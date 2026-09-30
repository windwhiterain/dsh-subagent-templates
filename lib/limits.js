/**
 * Delegation limits for template children.
 *
 * Every limit here answers a question the Harness cannot answer for this plugin.
 * A template child is an ordinary root Session: its header carries no
 * `parentSession`, because that field is what makes the Client treat a session
 * as a subagent and hide its model picker. The plugin's own mapping store is
 * therefore the only record of the parent/child chain, and every count is taken
 * from it.
 *
 * The names and the semantics mirror the Harness's own subagent limits
 * (`packages/subagent/subagent/src/index.ts`): `maxDepth` caps how deep
 * delegation nests, and `maxActiveSubagents` caps how many children one Session
 * keeps alive at once. A child that has finished stops counting against the
 * active limit, exactly as the Harness's own activation pool releases its slot.
 *
 * @module dsh-subagent-templates/lib/limits
 */

/**
 * Resolve the depth a child of one Session would take.
 *
 * A Session with no recorded parent is top-level, so its child is depth 1.
 * @param store - the parent/child mapping store, or undefined without storage.
 * @param parentSessionId - the Session that would delegate.
 * @returns that Session's child depth, or undefined when no store can answer it.
 */
export function childDepthOf(store, parentSessionId) {
  if (store === undefined) return undefined
  let depth = 0
  let current = parentSessionId
  // The plugin never writes a cycle, but the walk bounds itself rather than
  // trusting a durable unit: a corrupt record must not hang a tool call.
  const walked = new Set([current])
  for (;;) {
    const mapping = store.get(current)
    if (mapping === undefined) break
    depth += 1
    current = mapping.parentSessionId
    if (walked.has(current)) break
    walked.add(current)
  }
  return depth + 1
}

/**
 * Count one Session's children that are still working.
 *
 * A child that has finished keeps its mapping — this plugin never reaps a child
 * — but it must not hold a slot against new work, or a Session would have to
 * delete its history before it could delegate again. This is the rule the
 * Harness's own activation pool follows when it releases a slot on completion.
 * @param store - the parent/child mapping store, or undefined without storage.
 * @param parentSessionId - the Session that would delegate.
 * @param isActive - reports whether a child Session is still working.
 * @returns the active child count, or undefined when no store can answer it.
 */
export function activeChildrenOf(store, parentSessionId, isActive) {
  if (store === undefined) return undefined
  return store.childrenOf(parentSessionId).filter(entry => isActive(entry.childSessionId)).length
}

/**
 * Whether a delegation may proceed at the given child depth.
 *
 * `undefined` and `'provider-managed'` both leave the depth unbounded:
 * `'provider-managed'` states that the bound belongs to the delegation provider,
 * and this plugin mounts no provider. An unanswerable depth is not a refusal.
 * @param maxDepth - the row's `maxDepth`, when it declares one.
 * @param childDepth - the depth the attempted child would take.
 * @returns whether the delegation may proceed.
 */
export function withinMaxDepth(maxDepth, childDepth) {
  if (maxDepth === undefined || maxDepth === 'provider-managed') return true
  if (childDepth === undefined) return true
  return childDepth <= maxDepth
}

/**
 * Whether a delegation may proceed at the given live-child count.
 *
 * The cap is on children alive now, so a finished child frees its slot. An
 * unanswerable count is not a refusal.
 * @param maxActiveSubagents - the row's cap on simultaneously live children.
 * @param activeChildren - how many children this Session has alive.
 * @returns whether the delegation may proceed.
 */
export function withinMaxActiveSubagents(maxActiveSubagents, activeChildren) {
  if (maxActiveSubagents === undefined) return true
  if (activeChildren === undefined) return true
  return activeChildren < maxActiveSubagents
}
