/**
 * Named subagent templates for DeepSeek Harness.
 *
 * Each configured template fixes a starting route — one provider/model pair, or
 * a route pool resolved per child by `dsh-llm-quota-retry` — an agent preset, and
 * an optional persona, and the `subagent` tool this plugin registers takes a
 * `template` argument so a delegating agent selects by name and description
 * instead of naming a provider, a model, and a reasoning effort per call. A
 * template says nothing about whether a child runs in the background: that is the
 * caller's decision on every call, and the call states it.
 *
 * A template call creates an ordinary root Session — a workspace, a top-level
 * Agent, an attached Session, one opening prompt — so the subagent keeps the
 * full model picker and Session surface and the user can open, steer, or stop
 * it like any session. The parent/child relationship lives in this plugin's
 * storage domain (`./store.ts`), never in the Session header, precisely so the
 * Client does not classify the child as a subagent and hide its picker.
 *
 * Every call names its child, and that name is the child's only handle: it
 * titles the Session, it is what `delete_subagent` takes, it labels the
 * child's row in the Client panel, and every message about the child — the
 * settlement notice, a question the child sends up, an error — opens with it
 * rather than with the child's Session id. The name is unique among one parent's
 * live children, so a reference to a subagent is never ambiguous.
 *
 * A foreground call returns the child's output as its tool result; a background
 * call returns the child's name and delivers the output to the parent as a
 * settlement notice when the child finishes on its own terms. An interrupted
 * turn is not an outcome: a child the user stops keeps its session, so the call
 * waiting for it keeps waiting and a background watch stays armed until the
 * child's next turn ends naturally. Only deleting the child ends a background
 * watch without a result.
 *
 * A template child is an ordinary root Session, so it is deliberately absent from
 * the Harness subagent registry. That is what keeps its model picker, and it is
 * also why the native delegation tools cannot serve it: `list_agents` and
 * `send_message` read a registry this plugin's children are not in. This plugin
 * therefore supplies the same capabilities over its own mapping — `list_subagents`,
 * `message_subagent`, `interrupt_subagent`, and `delete_subagent` — so a parent
 * has one delegation world with one naming discipline. Those four are installed
 * into a session's own scope once that session has delegated, so a session that
 * never delegates never carries them. What is not reproduced is `subagent_fork`,
 * whose inherited-context child would be a second kind of object with a second
 * lifecycle.
 *
 * Delegation is capped the way the Harness caps its own subagents:
 * `maxActiveSubagents` bounds how many children a session has working at once,
 * and `maxDepth` bounds how deep delegation nests. Both read this plugin's
 * mapping store, since a template child carries no `parentSession` header for
 * the Harness to count from.
 *
 * This plugin imports no Harness package: out-of-tree bundles resolve from the
 * profile, which does not put the Harness's own modules on this package's
 * resolution path. Its one dependency is the schema library
 * `@deepseek-ai/schemastery`, which `./lib/config.js` builds the row's `Config`
 * from — the schema the Loader validates the row with and the Settings surface
 * edits — and `./lib/harness.js` holds the replicated Harness behavior.
 *
 * @module dsh-subagent-templates
 */

import { Config, normalizeConfig } from './lib/config.js'
import {
  createDelegationTool,
  createDeleteSubagentTool,
  createSubagentInterruptTool,
  createSubagentListTool,
  createSubagentMessageTool,
  createTemplateListTool,
} from './lib/tool.js'
import { openMappingStore } from './lib/store.js'
import { childrenProjection } from './lib/projection.js'

export const name = 'subagent-templates'
export const inject = ['tools']
export { Config }

/** Configuration fields the Settings surface may edit on a running row. */
const VOLATILE_FIELDS = Object.freeze(['templates', 'maxDepth', 'maxActiveSubagents'])

/**
 * Mount one template delegation composition.
 * @param ctx - the context that owns every registration, including the tool row.
 * @param rawConfig - the row's configuration, validated here and by {@link Config}.
 */
export async function apply(ctx, rawConfig) {
  // Volatile fields arrive as references the Loader updates in place, so the
  // configuration is read through `normalizeConfig` again whenever one changes.
  const initial = normalizeConfig(rawConfig)

  /**
   * Live children, keyed by child session id. A template child is a root
   * Session, so nothing in the host tracks it for us: this registry is the only
   * thing that can end one on an explicit delete, which also ends the settlement
   * watch still waiting for its next result.
   */
  const running = new Map()

  /**
   * Names reserved by delegations that have not been recorded yet, keyed by
   * parent session id and then by name. The store is the authority on which
   * names a parent already uses; this covers the window before the record is
   * written, when two calls in one turn could otherwise both take the same name.
   */
  const claimedNames = new Map()

  const store = await openMappingStore(ctx)

  /**
   * Reserve one name among a parent's subagents.
   *
   * The name is the child's only handle, so two live children of the same parent
   * may never share one: every later reference to a child would be ambiguous.
   * Both the durable record and an in-flight claim are checked, and the claim is
   * released when the call settles either way.
   * @param parentSessionId - the delegating parent session id.
   * @param name - the name the call gave the child.
   * @returns the release this call must run when it settles.
   * @throws when the parent already has a live subagent by that name.
   */
  const claimName = (parentSessionId, name) => {
    if (typeof name !== 'string' || name.trim().length === 0) {
      throw new Error('a subagent needs a name that is not blank')
    }
    const held = claimedNames.get(parentSessionId) ?? new Set()
    if (held.has(name) || store?.childNamed(parentSessionId, name) !== undefined) {
      throw new Error(
        `a subagent named "${name}" already exists; give this one a different name, or delete the existing one first`,
      )
    }
    held.add(name)
    claimedNames.set(parentSessionId, held)
    return () => {
      held.delete(name)
      if (held.size === 0) claimedNames.delete(parentSessionId)
    }
  }

  /**
   * Register one child so an explicit end can reach it, whichever route
   * delegated it.
   * @param sessionId - the child session id.
   * @param parentSessionId - the delegating parent session id.
   * @param child - the child's Agent, owning handle, lifetime controller, and
   *   the stop of its settlement watch.
   */
  const registerChild = (sessionId, parentSessionId, child) => {
    running.set(sessionId, { parentSessionId, ...child })
  }

  /**
   * Stop one background child for good: abort its lifetime, release the handle,
   * and end its settlement watch.
   *
   * The child's lifetime controller is the only thing that owns it, so aborting
   * that — then releasing the handle — is what actually stops it. Either step
   * may be refused by a Session whose scope is already unwound; that is a
   * diagnostic, not a teardown failure.
   *
   * The watch is stopped here and nowhere else, because this is the one path
   * that ends a delegated child: an interruption leaves the child live and its
   * watch armed (its next natural turn is what reports), but a deleted child can
   * never settle, and a watch that outlived it could only wait forever.
   * @param sessionId - the child session id.
   * @param reason - why it is being stopped.
   */
  const stopChild = (sessionId, reason) => {
    const child = running.get(sessionId)
    if (child === undefined) return
    running.delete(sessionId)
    child.stopWatch?.()
    try {
      child.lifetime.abort(new Error(`subagent-templates: ${reason}`))
    } catch (error) {
      ctx.logger?.warn?.(`subagent-templates: child ${sessionId} refused cancellation: ${String(error)}`)
    }
    void child.handle.dispose().catch(() => {})
  }

  /**
   * Delete one delegated child on explicit request: stop its Agent, release its
   * handle, and archive its Session (removed from the lists, log kept). This is
   * the ONLY path that ends a child — a delegated Session is never reaped
   * automatically, not when the parent closes and not when this plugin unloads.
   * @param sessionId - the child session id.
   * @returns the deleted session id, for the tool result.
   */
  const deleteChild = async (sessionId) => {
    stopChild(sessionId, 'the delegating agent deleted this subagent session')
    const mapping = store?.get(sessionId)
    if (mapping !== undefined) await store?.remove(sessionId)
    const workspaces = ctx.get('workspaceRegistry')
    if (workspaces !== undefined) {
      // stopActivity lets the archive proceed even though the child may still be
      // mid-turn; stopChild above already asked it to stop.
      await workspaces.archiveSession(sessionId, { stopActivity: true }).catch((error) => {
        ctx.logger?.warn?.(`subagent-templates: archiving child ${sessionId} failed: ${String(error)}`)
      })
    }
    return sessionId
  }

  // The four tools that stand in for the native ones this plugin's design
  // removes. The native rows read `ctx.subagents`, which holds no template child
  // because a template child is an ordinary root Session; these read the mapping
  // store and the Agent registry instead, and address a child by its name.
  //
  // They are installed into the delegating session's OWN agent scope, and only
  // once that session has delegated something. Before its first delegation every
  // one of them could only answer "you have no subagent named that", so carrying
  // them in the prompt is four tools of noise and four tempting dead ends. An
  // agent-scoped registration unwinds with the agent, and appears in that
  // session's next model request — it cannot appear in the one already in flight.
  //
  // They are never withdrawn again. A session that has delegated may delegate
  // again at any point, and keeping them means it does not have to earn them a
  // second time; after its last child is gone they answer honestly instead.
  const control = { store, agents: ctx.get('agents') }
  const childToolScopes = new Map()

  /**
   * Install the child-management tools into one session's own scope, at most once.
   * @param parent - the delegating parent Agent.
   */
  const adoptChildTools = (parent) => {
    if (childToolScopes.has(parent.id)) return
    let disposeTools = () => {}
    parent.ctx.inject(['tools'], (toolCtx) => {
      const disposers = [
        toolCtx.tools.register(createSubagentListTool(control)),
        toolCtx.tools.register(createSubagentMessageTool(control)),
        toolCtx.tools.register(createSubagentInterruptTool(control)),
        toolCtx.tools.register(createDeleteSubagentTool({ store, deleteChild })),
      ]
      disposeTools = () => {
        for (const dispose of disposers.reverse()) dispose()
      }
    })
    childToolScopes.set(parent.id, disposeTools)
  }

  // A hot reload replaces this instance and loses every scope it adopted, while
  // the children it recorded are still in the store. Adopting the live sessions
  // that already have children is what keeps a reloaded session's tools from
  // vanishing until it happens to delegate again.
  for (const agent of ctx.get('agents')?.list() ?? []) {
    if ((store?.childrenOf(agent.id) ?? []).length > 0) adoptChildTools(agent)
  }

  /**
   * Template id -> display name, for the sidebar projection. Rebuilt with the
   * registrations below, because the projection closes over this binding rather
   * than over a snapshot of it.
   */
  let templateNames = new Map()

  /**
   * Registrations derived from the template list and the two caps.
   *
   * They are rebuilt rather than registered once, because a Settings edit commits
   * those volatile values into the running configuration: the delegation tool's
   * description names every template it offers, so a stale one would advertise a
   * template the row no longer has.
   */
  let templateRegistrations = []
  const registerTemplateTools = (current) => {
    for (const dispose of templateRegistrations) dispose()
    templateNames = new Map(current.templates.map(template => [template.id, template.name]))
    templateRegistrations = [
      ctx.tools.register(createDelegationTool({
        ctx,
        toolName: current.toolName,
        templates: current.templates,
        store,
        claimName,
        onDelegated: adoptChildTools,
        registerChild,
        maxDepth: current.maxDepth,
        maxActiveSubagents: current.maxActiveSubagents,
      })),
      ctx.tools.register(createTemplateListTool(current.templates)),
    ]
  }
  registerTemplateTools(initial)
  ctx.effect(() => () => {
    for (const dispose of templateRegistrations) dispose()
  }, `${name}.tools`)

  // A Settings edit commits volatile values into the running configuration and
  // names the paths it changed. A value this row then refuses — an unknown field,
  // a duplicate id — keeps the running registrations: the Loader has already
  // committed the value, so the refusal is logged rather than thrown, and the next
  // valid edit takes effect.
  ctx.on('loader/volatile-update', (paths) => {
    if (!paths.some(path => VOLATILE_FIELDS.includes(path[0]))) return
    let next
    try {
      next = normalizeConfig(rawConfig)
    } catch (error) {
      ctx.logger.error(
        'subagent-templates: the edited configuration was refused: '
        + `${error instanceof Error ? error.message : String(error)}`,
      )
      return
    }
    registerTemplateTools(next)
  })

  // This row ships a page of its own (`client.js`), which is where those volatile
  // fields are edited, so the shipped auto-generated form for them is suppressed:
  // one row, one page.
  ctx.inject(['settings'], (child) => {
    child.effect(() => child.settings.configure({ auto: false }, ctx.fiber), `${name}.settings`)
  })

  // Publish the delegated children to the browser panel. The fold reads the
  // mapping store, so it is recomputed on every parent Session event — which is
  // when a child can have been added. The wire row carries only what the panel
  // draws; the template's display name is resolved here because the store
  // records the template id, which the panel never shows.
  ctx.inject(['sessionProjections'], (child) => {
    child.effect(() => child.sessionProjections.register(childrenProjection(
      (sessionId) => (store?.childrenOf(sessionId) ?? []).map(entry => ({
        childSessionId: entry.childSessionId,
        name: entry.mapping.name,
        templateName: templateNames.get(entry.mapping.templateId) ?? entry.mapping.templateId,
        createdAt: entry.mapping.createdAt,
      })),
    )), `${name}.projection`)
  })

  // A disposed parent no longer ends its children. Each child is its own
  // Session, so it keeps working and the user can still open, steer, or delete
  // it; only an explicit delete stops one.
  // Unloading releases the storage unit and withdraws every adopted scope —
  // the adopted registrations live on the agents' fibers, not this plugin's, so
  // nothing else would take them back — but it deliberately leaves live children
  // running: a code reload must never destroy a subagent mid-task.
  ctx.effect(() => async () => {
    for (const dispose of childToolScopes.values()) dispose()
    childToolScopes.clear()
    await store?.close()
  })
}
