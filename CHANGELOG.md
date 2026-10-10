# Changelog

本文件记录本项目的所有重要变更。
格式参考 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)，
版本号遵循 [语义化版本](https://semver.org/lang/zh-CN/)。

---

## [1.1.2] — 2026-10-10

### Fixed

- **宿主清洗在 Electron 下完全失效（真实缺陷，已修）**：`host-clean.js` 用 `node:fs` 直接
  打开 `app.asar` 本体，而 Electron 的 `node:fs` 会拦截所有 `.asar` 路径并把它当归档**内部**
  解析 —— `openSync(path,'r+')` 恒抛 `ENOENT`、`statSync().size` 恒返回 `0`。
  异常被 `apply` 的 `try/catch` 静默吞掉，磁盘一个字节都没动，表现为
  **「点清洗没反应，重启也没反应」**。

  修复：新增 `RAW`（`electron.original-fs`，纯 Node 下自动退回 `node:fs`），
  把 `host-clean.js` 5 处、`maintenance.js` 4 处**按路径**访问归档的调用全部改走它；
  按 fd 操作的调用不受影响。同一缺陷也存在于 `dsh-armor-clean` 与 release 源码，已一并修复。

  验证：Electron 44 运行时下 —— 读活体归档 9/9、写副本 9/9、还原 9/9、还原后 `sha256`
  与原文件**逐字节相同**；真件往返 `983ca711…` ⇄ `3247f6b0…` 双向通过。

### Changed

- **文档更正**：此前多处表述与实现不符，已统一改为准确说法 ——
  - 「绝不修改任何宿主文件」→ 契约面不碰宿主；**宿主清洗是唯一例外**（9 处等长原地写，可逐字节还原）。
  - 「关闭后逐字节相同」→ 限定为**注册面**；清洗开关独立，关主开关不会自动还原 `app.asar`。
  - 「开关不需要重启」→ 明确区分**写盘**（不用重启）与**读盘**（必须重启）。
  - 「三处注册」→ 实际 **4 处**（新增常驻的 `armor-switch:preferences`，order 200）。
  - 「`verify.mjs` 29 项断言」→ 实测 **39 项**。
  - L3 补充：开清洗时那句开场白是**被改写**（重启后生效），关清洗时是**被覆盖**；两种状态都不等于删除。

## [1.1.1] — 2026-10-10

### Fixed

- 宿主审批提示词不再误改 `lib/types/index.js` 后就宣称生效；新增真正运行的
  `lib/index.js` 与 `lib/invariant.js` 目标，同时保留旧目标以兼容并恢复既有清单。
- 运行时契约开关改用 `armor-switch.state.json` 原子持久化，开启和关闭都会保存，重启不丢状态。
- Profile 状态检查、写入和移除统一使用同一解析器；旧版本块不再误报为 `edited`。
- Profile 移除不再全局压缩其它配置中的空行。
- 宿主恢复只在全部目标已还原或本来为原样时报告成功。
- 插件详情页同时显示运行时、宿主和 Profile 状态，支持独立切换与“一键全部启用/关闭”。

### Verified

- 真实 ASAR 副本上完成两轮 9/9 目标启用→关闭往返。
- 旧 Profile 块迁移、再次创建/移除和运行时状态 true/false 持久化通过。

## [1.0.0] — 2026-10-07

首个公开版本。

### Added

- **三处惰性注册**：`armor-switch:contract`（section，order 2，进系统提示词）、
  `armor-switch:authority`（context，order 100）、`armor-switch:mechanism`（context，order 130）。
  三者的 `text` 都是函数，每次 assemble 重新求值；关闭时返回 `''`，被宿主整体丢弃。
- **关闭态字节级等价**：关闭时组装结果与官方逐字节相同，不增删任何他人 section/context。
- **热切换**：开关只改内存真值，下一次请求即生效，无需注销/重注册、无需重启。
- **composer dock 芯片**：`conversation.composer.dock` 上的「破甲 开/关」主开关
  ＋「全权」次级开关，本地乐观更新 + RPC 返回值校准。
- **私有 RPC 通道** `/armor-switch`，端点 `status` / `set` / `toggle` / `recheck`。
- **契约指纹** `status.contract` = 三段开启态文本拼接的 `sha256` 前 16 位，恒定不变，
  用于升级后对账「当前部署的是哪一份字节」。
- **零外部依赖**：宿主半仅 `@deepseek-ai/schemastery` + `node:crypto`；
  客户端半仅 `require('react')`。无 JSX、无 TS、无打包器。
- **自带 `connection` 覆盖**：把 `webServer` 加进 `connection` 行的 `inject`，
  使私有通道能挂载。此覆盖自足，不依赖任何其它插件的 patch。
- **幂等安装/卸载脚本**（PowerShell），改前自动备份，完整回滚。
- **离线自检脚本** `scripts/verify.mjs`，28 项断言，无需真实宿主。
  （1.1.x 已扩充至 39 项；此处保留 1.0.0 的历史数字。）

### Fixed

- **A7 — 主开关的权限副作用（真实缺陷，已修）**：
  早期实现里，关闭「破甲」会把每个 live agent 的 session 写成
  `workspace-write` + approval `ask`。在本 profile 默认预设为 `danger-full-access` 的情况下，
  这等于「用户只点了一下破甲开关，沙箱被悄悄收窄、审批被打开」，且 UI 上完全看不出来。

  现在的硬性规则：
  1. **主开关绝不触碰权限。** `toggle`、以及只带 `enabled` 的 `set` 都不得调用权限服务。
  2. **只有显式传入 `fullAccess` 字段时才动权限。**
  3. **恢复目标读 profile 自己的 `permissionPresets.defaultPreset`**，不硬编码
     `workspace-write`；读不到才回退。
  4. 全程 `try/catch`，任何失败都不影响主开关。

  回归保护：`scripts/verify.mjs` 的 A7 断言组会断言「主开关往返 6 次，权限写入恒为 0 次」。

- **动态样式生命周期**：`ensureStyles()` 原本在 `apply()` 顶层同步调用，而卸载清理挂在
  `ctx.effect` 的返回闭包里，上下文重建时会出现「样式被清掉但不再注入」。
  现已把注入与清理成对收进同一个 `ctx.effect`，并加上 `tag.parentNode` 判空。

- **locale 文案与实际行为不符**：`fullAccessTitleOn/Off` 仍写着旧的
  「点击恢复 workspace-write」，与 A7 修复后的「恢复 profile 默认预设」不一致。已更正中英文两处。

### Known limitations

- `minimal` 预设下本插件**完全不生效**（该 persona 同时声明 `complete: true` 与
  `includeRuntimeContext: false`，前者丢弃 section、后者抑制全部 context）。
- 首次安装需要重启一次 DSH Desktop（客户端模块世代需重新挂载）。
- 宿主 `agent-instructions` 的免责开场白**仍然存在于 session 中**，它是被更高权威面
  **覆盖**，不是被删除。
- 无法绕过模型供应商的服务端内容审核。
- 开关状态是**进程级**的，对整个 DSH 实例生效。

---

## 版本规划（未实现）

以下条目为记录用，**当前版本不做**：

- **按会话隔离的开关状态**：目前 `state` 是模块级单例。若要支持「只对当前会话生效」，
  需要 RPC 带上 `sessionId` 并以 Map 存储。
- **`minimal` 预设下的影子覆盖**：需要在 `agent.ctx` 上注册同名
  `deployment:persona-prefix` + `complete: true` 影子来重建整个 minimal persona，
  依赖 `agent/created` / `agent/disposed` / `agentPresets.composedPreset`，
  复杂且随宿主升级易碎。
- **芯片感知 `minimal` 预设**：检测到当前预设会让插件失效时置灰或给 warning 标记。
