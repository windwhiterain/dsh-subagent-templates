/**
 * Delegation depth over this plugin's own parent/child mapping.
 *
 * The Harness answers delegation depth from a child's persisted `parentSession`
 * header. A template child has none: this plugin leaves that field unset so the
 * Client keeps the child's model picker available, and that same omission is
 * what keeps the child out of the subagent registry. The mapping store is
 * therefore the only record of the chain, and depth is counted by walking it.
 *
 * @module dsh-subagent-templates/lib/depth
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
 * Whether a delegation at one child depth stays within the configured cap.
 *
 * `maxDepth` is undefined when the row declares none, and `'provider-managed'`
 * when it defers the bound to the delegation provider — this plugin delegates to
 * ordinary root Sessions and mounts no provider, so both values leave the depth
 * unbounded here.
 * @param maxDepth - the row's `maxDepth`, when it declares one.
 * @param childDepth - the depth the attempted child would take.
 * @returns whether the delegation may proceed.
 */
export function withinMaxDepth(maxDepth, childDepth) {
  if (maxDepth === undefined || maxDepth === 'provider-managed') return true
  if (childDepth === undefined) return true
  return childDepth <= maxDepth
}
