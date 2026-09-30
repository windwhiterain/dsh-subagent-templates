/**
 * Browser half: one right-Sidebar tab type listing the subagent sessions this
 * session delegated, and the deployment's settings page for this plugin's own
 * Loader row.
 *
 * The Host publishes a parent's children through the `subagentTemplates` Session
 * projection, so the panel reads template facts from `useProjection` and session
 * facts from the standard kit — it never talks to the plugin's storage domain,
 * and it holds no subscription of its own. Everything it draws is either owner
 * data from the framework, a callback this plugin's `apply` injected, or the
 * copy in this file.
 *
 * A delegated child is an ordinary root Session, so "open" is the shipped
 * workspace navigation and "delete" is the shipped archive-with-stop: the panel
 * adds no session lifecycle of its own, and a child the user removes here is
 * simply gone from the list.
 *
 * The settings page is a deployment page, not a session page: it stages the
 * template list and the two deployment limits over the shared configuration form
 * for this plugin's row, and writes them as whole values through that form. It
 * registers into the Plugins surface only while the Host serves the row's
 * namespace, so it can never offer a field the Host would refuse — and the
 * settings surface is injected rather than required, because this bundle is a
 * panel that also ships a page: a shell without that client half keeps the panel
 * and is offered no page at all.
 *
 * This file is served as one classic script, so it imports nothing: React, Cordis,
 * and the shared primitives arrive through the `require` the module system hands
 * the factory. It therefore carries its own stylesheet, built from the same
 * `--dsw-*` tokens the rest of the client uses.
 */

window.__ModuleLoader__.load({
  id: 'dsh-subagent-templates',
  factory(require) {
    const React = require('react')
    const { createElement: h, useCallback, useMemo, useState } = React
    const { createSnapshotStore } = require('@deepseek-ai/dsh-client-store')
    const {
      Button, Input, SegmentedControl, StateDot, Tag, Toast, Tooltip,
    } = require('@deepseek-ai/dsh-client-ui-primitives')

    /** The tab type's discriminator, and the page address the registry records. */
    const KIND = 'subagent-templates'
    /** This implementation's identity, and the key the tab body registers under. */
    const ID = 'dsh-subagent-templates/panel'
    /** The Host projection key carrying a parent's delegated children. */
    const PROJECTION_KEY = 'subagentTemplates'
    /** This plugin's copy namespace. */
    const NS = 'subagentTemplates'
    /** The settings page's copy namespace. */
    const SETTINGS_NS = 'settings.subagentTemplates'
    /**
     * The Loader row id this plugin's configuration is served under, which is
     * also the settings namespace the page edits.
     */
    const SETTINGS_NAMESPACE = 'subagent-templates'
    /** The settings page's address in the Plugins surface, and its place among that surface's items. */
    const SETTINGS_PAGE_ID = 'subagent-templates'
    const SETTINGS_PAGE_ORDER = 20
    /** The two route modes a template chooses between; the Host schema refuses both at once. */
    const ROUTE_FIXED = 'fixed'
    const ROUTE_POOL = 'pool'
    /** A template row's text drafts, in the order the page draws them. */
    const TEMPLATE_TEXT_FIELDS = [
      'id', 'name', 'description', 'provider', 'model', 'pool',
      'preset', 'reasoningEffort', 'maxTokens', 'persona', 'toolFilter',
    ]
    /**
     * The deployment-level numbers the page edits, with the smallest value each
     * accepts and the copy that names it.
     */
    const SETTINGS_LIMITS = [
      { field: 'maxDepth', minimum: 0, labelKey: 'limit.maxDepth', hintKey: 'limit.maxDepthHint' },
      {
        field: 'maxActiveSubagents',
        minimum: 1,
        labelKey: 'limit.maxActiveSubagents',
        hintKey: 'limit.maxActiveSubagentsHint',
      },
    ]
    /** Shared empty row list, so an absent projection allocates nothing per render. */
    const NO_CHILDREN = []

    /** Panel copy; both dictionaries carry exactly the same key set. */
    const zh = {
      'tab.title': '子智能体',
      'guide.title': '子智能体',
      'guide.description': '查看这个会话派出的子智能体，打开或停止它们。',
      'loading': '正在读取会话列表…',
      'empty.title': '这个会话还没有派出过子智能体。',
      'empty.body': '让这个会话用 subagent 工具委派一个任务，它就会出现在这里。',
      'row.open': '打开子智能体会话 {name}',
      'row.delete': '停止并删除 {name}。会话会从列表移除，日志保留。',
      'row.deleteConfirm': '停止并删除 {name}？会话会从列表移除，日志保留。',
      'row.deleteYes': '删除',
      'row.keep': '保留',
      'row.deleting': '正在停止…',
      'row.failed': '删除失败：{reason}',
      'status.running': '进行中',
      'status.done': '已结束',
      'status.unknown': '状态未知',
    }

    /** English copy. */
    const en = {
      'tab.title': 'Subagents',
      'guide.title': 'Subagents',
      'guide.description': 'The subagent sessions this session delegated. Open or stop them.',
      'loading': 'Reading the session list…',
      'empty.title': 'This session has not delegated anything yet.',
      'empty.body': 'Ask this session to delegate a task with the subagent tool, and it will appear here.',
      'row.open': 'Open the subagent session {name}',
      'row.delete': 'Stop and delete {name}. Its session leaves the list; the log is kept.',
      'row.deleteConfirm': 'Stop and delete {name}? Its session leaves the list; the log is kept.',
      'row.deleteYes': 'Delete',
      'row.keep': 'Keep',
      'row.deleting': 'Stopping…',
      'row.failed': 'Could not delete: {reason}',
      'status.running': 'Running',
      'status.done': 'Finished',
      'status.unknown': 'Status unknown',
    }

    /** Settings page copy; both dictionaries carry exactly the same key set. */
    const zhSettings = {
      'page.title': '子智能体模板',
      'page.description': '父智能体按名字选择的模板：每个模板固定一条路线（或一个解析出路线的池）、一个 agent preset，以及可选的 persona。',
      'page.summary': '编辑派出子智能体时使用的模板。',
      'page.loading': '正在读取配置，读取完成后才能编辑。',
      'page.locked': '这份配置由 home patch 或命令行覆盖持有，浏览器只能读取。',
      'save': '保存',
      'saving': '正在保存…',
      'saved': '已保存',
      'discard': '放弃修改',
      'restore': '恢复出厂默认',
      'failure.refused': '服务器拒绝了这次保存，已重新读取配置；草稿保留。',
      'failure.error': '保存失败：{reason}',
      'limits.title': '部署限制',
      'limit.maxDepth': '最大嵌套深度',
      'limit.maxDepthHint': '子智能体最多可以再往下委派几层；0 表示子智能体不能再委派。',
      'limit.maxActiveSubagents': '最多同时运行',
      'limit.maxActiveSubagentsHint': '一个会话最多同时有多少个子智能体在工作。',
      'invalid.number': '请输入不小于 {minimum} 的整数。',
      'invalid.integer': '请输入整数。',
      'invalid.id': 'id 不能为空。',
      'invalid.toolFilter': 'JSON 无效：{reason}',
      'invalid.toolFilterObject': '工具过滤必须是一个 JSON 对象，例如 {"deny":["write"]}。',
      'invalid.toolFilterEmpty': '请至少指定一个工具名（allow 或 deny）。',
      'invalid.toolFilterEntry': '工具名不能为空。',
      'invalid.toolFilterKey': '工具过滤只支持 allow 和 deny。',
      'overridden': '已覆盖',
      'reset': '恢复出厂值',
      'resetField': '把这一项恢复为出厂值',
      'resetRow': '把这个模板恢复为出厂值',
      'templates.title': '模板',
      'templates.empty': '还没有模板。添加一个，父智能体就能按名字选它。',
      'templates.add': '添加模板',
      'template.index': '第 {index} 个模板',
      'template.moveUp': '上移',
      'template.moveDown': '下移',
      'template.remove': '删除',
      'template.route': '路线',
      'template.routeFixed': '固定路线',
      'template.routePool': '路线池',
      'template.id': 'id',
      'template.idHint': '小写字母、数字和连字符；委派时父智能体把它作为 template 传入。',
      'template.name': '名称',
      'template.description': '说明',
      'template.provider': '提供方',
      'template.model': '模型',
      'template.pool': '池名',
      'template.preset': 'agent preset',
      'template.reasoningEffort': '推理强度',
      'template.maxTokens': '最大 token 数',
      'template.persona': 'persona',
      'template.toolFilter': '工具过滤（JSON）',
      'template.toolFilterHint': '例如 {"deny":["write"]}。留空表示保留全部工具；allow 为空则子智能体只剩 ask_parent。',
    }

    /** English copy of the settings page. */
    const enSettings = {
      'page.title': 'Subagent templates',
      'page.description': 'The templates a delegating agent picks by name: each fixes a route (or the pool one is resolved from), an agent preset, and an optional persona.',
      'page.summary': 'Edit the templates a subagent is delegated with.',
      'page.loading': 'Reading the configuration; editing opens once it arrives.',
      'page.locked': 'A home patch or a command-line overlay owns this configuration, so the browser can only read it.',
      'save': 'Save',
      'saving': 'Saving…',
      'saved': 'Saved',
      'discard': 'Discard',
      'restore': 'Restore shipped defaults',
      'failure.refused': 'The host refused this save and has re-read the configuration; your draft is kept.',
      'failure.error': 'Could not save: {reason}',
      'limits.title': 'Deployment limits',
      'limit.maxDepth': 'Maximum nesting depth',
      'limit.maxDepthHint': 'How many more delegation levels a subagent may open. 0 stops a subagent from delegating.',
      'limit.maxActiveSubagents': 'Maximum active subagents',
      'limit.maxActiveSubagentsHint': 'How many subagents one session may have working at once.',
      'invalid.number': 'Enter a whole number of at least {minimum}.',
      'invalid.integer': 'Enter a whole number.',
      'invalid.id': 'An id is required.',
      'invalid.toolFilter': 'Not valid JSON: {reason}',
      'invalid.toolFilterObject': 'The tool filter must be a JSON object, for example {"deny":["write"]}.',
      'invalid.toolFilterEmpty': 'Name at least one tool in allow or deny.',
      'invalid.toolFilterEntry': 'Blank tool names are not allowed.',
      'invalid.toolFilterKey': 'A tool filter takes only allow and deny.',
      'overridden': 'Overridden',
      'reset': 'Restore',
      'resetField': 'Restore this field to the shipped value',
      'resetRow': 'Restore this template to the shipped value',
      'templates.title': 'Templates',
      'templates.empty': 'No templates yet. Add one, and a delegating agent can pick it by name.',
      'templates.add': 'Add template',
      'template.index': 'Template {index}',
      'template.moveUp': 'Move up',
      'template.moveDown': 'Move down',
      'template.remove': 'Remove',
      'template.route': 'Route',
      'template.routeFixed': 'Fixed route',
      'template.routePool': 'Route pool',
      'template.id': 'Id',
      'template.idHint': 'Lowercase letters, digits, and hyphens. This is the name a delegating agent passes as template.',
      'template.name': 'Name',
      'template.description': 'Description',
      'template.provider': 'Provider',
      'template.model': 'Model',
      'template.pool': 'Pool',
      'template.preset': 'Agent preset',
      'template.reasoningEffort': 'Reasoning effort',
      'template.maxTokens': 'Maximum tokens',
      'template.persona': 'Persona',
      'template.toolFilter': 'Tool filter (JSON)',
      'template.toolFilterHint': 'For example {"deny":["write"]}. Blank keeps the whole tool set; an empty allow leaves the child nothing but ask_parent.',
    }

    /**
     * The panel's stylesheet, installed once per page.
     *
     * A served client half is one classic script, so it cannot ship a CSS file the
     * module system would load; the sheet is built from the same design tokens the
     * shipped stylesheets read, so both themes follow it.
     */
    const STYLE_ID = 'subagent-templates-panel-style'
    const CSS = `
.dsst-panel { display: flex; flex-direction: column; gap: 8px; height: 100%; padding: 12px 14px; box-sizing: border-box; overflow-y: auto; }
.dsst-row { display: flex; flex-wrap: wrap; align-items: center; gap: 10px; padding: 8px 10px; border: 0.5px solid var(--dsw-alias-border-l3); border-radius: var(--dsw-radius-lg); }
.dsst-row:hover { background: var(--dsw-alias-interactive-bg-hover); }
.dsst-dot { flex: none; display: flex; align-items: center; }
.dsst-open { flex: 1; min-width: 0; display: flex; flex-direction: column; gap: 2px; padding: 0; border: 0; background: none; color: var(--dsw-alias-label-primary); font: inherit; text-align: left; cursor: pointer; }
.dsst-name { overflow: hidden; font-size: 13px; line-height: 1.4; white-space: nowrap; text-overflow: ellipsis; }
.dsst-meta { overflow: hidden; color: var(--dsw-alias-label-tertiary); font-size: 11px; line-height: 1.4; white-space: nowrap; text-overflow: ellipsis; }
.dsst-tail { flex: none; }
.dsst-confirm { flex-basis: 100%; display: flex; flex-wrap: wrap; align-items: center; gap: 8px; color: var(--dsw-alias-label-secondary); font-size: 12px; line-height: 1.4; }
.dsst-error { flex-basis: 100%; color: var(--dsw-alias-state-error-primary); font-size: 11px; line-height: 1.4; }
.dsst-empty { display: flex; flex-direction: column; gap: 6px; align-items: center; justify-content: center; height: 100%; padding: 0 20px; text-align: center; }
.dsst-empty-title { color: var(--dsw-alias-label-secondary); font-size: 13px; line-height: 1.5; }
.dsst-empty-body { color: var(--dsw-alias-label-tertiary); font-size: 12px; line-height: 1.5; }
.dsst-settings { display: flex; flex-direction: column; gap: 14px; padding: 12px 14px; box-sizing: border-box; }
.dsst-settings-guide { display: flex; flex-direction: column; gap: 4px; }
.dsst-settings-title { color: var(--dsw-alias-label-primary); font-size: 13px; line-height: 1.5; }
.dsst-settings-description { color: var(--dsw-alias-label-tertiary); font-size: 12px; line-height: 1.5; }
.dsst-limits { display: flex; flex-wrap: wrap; gap: 12px; }
.dsst-limits > * { flex: 1 1 220px; min-width: 0; }
.dsst-section { display: flex; flex-direction: column; gap: 8px; }
.dsst-section-title { color: var(--dsw-alias-label-primary); font-size: 13px; line-height: 1.5; }
.dsst-settings-locked { display: flex; align-items: center; gap: 8px; padding: 8px 10px; border: 0.5px solid var(--dsw-alias-border-l3); border-radius: var(--dsw-radius-lg); color: var(--dsw-alias-label-secondary); font-size: 12px; line-height: 1.5; }
.dsst-templates-head { display: flex; align-items: center; gap: 8px; }
.dsst-templates-title { color: var(--dsw-alias-label-primary); font-size: 13px; line-height: 1.5; }
.dsst-templates-empty { color: var(--dsw-alias-label-tertiary); font-size: 12px; line-height: 1.5; }
.dsst-templates { display: flex; flex-direction: column; gap: 10px; }
.dsst-template { display: flex; flex-direction: column; gap: 8px; padding: 10px; border: 0.5px solid var(--dsw-alias-border-l3); border-radius: var(--dsw-radius-lg); }
.dsst-template-head { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; }
.dsst-template-index { color: var(--dsw-alias-label-tertiary); font-size: 11px; line-height: 1.4; }
.dsst-spacer { flex: 1; }
.dsst-fields { display: flex; flex-direction: column; gap: 8px; }
.dsst-field { display: flex; flex-direction: column; gap: 4px; min-width: 0; }
.dsst-field-head { display: flex; align-items: center; gap: 6px; }
.dsst-field-label { flex: 1; color: var(--dsw-alias-label-secondary); font-size: 12px; line-height: 1.4; }
.dsst-field-mark { display: flex; align-items: center; gap: 6px; }
.dsst-field-hint { color: var(--dsw-alias-label-tertiary); font-size: 11px; line-height: 1.4; }
.dsst-field-problem { color: var(--dsw-alias-label-error); font-size: 11px; line-height: 1.4; }
.dsst-textarea { width: 100%; box-sizing: border-box; min-height: 54px; padding: 6px 8px; border: 0.5px solid var(--dsw-alias-border-l3); border-radius: var(--dsw-radius-md); background: var(--dsw-alias-bg-layer-1); color: var(--dsw-alias-label-primary); font: inherit; font-size: 12px; resize: vertical; }
.dsst-route-inputs { display: flex; flex-wrap: wrap; gap: 8px; }
.dsst-route-inputs > * { flex: 1 1 140px; min-width: 0; }
.dsst-settings-actions { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; }
.dsst-settings-failure { display: flex; align-items: center; gap: 8px; color: var(--dsw-alias-label-error); font-size: 12px; line-height: 1.5; }
`

    if (typeof document !== 'undefined' && document.getElementById(STYLE_ID) === null) {
      const style = document.createElement('style')
      style.id = STYLE_ID
      style.textContent = CSS
      document.head.append(style)
    }

    /**
     * A short elapsed-time label for one delegation.
     * @param createdAt - epoch milliseconds the delegation recorded.
     * @returns the age as `45s`, `3m`, `2h`, or `4d`.
     */
    function age(createdAt) {
      if (!Number.isFinite(createdAt) || createdAt <= 0) return undefined
      const seconds = Math.max(0, Math.round((Date.now() - createdAt) / 1000))
      if (seconds < 60) return `${seconds}s`
      if (seconds < 3600) return `${Math.round(seconds / 60)}m`
      if (seconds < 86400) return `${Math.round(seconds / 3600)}h`
      return `${Math.round(seconds / 86400)}d`
    }

    /**
     * One child row: its status, its name as the open control, and the delete
     * action.
     *
     * The confirmation is a second line inside the row rather than a layer over
     * the panel, so the destructive action never covers the list it changes. A
     * row being deleted keeps its place with its controls disabled: the archive
     * is asynchronous, and taking the row out on the clicker's optimism would
     * also throw away the confirmation and the error a refusal produces.
     * @param props - the row's data, the copy seat, and the two injected callbacks.
     * @param props.row - the projection row: child session id, name, template, and time.
     * @param props.running - the child's last known running state, or undefined.
     * @param props.deleting - an archive for this child is in flight.
     * @param props.t - namespace-bound translate.
     * @param props.open - opens the child session in the main view.
     * @param props.remove - stops the child and archives its session.
     * @returns the row element.
     */
    function ChildRow({ row, running, deleting, t, open, remove }) {
      const [confirming, setConfirming] = useState(false)
      const [failure, setFailure] = useState(undefined)
      const state = running === true ? 'ongoing' : running === false ? 'done' : 'idle'
      const statusKey = running === true ? 'status.running' : running === false ? 'status.done' : 'status.unknown'
      const meta = [row.templateName, age(row.createdAt)].filter(part => part !== undefined).join(' · ')

      const confirm = useCallback(() => {
        setFailure(undefined)
        remove(row).catch((reason) => {
          setConfirming(false)
          setFailure(t('row.failed', { reason: String(reason) }))
        })
      }, [remove, row, t])

      const tail = deleting
        ? h('span', { className: 'dsst-meta' }, t('row.deleting'))
        : confirming
          ? h(Button, {
            size: 'sm',
            onClick: () => { setConfirming(false); setFailure(undefined) },
          }, t('row.keep'))
          : h(Button, {
            size: 'sm',
            title: t('row.delete', { name: row.name }),
            onClick: () => { setConfirming(true) },
          }, t('row.deleteYes'))

      return h('div', { className: 'dsst-row' },
        h('span', { className: 'dsst-dot', title: t(statusKey) }, h(StateDot, { state })),
        h('button', {
          type: 'button',
          className: 'dsst-open',
          disabled: deleting,
          title: t('row.open', { name: row.name }),
          onClick: () => { open(row.childSessionId) },
        },
        h('span', { className: 'dsst-name' }, row.name),
        h('span', { className: 'dsst-meta' }, meta)),
        h('span', { className: 'dsst-tail' }, tail),
        confirming
          ? h('div', { className: 'dsst-confirm' },
            h('span', { style: { flex: '1', minWidth: '0' } }, t('row.deleteConfirm', { name: row.name })),
            h(Button, { size: 'sm', variant: 'outline', onClick: confirm }, t('row.deleteYes')))
          : null,
        failure !== undefined ? h('div', { className: 'dsst-error' }, failure) : null)
    }

    /**
     * The tab body: this session's delegated children, or the reason there are none.
     * @param props - the slot framework's standard kit, the copy seat, and this
     *   plugin's injected callbacks.
     * @param props.useProjection - reads the Host's `subagentTemplates` value.
     * @param props.useSessions - the Session catalog projection.
     * @param props.useSessionStatus - per-session running state.
     * @param props.t - namespace-bound translate.
     * @param props.open - opens one child session in the main view.
     * @param props.archive - stops one child and archives its session.
     * @returns the panel element.
     */
    function SubagentPanel({ useProjection, useSessions, useSessionStatus, t, open, archive }) {
      const view = useProjection(PROJECTION_KEY)
      const sessions = useSessions()
      const statuses = useSessionStatus()
      // Which rows have an archive in flight. A child leaves the list when the
      // Session catalog drops it, which is the archive's own consequence and the
      // only signal the panel trusts; a refused archive simply clears here and
      // leaves the row, its question, and its reason where the user is looking.
      const [deleting, setDeleting] = useState(() => new Set())

      const remove = useCallback((row) => {
        setDeleting(current => new Set(current).add(row.childSessionId))
        return archive(row.childSessionId).catch((error) => {
          setDeleting(current => {
            const next = new Set(current)
            next.delete(row.childSessionId)
            return next
          })
          throw error
        })
      }, [archive])

      const rows = view?.children ?? NO_CHILDREN
      const present = useMemo(() => new Set(sessions.ids), [sessions])
      const shown = rows.filter((row) => {
        if (present.has(row.childSessionId)) return true
        // A child the catalog has not listed yet is still live, so it stays: the
        // delegation that created it and the row that announces it are two
        // different streams. A child being deleted gets no such grace, because
        // its absence from the catalog is the archive landing.
        return statuses.get(row.childSessionId)?.running === true && !deleting.has(row.childSessionId)
      })

      if (sessions.phase !== 'ready') {
        return h('div', { className: 'dsst-panel' }, h('div', { className: 'dsst-empty-body' }, t('loading')))
      }
      if (shown.length === 0) {
        return h('div', { className: 'dsst-panel' },
          h('div', { className: 'dsst-empty' },
            h('div', { className: 'dsst-empty-title' }, t('empty.title')),
            h('div', { className: 'dsst-empty-body' }, t('empty.body'))))
      }
      return h('div', { className: 'dsst-panel' },
        shown.map(row => h(ChildRow, {
          key: row.childSessionId,
          row,
          running: statuses.get(row.childSessionId)?.running,
          deleting: deleting.has(row.childSessionId),
          t,
          open,
          remove,
        })))
    }

    /**
     * Whether a stored value is a plain JSON object.
     *
     * The section itself and a row's tool filter are objects; reading an array
     * or a primitive as one would let a malformed section look like the shape
     * this page edits.
     * @param value - the value to test.
     * @returns whether the value is a non-null, non-array object.
     */
    function isRecord(value) {
      return typeof value === 'object' && value !== null && !Array.isArray(value)
    }

    /**
     * Render a stored value as the draft text a control shows.
     * @param value - the stored value.
     * @returns the value as text; the empty string when the section carries none.
     */
    function draftText(value) {
      if (typeof value === 'string') return value
      if (typeof value === 'number' && Number.isFinite(value)) return String(value)
      return ''
    }

    /**
     * Whether two JSON values are equal, which is how a field's shipped value is
     * told from the user layer's.
     * @param left - one value.
     * @param right - the other value.
     * @returns whether the two serialize identically.
     */
    function sameValue(left, right) {
      return JSON.stringify(left) === JSON.stringify(right)
    }

    /**
     * Parse a draft as a whole number.
     * @param text - the draft text.
     * @returns the number, or undefined when the draft is not an integer.
     */
    function parseInteger(text) {
      const trimmed = text.trim()
      if (!/^-?\d+$/.test(trimmed)) return undefined
      const value = Number(trimmed)
      return Number.isSafeInteger(value) ? value : undefined
    }

    /**
     * Parse a draft as a deployment limit.
     * @param text - the draft text.
     * @param minimum - the smallest value the limit accepts.
     * @returns the number, or undefined when the draft is not an integer of at
     *   least the minimum.
     */
    function parseLimit(text, minimum) {
      const value = parseInteger(text)
      return value !== undefined && value >= minimum ? value : undefined
    }

    /** The keys a tool filter may carry, matching the row's own normalizer. */
    const TOOL_FILTER_KEYS = ['allow', 'deny']

    /**
     * Whether one side of a tool filter is a list of tool names.
     *
     * A blank entry is not a tool name, and a side that is not a list at all
     * cannot carry names, so neither is usable: the row refuses both with one
     * issue, "must be an array of non-empty tool names".
     * @param value - one of the filter's `allow` or `deny` entries.
     * @returns whether the value is a list whose every entry is a non-empty string.
     */
    function listsNames(value) {
      return Array.isArray(value) && value.every(name => typeof name === 'string' && name.trim() !== '')
    }

    /**
     * The problem a parsed tool filter carries, if any, told apart by what the
     * user has to fix.
     *
     * The row's normalizer is the authority, and this mirrors its three
     * refusals exactly: a key it does not know, a side that is not a list of
     * non-empty tool names, and a filter carrying neither side at all. A side
     * that is present but empty is NOT refused, because the row accepts it as a
     * deliberate lockout — a child left with no tools but the ones the plugin
     * installs itself — and a page that refused it could not open a
     * hand-written one at all.
     *
     * The unknown key comes first because it is a problem with the object
     * itself, and the malformed side before the absent one because blanking an
     * entry is a different repair from naming a side.
     * @param filter - the parsed filter object.
     * @returns the copy key of the problem, or undefined when the filter is
     *   acceptable.
     */
    function toolFilterShapeProblem(filter) {
      if (Object.keys(filter).some(key => !TOOL_FILTER_KEYS.includes(key))) return { key: 'invalid.toolFilterKey' }
      const present = TOOL_FILTER_KEYS.filter(key => filter[key] !== undefined)
      if (present.some(key => !listsNames(filter[key]))) return { key: 'invalid.toolFilterEntry' }
      return present.length > 0 ? undefined : { key: 'invalid.toolFilterEmpty' }
    }

    /**
     * The problem a tool-filter draft carries, if any. The text is JSON because
     * the field describes a filter object the schema declares, so an array or a
     * bare string is as unusable as a syntax error; a filter the row would
     * refuse — an unknown key, a side that is not a list of non-empty tool
     * names, or neither side at all — is refused here rather than by the Host's
     * read, where it would leave the user looking at a save the row then
     * rejected. A blank field is not one of these problems: it is how a template
     * says the child keeps its whole tool set, and a present but empty side is
     * the row's own lockout, which the page opens and saves as typed.
     * @param text - the draft text.
     * @returns the copy key and its parameters, or undefined when the draft is
     *   acceptable.
     */
    function toolFilterProblem(text) {
      const trimmed = text.trim()
      if (trimmed === '') return undefined
      let parsed
      try {
        parsed = JSON.parse(trimmed)
      } catch (error) {
        return { key: 'invalid.toolFilter', params: { reason: String(error) } }
      }
      if (!isRecord(parsed)) return { key: 'invalid.toolFilterObject' }
      return toolFilterShapeProblem(parsed)
    }

    /**
     * One template row as the editor drafts it: every field is text, and the
     * route mode decides which of `provider`/`model` and `pool` a save writes.
     * @param stored - the stored row, or undefined for a row the user adds.
     * @returns the row's draft.
     */
    function draftRow(stored) {
      const row = isRecord(stored) ? stored : {}
      const pool = draftText(row.pool)
      return {
        id: draftText(row.id),
        name: draftText(row.name),
        description: draftText(row.description),
        route: pool === '' ? ROUTE_FIXED : ROUTE_POOL,
        provider: draftText(row.provider),
        model: draftText(row.model),
        pool,
        preset: draftText(row.preset),
        reasoningEffort: draftText(row.reasoningEffort),
        maxTokens: draftText(row.maxTokens),
        persona: draftText(row.persona),
        toolFilter: row.toolFilter === undefined ? '' : JSON.stringify(row.toolFilter),
      }
    }

    /**
     * The editable section as a draft seeded from the effective values.
     * @param snapshot - the configuration form snapshot to read.
     * @returns the seeded draft.
     */
    function draftFrom(snapshot) {
      const value = isRecord(snapshot.value) ? snapshot.value : {}
      const draft = { templates: [], maxDepth: '', maxActiveSubagents: '' }
      for (const limit of SETTINGS_LIMITS) draft[limit.field] = draftText(value[limit.field])
      if (Array.isArray(value.templates)) draft.templates = value.templates.map(draftRow)
      return draft
    }

    /**
     * Whether two drafts hold the same values, which tells an edit that changed
     * nothing from one a save should write.
     *
     * Both are built by the same constructor when a snapshot is read, so key
     * order is identical and a serialized comparison is exact.
     * @param left - one draft.
     * @param right - the other draft.
     * @returns whether the two drafts are equal.
     */
    function sameDraft(left, right) {
      return JSON.stringify(left) === JSON.stringify(right)
    }

    /**
     * The problems one row draft carries: the save blockers this page reports
     * inline. The Host schema refuses all three as well; refusing them here
     * means the user is told which field it is instead of losing a whole write.
     * @param row - the row draft.
     * @returns a problem per field, undefined when the field is acceptable.
     */
    function rowProblems(row) {
      return {
        id: row.id.trim() === '' ? { key: 'invalid.id' } : undefined,
        maxTokens: row.maxTokens.trim() === '' || parseInteger(row.maxTokens) !== undefined
          ? undefined
          : { key: 'invalid.integer' },
        toolFilter: toolFilterProblem(row.toolFilter),
      }
    }

    /**
     * Whether a row draft holds a problem that blocks the save.
     * @param row - the row draft.
     * @returns whether any of the row's fields blocks the save.
     */
    function rowInvalid(row) {
      const problems = rowProblems(row)
      return problems.id !== undefined || problems.maxTokens !== undefined || problems.toolFilter !== undefined
    }

    /**
     * The value a save writes for one row.
     *
     * Exactly one route representation is written: a pool row carries `pool`
     * and a fixed row carries `provider` and `model`, because the schema refuses
     * a row with both. Blank optional text is omitted rather than written as an
     * empty string, so a field the user cleared reverts to the shipped value.
     * @param row - the row draft.
     * @returns the row's value, or undefined when a draft field blocks the save.
     */
    function rowValue(row) {
      const id = row.id.trim()
      if (id === '') return undefined
      const value = { id, name: row.name.trim() }
      if (row.description.trim() !== '') value.description = row.description.trim()
      if (row.route === ROUTE_POOL) {
        value.pool = row.pool.trim()
      } else {
        value.provider = row.provider.trim()
        value.model = row.model.trim()
      }
      for (const field of ['preset', 'reasoningEffort', 'persona']) {
        if (row[field].trim() !== '') value[field] = row[field].trim()
      }
      if (row.maxTokens.trim() !== '') {
        const maxTokens = parseInteger(row.maxTokens)
        if (maxTokens === undefined) return undefined
        value.maxTokens = maxTokens
      }
      if (toolFilterProblem(row.toolFilter) !== undefined) return undefined
      if (row.toolFilter.trim() !== '') value.toolFilter = JSON.parse(row.toolFilter)
      return value
    }

    /**
     * The write a save performs: one whole-value set for the template list and
     * one for each deployment limit.
     *
     * A template row is not addressable by path, so every field is written as
     * part of the array; and because the array is written whole, a route-mode
     * switch cannot leave the other mode's fields behind for the schema to
     * refuse. All three operations travel in one mutation, so they land on one
     * revision together.
     * @param draft - the drafted section.
     * @returns the operations, or undefined when a draft field blocks the save.
     */
    function plannedOps(draft) {
      const templates = []
      for (const row of draft.templates) {
        const value = rowValue(row)
        if (value === undefined) return undefined
        templates.push(value)
      }
      const ops = [{ op: 'set', path: ['templates'], value: templates }]
      for (const limit of SETTINGS_LIMITS) {
        const value = parseLimit(draft[limit.field], limit.minimum)
        if (value === undefined) return undefined
        ops.push({ op: 'set', path: [limit.field], value })
      }
      return ops
    }

    /**
     * The overridden marks of one row: which of its fields the user layer
     * carries rather than the shipped layer.
     *
     * `templates` is one array field, so the user layer holds the whole list or
     * nothing and a row cannot carry presence of its own. A field therefore
     * counts as overridden when the user layer's row at this index carries it
     * AND its value differs from the shipped row's — presence compared against
     * `user`, never against the effective value, which a staged edit has already
     * moved away from it.
     * @param user - the user layer of the scope snapshot.
     * @param base - the shipped layer of the scope snapshot.
     * @param index - the row's index in the drafted list.
     * @returns a mark per row field, plus `any`.
     */
    function overriddenMarks(user, base, index) {
      const userRow = Array.isArray(user.templates) ? user.templates[index] : undefined
      const baseRow = Array.isArray(base.templates) ? base.templates[index] : undefined
      const marks = { any: false }
      if (!isRecord(userRow)) return marks
      for (const field of TEMPLATE_TEXT_FIELDS) {
        const mark = Object.hasOwn(userRow, field)
          && !sameValue(userRow[field], isRecord(baseRow) ? baseRow[field] : undefined)
        marks[field] = mark
        marks.any = marks.any || mark
      }
      return marks
    }

    /**
     * The staged editor behind the settings page's slot registration.
     *
     * One page owns one form scope — the Loader row's namespace. It keeps the
     * draft, publishes the snapshot store the component reads, and performs the
     * writes. A scope snapshot replaces a draft that carries no staged edit, so
     * the page follows a write landing elsewhere (or its own accepted write); a
     * staged draft survives the re-read, which is what keeps a refused save and
     * its reason in front of the user.
     * @param scope - the shared configuration form for the settings namespace.
     * @returns the page's inject face and the disposer ending its subscription.
     */
    function createSettingsPage(scope) {
      let draft
      let baselineRevision
      let staged = false
      let saving = false
      let failure
      let saved = 0

      /**
       * The draft, seeded from the current snapshot on first read.
       * @returns the current draft.
       */
      function currentDraft() {
        if (draft === undefined) reseed()
        return draft
      }

      /** Rebuild the draft from what the scope last accepted, and remember its revision. */
      function reseed() {
        const snapshot = scope.getSnapshot()
        draft = draftFrom(snapshot)
        baselineRevision = snapshot.revision
        staged = false
      }

      /**
       * The page's whole published state, rebuilt from the scope and the draft.
       * @returns the state the component renders.
       */
      function project() {
        const snapshot = scope.getSnapshot()
        const pending = currentDraft()
        const user = isRecord(snapshot.user) ? snapshot.user : {}
        const base = isRecord(snapshot.base) ? snapshot.base : {}
        const templates = pending.templates.map((row, index) => ({
          ...row,
          overridden: overriddenMarks(user, base, index),
          problems: rowProblems(row),
        }))
        const limits = SETTINGS_LIMITS.map((limit) => {
          const value = parseLimit(pending[limit.field], limit.minimum)
          return {
            field: limit.field,
            minimum: limit.minimum,
            labelKey: limit.labelKey,
            hintKey: limit.hintKey,
            text: pending[limit.field],
            invalid: value === undefined,
            overridden: Object.hasOwn(user, limit.field),
          }
        })
        return {
          status: snapshot.status,
          writable: snapshot.writable === true,
          saving,
          failure,
          saved,
          edited: staged && !sameDraft(pending, draftFrom(snapshot)),
          invalid: templates.some(row => rowInvalid(row)) || limits.some(limit => limit.invalid),
          templatesOverridden: Object.hasOwn(user, 'templates'),
          templates,
          limits,
        }
      }

      const store = createSnapshotStore(project())

      /** Publish the current state to the page's store. */
      function publish() {
        store.set(project())
      }

      const unsubscribe = scope.subscribe(() => {
        // A draft holding no staged edit is replaced by what the scope re-read,
        // which is how a write landing elsewhere — or this page's own accepted
        // write — becomes what the user sees. A draft with a staged edit
        // survives the re-read, which is what keeps a refused save in front of
        // the user instead of hiding it under the Host's own values.
        if (!staged) reseed()
        publish()
      })

      /** Stage a change: the next save writes it, and the last refusal no longer applies. */
      function stage() {
        staged = true
        failure = undefined
        publish()
      }

      /**
       * Stage one row's text field.
       * @param index - the row's index.
       * @param field - the row field to stage.
       * @param text - the draft text.
       */
      function editTemplate(index, field, text) {
        const row = currentDraft().templates[index]
        if (row === undefined || !TEMPLATE_TEXT_FIELDS.includes(field)) return
        row[field] = text
        stage()
      }

      /**
       * Stage one deployment limit's draft text.
       * @param field - the limit's field name.
       * @param text - the draft text.
       */
      function editLimit(field, text) {
        if (!SETTINGS_LIMITS.some(limit => limit.field === field)) return
        currentDraft()[field] = text
        stage()
      }

      /**
       * Stage a row's route mode. Only the chosen mode's inputs are written, so
       * switching does not have to clear the other side by hand.
       * @param index - the row's index.
       * @param mode - the chosen mode, `fixed` or `pool`.
       */
      function setRouteMode(index, mode) {
        const row = currentDraft().templates[index]
        if (row === undefined || (mode !== ROUTE_FIXED && mode !== ROUTE_POOL)) return
        row.route = mode
        stage()
      }

      /** Stage a blank template row at the end of the list. */
      function addTemplate() {
        currentDraft().templates.push(draftRow(undefined))
        stage()
      }

      /**
       * Stage the removal of one template row.
       * @param index - the row's index.
       */
      function removeTemplate(index) {
        const templates = currentDraft().templates
        if (!Number.isInteger(index) || index < 0 || index >= templates.length) return
        templates.splice(index, 1)
        stage()
      }

      /**
       * Stage a template row one place up or down. The declared order is the
       * order the delegating model sees, so the page moves rows rather than
       * renumbering them.
       * @param index - the row's current index.
       * @param step - how many places to move it, negative for toward the front.
       */
      function moveTemplate(index, step) {
        const templates = currentDraft().templates
        const target = index + step
        if (!Number.isInteger(index) || !Number.isInteger(step)) return
        if (index < 0 || index >= templates.length || target < 0 || target >= templates.length) return
        const [row] = templates.splice(index, 1)
        templates.splice(target, 0, row)
        stage()
      }

      /**
       * The shipped row at one index, as a draft to restore from.
       * @param index - the row's index.
       * @returns the shipped row's draft, blank when the shipped layer has no
       *   row at that index.
       */
      function shippedRow(index) {
        const snapshot = scope.getSnapshot()
        const base = isRecord(snapshot.base) ? snapshot.base : {}
        return draftRow(Array.isArray(base.templates) ? base.templates[index] : undefined)
      }

      /**
       * Stage one row field back to its shipped value. The route fields are one
       * value in the schema, so restoring any of them restores the whole route.
       * @param index - the row's index.
       * @param field - the row field to restore.
       */
      function resetTemplateField(index, field) {
        const row = currentDraft().templates[index]
        if (row === undefined) return
        const shipped = shippedRow(index)
        if (field === 'route') {
          row.route = shipped.route
          row.provider = shipped.provider
          row.model = shipped.model
          row.pool = shipped.pool
        } else if (TEMPLATE_TEXT_FIELDS.includes(field)) {
          row[field] = shipped[field]
        } else return
        stage()
      }

      /**
       * Stage every field of one row back to its shipped value.
       * @param index - the row's index.
       */
      function resetTemplateRow(index) {
        const row = currentDraft().templates[index]
        if (row === undefined) return
        Object.assign(row, shippedRow(index))
        stage()
      }

      /**
       * Clear one deployment limit's user-layer override immediately, which is
       * the only write that truly reverts a number: a whole-value save would
       * store the value it wrote as the user's own.
       * @param field - the limit's field name.
       */
      function resetLimit(field) {
        if (!SETTINGS_LIMITS.some(limit => limit.field === field)) return
        void clearOverride(field)
      }

      /**
       * Write one field clear and re-seed that field from what the Host kept.
       * Every other staged edit survives the re-read.
       * @param field - the field to clear.
       */
      async function clearOverride(field) {
        failure = undefined
        publish()
        try {
          const landed = await scope.unset(field)
          if (!landed) {
            failure = { key: 'failure.refused' }
            publish()
            return
          }
          const seeded = draftFrom(scope.getSnapshot())
          if (draft === undefined) draft = seeded
          else draft[field] = seeded[field]
          publish()
        } catch (error) {
          failure = { key: 'failure.error', params: { reason: String(error) } }
          publish()
        }
      }

      /** Drop every staged edit and re-seed from the last accepted snapshot. */
      function discard() {
        reseed()
        failure = undefined
        publish()
      }

      /**
       * Write every edited field in one revision-fenced mutation.
       *
       * A refusal keeps the draft: the scope has already re-read, and throwing
       * the user's edits away would hide what the Host objected to. An invalid
       * draft performs no write at all.
       */
      async function save() {
        const snapshot = scope.getSnapshot()
        if (saving || snapshot.writable !== true || snapshot.status !== 'ready') return
        const ops = plannedOps(currentDraft())
        if (ops === undefined) return
        saving = true
        failure = undefined
        publish()
        let landed = false
        try {
          landed = await scope.mutate(ops, baselineRevision)
        } catch (error) {
          saving = false
          failure = { key: 'failure.error', params: { reason: String(error) } }
          publish()
          return
        }
        saving = false
        if (!landed) {
          failure = { key: 'failure.refused' }
          publish()
          return
        }
        saved += 1
        reseed()
        publish()
      }

      /**
       * Clear all three editable fields' user-layer overrides, one write each:
       * the array first, then the limits in the page's own order, so a refusal
       * leaves the earlier clears standing rather than hiding which one failed.
       */
      async function restoreDefaults() {
        const snapshot = scope.getSnapshot()
        if (saving || snapshot.writable !== true || snapshot.status !== 'ready') return
        failure = undefined
        publish()
        try {
          for (const field of ['templates', ...SETTINGS_LIMITS.map(limit => limit.field)]) {
            const landed = await scope.unset(field)
            if (!landed) {
              failure = { key: 'failure.refused' }
              publish()
              return
            }
          }
        } catch (error) {
          failure = { key: 'failure.error', params: { reason: String(error) } }
          publish()
          return
        }
        reseed()
        publish()
      }

      /** Drop the save confirmation banner. */
      function dismissNotice() {
        if (saved === 0) return
        saved = 0
        publish()
      }

      return {
        /**
         * Build the face the page's slot registration injects.
         * @returns the page's snapshot store and its staged actions.
         */
        face() {
          return {
            hooks: { subagentTemplatesPage: store },
            editTemplate,
            editLimit,
            setRouteMode,
            addTemplate,
            removeTemplate,
            moveTemplate,
            resetTemplateField,
            resetTemplateRow,
            resetLimit,
            save: () => { void save() },
            discard,
            restoreDefaults: () => { void restoreDefaults() },
            dismissNotice,
          }
        },
        /** Release the scope subscription the page holds. */
        dispose() {
          unsubscribe()
        },
      }
    }

    /**
     * One labelled control: its label, its override mark and reset, the control
     * itself, its hint, and the problem a save would report inline.
     * @param props - the field's labels, its state, and its control.
     * @param props.t - namespace-bound translate.
     * @param props.id - the control's id, which the label points at.
     * @param props.label - the visible label.
     * @param props.hint - an optional line under the control.
     * @param props.problem - the copy key and parameters of a save blocker.
     * @param props.overridden - whether the user layer carries this field.
     * @param props.resetLabel - the reset control's text.
     * @param props.resetHint - the reset control's tooltip.
     * @param props.disabled - whether the control refuses input.
     * @param props.onReset - clears this field's user-layer override.
     * @param props.children - the control element.
     * @returns the field element.
     */
    function SettingsField(props) {
      const { t, id, label, hint, problem, overridden, resetLabel, resetHint, disabled, onReset, children } = props
      return h('div', { className: 'dsst-field' },
        h('div', { className: 'dsst-field-head' },
          h('label', { className: 'dsst-field-label', htmlFor: id }, label),
          overridden === true
            ? h('span', { className: 'dsst-field-mark' },
              h(Tag, { tone: 'info' }, t('overridden')),
              h(Tooltip, { label: resetHint },
                h(Button, { size: 'sm', disabled, onClick: onReset }, resetLabel)))
            : null),
        children,
        hint !== undefined ? h('div', { className: 'dsst-field-hint' }, hint) : null,
        problem !== undefined ? h('div', { className: 'dsst-field-problem' }, t(problem.key, problem.params)) : null)
    }

    /**
     * One deployment limit, as a number the Host reads.
     * @param props - the limit's published state, the copy seat, and the actions.
     * @param props.limit - the published limit: text, whether it is invalid, and
     *   whether the user layer carries it.
     * @param props.t - namespace-bound translate.
     * @param props.locked - whether the whole editor refuses input.
     * @param props.actions - the page's staged actions.
     * @returns the limit field.
     */
    function LimitField({ limit, t, locked, actions }) {
      const id = `dsst-limit-${limit.field}`
      return h(SettingsField, {
        t,
        id,
        label: t(limit.labelKey),
        hint: t(limit.hintKey),
        disabled: locked,
        overridden: limit.overridden,
        problem: limit.invalid ? { key: 'invalid.number', params: { minimum: limit.minimum } } : undefined,
        resetLabel: t('reset'),
        resetHint: t('resetField'),
        onReset: () => { actions.resetLimit(limit.field) },
        children: h(Input, {
          id,
          value: limit.text,
          disabled: locked,
          inputMode: 'numeric',
          'aria-invalid': limit.invalid,
          onChange: event => { actions.editLimit(limit.field, event.target.value) },
        }),
      })
    }

    /**
     * One template row: its order among the list, its route, and every field the
     * schema declares. Its controls are stateless — the page's draft holds the
     * values — so a move reorders the rows without losing a draft.
     * @param props - the row's published state, its index, the copy seat, and
     *   the page's actions.
     * @param props.row - the published row: draft text, override marks, problems.
     * @param props.index - the row's index in the list.
     * @param props.total - how many rows the list holds.
     * @param props.t - namespace-bound translate.
     * @param props.locked - whether the whole editor refuses input.
     * @param props.actions - the page's staged actions.
     * @returns the template row element.
     */
    function TemplateRow({ row, index, total, t, locked, actions }) {
      const target = name => `dsst-template-${index}-${name}`
      const field = (name, label, hint, control) => h(SettingsField, {
        key: name,
        t,
        id: target(name),
        label,
        hint,
        disabled: locked,
        overridden: row.overridden[name] === true,
        problem: row.problems[name],
        resetLabel: t('reset'),
        resetHint: t('resetField'),
        onReset: () => { actions.resetTemplateField(index, name) },
        children: control(target(name)),
      })
      const text = (name, label, hint) => field(name, label, hint, id => h(Input, {
        id,
        value: row[name],
        disabled: locked,
        'aria-invalid': row.problems[name] !== undefined,
        onChange: event => { actions.editTemplate(index, name, event.target.value) },
      }))
      const area = (name, label) => field(name, label, undefined, id => h('textarea', {
        id,
        className: 'dsst-textarea',
        value: row[name],
        disabled: locked,
        onChange: event => { actions.editTemplate(index, name, event.target.value) },
      }))
      return h('div', { className: 'dsst-template' },
        h('div', { className: 'dsst-template-head' },
          h('span', { className: 'dsst-template-index' }, t('template.index', { index: index + 1 })),
          row.overridden.any === true
            ? h('span', { className: 'dsst-field-mark' },
              h(Tag, { tone: 'info' }, t('overridden')),
              h(Tooltip, { label: t('resetRow') },
                h(Button, { size: 'sm', disabled: locked, onClick: () => { actions.resetTemplateRow(index) } }, t('reset'))))
            : null,
          h('span', { className: 'dsst-spacer' }),
          h(Button, {
            size: 'sm',
            disabled: locked || index === 0,
            onClick: () => { actions.moveTemplate(index, -1) },
          }, t('template.moveUp')),
          h(Button, {
            size: 'sm',
            disabled: locked || index === total - 1,
            onClick: () => { actions.moveTemplate(index, 1) },
          }, t('template.moveDown')),
          h(Button, {
            size: 'sm',
            variant: 'outline',
            disabled: locked,
            onClick: () => { actions.removeTemplate(index) },
          }, t('template.remove'))),
        h('div', { className: 'dsst-fields' },
          text('id', t('template.id'), t('template.idHint')),
          text('name', t('template.name')),
          area('description', t('template.description')),
          h('div', { className: 'dsst-field' },
            h('div', { className: 'dsst-field-head' },
              h('span', { className: 'dsst-field-label' }, t('template.route'))),
            h(SegmentedControl, {
              id: target('route'),
              value: row.route,
              label: t('template.route'),
              disabled: locked,
              options: [
                { value: ROUTE_FIXED, label: t('template.routeFixed') },
                { value: ROUTE_POOL, label: t('template.routePool') },
              ],
              onChange: mode => { actions.setRouteMode(index, mode) },
            }),
            h('div', { className: 'dsst-route-inputs' },
              row.route === ROUTE_POOL
                ? text('pool', t('template.pool'))
                : [text('provider', t('template.provider')), text('model', t('template.model'))])),
          text('preset', t('template.preset')),
          text('reasoningEffort', t('template.reasoningEffort')),
          text('maxTokens', t('template.maxTokens')),
          area('persona', t('template.persona')),
          text('toolFilter', t('template.toolFilter'), t('template.toolFilterHint'))))
    }

    /**
     * The settings page: the deployment limits and the template list, edited as
     * drafts and written by one save.
     *
     * A deployment page, not a session page: it reads the row's configuration
     * form and never a session projection. A namespace the Host does not serve
     * renders nothing at all, which is the state `whileServed` also prevents the
     * registration from reaching; a served row the browser may not write renders
     * the editor disabled, with the reason.
     * @param props - the view the Plugins surface asks for, the copy seat, the
     *   page's snapshot hook, and its staged actions.
     * @param props.view - `summary` for the one-liner or `page` for the editor.
     * @param props.t - namespace-bound translate.
     * @param props.useSubagentTemplatesPage - reads the page's snapshot.
     * @returns the one-liner, the editor, or nothing when the row is not served.
     */
    function SubagentTemplatesPage(props) {
      const { t } = props
      const state = props.useSubagentTemplatesPage(snapshot => snapshot)
      if (props.view === 'summary') return t('page.summary')
      if (state.status === 'unavailable') return null
      const locked = state.status !== 'ready' || !state.writable
      const actions = props
      return h('div', { className: 'dsst-settings' },
        h('div', { className: 'dsst-settings-guide' },
          h('div', { className: 'dsst-settings-title' }, t('page.title')),
          h('div', { className: 'dsst-settings-description' }, t('page.description'))),
        h('div', { className: 'dsst-section' },
          h('div', { className: 'dsst-section-title' }, t('limits.title')),
          h('div', { className: 'dsst-limits' },
            state.limits.map(limit => h(LimitField, { key: limit.field, limit, t, locked, actions })))),
        locked
          ? h('div', { className: 'dsst-settings-locked' },
            h(StateDot, { state: state.status === 'ready' ? 'warning' : 'ongoing' }),
            h('span', null, state.status === 'ready' ? t('page.locked') : t('page.loading')))
          : null,
        h('div', { className: 'dsst-templates-head' },
          h('span', { className: 'dsst-templates-title' }, t('templates.title')),
          state.templatesOverridden ? h(Tag, { tone: 'info' }, t('overridden')) : null,
          h('span', { className: 'dsst-spacer' }),
          h(Button, {
            size: 'sm',
            variant: 'outline',
            disabled: locked,
            onClick: () => { actions.addTemplate() },
          }, t('templates.add'))),
        state.templates.length === 0
          ? h('div', { className: 'dsst-templates-empty' }, t('templates.empty'))
          : h('div', { className: 'dsst-templates' },
            state.templates.map((row, index) => h(TemplateRow, {
              key: index,
              row,
              index,
              total: state.templates.length,
              t,
              locked,
              actions,
            }))),
        h('div', { className: 'dsst-settings-actions' },
          h(Button, {
            variant: 'primary',
            disabled: locked || !state.edited || state.invalid || state.saving,
            onClick: () => { actions.save() },
          }, state.saving ? t('saving') : t('save')),
          h(Button, {
            variant: 'outline',
            disabled: locked || !state.edited || state.saving,
            onClick: () => { actions.discard() },
          }, t('discard')),
          h(Button, {
            variant: 'outline',
            disabled: locked || state.saving,
            onClick: () => { actions.restoreDefaults() },
          }, t('restore'))),
        state.failure !== undefined
          ? h('div', { className: 'dsst-settings-failure' },
            h(StateDot, { state: 'error' }),
            h('span', null, t(state.failure.key, state.failure.params)))
          : null,
        state.saved > 0
          ? h(Toast, { key: state.saved, text: t('saved'), tone: 'success', onDone: () => { actions.dismissNotice() } })
          : null)
    }

    return {
      inject: ['slots', 'sidebarRightTabs', 'locale', 'uiWorkspace'],
      apply(ctx) {
        const t = ctx.locale.bind(NS)
        const workspace = ctx.uiWorkspace

        ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'subagent-templates: dictionaries')
        // Stage one of a tab type's registration: what the type IS. The type is
        // an `extension` band, so it outranks a page type shipped inside the
        // product, and its guide entry is how a user opens the panel.
        ctx.effect(() => ctx.sidebarRightTabs.register({
          id: ID,
          kind: KIND,
          priority: 'extension',
          title: () => t('tab.title'),
          guide: [{
            id: 'panel',
            order: 30,
            title: () => t('guide.title'),
            description: () => t('guide.description'),
          }],
        }), 'subagent-templates: tab type')
        // Stage two: the body, under the same key the definition carries. The seat
        // is session-scoped, so the body is mounted per session and reads that
        // session's own projection; the two callbacks are the only behavior this
        // plugin hands the component.
        ctx.effect(() => ctx.slots.inject('sidebar.right.pane.tab', () => ctx.slots.register({
          name: 'sidebar.right.pane.tab',
          key: ID,
          locale: NS,
          inject: () => ({
            open: childSessionId => { workspace.openSession(childSessionId) },
            // stopActivity lets the archive proceed while the child may still be
            // mid-turn, which is the whole point of deleting a running subagent.
            archive: childSessionId => workspace.archiveSession(childSessionId, { stopActivity: true }),
          }),
        }, SubagentPanel)), 'subagent-templates: tab body')
        // The settings page. It edits this plugin's own Loader row, so it
        // registers only while the Host serves that row's namespace: a
        // deployment that never composed it shows no trace of the page, and a
        // row the browser may not write still opens, disabled with the reason.
        //
        // The settings surface is not what this bundle is: the panel above has
        // nothing to do with it, so it is injected rather than declared. A shell
        // that never composed that client half keeps the whole panel and is
        // offered no page, and every registration the page owns — its copy, its
        // form subscription, and its namespace watch — rides the injected child,
        // so unmounting the surface withdraws the page with it.
        ctx.inject(['configForms'], (settingsScope) => {
          const settings = ctx.locale.bind(SETTINGS_NS)
          settingsScope.effect(
            () => ctx.locale.register(SETTINGS_NS, { zh: zhSettings, en: enSettings }),
            'subagent-templates: settings dictionaries',
          )
          const page = createSettingsPage(settingsScope.configForms.get(SETTINGS_NAMESPACE))
          settingsScope.effect(() => () => { page.dispose() }, 'subagent-templates: settings form subscription')
          settingsScope.effect(() => settingsScope.configForms.whileServed([SETTINGS_NAMESPACE], () => ctx.slots.inject('plugins.item', () => ctx.slots.register({
            name: 'plugins.item',
            id: SETTINGS_PAGE_ID,
            order: SETTINGS_PAGE_ORDER,
            label: () => settings('page.title'),
            locale: SETTINGS_NS,
            inject: () => page.face(),
          }, SubagentTemplatesPage))), 'subagent-templates: settings page')
        })
      },
    }
  },
})
