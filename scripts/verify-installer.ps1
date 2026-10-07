<#
.SYNOPSIS
    验证 install.ps1 生成的 profile patch 是合法 YAML。

.DESCRIPTION
    这是一条针对真实缺陷的回归测试。

    背景：New-OverrideBlock 早期用手写字符串字面量拼接缩进，实际多打了一个空格，
    生成 3 空格缩进的块：

        - id: armor-switch
           name: 'dsh-armor-switch'     <- 3 空格，与上一行的 key 列不对齐
           config:
             enabled: false

    这在 YAML 里是**非法**的（js-yaml 报 "bad indentation of a mapping entry"），
    于是全新安装会写入一个解析失败的 patch —— 插件静默不加载。
    更阴险的是：已有 profile 走「就地规整」分支，不触发这条路径，
    所以它只在全新安装时炸。

    本脚本在一个临时 profile 上真跑一遍安装，然后断言：
      1. 生成的 armor-switch 条目缩进宽度恰好是 0,2,2,4,4
      2. 追加字节数恰好 97（LF）
      3. 若本机可解析 js-yaml，则再用真解析器解析整个文件

.EXAMPLE
    powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\verify-installer.ps1
#>
[CmdletBinding()]
param()

$ErrorActionPreference = 'Stop'

$here    = Split-Path -Parent $PSCommandPath
$repo    = [System.IO.Path]::GetFullPath((Join-Path $here '..'))
$install = Join-Path $here 'install.ps1'

$failures = 0
function Check([string]$id, [string]$title, [bool]$pass, [string]$note = '') {
    $tag = if ($pass) { 'PASS' } else { 'FAIL' }
    Write-Host ("{0}  {1}  {2}{3}" -f $tag, $id, $title, $(if ($note) { "  :: $note" } else { '' }))
    if (-not $pass) { $script:failures++ }
}

Write-Host 'installer regression: 全新安装生成的 YAML 必须可解析'

# ── 准备临时环境 ────────────────────────────────────────────────────────────
$stamp    = Get-Date -Format 'yyyyMMdd-HHmmss'
$work     = Join-Path $env:TEMP "armor-installer-verify-$stamp"
$repoCopy = Join-Path $work 'repo'
$profile  = Join-Path $work 'profile'

try {
    New-Item -ItemType Directory -Path $work -Force | Out-Null
    Copy-Item $repo $repoCopy -Recurse -Force
    New-Item -ItemType Directory -Path $profile -Force | Out-Null

    # 造一个「全新」的 profile：空依赖、无 armor-switch、patch 里没有该条目
    $utf8NoBom = New-Object System.Text.UTF8Encoding($false)
    [System.IO.File]::WriteAllText(
        (Join-Path $profile 'package.json'),
        '{"name":"desktop","dependencies":{},"dsh":{"profile":{"bundles":["other"]}}}',
        $utf8NoBom)
    [System.IO.File]::WriteAllText(
        (Join-Path $profile 'cordis.patch.yml'),
        "- id: other`n  disabled: false`n",
        $utf8NoBom)

    $patchPath = Join-Path $profile 'cordis.patch.yml'
    $before    = (Get-Item $patchPath).Length

    # ── 真跑安装 ────────────────────────────────────────────────────────────
    $out = & powershell -NoProfile -ExecutionPolicy Bypass -File (Join-Path $repoCopy 'scripts\install.ps1') `
        -StagingPath $repoCopy -ProfilePath $profile 2>&1
    $installOk = ($LASTEXITCODE -eq 0)

    $appended = (Get-Item $patchPath).Length - $before
    Check 'I1.1' 'install.ps1 全新安装退出码 0' $installOk `
        ($out | Select-String -Pattern 'ERROR|Exception' | Select-Object -First 1)

    # ── 断言 1：缩进宽度 ───────────────────────────────────────────────────
    $text  = [System.IO.File]::ReadAllText($patchPath, [System.Text.Encoding]::UTF8)
    $lines = @($text -split "`r?`n" | Where-Object { $_.Trim().Length -gt 0 })

    $armorStart = -1
    for ($i = 0; $i -lt $lines.Count; $i++) {
        if ($lines[$i] -match '^-\s*id:\s*armor-switch\s*$') { $armorStart = $i; break }
    }
    Check 'I1.2' 'patch 里出现 armor-switch 条目' ($armorStart -ge 0) `
        "armorStart=$armorStart lines=$($lines.Count)"

    $widths = @()
    if ($armorStart -ge 0) {
        for ($i = $armorStart; $i -lt [Math]::Min($armorStart + 5, $lines.Count); $i++) {
            $w = 0
            foreach ($ch in $lines[$i].ToCharArray()) { if ($ch -eq ' ') { $w++ } else { break } }
            $widths += $w
        }
    }
    $actual   = $widths -join ','
    $expected = '0,2,2,4,4'
    Check 'I1.3' '缩进宽度为 0,2,2,4,4（2 空格为子键、4 空格为 config 子键）' `
        ($actual -eq $expected) "得到 [$actual]，期望 [$expected]"

    # ── 断言 2：追加字节数 ─────────────────────────────────────────────────
    Check 'I1.4' '追加字节数为 97（2 空格块；3 空格块会是 101）' ($appended -eq 97) "appended=$appended"

    # ── 断言 3：用真解析器再验一次（如果宿主里有 js-yaml）──────────────────
    $jsYaml = Join-Path $env:USERPROFILE '.dsh\profiles\desktop\node_modules\js-yaml\index.js'
    if (Test-Path $jsYaml) {
        $probe = Join-Path $work 'parse.mjs'
        [System.IO.File]::WriteAllText($probe, @'
import fs from 'node:fs';
import { pathToFileURL } from 'node:url';

const yaml = (await import(pathToFileURL(process.argv[2]).href)).default;
try {
  const d = yaml.load(fs.readFileSync(process.argv[3], 'utf8'));
  const e = (d || []).find((x) => x && x.id === 'armor-switch');
  if (!e) { console.log('NO_ENTRY'); process.exit(1); }
  if (!e.config || e.config.enabled !== false) { console.log('BAD_CONFIG ' + JSON.stringify(e.config)); process.exit(1); }
  console.log('PARSE_OK ' + JSON.stringify(e));
} catch (err) {
  console.log('PARSE_FAIL ' + err.message.split('\n')[0]);
  process.exit(1);
}
'@, $utf8NoBom)
        $probeOut = & node $probe $jsYaml $patchPath 2>&1
        $probeOk  = ($LASTEXITCODE -eq 0)
        Check 'I1.5' 'js-yaml 能解析整个 patch 文件' $probeOk ($probeOut -join ' ')
    } else {
        Check 'I1.5' 'js-yaml 能解析整个 patch 文件' $true '未找到 js-yaml，跳过（缩进宽度断言已覆盖该缺陷）'
    }
} finally {
    if (Test-Path $work) { Remove-Item $work -Recurse -Force -ErrorAction SilentlyContinue }
}

Write-Host ''
Write-Host ('═' * 66)
Check 'RESULT' 'installer 回归' ($failures -eq 0) "$failures 个失败"
Write-Host ('═' * 66)
exit $(if ($failures -eq 0) { 0 } else { 1 })
