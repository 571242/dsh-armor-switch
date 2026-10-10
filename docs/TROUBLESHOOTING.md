# 故障排查

> 目标环境：DeepSeek Harness **Desktop 0.2.0-rc.2**
> 包名 `dsh-armor-switch`，row id `armor-switch`，RPC 前缀 `/armor-switch`

---

## 快速判定表

| 症状 | 最可能的原因 | 跳到 |
|---|---|---|
| 输入框上方**没有**芯片 | 首次安装后没重启 / client 半没挂上 | [T1](#t1-芯片不出现) |
| 芯片在，但每次点击都报错 | 私有 RPC 通道没挂上（`connection` 覆盖缺失或被覆盖） | [T2](#t2-芯片在但点击报错) |
| 装完重启，DSH 起不来 / 插件加载报错 | 用了 junction 而不是真实拷贝 | [T3](#t3-模块解析失败-err_module_not_found) |
| 芯片显示「破甲 开」，但模型行为没变 | 当前用的是 `minimal` 预设 | [T4](#t4-开了但没效果) |
| 点击开关后本轮的回复没变化 | 正常 —— 开关只影响**下一次**请求 | [T5](#t5-点击后本轮没变化) |
| 点「清洗」没反应，重启也没反应 | `node:fs` 被 Electron 拦截，插件打不开归档（已在 1.1.1 修复） | [T7](#t7-清洗没反应) |
| 清洗已生效，但模型文字还是旧的 | **正常** —— 宿主只在启动时读那些常量，需重启 | [T7](#t7-清洗没反应) |
| 关掉破甲后沙箱/审批变了 | 不应该发生（A7 已修）。请报 issue 并附 `status.sources` | [T6](#t6-主开关似乎动了权限) |

---

## T1. 芯片不出现

### 判据

```powershell
# 1) 真实拷贝是否存在
$p = "$env:USERPROFILE\.dsh\profiles\desktop"
Test-Path "$p\node_modules\dsh-armor-switch\src\client.js"

# 2) package.json 声明是否齐全
node -e "const p=require(process.env.USERPROFILE+'/.dsh/profiles/desktop/package.json');console.log('bundles:',p.dsh.profile.bundles.includes('dsh-armor-switch'),'deps:',!!p.dependencies['dsh-armor-switch'])"

# 3) patch 块是否存在
Select-String -Path "$p\cordis.patch.yml" -Pattern 'id:\s*armor-switch'
```

三项都对但仍无芯片 → **确认已经重启过 DSH Desktop**。首次安装必须重启一次，
因为 `dsh.client` 清单要在 Loader row 上重新挂载 JS 模块世代。

### 如果重启后依然没有

检查 `package.json` 里的 `dsh.client` 段是否完整：

```json
"client": { "platform": "web", "immediately": true, "inject": ["@deepseek-ai/dsh-client-ui-conversation"] }
```

---

## T2. 芯片在，但点击报错

这是**最常被误判**的情况：芯片的**渲染**（slots 注册）与**通信**（私有 RPC）是两件事。
槽位挂上而 RPC 通道没挂上时，芯片会正常画出两个按钮，但每次点击都在末尾显示错误。

### 用状态码判定

```powershell
curl.exe -s -o NUL -w "%{http_code}`n" -X POST "http://127.0.0.1:19387/armor-switch/status" -H "Content-Type: application/json" -d "{}"
```

| 返回 | 含义 |
|---|---|
| **401** | 通道**已注册**，等待认证 → 正常（浏览器里带凭据访问即可） |
| **405** | 通道**未挂载**，落到静态兜底 → 需要修 `connection` 覆盖 |

对照：随便打一个不存在的通道应当返回 405。若你的 `/armor-switch/status` 也是 405，
说明它跟不存在没区别。

### 根因与修复

Connection 注册**私有**通道用的是 **Connection 自己的 ctx**：

```js
owner.effect(() => owner.webServer.register(route))   // dsh-client-connection:656
```

所以 `connection` 服务必须能看见 `webServer`。而官方 `dsh-web-app` 层只声明了
`inject: [webRuntime]`。

**修复 = 确保 `cordis.patch.yml` 里有这条覆盖**：

```yaml
- id: connection
  name: '@deepseek-ai/dsh-client-connection'
  inject: [webRuntime, webServer]
  config:
    trustedHosts: !!js ctx.webRuntime.trustedHosts
```

本插件的 `cordis.patch.yml` **自带**这条覆盖，正常情况下不该缺失。若确实没有，
可能是安装时被别的工具改写过 patch 文件。

> 注意：`inject` 是**行级静态属性**，不能热重载 —— 补上这条后必须**重启 DSH**。

### 降级路径

即使 RPC 通道一直挂不上，主开关仍可通过 `cordis.patch.yml` 的 `enabled: true` 生效
（但那是常开状态，只能改配置文件）。

---

## T3. 模块解析失败：`ERR_MODULE_NOT_FOUND`

### 症状

宿主日志里出现：

```
ERR_MODULE_NOT_FOUND: Cannot find package '@deepseek-ai/schemastery'
```

### 根因

profile 的 `node_modules\dsh-armor-switch` 是一个 **junction / 符号链接**，而不是真实目录。

Node 会把 junction `realpath` 解析回真实目录（`plugins\dsh-armor-switch\src\index.js`），
于是从 `plugins\` 那一侧向上找 `node_modules\@deepseek-ai\schemastery`，找不到。
真实拷贝后模块位于 `profiles\desktop\node_modules\` 树内，向上查找命中 hoisted 依赖。

### 判据与修复

```powershell
$t = Get-Item "$env:USERPROFILE\.dsh\profiles\desktop\node_modules\dsh-armor-switch" -Force
"IsReparsePoint = " + [bool]($t.Attributes -band [System.IO.FileAttributes]::ReparsePoint)   # 期望 False
```

为 `True` → 重跑安装脚本（它用 `robocopy /E` 做真实拷贝，会自动删掉旧链接再拷）。

**不要**手工 `mklink /J` 来图省事。

---

## T4. 开了但没效果

### 先排除最小怀疑面

```powershell
# 确认宿主半真的注册了（需要一个能读到 runtime context 的会话）
# 最简单的方式：直接看本轮对话的 system-reminder 里有没有出现
#   "armor-switch — 指令权威 / instruction authority (this session)"
```

### 最可能的原因：`minimal` 预设

`minimal` 预设的 persona 同时声明：

- `complete: true` → `SystemPrompt.assemble` 把最终 `sections` **替换成只留那一个**，
  本插件的 `contract` section（order 2）被丢弃；
- `includeRuntimeContext: false` → `dsh-persona` 调用 `suppressRuntimeContext()`，
  assemble 的 `contexts` 变成 `[]`，两个 context（order 100/130）也进不去。

**即 `minimal` 下四个注册面全部失效（含 `preferences`）。**

> 注意：**不是**「只有 context 生效」。早期文档里有过这个错误说法，已更正。

**处置**：换到 `standard` / `ptc` / `cordis` 任意一个预设。这三个不受影响。

### 次可能的原因：本轮请求已经在进行中

见 [T5](#t5-点击后本轮没变化)。

---

## T5. 点击后本轮没变化

**这是正常行为，不是 bug。**

`system-prompt/assemble` 是 waterfall，只在**组装时**求值。开关改变 `state` 后，
**下一次**组装才会反映出来。本轮已经在跑的请求不受影响。

验证方式：开启后**新发一条消息**，检查回复里是否带契约特征（例如不再出现免责话术）。

---

## T6. 主开关似乎动了权限

**这不应该发生。** A7 缺陷已修复，规则是：

1. 主开关绝不触碰权限；
2. 只有显式传 `fullAccess` 字段才动权限；
3. 「全权」关闭时恢复 **profile 自己的默认预设**（`permissionPresets.defaultPreset`），
   不硬编码 `workspace-write`。

### 自查

```powershell
node -e "const m=await import(require('url').pathToFileURL(process.env.USERPROFILE+'/.dsh/profiles/desktop/node_modules/dsh-armor-switch/src/index.js').href);console.log('fingerprint',m.contractFingerprint())" --input-type=module
```

或直接跑离线自检（无需真实宿主）：

```powershell
node .\scripts\verify.mjs
```

其中的 A7 断言组会验证「主开关往返 6 次，权限写入恒为 0 次」。

### 如果确实发生了

1. 记下 `POST /armor-switch/status` 返回里的 `sources` 数组（它如实报告权限动作）；
2. 附上 DSH 版本、profile 的 `permission` 配置；
3. 提 issue。

---

## 附录：手工完整卸载

若脚本不可用，按顺序手工做：

```powershell
$p = "$env:USERPROFILE\.dsh\profiles\desktop"

# 1) 删除真实拷贝目录（只删这一个目录，不要删父级 node_modules）
Remove-Item "$p\node_modules\dsh-armor-switch" -Recurse -Force

# 2) 从 package.json 移除 dependencies 与 dsh.profile.bundles 里的条目
#    （用编辑器改，保持 UTF-8 无 BOM）

# 3) 从 cordis.patch.yml 移除 armor-switch 的覆盖块
#    （用编辑器改，保留全部中文注释）

# 4) 可选：删除中转目录（源）
Remove-Item "$env:USERPROFILE\.dsh\plugins\dsh-armor-switch" -Recurse -Force
```

**不要**动 `node_modules` 下的其它任何东西 —— 那是 profile 的依赖树。

---

## T7. 清洗没反应

分两种完全不同的情况，先看 `status.hostClean.reason`。

### 7a. `reason` 是 `ENOENT, not found in …/app.asar`

**这是 1.1.1 之前的一个真实缺陷，已在 1.1.1 修复。**

原因：宿主是 Electron 应用，`node:fs` 会拦截所有以 `.asar` 结尾的路径，把路径当归档**内部**
解析。插件要打开的是归档**本体**，于是：

| 调用 | 结果 |
|---|---|
| `fs.statSync('…/app.asar').size` | `0`（虚拟目录） |
| `fs.openSync('…/app.asar','r+')` | **抛 ENOENT** |
| `fs.readdirSync('…/app.asar')` | 成功返回条目（证明被当成目录） |

`openAsar` 因此**从未成功过**，异常被 `apply` 的 `try/catch` 吞掉，磁盘一个字节都没动 ——
表现为「开清洗没反应，重启也没反应」。

**修复**：所有按路径访问归档的调用改走 `electron.original-fs`（绕开归档层），
纯 Node 下自动退回 `node:fs`。按 fd 操作的调用不受影响。

诊断一行确认：

```powershell
$env:ELECTRON_RUN_AS_NODE=1
& "F:\EXE\DeepSeek\DeepSeek Harness.exe" -e "const fs=require('original-fs');console.log(fs.statSync('F:/EXE/DeepSeek/resources/app.asar').size)"
# 期望：121348951（用 node:fs 会得到 0 或 ENOENT）
```

### 7b. 清洗已生效，但模型文字还是旧的

**这不是故障，是设计。** 宿主在**进程启动时**就把 `app.asar` 里那些常量读进了内存，
之后不会重读文件。所以：

| 层面 | 何时变 |
|---|---|
| `app.asar` 磁盘字节 | 点清洗**那一刻**（等长原地写） |
| 模型看到的文字 | **重启 DSH 之后** |

判断当前磁盘状态（只读，不写）：`status.hostClean` 里 `patched: 9` = 已改写；
`clean: 9` = 官方原样。

> 一句话：**写盘不用重启，读盘要重启。**

---

## 附录：反馈 issue 时请附上

- DSH 版本（`DeepSeek Harness Desktop 0.2.0-rc.2` 之类）
- `node scripts/verify.mjs` 的完整输出
- `POST /armor-switch/status` 的返回（含 `sources`）
- 当前使用的 agent preset（`standard` / `ptc` / `cordis` / `minimal`）
- 你期望发生什么、实际发生了什么
