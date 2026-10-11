/**
 * How this plugin hands a message to another Agent, and what it does when the
 * receiving Session loses one.
 *
 * Two facts about the recipient decide how a message has to travel to it.
 *
 * **The Client draws a message whose source is not `user` as injected context,
 * and a context row is not one of its visible rows.** A message spliced into a
 * turn that is already running would therefore be read by the model and seen by
 * nobody. A mid-turn delivery claims `user` instead, which is what makes it a
 * visible in-turn row. Only the splice does that: a delivery that opens a turn
 * is already drawn as a visible turn trigger under its own kind, so it keeps the
 * `agent-message` or `subagent-settled` source — and with it the icon and title
 * that name who sent it. The sending Session id stays on the source either way,
 * so the durable record still says who sent the message, and no `rpcId` is
 * written: the browser's prompt admission is the only writer of that field, and
 * a message without it is not read as a human instruction.
 *
 * **A turn that fails takes its claimed input with it.** Before every proposed
 * step the Harness claims the recipient's whole inbox batch as a durable
 * deletion, and that batch is written back into the log as `user/message` only
 * once the request for that step is being prepared. Anything failing in between
 * — a pre-step listener, the request header, a `prepareCall` that cannot resolve
 * a route, a full disk — ends the turn with the batch claimed and never logged.
 * The message is then absent from the log and absent from the inbox, and the
 * next turn that recipient runs has no idea it was ever sent. This channel
 * remembers what it handed over, watches the recipient's own log for the message
 * the model actually received, and puts back what a failed turn took.
 *
 * Cancellation is deliberately not repaired. A stop is somebody deciding this
 * work should not continue, so putting a message back into it would override
 * that decision rather than repair a failure.
 *
 * @module dsh-subagent-templates/lib/delivery
 */

/** How many times one message is put back before this channel gives up on it. */
const MAX_REDELIVERIES = 3

/**
 * One message this plugin handed over that the recipient has not run yet.
 * @typedef {object} OutstandingMessage
 * @property {object} message The message as the recipient's inbox accepted it.
 * @property {string} label What a diagnostic about this message names it by.
 * @property {number} redeliveries How many times this channel has put it back.
 */

/**
 * One recipient's unacknowledged messages.
 * @typedef {object} RecipientState
 * @property {object} target The exact live Agent that received them.
 * @property {Map<string, OutstandingMessage>} outstanding Messages the model has
 *   not been shown, keyed by durable `MessageId`.
 */

/**
 * @typedef {object} DeliveryChannel
 * @property {(target: object, message: object, label: string) => void} deliver
 *   Hand one message to a live Agent over the route its own state requires, and
 *   remember it until the model is shown it.
 * @property {() => void} stop Stop watching every recipient.
 */

/**
 * Claim the source kind the Client draws as a visible in-turn message.
 *
 * Only the model-visible content and the durable `MessageId` cross over; the
 * source keeps every field it had, so the log still records the sender.
 * @param message - the message about to be spliced into a running turn.
 * @returns the same message under a source the Client draws as a visible row.
 */
function asVisibleInTurnMessage(message) {
  return { ...message, source: { ...message.source, kind: 'user' } }
}

/**
 * Hand one message to a live Agent over the route its current state requires.
 *
 * An idle recipient is queued the message as a distinct turn, which the Client
 * draws as a turn trigger under the message's own source. A recipient that is
 * already working takes it at its next step, where the source decides whether
 * anyone sees it.
 * @param target - the exact live Agent receiving the message.
 * @param message - the model-visible message to deliver.
 */
function send(target, message) {
  if (target.status === 'idle') target.followup(message)
  else target.steer(asVisibleInTurnMessage(message))
}

/**
 * Build the channel this plugin's tools deliver through.
 * @param {object} ctx - the plugin context, for its logger.
 * @returns {DeliveryChannel} the delivery channel.
 */
export function createDeliveryChannel(ctx) {
  /** One entry per recipient this channel currently owes something to. */
  const recipients = new Map()

  /**
   * The one watcher over every recipient's log, held only while something is
   * outstanding. It lives on this plugin's context rather than on a recipient's
   * own scope: a Session publishes its events through the context that created
   * it, which for a Session this plugin did not create is not that Agent's scope.
   * @type {(() => void)|undefined}
   */
  let dispose

  /**
   * Forget a recipient that owes nothing, and drop the watcher once no recipient
   * does, so an ordinary Session this plugin spoke to once keeps no listener.
   */
  const release = () => {
    if (recipients.size > 0) return
    dispose?.()
    dispose = undefined
  }

  /**
   * Put back what a failed turn claimed and never logged.
   *
   * `whenIdle()` is the Harness's own answer to "this recipient has finished
   * reacting to that turn", and it resolves after the driver has run its own
   * last check for queued work. A message put back here is therefore the first
   * thing the next turn claims, rather than one the driver already decided not
   * to start a turn for.
   * @param {RecipientState} state - the recipient whose turn failed.
   * @returns {Promise<void>} completion once the sweep has run.
   */
  const sweep = async (state) => {
    const { target, outstanding } = state
    if (outstanding.size === 0) return
    // A message the failed turn never claimed is still queued and needs nothing.
    const queued = new Set(
      [...target.inbox.nextTurn, ...target.inbox.nextStep].map(message => message.id),
    )
    for (const [id, entry] of [...outstanding]) {
      if (queued.has(id)) continue
      outstanding.delete(id)
      if (entry.redeliveries >= MAX_REDELIVERIES) {
        ctx.logger?.warn?.(
          `subagent-templates: ${entry.label} was still unread after ${MAX_REDELIVERIES} failed turns; `
          + 'it was not put back again',
        )
        continue
      }
      try {
        send(target, entry.message)
        outstanding.set(id, { ...entry, redeliveries: entry.redeliveries + 1 })
        ctx.logger?.warn?.(
          `subagent-templates: ${entry.label} was dropped by a failed turn and has been put back `
          + `(attempt ${entry.redeliveries + 1})`,
        )
      } catch (error) {
        ctx.logger?.warn?.(`subagent-templates: ${entry.label} could not be put back: ${String(error)}`)
      }
    }
    if (outstanding.size === 0) recipients.delete(target)
    release()
  }

  /**
   * Follow every recipient's log: a `user/message` is a message the model was
   * shown, and a failed turn end is one that may have taken messages with it.
   * @returns {() => void} the disposer for this watcher.
   */
  const observe = () => ctx.on('session/event', (session, event) => {
    if (event.type === 'user/message') {
      for (const state of [...recipients.values()]) {
        if (state.target.session !== session) continue
        state.outstanding.delete(event.data.id)
        if (state.outstanding.size === 0) recipients.delete(state.target)
      }
      release()
      return
    }
    if (event.type !== 'turn/end') return
    const kind = event.data.reason?.kind
    // `blocked` is a refusal that discarded the batch the turn had claimed, so
    // it costs the messages too. `aborted` is a stop, which is not repaired.
    if (kind !== 'error' && kind !== 'blocked') return
    for (const state of [...recipients.values()]) {
      if (state.target.session !== session || state.outstanding.size === 0) continue
      void state.target.whenIdle()
        .then(() => sweep(state), () => sweep(state))
    }
  })

  return {
    deliver(target, message, label) {
      let state = recipients.get(target)
      if (state === undefined) {
        state = { target, outstanding: new Map() }
        recipients.set(target, state)
      }
      state.outstanding.set(message.id, { message, label, redeliveries: 0 })
      // The watcher is installed before the message can be claimed, so a turn
      // that fails on its very next step is still seen.
      dispose ??= observe()
      try {
        send(target, message)
      } catch (error) {
        state.outstanding.delete(message.id)
        if (state.outstanding.size === 0) recipients.delete(target)
        release()
        throw error
      }
    },
    stop() {
      dispose?.()
      dispose = undefined
      recipients.clear()
    },
  }
}