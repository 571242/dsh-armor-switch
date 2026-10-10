import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import vm from 'node:vm'
import { createHash } from 'node:crypto'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { TARGETS, sha16 } from '../src/host-clean.js'
import { BEGIN, END, BLOCK_BODY } from '../src/profile-clean.js'
import { currentProfile, inspectMaintenanceHost, inspectMaintenanceProfile, restoreHost, restoreProfile } from '../src/maintenance.js'

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'armor-maintenance-'))
const saved = Object.fromEntries(['DSH_HOME', 'DSH_PROFILE', 'DSH_PROFILE_DIR'].map(k => [k, process.env[k]]))
process.env.DSH_HOME = root
const active = path.join(root, 'profiles/custom')
const desktop = path.join(root, 'profiles/desktop')
for (const dir of [active, desktop]) { fs.mkdirSync(dir, { recursive: true }); fs.writeFileSync(path.join(dir, 'package.json'), '{}') }
process.env.DSH_PROFILE_DIR = active
process.env.DSH_PROFILE = 'custom'
let passed = 0
async function check(name, test) { await test(); passed++; console.log(`PASS ${name}`) }
const patch = path.join(active, 'cordis.patch.yml')
const prefix = '- id: keep-before\r\n  config: {}\r\n\r\n\r\n'
const suffix = '- id: keep-after\r\n  config: {value: precious}\r\n'
function setBlock(body = BLOCK_BODY) { fs.writeFileSync(patch, prefix + BEGIN + '\r\n' + body.replace(/\n/g, '\r\n') + END + '\r\n' + suffix) }
function fixture(name) {
  const file = path.join(root, name + '.asar')
  const entries = new Map()
  const records = []
  for (const [i, target] of TARGETS.entries()) {
    if (!entries.has(target.file)) entries.set(target.file, [])
    const chunks = entries.get(target.file)
    const offset = chunks.reduce((n, b) => n + b.length, 0)
    const original = Buffer.from(('ORIGINAL-' + i).padEnd(32, ' '))
    const modified = Buffer.from(('MODIFIED-' + i).padEnd(32, ' '))
    chunks.push(modified, Buffer.from('\n'))
    records.push({ id: target.id, file: target.file, relOffset: offset, bytes: original.length,
      originalBase64: original.toString('base64'), newBase64: modified.toString('base64'), originalSha16: sha16(original), newSha16: sha16(modified) })
  }
  const header = { files: {} }; const buffers = []; let offset = 0
  for (const [entryPath, chunks] of entries) {
    const parts = entryPath.split('/').filter(Boolean); const name = parts.pop(); let node = header
    for (const part of parts) node = node.files[part] ||= { files: {} }
    const buf = Buffer.concat(chunks); node.files[name] = { size: buf.length, offset: String(offset) }; buffers.push(buf); offset += buf.length
  }
  const json = Buffer.from(JSON.stringify(header)); const dataStart = Math.ceil((16 + json.length) / 4) * 4
  const head = Buffer.alloc(dataStart); head.writeUInt32LE(4, 0); head.writeUInt32LE(dataStart - 8, 4); head.writeUInt32LE(dataStart - 12, 8); head.writeUInt32LE(json.length, 12); json.copy(head, 16)
  fs.writeFileSync(file, Buffer.concat([head, ...buffers]))
  const manifest = { version: 1, asarPath: file, asarSize: fs.statSync(file).size, targets: records }
  const manifestFile = path.join(root, name + '.json'); fs.writeFileSync(manifestFile, JSON.stringify(manifest))
  return { file, manifest, manifestFile, dataStart, header }
}

await check('uses active profile instead of desktop', () => assert.equal(currentProfile(), active))
await check('invalid explicit profile never falls back', () => assert.equal(currentProfile(path.join(root, 'missing')), null))
await check('ambiguous profile selection refuses to guess', () => {
  delete process.env.DSH_PROFILE_DIR; delete process.env.DSH_PROFILE; assert.equal(currentProfile(), null)
  process.env.DSH_PROFILE_DIR = active; process.env.DSH_PROFILE = 'custom'
})
await check('incomplete markers preserve user configuration', () => {
  const text = prefix + BEGIN + '\n- id: partial\n' + suffix; fs.writeFileSync(patch, text)
  assert.equal(restoreProfile(active).ok, false); assert.equal(fs.readFileSync(patch, 'utf8'), text)
})
await check('duplicate markers refuse automatic deletion', () => {
  setBlock(); const text = fs.readFileSync(patch, 'utf8') + BEGIN + '\n'; fs.writeFileSync(patch, text)
  assert.equal(restoreProfile(active).ok, false); assert.equal(fs.readFileSync(patch, 'utf8'), text)
})
await check('edited generated block is preserved', () => {
  setBlock(BLOCK_BODY + '# user edit\n'); const before = fs.readFileSync(patch)
  assert.equal(restoreProfile(active).ok, false); assert.deepEqual(fs.readFileSync(patch), before)
})
await check('restoration preserves all bytes outside complete block', () => {
  setBlock(); assert.equal(inspectMaintenanceProfile(active).present, true)
  const result = restoreProfile(active); assert.equal(result.ok, true); assert.ok(fs.existsSync(result.backup))
  assert.equal(fs.readFileSync(patch, 'utf8'), prefix + suffix)
  assert.equal(restoreProfile(active).changed, false)
})
await check('valid aligned archive restores original bytes and retains manifest', () => {
  const f = fixture('valid'); const beforeManifest = fs.readFileSync(f.manifestFile)
  assert.equal(inspectMaintenanceHost(f.file, f.manifestFile).patched, TARGETS.length)
  assert.equal(restoreHost(f.file, f.manifestFile).ok, true)
  assert.equal(inspectMaintenanceHost(f.file, f.manifestFile).clean, TARGETS.length)
  assert.equal(restoreHost(f.file, f.manifestFile).changed, false)
  assert.deepEqual(fs.readFileSync(f.manifestFile), beforeManifest)
})
await check('drift preflight aborts every restore write', () => {
  const f = fixture('drift'); const bytes = fs.readFileSync(f.file); bytes[f.dataStart] = 88; fs.writeFileSync(f.file, bytes)
  assert.equal(inspectMaintenanceHost(f.file, f.manifestFile).ok, false)
  assert.equal(restoreHost(f.file, f.manifestFile).ok, false); assert.deepEqual(fs.readFileSync(f.file), bytes)
})
await check('different archive identity refuses restore', () => {
  const f = fixture('identity'); const other = fixture('other'); const before = fs.readFileSync(other.file)
  assert.equal(restoreHost(other.file, f.manifestFile).ok, false); assert.deepEqual(fs.readFileSync(other.file), before)
})
await check('corrupt backup bytes refuse restore', () => {
  const f = fixture('corrupt'); f.manifest.targets[0].originalBase64 = Buffer.alloc(32).toString('base64')
  fs.writeFileSync(f.manifestFile, JSON.stringify(f.manifest)); const before = fs.readFileSync(f.file)
  assert.equal(restoreHost(f.file, f.manifestFile).ok, false); assert.deepEqual(fs.readFileSync(f.file), before)
})
await check('missing manifest never claims restoration succeeded', () => {
  const f = fixture('missing-record'); assert.equal(restoreHost(f.file, path.join(root, 'missing.json')).ok, false)
})

// Isolated host plugin import: no hoisted dependency or real filesystem mutations.
const moduleRoot = path.join(root, 'module'); const stub = path.join(moduleRoot, 'node_modules/@deepseek-ai/schemastery')
fs.mkdirSync(stub, { recursive: true }); fs.writeFileSync(path.join(moduleRoot, 'package.json'), '{"type":"module"}')
fs.writeFileSync(path.join(stub, 'package.json'), '{"type":"module","exports":"./index.js"}')
fs.writeFileSync(path.join(stub, 'index.js'), 'const z=new Proxy(()=>z,{get:()=>z,apply:()=>z});export default z')
for (const name of ['index.js', 'host-clean.js', 'profile-clean.js', 'maintenance.js', 'preferences.js']) fs.copyFileSync(path.join(repo, 'src', name), path.join(moduleRoot, name))
const mod = await import(pathToFileURL(path.join(moduleRoot, 'index.js')))
const fake = { get: () => undefined, effect: fn => fn(), inject: () => {}, systemPrompt: { section: () => () => {}, context: () => () => {} } }
const archive = fixture('rpc'); fs.copyFileSync(archive.manifestFile, path.join(root, 'armor-switch-hostclean.json')); setBlock()
const config = { enabled: false, fullAccess: false, hostClean: true, profileClean: true, asarPath: archive.file, profilePath: active }
await check('mount never applies disk cleaning, even with legacy true flags', () => {
  const h = fs.readFileSync(archive.file); const p = fs.readFileSync(patch)
  mod.apply(fake, config); assert.deepEqual(fs.readFileSync(archive.file), h); assert.deepEqual(fs.readFileSync(patch), p)
})
await check('recheck re-reads disk rather than startup cache', async () => {
  assert.equal((await mod.handleRpc('recheck', {})).value.profileClean.present, true)
  fs.writeFileSync(patch, prefix + suffix)
  assert.equal((await mod.handleRpc('recheck', {})).value.profileClean.present, false)
})
await check('partial restoration reports per-surface failure', async () => {
  fs.writeFileSync(patch, BEGIN + '\n' + suffix)
  const response = await mod.handleRpc('revertAll', {})
  assert.equal(response.ok, false); assert.equal(response.value.operation.outcomes.host.ok, true)
  assert.equal(response.value.operation.outcomes.profile.ok, false); assert.equal(response.value.restartRequired, true)
})
await check('maintenance does not expose new disk rewrite actions', async () => {
  for (const endpoint of ['hostClean', 'profileClean', 'cleanAll']) assert.equal((await mod.handleRpc(endpoint, {})).ok, false)
})

let definition, registration, api, dispose
const react = { createElement: (tag, props, children) => ({ tag, props, children }), useState: () => [null, () => {}], useEffect: () => {} }
vm.runInNewContext(fs.readFileSync(path.join(repo, 'src/client.js'), 'utf8'), { window: { __ModuleLoader__: { load: d => definition = d } }, Set, Promise, Error, Array, String })
const client = definition.factory(() => react)
let failConnection = false; let called = 0
const clientCtx = { get: () => ({ rpc: { call: () => { called++; if (failConnection) throw Error('offline'); return Promise.resolve({ ok: true, value: { hostClean: { ok: true }, profileClean: { ok: true } } }) } } }),
  effect: fn => { const d = fn(); if (typeof d === 'function') dispose = d }, locale: { register: () => () => {} },
  slots: { inject: (name, fn) => { assert.equal(name, 'plugins.bundle.config'); return fn() }, register: (reg, component) => { registration = reg; api = reg.inject(); return () => {} } } }
await check('UI registers only on own plugin page, never composer dock', () => {
  client.apply(clientCtx); assert.equal(registration.key, 'dsh-armor-switch')
  const pkg = JSON.parse(fs.readFileSync(path.join(repo, 'package.json')))
  assert.ok(pkg.dsh.client.inject.includes('@deepseek-ai/dsh-client-ui-plugin-manager'))
})
await check('connection failure preserves confirmed values and reports error', async () => {
  await api.refresh(); const value = api.hooks.maintenance.getSnapshot().value
  failConnection = true; await api.refresh(); const snapshot = api.hooks.maintenance.getSnapshot()
  assert.equal(snapshot.failed, true); assert.equal(snapshot.value, value); assert.equal(snapshot.busy, false)
})
await check('source disposal prevents further requests', async () => { const before = called; dispose(); await api.refresh(); assert.equal(called, before) })
await check('instruction literals and replacement table remain byte-identical', () => {
  const expected = JSON.parse(fs.readFileSync(path.join(repo, 'tests/instruction-hashes.json')))
  function hash(s) { return createHash('sha256').update(s).digest('hex') }
  for (const [name, entry] of Object.entries(expected)) {
    const src = fs.readFileSync(path.join(repo, entry.file), 'utf8')
    let raw
    if (name === 'TARGETS') raw = src.slice(src.indexOf('export const TARGETS = ['), src.indexOf('\n]\n', src.indexOf('export const TARGETS = [')) + 3)
    else raw = src.match(new RegExp('const ' + name + ' = `((?:\\\\[\\s\\S]|[^`])*)`'))?.[0]
    assert.equal(hash(raw), entry.sha256, name)
  }
})
for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v }
console.log(`ALL PASS: ${passed}. Fixture directory: ${root}`)
