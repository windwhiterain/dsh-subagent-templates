/**
 * The Session projection that carries a parent session's delegated children to
 * the browser.
 *
 * A projection is a pure fold over one session's own events, and the child list
 * is not in the log (a plugin may not append its own event types), so the fold
 * reads the mapping store instead. That is sufficient because a delegation
 * always happens inside a parent turn — the parent's `tool/call` and
 * `tool/result` events drive the fold right after the record is written — and
 * the settlement notice is itself a parent event. So the panel refreshes
 * whenever the delegating session does anything, which is exactly when a child
 * can have changed.
 *
 * The wire view is identity-stable for an unchanged list, so a parent event that
 * does not touch the children publishes nothing.
 *
 * The row fields are the caller's: this module owns only the fold's shape and the
 * reference gate, and publishes whatever row list the reader returns. A
 * projection view must be a JSON value, so `view` always answers `{ children }`
 * and never declines with `undefined` — a key holding `undefined` is what makes
 * the Host's session-list summary fail its lossless-JSON check.
 *
 * @module dsh-subagent-templates/lib/projection
 */

/** The Session projection key the client panel reads. */
export const PROJECTION_KEY = 'subagentTemplates'

/** Accepts any JSON state and any JSON wire value; this plugin validates at its own edges. */
const PASSTHROUGH = { parse: (value) => value }

/**
 * Build the projection that publishes a parent's delegated children.
 * @param childrenOf - reads one session's children as wire rows, in render order.
 * @returns the projection definition to register.
 */
export function childrenProjection(childrenOf) {
  // One cached wire value per session: an unchanged list must hand back the
  // same reference so the registry suppresses publication.
  const cache = new Map()
  return {
    key: PROJECTION_KEY,
    stateVersion: 1,
    stateSchema: PASSTHROUGH,
    init: (header) => ({ sessionId: header.id }),
    // The fold's own state carries no information; recomputing the view is the
    // point, and the view's reference gate decides whether anything publishes.
    apply: (state) => ({ ...state }),
    wire: {
      viewSchema: PASSTHROUGH,
      view(state) {
        const children = childrenOf(state.sessionId)
        const cached = cache.get(state.sessionId)
        if (cached !== undefined && sameChildren(cached.children, children)) return cached
        const value = { children }
        cache.set(state.sessionId, value)
        return value
      },
    },
  }
}

/**
 * Whether two child lists carry the same facts in the same order.
 * @param a - the previously published children.
 * @param b - the children read now.
 * @returns whether the wire value is unchanged.
 */
function sameChildren(a, b) {
  if (a.length !== b.length) return false
  return a.every((row, index) => {
    const other = b[index]
    return row.childSessionId === other.childSessionId
      && row.name === other.name
      && row.templateName === other.templateName
      && row.createdAt === other.createdAt
  })
}
