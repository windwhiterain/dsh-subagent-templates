/**
 * The model-facing delegation surface: one `subagent` tool whose `template`
 * argument selects a prepared child Session, plus `list_subagent_templates`
 * for discovery.
 *
 * A template exists so the delegating agent chooses by name and description
 * instead of naming a provider, a model, and a reasoning effort per call. The
 * name and description therefore carry the whole selection contract, and the
 * tool description states the current template list on every turn.
 *
 * Every call names its child, and that name is the child's only handle: it
 * titles the child's Session, is what `delete_subagent` takes, and labels the
 * child's row in the Client panel. No result or notice about a child carries a
 * Session id. Whether a child runs in the background is the caller's decision on
 * every call and has no default, so a delegation always states which it wants.
 *
 * A foreground call waits for the child Session's own turn to settle and
 * returns its closing text. A background call returns the child's name
 * immediately and its output reaches the delegating agent as a settlement
 * notice when the child finishes on its own terms; a child stopped by an
 * external cause settles silently.
 *
 * @module dsh-subagent-templates/lib/tool
 */

import { startTemplateSession, watchChildSettlement, childOutcome } from './session-delegate.js'
import { childDepthOf, withinMaxDepth } from './depth.js'
import { contentText, createAgentMessage } from './harness.js'

/**
 * How a child's work stands right now, from the live Agent registry.
 *
 * A template child is an ordinary root Session, so the Harness subagent registry
 * knows nothing about it and this plugin reads the Agent registry instead. A
 * child with no live Agent is one whose Session was closed; its log survives, and
 * it can still be opened and read.
 * @param agents - the Harness Agent registry, or undefined without it.
 * @param childSessionId - the child's Session id.
 * @returns `working` while its turn runs, `idle` while it is live and waiting,
 *   and `ended` once no live Agent holds it.
 */
function statusOf(agents, childSessionId) {
  const child = agents?.get(childSessionId)
  if (child === undefined) return 'ended'
  return child.status === 'running' ? 'working' : 'idle'
}

/**
 * Render one template as its model-facing selection line.
 * @param template - the normalized template.
 * @returns `id — name: description`.
 */
function templateLine(template) {
  return `- ${template.id} — ${template.name}: ${template.description}`
}

/**
 * Build the delegation tool's model-facing description.
 * @param templates - every template, in configured order.
 * @returns the description text.
 */
function delegationDescription(templates) {
  return 'Delegate a task to a subagent session built from one of the templates below. A template fixes the '
    + 'subagent\'s starting model and agent preset, so choose a template by name instead of naming a model. The '
    + 'subagent runs as its own session with full access to its workspace.\n\n'
    + 'Templates:\n'
    + templates.map(templateLine).join('\n')
    + '\n\nThe subagent does not see this conversation\'s turns, so its prompt must be self-contained. Give it a '
    + '`name` you can use to refer to it later: that name titles its session and is how `delete_subagent` finds it, '
    + 'so it must be unique among the subagents you have running. Say in `run_in_background` whether to wait for the '
    + 'subagent: a foreground call waits and returns its output, and a background call returns immediately and '
    + 'delivers its output to you when it finishes, so a background subagent must not be polled for.'
}

/**
 * Read a child Session's working directory, falling back to the process cwd.
 * @param parent - the delegating parent Agent.
 * @returns an absolute directory the child Session can adopt.
 */
function childCwd(parent) {
  return parent.session.header.cwd ?? process.cwd()
}

/**
 * The canonical `output.schema` both execution routes report through.
 * The enforced subset rejects the tool shorthands' `type: 'json'`; an empty
 * schema node is its unconstrained-JSON form. */
const OUTPUT_SCHEMA = {
  oneOf: [
    {
      type: 'object',
      additionalProperties: false,
      required: ['kind', 'name'],
      properties: {
        kind: { type: 'string', const: 'background' },
        name: { type: 'string' },
      },
    },
    {
      type: 'object',
      additionalProperties: false,
      required: ['kind', 'name', 'output'],
      properties: {
        kind: { type: 'string', const: 'foreground' },
        name: { type: 'string' },
        output: { type: 'array', items: {} },
      },
    },
  ],
}

/**
 * Build the delegation tool definition.
 * @param options - the resolved tool name, templates, parent mapping, and the child registry.
 * @param options.ctx - the plugin context carrying `agents` and the optional storage facility.
 * @param options.toolName - the model-facing tool name.
 * @param options.templates - every template, in configured order.
 * @param options.store - the parent/child mapping store, or undefined without storage.
 * @param options.claimName - reserves one name among a parent's children and returns its release.
 * @param options.onDelegated - called once the caller's first child exists, so it can
 *   install the child-management tools into that caller's own scope.
 * @param options.registerChild - registers a background child so an external stop can cancel it.
 * @param options.maxDepth - the row's delegation-depth cap, when it declares one.
 * @returns the tool definition.
 */
export function createDelegationTool({ ctx, toolName, templates, store, claimName, onDelegated, registerChild, maxDepth }) {
  const byId = new Map(templates.map(template => [template.id, template]))
  return {
    name: toolName,
    description: delegationDescription(templates),
    parameters: {
      type: 'object',
      additionalProperties: false,
      required: ['name', 'template', 'prompt', 'run_in_background'],
      properties: {
        name: {
          type: 'string',
          description: 'A short name for this subagent, unique among the ones you have running. It titles the '
            + 'subagent\'s session and is the only way to refer to it afterwards, including for `delete_subagent`.',
        },
        template: {
          type: 'string',
          enum: templates.map(template => template.id),
          description: 'The template to delegate with, by id.',
        },
        prompt: {
          type: 'string',
          description: 'The complete, self-contained task for the subagent. It does not share this conversation\'s context, so include everything it needs.',
        },
        run_in_background: {
          type: 'boolean',
          description: 'true to return immediately and take the subagent\'s output when it finishes; false to wait '
            + 'for it here and get its output as this call\'s result. There is no default: decide which one this '
            + 'call wants.',
        },
      },
    },
    output: {
      schema: OUTPUT_SCHEMA,
      render: (_args, value) => [{
        type: 'text',
        text: value.kind === 'background'
          ? `started background subagent "${value.name}"`
          : contentText(value.output),
      }],
    },
    // A child Session never mutates the parent Session.
    isConcurrencySafe: () => true,
    async execute(args, exec) {
      const parent = exec.agent
      if (parent === undefined) {
        // Non-agent callers provide no parent for delegation ownership.
        throw new Error(`${toolName} requires a calling agent (exec.agent was undefined)`)
      }
      const template = byId.get(args.template)
      if (template === undefined) {
        throw new Error(
          `unknown subagent template "${args.template}"; available templates: ${[...byId.keys()].join(', ')}`,
        )
      }
      exec.signal.throwIfAborted()

      // The depth cap is enforced before the name is claimed, so a refused
      // delegation reserves nothing and leaves the parent's names untouched.
      const childDepth = childDepthOf(store, parent.id)
      if (!withinMaxDepth(maxDepth, childDepth)) {
        throw new Error(
          `subagent depth ${childDepth} exceeds maxDepth ${maxDepth}; this session may not delegate further`,
        )
      }

      // The name is checked against the parent's own children before anything is
      // created, so a duplicate costs the call nothing. The claim also covers two
      // calls in one turn, which run concurrently; the record it guards is
      // written below, so the claim is held only until this call settles.
      const releaseName = claimName(parent.id, args.name)
      try {
        const cwd = childCwd(parent)
        const { sessionId, child, handle, lifetime } = await startTemplateSession(
          ctx,
          template,
          parent,
          args.name,
          args.prompt,
          cwd,
          exec.signal,
        )
        try {
          if (store !== undefined) {
            await store.put(sessionId, {
              parentSessionId: parent.id,
              name: args.name,
              templateId: template.id,
              createdAt: Date.now(),
              cwd,
            })
          }
        } catch (error) {
          // The Session exists but nothing would remember which parent it
          // belongs to, so the parent's tools could never reach it. A child the
          // parent cannot name is not a delegation: stop it and fail the call.
          await handle.dispose().catch(() => {})
          throw new Error(`subagent "${args.name}" could not be recorded against this session: ${String(error)}`)
        }

        const settle = watchChildSettlement(ctx, template, args.name, sessionId, child, parent.id)
        // The caller now has a child, so the tools that act on children become
        // meaningful for it. They are installed into its own scope rather than
        // published at the Host plane, so a session that never delegates never
        // carries them.
        onDelegated(parent)
        if (args.run_in_background === true) {
          // The child Session runs on its own loop, past this tool call. An
          // external stop cancels it and its outcome is an external stop, so the
          // settlement stays silent.
          registerChild(sessionId, parent.id, { child, handle, lifetime })
          void child.whenIdle()
            .then(settle, () => {})
            .catch((error) => {
              ctx.logger?.warn?.(`subagent-templates: settlement watch for "${args.name}" failed: ${String(error)}`)
            })
          return { kind: 'background', name: args.name }
        }

        // A foreground call waits for the child's turn. If the tool call itself
        // is cancelled, the child must not be left running: the caller asked
        // for a result it will never read.
        const onCallAbort = () => { lifetime.abort(new Error('the delegating tool call was cancelled')) }
        exec.signal.addEventListener('abort', onCallAbort, { once: true })
        try {
          await child.whenIdle()
        } finally {
          exec.signal.removeEventListener('abort', onCallAbort)
        }
        await settle()
        const outcome = childOutcome(child.session)
        if (outcome.externalStop) {
          const reason = outcome.stopReason === 'aborted'
            ? `subagent "${args.name}" was stopped before it finished`
            : `subagent "${args.name}" did not finish (${outcome.stopReason})`
          throw new Error(reason)
        }
        if (outcome.stopReason !== 'completed') {
          throw new Error(`subagent "${args.name}" ended abnormally (${outcome.stopReason})`)
        }
        return { kind: 'foreground', name: args.name, output: outcome.output }
      } finally {
        releaseName()
      }
    },
  }
}

/**
 * Build the tool a delegating agent uses to delete one of its own subagent
 * sessions. Deletion is explicit by design: a delegated child is never reaped
 * automatically, so this (or the user, in the Client panel) is the only way one
 * ends. Authority is the caller's own mapping, so an agent cannot delete a
 * stranger's child, and the child is addressed by the name its delegation gave
 * it.
 * @param options - the mapping store and the delete operation.
 * @param options.store - the parent/child mapping store.
 * @param options.deleteChild - stops the child, releases it, and archives its session.
 * @returns the tool definition.
 */
export function createDeleteSubagentTool({ store, deleteChild }) {
  return {
    name: 'delete_subagent',
    description:
      'Delete one subagent session you delegated, by the name you gave it. This stops the subagent if it is still '
      + 'working and removes its session from your list (its log is kept). Use it when a delegated task is no longer '
      + 'wanted — a wrong turn, a scope you no longer need, or a subagent that has clearly gone off track. Do not '
      + 'call it just to stop a subagent whose answer you are still waiting for: a subagent that finishes on its own '
      + 'reports back to you without being deleted.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      required: ['name'],
      properties: {
        name: {
          type: 'string',
          description: 'The name of the subagent to delete, as you named it when you delegated it.',
        },
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        required: ['name', 'deleted'],
        properties: {
          name: { type: 'string' },
          deleted: { type: 'boolean' },
        },
      },
      render: (_args, value) => [{
        type: 'text',
        text: value.deleted
          ? `deleted subagent "${value.name}"`
          : `no subagent named "${value.name}" is running for you`,
      }],
    },
    async execute(args, exec) {
      const parent = exec.agent
      if (parent === undefined) throw new Error('delete_subagent requires a calling agent (exec.agent was undefined)')
      const entry = store?.childNamed(parent.id, args.name)
      if (entry === undefined) {
        return { name: args.name, deleted: false }
      }
      await deleteChild(entry.childSessionId)
      return { name: args.name, deleted: true }
    },
  }
}

/**
 * Build the template-discovery tool definition. The delegation tool already
 * names every template; this reports what each one fixes, so the model can
 * explain a choice without a second delegation.
 * @param templates - every template, in configured order.
 * @returns the tool definition.
 */
export function createTemplateListTool(templates) {
  return {
    name: 'list_subagent_templates',
    description: 'List the subagent templates available to the delegation tool, with the model and agent '
      + 'preset each one fixes. Templates cannot be changed per call.',
    parameters: { type: 'object', additionalProperties: false, properties: {} },
    output: {
      schema: { type: 'string' },
      render: (_args, value) => [{ type: 'text', text: value }],
    },
    execute() {
      return Promise.resolve(templates.map(template => [
        templateLine(template),
        `  model: ${template.provider}/${template.model}`
        + (template.reasoningEffort === undefined ? '' : ` (reasoning effort: ${template.reasoningEffort})`),
        `  agent preset: ${template.preset ?? '(the delegating session\'s own composition)'}`,
      ].join('\n')).join('\n'))
    },
  }
}

/**
 * Build the tool a delegating agent uses to see the subagents it has running.
 *
 * The native `list_agents` cannot serve this: it reads the Harness subagent
 * registry, which holds no template child, because a template child is an
 * ordinary root Session. This reads the plugin's own mapping instead, which is
 * the only record of what a parent delegated.
 *
 * It lists direct children only. That is the scope every other tool in this set
 * can act on — a child that delegates again has its own children, reachable from
 * that child — so a deeper row would be a fact the caller could not use.
 * @param options - the mapping store and the live Agent registry.
 * @param options.store - the parent/child mapping store.
 * @param options.agents - the Harness Agent registry, or undefined without it.
 * @returns the tool definition.
 */
export function createSubagentListTool({ store, agents }) {
  return {
    name: 'list_subagents',
    description: 'List the subagents you delegated, with the name you gave each, the template it runs under, and '
      + 'whether it is still working. Use the name to send it a message, interrupt its current work, or delete it. '
      + 'A subagent that finished on its own already reported back to you, so listing it is how you check what is '
      + 'still outstanding rather than a way to collect results.',
    parameters: { type: 'object', additionalProperties: false, properties: {} },
    output: {
      schema: {
        type: 'array',
        items: {
          type: 'object',
          additionalProperties: false,
          required: ['name', 'template', 'status'],
          properties: {
            name: { type: 'string' },
            template: { type: 'string' },
            status: { type: 'string', enum: ['working', 'idle', 'ended'] },
          },
        },
      },
      render: (_args, rows) => [{
        type: 'text',
        text: rows.length === 0
          ? '(no subagents)'
          : rows.map(row => `- ${row.name} [${row.status}]: ${row.template}`).join('\n'),
      }],
    },
    async execute(_args, exec) {
      const parent = exec.agent
      if (parent === undefined) throw new Error('list_subagents requires a calling agent (exec.agent was undefined)')
      const rows = (store?.childrenOf(parent.id) ?? []).map((entry) => ({
        name: entry.mapping.name,
        template: entry.mapping.templateId,
        status: statusOf(agents, entry.childSessionId),
      }))
      return rows
    },
  }
}

/**
 * Build the tool a delegating agent uses to send a message to one of its own
 * subagents.
 *
 * This is the downward half of the channel `ask_parent` provides upward, and it
 * replaces the native `send_message` for template children: a working child
 * receives the message at its next step and an idle one starts a new turn with
 * it, which is the same delivery the native tool gave a continuable child.
 * @param options - the mapping store and the live Agent registry.
 * @param options.store - the parent/child mapping store.
 * @param options.agents - the Harness Agent registry, or undefined without it.
 * @returns the tool definition.
 */
export function createSubagentMessageTool({ store, agents }) {
  return {
    name: 'message_subagent',
    description: 'Send a message to a subagent you delegated, by the name you gave it. A subagent that is working '
      + 'receives it at its next step; one that is idle starts a new turn with it. This returns delivery, not an '
      + 'answer: a subagent reports its result when its turn ends. Use it to redirect a subagent, answer a question '
      + 'it asked you with `ask_parent`, or carry a subagent\'s own words back to it.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      required: ['name', 'message'],
      properties: {
        name: {
          type: 'string',
          description: 'The name of the subagent, as you named it when you delegated it.',
        },
        message: {
          type: 'string',
          description: 'The message for the subagent. It cannot see this conversation, so include anything it needs.',
        },
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        required: ['name', 'status'],
        properties: {
          name: { type: 'string' },
          status: { type: 'string', enum: ['delivered', 'unknown', 'ended'] },
        },
      },
      render: (_args, value) => [{
        type: 'text',
        text: {
          delivered: `message delivered to subagent "${value.name}"`,
          unknown: `no subagent named "${value.name}" is running for you`,
          ended: `subagent "${value.name}" is no longer live, so nothing received the message`,
        }[value.status],
      }],
    },
    async execute(args, exec) {
      const parent = exec.agent
      if (parent === undefined) throw new Error('message_subagent requires a calling agent (exec.agent was undefined)')
      const entry = store?.childNamed(parent.id, args.name)
      const child = entry === undefined ? undefined : agents?.get(entry.childSessionId)
      if (child === undefined) {
        return { name: args.name, status: entry === undefined ? 'unknown' : 'ended' }
      }
      child.steer(createAgentMessage(parent, [{ type: 'text', text: args.message }]))
      return { name: args.name, status: 'delivered' }
    },
  }
}

/**
 * Build the tool a delegating agent uses to stop one of its own subagents'
 * current work without ending it.
 *
 * This is the replacement for the native `interrupt_agent` and it is the tool
 * that makes a long background delegation controllable: the child stops where it
 * is, its Session and its transcript survive, and a message afterwards starts a
 * new turn with whatever context it had. `delete_subagent` is the other end of
 * that choice — it ends the child for good.
 *
 * An interrupted child settles silently, exactly as any externally stopped child
 * does: it did not finish, so there is no result to report.
 * @param options - the mapping store and the live Agent registry.
 * @param options.store - the parent/child mapping store.
 * @param options.agents - the Harness Agent registry, or undefined without it.
 * @returns the tool definition.
 */
export function createSubagentInterruptTool({ store, agents }) {
  return {
    name: 'interrupt_subagent',
    description: 'Stop a subagent\'s current work without deleting it, by the name you gave it. The subagent keeps '
      + 'its session and everything it has done so far; you can send it a new message afterwards and it will start '
      + 'another turn. This returns without waiting for the stop to take effect, and a subagent stopped this way '
      + 'reports nothing back to you, because it did not finish. Use `delete_subagent` instead when the subagent is '
      + 'no longer wanted at all.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      required: ['name'],
      properties: {
        name: {
          type: 'string',
          description: 'The name of the subagent, as you named it when you delegated it.',
        },
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        required: ['name', 'status'],
        properties: {
          name: { type: 'string' },
          status: { type: 'string', enum: ['interrupted', 'unknown', 'ended'] },
        },
      },
      render: (_args, value) => [{
        type: 'text',
        text: {
          interrupted: `asked subagent "${value.name}" to stop its current work`,
          unknown: `no subagent named "${value.name}" is running for you`,
          ended: `subagent "${value.name}" is no longer live, so there was nothing to stop`,
        }[value.status],
      }],
    },
    async execute(args, exec) {
      const parent = exec.agent
      if (parent === undefined) throw new Error('interrupt_subagent requires a calling agent (exec.agent was undefined)')
      const entry = store?.childNamed(parent.id, args.name)
      const child = entry === undefined ? undefined : agents?.get(entry.childSessionId)
      if (child === undefined) {
        return { name: args.name, status: entry === undefined ? 'unknown' : 'ended' }
      }
      child.cancel({ kind: 'parent' })
      return { name: args.name, status: 'interrupted' }
    },
  }
}
