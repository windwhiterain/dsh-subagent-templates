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
 * Validate one stored record at the durable boundary, and hand back the form
 * this plugin writes.
 *
 * The record names its child in `name`. A record written before the naming
 * requirement called that field `label` and held a task description, which was
 * then the only word that record had for its child, so it is read as the name and
 * is rewritten in the new form on the next write. That is why the unit version
 * does not change: the new reader accepts both records and always writes the
 * current one, which is a backward-compatible change rather than a migration.
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
  // A hot reload activates the new instance before the old one's domain has
  // closed, so `open` can legitimately find the name still reserved. Adopting
  // the live domain keeps the row activating; the old instance's disposer
  // closes it when its fiber unwinds, and the next reload reopens it.
  let domain
  let owned = true
  try {
    domain = await facility.open(MAPPING_DOMAIN)
  } catch (error) {
    if (!/already[- ]open/.test(String(error?.message ?? error))) throw error
    const live = facility.get?.(MAPPING_DOMAIN.name)
    if (live === undefined) throw error
    domain = live
    // An adopted domain belongs to the instance that opened it; closing it here
    // would pull the medium out from under that instance's own writes.
    owned = false
  }
  const table = domain.table(TABLE)
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
      await table.put(childSessionId, stored)
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
     * Read one parent's recorded children, oldest first.
     * @param parentSessionId - the delegating parent Session.
     * @returns that parent's children, in creation order.
     */
    childrenOf(parentSessionId) {
      return readAll(table)
        .filter(entry => entry.mapping.parentSessionId === parentSessionId)
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
      return readAll(table)
        .find(entry => entry.mapping.parentSessionId === parentSessionId && entry.mapping.name === name)
    },
    /**
     * Forget one child's mapping.
     * @param childSessionId - the child's Session id.
     * @returns whether a record was removed.
     */
    async remove(childSessionId) {
      return table.delete(childSessionId)
    },
    /** Close the domain, releasing the storage unit. A no-op for an adopted one. */
    async close() {
      if (owned) await domain.close()
    },
  }
}

