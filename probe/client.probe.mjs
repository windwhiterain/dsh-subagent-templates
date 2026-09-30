/**
 * Offline probe for the browser half of `dsh-subagent-templates`.
 *
 * `client.js` is served as one classic script, so the only way to check it
 * without a browser is to run the file the way the module system runs it: give
 * it a `window.__ModuleLoader__` and a `require`, take the plugin it builds, and
 * drive the tab body it registers against a jsdom document and the real React.
 * React, react-dom, and jsdom come from the Harness checkout's pnpm store — this
 * plugin depends on none of them.
 *
 *   node probe/client.probe.mjs
 *
 * It checks the two-stage tab registration, the dictionary pair, the row the
 * panel draws, the two actions, the refusal path, and the two ways a child stops
 * being listed. It then drives the settings page the same way: the registration
 * that follows the served namespace, the summary view, the editor the page
 * draws, and the operations every edit hands the stubbed form scope. Its last
 * settings check imports the row's own normalizer and drives one table of tool
 * filter shapes through both sides, so the page's rules can only drift from the
 * row's by failing.
 */

import assert from 'node:assert/strict'
import { readdirSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { createRequire } from 'node:module'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { runInNewContext } from 'node:vm'
// The row's own normalizer is the authority on what the row accepts, so the
// filter-shape correspondence check below drives both sides from one table.
import { normalizeConfig } from '../lib/config.js'

/** The Harness checkout whose pnpm store holds React, react-dom, and jsdom. */
const HARNESS = process.env.DSH_HARNESS_ROOT ?? 'C:/resource/deepseek-harness'
/** This plugin's checkout, derived from this file's own location. */
const PLUGIN = dirname(dirname(fileURLToPath(import.meta.url)))
const STORE = join(HARNESS, 'node_modules', '.pnpm')

/**
 * Resolve one package from the Harness checkout's pnpm store, which is the only
 * place this plugin's browser half can find React. The store keeps each package
 * under a versioned directory whose own `node_modules` holds its dependencies, so
 * a resolver rooted there finds the entry Node would load.
 * @param name - the package to import.
 * @param prefix - the `<name>@<version>` store directory prefix to match.
 * @returns a file URL of the package's entry point.
 */
function fromStore(name, prefix) {
  const directory = readdirSync(STORE).find(entry => entry.startsWith(prefix))
  assert.ok(directory !== undefined, `${name} is not in the Harness pnpm store`)
  const base = join(STORE, directory, 'node_modules')
  return pathToFileURL(createRequire(join(base, name, 'index.js')).resolve(name)).href
}

const React = await import(fromStore('react', 'react@18'))
const { createRoot } = await import(fromStore('react-dom/client', 'react-dom@18.3.1'))
const { act, Simulate } = await import(fromStore('react-dom/test-utils', 'react-dom@18.3.1'))
const { JSDOM } = await import(fromStore('jsdom', 'jsdom@29'))

const dom = new JSDOM('<!doctype html><html><head></head><body><div id="root"></div></body></html>')
// Node 24 defines some of these as getter-only globals, so each is installed
// rather than assigned.
for (const [key, value] of Object.entries({
  window: dom.window,
  document: dom.window.document,
  navigator: dom.window.navigator,
  HTMLElement: dom.window.HTMLElement,
  Event: dom.window.Event,
  MouseEvent: dom.window.MouseEvent,
  IS_REACT_ACT_ENVIRONMENT: true,
})) {
  Object.defineProperty(globalThis, key, { value, configurable: true, writable: true })
}

let handoff
dom.window.__ModuleLoader__ = { load: registration => { handoff = registration } }
await import(pathToFileURL(join(PLUGIN, 'client.js')).href)

assert.ok(handoff !== undefined, 'the client half registered itself with the module loader')
assert.equal(handoff.id, 'dsh-subagent-templates')

/** Stand-ins for the shared primitives, so the probe reads its own markup. */
const primitives = {
  Button: props => React.createElement(
    'button',
    {
      type: 'button',
      'data-variant': props.variant ?? 'ghost',
      disabled: props.disabled === true,
      onClick: props.onClick,
      title: props.title,
    },
    props.children,
  ),
  StateDot: props => React.createElement('i', { 'data-state': props.state }),
  Input: ({ icon: _icon, ...rest }) => React.createElement('input', rest),
  SegmentedControl: props => React.createElement(
    'div',
    { role: 'tablist', 'aria-label': props.label },
    props.options.map(option => React.createElement('button', {
      key: option.value,
      id: `${props.id}-${option.value}`,
      type: 'button',
      role: 'tab',
      'aria-selected': option.value === props.value,
      disabled: props.disabled === true || option.disabled === true,
      onClick: () => { props.onChange(option.value) },
    }, option.label)),
  ),
  Tag: props => React.createElement('span', { 'data-tone': props.tone }, props.children),
  // The bubble is an overlay this probe has no viewport for; the anchor is what
  // the assertions reach.
  Tooltip: props => props.children,
  Toast: props => React.createElement('div', { 'data-toast': props.text }, props.text),
}

/** The minimal snapshot store the settings page builds its state on. */
const storeModule = {
  createSnapshotStore: (initial) => {
    let state = initial
    const listeners = new Set()
    const publish = () => { for (const listener of [...listeners]) listener() }
    return {
      getSnapshot: () => state,
      subscribe: (listener) => {
        listeners.add(listener)
        return () => { listeners.delete(listener) }
      },
      set: (next) => { state = next; publish() },
      update: (mutator) => {
        const draft = structuredClone(state)
        mutator(draft)
        state = draft
        publish()
      },
    }
  },
}

const plugin = handoff.factory(specifier => {
  if (specifier === 'react') return React
  if (specifier === '@deepseek-ai/dsh-client-ui-primitives') return primitives
  if (specifier === '@deepseek-ai/dsh-client-store') return storeModule
  throw new Error(`the client half required an unexpected module: ${specifier}`)
})

/**
 * Replace `{name}` placeholders the way the locale service does, so the probe
 * asserts the copy the plugin actually registered.
 * @param template - the registered dictionary entry.
 * @param params - the interpolation values.
 * @returns the rendered string.
 */
function interpolate(template, params) {
  return String(template).replace(/\{(\w+)\}/g, (whole, key) => (params?.[key] ?? whole))
}

const checks = []
/** Register one probe check. */
function check(name, body) {
  checks.push([name, body])
}

// --- The plugin's own apply, against a fake client context ---------------------

const opened = []
const archived = []
let dictionaries
let tabType
let body
const disposers = []

// The settings page's own seat: the Plugins surface's registrations, the
// namespaces the Host serves, and the form scope the page reads and writes.
const pages = []
const writes = []
const scopeListeners = new Set()
const servedListeners = new Set()
let servedNamespaces = new Set()
let configFormEntryId

/** The shipped layer the stub serves as `base`, and reverts a cleared field to. */
const baseSection = {
  templates: [
    { id: 'medium', name: 'Medium', preset: 'default', provider: 'deepseek', model: 'deepseek-v4' },
    { id: 'reviewer', name: 'Reviewer', pool: 'fast', reasoningEffort: 'high' },
  ],
  maxDepth: 1,
  maxActiveSubagents: 3,
}

/**
 * What the stub's Host document currently holds. It starts out unanswered, the
 * way a page mounted before the describe mirror's first read finds it.
 */
const section = {
  status: 'loading',
  writable: true,
  revision: 7,
  value: {},
  user: {},
  refuse: false,
}

/** Notify the page the way the shared form does after any snapshot change. */
function notifyScope() {
  for (const listener of [...scopeListeners]) listener()
}

/**
 * Serve a set of namespaces, the way the Host's describe mirror would.
 * @param namespaces - the namespaces to serve from now on.
 */
function setServed(namespaces) {
  servedNamespaces = new Set(namespaces)
  for (const listener of [...servedListeners]) listener()
}

/**
 * Apply one mutation the way the Host document would: the values land in the
 * section, the user layer records them, and the revision advances.
 * @param ops - the operations the page handed the scope.
 * @param revision - the revision the page fenced the write with.
 * @returns whether the Host accepted the write.
 */
async function mutateScope(ops, revision) {
  writes.push({ ops, revision })
  if (section.refuse === true) return false
  for (const op of ops) {
    const field = op.path[0]
    if (op.op === 'set') {
      section.value[field] = structuredClone(op.value)
      section.user[field] = structuredClone(op.value)
    } else {
      delete section.user[field]
      section.value[field] = structuredClone(baseSection[field])
    }
  }
  section.revision += 1
  notifyScope()
  return true
}

const formScope = {
  getSnapshot: () => ({
    status: section.status,
    value: section.value,
    base: baseSection,
    user: section.user,
    revision: section.revision,
    writable: section.writable,
    mode: 'host',
  }),
  subscribe: (listener) => {
    scopeListeners.add(listener)
    return () => { scopeListeners.delete(listener) }
  },
  mutate: mutateScope,
  unset: field => mutateScope([{ op: 'unset', path: [field] }]),
}

const configForms = {
  get: (entryId) => {
    configFormEntryId = entryId
    return formScope
  },
  // The real service keeps the registration alive exactly while the mirror
  // serves one of the namespaces; this stub follows the same transitions.
  whileServed: (namespaces, register) => {
    let off
    const sync = () => {
      const watched = namespaces.some(namespace => servedNamespaces.has(namespace))
      if (watched && off === undefined) off = register(servedNamespaces)
      else if (!watched && off !== undefined) {
        off()
        off = undefined
      }
    }
    servedListeners.add(sync)
    sync()
    return () => {
      servedListeners.delete(sync)
      off?.()
      off = undefined
    }
  },
}

// Whether the shell composed the settings client half. The stub `inject` below
// reads it the way cordis does: a callback runs only while every service it
// named is available, and what it registered is withdrawn when one goes away.
let configFormsAvailable = false
const injectWatchers = new Set()

/**
 * Run one injected child context the way cordis' `ctx.inject` does: the callback
 * runs only while every service it named is available, and it is given a context
 * carrying exactly those services plus the child's own effect seat.
 * @param dependencies - the service names the callback declared.
 * @param run - the callback, handed the child context.
 * @returns the disposer ending the child and everything the callback registered.
 */
function injectChild(dependencies, run) {
  let child
  const sync = () => {
    const ready = dependencies.every(dependency => dependency === 'configForms' && configFormsAvailable)
    if (ready && child === undefined) child = startChild(run)
    else if (!ready && child !== undefined) {
      child.dispose()
      child = undefined
    }
  }
  injectWatchers.add(sync)
  sync()
  return () => {
    injectWatchers.delete(sync)
    child?.dispose()
    child = undefined
  }
}

/**
 * One injected child context, and the effects registered through it.
 * @param run - the callback to run with the child.
 * @returns the child's disposer.
 */
function startChild(run) {
  const owned = []
  run({
    configForms,
    effect: (body) => {
      const disposer = body()
      owned.push(disposer)
      return disposer
    },
  })
  return {
    /** Dispose everything the callback registered through this child. */
    dispose() {
      for (const dispose of owned.splice(0)) dispose?.()
    },
  }
}

/**
 * Compose or unload the settings client half, as the shell does; a callback
 * whose service just appeared runs, and one whose service just went away is
 * withdrawn.
 * @param available - whether the settings surface is composed.
 */
function setConfigFormsAvailable(available) {
  configFormsAvailable = available
  for (const sync of [...injectWatchers]) sync()
}

const ctx = {
  locale: {
    bind: ns => (key, params) => interpolate(dictionaries[ns].en[key] ?? dictionaries[ns].zh[key], params),
    register: (ns, dicts) => {
      dictionaries = { ...dictionaries, [ns]: dicts }
      return () => {}
    },
  },
  sidebarRightTabs: { register: definition => { tabType = definition; return () => {} } },
  slots: {
    register: (spec, Component) => {
      // The Plugins surface's items and the right Sidebar's tab body share one
      // register, so the seat is told apart by the slot it names.
      if (spec.name === 'plugins.item') {
        const entry = { spec, Component }
        pages.push(entry)
        return () => {
          const at = pages.indexOf(entry)
          if (at !== -1) pages.splice(at, 1)
        }
      }
      body = { spec, Component }
      return () => {}
    },
    // Both seats are declared by the shell, so the injection runs at once.
    inject: (_name, run) => run(),
  },
  uiWorkspace: {
    openSession: id => { opened.push(id) },
    archiveSession: async (id, options) => { archived.push([id, options]) },
  },
  configForms,
  // The child a `ctx.inject` starts belongs to the calling fiber, so the
  // plugin's own disposal ends it.
  inject: (dependencies, run) => {
    const dispose = injectChild(dependencies, run)
    disposers.push(dispose)
    return dispose
  },
  effect: body2 => { const disposer = body2(); disposers.push(disposer); return disposer },
}

plugin.apply(ctx)
assert.deepEqual(plugin.inject, ['slots', 'sidebarRightTabs', 'locale', 'uiWorkspace'])

// --- The settings surface is optional to this bundle ----------------------------

check('a shell without the settings surface keeps the panel and offers no page', () => {
  // The panel is this bundle: it registers whether or not the settings client
  // half is anywhere in the shell.
  assert.equal(tabType.kind, 'subagent-templates')
  assert.equal(body.spec.name, 'sidebar.right.pane.tab')
  // Nothing asked for a settings scope, no page was offered, and the page's own
  // copy was never registered either.
  assert.equal(configFormEntryId, undefined)
  assert.deepEqual(pages, [])
  assert.equal(servedListeners.size, 0)
  assert.equal(dictionaries['settings.subagentTemplates'], undefined)
})

let settingsEntry
let settingsStore
let settingsActions

check('a shell with the settings surface gets the page beside the panel', () => {
  setConfigFormsAvailable(true)
  // The injected child asked for this plugin's own Loader row and no other, and
  // registered the page's copy with the rest of the page.
  assert.equal(configFormEntryId, 'subagent-templates')
  assert.equal(typeof dictionaries['settings.subagentTemplates']?.en, 'object')
  assert.equal(body.spec.name, 'sidebar.right.pane.tab')
  // The page follows its namespace: served, unserved, served again.
  assert.deepEqual(pages, [])
  setServed(['some-other-row'])
  assert.deepEqual(pages, [])
  setServed(['subagent-templates'])
  assert.equal(pages.length, 1)
  setServed([])
  assert.deepEqual(pages, [])
  setServed(['subagent-templates'])
  assert.equal(pages.length, 1)

  settingsEntry = pages[0]
  assert.equal(settingsEntry.spec.name, 'plugins.item')
  assert.equal(settingsEntry.spec.id, 'subagent-templates')
  assert.equal(settingsEntry.spec.order, 20)
  assert.equal(settingsEntry.spec.locale, 'settings.subagentTemplates')
  assert.equal(typeof settingsEntry.spec.label, 'function')
  assert.equal(settingsEntry.spec.label(), dictionaries['settings.subagentTemplates'].en['page.title'])

  const face = settingsEntry.spec.inject()
  // The renderer synthesizes one selector hook per face hook, named use<Name>.
  assert.deepEqual(Object.keys(face.hooks), ['subagentTemplatesPage'])
  settingsStore = face.hooks.subagentTemplatesPage
  const { hooks: _settingsHooks, ...actions } = face
  settingsActions = actions
})

// --- The standard kit the slot framework would hand the body -------------------

const KID = 'subagent-template-1'
const OTHER = 'subagent-template-2'
let view = {
  children: [
    { childSessionId: KID, name: 'explorer', templateName: 'Medium', createdAt: Date.now() - 5000 },
  ],
}
let sessions = { ids: [KID, 'parent-1'], byId: {}, phase: 'ready', projectionsBySession: {} }
let statuses = new Map([[KID, { running: true, pendingInteraction: undefined, completionUnread: false }]])

/**
 * Mount the panel with the current fixture values and return its root.
 * @returns the React root, for the next render or unmount.
 */
function mount() {
  const container = document.createElement('div')
  document.body.append(container)
  const root = createRoot(container)
  return { root, container }
}

let harnessRoot
let container

/**
 * Render the panel with the current fixtures and flush effects. A fresh mount
 * starts from the component's initial state, which is what a session switch
 * does; a re-render keeps the row-local state a click left behind.
 * @param options.fresh - unmount and mount again instead of re-rendering.
 * @returns the container the panel rendered into.
 */
async function render(options = {}) {
  if (options.fresh === true) {
    await act(async () => { harnessRoot.unmount() })
    ;({ root: harnessRoot, container } = mount())
  }
  await act(async () => {
    harnessRoot.render(React.createElement(body.Component, {
      useProjection: key => (key === 'subagentTemplates' ? view : undefined),
      useSessions: () => sessions,
      useSessionStatus: () => statuses,
      t: ctx.locale.bind('subagentTemplates'),
      ...body.spec.inject(),
    }))
  })
  return container
}

/**
 * Click one button by its exact text, inside act so React flushes the update.
 * @param container_ - the rendered container to search.
 * @param text - the button's text content.
 * @returns whether such a button existed and was clicked.
 */
async function clickText(container_, text) {
  const target = [...container_.querySelectorAll('button')].find(node => node.textContent === text)
  if (target === undefined) return false
  await act(async () => { target.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true })) })
  return true
}

/**
 * Click the open control on one named child row.
 * @param container_ - the rendered container to search.
 * @param name - the row's name.
 * @returns whether such a row existed and was clicked.
 */
async function clickName(container_, name) {
  const label = [...container_.querySelectorAll('.dsst-name')].find(node => node.textContent === name)
  if (label === undefined) return false
  await act(async () => { label.closest('button').dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true })) })
  return true
}

/** The destructive button inside the open confirmation line of a row. */
function confirmButton(container_) {
  return [...container_.querySelectorAll('.dsst-confirm button')].find(node => node.textContent === 'Delete')
}

/** The row element carrying one child's name. */
function rowOf(container_, name) {
  return [...container_.querySelectorAll('.dsst-row')]
    .find(row => row.querySelector('.dsst-name')?.textContent === name)
}

/**
 * Click one button by its exact text inside one named row.
 * @param container_ - the rendered container to search.
 * @param name - the row's name.
 * @param text - the button's text content.
 * @returns whether such a button existed and was clicked.
 */
async function clickRowButton(container_, name, text) {
  const target = [...(rowOf(container_, name)?.querySelectorAll('button') ?? [])]
    .find(node => node.textContent === text)
  if (target === undefined) return false
  await act(async () => { target.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true })) })
  return true
}

check('the client half registers a right-sidebar tab type in two stages', () => {
  assert.equal(tabType.kind, 'subagent-templates')
  assert.equal(tabType.id, 'dsh-subagent-templates/panel')
  assert.equal(tabType.priority, 'extension')
  // The body registers under the definition's own id, which is the dispatch key.
  assert.equal(body.spec.name, 'sidebar.right.pane.tab')
  assert.equal(body.spec.key, tabType.id)
  assert.equal(body.spec.locale, 'subagentTemplates')
  // Copy is thunked, so a language change needs no re-registration.
  assert.equal(typeof tabType.title, 'function')
  assert.equal(tabType.guide.length, 1)
  assert.equal(tabType.guide[0].title(), 'Subagents')
  assert.ok(tabType.guide[0].description().length > 0)
  // The body and the type agree on the panel's only namespace.
  assert.equal(tabType.title(), dictionaries.subagentTemplates.en['tab.title'])
})

check('both dictionaries carry exactly the same keys', () => {
  const zh = Object.keys(dictionaries.subagentTemplates.zh).sort()
  const en = Object.keys(dictionaries.subagentTemplates.en).sort()
  assert.deepEqual(zh, en)
  for (const key of zh) {
    for (const value of [dictionaries.subagentTemplates.zh[key], dictionaries.subagentTemplates.en[key]]) {
      assert.equal(typeof value, 'string')
      assert.ok(value.length > 0, `${key} is empty`)
    }
  }
})

check('an empty session explains itself instead of showing an empty box', async () => {
  view = { children: [] }
  sessions = { ids: ['parent-1'], byId: {}, phase: 'ready', projectionsBySession: {} }
  statuses = new Map()
  ;({ root: harnessRoot, container } = mount())
  await render()
  assert.match(container.textContent, /has not delegated anything yet/)
  assert.match(container.textContent, /subagent tool/)
})

check('a session list that has not arrived renders no verdict', async () => {
  sessions = { ids: [], byId: {}, phase: 'pending', projectionsBySession: {} }
  await render()
  assert.match(container.textContent, /Reading the session list/)
  assert.equal(container.textContent.includes('has not delegated'), false)
})

check('a child row shows its name, its template, and its running state', async () => {
  view = {
    children: [
      { childSessionId: KID, name: 'explorer', templateName: 'Medium', createdAt: Date.now() - 5000 },
      { childSessionId: OTHER, name: 'reviewer', templateName: 'High', createdAt: Date.now() - 7_200_000 },
    ],
  }
  sessions = { ids: [KID, OTHER, 'parent-1'], byId: {}, phase: 'ready', projectionsBySession: {} }
  statuses = new Map([
    [KID, { running: true, pendingInteraction: undefined, completionUnread: false }],
    [OTHER, { running: false, pendingInteraction: undefined, completionUnread: false }],
  ])
  await render()
  const rows = container.querySelectorAll('.dsst-row')
  assert.equal(rows.length, 2)
  const [running, finished] = rows
  assert.equal(running.querySelector('.dsst-name').textContent, 'explorer')
  assert.match(running.querySelector('.dsst-meta').textContent, /^Medium · \d+s$/)
  assert.equal(running.querySelector('i').dataset.state, 'ongoing')
  assert.equal(finished.querySelector('.dsst-name').textContent, 'reviewer')
  assert.match(finished.querySelector('.dsst-meta').textContent, /^High · \d+h$/)
  assert.equal(finished.querySelector('i').dataset.state, 'done')
})

check('a child the catalog no longer lists is not offered, unless it is running', async () => {
  // A child the user archived leaves the Host list; a running child is kept even
  // when the list has not caught up, so a live delegation never blinks out.
  sessions = { ids: ['parent-1'], byId: {}, phase: 'ready', projectionsBySession: {} }
  statuses = new Map([[KID, { running: true, pendingInteraction: undefined, completionUnread: false }]])
  await render()
  assert.equal(container.querySelectorAll('.dsst-row').length, 1)
  assert.equal(container.querySelector('.dsst-name').textContent, 'explorer')

  statuses = new Map([[KID, { running: false, pendingInteraction: undefined, completionUnread: false }]])
  await render()
  assert.equal(container.querySelectorAll('.dsst-row').length, 0)
  assert.match(container.textContent, /has not delegated anything yet/)
})

check('clicking a name opens that child as an ordinary session', async () => {
  sessions = { ids: [KID, OTHER, 'parent-1'], byId: {}, phase: 'ready', projectionsBySession: {} }
  await render()
  assert.equal(await clickName(container, 'explorer'), true)
  assert.deepEqual(opened, [KID])
})

check('deleting asks first, then stops and archives the child', async () => {
  assert.equal(await clickText(container, 'Delete'), true)
  // The confirmation sits inside the row, and the archive has not started.
  assert.match(container.textContent, /Stop and delete explorer\?/)
  assert.equal(archived.length, 0)
  assert.equal(container.querySelectorAll('.dsst-row').length, 2)

  await act(async () => { confirmButton(container).dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true })) })
  await act(async () => {})
  // The shipped archive-with-stop, not a lifecycle this plugin invented.
  assert.deepEqual(archived, [[KID, { stopActivity: true }]])
  // The row keeps its place with its controls disabled while the archive runs.
  assert.equal(container.querySelectorAll('.dsst-row').length, 2)
  assert.match(container.textContent, /Stopping…/)
  assert.equal(container.querySelector('.dsst-open').disabled, true)

  // The child leaves when the Session catalog drops it, which is the archive's
  // own consequence rather than the panel's optimism.
  await render()
  sessions = { ids: [OTHER, 'parent-1'], byId: {}, phase: 'ready', projectionsBySession: {} }
  await render()
  assert.equal(container.querySelectorAll('.dsst-row').length, 1)
  assert.equal(container.querySelector('.dsst-name').textContent, 'reviewer')
})

check('keeping the child closes the question and changes nothing', async () => {
  assert.equal(await clickText(container, 'Delete'), true)
  assert.equal(await clickText(container, 'Keep'), true)
  assert.equal(archived.length, 1)
  assert.equal(container.querySelectorAll('.dsst-row').length, 1)
  assert.equal(container.textContent.includes('Stop and delete'), false)
  // The question can be asked again on the same row.
  assert.equal(await clickText(container, 'Delete'), true)
  assert.match(container.textContent, /Stop and delete reviewer\?/)
})

check('a refused archive keeps the row and puts the reason on it', async () => {
  const original = ctx.uiWorkspace.archiveSession
  ctx.uiWorkspace.archiveSession = async () => { throw new Error('workspace is locked') }
  try {
    // A fresh mount with both children listed, so the row starts from its own
    // initial state and the refusal has something to keep.
    sessions = { ids: [KID, OTHER, 'parent-1'], byId: {}, phase: 'ready', projectionsBySession: {} }
    await render({ fresh: true })
    assert.equal(container.querySelectorAll('.dsst-row').length, 2)
    assert.equal(await clickName(container, 'reviewer'), true)
    // The question opens on the row it belongs to, and confirms on that row.
    assert.equal(await clickRowButton(container, 'reviewer', 'Delete'), true)
    assert.match(rowOf(container, 'reviewer').textContent, /Stop and delete reviewer\?/)
    assert.equal(rowOf(container, 'explorer').textContent.includes('Stop and delete'), false)
    assert.equal(await clickRowButton(container, 'reviewer', 'Delete'), true)
    await act(async () => {})
    assert.equal(container.querySelectorAll('.dsst-row').length, 2)
    assert.match(container.querySelector('.dsst-error').textContent, /Could not delete: Error: workspace is locked/)
    assert.equal(container.textContent.includes('Stopping'), false)
  } finally {
    ctx.uiWorkspace.archiveSession = original
  }
})

// --- The settings page, driven the way the Plugins surface drives it ------------

let settingsRoot
let settingsContainer

/**
 * Render the settings page with the current section fixtures, mounting it once.
 * @param view - the view the Plugins surface asks for.
 * @returns the container the page rendered into.
 */
async function renderPage(view) {
  if (settingsRoot === undefined) {
    settingsContainer = document.createElement('div')
    document.body.append(settingsContainer)
    settingsRoot = createRoot(settingsContainer)
  }
  await act(async () => {
    settingsRoot.render(React.createElement(settingsEntry.Component, {
      view,
      t: ctx.locale.bind('settings.subagentTemplates'),
      // What the renderer synthesizes from the inject face's `hooks`.
      useSubagentTemplatesPage: selector => selector(React.useSyncExternalStore(
        settingsStore.subscribe, settingsStore.getSnapshot, settingsStore.getSnapshot,
      )),
      ...settingsActions,
    }))
  })
  return settingsContainer
}

/**
 * Type into one control the way a user edits it.
 *
 * The value goes in through the host element prototype's setter, so React's
 * value tracker sees a change it did not originate. The event then goes through
 * React's own `Simulate`: jsdom implements no `oninput` IDL attribute, so
 * React's `isInputEventSupported` probe fails there and it falls back to an
 * IE-era value-change polyfill, under which a dispatched native `input` reports
 * nothing and only a `keyup` against the focused element does — a path no
 * browser runs. `Simulate.change` is the one route that reaches the same
 * `onChange` prop the browser would reach, on every edit.
 * @param container_ - the rendered container to search.
 * @param id - the control's id.
 * @param text - the text to type.
 */
async function typeInto(container_, id, text) {
  const node = container_.querySelector(`#${id}`)
  assert.ok(node !== null, `no control with id ${id}`)
  const prototype = node.tagName === 'TEXTAREA'
    ? dom.window.HTMLTextAreaElement.prototype
    : dom.window.HTMLInputElement.prototype
  await act(async () => {
    Object.getOwnPropertyDescriptor(prototype, 'value').set.call(node, text)
    Simulate.change(node, { target: { value: text } })
  })
}

/**
 * Click one element by its id, inside act.
 * @param container_ - the rendered container to search.
 * @param id - the element's id.
 * @returns whether such an element existed and was clicked.
 */
async function clickId(container_, id) {
  const node = container_.querySelector(`#${id}`)
  if (node === null) return false
  await act(async () => { node.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true })) })
  return true
}

/**
 * Click one button by its exact text, inside act.
 * @param container_ - the rendered container to search.
 * @param text - the button's text content.
 * @returns whether such a button existed and was clicked.
 */
async function clickButtonText(container_, text) {
  const target = [...container_.querySelectorAll('button')].find(node => node.textContent === text)
  if (target === undefined) return false
  await act(async () => { target.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true })) })
  return true
}

/**
 * Click one button by its exact text inside one template row.
 * @param container_ - the rendered container to search.
 * @param index - the row's index.
 * @param text - the button's text content.
 * @returns whether such a button existed and was clicked.
 */
async function clickTemplateAction(container_, index, text) {
  const row = container_.querySelectorAll('.dsst-template')[index]
  if (row === undefined) return false
  const target = [...row.querySelectorAll('button')].find(node => node.textContent === text)
  if (target === undefined) return false
  await act(async () => { target.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true })) })
  return true
}

/**
 * Click Save and let the write settle.
 * @param container_ - the rendered container to search.
 */
async function save(container_) {
  assert.equal(await clickButtonText(container_, 'Save'), true)
  await act(async () => {})
}

/**
 * The Save control, which every write check reads for its enabled state.
 * @param container_ - the rendered container to search.
 * @returns the Save button, or undefined when the page does not draw one.
 */
function saveButton(container_) {
  return [...container_.querySelectorAll('button')].find(node => node.textContent === 'Save')
}

check('the bundle declares nothing in the shared batch scope', () => {
  let registration
  const scope = { window: { __ModuleLoader__: { load: (value) => { registration = value } } } }
  runInNewContext(readFileSync(join(PLUGIN, 'client.js'), 'utf8'), scope)
  // The file's only top-level statement is the registration: a `var` or an
  // implicit global anywhere in it would land on the batch scope it runs in.
  assert.deepEqual(Object.keys(scope), ['window'])
  assert.deepEqual(Object.keys(scope.window), ['__ModuleLoader__'])
  assert.equal(registration.id, 'dsh-subagent-templates')
})

check('the settings dictionaries carry exactly the same keys', () => {
  const dicts = dictionaries['settings.subagentTemplates']
  const zhSettings = Object.keys(dicts.zh).sort()
  const enSettings = Object.keys(dicts.en).sort()
  assert.deepEqual(zhSettings, enSettings)
  assert.ok(zhSettings.length > 0)
  for (const key of zhSettings) {
    for (const value of [dicts.zh[key], dicts.en[key]]) {
      assert.equal(typeof value, 'string')
      assert.ok(value.length > 0, `${key} is empty`)
    }
  }
})

check('a section that arrives after the page mounted seeds the editor', async () => {
  // The page is created while the Host has not answered yet, which is the state
  // a slow settings read leaves it in; the row it edits must appear once the
  // first section arrives rather than staying at the draft it was created with.
  await renderPage('page')
  assert.equal(settingsContainer.querySelectorAll('.dsst-template').length, 0)
  assert.match(settingsContainer.textContent, /Reading the configuration/)
  await act(async () => {
    section.status = 'ready'
    section.value = structuredClone(baseSection)
    notifyScope()
  })
  assert.equal(settingsContainer.querySelectorAll('.dsst-template').length, 2)
  assert.equal(settingsContainer.querySelector('#dsst-limit-maxDepth').value, '1')
  assert.equal(settingsContainer.textContent.includes('Reading the configuration'), false)
})

check('the summary view answers with one line', async () => {
  await renderPage('summary')
  assert.equal(settingsContainer.textContent, dictionaries['settings.subagentTemplates'].en['page.summary'])
})

check('the editor draws both limits and both template routes', async () => {
  await renderPage('page')
  assert.equal(settingsContainer.querySelector('#dsst-limit-maxDepth').value, '1')
  assert.equal(settingsContainer.querySelector('#dsst-limit-maxActiveSubagents').value, '3')
  assert.equal(settingsContainer.querySelectorAll('.dsst-template').length, 2)
  assert.equal(settingsContainer.querySelector('#dsst-template-0-id').value, 'medium')
  assert.equal(settingsContainer.querySelector('#dsst-template-0-provider').value, 'deepseek')
  // A fixed row offers provider and model; a pool row offers the pool instead.
  assert.equal(settingsContainer.querySelector('#dsst-template-0-pool'), null)
  assert.equal(settingsContainer.querySelector('#dsst-template-1-pool').value, 'fast')
  assert.equal(settingsContainer.querySelector('#dsst-template-1-provider'), null)
  // The route is a rendered choice between the two modes, not a text field.
  assert.equal(settingsContainer.querySelector('#dsst-template-0-route-fixed').getAttribute('aria-selected'), 'true')
  assert.equal(settingsContainer.querySelector('#dsst-template-1-route-pool').getAttribute('aria-selected'), 'true')
})

check('discarding drops the draft without writing', async () => {
  writes.length = 0
  await typeInto(settingsContainer, 'dsst-template-0-name', 'Renamed')
  assert.equal(settingsContainer.querySelector('#dsst-template-0-name').value, 'Renamed')
  assert.equal(writes.length, 0)
  assert.equal(await clickButtonText(settingsContainer, 'Discard'), true)
  assert.equal(settingsContainer.querySelector('#dsst-template-0-name').value, 'Medium')
  assert.equal(writes.length, 0)
})

check('a changed description rides one whole-value write', async () => {
  writes.length = 0
  await typeInto(settingsContainer, 'dsst-template-0-description', 'Delegates at medium effort.')
  await save(settingsContainer)
  // One mutation carries every edited field: the whole array and both numbers.
  assert.equal(writes.length, 1)
  assert.equal(writes[0].revision, 7)
  assert.deepEqual(writes[0].ops, [
    {
      op: 'set',
      path: ['templates'],
      value: [
        {
          id: 'medium',
          name: 'Medium',
          description: 'Delegates at medium effort.',
          provider: 'deepseek',
          model: 'deepseek-v4',
          preset: 'default',
        },
        { id: 'reviewer', name: 'Reviewer', pool: 'fast', reasoningEffort: 'high' },
      ],
    },
    { op: 'set', path: ['maxDepth'], value: 1 },
    { op: 'set', path: ['maxActiveSubagents'], value: 3 },
  ])
  // The accepted write re-seeds the draft, so nothing is left to save.
  assert.equal(saveButton(settingsContainer).disabled, true)
})

check('adding a template appends it to the written array', async () => {
  writes.length = 0
  assert.equal(await clickButtonText(settingsContainer, 'Add template'), true)
  await typeInto(settingsContainer, 'dsst-template-2-id', 'fast')
  await typeInto(settingsContainer, 'dsst-template-2-name', 'Fast')
  await typeInto(settingsContainer, 'dsst-template-2-provider', 'deepseek')
  await typeInto(settingsContainer, 'dsst-template-2-model', 'deepseek-v4-flash')
  await save(settingsContainer)
  assert.equal(writes.length, 1)
  const templates = writes[0].ops[0].value
  assert.equal(templates.length, 3)
  assert.deepEqual(templates[2], { id: 'fast', name: 'Fast', provider: 'deepseek', model: 'deepseek-v4-flash' })
})

check('moving a template reorders the written array', async () => {
  writes.length = 0
  assert.equal(await clickTemplateAction(settingsContainer, 2, 'Move up'), true)
  await save(settingsContainer)
  assert.equal(writes.length, 1)
  assert.deepEqual(writes[0].ops[0].value.map(row => row.id), ['medium', 'fast', 'reviewer'])
})

check('switching a route mode writes the new route and drops the other', async () => {
  writes.length = 0
  assert.equal(await clickId(settingsContainer, 'dsst-template-0-route-pool'), true)
  await typeInto(settingsContainer, 'dsst-template-0-pool', 'slow')
  await save(settingsContainer)
  assert.equal(writes.length, 1)
  const [first] = writes[0].ops[0].value
  assert.deepEqual(first, {
    id: 'medium',
    name: 'Medium',
    description: 'Delegates at medium effort.',
    pool: 'slow',
    preset: 'default',
  })
  assert.equal('provider' in first, false)
  assert.equal('model' in first, false)
})

check('a blank id blocks the save and is reported inline', async () => {
  writes.length = 0
  await typeInto(settingsContainer, 'dsst-template-2-id', '')
  assert.equal(settingsContainer.querySelector('#dsst-template-2-id').getAttribute('aria-invalid'), 'true')
  assert.match(settingsContainer.textContent, /An id is required\./)
  await save(settingsContainer)
  assert.equal(writes.length, 0)
  await typeInto(settingsContainer, 'dsst-template-2-id', 'reviewer')
})

check('an invalid tool filter blocks the save and is reported inline', async () => {
  writes.length = 0
  await typeInto(settingsContainer, 'dsst-template-0-toolFilter', '{"deny":')
  assert.match(settingsContainer.textContent, /Not valid JSON/)
  assert.equal(saveButton(settingsContainer).disabled, true)
  await save(settingsContainer)
  assert.equal(writes.length, 0)
})

check('a tool filter with neither side blocks the save with its own message', async () => {
  writes.length = 0
  // The object is well-formed JSON, so this is not the syntax case: the row
  // refuses a filter that carries neither side, and the page must say so before
  // the save rather than let a write land on a value the row rejects.
  await typeInto(settingsContainer, 'dsst-template-0-toolFilter', '{}')
  await act(async () => {})
  assert.match(settingsContainer.textContent, /Name at least one tool in allow or deny\./)
  assert.equal(settingsContainer.textContent.includes('Not valid JSON'), false)
  assert.equal(saveButton(settingsContainer).disabled, true)
  await save(settingsContainer)
  assert.equal(writes.length, 0)

  // One side present is enough, whichever side it is, even when the other side
  // is present and empty: the row accepts that shape, so the page does.
  await typeInto(settingsContainer, 'dsst-template-0-toolFilter', '{"allow":[],"deny":["write"]}')
  await act(async () => {})
  assert.equal(settingsContainer.textContent.includes('Name at least one tool'), false)
})

check('a tool filter whose list holds a blank name blocks the save with its own message', async () => {
  writes.length = 0
  // An empty string is not a tool name, even when the list is otherwise usable:
  // the row refuses the filter, so the page refuses the save.
  await typeInto(settingsContainer, 'dsst-template-0-toolFilter', '{"allow":["read",""],"deny":["write"]}')
  await act(async () => {})
  assert.match(settingsContainer.textContent, /Blank tool names are not allowed\./)
  assert.equal(settingsContainer.textContent.includes('Name at least one tool'), false)
  assert.equal(saveButton(settingsContainer).disabled, true)
  await save(settingsContainer)
  assert.equal(writes.length, 0)

  // A blank name in `deny` alone, with `allow` fine, is refused just the same.
  await typeInto(settingsContainer, 'dsst-template-0-toolFilter', '{"allow":["read"],"deny":["write",""]}')
  await act(async () => {})
  assert.match(settingsContainer.textContent, /Blank tool names are not allowed\./)
  await save(settingsContainer)
  assert.equal(writes.length, 0)

  // A side that is a blank name and nothing else is the same repair, not a
  // filter that named nothing.
  await typeInto(settingsContainer, 'dsst-template-0-toolFilter', '{"deny":[""]}')
  await act(async () => {})
  assert.match(settingsContainer.textContent, /Blank tool names are not allowed\./)
  await save(settingsContainer)
  assert.equal(writes.length, 0)

  // A side that is not a list at all cannot carry names either.
  await typeInto(settingsContainer, 'dsst-template-0-toolFilter', '{"allow":"read"}')
  await act(async () => {})
  assert.match(settingsContainer.textContent, /Blank tool names are not allowed\./)
  await save(settingsContainer)
  assert.equal(writes.length, 0)
})

check('a tool filter with a key the row does not know blocks the save with its own message', async () => {
  writes.length = 0
  // The row refuses an unknown filter key with its own issue, so the page says
  // which repair this is rather than letting the write land and be rejected.
  await typeInto(settingsContainer, 'dsst-template-0-toolFilter', '{"allow":["read"],"foo":1}')
  await act(async () => {})
  assert.match(settingsContainer.textContent, /A tool filter takes only allow and deny\./)
  assert.equal(saveButton(settingsContainer).disabled, true)
  await save(settingsContainer)
  assert.equal(writes.length, 0)

  // An extra key beside an otherwise usable filter is the same repair.
  await typeInto(settingsContainer, 'dsst-template-0-toolFilter', '{"deny":["write"],"extra":[]}')
  await act(async () => {})
  assert.match(settingsContainer.textContent, /A tool filter takes only allow and deny\./)
  await save(settingsContainer)
  assert.equal(writes.length, 0)
})

check('a tool filter the row accepts is written exactly as typed', async () => {
  writes.length = 0
  await typeInto(settingsContainer, 'dsst-template-0-toolFilter', '{"deny":["write"]}')
  await act(async () => {})
  await save(settingsContainer)
  assert.equal(writes.length, 1)
  assert.deepEqual(writes[0].ops[0].value[0].toolFilter, { deny: ['write'] })

  writes.length = 0
  await typeInto(settingsContainer, 'dsst-template-0-toolFilter', '{"allow":["read"]}')
  await act(async () => {})
  await save(settingsContainer)
  assert.equal(writes.length, 1)
  assert.deepEqual(writes[0].ops[0].value[0].toolFilter, { allow: ['read'] })

  // Both sides, and a list of several names, are written as typed too.
  writes.length = 0
  await typeInto(settingsContainer, 'dsst-template-0-toolFilter', '{"allow":["read","grep"],"deny":["write"]}')
  await act(async () => {})
  assert.equal(settingsContainer.textContent.includes('Blank tool names'), false)
  await save(settingsContainer)
  assert.equal(writes.length, 1)
  assert.deepEqual(writes[0].ops[0].value[0].toolFilter, { allow: ['read', 'grep'], deny: ['write'] })

  // A present but empty side is the row's own lockout — a child left with
  // nothing but ask_parent — so the page saves one as typed rather than
  // refusing a filter a hand-written row may legitimately carry.
  writes.length = 0
  await typeInto(settingsContainer, 'dsst-template-0-toolFilter', '{"allow":[]}')
  await act(async () => {})
  assert.equal(settingsContainer.textContent.includes('Name at least one tool'), false)
  assert.equal(saveButton(settingsContainer).disabled, false)
  await save(settingsContainer)
  assert.equal(writes.length, 1)
  assert.deepEqual(writes[0].ops[0].value[0].toolFilter, { allow: [] })
})

check('a blank tool filter stays valid and writes no filter at all', async () => {
  writes.length = 0
  // Blank is how a template says "the child keeps its whole tool set" — the one
  // case the row's schema must never fill in — so the written row omits the key.
  await typeInto(settingsContainer, 'dsst-template-0-toolFilter', '')
  await act(async () => {})
  assert.equal(settingsContainer.textContent.includes('Name at least one tool'), false)
  assert.equal(settingsContainer.textContent.includes('Blank tool names'), false)
  assert.equal(settingsContainer.textContent.includes('Not valid JSON'), false)
  await save(settingsContainer)
  assert.equal(writes.length, 1)
  assert.equal('toolFilter' in writes[0].ops[0].value[0], false)
})

check('restoring the shipped defaults clears the three fields', async () => {
  writes.length = 0
  assert.equal(await clickButtonText(settingsContainer, 'Restore shipped defaults'), true)
  await act(async () => {})
  assert.deepEqual(writes.map(write => write.ops), [
    [{ op: 'unset', path: ['templates'] }],
    [{ op: 'unset', path: ['maxDepth'] }],
    [{ op: 'unset', path: ['maxActiveSubagents'] }],
  ])
  // The page follows the cleared section: the shipped list is back, and the
  // invalid filter went with the rest of the draft.
  assert.equal(settingsContainer.querySelectorAll('.dsst-template').length, 2)
  assert.equal(settingsContainer.querySelector('#dsst-template-0-id').value, 'medium')
  assert.equal(settingsContainer.querySelector('#dsst-template-0-toolFilter').value, '')
  assert.equal(settingsContainer.querySelector('#dsst-template-0-route-fixed').getAttribute('aria-selected'), 'true')
})

check('a refused write keeps the draft and reports the refusal', async () => {
  writes.length = 0
  section.refuse = true
  await typeInto(settingsContainer, 'dsst-template-0-name', 'Refused')
  await save(settingsContainer)
  assert.equal(writes.length, 1)
  assert.match(settingsContainer.textContent, /The host refused this save/)
  // The draft is not thrown away, so the user can correct what was refused.
  assert.equal(settingsContainer.querySelector('#dsst-template-0-name').value, 'Refused')
  section.refuse = false
  await clickButtonText(settingsContainer, 'Discard')
  assert.equal(settingsContainer.querySelector('#dsst-template-0-name').value, 'Medium')
})

check('a limit the user layer carries is marked, and its reset clears the override', async () => {
  writes.length = 0
  await act(async () => {
    section.user.maxActiveSubagents = 4
    section.value.maxActiveSubagents = 4
    notifyScope()
  })
  const limit = settingsContainer.querySelector('#dsst-limit-maxActiveSubagents')
  assert.equal(limit.value, '4')
  // The mark and its reset ride the field head above the control.
  assert.match(limit.closest('.dsst-field').textContent, /Overridden/)
  const reset = [...limit.closest('.dsst-field').querySelectorAll('button')]
    .find(node => node.textContent === 'Restore')
  await act(async () => { reset.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true })) })
  await act(async () => {})
  // Clearing a number is a write of its own: a whole-value save would store the
  // value it wrote as the user's own, which is not what a reset means.
  assert.deepEqual(writes.map(write => write.ops), [[{ op: 'unset', path: ['maxActiveSubagents'] }]])
  assert.equal(settingsContainer.querySelector('#dsst-limit-maxActiveSubagents').value, '3')
  assert.equal(limit.closest('.dsst-field').textContent.includes('Overridden'), false)
})

check('a row field the user layer carries is marked, and its reset restores the shipped value', async () => {
  writes.length = 0
  await act(async () => {
    section.user.templates = [
      { ...baseSection.templates[0], model: 'deepseek-v4-flash' },
      structuredClone(baseSection.templates[1]),
    ]
    section.value.templates = structuredClone(section.user.templates)
    notifyScope()
  })
  const model = settingsContainer.querySelector('#dsst-template-0-model')
  assert.equal(model.value, 'deepseek-v4-flash')
  assert.match(model.closest('.dsst-field').textContent, /Overridden/)
  // The shipped row's own fields are not marked: only the one the user changed is.
  assert.equal(settingsContainer.querySelector('#dsst-template-0-name')
    .closest('.dsst-field').textContent.includes('Overridden'), false)
  const reset = [...model.closest('.dsst-field').querySelectorAll('button')]
    .find(node => node.textContent === 'Restore')
  await act(async () => { reset.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true })) })
  // A template row is written as a whole array, so a field reset revises the
  // draft; the write that lands it is the next save.
  assert.equal(settingsContainer.querySelector('#dsst-template-0-model').value, 'deepseek-v4')
  assert.equal(writes.length, 0)
})

check('a locked deployment disables the editor and says why', async () => {
  await act(async () => { section.writable = false; notifyScope() })
  assert.match(settingsContainer.textContent, /A home patch or a command-line overlay owns this configuration/)
  assert.equal(settingsContainer.querySelector('#dsst-limit-maxDepth').disabled, true)
  assert.equal(settingsContainer.querySelector('#dsst-template-0-id').disabled, true)
  assert.equal(settingsContainer.querySelector('#dsst-template-0-description').disabled, true)
  await act(async () => { section.writable = true; notifyScope() })
  assert.equal(settingsContainer.textContent.includes('home patch'), false)
})

check('a namespace the Host stops serving renders nothing at all', async () => {
  await act(async () => { section.status = 'unavailable'; notifyScope() })
  assert.equal(settingsContainer.textContent, '')
  await act(async () => { section.status = 'ready'; notifyScope() })
  assert.notEqual(settingsContainer.textContent, '')
})

// --- The page's filter rules against the row's own normalizer ------------------

/**
 * One template the row accepts unchanged, the carrier for every filter shape
 * below: with everything else held fixed, the filter alone decides each verdict.
 */
const ROW_TEMPLATE = {
  id: 'medium',
  name: 'Medium',
  description: 'Executes and explores.',
  provider: 'command-code-goat',
  model: 'deepseek/deepseek-v4.1-flash',
}

/**
 * Every filter shape the page and the row are asked about, as the parsed value
 * the page would write; `undefined` is the blank field, which the page omits
 * from the write and the row therefore never sees.
 */
const FILTER_SHAPES = [
  { label: 'an absent filter', value: undefined },
  { label: 'a deny-only filter', value: { deny: ['write'] } },
  { label: 'an allow-only filter', value: { allow: ['read'] } },
  { label: 'an allow and a deny', value: { allow: ['read', 'grep'], deny: ['write'] } },
  { label: 'an empty allow beside a deny', value: { allow: [], deny: ['write'] } },
  { label: 'an empty filter', value: {} },
  { label: 'an empty allow', value: { allow: [] } },
  { label: 'a blank deny entry', value: { deny: [''] } },
  { label: 'a blank entry beside a good one', value: { allow: ['read', ''], deny: ['write'] } },
  { label: 'an allow that is not a list', value: { allow: 'read' } },
  { label: 'an unknown key beside a good allow', value: { allow: ['read'], foo: 1 } },
  { label: 'an unknown key beside a good deny', value: { deny: ['write'], extra: [] } },
]

/**
 * What the page's rules say about one filter shape, read the way the editor
 * decides it: the problem the field carries is what disables Save and draws the
 * inline message.
 * @param value - the parsed filter the page would write, or undefined for a blank field.
 * @returns whether the page accepts the shape.
 */
async function pageAcceptsFilter(value) {
  await typeInto(settingsContainer, 'dsst-template-0-toolFilter', value === undefined ? '' : JSON.stringify(value))
  await act(async () => {})
  return settingsStore.getSnapshot().templates[0].problems.toolFilter === undefined
}

/**
 * What the row's normalizer says about the same shape, carried by a template it
 * otherwise accepts.
 * @param value - the parsed filter the page would write, or undefined when the row omits it.
 * @returns whether `normalizeConfig` accepts the template carrying this filter.
 */
function rowAcceptsFilter(value) {
  const template = { ...ROW_TEMPLATE }
  if (value !== undefined) template.toolFilter = value
  try {
    normalizeConfig({ templates: [template] })
    return true
  } catch (_refused) {
    return false
  }
}

check('the page and the row agree on every tool-filter shape', async () => {
  const disagreements = []
  const table = []
  for (const shape of FILTER_SHAPES) {
    const page = await pageAcceptsFilter(shape.value)
    const row = rowAcceptsFilter(shape.value)
    table.push(`     ${row ? 'row accepts' : 'row refuses'}  ${page ? 'page accepts' : 'page refuses'}  ${shape.label}\n`)
    if (page && !row) disagreements.push(`the page allows ${shape.label}, but the row refuses it`)
    if (!page && row) disagreements.push(`the page blocks ${shape.label}, but the row accepts it`)
  }
  process.stdout.write(table.join(''))
  // A page stricter than the row is as much a drift as a page looser than it:
  // either way one side is deciding a filter shape the other disagrees with.
  assert.deepEqual(disagreements, [])
})

check('unloading the settings surface withdraws the page, and disposing the plugin ends it', () => {
  // Unmounting the surface alone takes the page, its watch, and its scope
  // subscription down with it; the panel registered from the same apply stays.
  setConfigFormsAvailable(false)
  assert.deepEqual(pages, [])
  assert.equal(servedListeners.size, 0)
  assert.equal(tabType.kind, 'subagent-templates')
  // Composing it again offers the page once more.
  setConfigFormsAvailable(true)
  assert.equal(pages.length, 1)
  // The plugin's own disposal ends the child it started.
  for (const dispose of disposers) dispose?.()
  assert.deepEqual(pages, [])
  assert.equal(servedListeners.size, 0)
})

let failed = 0
for (const [name, body2] of checks) {
  try {
    await body2()
    process.stdout.write(`ok   ${name}\n`)
  } catch (error) {
    failed += 1
    process.stdout.write(`FAIL ${name}\n     ${error?.message?.split('\n').join('\n     ')}\n`)
  }
}
process.stdout.write(`\n${checks.length - failed}/${checks.length} client probe checks passed\n`)
process.exitCode = failed === 0 ? 0 : 1
