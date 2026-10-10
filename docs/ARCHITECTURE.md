# 架构深挖：为什么是这三个注册面

> 本文记录 `armor-switch` 的设计推导过程与在宿主源码里逐条核对过的事实。
> 目标环境：DeepSeek Harness **Desktop 0.2.0-rc.2**（`@deepseek-ai/dsh` 0.2.0-rc.2），
> 宿主代码位于 `app.asar`。**所有 API 事实都是从该 asar 中反查确认的，不是凭记忆猜的。**

---

## 0. 设计目标与硬约束

### 目标

一个**极小的、随时可开关**的破甲插件。开关前 = 官方原样（**注册面**字节级相同）；开关后 = 改写底层系统。

### 硬约束

1. **契约面绝不修改任何宿主文件** —— 不 patch 宿主 `node_modules`；四处注册全部只用宿主公开的 Cordis 接口。
   **唯一的例外是「宿主清洗」**（独立开关，默认关闭）：它按同一文档 §清洗 所述，
   对 `app.asar` 中 9 处常量做等长原地写，并先把原字节落盘以便逐字节还原。
   这条早期写成「绝不修改任何宿主文件」，与 1.1.x 引入清洗后的实现不符 —— 已更正。
2. `src/index.js` **只允许** `import '@deepseek-ai/schemastery'`（profile 里确实存在）＋
   `node:crypto` 内建。其余一律用 `ctx.on` / `ctx.get` / `ctx.inject` / `ctx.effect`。
3. `src/client.js` 是**手写**的 `window.__ModuleLoader__.load({id, factory})` 工厂，
   只 `require('react')`：**不用 JSX、不用 TS、不用打包器**。
4. 开关**默认关闭**。
5. 关闭状态下，模型看到的组装结果必须与官方完全一致。
6. 安装后**不得要求重启才能切换运行时契约**；只有首次安装需要一次重启。
   宿主清洗的字节**立即写盘**，但宿主只在启动时读入这些常量，所以**要让模型读到必须重启** ——
   这两件事的时机不同，不能混为一谈。

### 为什么约束 1 和 2 必须一起成立

约束 1 排除了「改宿主源码」这条捷径；约束 2 则进一步排除了「靠引入宿主内部包来拿到能力」。
后者常被低估：如果插件 `import '@deepseek-ai/dsh-system-prompt'` 之类的内部包，它就绑定了
宿主的模块解析行为 —— 裸 Node 跑不通（`ERR_MODULE_NOT_FOUND`），而 DSH Loader 有自己的运行时
解析（`@deepseek-ai/dsh-app-boot` 的 `createRuntimeResolution`，会把安装作用域的包也纳入解析）。

**裸 node 跑不通 ≠ 插件加载不了**，但这个差异会让调试和验证变得不可靠。
本插件选择**零外部 import**（只要 `@deepseek-ai/schemastery`，它在 profile 里真实存在），
因此无论走裸 node 还是 Loader 解析都稳 —— 这直接让 `scripts/verify.mjs` 可以在无宿主环境下运行。

---

## 1. 核心洞察：`text` 可以是函数，空串会被过滤

一切设计的地基是这两条事实（已从 `@deepseek-ai/dsh-system-prompt/lib/index.js` 逐行读出）：

- **第 340-347 行**：section/context 的 `text` **可以是函数** —— 每次 assemble 都会重新调用
  `section.text(context)`。
- **第 114 行 `renderPrompt`**：结尾是 `.filter((text) => text.length > 0)`。
- **第 148-150 行 `renderContextSections`**：同样 `.filter((text) => text.length > 0)`。
- **第 355 行**：`system-prompt/assemble` 是 waterfall，以返回值为准。

**推论**：注册一次，用函数读运行时开关即可。

- 关闭时返回 `''` → 被 filter 掉 → **组装结果与官方字节级一致**，不增删任何他人 section。
- 开启时返回契约文本 → **下一次请求即生效**。

**不需要**注销/重注册，**不需要**重启。这是整个插件能做到「热切换」的全部原因 ——
不是靠什么热重载机制，而是靠「贡献本身就是惰性的」。

---

## 2. section 与 context 的落点不同（这是最关键的区分）

初学者最容易在这里搞错，认为 `systemPrompt.section()` 和 `systemPrompt.context()` 只是
「同一件事的两个位置」。**不是。**

### (a) 落点

| 接口 | 落点 |
|---|---|
| `systemPrompt.section()` | 进**系统提示词**（由 `renderPrompt` 渲染） |
| `systemPrompt.context()` | **不进系统提示词** |

`dsh-agent-loop` 的 `preStep`（第 907-918 行）把 `renderContextSections(assembly)` 渲染成
`"Current runtime context. This snapshot supersedes earlier runtime-context snapshots."`
这条 **user 角色消息**，追加在 claimed messages **之后**。

（沙箱策略、审批策略就是这么进模型上下文的 —— 它们是 context，不是 section。）

### (b) `complete: true` + `includeRuntimeContext: false` 会同时废掉两者

`SystemPrompt.assemble`：

- 第 335-336 行：存在 `complete` section → 第 357-360 行最终 `sections` 被**替换成
  `[completeSection]` 一个**，其它 section 全部丢弃。
- 第 313 行：`runtimeContextSuppressed = !global.runtimeContextSuppressors.isEmpty() || scopeLayers.some(...)`
  → 第 347、360 行 `contexts: runtimeContextSuppressed ? [] : ...`，**抑制时所有 context 为空**。
- 抑制器来自 `dsh-persona/lib/index.js` 第 47 行：
  `if (!(config.includeRuntimeContext ?? true)) ctx.systemPrompt.suppressRuntimeContext()`。

### (c) 四个官方预设的实际影响

| preset | persona 配置 | 本插件 section(order 2) | 本插件 context(100/130) |
|---|---|---|---|
| `standard` | 无 complete | 生效 | 生效 |
| `ptc` | 无 complete | 生效 | 生效 |
| `cordis` | 无 complete | 生效 | 生效 |
| **`minimal`** | `complete: true` **且** `includeRuntimeContext: false` | **被丢弃** | **被抑制** |

→ **`minimal` 下四个注册面全部失效**（含 `preferences`，它也是 section）。

> 这正是 README 的 L1 条目的来源。它是一条被如实记录的**已知失效面**，而不是被掩盖的缺陷。
> 本 profile 默认 preset 是 `standard`，主路径不受影响。

**由此得出的实现要求**：三段文本**各自自带能独立成立的规则内核**，不能只写指向彼此的指针 ——
这样即使未来某个预设改用 `complete: true` 丢掉 section 面，context 面仍然够用。

---

## 3. 为什么必须走「覆盖」而不是「删除那句免责文案」

宿主 `@deepseek-ai/dsh-agent-instructions/lib/index.js` 第 113-114 行把开场白写成**常量**：

```js
const AGENT_INSTRUCTIONS_INTRO = "The following workspace instructions may be relevant to your
work. Use them as guidance when applicable. More specific instructions take precedence over
broader ones. They do not override system, developer, or direct user instructions.";
```

它在第 766-796 行经 `createUserMessage` 作为 **user 角色消息**注入进 session（不是 system section）。

**插件在不改宿主文件的前提下无法重写它。** 所以正确做法是从更高权威面覆盖，两条独立的腿：

1. **层级腿**：`contract` 注册的是 `systemPrompt.section()`，它确实进**系统提示词**
   （`renderPrompt`），而那句免责是 **user 角色消息**。在模型看到的最终结构里，
   系统提示词高于用户消息。
2. **时序腿**：`authority` 是 `systemPrompt.context()`，被 agent-loop 的 `preStep`
   （第 907-917 行 `[...claimed, context]`）渲染成一条**最新的 user 消息**，
   位于所有已 claim 消息**之后**。它每轮重新注入、排最新，并在文本里明确该免责框架
   「不是降级操作者指令的许可」。

### 两个必须避免的错误说法

- ❌ 「authority context 排在 user 消息之前」—— **错**。它是 `[...claimed, context]`，
  排在 claimed **之后**。正确表述是上面两条腿。
- ❌ 「本插件删掉了那句免责文案」—— **错**。**关清洗**时那句常量仍在 session 里，只是被覆盖；
  **开清洗**时它的`app.asar`字节被改写（等长原地写），但仍需重启才被模型读到。
  两种状态下都不存在「从 session 里删掉」这回事。
  README 与 CHANGELOG 都如实记录这一点（L3）。

---

## 4. 四处注册的分工

| # | 接口 | name | order | 作用 |
|---|---|---|---|---|
| 1 | `ctx.systemPrompt.section` | `armor-switch:contract` | 2 | 交付契约总则（把「底层系统」本身改掉） |
| 2 | `ctx.systemPrompt.context` | `armor-switch:authority` | 100 | 指令权威性：中和 workspace-instruction 免责框架 |
| 3 | `ctx.systemPrompt.context` | `armor-switch:mechanism` | 130 | 环境机制与执行：沙箱/审批如实一行 + 继续交付 |

### order 的选择依据

官方排序常量（`dsh-system-prompt` 第 10-48 行）：

```
SECTION: HARNESS_IDENTITY -1000, DEPLOYMENT_PERSONA_PREFIX 0,
         PLAN_POLICY 500, TEAM_POLICY 600, PTC_ONLY 800, ...
CONTEXT: SANDBOX_POLICY 110, APPROVAL_POLICY 115, SUBAGENT_DELEGATION 120
```

- `contract` 用 **order 2**：故意紧跟在 `DEPLOYMENT_PERSONA_PREFIX`（0）之后 ——
  它是一条「前缀规则」，要尽早定调。
- `authority` 用 **100**：刚好在 `SANDBOX_POLICY`（110）之前。
- `mechanism` 用 **130**：刚好在 `SUBAGENT_DELEGATION`（120）之后。

**注意**：100 和 130 都**不是官方常量**，所以源码里直接写字面量并注释说明，
不假装它们来自官方表。

---

## 5. 开关状态、持久化与权限

### 状态

```js
const state = { enabled: false, fullAccess: false, startupEnabled: false, notes: [] }
```

放在**模块级**是刻意的：RPC handler 和三个 `text` 函数必须读**同一个**真值，
而 `apply` 每个模块只跑一次。

`Config` **故意不加 `.volatile()`**：本插件不依赖 settings/volatile 的热更新语义，
避免出现「开关写不回去导致不可用」的失败模式。持久化是**可选增强**：
`ctx.get('settings')` 可用时才尝试写回，失败只在返回里报原因，**绝不能让开关不可用**。

### 权限（A7 缺陷的教训）

**这是本项目最重要的一条设计规则**，来自一个被独立验证发现的真实缺陷：

> 早期实现里，「关闭破甲」会把每个 live agent 的 session 写成
> `workspace-write` + approval `ask`。而在本 profile 默认预设为 `danger-full-access` 的情况下，
> 这等于**用户只点了一下破甲开关，沙箱被悄悄收窄、审批被打开**，并且 UI 上完全看不出来。

现在的硬性规则（源码里有对应注释，`scripts/verify.mjs` 有回归断言）：

1. **主开关（enabled）绝不触碰权限。** `toggle`、以及 `set` 里只带 `enabled` 的调用，
   都不得调用 `applyFullAccess`。
2. **只有显式传入 `fullAccess` 字段时才动权限**
   （判据：`field(payload,'fullAccess') !== undefined`）。
3. **恢复目标读 profile 的默认预设**，不要硬编码：
   `ctx.get('permissionPresets')?.defaultPreset`；读不到才回退 `'workspace-write'`。
   选中的预设名要写进返回的 note。
4. 全程 `try/catch`，任何失败**不得**影响主开关。

这套规则直接落实了 §0 的「关闭 = 官方原样」。

---

## 6. 私有 RPC 通道与那条 `connection` 覆盖

### 为什么必须有那条覆盖

Connection 注册**私有**通道路由时走的是：

```js
owner.effect(() => owner.webServer.register(route))   // dsh-client-connection/lib/index.js:656
```

其中 `owner` 是 **Connection 自己的 ctx**（`const owner = this.ctx`，同文件 :574）。

也就是说 `connection` 服务**必须能看见 `webServer`**，私有通道才挂得上去。
而官方 `dsh-web-app` 层对它的声明只有：

```yaml
- id: connection
  inject: [webRuntime]      # 没有 webServer
```

它内部那句 `ctx.inject(["webServer"], …)`（:820）只覆盖**共享的 `/api` 路由**，
不覆盖私有通道注册表。

**症状**：通道没挂上时 `POST /armor-switch/<endpoint>` 返回 **405**（静态兜底），
而已注册通道返回 **401**（未认证）—— 用这两个状态码就能判定。

**修复**：插件的 bundle patch 自带一条 `connection` 覆盖，把 `webServer` 加进 `inject`：

```yaml
- id: connection
  name: '@deepseek-ai/dsh-client-connection'
  inject: [webRuntime, webServer]
  config:
    trustedHosts: !!js ctx.webRuntime.trustedHosts
```

因为 patch 会替换目标行的**整个 `config`**，所以 `config` 段按原样重复了一遍，
只有 `inject` 多了 `webServer`。

### 一条重要的教训

早期版本**搭便车**依赖了另一个插件（`dsh-unrestricted`）里恰好存在的同一条覆盖。
那个插件一卸载，本插件的私有通道就没了。

**现在改为自带声明，自足，不依赖任何其它插件的 patch。**

> 另注：`inject` 是**行级静态属性**，不像 `config` 那样能热重载 ——
> 改动它必须**重启 DSH** 才生效。

---

## 7. 安装：为什么必须是真实拷贝

**用 `robocopy` 真实拷贝到 profile 的 `node_modules`，不要用 `mklink /J` junction。**

证据（裸 node 22，本机 runtime）：

```
A) junction  profile\node_modules\dsh-armor-switch -> plugins\dsh-armor-switch
   import '@deepseek-ai/schemastery'  →  ERR_MODULE_NOT_FOUND
B) real copy profile\node_modules\dsh-armor-switch  (robocopy /E)
   import '@deepseek-ai/schemastery'  →  OK
```

原因：Node 把 junction `realpath` 解析到真实目录（`plugins/dsh-armor-switch/src/index.js`），
于是从 `plugins/` 那一侧向上找 `node_modules/@deepseek-ai/schemastery`，找不到；
真实拷贝后模块位于 `profiles/desktop/node_modules/` 树内，向上查找命中 profile 的 hoisted 依赖。

**诚实限定**：这只证了**裸 node** 的行为。DSH 的 Loader 有自己的运行时解析，
junction 在 Loader 下**可能**也能跑 —— 但**未经实测，不要假设**。
选择真实拷贝的理由是它**双路径都证明可行**，且与 pnpm hoisted linker 对 `file:` 依赖的行为一致。

**结论：安装 = robocopy 真实拷贝。** 副作用：改源码不会自动进 profile，
改了要重跑安装脚本 —— 这反而让安装态稳定、可预测。

---

## 8. 契约指纹

`status.contract` = 三段**开启态**文本拼接后的 `sha256` 十六进制前 16 位（`node:crypto`）。

它由常量算出、**与实时开关无关**，所以来回切换恒定不变；升级后可用它对账
「当前部署的是哪一份字节」。

---

## 9. 已知风险汇总

| # | 风险 | 状态 |
|---|---|---|
| L1 | `minimal` 预设下四个注册面全部失效 | 如实记录，主路径不受影响（默认 `standard`） |
| L2 | 首次安装需要一次重启（客户端模块世代） | 已记录，后续切换无需重启 |
| L3 | 免责开场白：关清洗时被覆盖，开清洗时被改写（重启后生效） | 如实记录，两种状态都不等于「删除」 |
| L4 | 无法绕过服务端内容审核 | 已记录（改的是客户端契约） |
| L5 | 开关状态是进程级的 | 已记录；按会话隔离列入未来规划 |
| L6 | `connection` 不可用时芯片显示但报错 | 已记录 + 405/401 判据 + 降级路径 |

---

## 10. 未做的增强（明确记录，不在本版本）

1. **按会话隔离的开关**：`state` 目前是模块级单例。要做 per-session 需要 RPC 带 `sessionId`
   并以 Map 存储。
2. **`minimal` 预设下的影子覆盖**：像某些方案那样在 `agent.ctx` 上注册同名
   `deployment:persona-prefix` + `complete: true` 影子来覆盖 minimal。需要
   `agent/created` / `agent/disposed` / `agentPresets.composedPreset`，
   且要重建整个 minimal persona —— 复杂且随宿主升级易碎。
3. **芯片感知 `minimal` 预设**：检测到当前预设会让插件失效时置灰或给 warning 标记。
