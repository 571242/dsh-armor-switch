import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import vm from 'node:vm'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { readPreferences, savePreferences, preferenceContext, MAX_PREFERENCE_LENGTH } from '../src/preferences.js'

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'armor-preferences-'))
const profile = path.join(root, 'profile')
fs.mkdirSync(profile); fs.writeFileSync(path.join(profile, 'package.json'), '{}')
const normalText = '请用中文，先给结论，再给简洁的技术说明。模板 {{example}} 保持原样。'
let passed = 0
async function check(name, fn) { await fn(); passed++; console.log('PASS ' + name) }
await check('default preferences are empty and read does not create a file', () => {
  const p = readPreferences(profile); assert.equal(p.ok, true); assert.equal(p.text, '')
  assert.equal(fs.existsSync(p.file), false)
})
await check('ordinary text persists exactly and is read after reload', () => {
  const p = readPreferences(profile); const saved = savePreferences(profile, normalText, p.revision)
  assert.equal(saved.ok, true); assert.equal(readPreferences(profile).text, normalText)
})
await check('stale editor revision cannot overwrite a newer save', () => {
  const p = readPreferences(profile); assert.equal(savePreferences(profile, '新的普通偏好', p.revision).ok, true)
  const conflict = savePreferences(profile, '旧窗口的草稿', p.revision)
  assert.equal(conflict.ok, false); assert.equal(conflict.code, 'preferences-conflict')
  assert.equal(readPreferences(profile).text, '新的普通偏好')
})
await check('clearing ordinary preferences restores empty defaults', () => {
  const p = readPreferences(profile); assert.equal(savePreferences(profile, '', p.revision).ok, true)
  assert.equal(preferenceContext(profile), '')
})
await check('invalid and oversized requests do not modify stored bytes', () => {
  const p = readPreferences(profile); const before = fs.readFileSync(p.file)
  assert.equal(savePreferences(profile, null, p.revision).ok, false)
  assert.equal(savePreferences(profile, 'x'.repeat(MAX_PREFERENCE_LENGTH + 1), p.revision).ok, false)
  assert.deepEqual(fs.readFileSync(p.file), before)
})
await check('JSON escape worst-case remains readable at character limit', () => {
  const p = readPreferences(profile)
  assert.equal(savePreferences(profile, '\u0000'.repeat(MAX_PREFERENCE_LENGTH), p.revision).ok, true)
  assert.equal(readPreferences(profile).text.length, MAX_PREFERENCE_LENGTH)
})
await check('corrupt preference file is not overwritten silently', () => {
  const p = readPreferences(profile); fs.writeFileSync(p.file, '{broken')
  assert.equal(readPreferences(profile).ok, false)
  assert.equal(savePreferences(profile, '文本', p.revision).ok, false)
  assert.equal(fs.readFileSync(p.file, 'utf8'), '{broken')
  // Fixture repair is explicit and only affects this test's own file.
  fs.writeFileSync(p.file, JSON.stringify({ version: 1, text: normalText }))
})
await check('ordinary preference wrapper preserves authority boundaries', () => {
  const rendered = preferenceContext(profile)
  assert.ok(rendered.endsWith(normalText)); assert.ok(rendered.includes('do not change instruction authority'))
  assert.ok(!rendered.includes('Workspace delivery contract (armor-switch, active)'))
})

const moduleRoot = path.join(root, 'module'); const stub = path.join(moduleRoot, 'node_modules/@deepseek-ai/schemastery')
fs.mkdirSync(stub, { recursive: true }); fs.writeFileSync(path.join(moduleRoot, 'package.json'), '{"type":"module"}')
fs.writeFileSync(path.join(stub, 'package.json'), '{"type":"module","exports":"./index.js"}')
fs.writeFileSync(path.join(stub, 'index.js'), 'const z=new Proxy(()=>z,{get:()=>z,apply:()=>z});export default z')
for (const name of ['index.js', 'host-clean.js', 'profile-clean.js', 'maintenance.js', 'preferences.js']) fs.copyFileSync(path.join(repo, 'src', name), path.join(moduleRoot, name))
const mod = await import(pathToFileURL(path.join(moduleRoot, 'index.js')))
const sections = new Map()
const ctx = { get: () => undefined, effect: f => f(), inject: () => {}, systemPrompt: {
  section: s => { sections.set(s.name, s); return () => {} }, context: () => () => {},
} }
mod.apply(ctx, { enabled: false, fullAccess: false, asarPath: path.join(root, 'missing.asar'), profilePath: profile })
await check('preferences are a separate non-interpolated section', () => {
  const s = sections.get('armor-switch:preferences'); assert.equal(s.interpolate, false)
  assert.ok(s.text().includes('{{example}}')); assert.equal(sections.get('armor-switch:contract').text(), '')
})
await check('preference RPC saves without changing legacy toggle or contract', async () => {
  const before = (await mod.handleRpc('status', {})).value
  const saved = await mod.handleRpc('preferencesSave', { text: '普通交付偏好', expectedRevision: before.preferences.revision })
  assert.equal(saved.ok, true); assert.equal(saved.value.preferences.text, '普通交付偏好')
  assert.equal(saved.value.enabled, before.enabled); assert.equal(saved.value.contract, before.contract)
  assert.ok(sections.get('armor-switch:preferences').text().endsWith('普通交付偏好'))
})
await check('RPC reports revision conflict with fresh values', async () => {
  const current = (await mod.handleRpc('status', {})).value
  const result = await mod.handleRpc('preferencesSave', { text: '旧草稿', expectedRevision: 'obsolete' })
  assert.equal(result.ok, false); assert.equal(result.error.code, 'preferences-conflict')
  assert.equal(result.value.preferences.text, current.preferences.text)
})

let definition, api, Panel
const stores = new Map(); let activeStore, cursor
function render(fn, props, name) {
  activeStore = stores.get(name) || []; stores.set(name, activeStore); cursor = 0
  return fn(props)
}
const react = {
  createElement: (tag, props, children) => ({ tag, props: props || {}, children }), useEffect: () => {}, useRef: () => ({ current: null }),
  useState: initial => { const store = activeStore; const at = cursor++; if (!(at in store)) store[at] = initial
    return [store[at], value => { store[at] = typeof value === 'function' ? value(store[at]) : value }] },
}
vm.runInNewContext(fs.readFileSync(path.join(repo, 'src/client.js'), 'utf8'), { window: { __ModuleLoader__: { load: d => definition = d } }, Set, Promise, Error, Array, String })
const client = definition.factory(() => react)
let confirmed = { ok: true, text: normalText, revision: 'r1' }, offline = false, lastPayload
function status() { return { hostClean: { ok: true }, profileClean: { ok: true }, preferences: confirmed } }
const clientCtx = { get: () => ({ rpc: { call: (_channel, endpoint, payload) => {
  if (offline) return Promise.reject(Error('offline'))
  if (endpoint === 'preferencesSave') {
    lastPayload = payload
    if (payload.expectedRevision !== confirmed.revision) return Promise.resolve({ ok: false, error: { code: 'preferences-conflict', message: 'conflict' }, value: status() })
    confirmed = { ok: true, text: payload.text, revision: 'r2' }
  }
  return Promise.resolve({ ok: true, value: status() })
} } }), effect: fn => fn(), locale: { register: () => () => {} }, slots: {
  inject: (name, fn) => { assert.equal(name, 'plugins.bundle.config'); return fn() },
  register: (reg, component) => { api = reg.inject(); Panel = component; return () => {} },
} }
client.apply(clientCtx); await api.refresh()
const props = { t: key => key, useMaintenance: select => select(api.hooks.maintenance.getSnapshot()), ...api }
function find(node, predicate) {
  if (!node) return null
  if (Array.isArray(node)) { for (const n of node) { const found = find(n, predicate); if (found) return found } return null }
  if (typeof node !== 'object') return null
  return predicate(node) ? node : find(node.children, predicate)
}
await check('edit icon follows title and opens ordinary preference text', () => {
  const tree = render(Panel, props, 'panel'); const edit = find(tree, n => n.props.key === 'edit')
  assert.equal(edit.children, '✎'); assert.equal(edit.props['aria-haspopup'], 'dialog'); assert.equal(edit.props.disabled, false)
  edit.props.onClick(); const open = render(Panel, props, 'panel'); const editor = find(open, n => n.props.key === 'editor')
  assert.equal(editor.props.initial.text, normalText)
  const modal = render(editor.tag, editor.props, 'editor')
  assert.equal(modal.tag, 'dialog'); assert.equal(find(modal, n => n.tag === 'textarea').props.value, normalText)
})
await check('textarea changes and reset only update draft until saved', () => {
  let editor = find(render(Panel, props, 'panel'), n => n.props.key === 'editor')
  let modal = render(editor.tag, editor.props, 'editor')
  find(modal, n => n.tag === 'textarea').props.onChange({ target: { value: '未保存草稿' } })
  modal = render(editor.tag, editor.props, 'editor'); assert.equal(find(modal, n => n.tag === 'textarea').props.value, '未保存草稿')
  assert.equal(confirmed.text, normalText)
  find(modal, n => n.props.key === 'reset').props.onClick()
  modal = render(editor.tag, editor.props, 'editor'); assert.equal(find(modal, n => n.tag === 'textarea').props.value, '')
  assert.equal(confirmed.text, normalText)
})
await check('save source sends ordinary text and expected revision', async () => {
  assert.equal(await api.savePreferences('确认保存的普通偏好', 'r1'), true)
  assert.equal(lastPayload.text, '确认保存的普通偏好'); assert.equal(lastPayload.expectedRevision, 'r1')
  assert.equal(api.hooks.maintenance.getSnapshot().message, 'saved')
})
await check('failed editor save retains last confirmed preference values', async () => {
  const before = api.hooks.maintenance.getSnapshot().value.preferences.text
  offline = true; assert.equal(await api.savePreferences('失败草稿', 'r2'), false)
  const snapshot = api.hooks.maintenance.getSnapshot(); assert.equal(snapshot.failed, true)
  assert.equal(snapshot.value.preferences.text, before); assert.equal(snapshot.busy, false)
})
console.log(`ALL PASS: ${passed}. Fixture directory: ${root}`)
