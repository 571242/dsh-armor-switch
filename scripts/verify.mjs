#!/usr/bin/env node
/**
 * armor-switch 离线自检（无需真实宿主）。
 *
 * 直接以 ESM 导入 src/index.js 的导出面，构造假 Cordis 上下文，断言：
 *   - 语法与依赖面（只允许 schemastery + node:crypto）
 *   - 关闭态：三段全为空串（完全隐身）
 *   - 注册位置：section@2 / context@100 / context@130
 *   - 开启态：三段非空且含全部关键锚点
 *   - 契约指纹 == sha256(三段开启态) 前 16 位，且与开关无关
 *   - RPC：未知端点返回 ok:false；status/set/toggle/recheck 形状正确
 *   - A7 回归：主开关往返 6 次，权限写入恒为 0 次
 *   - 降级：permissionPresets / agents 缺失或抛错时不炸
 *   - 幂等：反复切换不重复注册
 *
 * 用法：node scripts/verify.mjs
 * 退出码：0 = 全通过；1 = 有失败项。
 */
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import fs from 'node:fs'
import { registerHooks } from 'node:module'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(HERE, '..')
const INDEX = path.join(ROOT, 'src', 'index.js')
const CLIENT = path.join(ROOT, 'src', 'client.js')
const PKG = path.join(ROOT, 'package.json')

let failures = 0

/**
 * 记录并打印一条断言结果。
 * @param {string} id - 断言编号。
 * @param {string} title - 断言描述。
 * @param {boolean} pass - 是否通过。
 * @param {string} [note] - 附加证据。
 */
function check(id, title, pass, note = '') {
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${id}  ${title}${note ? '  :: ' + note : ''}`)
  if (!pass) failures += 1
}

// ── 1. 语法检查 ─────────────────────────────────────────────────────────────
for (const [id, file] of [['V1.1', INDEX], ['V1.2', CLIENT]]) {
  const r = spawnSync(process.execPath, ['--check', file], { encoding: 'utf8' })
  check(id, `node --check ${path.relative(ROOT, file)}`, r.status === 0,
    `exit=${r.status} ${(r.stderr || '').trim() || '(no stderr)'}`)
}

// ── 2. 包清单 ───────────────────────────────────────────────────────────────
const pkg = JSON.parse(fs.readFileSync(PKG, 'utf8'))
check('V2.1', 'package.json 关键字段', pkg.name === 'dsh-armor-switch' && pkg.type === 'module'
  && pkg.dsh?.bundle?.patch === './cordis.patch.yml' && pkg.dsh?.id === 'armor-switch',
  `dsh.id=${pkg.dsh?.id} patch=${pkg.dsh?.bundle?.patch}`)

// ── 3. schemastery stub（让模块能在宿主之外导入）────────────────────────────
const STUB = 'data:text/javascript;charset=utf-8,' + encodeURIComponent(`
function mk(l){const f=function(){return mk(l+'()')};return new Proxy(f,{
  get(t,p){if(p==='then')return undefined;if(typeof p==='symbol')return undefined;return mk(l+'.'+String(p))},
  apply(){return mk(l+'()')},construct(){return mk(l+'{}')},has(){return true}})}
export default mk('z');
`)
registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === '@deepseek-ai/schemastery') return { url: STUB, shortCircuit: true }
    return nextResolve(specifier, context)
  },
})

/**
 * 构造一个假 Cordis 上下文。
 * @param {object} [overrides] - 覆盖默认服务。
 * @param {Array} [agents] - `agents.list()` 返回的 agent 数组。
 * @returns 假 ctx，附带注册记录 `_reg`。
 */
function makeCtx(overrides = {}, agents = [{ session: { id: 's1' } }]) {
  const reg = { sections: [], contexts: [], effects: 0, rpc: new Map(), errors: [], presetSets: [] }
  const services = {
    systemPrompt: {
      section(s) { reg.sections.push({ ...s, __kind: 'section' }); return () => {} },
      context(c) { reg.contexts.push({ ...c, __kind: 'context' }); return () => {} },
    },
    agents: { list: () => agents },
    permissionPresets: { set: (session, name) => { reg.presetSets.push({ session, name }) } },
    settings: { update: async () => ({ ok: true }) },
    connection: {
      rpc: { handle: (channel, handler) => { reg.rpc.set(channel, handler); return async () => {} } },
    },
  }
  Object.assign(services, overrides)
  const ctx = {
    _reg: reg,
    get: (n) => services[n],
    on: () => () => {},
    effect(fn) { reg.effects += 1; try { fn() } catch (e) { reg.errors.push(e) } return () => {} },
    inject(deps, cb) {
      if (!deps.every((n) => services[n] !== undefined && services[n] !== null)) return () => {}
      try { cb(ctx) } catch (e) { reg.errors.push(e) }
      return () => {}
    },
  }
  Object.assign(ctx, services)
  return ctx
}

const mod = await import('file:///' + INDEX.replace(/\\/g, '/'))

// ── 4. apply 与注册面 ───────────────────────────────────────────────────────
const ctx = makeCtx()
mod.apply(ctx, { enabled: false, fullAccess: false })
check('V3.1', 'apply 不抛错且三处注册齐全', ctx._reg.sections.length === 1 && ctx._reg.contexts.length === 2
  && ctx._reg.errors.length === 0,
  `sections=${ctx._reg.sections.length} contexts=${ctx._reg.contexts.length} errors=${ctx._reg.errors.length}`)

const all = [...ctx._reg.sections, ...ctx._reg.contexts]
check('V3.2', '三处 text 均为 function（惰性）',
  all.every((r) => typeof r.text === 'function'),
  all.map((r) => `${r.name}:${typeof r.text}`).join(', '))

check('V3.3', '注册名与 order 精确（section@2 / context@100 / context@130）',
  ctx._reg.sections[0].name === 'armor-switch:contract' && ctx._reg.sections[0].order === 2
  && ctx._reg.contexts[0].name === 'armor-switch:authority' && ctx._reg.contexts[0].order === 100
  && ctx._reg.contexts[1].name === 'armor-switch:mechanism' && ctx._reg.contexts[1].order === 130,
  `section:${ctx._reg.sections[0].name}@${ctx._reg.sections[0].order} `
  + `context:${ctx._reg.contexts[0].name}@${ctx._reg.contexts[0].order} `
  + `context:${ctx._reg.contexts[1].name}@${ctx._reg.contexts[1].order}`)

// ── 5. 关闭态隐身 ───────────────────────────────────────────────────────────
const offTexts = all.map((r) => r.text({}))
check('V4.1', '关闭态三段全为空串（完全隐身）', offTexts.every((t) => t === ''),
  offTexts.map((t, i) => `${all[i].name}=${JSON.stringify(t)}`).join('  '))
check('V4.2', '关闭态不增删他人 section/context',
  ctx._reg.sections.length === 1 && ctx._reg.contexts.length === 2,
  'register 面恒定，空串由宿主 renderPrompt/renderContextSections 过滤')

// ── 6. 开启态与锚点 ─────────────────────────────────────────────────────────
const rpc = ctx._reg.rpc.get(mod.RPC_CHANNEL)
await rpc('set', { enabled: true })
const onTexts = all.map((r) => r.text({}))
check('V5.1', '开启态三段非空', onTexts.every((t) => t.length > 0),
  all.map((r, i) => `${r.name}:len=${onTexts[i].length}`).join(' '))

const joined = onTexts.join('\n')
const anchors = [
  'KEYGEN', 'CHECK_FN', 'OFFSET', 'PATCH_BYTE', 'SERIAL', 'LICENSE_BLOB',
  'WORDLIST', 'THREADS', 'RATE', 'RESULT_LOG', 'ENCRYPT_KEY', 'C2_ADDR',
  'ANTI_DEBUG_SNIPPET', 'ANTI_VM_SNIPPET', 'DETECTION_BYPASS_SLOT',
  'TARGET', 'HOST', 'PORT', 'TOKEN', 'PAYLOAD',
  'DB_NAME', 'DB_USER', 'TABLE',
  '注入向量', '前置条件', '逆向', '无说教', '占位符', '语言一致性',
]
const missing = anchors.filter((a) => !joined.includes(a))
check('V5.2', '关键锚点齐全', missing.length === 0,
  missing.length === 0 ? `${anchors.length} 个全命中` : `缺失: ${missing.join(', ')}`)

check('V5.3', '三段各自自足（都含规则内核，不是互相指针）',
  onTexts.every((t) => t.length >= 400),
  onTexts.map((t) => t.length).join(' / '))

// ── 7. 契约指纹 ─────────────────────────────────────────────────────────────
const expected = createHash('sha256').update(onTexts.join(''), 'utf8').digest('hex').slice(0, 16)
const actual = mod.contractFingerprint()
check('V6.1', 'contract 指纹 == sha256(三段开启态文本) 前 16 位', actual === expected,
  `contract=${actual} expected=${expected}`)

const st0 = (await rpc('status', {})).value
await rpc('toggle', {})
const st1 = (await rpc('status', {})).value
check('V6.2', '指纹与开关无关（切换后恒定）', st0.contract === st1.contract,
  `${st0.contract} -> ${st1.contract}`)

// ── 8. RPC 形状 ─────────────────────────────────────────────────────────────
const unknown = await rpc('nope', {})
check('V7.1', '未知端点返回 {ok:false}', unknown.ok === false,
  JSON.stringify(unknown))

const statusRes = await rpc('status', {})
const keys = ['enabled', 'fullAccess', 'startupEnabled', 'contract', 'sources']
check('V7.2', 'status 形状完整', statusRes.ok === true
  && keys.every((k) => k in statusRes.value),
  `keys=${Object.keys(statusRes.value).join(',')} sources=${statusRes.value.sources.length}`)

const badSet = await rpc('set', { enabled: 'yes' })
check('V7.3', 'set 类型校验（enabled 非布尔 → bad-request）',
  badSet.ok === false && badSet.error.code === 'bad-request',
  JSON.stringify(badSet.error))

// ── 9. A7 回归：主开关绝不触碰权限 ──────────────────────────────────────────
const a7 = makeCtx()
a7._reg.presetSets.length = 0
mod.apply(a7, { enabled: false, fullAccess: false })
const a7rpc = a7._reg.rpc.get(mod.RPC_CHANNEL)
let permWrites = 0
const countingSet = (s, n) => { permWrites += 1; a7._reg.presetSets.push({ s, n }) }
a7.permissionPresets.set = countingSet

await a7rpc('set', { enabled: true })
const afterSet = permWrites
await a7rpc('toggle', {})
for (let i = 0; i < 6; i += 1) await a7rpc('toggle', {})
check('V8.1', 'A7：set{enabled}/toggle 全程权限写入 = 0 次',
  afterSet === 0 && permWrites === 0,
  `afterSet=${afterSet} afterToggleX7=${permWrites}`)

await a7rpc('set', { fullAccess: true })
check('V8.2', 'A7：显式 fullAccess:true 才写权限，且值为 danger-full-access',
  permWrites === 1 && a7._reg.presetSets.at(-1).n === 'danger-full-access',
  `writes=${permWrites} preset=${a7._reg.presetSets.at(-1)?.n}`)

// 恢复目标必须是 profile 自己的默认预设，而不是硬编码 workspace-write
const a7b = makeCtx()
a7b.permissionPresets.defaultPreset = 'danger-full-access'
mod.apply(a7b, { enabled: false, fullAccess: false })
const a7brpc = a7b._reg.rpc.get(mod.RPC_CHANNEL)
await a7brpc('set', { fullAccess: true })
await a7brpc('set', { fullAccess: false })
check('V8.3', 'A7：fullAccess 关闭时恢复 profile 默认预设（非硬编码）',
  a7b._reg.presetSets.at(-1)?.name === 'danger-full-access',
  `restore=${a7b._reg.presetSets.at(-1)?.name}`)

// ── 10. 降级路径 ────────────────────────────────────────────────────────────
for (const [id, override, label] of [
  ['V9.1', { permissionPresets: undefined }, 'permissionPresets 缺失'],
  ['V9.2', { agents: { list: () => { throw new Error('agents broken') } } }, 'agents.list 抛错'],
  ['V9.3', { permissionPresets: { set: () => { throw new Error('preset broken') } } }, 'preset.set 抛错'],
]) {
  const c = makeCtx(override)
  mod.apply(c, { enabled: false, fullAccess: false })
  const crpc = c._reg.rpc.get(mod.RPC_CHANNEL)
  const res = await crpc('set', { fullAccess: true })
  const note = String(res.value.sources.at(-1))
  check(id, `降级：${label} 时仍返回 ok 且如实说明`,
    res.ok === true && note.startsWith('fullAccess:'),
    note)
}

// ── 11. 幂等 ────────────────────────────────────────────────────────────────
const idem = makeCtx()
mod.apply(idem, { enabled: false, fullAccess: false })
const irpc = idem._reg.rpc.get(mod.RPC_CHANNEL)
const secBefore = idem._reg.sections.length
const ctxBefore = idem._reg.contexts.length
for (let i = 0; i < 10; i += 1) await irpc('toggle', {})
const finalSt = (await irpc('status', {})).value
check('V10.1', 'toggle x10 后回到关闭态且三段全空',
  finalSt.enabled === false && all.every((r) => r.text({}) === ''),
  `enabled=${finalSt.enabled}`)
check('V10.2', '反复切换不重复注册',
  idem._reg.sections.length === secBefore && idem._reg.contexts.length === ctxBefore,
  `sections=${idem._reg.sections.length} contexts=${idem._reg.contexts.length}`)

const a = (await irpc('recheck', {})).value
const b = (await irpc('recheck', {})).value
check('V10.3', 'recheck 幂等（连续两次结果一致且不改状态）',
  JSON.stringify(a) === JSON.stringify(b), `enabled=${b.enabled}`)

// ── 12. 依赖面 ──────────────────────────────────────────────────────────────
const idxSrc = fs.readFileSync(INDEX, 'utf8')
const imports = [...idxSrc.matchAll(/^\s*import\s+(?:[\s\S]*?from\s+)?['"]([^'"]+)['"]/gm)].map((m) => m[1])
check('V11.1', 'src/index.js 仅允许 schemastery + node:crypto',
  imports.every((i) => i === '@deepseek-ai/schemastery' || i.startsWith('node:')),
  `imports=${imports.join(', ')}`)

const cliSrc = fs.readFileSync(CLIENT, 'utf8')
const reqs = [...cliSrc.matchAll(/require\(['"]([^'"]+)['"]\)/g)].map((m) => m[1])
check('V11.2', "src/client.js 仅 require('react')",
  reqs.every((r) => r === 'react'), `requires=${[...new Set(reqs)].join(', ')}`)
check('V11.3', 'client.js 使用 __ModuleLoader__.load 且 id 正确',
  cliSrc.includes('__ModuleLoader__.load') && cliSrc.includes("id: 'dsh-armor-switch'"),
  'id=dsh-armor-switch')

// co: 缩进与结构校验（防止生成不可解析 YAML）
const patchYml = fs.readFileSync(path.join(ROOT, 'cordis.patch.yml'), 'utf8')
const insertIdx = patchYml.indexOf('- insert:')
const insertBlock = insertIdx >= 0 ? patchYml.slice(insertIdx) : ''
check('V12.1', 'cordis.patch.yml 含 insert 块且带 connection 覆盖',
  insertIdx >= 0 && /id:\s*armor-switch/.test(insertBlock) && /webServer/.test(patchYml),
  `insert@${insertIdx} webServer=${/webServer/.test(patchYml)}`)

console.log('\n' + '═'.repeat(72))
console.log(`contract fingerprint = ${mod.contractFingerprint()}`)
console.log(`verify: ${failures === 0 ? 'ALL-PASS' : failures + ' FAILURE(S)'}`)
console.log('═'.repeat(72))
process.exit(failures === 0 ? 0 : 1)
