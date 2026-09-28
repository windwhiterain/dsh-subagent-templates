/**
 * Offline probe for the mapping store, against the Harness's own storage code.
 *
 * The Host refuses to open a unit whose stored version it does not accept, and it
 * validates every record through the value schema. Both facts make a format
 * change a medium operation rather than a local one, so it is checked here
 * instead of reasoned about: the probe drives `JsonStorageBackend` over a copy of
 * the profile's real `subagent_templates` file and then over a fresh one.
 *
 *   node --import tsx/esm probe/store.probe.mjs
 *
 * Run it from the Harness checkout, where the TypeScript sources and `tsx` live.
 * It reads the live store and writes only under this plugin's `.dev-artifacts/`.
 */

import assert from 'node:assert/strict'
import { copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

/** This plugin's checkout, derived from this file's own location. */
const PLUGIN = dirname(dirname(fileURLToPath(import.meta.url)))
/** The Harness checkout holding the TypeScript sources and `tsx`. */
const HARNESS = process.env.DSH_HARNESS_ROOT ?? 'C:/resource/deepseek-harness'
/** The profile's live mapping unit. The probe copies it and never writes it. */
const LIVE_STORE = join(process.env.DSH_HOME ?? join(homedir(), '.dsh'), 'storages', 'subagent_templates.json')
const { MAPPING_DOMAIN, TABLE } = await import(pathToFileURL(join(PLUGIN, 'lib', 'store.js')).href)
const { JsonStorageBackend } = await import(
  pathToFileURL(join(HARNESS, 'packages', 'storage', 'storage-json', 'src', 'index.ts')).href
)

const ROOT = join(PLUGIN, '.dev-artifacts', 'store-probe')
rmSync(ROOT, { recursive: true, force: true })
mkdirSync(ROOT, { recursive: true })

/** One record as this plugin writes it today. */
const CURRENT = {
  parentSessionId: 'session-parent',
  name: 'explorer',
  templateId: 'medium',
  createdAt: 1790668290348,
  cwd: 'C:\\work\\project',
}

/**
 * Read a unit's whole state the way the domain layer does, and validate every
 * record through the value schema — the two steps that decide whether an
 * activation survives its own store.
 * @param root - the backend root to open under.
 * @returns the validated records, and the number the schema refused.
 */
async function openValidated(root) {
  const backend = new JsonStorageBackend(root)
  try {
    const unit = await backend.kv.open({
      name: MAPPING_DOMAIN.name,
      version: MAPPING_DOMAIN.version,
      tables: [TABLE],
      hasGlobal: false,
    })
    try {
      const state = await unit.loadAll()
      const parse = MAPPING_DOMAIN.tables[TABLE].valueSchema.parse
      const records = {}
      let refused = 0
      for (const [key, raw] of Object.entries(state.tables[TABLE] ?? {})) {
        try {
          records[key] = parse(raw)
        } catch {
          refused += 1
        }
      }
      return { records, refused, unit, state }
    } finally {
      await unit.close()
    }
  } finally {
    await backend.close()
  }
}

const checks = []
/** Register one probe check. */
function check(name, body) {
  checks.push([name, body])
}

check('the unit version did not move, because the reader accepts the old record', () => {
  // A backward-compatible change: the new validator reads the old record and
  // always writes the current one, so there is nothing to migrate and no
  // version to declare compatible.
  assert.equal(MAPPING_DOMAIN.version, 1)
  assert.equal(MAPPING_DOMAIN.compatibleVersions, undefined)
  assert.equal(MAPPING_DOMAIN.invalidRecords, undefined)
  assert.equal(MAPPING_DOMAIN.layout, undefined)
})

check("the profile's real store opens, and every legacy record survives", async () => {
  // The decisive check: the file on the user's disk, opened with the spec this
  // plugin now declares. A format change that broke it would fail activation.
  if (!existsSync(LIVE_STORE)) {
    process.stdout.write('     (no live store on this machine; the legacy record below still covers the shape)\n')
    return
  }
  const copy = join(ROOT, MAPPING_DOMAIN.name)
  mkdirSync(copy, { recursive: true })
  copyFileSync(LIVE_STORE, join(copy, `${MAPPING_DOMAIN.name}.json`))
  const { records, refused } = await openValidated(copy)
  assert.equal(refused, 0, 'no record in the live store is unreadable')
  const legacy = Object.values(records).filter(record => record.name !== undefined)
  assert.ok(legacy.length > 0, 'the live store has records to read')
  for (const record of legacy) {
    // The old field was the only word that record had for its child.
    assert.equal(typeof record.name, 'string')
    assert.ok(record.name.length > 0)
    assert.equal(record.label, undefined, 'the read form drops the old field')
  }
})

check('a legacy record reads as the name it did have, and writes in the new form', () => {
  const parse = MAPPING_DOMAIN.tables[TABLE].valueSchema.parse
  const legacy = { ...CURRENT, name: undefined, label: 'Analyze the incremental diff' }
  const read = parse(legacy)
  assert.equal(read.name, 'Analyze the incremental diff')
  assert.equal('label' in read, false)
  // A record that already names its child is untouched apart from the copy.
  assert.deepEqual(parse(CURRENT), CURRENT)
  assert.deepEqual(parse({ ...CURRENT, label: 'stale' }), { ...CURRENT, name: CURRENT.name })
})

check('a record with no name in either form is refused', () => {
  const parse = MAPPING_DOMAIN.tables[TABLE].valueSchema.parse
  assert.throws(() => parse({ ...CURRENT, name: undefined }), /"name" must be a non-empty string/)
  assert.throws(() => parse({ ...CURRENT, name: '' }), /"name" must be a non-empty string/)
  assert.throws(() => parse({ ...CURRENT, name: undefined, label: '' }), /"name" must be a non-empty string/)
  assert.throws(() => parse({ ...CURRENT, parentSessionId: '' }), /parentSessionId/)
  assert.throws(() => parse({ ...CURRENT, createdAt: -1 }), /non-negative integer/)
  assert.throws(() => parse(null), /must be an object/)
  assert.throws(() => parse([CURRENT]), /must be an object/)
})

check('a fresh unit round-trips a record and stamps the current version', async () => {
  const { records } = await openValidated(ROOT)
  assert.deepEqual(records, {})
  // The backend owns one handle per unit, so a write needs a second open; the
  // domain layer is what normally holds one open across a session.
  const backend = new JsonStorageBackend(ROOT)
  try {
    const opened = await backend.kv.open({
      name: MAPPING_DOMAIN.name,
      version: MAPPING_DOMAIN.version,
      tables: [TABLE],
      hasGlobal: false,
    })
    try {
      await opened.putRecord(TABLE, 'subagent-template-1', CURRENT)
      const state = await opened.loadAll()
      assert.deepEqual(state.tables[TABLE]['subagent-template-1'], CURRENT)
    } finally {
      await opened.close()
    }
  } finally {
    await backend.close()
  }
  // The single layout keeps the whole unit in one file next to the other profile
  // storages, stamped with the version this spec declares.
  const onDisk = JSON.parse(readFileSync(join(ROOT, `${MAPPING_DOMAIN.name}.json`), 'utf8'))
  assert.equal(onDisk.unit.version, MAPPING_DOMAIN.version)
  assert.deepEqual(onDisk.tables[TABLE]['subagent-template-1'], CURRENT)
})

let failed = 0
for (const [name, body] of checks) {
  try {
    await body()
    process.stdout.write(`ok   ${name}\n`)
  } catch (error) {
    failed += 1
    process.stdout.write(`FAIL ${name}\n     ${error?.message?.split('\n').join('\n     ')}\n`)
  }
}
process.stdout.write(`\n${checks.length - failed}/${checks.length} store probe checks passed\n`)
if (failed === 0) rmSync(ROOT, { recursive: true, force: true })
process.exitCode = failed === 0 ? 0 : 1
