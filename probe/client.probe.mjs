/**
 * Offline probe for the browser half of `dsh-subagent-templates`.
 *
 * `client.js` is served as one classic script, so the only way to check it
 * without a browser is to run the file the way the module system runs it: give
 * it a `window.__ModuleLoader__` and a `require`, take the plugin it builds, and
 * drive the tab body it registers against a jsdom document and the real React.
 * React, react-dom, and jsdom come from the Harness checkout's pnpm store — this
 * plugin depends on none of them.
 *
 *   node probe/client.probe.mjs
 *
 * It checks the two-stage tab registration, the dictionary pair, the row the
 * panel draws, the two actions, the refusal path, and the two ways a child stops
 * being listed.
 */

import assert from 'node:assert/strict'
import { readdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { createRequire } from 'node:module'
import { fileURLToPath, pathToFileURL } from 'node:url'

/** The Harness checkout whose pnpm store holds React, react-dom, and jsdom. */
const HARNESS = process.env.DSH_HARNESS_ROOT ?? 'C:/resource/deepseek-harness'
/** This plugin's checkout, derived from this file's own location. */
const PLUGIN = dirname(dirname(fileURLToPath(import.meta.url)))
const STORE = join(HARNESS, 'node_modules', '.pnpm')

/**
 * Resolve one package from the Harness checkout's pnpm store, which is the only
 * place this plugin's browser half can find React. The store keeps each package
 * under a versioned directory whose own `node_modules` holds its dependencies, so
 * a resolver rooted there finds the entry Node would load.
 * @param name - the package to import.
 * @param prefix - the `<name>@<version>` store directory prefix to match.
 * @returns a file URL of the package's entry point.
 */
function fromStore(name, prefix) {
  const directory = readdirSync(STORE).find(entry => entry.startsWith(prefix))
  assert.ok(directory !== undefined, `${name} is not in the Harness pnpm store`)
  const base = join(STORE, directory, 'node_modules')
  return pathToFileURL(createRequire(join(base, name, 'index.js')).resolve(name)).href
}

const React = await import(fromStore('react', 'react@18'))
const { createRoot } = await import(fromStore('react-dom/client', 'react-dom@18.3.1'))
const { act } = await import(fromStore('react-dom/test-utils', 'react-dom@18.3.1'))
const { JSDOM } = await import(fromStore('jsdom', 'jsdom@29'))

const dom = new JSDOM('<!doctype html><html><head></head><body><div id="root"></div></body></html>')
// Node 24 defines some of these as getter-only globals, so each is installed
// rather than assigned.
for (const [key, value] of Object.entries({
  window: dom.window,
  document: dom.window.document,
  navigator: dom.window.navigator,
  HTMLElement: dom.window.HTMLElement,
  Event: dom.window.Event,
  MouseEvent: dom.window.MouseEvent,
  IS_REACT_ACT_ENVIRONMENT: true,
})) {
  Object.defineProperty(globalThis, key, { value, configurable: true, writable: true })
}

let handoff
dom.window.__ModuleLoader__ = { load: registration => { handoff = registration } }
await import(pathToFileURL(join(PLUGIN, 'client.js')).href)

assert.ok(handoff !== undefined, 'the client half registered itself with the module loader')
assert.equal(handoff.id, 'dsh-subagent-templates')

/** Stand-ins for the two shared primitives, so the probe reads its own markup. */
const primitives = {
  Button: props => React.createElement(
    'button',
    { type: 'button', 'data-variant': props.variant ?? 'ghost', onClick: props.onClick, title: props.title },
    props.children,
  ),
  StateDot: props => React.createElement('i', { 'data-state': props.state }),
}

const plugin = handoff.factory(specifier => {
  if (specifier === 'react') return React
  if (specifier === '@deepseek-ai/dsh-client-ui-primitives') return primitives
  throw new Error(`the client half required an unexpected module: ${specifier}`)
})

/**
 * Replace `{name}` placeholders the way the locale service does, so the probe
 * asserts the copy the plugin actually registered.
 * @param template - the registered dictionary entry.
 * @param params - the interpolation values.
 * @returns the rendered string.
 */
function interpolate(template, params) {
  return String(template).replace(/\{(\w+)\}/g, (whole, key) => (params?.[key] ?? whole))
}

const checks = []
/** Register one probe check. */
function check(name, body) {
  checks.push([name, body])
}

// --- The plugin's own apply, against a fake client context ---------------------

const opened = []
const archived = []
let dictionaries
let tabType
let body
const disposers = []

const ctx = {
  locale: {
    bind: ns => (key, params) => interpolate(dictionaries[ns].en[key] ?? dictionaries[ns].zh[key], params),
    register: (ns, dicts) => {
      dictionaries = { ...dictionaries, [ns]: dicts }
      return () => {}
    },
  },
  sidebarRightTabs: { register: definition => { tabType = definition; return () => {} } },
  slots: {
    register: (spec, Component) => { body = { spec, Component }; return () => {} },
    // The seat is declared by the right Sidebar, so the injection runs at once.
    inject: (_name, run) => run(),
  },
  uiWorkspace: {
    openSession: id => { opened.push(id) },
    archiveSession: async (id, options) => { archived.push([id, options]) },
  },
  effect: body2 => { const disposer = body2(); disposers.push(disposer); return disposer },
}

plugin.apply(ctx)
assert.deepEqual(plugin.inject, ['slots', 'sidebarRightTabs', 'locale', 'uiWorkspace'])
for (const dispose of disposers) dispose?.()

// --- The standard kit the slot framework would hand the body -------------------

const KID = 'subagent-template-1'
const OTHER = 'subagent-template-2'
let view = {
  children: [
    { childSessionId: KID, name: 'explorer', templateName: 'Medium', createdAt: Date.now() - 5000 },
  ],
}
let sessions = { ids: [KID, 'parent-1'], byId: {}, phase: 'ready', projectionsBySession: {} }
let statuses = new Map([[KID, { running: true, pendingInteraction: undefined, completionUnread: false }]])

/**
 * Mount the panel with the current fixture values and return its root.
 * @returns the React root, for the next render or unmount.
 */
function mount() {
  const container = document.createElement('div')
  document.body.append(container)
  const root = createRoot(container)
  return { root, container }
}

let harnessRoot
let container

/**
 * Render the panel with the current fixtures and flush effects. A fresh mount
 * starts from the component's initial state, which is what a session switch
 * does; a re-render keeps the row-local state a click left behind.
 * @param options.fresh - unmount and mount again instead of re-rendering.
 * @returns the container the panel rendered into.
 */
async function render(options = {}) {
  if (options.fresh === true) {
    await act(async () => { harnessRoot.unmount() })
    ;({ root: harnessRoot, container } = mount())
  }
  await act(async () => {
    harnessRoot.render(React.createElement(body.Component, {
      useProjection: key => (key === 'subagentTemplates' ? view : undefined),
      useSessions: () => sessions,
      useSessionStatus: () => statuses,
      t: ctx.locale.bind('subagentTemplates'),
      ...body.spec.inject(),
    }))
  })
  return container
}

/**
 * Click one button by its exact text, inside act so React flushes the update.
 * @param container_ - the rendered container to search.
 * @param text - the button's text content.
 * @returns whether such a button existed and was clicked.
 */
async function clickText(container_, text) {
  const target = [...container_.querySelectorAll('button')].find(node => node.textContent === text)
  if (target === undefined) return false
  await act(async () => { target.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true })) })
  return true
}

/**
 * Click the open control on one named child row.
 * @param container_ - the rendered container to search.
 * @param name - the row's name.
 * @returns whether such a row existed and was clicked.
 */
async function clickName(container_, name) {
  const label = [...container_.querySelectorAll('.dsst-name')].find(node => node.textContent === name)
  if (label === undefined) return false
  await act(async () => { label.closest('button').dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true })) })
  return true
}

/** The destructive button inside the open confirmation line of a row. */
function confirmButton(container_) {
  return [...container_.querySelectorAll('.dsst-confirm button')].find(node => node.textContent === 'Delete')
}

/** The row element carrying one child's name. */
function rowOf(container_, name) {
  return [...container_.querySelectorAll('.dsst-row')]
    .find(row => row.querySelector('.dsst-name')?.textContent === name)
}

/**
 * Click one button by its exact text inside one named row.
 * @param container_ - the rendered container to search.
 * @param name - the row's name.
 * @param text - the button's text content.
 * @returns whether such a button existed and was clicked.
 */
async function clickRowButton(container_, name, text) {
  const target = [...(rowOf(container_, name)?.querySelectorAll('button') ?? [])]
    .find(node => node.textContent === text)
  if (target === undefined) return false
  await act(async () => { target.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true })) })
  return true
}

check('the client half registers a right-sidebar tab type in two stages', () => {
  assert.equal(tabType.kind, 'subagent-templates')
  assert.equal(tabType.id, 'dsh-subagent-templates/panel')
  assert.equal(tabType.priority, 'extension')
  // The body registers under the definition's own id, which is the dispatch key.
  assert.equal(body.spec.name, 'sidebar.right.pane.tab')
  assert.equal(body.spec.key, tabType.id)
  assert.equal(body.spec.locale, 'subagentTemplates')
  // Copy is thunked, so a language change needs no re-registration.
  assert.equal(typeof tabType.title, 'function')
  assert.equal(tabType.guide.length, 1)
  assert.equal(tabType.guide[0].title(), 'Subagents')
  assert.ok(tabType.guide[0].description().length > 0)
  // The body and the type agree on the panel's only namespace.
  assert.equal(tabType.title(), dictionaries.subagentTemplates.en['tab.title'])
})

check('both dictionaries carry exactly the same keys', () => {
  const zh = Object.keys(dictionaries.subagentTemplates.zh).sort()
  const en = Object.keys(dictionaries.subagentTemplates.en).sort()
  assert.deepEqual(zh, en)
  for (const key of zh) {
    for (const value of [dictionaries.subagentTemplates.zh[key], dictionaries.subagentTemplates.en[key]]) {
      assert.equal(typeof value, 'string')
      assert.ok(value.length > 0, `${key} is empty`)
    }
  }
})

check('an empty session explains itself instead of showing an empty box', async () => {
  view = { children: [] }
  sessions = { ids: ['parent-1'], byId: {}, phase: 'ready', projectionsBySession: {} }
  statuses = new Map()
  ;({ root: harnessRoot, container } = mount())
  await render()
  assert.match(container.textContent, /has not delegated anything yet/)
  assert.match(container.textContent, /subagent tool/)
})

check('a session list that has not arrived renders no verdict', async () => {
  sessions = { ids: [], byId: {}, phase: 'pending', projectionsBySession: {} }
  await render()
  assert.match(container.textContent, /Reading the session list/)
  assert.equal(container.textContent.includes('has not delegated'), false)
})

check('a child row shows its name, its template, and its running state', async () => {
  view = {
    children: [
      { childSessionId: KID, name: 'explorer', templateName: 'Medium', createdAt: Date.now() - 5000 },
      { childSessionId: OTHER, name: 'reviewer', templateName: 'High', createdAt: Date.now() - 7_200_000 },
    ],
  }
  sessions = { ids: [KID, OTHER, 'parent-1'], byId: {}, phase: 'ready', projectionsBySession: {} }
  statuses = new Map([
    [KID, { running: true, pendingInteraction: undefined, completionUnread: false }],
    [OTHER, { running: false, pendingInteraction: undefined, completionUnread: false }],
  ])
  await render()
  const rows = container.querySelectorAll('.dsst-row')
  assert.equal(rows.length, 2)
  const [running, finished] = rows
  assert.equal(running.querySelector('.dsst-name').textContent, 'explorer')
  assert.match(running.querySelector('.dsst-meta').textContent, /^Medium · \d+s$/)
  assert.equal(running.querySelector('i').dataset.state, 'ongoing')
  assert.equal(finished.querySelector('.dsst-name').textContent, 'reviewer')
  assert.match(finished.querySelector('.dsst-meta').textContent, /^High · \d+h$/)
  assert.equal(finished.querySelector('i').dataset.state, 'done')
})

check('a child the catalog no longer lists is not offered, unless it is running', async () => {
  // A child the user archived leaves the Host list; a running child is kept even
  // when the list has not caught up, so a live delegation never blinks out.
  sessions = { ids: ['parent-1'], byId: {}, phase: 'ready', projectionsBySession: {} }
  statuses = new Map([[KID, { running: true, pendingInteraction: undefined, completionUnread: false }]])
  await render()
  assert.equal(container.querySelectorAll('.dsst-row').length, 1)
  assert.equal(container.querySelector('.dsst-name').textContent, 'explorer')

  statuses = new Map([[KID, { running: false, pendingInteraction: undefined, completionUnread: false }]])
  await render()
  assert.equal(container.querySelectorAll('.dsst-row').length, 0)
  assert.match(container.textContent, /has not delegated anything yet/)
})

check('clicking a name opens that child as an ordinary session', async () => {
  sessions = { ids: [KID, OTHER, 'parent-1'], byId: {}, phase: 'ready', projectionsBySession: {} }
  await render()
  assert.equal(await clickName(container, 'explorer'), true)
  assert.deepEqual(opened, [KID])
})

check('deleting asks first, then stops and archives the child', async () => {
  assert.equal(await clickText(container, 'Delete'), true)
  // The confirmation sits inside the row, and the archive has not started.
  assert.match(container.textContent, /Stop and delete explorer\?/)
  assert.equal(archived.length, 0)
  assert.equal(container.querySelectorAll('.dsst-row').length, 2)

  await act(async () => { confirmButton(container).dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true })) })
  await act(async () => {})
  // The shipped archive-with-stop, not a lifecycle this plugin invented.
  assert.deepEqual(archived, [[KID, { stopActivity: true }]])
  // The row keeps its place with its controls disabled while the archive runs.
  assert.equal(container.querySelectorAll('.dsst-row').length, 2)
  assert.match(container.textContent, /Stopping…/)
  assert.equal(container.querySelector('.dsst-open').disabled, true)

  // The child leaves when the Session catalog drops it, which is the archive's
  // own consequence rather than the panel's optimism.
  await render()
  sessions = { ids: [OTHER, 'parent-1'], byId: {}, phase: 'ready', projectionsBySession: {} }
  await render()
  assert.equal(container.querySelectorAll('.dsst-row').length, 1)
  assert.equal(container.querySelector('.dsst-name').textContent, 'reviewer')
})

check('keeping the child closes the question and changes nothing', async () => {
  assert.equal(await clickText(container, 'Delete'), true)
  assert.equal(await clickText(container, 'Keep'), true)
  assert.equal(archived.length, 1)
  assert.equal(container.querySelectorAll('.dsst-row').length, 1)
  assert.equal(container.textContent.includes('Stop and delete'), false)
  // The question can be asked again on the same row.
  assert.equal(await clickText(container, 'Delete'), true)
  assert.match(container.textContent, /Stop and delete reviewer\?/)
})

check('a refused archive keeps the row and puts the reason on it', async () => {
  const original = ctx.uiWorkspace.archiveSession
  ctx.uiWorkspace.archiveSession = async () => { throw new Error('workspace is locked') }
  try {
    // A fresh mount with both children listed, so the row starts from its own
    // initial state and the refusal has something to keep.
    sessions = { ids: [KID, OTHER, 'parent-1'], byId: {}, phase: 'ready', projectionsBySession: {} }
    await render({ fresh: true })
    assert.equal(container.querySelectorAll('.dsst-row').length, 2)
    assert.equal(await clickName(container, 'reviewer'), true)
    // The question opens on the row it belongs to, and confirms on that row.
    assert.equal(await clickRowButton(container, 'reviewer', 'Delete'), true)
    assert.match(rowOf(container, 'reviewer').textContent, /Stop and delete reviewer\?/)
    assert.equal(rowOf(container, 'explorer').textContent.includes('Stop and delete'), false)
    assert.equal(await clickRowButton(container, 'reviewer', 'Delete'), true)
    await act(async () => {})
    assert.equal(container.querySelectorAll('.dsst-row').length, 2)
    assert.match(container.querySelector('.dsst-error').textContent, /Could not delete: Error: workspace is locked/)
    assert.equal(container.textContent.includes('Stopping'), false)
  } finally {
    ctx.uiWorkspace.archiveSession = original
  }
})

let failed = 0
for (const [name, body2] of checks) {
  try {
    await body2()
    process.stdout.write(`ok   ${name}\n`)
  } catch (error) {
    failed += 1
    process.stdout.write(`FAIL ${name}\n     ${error?.message?.split('\n').join('\n     ')}\n`)
  }
}
process.stdout.write(`\n${checks.length - failed}/${checks.length} client probe checks passed\n`)
process.exitCode = failed === 0 ? 0 : 1
