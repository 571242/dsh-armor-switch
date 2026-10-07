# armor-switch · 破甲开关

> 一个**极小的、随时可开关**的交付契约插件，用于 DeepSeek Harness。
> **关闭时 = 官方原样（逐字节相同）；开启时 = 改写底层系统。**
> 全程**不修改任何宿主文件** —— 不 patch `app.asar`，不 patch 宿主 `node_modules`。

![license](https://img.shields.io/badge/license-MIT-blue.svg)
![platform](https://img.shields.io/badge/platform-DeepSeek%20Harness%20Desktop-4B6BFB.svg)
![dsh](https://img.shields.io/badge/DSH-0.2.0--rc.2-orange.svg)
![runtime deps](https://img.shields.io/badge/runtime%20deps-1-brightgreen.svg)
![build](https://img.shields.io/badge/build%20step-none-success.svg)

---

## 目录

- [这是什么](#这是什么)
- [快速开始](#快速开始)
- [它做对了什么](#它做对了什么)
- [工作原理](#工作原理)
- [与其他方案对比](#与其他方案对比)
- [已知限制（必读）](#已知限制必读)
- [卸载](#卸载)
- [English](#english)

---

## 这是什么

DSH 的模型行为由「系统提示词 + 运行时上下文」共同决定。`armor-switch` 在**不改动宿主任何文件**的
前提下，往这两个面上注册三段可随时启停的规则文本：

| 开关 | 模型看到的东西 |
|---|---|
| **关**（默认） | 与官方**逐字节相同**。三段都返回空串，被宿主渲染时整体丢弃，不增删任何他人 section。 |
| **开** | 交付契约生效：授权操作者指令为最高权威、把「请求 → 交付物」逐类写成可执行规则、禁止说教、规定占位符与语言一致性。 |

关键点：**开启/关闭是热切换的，只影响下一次请求，不需要重启 DSH。**

> ⚠️ **本插件的实质**：它改写的是**模型侧的指令契约** —— 让 Agent 不再对合法请求做过度自我审查、
> 不再用免责话术替代交付。它**不能**绕过模型供应商的云端内容审核，也不改变任何网络层能力。
> 请先读完[已知限制](#已知限制必读)再决定是否使用。

---

## 快速开始

### 环境要求

- DeepSeek Harness **Desktop 0.2.0-rc.2**（`@deepseek-ai/dsh` 0.2.0-rc.2）
- Windows（安装脚本为 PowerShell）
- Node.js（DSH 自带运行时即可）

### 安装

```powershell
# 把本仓库放到 ~/.dsh/plugins/dsh-armor-switch
git clone <你的仓库地址> "$env:USERPROFILE\.dsh\plugins\dsh-armor-switch"
cd "$env:USERPROFILE\.dsh\plugins\dsh-armor-switch"

# 预览将要做的改动（不落盘）
powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\install.ps1 -WhatIf

# 真装
powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\install.ps1
```

装完**重启一次 DSH Desktop**，输入框上方会出现芯片 **「破甲 关」**。
点击主区即可开关；之后的切换**不需要**再重启。

### 安装脚本会做什么

| # | 动作 | 目标 |
|---|---|---|
| 1 | 同步源码到中转目录 | `%USERPROFILE%\.dsh\plugins\dsh-armor-switch` |
| 2 | **真实拷贝**（`robocopy /E`，不是 junction） | `<profile>\node_modules\dsh-armor-switch` |
| 3 | `dependencies` + `dsh.profile.bundles` 各加一项 | `<profile>\package.json` |
| 4 | 末尾追加按 id 覆盖 `config` 的块 | `<profile>\cordis.patch.yml` |
| — | 改前自动备份 | `*.bak-<时间戳>` |

脚本**幂等**，可反复执行；它会自动探测 profile 路径，也支持 `-ProfilePath` 显式指定。

> **为什么必须是真实拷贝而不能用 `mklink /J`**
> Node 会把 junction `realpath` 解析回 `plugins\` 的真实目录，于是从那一侧向上查找 `node_modules`
> 时找不到 profile 里 hoisted 的 `@deepseek-ai/schemastery`，插件启动即报
> `ERR_MODULE_NOT_FOUND`。真实拷贝后模块位于 profile 的 `node_modules` 树内，向上查找命中。

### 验证安装

```powershell
node .\scripts\verify.mjs
```

该脚本会在假 Cordis 上下文里跑完整套断言（隐身性、注册位置、RPC、幂等、降级路径），
**无需真实宿主即可运行**，29 项断言全绿即为通过。

若还要验证**安装脚本本身**（它写进 profile 的 patch 必须是合法 YAML）：

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\verify-installer.ps1
```

---

## 它做对了什么

### 1. 关闭即隐身：字节级等价

宿主的 `SystemPrompt.assemble` 允许 section/context 的 `text` 是**函数**，每次组装重新求值；
而 `renderPrompt` 与 `renderContextSections` 都会 `.filter((text) => text.length > 0)`。

所以本插件注册一次，用函数读运行时开关：**关闭时返回 `''`，贡献被整体丢弃**。
模型收到的提示词与官方逐字节相同 —— 不是「看起来差不多」，是真的一个字节都不差。

### 2. 热切换，零重启

开关真值只存在内存里，下一次 assemble 立即反映。不需要注销/重注册，不需要重启进程。
（唯一需要重启的是**首次安装**，因为客户端模块世代要重新挂载。）

### 3. 零外部依赖、零构建

宿主半只 `import '@deepseek-ai/schemastery'`（profile 里真实存在）与 `node:crypto` 内建；
客户端半是手写的 `window.__ModuleLoader__` 工厂，只 `require('react')`。
**不用 JSX、不用 TS、不用打包器** —— 源码即产物，没有任何构建步骤。

这意味着它既能在裸 Node 下解析，也能在 DSH Loader 的运行时解析下工作，
**不会因为依赖解析差异而失效**。

### 4. 主开关与权限严格解耦

这是被真实缺陷教育出来的设计（见 [CHANGELOG](CHANGELOG.md) 的 A7）：

- **主开关（破甲）绝不触碰沙箱与审批。** 它只改契约。
- **只有显式传入 `fullAccess` 字段时**才会动权限。
- 「全权」关闭时，恢复目标是**读 profile 自己的 `permissionPresets.defaultPreset`**，
  而不是硬编码 `workspace-write`。

为什么最后一条重要：如果 profile 的默认预设本来就是 `danger-full-access`，硬编码
`workspace-write` 会在用户只碰过「全权」开关的情况下**把沙箱悄悄收窄、把审批打开** ——
而 UI 上完全看不出来。

---

## 工作原理

### 三处注册

| # | 接口 | name | order | 落点 |
|---|---|---|---|---|
| 1 | `systemPrompt.section()` | `armor-switch:contract` | 2 | **系统提示词** |
| 2 | `systemPrompt.context()` | `armor-switch:authority` | 100 | runtime-context 消息 |
| 3 | `systemPrompt.context()` | `armor-switch:mechanism` | 130 | runtime-context 消息 |

`100` / `130` 不是官方常量（官方 `CONTEXT_ORDERS` 只有 `SANDBOX_POLICY 110`、
`APPROVAL_POLICY 115`、`SUBAGENT_DELEGATION 120`），所以源码里直接写字面量并注释说明。

三段文本**各自自带能独立成立的规则内核**，而不是只写指向彼此的指针 ——
这样即使未来某个预设改用 `complete: true` 丢掉 section 面，context 面仍然够用。

### 为什么是「覆盖」而不是「删除」

宿主 `@deepseek-ai/dsh-agent-instructions` 把这段开场白写成**常量**，并经 `createUserMessage`
作为 **user 角色消息**注入：

> The following workspace instructions may be relevant to your work. Use them as guidance when
> applicable. More specific instructions take precedence over broader ones. They do not override
> system, developer, or direct user instructions.

在不改宿主文件的前提下，插件**无法**重写它。本插件从更高权威面覆盖，两条独立的腿：

- **层级腿**：`contract` 走 `systemPrompt.section()`，进的是**系统提示词**；那句开场白是 user 消息。
- **时序腿**：`authority` 走 runtime-context，由 agent-loop 的 `preStep` 渲染成一条
  **每轮重新注入、排在最新位置**的 user 消息。

> **如实说明：那句开场白本身仍在 session 里。它没有被删除，也删不掉；它是被覆盖的。**
> 本插件不宣称、也没有「删掉那句话」。

### 私有 RPC 通道

芯片通过 Connection 的私有通道路由与宿主半通信：

```
POST /armor-switch/{status|set|toggle|recheck}
```

Connection 注册私有通道时用的是 **Connection 自己的 ctx**，所以它必须能看见 `webServer`
服务；而官方 `dsh-web-app` 层只声明了 `inject: [webRuntime]`。因此本插件的 bundle patch 里
**自带一条 `connection` 覆盖**，把 `webServer` 加进 `inject`。

**这条覆盖不能删** —— 删掉之后私有通道挂不上，芯片会永久报错。
（早期版本搭便车依赖了另一个插件里恰好存在的同一条覆盖，那个插件一卸载本插件就坏；
现已改为自带声明。）

---

## 与其他方案对比

|  | armor-switch | 改 asar 类方案 | 逐字锚点替换类方案 |
|---|---|---|---|
| 宿主文件侵入 | **零**（纯标准扩展面） | 严重（改官方代码） | 中（引入重依赖） |
| 关闭后是否原样 | **逐字节相同** | 否（不可关闭） | 否（常驻） |
| 开关是否需要重启 | **否**（仅首次安装需要） | — | — |
| 运行时依赖 | **1** | 多 | 多 |
| 宿主升级脆弱性 | **低**（只用公开接口） | 极高（升级必坏） | 中高（锚点失配即失效） |
| 构建步骤 | **无**（源码即产物） | 有 | 有 |

---

## 已知限制（必读）

### L1 — `minimal` 预设下本插件完全不生效

`minimal` 预设的 persona 同时声明了：

- `complete: true` → `SystemPrompt.assemble` 把最终 `sections` **替换成只留那一个**，
  本插件的 `contract` section（order 2）被丢弃；
- `includeRuntimeContext: false` → `dsh-persona` 调用 `suppressRuntimeContext()`，assemble 的
  `contexts` 变成 `[]`，本插件的两个 context（order 100/130）也进不去。

即 **`minimal` 下三处注册全部失效**（注意：不是「只有 context 生效」）。
`standard` / `ptc` / `cordis` 三个预设不受影响。

### L2 — 首次安装需要重启一次

客户端半依赖宿主把 `dsh.client` 清单挂到 Loader row 上，新包的 JS 模块世代要在重启后才加载。
首次安装后请重启一次；之后开关切换不再需要重启。

### L3 — 那句免责开场白仍在 session 里

见[上文](#为什么是覆盖而不是删除)。它是被覆盖，不是被删除。

### L4 — 无法绕过服务端内容审核

本插件改写的是**客户端提示词契约**。模型供应商在网络层部署的内容审核/风控**不受其影响**。
如果你的请求被服务端拦截，本插件帮不上忙。

### L5 — 状态是进程级的

开关真值是模块级单例，**对整个 DSH 实例生效**：你在一个窗口开启，其它窗口、后台任务、
Agent Team 也会同时进入该状态。

### L6 — `connection` 服务不可用时芯片会显示但报错

芯片的**渲染**（槽位注册）与**通信**（私有 RPC）是两件事。槽位挂上而 RPC 通道没挂上时，
芯片会正常画出两个按钮，但每次点击都显示 RPC 错误。

按状态码判定：`POST /armor-switch/<endpoint>` 返回 **405** = 通道未挂载（静态兜底）；
返回 **401** = 已注册通道待认证（正常）。

此时主开关仍可通过 `cordis.patch.yml` 里的 `enabled: true` 生效（但那是常开，只能改配置文件）。

---

## 卸载

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\uninstall.ps1
```

卸载会移除：`node_modules` 下的真实拷贝目录、`package.json` 的 `dependencies` / `bundles` 项、
`cordis.patch.yml` 的覆盖块，并可选清理中转目录与备份文件。
**默认不会删除** `~/.dsh/plugins/dsh-armor-switch` 源目录（除非显式传 `-PurgeSource`）。

---

## 仓库结构

```
.
├── package.json            包清单（dsh.bundle.patch + dsh.client）
├── cordis.patch.yml        bundle 层：一条 insert row + 一条 connection 覆盖
├── src/
│   ├── index.js            宿主半：三处惰性注册 + 开关状态 + 私有 RPC + 契约文本
│   └── client.js           客户端半：composer dock 上的开关芯片（手写工厂）
├── locale/{zh,en}.json     显示元数据与芯片文案
├── scripts/
│   ├── install.ps1         幂等安装
│   ├── uninstall.ps1       完整回滚
│   ├── verify.mjs          离线自检（29 项断言，无需真实宿主）
│   └── verify-installer.ps1 安装脚本回归（生成的 patch 必须是合法 YAML）
├── docs/
│   ├── ARCHITECTURE.md     设计深挖：为什么是这三个注册面
│   └── TROUBLESHOOTING.md  故障排查
├── CHANGELOG.md
└── LICENSE                 MIT
```

---

## 契约指纹

`status.contract` 是三段开启态文本拼接后的 `sha256` 前 16 位。它由常量算出、与实时开关无关，
所以来回切换恒定不变；**升级后可用它对账「当前部署的是哪一份字节」**。

当前版本指纹：运行 `node scripts/verify.mjs` 即可看到。

---

## English

`armor-switch` is a **tiny, always-toggleable delivery-contract plugin** for DeepSeek Harness.

- **Off (default) = byte-identical to the stock prompt.** All three contributions return an empty
  string, which the host drops while rendering.
- **On = rewrites the delivery contract** starting with the next request. No restart required.
- **Zero host file modification.** No `app.asar` patching, no host `node_modules` patching.
- **No build step.** The source *is* the artifact: one `import` (`schemastery`) plus `node:crypto`.

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\install.ps1 -WhatIf   # preview
powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\install.ps1           # apply
# restart DSH Desktop once; a chip appears above the composer.
```

**Important limitations:** under the shipped `minimal` preset this plugin has **no effect** (that
persona declares both `complete: true` and `includeRuntimeContext: false`). The first install needs
one restart. It rewrites the *client-side* prompt contract only — it cannot bypass a model
provider's server-side content moderation.

A full English write-up lives in [README.en.md](README.en.md).

---

## License

[MIT](LICENSE)
