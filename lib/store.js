/**
 * Durable parent→child mapping for template Sessions.
 *
 * A template child is an ordinary root Session: its header carries no
 * `parentSession`, because that field is what makes the Client treat a session
 * as a subagent — which hides the model picker. The parent/child relationship
 * therefore lives here, in this plugin's own storage domain, and both the
 * result delivery and the Client panel read it.
 *
 * The delegating call names every child, and that name is the child's handle:
 * it titles the child's Session, addresses it in `delete_subagent`, and labels
 * its row in the panel. No model-visible reference to a child is a Session id.
 *
 * A record also carries `reportedTurns`: how many of that child's ended turns
 * have already reached its parent. It is what makes a settlement survive a
 * restart — a watch re-armed after one reads the child's log again, and the
 * counter is the only thing that can tell a turn it must report from one that
 * was already reported. Absent on a record written before it existed, and read
 * as "everything in the log so far" rather than as zero, so an old record is
 * never replayed.
 *
 * Records are indexed by parent as they are read and written, because the
 * reader that matters — whether one Session has delegated, asked on every Agent
 * the host creates — must not cost a scan of the whole domain.
 *
 * The domain spec is a plain object because a third-party bundle imports no
 * Harness package: `ctx.storageDomain.open()` duck-types each schema as
 * something with `parse`, so a `{ parse }` validator satisfies it. Consumers
 * subscribe to `domain/changed` for live updates.
 *
 * @module dsh-subagent-templates/lib/store
 */

/** Storage domain name; matches the storage unit-name rule. */
export const DOMAIN_NAME = 'subagent_templates'

/** Table holding one record per delegated child Session. */
export const TABLE = 'children'

/**
 * Current mapping format version. It has not moved since the record gained a
 * name, because the reader accepts the older record and writes the current one.
 */
const VERSION = 1

/**
 * How long to wait for a previous instance to release the domain on reload. The
 * teardown it waits on is a write-chain drain plus one unit close, and a reload
 * that exceeds this fails the row loudly rather than half-activating it.
 */
const OPEN_WAIT_MS = 5000

/** Poll interval while waiting for that release. */
const OPEN_POLL_MS = 25

/**
 * Validate one stored record at the durable boundary, and hand back the form
 * this plugin writes.
 *
 * The record names its child in `name`. A record written before the naming
 * requirement called that field `label` and held a task description, which was
 * then the only word that record had for its child, so it is read as the name and
 * is rewritten in the new form on the next write. That is why the unit version
 * does not change: the new reader accepts both records and always writes the
 * current one, which is a backward-compatible change rather than a migration.
 * `reportedTurns` was added the same way: a record that has none is read without
 * it, and the next write carries it.
 *
 * The shape is fixed and small, so an explicit field check is the whole validator.
 * @param value - the raw stored record.
 * @returns the record in the form this plugin writes.
 * @throws when a field is missing or malformed.
 */
function parseMapping(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new TypeError('subagent-templates: a stored child mapping must be an object')
  }
  const candidate = value
  const name = candidate.name ?? candidate.label
  for (const key of ['parentSessionId', 'templateId', 'cwd']) {
    if (typeof candidate[key] !== 'string' || candidate[key].length === 0) {
      throw new TypeError(`subagent-templates: stored child mapping field "${key}" must be a non-empty string`)
    }
  }
  if (typeof name !== 'string' || name.length === 0) {
    throw new TypeError('subagent-templates: stored child mapping field "name" must be a non-empty string')
  }
  if (!Number.isSafeInteger(candidate.createdAt) || candidate.createdAt < 0) {
    throw new TypeError('subagent-templates: stored child mapping createdAt must be a non-negative integer')
  }
  if (candidate.reportedTurns !== undefined
    && (!Number.isSafeInteger(candidate.reportedTurns) || candidate.reportedTurns < 0)) {
    throw new TypeError('subagent-templates: stored child mapping reportedTurns must be a non-negative integer')
  }
  const { label: _legacyLabel, ...rest } = candidate
  return { ...rest, name }
}

/**
 * The storage-domain declaration this plugin opens.
 *
 * A single whole-unit document, which is the layout this plugin's unit was
 * created in; the `children` table's keys are child Session ids, so they are
 * path-safe either way, and the single layout keeps the unit in one readable
 * file next to the other profile storages.
 */
export const MAPPING_DOMAIN = Object.freeze({
  name: DOMAIN_NAME,
  version: VERSION,
  tables: { [TABLE]: { valueSchema: { parse: parseMapping } } },
})

/**
 * Read every recorded mapping, newest first.
 * @param table - an open domain table.
 * @returns all stored child records with their child Session ids.
 */
function readAll(table) {
  return [...table.entries()]
    .map(([childSessionId, mapping]) => ({ childSessionId, mapping }))
    .sort((a, b) => b.mapping.createdAt - a.mapping.createdAt)
}

/**
 * Open the mapping domain and expose its operations. The plugin owns the
 * returned handle: unloading closes the domain, after which the mapping is
 * re-readable from disk on the next activation.
 *
 * The domain facility is reached through the global `ctx.storage` hub, NOT
 * `ctx.get('storageDomain')`: the facility is subtree-scoped (provided on an
 * injected child context by the domain layer) and is therefore invisible to a
 * third-party plugin. The hub is a process service and the facility is one of
 * its mounted forms, so `form('domain')` is the supported accessor; an
 * unmounted form throws, which this degrades to a warning.
 *
 * @param ctx - the plugin context carrying the optional `storage` hub.
 * @returns the mapping operations, or undefined when the deployment has no storage domain form.
 */
export async function openMappingStore(ctx) {
  const storage = ctx.get('storage')
  let facility
  try {
    facility = storage?.form('domain')
  } catch {
    facility = undefined
  }
  if (facility === undefined) {
    ctx.logger?.warn?.(
      'subagent-templates: the storage domain form is not mounted; the parent/child mapping will not be persisted',
    )
    return undefined
  }
  // A hot reload activates this instance before the previous one's disposer has
  // finished closing, so `open` can legitimately find the name still reserved.
  // The handle belongs to whoever opened it and that instance closes it, so this
  // waits out the previous teardown instead of adopting a domain the previous
  // instance is about to close — an adopted handle is dead the moment it is.
  const domain = await openOwnedDomain(facility)
  const table = domain.table(TABLE)
  /**
   * Every record, keyed by the parent it names and then by child Session id.
   *
   * The domain itself is keyed by child, which answers one child's record and
   * nothing else. The reader this plugin asks most often is the other one —
   * "does this Session have children", asked of every Agent the host creates —
   * so the records are indexed by parent on the way in and kept that way by
   * every write this plugin makes. It is the only writer of this table, so the
   * index cannot fall behind the medium.
   */
  const byParent = new Map()
  /** File one record under the parent it names. */
  const indexRecord = (childSessionId, mapping) => {
    const siblings = byParent.get(mapping.parentSessionId) ?? new Map()
    siblings.set(childSessionId, mapping)
    byParent.set(mapping.parentSessionId, siblings)
  }
  /** Drop one record from the parent's set, and the set itself when it empties. */
  const forgetRecord = (childSessionId, mapping) => {
    const siblings = byParent.get(mapping.parentSessionId)
    if (siblings?.delete(childSessionId) !== true) return
    if (siblings.size === 0) byParent.delete(mapping.parentSessionId)
  }
  for (const [childSessionId, mapping] of table.entries()) indexRecord(childSessionId, mapping)
  return {
    /** The opened domain, for consumers that need its own handle. */
    domain,
    /**
     * Record one delegated child under its parent.
     * @param childSessionId - the child's Session id.
     * @param mapping - the parent, name, template, time, and cwd facts.
     * @returns the stored record.
     */
    async put(childSessionId, mapping) {
      const stored = {
        parentSessionId: mapping.parentSessionId,
        name: mapping.name,
        templateId: mapping.templateId,
        createdAt: mapping.createdAt,
        cwd: mapping.cwd,
      }
      const previous = table.get(childSessionId)
      await table.put(childSessionId, stored)
      if (previous !== undefined) forgetRecord(childSessionId, previous)
      indexRecord(childSessionId, stored)
      return stored
    },
    /**
     * Read one child's mapping.
     * @param childSessionId - the child's Session id.
     * @returns the stored record, or undefined when it is not recorded.
     */
    get(childSessionId) {
      return table.get(childSessionId)
    },
    /**
     * Read every recorded mapping, newest first.
     * @returns every child record with its Session id.
     */
    all() {
      return readAll(table)
    },
    /**
     * Whether one Session has delegated anything.
     *
     * This is the question asked of every Agent the host creates, to decide
     * whether that session's child-management tools belong to it, so it reads
     * the index rather than the domain.
     * @param parentSessionId - the delegating parent Session.
     * @returns whether at least one child is recorded against it.
     */
    hasChildren(parentSessionId) {
      return (byParent.get(parentSessionId)?.size ?? 0) > 0
    },
    /**
     * Read one parent's recorded children, oldest first.
     * @param parentSessionId - the delegating parent Session.
     * @returns that parent's children, in creation order.
     */
    childrenOf(parentSessionId) {
      const siblings = byParent.get(parentSessionId)
      if (siblings === undefined) return []
      return [...siblings]
        .map(([childSessionId, mapping]) => ({ childSessionId, mapping }))
        .sort((a, b) => a.mapping.createdAt - b.mapping.createdAt)
    },
    /**
     * Find one parent's child by the name its delegating call gave it. The name
     * is the only handle a later tool call carries, so this is the lookup that
     * resolves it — and, because the name is unique among a parent's live
     * children, at most one record can match.
     * @param parentSessionId - the delegating parent Session.
     * @param name - the name the parent gave the child.
     * @returns the child record with its Session id, or undefined when the parent has no such child.
     */
    childNamed(parentSessionId, name) {
      const siblings = byParent.get(parentSessionId)
      if (siblings === undefined) return undefined
      for (const [childSessionId, mapping] of siblings) {
        if (mapping.name === name) return { childSessionId, mapping }
      }
      return undefined
    },
    /**
     * Record that this child's first `turns` ended turns have reached its parent.
     *
     * The count only ever moves forward, so a second report of the same turn —
     * two watches alive at once, or a redelivery — cannot walk it back and make
     * the next restart report that turn again.
     * @param childSessionId - the child's Session id.
     * @param turns - how many ended turns have now been reported.
     * @returns the stored record, or undefined when the child is no longer recorded.
     */
    async markReported(childSessionId, turns) {
      const current = table.get(childSessionId)
      if (current === undefined) return undefined
      if (current.reportedTurns !== undefined && current.reportedTurns >= turns) return current
      const updated = { ...current, reportedTurns: turns }
      await table.put(childSessionId, updated)
      indexRecord(childSessionId, updated)
      return updated
    },
    /**
     * Forget one child's mapping.
     * @param childSessionId - the child's Session id.
     * @returns whether a record was removed.
     */
    async remove(childSessionId) {
      const current = table.get(childSessionId)
      const removed = await table.delete(childSessionId)
      if (current !== undefined) forgetRecord(childSessionId, current)
      return removed
    },
    /** Close the domain, releasing the storage unit. */
    async close() {
      await domain.close()
    },
  }
}

/**
 * Open this plugin's domain, waiting out a previous instance's teardown.
 *
 * The facility rejects a name that is still reserved (`already-open`) and frees
 * it only once the owning instance's `close()` has drained its write chain and
 * released the unit. A reload lands inside that window, so this polls until the
 * name frees and then opens a handle of its own.
 * @param facility - the mounted storage-domain facility.
 * @returns the domain handle this instance owns and closes.
 * @throws when the name is still reserved after {@link OPEN_WAIT_MS}.
 */
async function openOwnedDomain(facility) {
  const deadline = Date.now() + OPEN_WAIT_MS
  for (;;) {
    try {
      return await facility.open(MAPPING_DOMAIN)
    } catch (error) {
      if (!/already[- ]open/.test(String(error?.message ?? error))) throw error
      if (Date.now() >= deadline) {
        throw new Error(
          `subagent-templates: storage domain '${DOMAIN_NAME}' is still reserved after ${OPEN_WAIT_MS} ms; `
          + 'the previous instance has not released it',
        )
      }
      await new Promise(resolve => setTimeout(resolve, OPEN_POLL_MS))
    }
  }
}

