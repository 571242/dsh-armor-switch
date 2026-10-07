---
name: Bug 报告
about: 报告一个可复现的问题
title: '[Bug] '
labels: bug
---

## 环境

- DSH 版本（例如 `DeepSeek Harness Desktop 0.2.0-rc.2`）：
- 操作系统：
- 当前 agent preset：`standard` / `ptc` / `cordis` / `minimal`
- 插件版本：

## 自检输出

请粘贴 `node scripts/verify.mjs` 的完整输出：

```
（粘贴在这里）
```

## 状态端点返回

```powershell
curl.exe -s -X POST "http://127.0.0.1:19387/armor-switch/status" -H "Content-Type: application/json" -d "{}"
```

```
（粘贴在这里，注意包含 sources 数组）
```

## 复现步骤

1.
2.
3.

## 期望行为

（你期望发生什么）

## 实际行为

（实际发生了什么）

## 补充信息

- 是否重启过 DSH？
- `POST /armor-switch/status` 返回的状态码是 401 还是 405？
