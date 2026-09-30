/**
 * Configuration normalization for `dsh-subagent-templates`.
 *
 * {@link Config} is the row's schema: schemastery, because the Cordis Loader
 * validates the row with it, the Settings surface renders a form from it, and the
 * marker that makes a field editable live is schemastery's `.volatile()`.
 * {@link normalizeConfig} stays the runtime contract — the invariants a schema
 * cannot state, such as unique template ids and a well-formed `toolFilter` — and
 * runs on the value the Loader parsed, so a hand-edited defect still fails loud.
 *
 * @module dsh-subagent-templates/lib/config
 */

import z from '@deepseek-ai/schemastery'

/** Fields one template may declare; any other key is refused. */
const TEMPLATE_FIELDS = Object.freeze([
  'id',
  'name',
  'description',
  'provider',
  'model',
  'pool',
  'reasoningEffort',
  'maxTokens',
  'preset',
  'persona',
  'toolFilter',
])

/** Fields the top-level configuration may declare. */
const CONFIG_FIELDS = Object.freeze(['toolName', 'maxDepth', 'maxActiveSubagents', 'templates'])

/** Template id grammar: the value a model passes as the `template` argument. */
const TEMPLATE_ID = /^[a-z0-9][a-z0-9-]*$/

/** The default model-facing tool name. */
export const DEFAULT_TOOL_NAME = 'subagent'

/** Default cap on how deep delegation nests; the Harness's own subagent default. */
export const DEFAULT_MAX_DEPTH = 1

/** Default cap on how many children one Session keeps alive at once. */
export const DEFAULT_MAX_ACTIVE_SUBAGENTS = 4

/** Thrown when configuration cannot be normalized; carries one issue per problem. */
export class ConfigError extends Error {
  /**
   * @param issues - every configuration problem found, as a message or an issue record.
   */
  constructor(issues) {
    super(`subagent-templates: invalid configuration:\n${issues.map(issue => `  - ${issue.message ?? issue}`).join('\n')}`)
    this.name = 'ConfigError'
    this.issues = issues
  }
}

/** Whether a value is a non-empty string. */
function filledString(value) {
  return typeof value === 'string' && value.trim().length > 0
}

/**
 * Validate one template's tool restriction.
 * @param value - the declared `toolFilter`.
 * @param path - issue path prefix for messages.
 * @param issues - collector for reported problems.
 * @returns the normalized restriction, or undefined when it is unusable.
 */
function normalizeToolFilter(value, path, issues) {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    issues.push(`${path} must be an object with \`allow\` and/or \`deny\``)
    return undefined
  }
  const normalized = {}
  for (const key of Object.keys(value)) {
    if (key !== 'allow' && key !== 'deny') {
      issues.push(`${path} has unknown field "${key}"`)
      continue
    }
    const names = value[key]
    if (!Array.isArray(names) || names.some(name => !filledString(name))) {
      issues.push(`${path}.${key} must be an array of non-empty tool names`)
      continue
    }
    normalized[key] = [...names]
  }
  if (normalized.allow === undefined && normalized.deny === undefined) {
    issues.push(`${path} must name \`allow\` and/or \`deny\``)
    return undefined
  }
  return normalized
}

/**
 * Validate one template declaration.
 *
 * A template fixes one route, or names a pool to resolve one from per child:
 * exactly one of the two, never both. `provider` and `model` are a single fixed
 * route, and `pool` names an ordered list of interchangeable routes owned by
 * `dsh-llm-quota-retry`, resolved when a child is created so each child starts
 * on a route that has allowance.
 *
 * @param raw - the declared template.
 * @param index - its position, for issue messages.
 * @param issues - collector for reported problems.
 * @returns the normalized template, or undefined when it is unusable.
 */
function normalizeTemplate(raw, index, issues) {
  const path = `templates[${index}]`
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    issues.push(`${path} must be an object`)
    return undefined
  }
  for (const key of Object.keys(raw)) {
    if (!TEMPLATE_FIELDS.includes(key)) {
      issues.push(`${path} has unknown field "${key}" (known fields: ${TEMPLATE_FIELDS.join(', ')})`)
    }
  }
  const template = {}
  for (const key of ['id', 'name', 'description']) {
    if (!filledString(raw[key])) {
      issues.push(`${path}.${key} must be a non-empty string`)
      return undefined
    }
    template[key] = raw[key]
  }
  if (!TEMPLATE_ID.test(template.id)) {
    issues.push(`${path}.id "${template.id}" must be lowercase letters, digits, and hyphens`)
  }
  const label = `${path} (${template.id})`
  const hasPool = raw.pool !== undefined
  const hasRoute = raw.provider !== undefined || raw.model !== undefined
  if (hasPool && hasRoute) {
    issues.push(`${label} declares both \`pool\` and \`provider\`/\`model\`; a template fixes exactly one route, so keep one of them`)
    return undefined
  }
  if (!hasPool && !hasRoute) {
    issues.push(`${label} declares neither a \`pool\` nor a \`provider\`/\`model\` route`)
    return undefined
  }
  if (hasPool) {
    if (!filledString(raw.pool)) issues.push(`${label}.pool must be a non-empty string`)
    else template.pool = raw.pool
  } else {
    for (const key of ['provider', 'model']) {
      if (!filledString(raw[key])) {
        issues.push(`${label}.${key} must be a non-empty string, or name a \`pool\` instead`)
        return undefined
      }
      template[key] = raw[key]
    }
  }
  for (const key of ['reasoningEffort', 'preset', 'persona']) {
    if (raw[key] === undefined) continue
    if (!filledString(raw[key])) {
      issues.push(`${label}.${key} must be a non-empty string`)
      continue
    }
    template[key] = raw[key]
  }
  if (raw.maxTokens !== undefined) {
    if (!Number.isSafeInteger(raw.maxTokens) || raw.maxTokens < 1) {
      issues.push(`${label}.maxTokens must be a positive safe integer`)
    } else {
      template.maxTokens = raw.maxTokens
    }
  }
  if (raw.toolFilter !== undefined) {
    const toolFilter = normalizeToolFilter(raw.toolFilter, `${label}.toolFilter`, issues)
    if (toolFilter !== undefined) template.toolFilter = Object.freeze(toolFilter)
  }
  return Object.freeze(template)
}

/**
 * Validate one raw configuration value and report every defect.
 * @param raw - the row's configuration, absent when the row declares none.
 * @returns either the normalized configuration or every issue found.
 */
function validate(raw) {
  if (raw === undefined || raw === null) {
    return { issues: [{ message: 'configuration requires `templates`' }] }
  }
  if (typeof raw !== 'object' || Array.isArray(raw)) {
    return { issues: [{ message: 'configuration must be an object' }] }
  }
  const issues = []
  for (const key of Object.keys(raw)) {
    if (!CONFIG_FIELDS.includes(key)) {
      issues.push({ message: `unknown configuration field "${key}" (known fields: ${CONFIG_FIELDS.join(', ')})`, path: [key] })
    }
  }
  const value = {
    toolName: DEFAULT_TOOL_NAME,
    maxDepth: DEFAULT_MAX_DEPTH,
    maxActiveSubagents: DEFAULT_MAX_ACTIVE_SUBAGENTS,
  }
  if (raw.toolName !== undefined) {
    if (!filledString(raw.toolName)) issues.push({ message: 'toolName must be a non-empty string', path: ['toolName'] })
    else value.toolName = raw.toolName
  }
  if (raw.maxDepth !== undefined) {
    const depth = raw.maxDepth
    if (depth === 'provider-managed') value.maxDepth = depth
    else if (Number.isSafeInteger(depth) && depth >= 0 && !Object.is(depth, -0)) value.maxDepth = depth
    else issues.push({ message: 'maxDepth must be a non-negative safe integer or "provider-managed"', path: ['maxDepth'] })
  }
  if (raw.maxActiveSubagents !== undefined) {
    const capacity = raw.maxActiveSubagents
    if (Number.isSafeInteger(capacity) && capacity >= 1) value.maxActiveSubagents = capacity
    else issues.push({ message: 'maxActiveSubagents must be a positive safe integer', path: ['maxActiveSubagents'] })
  }
  if (!Array.isArray(raw.templates) || raw.templates.length === 0) {
    issues.push({ message: 'templates must be a non-empty array', path: ['templates'] })
    return issues.length === 0 ? { value: Object.freeze(value) } : { issues }
  }
  const templates = []
  const seen = new Set()
  for (const [index, declared] of raw.templates.entries()) {
    const template = normalizeTemplate(declared, index, issues)
    if (template === undefined) continue
    if (seen.has(template.id)) {
      issues.push({ message: `duplicate template id "${template.id}"`, path: ['templates', index, 'id'] })
      continue
    }
    seen.add(template.id)
    templates.push(template)
  }
  value.templates = Object.freeze(templates)
  return issues.length === 0 ? { value: Object.freeze(value) } : { issues }
}

/**
 * Replace every volatile field's box with the value it currently holds.
 *
 * The Loader parses a `.volatile()` field into a reference it updates in place, so
 * a live row's configuration is reachable only through that reference's `get`.
 * Every other value is plain JSON, and no JSON-shaped configuration value has a
 * `get` method, so the box is recognised by that alone — which keeps this module
 * free of a second import.
 *
 * @param value - the row configuration the Loader parsed.
 * @returns a detached plain value with no references left in it.
 */
export function plainConfig(value) {
  if (value !== null && typeof value === 'object' && typeof value.get === 'function') return plainConfig(value.get())
  if (Array.isArray(value)) return value.map(plainConfig)
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([key, child]) => [key, plainConfig(child)]))
  }
  return value
}

/**
 * Normalize one row's configuration, failing loud on any defect.
 * @param raw - the row's configuration, absent when the row declares none.
 * @returns the frozen normalized configuration.
 * @throws {ConfigError} when a field is unknown or out of range.
 */
export function normalizeConfig(raw) {
  const result = validate(plainConfig(raw))
  if (result.issues !== undefined) throw new ConfigError(result.issues)
  return result.value
}

/** One template's tool restriction, as a row declares it. */
const toolFilterSchema = z.object({
  allow: z.array(z.string()).description('Tool names the child may use, on top of the rest of its tool set'),
  deny: z.array(z.string()).description('Tool names the child may not use'),
})

/** The fields every template declares, whichever route it fixes. */
const templateFields = {
  id: z.string().required().description('Lowercase letters, digits, and hyphens: the `template` argument a model passes'),
  name: z.string().required().description('Display name'),
  description: z.string().required().description('When to pick this template, in the model\'s own vocabulary'),
  preset: z.string().description('Agent preset the child joins; the deployment default when absent'),
  reasoningEffort: z.string().description('The child\'s starting thinking effort'),
  maxTokens: z.number().step(1).min(1).description('Upper bound on one response'),
  persona: z.string().description('The child\'s own persona prefix'),
  toolFilter: toolFilterSchema.description('The child\'s narrowed tool set'),
}

/**
 * A template that fixes one route. `pool: z.never()` is what makes the choice
 * exclusive: a template declaring both a route and a pool matches neither branch,
 * so the Settings surface refuses the edit instead of storing it.
 */
const fixedRouteTemplate = z.object({
  ...templateFields,
  provider: z.string().required().description('A registered LLM provider id'),
  model: z.string().required().description('A model that provider serves'),
  pool: z.never(),
})

/** A template that resolves its route from a pool when each child is created. */
const pooledTemplate = z.object({
  ...templateFields,
  pool: z.string().required().description('A route pool owned by dsh-llm-quota-retry'),
  provider: z.never(),
  model: z.never(),
})

/**
 * The row's schema.
 *
 * `.volatile()` marks the fields the Settings surface may edit on a running row:
 * their change is committed into this configuration in place and announced as
 * `loader/volatile-update`, instead of restarting the row. `toolName` is
 * deliberately not volatile — the tool a model is calling cannot be renamed out
 * from under it — so it is absent from the editable form and needs a restart.
 */
export const Config = z.object({
  toolName: z.string().default(DEFAULT_TOOL_NAME)
    .description('The model-facing tool name (not editable live: a rename needs a restart)'),
  maxDepth: z.number().step(1).min(0).default(DEFAULT_MAX_DEPTH).volatile()
    .description('How deep delegation may nest from this session'),
  maxActiveSubagents: z.number().step(1).min(1).default(DEFAULT_MAX_ACTIVE_SUBAGENTS).volatile()
    .description('How many children one session may keep working at once'),
  templates: z.array(z.union([fixedRouteTemplate, pooledTemplate])).required().volatile()
    .description('The templates a delegation may name, in the order a model reads them'),
})
