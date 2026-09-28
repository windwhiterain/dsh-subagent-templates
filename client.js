/**
 * Browser half: one right-Sidebar tab type listing the subagent sessions this
 * session delegated.
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
    const { Button, StateDot } = require('@deepseek-ai/dsh-client-ui-primitives')

    /** The tab type's discriminator, and the page address the registry records. */
    const KIND = 'subagent-templates'
    /** This implementation's identity, and the key the tab body registers under. */
    const ID = 'dsh-subagent-templates/panel'
    /** The Host projection key carrying a parent's delegated children. */
    const PROJECTION_KEY = 'subagentTemplates'
    /** This plugin's copy namespace. */
    const NS = 'subagentTemplates'
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
      },
    }
  },
})
