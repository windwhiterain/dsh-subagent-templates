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
 * titles the Session, it is the word `delete_subagent` deletes it by, it labels
 * the child's row in the Client panel, and every message about the child — the
 * settlement notice, a question the child sends up, an error — opens with it
 * rather than with the child's Session id. The name is unique among one parent's
 * live children, so a reference to a subagent is never ambiguous.
 *
 * A foreground call returns the child's output as its tool result; a background
 * call returns the child's name and delivers the output to the parent as a
 * settlement notice when the child finishes on its own terms. Either result also
 * carries the caller's other children when it has any — the rows
 * `list_subagents` would have answered, plus the sentence saying that nobody
 * ends a child for its parent — because a parent that delegates again is a
 * parent that already has children it may never delete, and the spawn is the one
 * moment to tell it. An interrupted turn is not an outcome: a child the user
 * stops keeps its session, so the call waiting for it keeps waiting and a
 * background watch stays armed until the child's next turn ends naturally. Only
 * deleting the child ends a background watch without a result. Deletion itself
 * takes several names in one call, or `"*"` for every child the caller delegated.
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
 * All of that lives on an **Agent**, and an Agent is not durable: a hot reload
 * keeps it, a restart replaces every one of them with a fresh Agent the moment
 * the user opens that Session. So none of it is left to activation time. Each
 * Session that appears is reconciled against the mapping store in whichever role
 * it plays — a delegating session recovers its four tools, a delegated one
 * recovers its `ask_parent` and its settlement watch — and a re-armed watch
 * resumes from the durable count of turns the parent has already been told
 * about, so a turn that ended while the Host was down is delivered once, and
 * never a turn it already has.
 *
 * Every message this plugin hands to another Session goes through one channel
 * (`./lib/delivery.js`), which picks the route the recipient's own state requires:
 * a delivery that opens a turn keeps the attribution the Client draws a turn
 * trigger from, a delivery spliced into a turn already running claims the one
 * source kind that is a visible row there, and a message a failed turn claimed
 * and never logged is put back once that turn is over.
 *
 * Delegation is capped the way the Harness caps its own subagents:
 * `maxActiveSubagents` bounds how many children a session has working at once,
 * and `maxDepth` bounds how deep delegation nests. Both read this plugin's
 * mapping store, since a template child carries no `parentSession` header for
 * the Harness to count from.
 *
 * A depth cap is applied by WITHHOLDING rather than by refusing: a session the
 * cap has closed never receives `subagent` or `list_subagent_templates`, because
 * a tool it can only fail with costs a tool error on every turn for a fact that
 * cannot change. The restriction lives on that session's own scope, is decided
 * from the recorded chain for a session this instance did not create, and is
 * lifted again if the live-editable cap is raised.
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
import { createDeliveryChannel } from './lib/delivery.js'
import {
  createDelegationTool,
  createDeleteSubagentTool,
  createSubagentInterruptTool,
  createSubagentListTool,
  createSubagentMessageTool,
  createTemplateListTool,
  withheldDelegationTools,
} from './lib/tool.js'
import { childDepthOf } from './lib/limits.js'
import { openMappingStore } from './lib/store.js'
import { childrenProjection } from './lib/projection.js'
import { installParentChannel, turnsEnded, watchChildSettlement } from './lib/session-delegate.js'

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

  // Every message this plugin hands to another Agent travels here: the channel
  // picks the route the recipient's own state requires, keeps the message
  // visible in the Client while it joins a running turn, and puts back one a
  // failed turn claimed and never logged. See ./lib/delivery.js.
  const deliveries = createDeliveryChannel(ctx)

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
   *
   * A child this instance did not create has no entry in `running` — that is
   * what a restart leaves behind — so its watch is ended here too, by the id
   * rather than by the record this instance happens to hold.
   * @param sessionId - the child session id.
   * @param reason - why it is being stopped.
   */
  const stopChild = (sessionId, reason) => {
    childWatches.get(sessionId)?.stop()
    childWatches.delete(sessionId)
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
  const control = { store, agents: ctx.get('agents'), deliveries }
  const childToolScopes = new Map()

  /**
   * The depth-cap restriction each session currently carries, keyed by Session id.
   *
   * Held per session rather than installed once globally, because a cap is
   * counted from each session's own position in the recorded chain: the same row
   * admits a top-level session and closes a child of it. The value is a holder
   * whose `dispose` the deferred registration fills in, so a cap raised later can
   * lift exactly this restriction and no other.
   */
  const depthCaps = new Map()

  /**
   * The configuration the running registrations were built from.
   *
   * `registerTemplateTools` is the writer and `applyDepthCap` the reader, and the
   * two must agree: a session reconciled against a stale cap would be denied tools
   * the row no longer forbids. It is replaced together with the registrations.
   */
  let current = initial

  /**
   * Whether this instance's teardown has run.
   *
   * A reload activates the replacement while this one is still unwinding, so work
   * that lands in the gap — a child whose creation window closes after the
   * disposer ran — must not register state the teardown will never see.
   */
  let unloaded = false

  /**
   * The settlement watch each recorded child currently has, keyed by that
   * child's Session id.
   *
   * One child gets one watch per instance, whoever created it: the delegating
   * call that spawned it, or the re-adoption that found it later. Two watches on
   * one child would each report the same turn.
   */
  const childWatches = new Map()

  /**
   * Holds one child's watch as this instance's answer for it.
   *
   * The returned releaser is what an explicit end, a child Session going away,
   * and this instance's own teardown all go through, so no watch outlives the
   * state that justifies it.
   * @param childSessionId - the child's Session id.
   * @param watch - the watch to hold.
   * @returns the releaser for this watch alone.
   */
  const trackWatch = (childSessionId, watch) => {
    childWatches.set(childSessionId, watch)
    return () => {
      if (childWatches.get(childSessionId) === watch) childWatches.delete(childSessionId)
    }
  }

  /**
   * Sessions a settlement notice is waiting for, keyed by that Session id.
   *
   * A child can finish a turn while its parent's Session is not resumed — one
   * the user closed, or one a restarted host has not brought back yet. The
   * result is held rather than dropped, and this is what it waits on: the one
   * `agent/created` listener below answers every wait, so no watch needs an
   * event subscription of its own.
   */
  const parentWaiters = new Map()

  /**
   * Resolve the live parent Agent a notice must reach.
   * @param parentSessionId - the delegating parent Session.
   * @param signal - ends the wait when the watch that owns it is stopped.
   * @returns the parent Agent, or undefined once the wait was stopped.
   */
  const waitForParent = (parentSessionId, signal) => {
    const live = control.agents?.get(parentSessionId)
    if (live !== undefined) return Promise.resolve(live)
    return new Promise((resolve) => {
      const waiters = parentWaiters.get(parentSessionId) ?? new Set()
      let finished = false
      const finish = (parent) => {
        if (finished) return
        finished = true
        waiters.delete(finish)
        if (waiters.size === 0) parentWaiters.delete(parentSessionId)
        signal.removeEventListener('abort', onStop)
        resolve(parent)
      }
      const onStop = () => finish(undefined)
      waiters.add(finish)
      parentWaiters.set(parentSessionId, waiters)
      signal.addEventListener('abort', onStop, { once: true })
      // A parent that came back between the read above and this registration must
      // not be missed; it reports itself here rather than at the next event.
      const now = control.agents?.get(parentSessionId)
      if (now !== undefined) finish(now)
    })
  }

  /**
   * Install the child-management tools into one session's own scope, at most once.
   *
   * `ctx.inject` runs its callback only after the fiber's first await, so the
   * registrations exist a microtask after this returns: the entry keeps a holder
   * whose `dispose` is filled in then. Capturing the assignment's result instead
   * would keep the placeholder, and the session's four tools would never be
   * withdrawn — leaving a reload's replacement to collide with them, because a
   * scope refuses two registrations of one name.
   *
   * A registration this scope refuses leaves the session unmarked, so a later
   * delegation can take the tools rather than the session losing them for good.
   * @param parent - the delegating parent Agent.
   */
  const adoptChildTools = (parent) => {
    if (childToolScopes.has(parent.id)) return
    // Reserve before the deferred registration runs, so two delegations in one
    // turn do not both adopt this session.
    const holder = { dispose: () => {} }
    childToolScopes.set(parent.id, holder)
    parent.ctx.inject(['tools'], (toolCtx) => {
      let disposers
      try {
        disposers = [
          toolCtx.tools.register(createSubagentListTool(control)),
          toolCtx.tools.register(createSubagentMessageTool(control)),
          toolCtx.tools.register(createSubagentInterruptTool(control)),
          toolCtx.tools.register(createDeleteSubagentTool({ store, deleteChild })),
        ]
      } catch (error) {
        childToolScopes.delete(parent.id)
        throw error
      }
      holder.dispose = () => {
        for (const dispose of disposers) dispose()
      }
      // This instance's teardown clears the entry before it closes the store, so a
      // registration that lands after that unload must not outlive it: the tools
      // would answer from a closed mapping domain, which is the state a replacement
      // can no longer repair.
      if (!childToolScopes.has(parent.id)) holder.dispose()
    })
  }

  /**
   * Withhold the delegation tools from one session that the depth cap has closed.
   *
   * A session at the cap must not be handed a tool it can only fail with: the
   * refusal would arrive as a tool error the model has to interpret, on every
   * turn, for a fact that never changes. So the tools are denied on that
   * session's own scope, and the call-time check inside the delegation tool stays
   * as the authority for a cap that moved after this session's tools were
   * assembled.
   *
   * The deny is reversible, because `maxDepth` is a volatile setting: raising the
   * cap has to hand the tools back, or a session that may delegate again would
   * still carry none. The entry is therefore keyed by session id and holds the
   * exact disposer `restrict()` returns.
   *
   * @param agent - the live Agent whose scope is being narrowed.
   * @param withheld - the tool names to deny, or undefined to leave the scope alone.
   */
  const applyDepthCap = (agent, withheld) => {
    const active = depthCaps.get(agent.id)
    if (withheld === undefined) {
      // The cap now admits this session's children again, so the tools go back.
      if (active === undefined) return
      depthCaps.delete(agent.id)
      active.dispose()
      return
    }
    // Already withheld, and by the same names: a Settings edit that re-registers
    // the row re-reconciles every session, and re-denying would stack a second
    // restriction on one that is already correct.
    if (active !== undefined) return
    const holder = { dispose: () => {} }
    depthCaps.set(agent.id, holder)
    agent.ctx.inject(['tools'], (toolCtx) => {
      const dispose = toolCtx.tools.restrict({ deny: withheld })
      holder.dispose = dispose
      // This instance's teardown clears the entry before the fiber lands, so a
      // restriction installed after that unload must not outlive it — the same
      // ordering the four adopted tools rely on.
      if (!depthCaps.has(agent.id)) dispose()
    })
  }

  /**
   * Record the cap a brand new child's own creation window already applied.
   *
   * A new child is denied inside `setup`, before its first model request and
   * before its mapping record exists, so there is no later moment at which the
   * depth could have been read to reach the same decision. Registering the deny
   * here is what makes it reversible afterwards: without an entry, a later
   * reconcile or a raised cap would find nothing to lift and this session would
   * carry no delegation tools for the rest of its life.
   * @param sessionId - the new child's Session id.
   * @param holder - the disposer holder for the restriction it installed.
   */
  const claimDepthCap = (sessionId, holder) => {
    if (depthCaps.has(sessionId)) return
    depthCaps.set(sessionId, holder)
    // The instance may have unloaded between the child's creation and this call,
    // which disposes every entry it held. A deny this instance did not own must
    // not be left behind by a teardown that never knew of it.
    if (unloaded) holder.dispose()
  }

  /**
   * Bring one session's delegation tools in line with the cap, from the durable
   * record rather than from anything the call that created it knew.
   *
   * This is the path a session takes that never ran a delegating call in this
   * process: one the host resumed after a restart, or one a reload re-adopted.
   * The mapping store is what still says how deep it sits, so the depth is read
   * from the chain rather than assumed.
   *
   * An unanswerable depth is not a refusal — the same rule the call-time check
   * follows — but it is ALSO not permission to withdraw, because a child whose
   * record has not been written yet is exactly that state: it is created, its
   * `agent/created` announcement fires, and its delegation depth only becomes
   * readable once the delegating call returns. That is why the cap for a NEW
   * child is decided by the call that created it, inside the child's own creation
   * window, and recorded through {@link claimDepthCap}: this reconcile must never
   * undo a deny it cannot yet justify.
   * @param agent - the live Agent to reconcile.
   */
  const reconcileDepthCap = (agent) => {
    const depth = childDepthOf(store, agent.id)
    if (depth === undefined) return
    applyDepthCap(agent, withheldDelegationTools(current.maxDepth, depth, current.toolName))
  }

  /**
   * Teach one recorded child what it is again, and give it back its watch.
   *
   * A child this instance did not create — one whose Session the host resumed
   * after a restart, or one that outlived a reloaded instance — has lost both:
   * the `ask_parent` that was registered in its own creation scope, and the
   * watch that carried its results home. The mapping record is what still says
   * which parent it belongs to and what it is called, which is everything either
   * one needs.
   *
   * The watch resumes from what the record says the parent has already been
   * told, and a record that says nothing is read as "everything the child's log
   * holds", so a delegation made before this counter existed is never replayed.
   * @param entry - the child's recorded mapping with its Session id.
   */
  const adoptRecordedChild = (entry) => {
    const { childSessionId, mapping } = entry
    const child = control.agents?.get(childSessionId)
    if (child === undefined) return
    // One pass per child per instance. A Session can be reconciled twice — once
    // as a parent that has children, once as a child of somebody — and a second
    // pass would register nothing while still leaving two inert fibers behind.
    if (childWatches.has(childSessionId)) return
    installParentChannel(ctx, child.ctx, mapping.parentSessionId, mapping.name, deliveries)
    const watch = watchChildSettlement(ctx, {
      name: mapping.name,
      sessionId: childSessionId,
      child,
      parentSessionId: mapping.parentSessionId,
      deliveries,
      waitForParent,
      answered: mapping.reportedTurns ?? turnsEnded(child.session.snapshotEvents()),
      markDelivered: (turns) => store?.markReported(childSessionId, turns),
    })
    trackWatch(childSessionId, watch)
    watch.report()
  }

  /**
   * Make one live session whole again, in whichever role it plays.
   *
   * A session that has delegated gets the tools that act on its children; a
   * session that WAS delegated gets its own channel up and a watch over its
   * turns. Both are read from the mapping store, which is durable, and both are
   * needed again for every Agent the host creates — so this runs on each one
   * rather than once when the plugin loads. A restart is exactly the case where
   * loading finds nothing: no Session is resumed until the user opens it.
   * @param agent - the live Agent that just appeared.
   */
  const reconcile = (agent) => {
    if (store?.hasChildren(agent.id) === true) adoptChildTools(agent)
    for (const entry of store?.childrenOf(agent.id) ?? []) adoptRecordedChild(entry)
    const mapping = store?.get(agent.id)
    if (mapping !== undefined) adoptRecordedChild({ childSessionId: agent.id, mapping })
    // Unconditional, and last: a session that never delegated still sits at some
    // depth, and a cap that has closed on it is true of the empty case too.
    reconcileDepthCap(agent)
  }

  // A session this plugin never delegated in: whatever is already live when the
  // row activates, which is what a reload finds. A cold start finds nothing here
  // and everything through `agent/created` below.
  for (const agent of control.agents?.list() ?? []) reconcile(agent)

  // Every Session the host brings up afterwards, in either role. This is the
  // Harness's own pattern for the same problem: a Session resumes long after the
  // plugin that composed it loaded, and what it needs has to follow it there.
  ctx.on('agent/created', ({ agent }) => {
    reconcile(agent)
    const waiters = parentWaiters.get(agent.id)
    if (waiters === undefined) return
    parentWaiters.delete(agent.id)
    for (const finish of waiters) finish(agent)
  })
  ctx.on('agent/disposed', ({ agent }) => {
    // The scope this session's tools lived in is unwinding with it, so the entry
    // has to go with it: a Session resumed later arrives under the same id, and
    // a stale entry would tell it it had already been adopted.
    childToolScopes.delete(agent.id)
    // The cap restriction lives in that same unwinding scope, so its entry goes
    // with it for the same reason — and it is NOT disposed here, because the
    // scope is what carries it away. A session resumed later is reconciled again
    // from the durable record and re-denied only if the cap still says so.
    depthCaps.delete(agent.id)
    // A watch on this child was observing an Agent that no longer exists, so it
    // can never see another turn. Its parent's watch is left alone: a parent
    // Session going away is not a reason to forget what its child owes it.
    childWatches.get(agent.id)?.stop()
    childWatches.delete(agent.id)
  })

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
  const registerTemplateTools = (config) => {
    for (const dispose of templateRegistrations) dispose()
    current = config
    templateNames = new Map(config.templates.map(template => [template.id, template.name]))
    templateRegistrations = [
      ctx.tools.register(createDelegationTool({
        ctx,
        toolName: config.toolName,
        templates: config.templates,
        store,
        claimName,
        onDelegated: adoptChildTools,
        claimDepthCap,
        trackWatch,
        waitForParent,
        registerChild,
        deliveries,
        maxDepth: config.maxDepth,
        maxActiveSubagents: config.maxActiveSubagents,
      })),
      ctx.tools.register(createTemplateListTool(config.templates)),
    ]
  }
  registerTemplateTools(initial)
  /**
   * Re-decide the cap for every live session against the configuration that now
   * holds. A raised cap lifts the restrictions it put in place and a lowered one
   * puts them back, and both are reversible precisely because each deny was taken
   * with the exact disposer `restrict()` returned.
   */
  const reconcileAllDepthCaps = () => {
    for (const agent of control.agents?.list() ?? []) reconcileDepthCap(agent)
  }
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
    // The cap moved, so every live session's own depth is re-read against it.
    // Template edits alone change no depth, but re-deciding here is what keeps
    // the two derivations from drifting apart over a row's lifetime.
    reconcileAllDepthCaps()
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
  // Unloading releases the storage unit, withdraws every adopted scope, and ends
  // every watch this instance armed — the adopted registrations live on the
  // agents' fibers, not this plugin's, so nothing else would take them back. The
  // children themselves deliberately keep running: a code reload must never
  // destroy a subagent mid-task.
  ctx.effect(() => async () => {
    unloaded = true
    for (const holder of childToolScopes.values()) holder.dispose()
    childToolScopes.clear()
    // The cap restrictions live on the agents' fibers, exactly as the four adopted
    // tools do, so this instance is what takes them back. A replacement re-decides
    // each one from the same durable record, so lifting them here cannot leave a
    // session with no cap and no replacement to install one.
    for (const holder of depthCaps.values()) holder.dispose()
    depthCaps.clear()
    // A watch left armed would report through a closed mapping domain and, once
    // its replacement armed one beside it, twice. What it owed is not lost: the
    // delivered count is durable, so the next instance resumes from where this
    // one stopped rather than replaying what the parent already has.
    for (const watch of childWatches.values()) watch.stop()
    childWatches.clear()
    parentWaiters.clear()
    // Live children deliberately survive this unload, so the channel stops
    // watching them first: a replaced instance re-arms it on its own
    // deliveries, and a child this instance never reaches again owes nothing.
    deliveries.stop()
    await store?.close()
  })
}
