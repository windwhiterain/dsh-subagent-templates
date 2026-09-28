/**
 * Configuration normalization for `dsh-subagent-templates`.
 *
 * Every template is validated at activation: a delegation that names a template
 * the plugin could not compose fails when the row loads, not when a model calls
 * it. {@link Config} adapts {@link normalizeConfig} to the Standard Schema
 * contract the Cordis Loader validates plugin config with.
 *
 * @module dsh-subagent-templates/lib/config
 */

/** Fields one template may declare; any other key is refused. */
const TEMPLATE_FIELDS = Object.freeze([
  'id',
  'name',
  'description',
  'provider',
  'model',
  'reasoningEffort',
  'maxTokens',
  'preset',
  'persona',
  'toolFilter',
])

/** Fields the top-level configuration may declare. */
const CONFIG_FIELDS = Object.freeze(['toolName', 'maxDepth', 'templates'])

/** Template id grammar: the value a model passes as the `template` argument. */
const TEMPLATE_ID = /^[a-z0-9][a-z0-9-]*$/

/** The default model-facing tool name. */
export const DEFAULT_TOOL_NAME = 'subagent'

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
  for (const key of ['id', 'name', 'description', 'provider', 'model']) {
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
  const value = { toolName: DEFAULT_TOOL_NAME }
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
 * Normalize one row's configuration, failing loud on any defect.
 * @param raw - the row's configuration, absent when the row declares none.
 * @returns the frozen normalized configuration.
 * @throws {ConfigError} when a field is unknown or out of range.
 */
export function normalizeConfig(raw) {
  const result = validate(raw)
  if (result.issues !== undefined) throw new ConfigError(result.issues)
  return result.value
}

/** Standard Schema adapter over {@link normalizeConfig}, consumed by the Loader through `Config['~standard'].validate`. */
export const Config = Object.freeze({
  '~standard': Object.freeze({
    version: 1,
    vendor: 'dsh-subagent-templates',
    validate,
  }),
})
