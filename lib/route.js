/**
 * Resolving a template's route at delegation time.
 *
 * A template fixes either one route (`provider` + `model`) or the **name of a
 * pool** owned by `dsh-llm-quota-retry` — an ordered list of interchangeable
 * routes. A pool is resolved for every child, right before that child exists, so
 * a template that names one starts each subagent on a route with allowance
 * instead of on a route chosen when the row activated.
 *
 * The pool's owner is a separate plugin, so nothing here is assumed to be
 * present: a template that names a pool without the service mounted, or names a
 * pool the service does not define, fails the delegation with a message naming
 * the template and the pool. A child that silently fell back to the deployment's
 * default model would be a delegation whose route nobody chose.
 *
 * @module dsh-subagent-templates/lib/route
 */

/**
 * Resolve one template into the route its child starts on.
 * @param ctx - the plugin context, for the route-pool service.
 * @param template - the normalized template.
 * @returns the template itself for a fixed route, or a copy carrying the route
 *   the pool chose.
 * @throws when the template names a pool this deployment cannot resolve.
 */
export async function resolveTemplateRoute(ctx, template) {
  if (template.pool === undefined) return template
  const service = ctx.get('llmQuotaRetry')
  if (service === undefined || typeof service.pickRoute !== 'function') {
    throw new Error(
      `subagent-templates: template "${template.id}" names route pool "${template.pool}", but no route-pool `
      + 'service is mounted: install and enable dsh-llm-quota-retry, or give the template a provider and model',
    )
  }
  const route = await service.pickRoute(template.pool)
  if (route === undefined) {
    throw new Error(
      `subagent-templates: template "${template.id}" names route pool "${template.pool}", `
      + 'which the route-pool service does not define',
    )
  }
  return {
    ...template,
    provider: route.provider,
    model: route.model,
    // The pool's route may bring its own starting effort; the template's own
    // value stays the fallback for a route that declares none.
    ...route.reasoningEffort === undefined ? {} : { reasoningEffort: route.reasoningEffort },
  }
}

/**
 * Put one new child under its template's pool.
 *
 * The route was resolved from that pool a moment earlier, so this only records
 * which pool governs the child — the same durable per-Session setting the
 * `/quota-pool` command and the composer chip write, so a failover after a host
 * restart still knows where the child may move to. It is best-effort: a pool the
 * service no longer defines still leaves a working child, whose route inference
 * covers it.
 *
 * @param ctx - the plugin context, for the route-pool service.
 * @param session - the child Session that was just created.
 * @param template - the template the child was created from.
 */
export function assignTemplatePool(ctx, session, template) {
  if (template.pool === undefined) return
  const service = ctx.get('llmQuotaRetry')
  if (typeof service?.setPool !== 'function') return
  if (service.setPool(session, template.pool) === true) return
  ctx.logger?.warn?.(
    `subagent-templates: template "${template.id}" names route pool "${template.pool}", `
    + 'which the route-pool service does not define; the child keeps the route it was started on',
  )
}
