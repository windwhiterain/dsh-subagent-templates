/**
 * The template delegation engine: one template call becomes one ordinary root
 * Session.
 *
 * A template child is created the way a person's own Session is created — a
 * workspace, a top-level Agent, an attached Session, one opening prompt. It
 * therefore keeps the full model picker and the full Session surface, which is
 * the point: a delegated task and a Session the user opens by hand are the same
 * kind of thing. Because the child's header carries no `parentSession`, the
 * Client never classifies it as a subagent and never hides its model picker.
 *
 * The parent/child relationship lives in the plugin's own storage domain
 * (`./store.ts`) rather than in the header, and the child's closing output is
 * delivered back to the parent as one settlement notice per turn the child
 * finishes naturally. A delegation is therefore not a one-shot result: a child
 * the parent keeps talking to keeps reporting, and the turn a foreground call
 * was waiting for is that call's own result rather than a second notice.
 *
 * A turn an external cause interrupted is not a settlement. The child keeps its
 * session and everything it had done, so the watcher waits through the
 * interruption for the child's next natural end instead of reporting a stop as
 * a result: a user who stops a delegated subagent is redirecting it, and an
 * interrupt must never fail or answer the session that delegated it. Only an
 * explicit end of the delegation stops a wait — deleting the child, or
 * cancelling the call that was waiting for it — and a child nothing wakes again
 * leaves the wait pending on purpose.
 *
 * The delegating call names the child. That name titles the child's Session and
 * is the only handle any later reference to it carries, so no notice, tool
 * result, relayed message, or error message about a child ever shows a Session id.
 *
 * This mirrors the shipped webhook Session creation
 * (`packages/webhook/webhook/src/session.ts`) and the core Agent/Session
 * services; it imports no Harness package.
 *
 * @module dsh-subagent-templates/lib/session-delegate
 */

import { randomUUID } from 'node:crypto'
import { assignTemplatePool } from './route.js'
import {
  boundContextSummary,
  createNamedAgentMessage,
  createUserMessage,
  finalAssistantOutput,
  lastTurnEndKind,
  toStopReason,
} from './harness.js'

/**
 * Brand a child Session id the way the shipped `SessionId` type does. The
 * plugin cannot import the brand, and a string is the runtime representation.
 * @param prefix - the id prefix.
 * @returns a fresh unique Session id.
 */
function childSessionId(prefix) {
  return `${prefix}-${randomUUID()}`
}

/**
 * How one child turn ended.
 * @typedef {object} ChildOutcome
 * @property {string} stopReason The settlement vocabulary the notice uses.
 * @property {boolean} externalStop The turn was stopped by an external cause.
 * @property {boolean} cancelled The turn was interrupted, so it is waited
 *   through rather than reported.
 * @property {Array<object>} output The child's closing content blocks.
 */

/**
 * Read how one child turn ended, in the settlement vocabulary the notice uses.
 * @param events - the child-owned session events, as the log reports them.
 * @returns {ChildOutcome} the outcome this delegation is settled by.
 */
function childOutcome(events) {
  const kind = lastTurnEndKind(events)
  const stopReason = toStopReason(kind)
  // An external stop leaves no natural terminal turn: the run was cancelled,
  // refused, or torn down before it could finish on its own terms.
  const externalStop = kind === 'aborted' || kind === 'blocked' || kind === undefined
  // A cancelled turn is the one interruption that is not an outcome at all: the
  // child is still live and idle, so its next turn is what settles this
  // delegation. Nothing may report the cancellation itself as a result.
  const cancelled = kind === 'aborted'
  return { stopReason, externalStop, cancelled, output: finalAssistantOutput(events) }
}

/**
 * Count the turns one child's own log says it has finished.
 *
 * A turn is the unit a settlement is reported per, and this count is what tells
 * one watch which ends it has already answered for — so the same turn is never
 * reported twice, and a turn the child runs after a message is not mistaken for
 * the one before it. The log, not a flag, is the state: it is the same state
 * {@link childOutcome} reads, so the two can never disagree.
 * @param events - the child-owned session events.
 * @returns how many turns have ended.
 */
function turnsEnded(events) {
  let ended = 0
  for (const event of events) if (event.type === 'turn/end') ended += 1
  return ended
}

/**
 * The context a child's Agent must be created through.
 *
 * `ctx.get()` returns a traced service (`Context.get` → `getTraceable`), so the
 * registry a call reaches is bound to the context that asked for it:
 * `AgentRegistry.create()` takes `ownerCtx = this.ctx`, and `AgentLoop.prepare()`
 * registers the new Agent's whole teardown as `ownerCtx.effect(...)`, cancelling
 * its machine with `disposed` when that fiber unloads
 * (packages/core/agent-loop/src/index.ts, `agentLoop.lifecycle`). A child created
 * through this plugin's own context therefore dies with this plugin's loader
 * entry: on an HMR edit of a watched file, or on any profile recomposition whose
 * composed row for this entry changed, which is what every Plugin Manager action
 * causes. The root context's fiber belongs to the application and unloads only
 * when the process exits, so a child created through it survives every plugin
 * reload — which is what makes the child's documented lifetime true.
 *
 * @param ctx - the plugin context.
 * @returns the application root context, whose fiber no plugin reload disposes.
 */
function ownershipContext(ctx) {
  return ctx.root
}

/**
 * The one-line account of a settled child, for the settlement notice.
 * @param template - the template the child ran under.
 * @param name - the name the delegating call gave the child.
 * @param stopReason - how the child ended.
 * @returns the model-facing opening line.
 */
function settlementSummary(template, name, stopReason) {
  const subject = `subagent "${name}"`
  switch (stopReason) {
    case 'completed':
      return `${subject} finished.`
    case 'max-tokens':
      return `${subject} ran out of room before it finished.`
    case 'refusal':
      return `${subject} declined the task.`
    case 'error':
      return `${subject} failed before it finished.`
    case 'aborted':
      return `${subject} was stopped before it finished.`
    /* v8 ignore next -- the seam's stop reason is a closed union here; an
     * unnameable reason would still read as a failure. */
    default:
      return `${subject} ended abnormally (${String(stopReason)}).`
  }
}

/**
 * Build the settlement notice delivered to the parent for a naturally finished
 * child: the account plus the child's own closing text, so the parent never has
 * to read the child Session to get the answer.
 * @param template - the template the child ran under.
 * @param name - the name the delegating call gave the child.
 * @param sessionId - the child's Session id, as the notice's factual sender.
 * @param outcome - the child's stop reason and output blocks.
 * @returns the durable user-message representation delivered to the parent.
 */
function settlementMessage(template, name, sessionId, outcome) {
  const summary = settlementSummary(template, name, outcome.stopReason)
  const text = outcome.output
    .filter(block => block.type === 'text')
    .map(block => block.text)
    .join('')
  return createUserMessage({
    content: [
      { type: 'text', text: summary },
      ...text.length === 0
        ? [{ type: 'text', text: 'It left no closing message.' }]
        : [{ type: 'text', text: 'Its closing message:' }, { type: 'text', text }],
    ],
    source: {
      kind: 'subagent-settled',
      form: 'notice',
      summary: boundContextSummary(summary),
      senderSessionId: sessionId,
    },
  })
}

/**
 * Build the notice for a child that never reached a natural end. This is
 * delivered only when the child failed on its own terms, not when an external
 * cause stopped it.
 * @param template - the template the child ran under.
 * @param name - the name the delegating call gave the child.
 * @param sessionId - the child's Session id, as the notice's factual sender.
 * @param error - the failure the child could not recover from.
 * @returns the durable user-message representation delivered to the parent.
 */
function failureMessage(template, name, sessionId, error) {
  const summary = `subagent "${name}" failed before it produced a result.`
  return createUserMessage({
    content: [{ type: 'text', text: `${summary}\nDiagnostic: ${String(error)}` }],
    source: {
      kind: 'subagent-settled',
      form: 'notice',
      summary: boundContextSummary(summary),
      senderSessionId: sessionId,
    },
  })
}

/**
 * Keep the template's route as the child's selection only until its first
 * durable request header exists, so a user change of the child's model — made
 * in the picker, from the Session, or by any other route — wins from then on.
 * Mirrors `installInitialModelSelection` in the shipped webhook plugin.
 * @param agentCtx - the child Agent's scoped context.
 * @param template - the template whose route is the initial default.
 */
function installInitialModelSelection(agentCtx, template) {
  agentCtx.on('agent/request', async ({ agent }, next) => {
    const resolved = await next()
    if (agent.session.requestHeader() !== undefined
      || (resolved.provider !== template.provider || resolved.model !== template.model)) return resolved
    const { reasoningEffort: _inherited, ...withoutEffort } = resolved
    return {
      ...withoutEffort,
      ...template.reasoningEffort === undefined ? {} : { reasoningEffort: template.reasoningEffort },
    }
  })
}

/**
 * Teach one child Session that it was delegated, and give it the one tool that
 * only makes sense for a delegated task: asking its parent a question.
 *
 * A template child is an ordinary root Session, so it inherits the deployment's
 * `send_message`, which reaches only a resident continuable child — the
 * Harness refuses that route for a session it does not classify as a subagent.
 * This registers a child-scoped `ask_parent` instead, and states the parent
 * relationship in a runtime context so the model knows the question is even
 * available. Both are registered on the child's own scope, so the parent and
 * every unrelated Session never see them.
 *
 * @param ctx - the plugin context, for the agent registry the parent lookup uses.
 * @param agentCtx - the child Agent's scoped creation context.
 * @param template - the template the child runs under.
 * @param parentSessionId - the delegating parent Session id.
 * @param name - the name the delegating call gave this child; the question the
 *   child sends up opens with it, so the parent reads back a name it chose.
 */
function installParentChannel(ctx, agentCtx, template, parentSessionId, name) {
  agentCtx.inject(['tools'], (toolCtx) => {
    toolCtx.tools.register({
      name: 'ask_parent',
      description:
        'Ask the session that delegated you a question, or report a finding that changes what it should do next. '
        + 'Use it when the task needs something only the delegating session knows — a decision it made, a file '
        + 'path it meant, an answer it already has. The message reaches it at its next step, so you get no reply '
        + 'inside this turn: ask something answerable in one message. Your final answer is delivered to it '
        + 'automatically when your turn ends, so send only what it cannot get from that.',
      parameters: {
        type: 'object',
        additionalProperties: false,
        required: ['question'],
        properties: {
          question: {
            type: 'string',
            description: 'The question or finding to send to the delegating session.',
          },
        },
      },
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          required: ['delivered'],
          properties: { delivered: { type: 'boolean' } },
        },
        render: () => [{ type: 'text', text: `question sent to the delegating session ${parentSessionId}` }],
      },
      execute(args, exec) {
        const sender = exec.agent
        if (sender === undefined) throw new Error('ask_parent requires a calling agent (exec.agent was undefined)')
        // The registry is read through the application root, not through this
        // plugin's own context: this tool lives on the CHILD's scope and outlives
        // a template edit that restarts this plugin's row, so it must reach the
        // parent from a context no reload disposes.
        const parent = ctx.root.get('agents')?.get(parentSessionId)
        if (parent === undefined) {
          throw new Error(
            `the delegating session ${parentSessionId} is not live; the question was not delivered`,
          )
        }
        // The parent reads this header, and the name is the only handle it holds
        // for this child; the message's own source still names the sending Session.
        parent.steer(createNamedAgentMessage(sender.id, name, [{ type: 'text', text: args.question }]))
        return Promise.resolve({ delivered: true })
      },
    })
  })
  agentCtx.inject(['systemPrompt'], (promptCtx) => {
    promptCtx.systemPrompt.context({
      name: 'subagent-templates:parent',
      order: promptCtx.systemPrompt.getContextOrder('SUBAGENT_DELEGATION'),
      text:
        'You are working on a task another session delegated to you, and you are running as your own session. '
        + `You are the subagent "${name}". That session is ${parentSessionId}. You do not see its conversation, and `
        + 'it does not see yours. If you are blocked on something only it can answer, send it a question with '
        + '`ask_parent`. Your own `send_message` tool cannot reach it: the Harness delivers that route only from a '
        + 'session it holds as a resident continuable child, which you are not, so naming this session there always '
        + 'fails. `ask_parent` reaches it at its next step, and there is no reply within your turn, so ask something '
        + 'it can answer without another round trip. Your own final message is delivered to it automatically when '
        + 'your turn ends, so never repeat that final answer in `ask_parent`.',
    })
  })
}

/**
 * Establish and drive one template child as an ordinary root Session.
 *
 * The child is created with a PLUGIN-OWNED abort controller, never the calling
 * tool's signal. An Agent's whole life is fused to the signal its creation
 * passed: `agent-loop` keeps a listener on that signal from `createAgent` until
 * the Agent is disposed, so a child created with the tool call's own
 * `exec.signal` is torn down the moment that call returns — which is exactly
 * what a background delegation does. This controller is the child's lifetime
 * owner; `stopChild` aborts it when the child really should stop. The controller
 * is one of two owners a child needs: the other is the context its Agent is
 * created through, which {@link ownershipContext} pins to the application root.
 *
 * @param ctx - the plugin context.
 * @param template - the selected template.
 * @param parent - the delegating parent Agent.
 * @param name - the name the delegating call gave this child, which titles its Session.
 * @param prompt - the child's opening task text.
 * @param cwd - the working directory the child runs in.
 * @param signal - the CALLING TOOL's signal, used only to abandon a creation
 *   that has not finished; it never reaches the child's lifetime.
 * @returns the child's Session id, its live Agent, its lifetime controller, and the owning handle.
 * @throws when the child cannot be created; nothing partial is left behind.
 */
export async function startTemplateSession(ctx, template, parent, name, prompt, cwd, signal) {
  const workspaces = ctx.get('workspaceRegistry')
  const agents = ownershipContext(ctx).get('agents')
  const sessionTitle = ctx.get('sessionTitle')
  if (workspaces === undefined || agents === undefined || sessionTitle === undefined) {
    // Checked before anything is created: a child that cannot be named would
    // exist without the handle every later reference uses, so this fails the
    // delegation instead of leaving one behind.
    throw new Error('subagent-templates: creating a template session needs the agents, workspaceRegistry, and sessionTitle services')
  }
  const sessionId = childSessionId('subagent-template')
  // A child that inherits the parent's working directory is a normal Session in
  // that same workspace; the relationship itself lives in the storage domain.
  const workspace = await workspaces.create(cwd)
  const parentCwd = parent.session.header.cwd
  // The child's lifetime owner. Nothing else may abort this child.
  const lifetime = new AbortController()
  // A creation that is still in flight when the tool call is cancelled must not
  // leave an orphan behind, so the caller's signal abandons THIS attempt.
  const abandonCreation = () => { lifetime.abort(new Error('the delegation was cancelled before the child existed')) }
  signal?.addEventListener('abort', abandonCreation, { once: true })

  const handle = await agents.create({
    sessionId,
    // No parentAgent: this is a root Session, not a subagent child. The Client
    // reads the header's parentSession, so leaving it unset is what keeps the
    // model picker available here.
    meta: {
      ...parentCwd === undefined ? {} : { cwd: parentCwd },
      ...template.preset === undefined ? {} : { agentPreset: template.preset },
    },
    agentOptions: {
      provider: template.provider,
      model: template.model,
      ...template.reasoningEffort === undefined ? {} : { reasoningEffort: template.reasoningEffort },
      ...template.maxTokens === undefined ? {} : { maxTokens: template.maxTokens },
    },
    signal: lifetime.signal,
    setup: async (agentCtx) => {
      const presets = agentCtx.get('agentPresets')
      if (presets !== undefined && template.preset !== undefined) {
        await presets.mount(agentCtx, template.preset)
      }
      // The join above comes first and the child's own registrations second, so
      // the child's persona and tool restriction win a name the preset also
      // claimed. Both registrations live on the child's own scope, so neither is
      // visible to the parent or to a sibling.
      const systemPrompt = agentCtx.get('systemPrompt')
      if (template.persona !== undefined && systemPrompt !== undefined) {
        systemPrompt.section({
          name: 'deployment:persona-prefix',
          order: systemPrompt.getSectionOrder('DEPLOYMENT_PERSONA_PREFIX'),
          text: template.persona,
        })
      }
      if (template.toolFilter !== undefined) agentCtx.get('tools')?.restrict(template.toolFilter)
      installInitialModelSelection(agentCtx, template)
      installParentChannel(ctx, agentCtx, template, parent.id, name)
    },
  })
  // Creation is complete: the tool call's signal no longer owns this child.
  signal?.removeEventListener('abort', abandonCreation)
  if (signal?.aborted === true) {
    await handle.dispose().catch(() => {})
    throw new Error('the delegation was cancelled before the child existed')
  }

  try {
    await workspace.attachSession(sessionId)
  } catch (error) {
    // A Session that cannot join its workspace is rolled back whole, so the
    // failure never leaves a half-attached child behind.
    await handle.dispose().catch(() => {})
    throw error
  }

  const child = handle.agent
  // The name the parent chose is the child's title, so the session list, the
  // Client panel, and the parent's own later references all read the same word.
  sessionTitle.rename(child.session, name)
  // Before the opening prompt can start a turn: which pool governs this child
  // when its route is one several pools share.
  assignTemplatePool(ctx, child.session, template)
  child.followup(createUserMessage({ content: [{ type: 'text', text: prompt }], source: { kind: 'user' } }))
  return { sessionId, child, handle, workspace, lifetime }
}

/**
 * Wait until the child starts another turn.
 *
 * An interrupted turn leaves the child live and idle, holding everything it had
 * already done, so the next turn is what settles the delegation — the user
 * redirecting the child with a message, or the delegating session sending one
 * with `message_subagent`. A child nothing wakes again leaves this promise
 * pending, which is the contract rather than a leak: {@link WatchSettlement.stop}
 * (the delegation ended) or the delegating call's own cancellation is what ends
 * the wait, by aborting `wake`.
 * @param child - the child Agent.
 * @param wake - signal that ends the wait because no result is wanted any more.
 * @returns resolution once the child is running again, or once `wake` aborts.
 */
function waitUntilRunning(child, wake) {
  if (wake.aborted || child.status === 'running') return Promise.resolve()
  return new Promise((resolve) => {
    let done = false
    const finish = () => {
      if (done) return
      done = true
      dispose()
      wake.removeEventListener('abort', finish)
      resolve()
    }
    const dispose = child.ctx.on('agent/status', ({ agent, status }) => {
      if (agent === child && status === 'running') finish()
    })
    wake.addEventListener('abort', finish, { once: true })
    // A turn that started between the status read and these registrations must
    // not be missed: the child reports `running` again here.
    if (wake.aborted || child.status === 'running') finish()
  })
}

/**
 * One child's settlement watch.
 * @typedef {object} WatchSettlement
 * @property {(wake?: AbortSignal) => Promise<ChildOutcome | undefined>} settled
 *   Waits for the next turn end this watch has not answered for; `undefined`
 *   once the wait was stopped.
 * @property {() => void} report
 *   Reports every later turn end to the parent, for as long as the child is
 *   live: the one turn a delegating call waited for is that call's own result,
 *   and every turn after it is a notice.
 * @property {() => void} stop Ends the wait, because the delegation is over.
 */

/**
 * Watch one child Session and deliver each of its turn ends to the parent.
 *
 * A naturally finished turn produces a settlement notice carrying its output.
 * An interrupted turn is waited through instead of being reported: see
 * {@link waitUntilRunning}. Delivery happens at every natural end, so a child
 * the user stopped and then redirected reports the redirected work, and so does
 * a child that already reported once and is then sent another message: the turn
 * a parent starts with `message_subagent` — or the user types into the child's
 * own session — is a result the parent asked for, and it is reported the same
 * way the first one was. The one exception is a turn the delegating call itself
 * waited for, which that call returns as its result and this watch has already
 * accounted for.
 *
 * The Agent registry is read through the application root, never through this
 * plugin's own context: a template edit in the profile patch restarts this
 * plugin's row while children are still working, and a notice must survive that.
 *
 * @param ctx - the plugin context.
 * @param template - the template the child ran under.
 * @param name - the name the delegating call gave the child.
 * @param sessionId - the child's Session id, as the notice's factual sender.
 * @param child - the child Agent.
 * @param parentSessionId - the delegating parent Session.
 * @returns {WatchSettlement} the child's settlement watch.
 */
export function watchChildSettlement(ctx, template, name, sessionId, child, parentSessionId) {
  const stopped = new AbortController()
  /**
   * How many of this child's finished turns the watch has already answered for.
   * A delegation is a conversation, not a single result: the parent may send this
   * child more work, and each turn that finishes is one result waiting for it.
   */
  let reported = 0
  let reporting = false

  /** Deliver one natural end to the parent, waking it when it is idle. */
  const deliver = async (outcome) => {
    const agents = ctx.root.get('agents')
    const parent = agents?.get(parentSessionId)
    if (parent === undefined) return
    const message = outcome.stopReason === 'error'
      ? failureMessage(template, name, sessionId, outcome)
      : settlementMessage(template, name, sessionId, outcome)
    if (parent.status === 'idle') parent.followup(message)
    else parent.inject(message)
  }

  /**
   * Wait for the child's next natural end, through every interruption.
   * @param wake - the delegating call's own signal, when there is one; its
   *   cancellation ends the wait because nobody will read the result.
   * @returns {Promise<ChildOutcome | undefined>} the outcome, or undefined once
   *   the wait was stopped.
   */
  const settled = async (wake) => {
    const onWake = () => stopped.abort()
    if (wake !== undefined) {
      if (wake.aborted) stopped.abort()
      else wake.addEventListener('abort', onWake, { once: true })
    }
    try {
      for (;;) {
        await child.whenIdle()
        if (stopped.signal.aborted) return undefined
        const own = child.session.snapshotEvents()
        const ended = turnsEnded(own)
        // The end this watch already answered for. The child is idle with nothing
        // new in its log, so what is being waited for is the next turn beginning;
        // a child nothing wakes again leaves the wait pending on purpose.
        if (ended <= reported) {
          await waitUntilRunning(child, stopped.signal)
          if (stopped.signal.aborted) return undefined
          continue
        }
        reported = ended
        const outcome = childOutcome(own)
        // A cancelled turn is not an outcome: the child is live and idle, so its
        // next turn is what settles this delegation. Nothing may report the
        // cancellation itself as a result.
        if (outcome.cancelled) continue
        return outcome
      }
    } finally {
      wake?.removeEventListener('abort', onWake)
    }
  }

  /**
   * Report every later turn end to the parent, until the wait is stopped.
   *
   * Arming this once keeps the child answering for as long as it is live, which
   * is what a message afterwards asks for: `message_subagent` starts a turn and
   * this is what carries its output back. It is a no-op once stopped, so a
   * delegated call that was cancelled and ended its child never arms one.
   */
  const report = () => {
    if (stopped.signal.aborted || reporting) return
    reporting = true
    void (async () => {
      for (;;) {
        const outcome = await settled()
        if (outcome === undefined) return
        // A turn the host refused admission to, and a turn that never began, are
        // stops rather than results: the delegation stays open, and the child's
        // next natural end is what reports.
        if (outcome.externalStop) continue
        try {
          await deliver(outcome)
        } catch (error) {
          // One notice that could not be handed over must not silence the rest.
          ctx.logger?.warn?.(
            `subagent-templates: the settlement notice for "${name}" was not delivered: ${String(error)}`,
          )
        }
      }
    })().catch((error) => {
      ctx.logger?.warn?.(`subagent-templates: settlement watch for "${name}" failed: ${String(error)}`)
    })
  }

  return { settled, report, stop: () => stopped.abort() }
}

export { settlementMessage, failureMessage, childOutcome }
