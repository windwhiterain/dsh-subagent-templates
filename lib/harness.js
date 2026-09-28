/**
 * Plain-JavaScript replicas of the Harness behavior this plugin composes on.
 *
 * An out-of-tree bundle imports no Harness package: the profile resolves this
 * package from its own directory, and the Harness's own modules are not on that
 * resolution path. What remains here is the small set of message- and
 * turn-reading helpers a template Session needs to deliver a child's outcome,
 * each mirroring one named shipped source so that drift against a Harness
 * upgrade stays localized and reviewable.
 *
 * Mirrored from the deepseek-harness checkout this plugin was written against
 * (`@deepseek-ai/dsh-subagent` 0.1.7-rc.2 and `@deepseek-ai/dsh-llm`):
 *   - packages/subagent/subagent/src/assistant-output.ts  (final output selection)
 *   - packages/subagent/subagent-in-process-driver/src/index.ts  (turn→stop reason)
 *   - packages/llm/llm/src/message.ts                       (message creation, bounded summary)
 *   - packages/llm/llm/src/assistant-stream.ts              (streamed text join)
 *
 * @module dsh-subagent-templates/lib/harness
 */

import { randomUUID } from 'node:crypto'

/**
 * Join every streamed text fragment of one assistant settlement. Mirrors
 * `joinAssistantStreamText` in packages/llm/llm/src/assistant-stream.ts.
 * @param stream - compact records from one assistant settlement.
 * @returns the joined text, empty when the stream carries no text delta.
 */
function joinAssistantStreamText(stream) {
  const parts = []
  for (const record of stream) {
    if (record.type === 'text-chunks') parts.push(record.texts.join(''))
    else if (record.type === 'chunk' && record.chunk.type === 'text-delta') parts.push(record.chunk.text)
  }
  return parts.join('')
}

/**
 * Select the child's final assistant output from its own event suffix: the last
 * non-empty assistant message, else the accumulated streamed text. Mirrors
 * `finalAssistantOutput` in `assistant-output.ts`.
 * @param events - the child-owned session events.
 * @returns the selected content blocks, or an empty array when the child produced none.
 */
export function finalAssistantOutput(events) {
  let message
  const partial = []
  for (const event of events) {
    if (event.type === 'assistant/message') {
      const content = event.data.message.content
      if (content.length > 0) message = content
    }
    if (event.type === 'assistant/message' || event.type === 'assistant/attempt') {
      const text = joinAssistantStreamText(event.data.stream)
      if (text.length > 0) partial.push(text)
    }
  }
  if (message !== undefined) return message
  const text = partial.join('')
  return text.length > 0 ? [{ type: 'text', text }] : []
}

/**
 * Read how the child's last ordinary turn ended. Mirrors the `foldConsumedWork`
 * end reason the in-process driver maps, for the single-run case this plugin reads.
 * @param events - the child-owned session events.
 * @returns the terminal turn reason kind, or undefined when no turn ended.
 */
export function lastTurnEndKind(events) {
  let reason
  for (const event of events) if (event.type === 'turn/end') reason = event.data.reason
  return reason?.kind
}

/** Map one turn-end kind to the settlement vocabulary the notice uses. Mirrors
 * `toStopReason` in the in-process driver. */
const STOP_REASON = {
  completed: 'completed',
  'max-tokens': 'max-tokens',
  aborted: 'aborted',
  blocked: 'refusal',
}

/**
 * Map one turn-end kind to a stop reason.
 * @param kind - the final turn's reason kind, or undefined without one.
 * @returns the settlement stop reason.
 */
export function toStopReason(kind) {
  return STOP_REASON[kind] ?? 'error'
}

/**
 * Create one identified user-role message. Mirrors `createUserMessage` in
 * packages/llm/llm/src/message.ts.
 * @param input - content plus the producer source for the new message.
 * @returns a detached user message with a fresh identity.
 */
export function createUserMessage(input) {
  return structuredClone({ ...input, id: randomUUID(), role: 'user' })
}

/**
 * Build the model-visible and durable representation of one adjacent-Agent
 * message. Mirrors `createAgentMessage` in
 * `packages/subagent/subagent/src/continuation-messages.ts`, which is how the
 * Harness attributes a message a child sent upward.
 * @param sender - the exact live agent that authored the message.
 * @param content - model-visible message blocks supplied by the sender.
 * @returns the durable user-message representation delivered to the recipient.
 */
export function createAgentMessage(sender, content) {
  return createUserMessage({
    content: [
      { type: 'text', text: `Agent ${sender.id} sent a message: ` },
      ...content,
    ],
    source: { kind: 'agent-message', form: 'relay', senderSessionId: sender.id },
  })
}

/**
 * Build the message a delegated child sends up to its parent, opening with the
 * name the parent gave that child. The durable attribution is
 * {@link createAgentMessage}'s — the `agent-message` source still carries the
 * sending Session id — while the model-visible header carries the name, which is
 * the only handle the parent has for that child.
 * @param senderSessionId - the sending child's Session id, for durable attribution.
 * @param name - the name the delegating call gave the child.
 * @param content - model-visible message blocks supplied by the sender.
 * @returns the durable user-message representation delivered to the parent.
 */
export function createNamedAgentMessage(senderSessionId, name, content) {
  return createUserMessage({
    content: [
      { type: 'text', text: `subagent "${name}" sent a message: ` },
      ...content,
    ],
    source: { kind: 'agent-message', form: 'relay', senderSessionId },
  })
}

/**
 * Bound one `notice` summary. Mirrors `boundContextSummary` in
 * packages/llm/llm/src/message.ts.
 * @param summary - the producer's one-line account, of any length.
 * @returns the account, ellipsized when it exceeds the bound.
 */
export function boundContextSummary(summary) {
  return summary.length <= 120 ? summary : `${summary.slice(0, 119)}…`
}

/**
 * Join the text blocks of one content array.
 * @param blocks - content blocks of any type.
 * @returns the concatenated text of the text blocks.
 */
export function contentText(blocks) {
  return blocks.filter(block => block.type === 'text').map(block => block.text).join('')
}
