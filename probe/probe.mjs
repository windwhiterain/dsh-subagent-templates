/**
 * Offline probe for `dsh-subagent-templates`.
 *
 * The plugin's entry point is an ordinary function, and every Harness service it
 * touches is reachable through `ctx`, so the whole delegation path runs here
 * against in-memory fakes: no Harness, no model, no filesystem. Run it after
 * every edit:
 *
 *   node probe/probe.mjs
 *
 * It checks the session-creation contract (a top-level Session with no
 * parentSession, the name that titles it, the template's preset and route, the
 * initial model selection the user can override), the caller's own choice of
 * foreground or background, name uniqueness, foreground and background
 * settlement, the external-stop silence rule, the parent/child store, and
 * configuration rejection.
 */

import assert from 'node:assert/strict'
import { apply, Config } from '../index.js'
import { normalizeConfig, ConfigError } from '../lib/config.js'

const TEMPLATES = [
  {
    id: 'medium',
    name: 'Medium',
    description: 'Executes and explores.',
    provider: 'command-code-goat',
    model: 'deepseek/deepseek-v4.1-flash',
    preset: 'personal',
  },
  {
    id: 'high',
    name: 'High',
    description: 'Advises and decides.',
    provider: 'opencode-go',
    model: 'deepseek-v4-pro',
    preset: 'personal',
  },
]

/**
 * Build a fake Harness around the plugin.
 * @param options - per-probe behavior switches.
 * @param options.answer - the child's final assistant text.
 * @param options.stopKind - the child's final turn reason kind.
 * @param options.parentStatus - the parent Agent's reported lifecycle status.
 * @param options.whenIdle - the child's idle await ('never' to hang).
 * @param options.deferredIdle - the child's turn stays open until it is stopped.
 * @param options.liveAgents - Agents already in the host's registry, as a reload sees them.
 * @param options.shared - an earlier instance's `storeRecords`, as a reload reopens them.
 * @param options.cancelThrows - the child refuses cancellation.
 * @param options.cwd - the parent's working directory.
 * @param options.config - the plugin configuration, when overriding the default.
 * @param options.noStore - the deployment has no storage facility.
 * @param options.noSessionTitle - the deployment has no session-title service.
 * @param options.presetMountFails - mounting the preset fails.
 * @returns the fake context plus recording helpers.
 */
function harness(options = {}) {
  const tools = new Map()
  const listeners = new Map()
  const disposers = []
  const created = []
  const attached = []
  const delivered = []
  const warnings = []
  // `shared` reuses an earlier instance's durable records, which is what a hot
  // reload actually gets: the mapping lives in a storage domain, and the
  // replacement instance reopens the same one.
  const storeRecords = options.shared?.storeRecords ?? new Map()
  const requestResolvers = []
  let childIdCounter = 0

  const childEvents = [
    { type: 'user/message', data: {} },
    { type: 'turn/start', data: { turn: 1 } },
    {
      type: 'assistant/message',
      data: { message: { content: [{ type: 'text', text: options.answer ?? 'done' }] }, stream: [] },
    },
    { type: 'turn/end', data: { reason: { kind: options.stopKind ?? 'completed' } } },
  ]
  /** The cause the child's turn was cancelled with, or null while it is whole. */
  let cancelled = null
  // `deferredIdle` holds a child's turn open until something stops it, which is
  // what the interrupt checks need: a turn that already finished cannot be
  // interrupted, and its settlement would have been delivered before the stop.
  let releaseIdle = () => {}
  const idlePromise = new Promise((resolve) => { releaseIdle = () => resolve() })

  const presetsApi = {
    mount: async (_agentCtx, presetId) => {
      if (options.presetMountFails === true) throw new Error('preset mount failed')
      created.push(['mount', presetId])
      return { id: presetId }
    },
    composedPreset: () => 'personal',
  }

  const systemPromptApi = {
    context: (contribution) => { created.push(['context', contribution]); return () => {} },
    section: (contribution) => { created.push(['persona', contribution]); return () => {} },
    getContextOrder: () => 500,
    getSectionOrder: () => 100,
  }

  // The child-scope tool registry, so a child-scoped tool (ask_parent) is
  // recorded exactly where the real one would land.
  const childTools = new Map()
  const childToolApi = {
    register: (definition) => {
      childTools.set(definition.name, definition)
      return () => childTools.delete(definition.name)
    },
    get: (name) => childTools.get(name),
    restrict: (restriction) => { created.push(['restrict', restriction]) },
  }

  const child = {
    id: '',
    options: {},
    steer: (message) => { created.push(['child.steer', message]) },
    session: {
      header: { id: '' },
      requestHeader: () => undefined,
      // A cancelled turn ends `aborted`, which is what makes a stopped child an
      // external stop rather than a finished one.
      snapshotEvents: () => (cancelled === null
        ? childEvents
        : childEvents.map(event => (event.type === 'turn/end'
          ? { type: 'turn/end', data: { reason: { kind: 'aborted', reason: { kind: cancelled } } } }
          : event))),
    },
    ctx: {
      get: (key) => {
        if (key === 'agentPresets') return presetsApi
        if (key === 'systemPrompt') return systemPromptApi
        if (key === 'tools') return childToolApi
        return undefined
      },
      inject: (deps, callback) => {
        const injected = { get: (key) => child.ctx.get(key) }
        for (const dep of deps) injected[dep] = child.ctx.get(dep)
        callback(injected)
        return { dispose: async () => {} }
      },
      on: (event, listener) => { listeners.set(`child:${event}`, listener); return () => {} },
    },
    followup: (message) => { created.push(['followup', message.content[0].text]) },
    whenIdle: options.whenIdle === 'never'
      ? () => new Promise(() => {})
      : options.deferredIdle === true ? () => idlePromise : async () => {},
    cancel: (cause) => {
      created.push(['cancel', cause.kind])
      cancelled = cause.kind
      // A cancelled turn leaves the running phase, so the Agent is live and idle:
      // this is the state `interrupt_subagent` exists to leave behind.
      child.status = 'idle'
      if (options.deferredIdle === true) releaseIdle()
      if (options.cancelThrows === true) throw new Error('session is closing')
    },
    status: 'running',
  }

  // The parent's own agent scope, the way the harness hands every live Agent a
  // context of its own. Tools registered here belong to this session alone, which
  // is what "only after a spawn" is made of.
  const parentTools = new Map()
  const scopedToolApi = {
    register: (definition) => {
      if (parentTools.has(definition.name)) throw new Error(`duplicate scoped tool ${definition.name}`)
      parentTools.set(definition.name, definition)
      return () => parentTools.delete(definition.name)
    },
    get: (toolName) => parentTools.get(toolName),
  }

  /** The agent-scoped context the harness hands one live Agent. */
  function agentScope() {
    return {
      get: (key) => (key === 'tools' ? scopedToolApi : undefined),
      inject: (deps, callback) => {
        const injected = { get: (key) => (key === 'tools' ? scopedToolApi : undefined) }
        for (const dep of deps) injected[dep] = injected.get(dep)
        callback(injected)
        return { dispose: async () => {} }
      },
    }
  }

  const parent = {
    id: 'parent-1',
    options: { provider: 'p', model: 'm' },
    session: { header: { id: 'parent-1', cwd: options.cwd ?? 'C:/work' } },
    status: options.parentStatus ?? 'running',
    followup: (message) => { delivered.push(['followup', message]) },
    inject: (message) => { delivered.push(['inject', message]) },
    steer: (message) => { delivered.push(['steer', message]) },
    ctx: agentScope(),
  }

  // The real registry holds every live Agent, which is how a template child is
  // found: it is a root Session, so nothing else knows it exists. `liveAgents`
  // seeds it, which is how a hot reload is modelled: the Agents belong to the
  // host, not to the plugin, so they survive the plugin being replaced — and so
  // does their tool scope, which is re-pointed at this instance's registry here.
  const live = new Map([[parent.id, parent]])
  for (const agent of options.liveAgents ?? []) {
    agent.ctx = agentScope()
    live.set(agent.id, agent)
  }
  const registry = { get: id => live.get(id) }
  const agents = registry
  // The application root context, as Cordis hands it to every plugin. Where a call
  // reaches `agents` from decides who owns what it creates, so this fake keeps the plugin
  // context and the root context apart rather than answering both with one registry.
  const root = {}
  /** Which context asked for the last creation, as `create` records it. */
  let createdBy
  const archived = []
  const renamed = []
  const workspaceRegistry = {
    create: async (path) => {
      created.push(['workspace.create', path])
      return {
        path,
        attachSession: async (id) => { attached.push(id) },
        detachSession: async (id) => { attached.push(`detach:${id}`) },
      }
    },
    archiveSession: async (id) => { archived.push(id) },
  }
  const sessionTitle = {
    rename: (session, title) => { renamed.push([session.header.id, title]) },
  }

  // A storage table matching the real domain-table surface the store consumes.
  const table = {
    get: (key) => storeRecords.get(key),
    put: async (key, value) => { storeRecords.set(key, value) },
    delete: async (key) => storeRecords.delete(key),
    entries: () => [...storeRecords.entries()][Symbol.iterator](),
  }
  const store = { table, close: async () => {} }

  // The storage-domain facility, with the one rule a reload has to respect: a
  // name stays reserved for the instance that opened it until THAT instance
  // closes it. `shared` carries the previous instance's facility, so a reload
  // meets the same reservation the real one does.
  const facility = options.shared?.facility ?? {
    /** Names held by an instance that has not closed yet. */
    reserved: new Set(),
    open(spec) {
      if (this.reserved.has(spec.name)) {
        const error = new Error(`domain '${spec.name}' is already open`)
        error.code = 'already-open'
        return Promise.reject(error)
      }
      this.reserved.add(spec.name)
      const reserved = this.reserved
      // One shared record map, so every instance's table reads the same medium.
      return Promise.resolve({ table: () => table, close: async () => { reserved.delete(spec.name) } })
    },
  }

  const projections = new Map()
  const ctx = {
    // The plugin's own context. Its `root` is the application root, exactly as Cordis
    // gives every plugin one: whatever a plugin creates through `ctx` is owned by this
    // context's fiber, and whatever it creates through `ctx.root` outlives the plugin.
    root,
    logger: { info: () => {}, debug: () => {}, warn: (line) => warnings.push(String(line)) },
    tools: {
      register: (definition) => {
        if (tools.has(definition.name)) throw new Error(`duplicate tool ${definition.name}`)
        tools.set(definition.name, definition)
        return () => tools.delete(definition.name)
      },
    },
    // A projection registration is part of apply; model the surface it uses.
    inject: (deps, callback) => {
      const injected = {
        get: (key) => ctx.get(key),
        effect: (effectCallback, label) => {
          const disposer = effectCallback()
          disposers.push({ label, dispose: disposer })
          return () => disposer?.()
        },
      }
      for (const dep of deps) injected[dep] = ctx.get(dep)
      callback(injected)
      return { dispose: async () => {} }
    },
    sessionProjections: {
      register: (definition) => { projections.set(definition.key, definition); return () => projections.delete(definition.key) },
    },
    effect: (callback, label) => {
      const disposer = callback()
      disposers.push({ label, dispose: disposer })
      return () => disposer?.()
    },
    on: (event, listener) => { listeners.set(event, listener); return () => {} },
    get: (key) => {
      if (key === 'agents') return agentsApi
      if (key === 'workspaceRegistry') return workspaceRegistry
      if (key === 'sessionTitle') return options.noSessionTitle === true ? undefined : sessionTitle
      if (key === 'sessionProjections') return ctx.sessionProjections
      if (key === 'storage') {
        // The real accessor is the global storage HUB and its mounted domain
        // form, not the subtree-scoped `storageDomain` key. Model the hub so the
        // probe cannot mask a wrong lookup.
        return {
          form: (form) => {
            if (form !== 'domain') throw new Error(`form "${form}" is not mounted`)
            if (options.noStore === true) throw new Error('form "domain" is not mounted')
            return facility
          },
        }
      }
      return undefined
    },
  }

  /**
   * The Agent registry as ONE context reads it.
   *
   * The real `create` is a method of a traced service, so it binds the new Agent's
   * lifecycle to the context the call was read through — `AgentRegistry.create()` takes
   * `ownerCtx = this.ctx` and `agent-loop` registers the Agent's whole teardown as
   * `ownerCtx.effect(...)`, which cancels its machine with `disposed` when that fiber
   * unloads. This fake records the owner and models that rule, so a child created
   * through the plugin's own context shows up here as a child that dies with it.
   * @param owner - `'root'` for the application root, `'plugin'` for the plugin's own context.
   * @returns the registry surface one context sees.
   */
  const agentsFor = (owner) => ({
    get: (id) => registry.get(id),
    // The real registry enumerates its live agents, which is how a hot-reloaded
    // instance finds the sessions that already have children.
    list: () => [...live.values()],
    create: async (createOptions) => {
      createdBy = owner
      childIdCounter += 1
      const id = createOptions.sessionId
      child.id = id
      child.session.header.id = id
      child.options = createOptions.agentOptions ?? {}
      // One child object models one creation, so a new child starts whole.
      cancelled = null
      live.set(id, child)
      created.push(['create', createOptions])
      // Drive the initial model-selection waterfall once, as a real first request would.
      const selectionListener = listeners.get('child:agent/request')
      if (selectionListener !== undefined) {
        const resolved = await selectionListener(
          { agent: child },
          async () => ({ provider: child.options.provider, model: child.options.model }),
        )
        requestResolvers.push(resolved)
      }
      await createOptions.setup?.(child.ctx, child)
      // The real Agent is fused to its creation signal: aborting that signal is
      // what tears the child down. Model that so an ownership bug shows here.
      createOptions.signal?.addEventListener('abort', () => {
        created.push(['cancel', 'disposed'])
        child.cancel({ kind: 'disposed' })
      }, { once: true })
      // The other owner: the creating context's fiber. `agentLoop.lifecycle` is an effect
      // of that fiber, so a creation through anything but the root is a child this plugin
      // would take down with it.
      if (owner !== 'root') {
        disposers.push({
          label: `agentLoop.lifecycle(${id})`,
          dispose: () => {
            created.push(['cancel', 'disposed'])
            child.cancel({ kind: 'disposed' })
          },
        })
      }
      return { agent: child, dispose: async () => { created.push(['dispose']) } }
    },
  })
  const agentsApi = agentsFor('plugin')
  root.get = (key) => (key === 'agents' ? agentsFor('root') : undefined)

  /**
   * Model the child starting another turn and ending it naturally.
   *
   * The state that decides an outcome is the log, not a flag: clearing the
   * cancellation cause is what makes `snapshotEvents()` report a completed turn
   * again, and the status transition is what a watcher waiting for the child's
   * next turn is armed on. Both happen here, in that order.
   */
  const resumeChild = () => {
    cancelled = null
    child.status = 'running'
    listeners.get('child:agent/status')?.({ agent: child, status: 'running' })
    child.status = 'idle'
  }

  return {
    ctx, parent, child, agentsApi, tools, parentTools, childTools, listeners, disposers, created, attached,
    delivered, warnings, store, storeRecords, requestResolvers, archived, renamed, projections, execSignal: undefined,
    facility, root, resumeChild,
    /** The context the last delegation created its child through: `'root'` or `'plugin'`. */
    get createdBy() { return createdBy },
  }
}

/** Mount the plugin on a fresh fake Harness. */
async function mount(options = {}) {
  const fake = harness(options)
  await apply(fake.ctx, options.config ?? { templates: TEMPLATES })
  return fake
}

/**
 * Mount, delegate one background child, and hand back the fake — so a test can
 * read the child-management tools out of the delegating session's own scope,
 * which is the only place they are ever registered.
 * @param options - per-probe behavior switches.
 * @returns the fake Harness with one live child.
 */
async function mountWithChild(options = {}) {
  const fake = await mount(options)
  await delegate(fake, { name: 'explorer', template: 'medium', prompt: 'look' }, true)
  return fake
}

/**
 * Run one delegation through the registered tool.
 *
 * The background flag is a separate argument because the tool requires it: a
 * probe call that could quietly omit it would stop testing the call the model
 * actually makes.
 * @param fake - the mounted fake Harness.
 * @param args - the delegation arguments, without the background flag.
 * @param runInBackground - whether the call returns immediately.
 * @returns the tool result.
 */
function delegate(fake, args, runInBackground) {
  assert.equal(typeof runInBackground, 'boolean', 'a probe delegation must state run_in_background')
  const signal = new AbortController().signal
  fake.execSignal = signal
  return fake.tools.get('subagent').execute(
    { ...args, run_in_background: runInBackground },
    { agent: fake.parent, signal },
  )
}

const checks = []
/** Register one probe check. */
function check(name, body) {
  checks.push([name, body])
}

/** Await one scheduling turn, so a promise chain the plugin owns can advance. */
const tick = () => new Promise(resolve => setImmediate(resolve))

/**
 * Await a condition the plugin reaches asynchronously, failing rather than
 * hanging the probe when it never holds.
 * @param condition - the condition to poll.
 * @param message - what the condition means, shown on failure.
 */
async function until(condition, message) {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    if (condition()) return
    await tick()
  }
  assert.ok(condition(), message)
}

check('config: rejects unknown fields, bad ids, duplicates, and empty lists', () => {
  assert.throws(() => normalizeConfig({ templates: TEMPLATES, nope: 1 }), ConfigError)
  assert.throws(() => normalizeConfig({ templates: [{ ...TEMPLATES[0], id: 'Bad Id' }] }), /lowercase letters/)
  assert.throws(() => normalizeConfig({ templates: [TEMPLATES[0], { ...TEMPLATES[1], id: 'medium' }] }), /duplicate template id/)
  assert.throws(() => normalizeConfig({ templates: [] }), /non-empty array/)
  assert.throws(() => normalizeConfig({ templates: [{ ...TEMPLATES[0], toolFilter: {} }] }), /allow.*deny/)
  // A template no longer carries a background preference: whether a child waits
  // is the delegating call's decision, so the field is refused outright.
  assert.throws(
    () => normalizeConfig({ templates: [{ ...TEMPLATES[0], background: true }] }),
    /unknown field "background"/,
  )
  const normalized = normalizeConfig({ templates: TEMPLATES })
  assert.equal(normalized.toolName, 'subagent')
  assert.equal(Config['~standard'].validate({ templates: TEMPLATES }).issues, undefined)
})

check('registration: only the spawning tools are global', async () => {
  const fake = await mount()
  // A session that has not delegated carries nothing it cannot use: the tool
  // that spawns a child, and the catalogue it picks one from.
  assert.deepEqual([...fake.tools.keys()].sort(), ['list_subagent_templates', 'subagent'])
  const definition = fake.tools.get('subagent')
  assert.match(definition.description, /- medium — Medium: Executes and explores\./)
  assert.match(definition.description, /- high — High: Advises and decides\./)
  assert.deepEqual(definition.parameters.properties.template.enum, ['medium', 'high'])
  // The name is required, and the old free-text description is gone: the name is
  // the child's handle and its title. The background flag is required too, so a
  // delegation always states whether it waits.
  assert.deepEqual(definition.parameters.required, ['name', 'template', 'prompt', 'run_in_background'])
  assert.equal(definition.parameters.properties.description, undefined)
  assert.equal(definition.parameters.properties.run_in_background.type, 'boolean')
  assert.match(definition.parameters.properties.run_in_background.description, /no default/)
})

check('the native delegation surface is gone from the plugin', async () => {
  const fake = await mount()
  // The native tools read the Harness subagent registry, which holds no template
  // child, so this plugin must not shadow them back into existence.
  for (const name of ['list_agents', 'send_message', 'interrupt_agent', 'subagent_fork', 'subagent_codex']) {
    assert.equal(fake.tools.has(name), false, `${name} must not be registered`)
  }
})

check('the child-management tools appear only after a spawn, in that session alone', async () => {
  const fake = await mount()
  const childTools = ['list_subagents', 'message_subagent', 'interrupt_subagent', 'delete_subagent']

  // Before the first delegation the parent's own scope carries none of them.
  assert.deepEqual([...fake.parentTools.keys()], [])
  await delegate(fake, { name: 'explorer', template: 'medium', prompt: 'look' }, true)
  assert.deepEqual([...fake.parentTools.keys()].sort(), [...childTools].sort())
  // Still not global, so another session in the same host does not inherit them.
  for (const name of childTools) {
    assert.equal(fake.tools.has(name), false, `${name} must stay out of the Host plane`)
  }
  // The child's own scope is untouched: a child manages its own children, and it
  // has none yet.
  assert.equal(fake.childTools.has('list_subagents'), false)
})

check('a second delegation installs nothing twice', async () => {
  const fake = await mount()
  await delegate(fake, { name: 'explorer', template: 'medium', prompt: 'look' }, true)
  await delegate(fake, { name: 'reviewer', template: 'high', prompt: 'look' }, true)
  // A scope rejects a duplicate tool name, so a second install would throw rather
  // than silently double up.
  assert.equal(fake.parentTools.size, 4)
})

check('a reloaded instance adopts the live sessions that already have children', async () => {
  // The first instance records a child, then goes away through its own disposers.
  const first = await mount()
  await delegate(first, { name: 'explorer', template: 'medium', prompt: 'look' }, true)
  assert.equal(first.parentTools.size, 4)
  for (const entry of first.disposers) await entry.dispose?.()

  // The replacement runs on a host whose Agents are the same Agents — only the
  // plugin is new — and finds that session through the registry and the store, so
  // a reloaded session does not have to delegate again to get its tools back.
  const second = harness({ liveAgents: [first.parent], shared: { storeRecords: first.storeRecords } })
  await apply(second.ctx, { templates: TEMPLATES })
  assert.deepEqual([...second.parentTools.keys()].sort(), [
    'delete_subagent', 'interrupt_subagent', 'list_subagents', 'message_subagent',
  ])
})

check('list_subagents reports each child by name, template, and work', async () => {
  const fake = await mountWithChild()
  const tool = fake.parentTools.get('list_subagents')
  const signal = new AbortController().signal
  const rows = await tool.execute({}, { agent: fake.parent, signal })
  assert.deepEqual(rows, [{ name: 'explorer', template: 'medium', status: 'working' }])
  // The row is drawn for a model, so it is text a model can act on.
  assert.deepEqual(tool.output.render({}, rows), [{ type: 'text', text: '- explorer [working]: medium' }])

  // An idle child and a child whose Session closed are distinguishable, because
  // "still there but waiting" and "gone" call for different next steps.
  fake.child.status = 'idle'
  assert.equal((await tool.execute({}, { agent: fake.parent, signal }))[0].status, 'idle')
  fake.agentsApi.get = () => undefined
  assert.equal((await tool.execute({}, { agent: fake.parent, signal }))[0].status, 'ended')
})

check('a session that has delegated every child away still answers honestly', async () => {
  // The tool only exists because this session delegated, so its empty state is
  // reached by deleting the last child — which is also why it is never withdrawn.
  const fake = await mountWithChild()
  const signal = new AbortController().signal
  await fake.parentTools.get('delete_subagent').execute({ name: 'explorer' }, { agent: fake.parent, signal })
  const tool = fake.parentTools.get('list_subagents')
  const rows = await tool.execute({}, { agent: fake.parent, signal })
  assert.deepEqual(rows, [])
  assert.deepEqual(tool.output.render({}, rows), [{ type: 'text', text: '(no subagents)' }])
  // And the other two keep reporting the name is unknown rather than failing.
  assert.deepEqual(
    await fake.parentTools.get('message_subagent').execute({ name: 'explorer', message: 'x' }, { agent: fake.parent, signal }),
    { name: 'explorer', status: 'unknown' },
  )
})

check('message_subagent reaches a working child and an idle one, by name', async () => {
  const fake = await mountWithChild()
  const tool = fake.parentTools.get('message_subagent')
  const signal = new AbortController().signal
  const before = fake.delivered.length

  // A name this parent never gave is refused without touching anything.
  const stranger = await tool.execute({ name: 'stranger', message: 'hi' }, { agent: fake.parent, signal })
  assert.deepEqual(stranger, { name: 'stranger', status: 'unknown' })
  assert.equal(fake.delivered.length, before, 'a refused message sends nothing')

  // Its own child gets the message, attributed to the parent exactly as the
  // child's own `ask_parent` is.
  const own = await tool.execute({ name: 'explorer', message: 'focus on the parser' }, { agent: fake.parent, signal })
  assert.deepEqual(own, { name: 'explorer', status: 'delivered' })
  const [, message] = fake.created.filter(entry => entry[0] === 'child.steer').at(-1)
  assert.equal(message.source.kind, 'agent-message')
  assert.equal(message.source.senderSessionId, fake.parent.id)
  assert.equal(message.content[1].text, 'focus on the parser')

  // A recorded child whose Session closed is a different answer from a name that
  // never existed: the first is recoverable in the session list, the second is not.
  fake.agentsApi.get = () => undefined
  assert.deepEqual(
    await tool.execute({ name: 'explorer', message: 'still there?' }, { agent: fake.parent, signal }),
    { name: 'explorer', status: 'ended' },
  )
})

check('interrupt_subagent stops the current work and leaves the child alive', async () => {
  // The child is still working when the interrupt lands, so what the interrupt
  // changes is observable: the turn ends, the child does not.
  const fake = await mount({ deferredIdle: true })
  const signal = new AbortController().signal
  await delegate(fake, { name: 'explorer', template: 'medium', prompt: 'look' }, true)
  const tool = fake.parentTools.get('interrupt_subagent')

  assert.deepEqual(
    await tool.execute({ name: 'stranger' }, { agent: fake.parent, signal }),
    { name: 'stranger', status: 'unknown' },
  )
  const own = await tool.execute({ name: 'explorer' }, { agent: fake.parent, signal })
  assert.deepEqual(own, { name: 'explorer', status: 'interrupted' })
  assert.ok(fake.created.some(entry => entry[0] === 'cancel' && entry[1] === 'parent'))
  assert.equal(fake.created.some(entry => entry[0] === 'dispose'), false, 'an interrupt disposes nothing')
  assert.equal(fake.archived.length, 0, 'an interrupt archives nothing')
  assert.equal(fake.storeRecords.size, 1, 'the mapping survives the interrupt')

  // An interrupted child has nothing to report, so its settlement stays silent.
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(
    fake.delivered.some(([, message]) => message.source.kind === 'subagent-settled'),
    false,
    'a stopped child reports nothing',
  )
})

check('an interrupted child still accepts a message, which starts its next turn', async () => {
  const fake = await mount({ deferredIdle: true })
  const signal = new AbortController().signal
  await delegate(fake, { name: 'explorer', template: 'medium', prompt: 'look' }, true)
  await fake.parentTools.get('interrupt_subagent').execute({ name: 'explorer' }, { agent: fake.parent, signal })
  const rows = await fake.parentTools.get('list_subagents').execute({}, { agent: fake.parent, signal })
  assert.equal(rows[0].status, 'idle')
  const sent = await fake.parentTools.get('message_subagent').execute(
    { name: 'explorer', message: 'do this instead' },
    { agent: fake.parent, signal },
  )
  assert.deepEqual(sent, { name: 'explorer', status: 'delivered' })
  const steered = fake.created.filter(entry => entry[0] === 'child.steer').at(-1)
  assert.equal(steered[1].content[1].text, 'do this instead')
})

check('foreground: the child is a top-level session on the template preset and route', async () => {
  const fake = await mount()
  const value = await delegate(fake, { name: 'reviewer', template: 'high', prompt: 'look' }, false)
  assert.equal(value.kind, 'foreground')
  assert.equal(value.name, 'reviewer')
  assert.equal(value.output[0].text, 'done')
  const [, create] = fake.created.find(entry => entry[0] === 'create')
  // No parentAgent: this is a root Session, not a subagent child.
  assert.equal(create.parentAgent, undefined)
  assert.equal(create.meta.parentSession, undefined)
  assert.equal(create.meta.origin, undefined)
  assert.equal(create.meta.agentPreset, 'personal')
  assert.equal(create.meta.cwd, 'C:/work')
  assert.equal(create.agentOptions.provider, 'opencode-go')
  assert.equal(create.agentOptions.model, 'deepseek-v4-pro')
  // The workspace is the parent's cwd, and the child is attached to it.
  assert.deepEqual(fake.created.find(entry => entry[0] === 'workspace.create'), ['workspace.create', 'C:/work'])
  assert.deepEqual(fake.attached, [create.sessionId])
  // The preset is joined in the creation window.
  assert.ok(fake.created.some(entry => entry[0] === 'mount' && entry[1] === 'personal'))
})

check('the name the parent chose titles the child session', async () => {
  const fake = await mount()
  await delegate(fake, { name: 'Reviewer', template: 'high', prompt: 'look' }, false)
  const [, create] = fake.created.find(entry => entry[0] === 'create')
  // Stored verbatim: the user chose no format for a name, so none is imposed.
  assert.deepEqual(fake.renamed, [[create.sessionId, 'Reviewer']])
  const mapping = fake.storeRecords.get(create.sessionId)
  assert.equal(mapping.name, 'Reviewer')
})

check('a blank name is refused before anything is created', async () => {
  const fake = await mount()
  await assert.rejects(() => delegate(fake, { name: '   ', template: 'high', prompt: 'look' }, false), /not blank/)
  assert.equal(fake.created.some(entry => entry[0] === 'create'), false)
  assert.equal(fake.storeRecords.size, 0)
})

check('a deployment without the session-title service fails the delegation outright', async () => {
  // A child that exists without the handle every later reference uses is not a
  // delegation, so the missing service must fail before a Session is created.
  const fake = await mount({ noSessionTitle: true })
  await assert.rejects(() => delegate(fake, { name: 'x', template: 'high', prompt: 'look' }, false), /sessionTitle/)
  assert.equal(fake.created.some(entry => entry[0] === 'create'), false)
})

check('a name already in use is refused, and the first child is untouched', async () => {
  const fake = await mount()
  const first = await delegate(fake, { name: 'reviewer', template: 'medium', prompt: 'look' }, true)
  assert.equal(first.kind, 'background')
  await assert.rejects(
    () => delegate(fake, { name: 'reviewer', template: 'high', prompt: 'look' }, false),
    /already exists/,
  )
  // The refusal costs nothing: exactly one child exists, and it is still there.
  const [, create] = fake.created.find(entry => entry[0] === 'create')
  assert.equal(fake.storeRecords.size, 1)
  assert.equal(fake.renamed.length, 1)
  assert.equal(fake.storeRecords.get(create.sessionId).name, 'reviewer')

  // Deleting it frees the name again.
  await fake.parentTools.get('delete_subagent').execute(
    { name: 'reviewer' },
    { agent: fake.parent, signal: new AbortController().signal },
  )
  const second = await delegate(fake, { name: 'reviewer', template: 'high', prompt: 'look' }, false)
  assert.equal(second.name, 'reviewer')
})

check('two calls in one turn cannot take the same name', async () => {
  const fake = await mount()
  const signal = new AbortController().signal
  const tool = fake.tools.get('subagent')
  const args = { name: 'reviewer', template: 'high', prompt: 'look' }
  // The durable record is written only after creation resolves, so this is the
  // window the in-flight claim exists to close.
  const outcomes = await Promise.allSettled([
    tool.execute(args, { agent: fake.parent, signal }),
    tool.execute(args, { agent: fake.parent, signal }),
  ])
  assert.deepEqual(outcomes.map(one => one.status), ['fulfilled', 'rejected'])
  assert.match(outcomes[1].reason.message, /already exists/)
  assert.equal(fake.storeRecords.size, 1)
})

check('a template no longer makes a call run in the background', async () => {
  // The caller decides, and states it: without the flag the schema refuses the
  // call, and with it false the call waits, whatever the template looks like.
  const fake = await mount()
  const tool = fake.tools.get('subagent')
  const signal = new AbortController().signal
  const value = await delegate(fake, { name: 'waiter', template: 'medium', prompt: 'look' }, false)
  assert.equal(value.kind, 'foreground')
  assert.equal(fake.archived.length, 0)
  // A call that leaves the decision out is not a call this tool accepts.
  assert.equal(
    tool.parameters.required.includes('run_in_background'),
    true,
    'the flag is required, so a model that forgets it is told rather than defaulted',
  )
  assert.equal(Object.hasOwn(tool.output.schema.oneOf[0].properties, 'sessionId'), false)
})

check('the child header omits parentSession so the model picker stays available', async () => {
  const fake = await mount()
  await delegate(fake, { name: 'x', template: 'high', prompt: 'look' }, false)
  const [, create] = fake.created.find(entry => entry[0] === 'create')
  // Nothing in the durable metadata marks this Session a subagent.
  assert.equal(Object.hasOwn(create.meta, 'parentSession'), false)
  assert.equal(Object.hasOwn(create.meta, 'origin'), false)
})

check('the template model is a default the user can override', async () => {
  const fake = await mount()
  await delegate(fake, { name: 'x', template: 'high', prompt: 'look' }, false)
  const listener = fake.listeners.get('child:agent/request')
  assert.ok(listener !== undefined, 'the child installs a model-selection waterfall')

  // Before any durable header exists, the first request keeps the template route.
  const first = await listener(
    { agent: { session: { requestHeader: () => undefined } } },
    async () => ({ provider: 'opencode-go', model: 'deepseek-v4-pro' }),
  )
  assert.equal(first.provider, 'opencode-go')
  assert.equal(first.model, 'deepseek-v4-pro')

  // Once the child has its own header (the user changed the model in the
  // picker), a later request is left alone.
  const after = await listener(
    { agent: { session: { requestHeader: () => ({ config: { provider: 'user-choice', model: 'user-model' } }) } } },
    async () => ({ provider: 'user-choice', model: 'user-model' }),
  )
  assert.equal(after.provider, 'user-choice')
  assert.equal(after.model, 'user-model')
})

check('background: the call returns the name immediately and is registered', async () => {
  const fake = await mount()
  const value = await delegate(fake, {
    name: 'explorer', template: 'medium', prompt: 'look',
  }, true)
  assert.deepEqual(value, { kind: 'background', name: 'explorer' })
  // No session id reaches the model: the name is the only handle it gets.
  assert.equal(value.sessionId, undefined)
  const [, create] = fake.created.find(entry => entry[0] === 'create')
  assert.match(create.sessionId, /^subagent-template-/)
})

check('background: a naturally finished child names itself to a busy parent', async () => {
  const fake = await mount({ parentStatus: 'running' })
  const value = await delegate(fake, {
    name: 'explorer', template: 'medium', prompt: 'look',
  }, true)
  await new Promise(resolve => setImmediate(resolve))
  const [, message] = fake.delivered.find(([what]) => what === 'inject')
  assert.equal(message.source.kind, 'subagent-settled')
  assert.equal(message.source.senderSessionId, fake.child.id)
  assert.equal(message.content[0].text, 'subagent "explorer" finished.')
  // The Session id is a factual wire field only; it is never model-visible text.
  assert.equal(message.content.some(block => block.text.includes(fake.child.id)), false)
  assert.ok(message.content.some(block => block.text === 'done'))
})

check('background: an idle parent is woken', async () => {
  const fake = await mount({ parentStatus: 'idle' })
  await delegate(fake, { name: 'explorer', template: 'medium', prompt: 'look' }, true)
  await new Promise(resolve => setImmediate(resolve))
  assert.ok(fake.delivered.some(([what]) => what === 'followup'))
})

check('a child is not bound to the calling tool\'s signal', async () => {
  // The regression this guards: an Agent's life is fused to the signal its
  // creation passed, so a child created with the tool call's own exec.signal is
  // torn down the moment that call returns.
  const fake = await mount()
  await delegate(fake, { name: 'x', template: 'high', prompt: 'look' }, false)
  const [, create] = fake.created.find(entry => entry[0] === 'create')
  assert.ok(create.signal !== undefined, 'the child is created with its own lifetime signal')
  // The tool call's signal is NOT the child's lifetime signal.
  assert.notEqual(create.signal, fake.execSignal)
})

check('a child is created through the app root, so a plugin reload cannot take it down', async () => {
  // The regression this guards is the second owner: `agents.create` binds the new Agent's
  // lifecycle to the context the call was read through, and disposing that fiber cancels
  // the child with `disposed`. Created through this plugin's own context, every child
  // would die with this entry — on an HMR edit of a watched file, or on any profile
  // recomposition whose composed row for this entry changed.
  const fake = await mount()
  await delegate(fake, { name: 'explorer', template: 'medium', prompt: 'look' }, true)
  assert.equal(fake.createdBy, 'root', 'a delegated child must be created through ctx.root')

  // What an edit to a watched file does: this plugin's own effects unwind. The child is
  // not one of them, because no effect of this plugin's fiber owns it.
  for (const entry of fake.disposers) await entry.dispose?.()
  assert.equal(
    fake.created.some(entry => entry[0] === 'cancel' && entry[1] === 'disposed'),
    false,
    'reloading the plugin must not cancel the children it delegated',
  )
  assert.equal(fake.agentsApi.get(fake.child.id), fake.child, 'the child is still the live Agent')
})

check('a child keeps running when the parent session is disposed', async () => {
  const fake = await mount()
  await delegate(fake, { name: 'explorer', template: 'medium', prompt: 'look' }, true)
  // Disposing the parent must NOT cancel or dispose the child: a delegated
  // child is its own Session and only an explicit delete ends it.
  const off = fake.listeners.get('agent/disposed')
  if (off !== undefined) off({ agent: fake.parent })
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(fake.created.some(entry => entry[0] === 'cancel'), false)
  assert.equal(fake.created.some(entry => entry[0] === 'dispose'), false)
})

check('delete_subagent finds the child by name and touches only the caller\'s own', async () => {
  const fake = await mount()
  const value = await delegate(fake, {
    name: 'explorer', template: 'medium', prompt: 'look',
  }, true)
  const [, create] = fake.created.find(entry => entry[0] === 'create')
  const tool = fake.parentTools.get('delete_subagent')
  const signal = new AbortController().signal
  // A name the caller never gave is refused, naming nothing of anyone's.
  const stranger = await tool.execute({ name: 'not-mine' }, { agent: fake.parent, signal })
  assert.deepEqual(stranger, { name: 'not-mine', deleted: false })
  assert.equal(fake.archived.length, 0)

  // The caller's own child is deleted: cancelled, disposed, and archived.
  const own = await tool.execute({ name: value.name }, { agent: fake.parent, signal })
  assert.deepEqual(own, { name: 'explorer', deleted: true })
  assert.ok(fake.created.some(entry => entry[0] === 'cancel'))
  assert.ok(fake.created.some(entry => entry[0] === 'dispose'))
  assert.ok(fake.archived.includes(create.sessionId))
  assert.equal(fake.storeRecords.has(create.sessionId), false)
})

check('an interrupted turn is not an outcome: the stopped turn reports nothing', async () => {
  const fake = await mount({ parentStatus: 'running', deferredIdle: true })
  await delegate(fake, { name: 'explorer', template: 'medium', prompt: 'look' }, true)
  await tick()
  fake.child.cancel({ kind: 'user' })
  await tick()
  assert.equal(fake.delivered.length, 0, 'a stopped child reports nothing for the stopped turn')
})

check('background: a stopped child is waited through, and its next turn is reported', async () => {
  const fake = await mount({ parentStatus: 'running', deferredIdle: true })
  await delegate(fake, { name: 'explorer', template: 'medium', prompt: 'look' }, true)
  await tick()
  // The user's own stop button: the child keeps its session and its transcript.
  fake.child.cancel({ kind: 'user' })
  await tick()
  assert.equal(
    fake.delivered.some(([, message]) => message.source?.kind === 'subagent-settled'),
    false,
    'the interruption itself is never a settlement',
  )

  // The user redirects the child, and that turn ends naturally.
  fake.resumeChild()
  await until(
    () => fake.delivered.some(([, message]) => message.source?.kind === 'subagent-settled'),
    'the child\'s next natural end is reported',
  )
  const [, message] = fake.delivered.find(([, sent]) => sent.source?.kind === 'subagent-settled')
  assert.equal(message.content[0].text, 'subagent "explorer" finished.')
})

check('background: deleting the child ends its settlement watch', async () => {
  const fake = await mount({ parentStatus: 'running', deferredIdle: true })
  await delegate(fake, { name: 'explorer', template: 'medium', prompt: 'look' }, true)
  await tick()
  fake.child.cancel({ kind: 'user' })
  await tick()
  await fake.parentTools.get('delete_subagent').execute(
    { name: 'explorer' },
    { agent: fake.parent, signal: new AbortController().signal },
  )
  // A deleted child can never settle, so its watch must not stay armed: a turn
  // that could no longer report anything must not be reported either.
  fake.resumeChild()
  await tick()
  assert.equal(fake.delivered.length, 0, 'a deleted child reports nothing')
})

check('foreground: the user\'s stop is waited through, not failed', async () => {
  const fake = await mount({ deferredIdle: true })
  const signal = new AbortController().signal
  const call = fake.tools.get('subagent').execute(
    { name: 'reviewer', template: 'high', prompt: 'look', run_in_background: false },
    { agent: fake.parent, signal },
  )
  await until(() => fake.child.id !== '', 'the child exists before it is stopped')
  fake.child.cancel({ kind: 'user' })
  let settled = false
  void call.then(() => { settled = true }, () => { settled = true })
  await tick()
  assert.equal(settled, false, 'a stopped turn is not an outcome: the call keeps waiting')

  // The user tells the child what to do instead; that turn is the result.
  fake.resumeChild()
  const value = await call
  assert.equal(value.kind, 'foreground')
  assert.equal(value.name, 'reviewer')
  assert.equal(value.output[0].text, 'done')
})

check('foreground: a child nothing wakes again leaves the call waiting', async () => {
  const fake = await mount({ deferredIdle: true })
  const call = fake.tools.get('subagent').execute(
    { name: 'reviewer', template: 'high', prompt: 'look', run_in_background: false },
    { agent: fake.parent, signal: new AbortController().signal },
  )
  await until(() => fake.child.id !== '', 'the child exists before it is stopped')
  fake.child.cancel({ kind: 'user' })
  let settled = false
  void call.then(() => { settled = true }, () => { settled = true })
  await tick()
  await tick()
  // Waiting is the contract, not a hang to be papered over: the delegating
  // session's own stop is what ends this.
  assert.equal(settled, false, 'the call waits for the child\'s next turn')
})

check('foreground: cancelling the delegating call ends the wait and stops the child', async () => {
  const fake = await mount({ deferredIdle: true })
  const controller = new AbortController()
  const call = fake.tools.get('subagent').execute(
    { name: 'reviewer', template: 'high', prompt: 'look', run_in_background: false },
    { agent: fake.parent, signal: controller.signal },
  )
  await until(() => fake.child.id !== '', 'the child exists before the call is cancelled')
  controller.abort()
  await assert.rejects(() => call, /the delegating tool call was cancelled/)
  // The child is not left running: the caller asked for a result it will never read.
  assert.ok(
    fake.created.some(entry => entry[0] === 'cancel' && entry[1] === 'disposed'),
    'cancelling the call stops the child it created',
  )
})

check('the parent/child mapping is recorded through the storage hub', async () => {
  const fake = await mount()
  const value = await delegate(fake, {
    name: 'explorer', template: 'medium', prompt: 'look',
  }, true)
  // The record exists in the backing table, which is only reachable via the
  // storage HUB's domain form — a lookup through the subtree-scoped
  // `storageDomain` key would leave this empty in a real host.
  const mapping = fake.storeRecords.get(fake.child.id)
  assert.ok(mapping !== undefined, 'the mapping reached the storage table')
  assert.equal(mapping.parentSessionId, 'parent-1')
  assert.equal(mapping.templateId, 'medium')
  assert.equal(mapping.name, 'explorer')
  assert.equal(mapping.label, undefined)
  assert.equal(fake.child.id, fake.renamed[0][0])
  assert.equal(value.sessionId, undefined)
})

check('a deployment without the storage domain form still delegates', async () => {
  const fake = await mount({ noStore: true })
  const value = await delegate(fake, { name: 'x', template: 'high', prompt: 'look' }, false)
  assert.equal(value.kind, 'foreground')
  assert.ok(fake.warnings.some(line => line.includes('storage domain form is not mounted')))
})

check('a preset that fails to mount rejects without leaving a half-attached child', async () => {
  const fake = await mount({ presetMountFails: true })
  await assert.rejects(
    () => delegate(fake, { name: 'x', template: 'high', prompt: 'look' }, false),
    /preset mount failed/,
  )
  assert.equal(fake.attached.length, 0)
})

check('the tool declares only enforced JSON Schema types', async () => {
  const supported = new Set(['object', 'array', 'string', 'number', 'integer', 'boolean', 'null'])
  const fake = await mount()
  const walk = (node, path) => {
    if (node === null || typeof node !== 'object') return
    if (Array.isArray(node)) return node.forEach((entry, i) => walk(entry, `${path}[${i}]`))
    if (Object.hasOwn(node, 'type')) {
      assert.ok(supported.has(node.type), `${path}.type "${node.type}" is not supported`)
    }
    for (const [key, value] of Object.entries(node)) walk(value, `${path}.${key}`)
  }
  for (const [name, definition] of fake.tools) {
    walk(definition.parameters, `${name}.parameters`)
    walk(definition.output.schema, `${name}.output.schema`)
  }
})

check('a child session can ask its parent a question', async () => {
  const fake = await mount()
  await delegate(fake, { name: 'x', template: 'high', prompt: 'look' }, false)
  const askParent = fake.childTools.get('ask_parent')
  assert.ok(askParent !== undefined, 'the child scope carries ask_parent')
  const value = await askParent.execute(
    { question: 'which branch did you mean?' },
    { agent: fake.child, signal: new AbortController().signal },
  )
  assert.deepEqual(value, { delivered: true })
  const [, message] = fake.delivered.find(([what]) => what === 'steer')
  assert.equal(message.source.kind, 'agent-message')
  assert.equal(message.source.senderSessionId, fake.child.id)
  assert.equal(message.content[0].text, 'subagent "x" sent a message: ')
  assert.equal(message.content[1].text, 'which branch did you mean?')
})

check('a child session is told its own name, its parent, and that it may ask', async () => {
  const fake = await mount()
  await delegate(fake, { name: 'explorer', template: 'high', prompt: 'look' }, false)
  const context = fake.created.find(([what, value]) => what === 'context' && value.name === 'subagent-templates:parent')
  assert.ok(context !== undefined, 'the child prompt states the parent relationship')
  assert.match(context[1].text, /parent-1/)
  assert.match(context[1].text, /ask_parent/)
  // The child can refer to itself by the name the parent uses for it.
  assert.match(context[1].text, /You are the subagent "explorer"/)
})

check('the parent scope never receives ask_parent', async () => {
  const fake = await mount()
  await delegate(fake, { name: 'x', template: 'high', prompt: 'look' }, false)
  // ask_parent is registered on the CHILD's scope only; the plugin's own tool
  // registry (the parent-visible one) must not carry it.
  assert.equal(fake.tools.has('ask_parent'), false)
})

check('the projection publishes the rows the client panel draws', async () => {
  const fake = await mount()
  const projection = fake.projections.get('subagentTemplates')
  assert.ok(projection !== undefined, 'the plugin registers its session projection')
  // A session with no children still publishes a value: the view must be a JSON
  // value, because the Host's session-list summary rejects a projection cell
  // holding `undefined`.
  const empty = projection.wire.view(projection.init({ id: 'parent-1' }))
  assert.deepEqual(empty, { children: [] })

  await delegate(fake, { name: 'explorer', template: 'medium', prompt: 'look' }, true)
  const state = projection.init({ id: 'parent-1' })
  const view = projection.wire.view(state)
  assert.equal(view.children.length, 1)
  assert.deepEqual(view.children[0], {
    childSessionId: fake.child.id,
    name: 'explorer',
    templateName: 'Medium',
    createdAt: view.children[0].createdAt,
  })
  // An unchanged list hands back the same reference, so nothing republishes.
  assert.equal(projection.wire.view(state), view)
  // A parent's own event does not change the children, so the fold's state move
  // publishes nothing either.
  const moved = projection.apply(state, { type: 'turn/end' })
  assert.equal(projection.wire.view(moved), view)
})

check('persona: a template persona shadows the deployment persona on the child scope', async () => {
  const fake = await mount({
    config: { templates: [{ ...TEMPLATES[0], persona: 'You are the tersest reviewer.' }] },
  })
  await delegate(fake, { name: 'x', template: 'medium', prompt: 'look' }, false)
  const section = fake.created.find(([what, value]) => what === 'persona' && value.name === 'deployment:persona-prefix')
  assert.ok(section !== undefined, 'the child scope received a persona section')
  assert.equal(section[1].text, 'You are the tersest reviewer.')
})

check('persona: a template without one contributes no persona section', async () => {
  const fake = await mount()
  await delegate(fake, { name: 'x', template: 'medium', prompt: 'look' }, false)
  const section = fake.created.find(([what, value]) => what === 'persona' && value.name === 'deployment:persona-prefix')
  assert.equal(section, undefined, 'the deployment persona is left alone')
})

check('toolFilter: a template restriction is applied to the child scope', async () => {
  const fake = await mount({
    config: { templates: [{ ...TEMPLATES[0], toolFilter: { deny: ['write'] } }] },
  })
  await delegate(fake, { name: 'x', template: 'medium', prompt: 'look' }, false)
  const restriction = fake.created.find(([what]) => what === 'restrict')
  assert.ok(restriction !== undefined, 'the child scope was restricted')
  assert.deepEqual(restriction[1], { deny: ['write'] })
})

check('toolFilter: a template without one restricts nothing', async () => {
  const fake = await mount()
  await delegate(fake, { name: 'x', template: 'medium', prompt: 'look' }, false)
  assert.equal(fake.created.find(([what]) => what === 'restrict'), undefined)
})

check('maxDepth: refuses a delegation past the cap, creating and recording nothing', async () => {
  const fake = await mount({ config: { templates: TEMPLATES, maxDepth: 0 } })
  await assert.rejects(
    () => delegate(fake, { name: 'x', template: 'medium', prompt: 'look' }, false),
    /exceeds maxDepth 0/,
  )
  assert.equal(fake.storeRecords.size, 0, 'a refused delegation leaves no mapping')
  assert.equal(fake.created.find(([what]) => what === 'create'), undefined, 'a refused delegation creates no Session')
})

check('maxDepth: admits a delegation at the cap', async () => {
  const fake = await mount({ config: { templates: TEMPLATES, maxDepth: 1 } })
  await delegate(fake, { name: 'x', template: 'medium', prompt: 'look' }, false)
  assert.equal(fake.storeRecords.size, 1)
})

check('maxDepth: counts the chain the mapping store recorded', async () => {
  const fake = await mount({ config: { templates: TEMPLATES, maxDepth: 1 } })
  // The delegating Session is itself a recorded child, so its own child is depth 2.
  fake.storeRecords.set('parent-1', {
    parentSessionId: 'grandparent-1',
    name: 'mid',
    templateId: 'medium',
    createdAt: 1,
    cwd: 'C:/work',
  })
  await assert.rejects(
    () => delegate(fake, { name: 'x', template: 'medium', prompt: 'look' }, false),
    /exceeds maxDepth 1/,
  )
})

check('maxDepth: provider-managed leaves the depth unbounded', async () => {
  const fake = await mount({ config: { templates: TEMPLATES, maxDepth: 'provider-managed' } })
  fake.storeRecords.set('parent-1', {
    parentSessionId: 'grandparent-1',
    name: 'mid',
    templateId: 'medium',
    createdAt: 1,
    cwd: 'C:/work',
  })
  await delegate(fake, { name: 'x', template: 'medium', prompt: 'look' }, false)
  assert.equal(fake.storeRecords.size, 2, 'the delegation proceeded past the first level')
})

check('a reload waits out the previous instance instead of adopting a domain it closes', async () => {
  const first = await mount()
  await delegate(first, { name: 'x', template: 'medium', prompt: 'look' }, false)
  assert.equal(first.storeRecords.size, 1)

  // The reload activates the second instance while the first still holds the
  // domain — the window in which the facility answers `already-open`.
  const second = harness({
    liveAgents: [first.parent],
    shared: { storeRecords: first.storeRecords, facility: first.facility },
  })
  const mounting = apply(second.ctx, { templates: TEMPLATES })
  // The previous instance's teardown lands while the new one is waiting.
  await new Promise(resolve => setTimeout(resolve, 30))
  for (const { dispose } of [...first.disposers].reverse()) {
    try { await dispose?.() } catch { /* a reload's teardown is best-effort */ }
  }
  await mounting

  assert.equal(first.facility.reserved.has('subagent_templates'), true,
    'the reloaded instance holds its own reservation, not the closed one')
  assert.equal(second.storeRecords.size, 1, 'the mapping survived the reload')
  await delegate(second, { name: 'y', template: 'medium', prompt: 'look' }, false)
  assert.equal(second.storeRecords.size, 2, 'the reloaded instance still records mappings')
})

check('config: the defaults are maxActiveSubagents 4 and maxDepth 1', () => {
  const normalized = normalizeConfig({ templates: TEMPLATES })
  assert.equal(normalized.maxActiveSubagents, 4)
  assert.equal(normalized.maxDepth, 1)
  assert.equal(normalizeConfig({ templates: TEMPLATES, maxActiveSubagents: 8 }).maxActiveSubagents, 8)
  assert.throws(() => normalizeConfig({ templates: TEMPLATES, maxActiveSubagents: 0 }), /positive safe integer/)
  assert.throws(() => normalizeConfig({ templates: TEMPLATES, maxActiveSubagents: 1.5 }), /positive safe integer/)
})

check('maxActiveSubagents: refuses a delegation while the cap is full', async () => {
  const fake = await mount({
    config: { templates: TEMPLATES, maxActiveSubagents: 1 },
    liveAgents: [{ id: 'child-a', status: 'running' }],
  })
  fake.storeRecords.set('child-a', {
    parentSessionId: 'parent-1',
    name: 'a',
    templateId: 'medium',
    createdAt: 1,
    cwd: 'C:/work',
  })
  await assert.rejects(
    () => delegate(fake, { name: 'x', template: 'medium', prompt: 'look' }, false),
    /active subagent limit: 1/,
  )
  assert.equal(fake.storeRecords.size, 1, 'the refused delegation records nothing')
})

check('maxActiveSubagents: a child that has finished holds no slot', async () => {
  const fake = await mount({
    config: { templates: TEMPLATES, maxActiveSubagents: 1 },
    liveAgents: [{ id: 'child-a', status: 'idle' }],
  })
  fake.storeRecords.set('child-a', {
    parentSessionId: 'parent-1',
    name: 'a',
    templateId: 'medium',
    createdAt: 1,
    cwd: 'C:/work',
  })
  await delegate(fake, { name: 'x', template: 'medium', prompt: 'look' }, false)
  assert.equal(fake.storeRecords.size, 2, 'a finished child must not block new work')
})

let failed = 0
for (const [name, body] of checks) {
  try {
    await body()
    process.stdout.write(`ok   ${name}\n`)
  } catch (error) {
    failed += 1
    process.stdout.write(`FAIL ${name}\n     ${error?.message?.split('\n').join('\n     ')}\n`)
  }
}
process.stdout.write(`\n${checks.length - failed}/${checks.length} probe checks passed\n`)
process.exitCode = failed === 0 ? 0 : 1
