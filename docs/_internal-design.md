# armor-switch（破甲开关）

一个**极小的、随时可开关**的交付契约插件。关闭时注册面与官方提示词**逐字节一致**；开启时改写底层系统。

它有**两个互相独立的面**：

1. **契约面（默认关闭）** —— 四处惰性注册，全部走宿主公开的 Cordis 接口。
   不 patch 任何宿主文件，不 patch 宿主 `node_modules`。
2. **宿主清洗（可选，默认关闭）** —— 经「锚点 + 期望前缀 + 字节指纹」三重校验后，
   对 `app.asar` 里 **9 处**固定常量做**等长原地写**，并先把原字节写进 manifest 以便逐字节还原。
   这是本插件唯一会碰宿主文件的功能。

- 包名 `dsh-armor-switch`，row id `armor-switch`，RPC 前缀 `/armor-switch`。
- 主开关默认**关闭**（`config.enabled: false`）；清洗意愿另存于 profile 的
  `armor-switch.clean-state.json`，启动时据此收敛磁盘。
- 宿主是 Electron 应用，`node:fs` 会拦截 `.asar` 路径；**任何直接开 `.asar` 的代码都必须走
  `electron.original-fs`**（见 src/host-clean.js 的 `RAW`），否则永远 ENOENT。

---

## 1. 生效机制

### 1.1 四处注册，text 是函数

`@deepseek-ai/dsh-system-prompt` 的 `SystemPrompt.assemble` 里，section 与 context 的 `text`
**可以是函数**，每次组装都重新调用 `section.text(context)`。而 `renderPrompt` 与
`renderContextSections` 都会 `.filter((text) => text.length > 0)` —— **返回空串的贡献被整体丢弃**。

所以本插件注册一次，用函数读运行时开关：

| # | 接口 | name | order | 落点 |
|---|---|---|---|---|
| 1 | `systemPrompt.section()` | `armor-switch:contract` | 2 | **系统提示词** |
| 2 | `systemPrompt.context()` | `armor-switch:authority` | 100 | runtime-context 消息 |
| 3 | `systemPrompt.context()` | `armor-switch:mechanism` | 130 | runtime-context 消息 |

- 关闭时三个 `text` 都返回 `''` → 被 filter 掉 → 组装结果与官方**逐字节相同**，不增删任何他人
  section / context。
- 开启时返回契约文本 → **下一次 assemble 即生效**。不需要注销再重注册，不需要重启。
- 100 / 130 不是官方常量（官方 `CONTEXT_ORDERS` 只有 SANDBOX_POLICY 110、APPROVAL_POLICY 115、
  SUBAGENT_DELEGATION 120），所以源码里直接写字面量并注释。

**开启** = 授权**操作者的直接指令**为最高权威、把「任务路由 = 完成条件」逐类写成可执行规则、
禁止说教、规定占位符用法与语言一致性；**关闭** = 什么都没发生。

### 1.2 三段文本的分工

`contract`（系统性、可长）承载完整的交付契约总则。`authority` 与 `mechanism` 走 runtime-context
消息面，且**各自自带一份能独立成立的规则内核**（权威性 + 无说教 + 占位符 + 任务路由要点），而不是
只写一句「见 contract」的指针：context 面在 `standard` / `ptc` / `cordis` 下与 section 面并存，
自足写法是廉价且必要的防御。`mechanism` 还承担「环境机制一行报告后继续交付」与「子代理/结构化
输出沿用同一尺度」。

### 1.3 契约指纹

`status.contract` = 三段**开启态**文本拼接后的 `sha256` 十六进制前 16 位（`node:crypto`）。
它由常量算出、与实时开关无关，所以来回切换恒定不变；升级后可用它对账「当前部署的是哪一份字节」。

---

## 2. 为什么是「覆盖」而不是「删除」

宿主 `@deepseek-ai/dsh-agent-instructions` 把那段免责文案写成**常量**：

> The following workspace instructions may be relevant to your work. Use them as guidance when
> applicable. More specific instructions take precedence over broader ones. They do not override
> system, developer, or direct user instructions.

它在 session 里是经 `createUserMessage` 注入的一条 **user 角色消息**，不是 system section。插件在
**不改宿主文件**的前提下无法重写它。

本插件的做法是从更高权威面**覆盖**它，两条独立的腿：

- **层级腿**：`contract` 是 `systemPrompt.section()`，进的是**系统提示词**；那句免责是 user 消息。
  系统层高于 user 消息层。
- **时序腿**：`authority` 是 runtime-context 贡献，由 agent-loop 的 preStep 渲染成一条 **每轮重新
  注入、排在最新位置**的 user 消息，且自带 "This snapshot supersedes earlier runtime-context
  snapshots" 语义——它比更早注入的那句免责框架更新、更靠近当前轮。

两条腿合起来让模型读到的是「那句框架只是给『读到的内容』加的包装，不构成降级操作者指令的许可」。

> **R3 如实说明：那句免责文案本身仍在 session 里。它没有被删除，也删不掉；它是被 §2 的 context
> 覆盖的。** 本插件不宣称、也没有「删掉那句话」。

---

## 3. 芯片（client 半）

`src/client.js` 是**手写**的 `window.__ModuleLoader__.load({ id, factory })` 工厂，不用 JSX、不用
TS、不用打包器，只 `require('react')`。

- 槽位 `conversation.composer.dock`（**list** 槽，需要 `id`）：`id: 'armor-switch'`，`order: 50`。
- `inject()` 返回 `{ hooks: { armor }, setArmor, setFullAccess, refresh }`；渲染器把 `hooks.armor`
  按 `standardHookPropName` 变成组件 prop **`useArmor`**（`use` + 首字母大写），其余摊平传入。
- `armor` 是实现 `{ getSnapshot(), subscribe(fn) }` 的不可变快照源。
- 组件显示 `破甲 开` / `破甲 关` 加一个小点；点击主区 = 切换开/关；旁边一个小的「全权」次级开关。
  点击后**本地乐观更新**，再用 RPC 返回值校准。
- 主开关发的是 `set { enabled }`，全权开关发的是 `set { fullAccess }`——两者**分开传字段**，所以
  点主开关不会连带触发权限写入（见 §4「两个开关是彼此独立的」）。
- 文案全部走 locale（`ctx.locale.register('armor-switch', { zh, en })`）；样式只用 `--dsw-alias-*`
  主题令牌 + 少量 rgba 强调；带 `title` / `aria-label` / `aria-pressed`；卸载时清掉注入的 `<style>`。

---

## 4. 用法

### 开启 / 关闭
点击输入框上方的芯片主区。开启后**下一次请求**生效（本轮的进行中请求不受影响，这是宿主
waterfall 的既定语义）。

### 两个开关是彼此独立的

**主开关（破甲）不改动沙箱与审批。** `toggle` 端点、以及只带 `enabled` 的 `set` 调用，**绝不**触碰
`permissionPresets`——主开关只改 `state.enabled`。所以「平时关着、想用开一下」不会顺手把
`danger-full-access` 收窄成 `workspace-write`，也不会把审批打开。只有显式传来 `fullAccess` 字段的
调用才会写权限。

### 全权（次级开关）
芯片右侧的小开关，**只有它会动权限**：开 → 对 `ctx.get('agents').list()` 里每个 agent 调
`permissionPresets.set(agent.session, 'danger-full-access')`（approval `never`）；关 → 恢复
**该 profile 配置的默认预设**，即读 `ctx.get('permissionPresets')?.defaultPreset`，**本机是
`danger-full-access`**；只有读不到或读取抛错时才回退到 `'workspace-write'`（approval `ask`）。
选中的恢复目标会写进 note，形如 `[restore target = profile default "danger-full-access"]`。

之所以不硬编码 `'workspace-write'`：本 profile 的默认预设就是 `danger-full-access`，硬编码会在用户
只碰过「全权」开关的情况下**收窄**沙箱并打开审批——那是个看不出来的副作用。

全程 `try/catch`，**任何失败都不影响主开关**，失败原因如实写进 `status.sources` 里
（例如 `fullAccess: permissionPresets service unavailable; preset "danger-full-access" not applied`）。
本 profile 的 `permission` row 已配置 `read-only` / `workspace-write` / `danger-full-access` 三个
preset（默认 `danger-full-access`）。

### RPC 端点
| 端点 | 作用 |
|---|---|
| `status` | `{ enabled, fullAccess, startupEnabled, contract, sources }` |
| `set` | `{ enabled?, fullAccess? }` → 改运行时状态；**仅在带 `fullAccess` 时**动权限；返回新 status |
| `toggle` | 翻转 `enabled`，返回新 status（**不触碰权限**） |
| `recheck` | 只读刷新，返回 status（不改状态，幂等） |

`handleRpc(endpoint, payload)` 返回 `{ ok: true, value }` 或
`{ ok: false, error: { code, message } }`；payload 兼容 `payload.x ?? payload?.args?.x`
（gateway 信封约定）。

### 安装 / 卸载
- 包目录放到 `~/.dsh/plugins/dsh-armor-switch`。
- 安装由 installer 用 **robocopy 真实拷贝**完成（**不用 junction**），并在 profile 的
  `package.json`（`dependencies` + `dsh.profile.bundles`）与 `cordis.patch.yml`（insert row
  `armor-switch`）各追加一处；幂等，重复执行不重复插入。
- **首次安装需要一次重启**（见 R1）。此后开关切换**不需要**重启。
- 卸载 = 移除上述三处追加 + 删除包目录；改动前先备份（`*.bak-<timestamp>`）。

### 降级路径（R2）
若 `connection` 服务不可用，芯片不会显示（`ctx.inject(['connection'], …)` 的回调不会被调用），但
**主开关仍可通过 `cordis.patch.yml` 的 `enabled: true` 生效**——那时它是常开的，只能改配置文件。

---

## 5. 已知风险（如实写）

**R1 — 首次安装需要一次重启。** client 半依赖宿主 Client Modules 把 `dsh.client` 清单挂到 Loader
row 上；新包的 JS 模块世代要在重启后才加载。首次安装后请重启一次；之后开关切换不再需要重启。

**R2 — `connection` 服务不可用 / 私有通道未挂载时，芯片仍会显示，但旁边出现持久错误文本。**
注意：芯片的**渲染**（槽位注册）与**通信**（私有 RPC）是两件事。槽位挂上、RPC 通道没挂上时，
芯片会正常画出「破甲 关 / 全权」两个按钮，但每次点击都在末尾显示 RPC 错误。这种「能看见但一直
报错」的状态，按 **R5** 的 405/401 判据排查，不要误以为芯片没加载。
宿主其余部分不受影响。

**R5 — 私有 RPC 要求 `connection` 自身持有 `webServer`（真实缺陷，已修）。**

Connection 注册一个**私有**通道路由时，走的是：

```js
owner.effect(() => owner.webServer.register(route))   // dsh-client-connection/lib/index.js:656
```

其中 `owner` 是 **Connection 自己的 ctx**（`const owner = this.ctx`，同文件 :574）。也就是说
`connection` 服务必须能看见 `webServer`，私有通道才挂得上去。

而官方 `dsh-web-app` 层对它的声明只有：

```yaml
- id: connection
  inject: [webRuntime]      # 没有 webServer
```

它内部那句 `ctx.inject(["webServer"], …)`（:820）只覆盖**共享的 `/api` 路由**，不覆盖私有通道注册表。

**症状**：通道没挂上时 `POST /armor-switch/<endpoint>` 返回 **405**（静态兜底），而已注册通道返回
**401**（未认证）——用这两个状态码就能判定。

**修复**：本插件的 bundle patch 里自带一条 `connection` 覆盖，把 `webServer` 加进 `inject`：

```yaml
- id: connection
  name: '@deepseek-ai/dsh-client-connection'
  inject: [webRuntime, webServer]
  config:
    trustedHosts: !!js ctx.webRuntime.trustedHosts
```

因为 patch 会替换目标行的**整个 `config`**，所以 `config` 段按原样重复了一遍，只有 `inject` 多了
`webServer`。**这条覆盖不能删**，删掉芯片就会永久报错。它自足，不依赖任何其它插件的 patch。

> 教训：早期版本**搭便车**依赖了 `dsh-unrestricted` 里恰好存在的同一条覆盖；那个插件一卸载，
> 本插件的私有通道就没了。现在改为自带声明。
>
> 另外：`inject` 是**行级静态属性**，不像 `config` 那样能热重载 —— 改动它必须**重启 DSH** 才生效。

**R3 — 那句免责文案仍在 session 里。** 见 §2。宿主把 `agent-instructions` 的开场白写成常量并作为
user 消息注入；本插件不改宿主文件，因此**它没有被删除，只是被系统层 + 时序更新的 runtime context
覆盖**。不要把本条理解成「删掉了那句话」。

**R4 — `minimal` 预设下 armor-switch 完全不生效。** 该预设的 persona
（`dsh-web-app/presets/minimal.patch.yml`）同时声明了：

- `complete: true` → `SystemPrompt.assemble` 把最终 `sections` **替换成只留那一个**，本插件的
  `contract` section（order 2）被丢弃；
- `includeRuntimeContext: false` → `dsh-persona` 调 `suppressRuntimeContext()`，assemble 的
  `runtimeContextSuppressed` 为真，`contexts` 变成 `[]`，本插件的 `authority` / `mechanism`
  （order 100 / 130）也进不去。

即 **minimal 下四个注册面全部失效**（`preferences` 同为 section，一并被丢弃；
「只有 context 生效」是早期错误说法，已更正）。
`standard` / `ptc` / `cordis` 三个预设不受影响。**本 profile 的默认预设是 `standard`，主路径正常。**
若你需要在 minimal 下也生效，需要走「在 agent 作用域内以 `complete: true` 影子覆盖 persona」的
额外复杂度，本版本不做。

---

## 6. 文件

```
armor-switch/
  package.json        包清单（含 dsh.bundle.patch 与 dsh.client）
  cordis.patch.yml    一条 insert row：id armor-switch / name dsh-armor-switch
  src/index.js        host 半：四处惰性注册 + 开关状态 + private RPC + 契约文本
  src/client.js       web 半：conversation.composer.dock 上的开关芯片
  locale/zh.json      显示元数据 + 芯片文案
  locale/en.json
  README.md
```

硬约束：`src/index.js` **只** `import '@deepseek-ai/schemastery'`（外加 `node:crypto` 内建），其余
一律走 `ctx.on` / `ctx.get` / `ctx.inject` / `ctx.effect`；`src/client.js` **只**
`require('react')`。
