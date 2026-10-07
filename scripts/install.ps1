<#
.SYNOPSIS
    幂等安装 dsh-armor-switch（破甲开关）到 DSH Desktop profile。

.DESCRIPTION
    做四件事，全部可重复执行、全部先备份：
      1. 把插件真实拷贝到 <profile>\node_modules\dsh-armor-switch
         （**不用 junction**：Node 会 realpath 解析到 plugins/ 侧，导致插件里的
          `import '@deepseek-ai/schemastery'` 报 ERR_MODULE_NOT_FOUND；
          真实拷贝后模块位于 profile 的 node_modules 树内，向上查找命中 hoisted 依赖。）
      2. package.json 的 dependencies 加 "dsh-armor-switch": "file:../../plugins/dsh-armor-switch"
      3. package.json 的 dsh.profile.bundles 末尾加 "dsh-armor-switch"
      4. cordis.patch.yml 末尾追加 insert 块（row id = armor-switch）
         —— 纯文本追加 + 精确字符串匹配，**绝不**用 JSON/YAML 往返解析
            （本机该文件含中文注释，必须原样保留）。

    写回一律 UTF8 无 BOM；打包文件用 LF，读到的换行风格保持一致。

.PARAMETER ProfilePath
    profile 目录。默认 %USERPROFILE%\.dsh\profiles\desktop

.PARAMETER StagingPath
    中转源目录（插件在 ~/.dsh/plugins 下的常驻副本）。默认 %USERPROFILE%\.dsh\plugins\dsh-armor-switch

.PARAMETER WorkspaceSource
    工作区里的插件源码目录。默认 <脚本目录>\..\armor-switch

.PARAMETER SkipStaging
    跳过「工作区 -> 中转目录」同步，直接从现有中转目录（或工作区）拷到 node_modules。

.PARAMETER Enable
    全新追加 insert 块时写 enabled: true（默认 false，符合冻结契约）。

.PARAMETER FullAccess
    全新追加 insert 块时写 fullAccess: true（默认 false）。

.EXAMPLE
    powershell -NoProfile -ExecutionPolicy Bypass -File .\install-armor-switch.ps1 -WhatIf
    powershell -NoProfile -ExecutionPolicy Bypass -File .\install-armor-switch.ps1
#>
[CmdletBinding(SupportsShouldProcess = $true, ConfirmImpact = 'Medium')]
param(
    [string]$ProfilePath,
    [string]$StagingPath,
    [string]$WorkspaceSource,
    [switch]$SkipStaging,
    [switch]$Enable,
    [switch]$FullAccess,
    [string]$DependencySpec = 'file:../../plugins/dsh-armor-switch'
)

$ErrorActionPreference = 'Stop'

# ---------------------------------------------------------------- 输出助手
function Say-Head([string]$t) { Write-Host ''; Write-Host "==== $t ====" -ForegroundColor Cyan }
function Say-Info([string]$t) { Write-Host "  $t" }
function Say-Act([string]$t)  { Write-Host "  [DO]     $t" -ForegroundColor Green }
function Say-Plan([string]$t) { Write-Host "  [WhatIf] $t" -ForegroundColor Yellow }
function Say-Skip([string]$t) { Write-Host "  [SKIP]   $t" -ForegroundColor DarkGray }
function Say-Warn([string]$t) { Write-Host "  [WARN]   $t" -ForegroundColor Yellow }
function Say-Ok([string]$t)   { Write-Host "  [OK]     $t" -ForegroundColor Green }
function Say-Err([string]$t)  { Write-Host "  [ERROR]  $t" -ForegroundColor Red }

$dry     = [bool]$WhatIfPreference
$stamp   = Get-Date -Format 'yyyyMMdd-HHmmss'
$PN      = 'dsh-armor-switch'
$ROWID   = 'armor-switch'

# ---------------------------------------------------------------- 工具函数
function Get-Nl([string]$t) { if ($t -match "`r`n") { return "`r`n" } else { return "`n" } }

function Read-Text([string]$p) { return [System.IO.File]::ReadAllText($p) }

function Write-TextUtf8NoBom([string]$p, [string]$t) {
    $enc = New-Object System.Text.UTF8Encoding($false)
    [System.IO.File]::WriteAllText($p, $t, $enc)
    $b = [System.IO.File]::ReadAllBytes($p)
    if ($b.Length -ge 3 -and $b[0] -eq 0xEF -and $b[1] -eq 0xBB -and $b[2] -eq 0xBF) {
        throw "写回后检测到 BOM，node 会报 Invalid package.json: $p"
    }
}

function Backup-File([string]$p, [string]$suffix) {
    $bak = "$p.bak-$suffix"
    $i = 1
    while (Test-Path -LiteralPath $bak) { $bak = "$p.bak-$suffix-$i"; $i++ }
    Copy-Item -LiteralPath $p -Destination $bak -Force
    return $bak
}

# 安全删除目录：若目标是 junction/符号链接，只删链接本身，绝不递归删到源目录
function Remove-DirSafely([string]$p) {
    if (-not (Test-Path -LiteralPath $p)) { return }
    $item = Get-Item -LiteralPath $p -Force
    $isLink = [bool]($item.Attributes -band [System.IO.FileAttributes]::ReparsePoint)
    if ($isLink) {
        [System.IO.Directory]::Delete($p, $false)
    } else {
        Remove-Item -LiteralPath $p -Recurse -Force
    }
}

function Invoke-RobocopyCopy([string]$src, [string]$dst) {
    & robocopy $src $dst /E /NFL /NDL /NJH /NJS /NC /NS | Out-Null
    $rc = $LASTEXITCODE
    return $rc
}

# --- package.json 文本级编辑（不做 JSON 往返，保持其它字节原样）---------------
function Add-DependencyText([string]$text, [string]$name, [string]$spec, [string]$nl) {
    $esc = [regex]::Escape($name)
    $re  = '"' + $esc + '"\s*:\s*"([^"]*)"'
    $m   = [regex]::Match($text, $re)
    if ($m.Success) {
        if ($m.Groups[1].Value -eq $spec) { return @{ Changed = $false; Text = $text; Note = "dependencies 已含 $name（值相同）" } }
        $new = $text.Remove($m.Index, $m.Length).Insert($m.Index, '"' + $name + '": "' + $spec + '"')
        return @{ Changed = $true; Text = $new; Note = "dependencies 已含 $name 但值为 $($m.Groups[1].Value)，改写为 $spec" }
    }
    $anchor = [regex]::Match($text, '"dependencies"\s*:\s*\{')
    if (-not $anchor.Success) { throw 'package.json 里找不到 "dependencies" 对象' }
    $pos  = $anchor.Index + $anchor.Length
    $rest = $text.Substring($pos)
    $empty = [regex]::IsMatch($rest, '^\s*\}')
    if ($empty) {
        $ins = $nl + '    "' + $name + '": "' + $spec + '"' + $nl + '  '
    } else {
        $ins = $nl + '    "' + $name + '": "' + $spec + '",'
    }
    return @{ Changed = $true; Text = $text.Insert($pos, $ins); Note = "dependencies 追加 $name" }
}

function Add-BundleText([string]$text, [string]$name, [string]$nl) {
    $esc = [regex]::Escape($name)
    $m = [regex]::Match($text, '"bundles"\s*:\s*\[')
    if (-not $m.Success) { throw 'package.json 里找不到 dsh.profile.bundles 数组' }
    $open = $m.Index + $m.Length - 1
    $depth = 0; $close = -1
    for ($i = $open; $i -lt $text.Length; $i++) {
        $c = $text[$i]
        if ($c -eq '[') { $depth++ }
        elseif ($c -eq ']') { $depth--; if ($depth -eq 0) { $close = $i; break } }
    }
    if ($close -lt 0) { throw 'dsh.profile.bundles 数组括号不平衡' }
    $inner = $text.Substring($open + 1, $close - $open - 1)
    if ($inner -match ('"' + $esc + '"')) { return @{ Changed = $false; Text = $text; Note = "bundles 已含 $name" } }
    $trimmed = $inner.TrimEnd()
    if ($trimmed.Trim() -eq '') {
        $newInner = $nl + '        "' + $name + '"' + $nl + '      '
    } else {
        $newInner = $trimmed + ',' + $nl + '        "' + $name + '"' + $nl + '      '
    }
    $new = $text.Substring(0, $open + 1) + $newInner + $text.Substring($close)
    return @{ Changed = $true; Text = $new; Note = "bundles 追加 $name" }
}

# --- cordis.patch.yml：定位含 id: armor-switch 的那个顶层条目 ---------------
function Get-ArmorEntryBounds([string[]]$lines) {
    $idIdx = -1
    for ($i = 0; $i -lt $lines.Count; $i++) {
        if ($lines[$i] -match '^[ \t]*-?\s*id:\s*armor-switch\s*$') { $idIdx = $i; break }
    }
    if ($idIdx -lt 0) { return $null }
    $start = 0
    for ($i = $idIdx; $i -ge 0; $i--) {
        if ($lines[$i] -match '^-(?:\s|$)') { $start = $i; break }
    }
    $end = $lines.Count
    for ($i = $start + 1; $i -lt $lines.Count; $i++) {
        if ($lines[$i] -match '^-(?:\s|$)') { $end = $i; break }
    }
    return @($start, $end, $idIdx)
}

# 在既有条目内就地规整 config.enabled / config.fullAccess（保留该条目其它键）
function Set-ArmorConfigValues {
    param([string[]]$Lines, [int]$Start, [int]$End, [int]$IdIdx, [bool]$EnabledValue, [bool]$FullValue, [string]$Nl)
    $idLine = $Lines[$IdIdx]
    $lead = [regex]::Match($idLine, '^[ \t]*').Value
    if ($idLine.TrimStart().StartsWith('- ')) { $propIndent = $lead + '  ' } else { $propIndent = $lead }
    $cfgIdx = -1
    for ($i = $Start; $i -lt $End; $i++) {
        if ($Lines[$i] -match '^[ \t]*config:\s*$') { $cfgIdx = $i; break }
    }
    $ev  = $EnabledValue.ToString().ToLower()
    $fv  = $FullValue.ToString().ToLower()
    $out = New-Object System.Collections.Generic.List[string]
    $setE = $false; $setF = $false
    for ($i = 0; $i -lt $Lines.Count; $i++) {
        if ($cfgIdx -ge 0 -and $i -gt $cfgIdx -and $i -lt $End) {
            if ($Lines[$i] -match '^[ \t]*enabled:\s*(?:true|false)?\s*$') {
                $out.Add($propIndent + '  enabled: ' + $ev + $Nl); $setE = $true; continue
            }
            if ($Lines[$i] -match '^[ \t]*fullAccess:\s*(?:true|false)?\s*$') {
                $out.Add($propIndent + '  fullAccess: ' + $fv + $Nl); $setF = $true; continue
            }
        }
        $out.Add($Lines[$i])
    }
    $arr = @($out.ToArray())
    if ($cfgIdx -lt 0) {
        $ins = @(
            ($propIndent + 'config:' + $Nl),
            ($propIndent + '  enabled: ' + $ev + $Nl),
            ($propIndent + '  fullAccess: ' + $fv + $Nl)
        )
        $head = @($arr[0..($End - 1)])
        $tail = @()
        if ($End -le $arr.Count - 1) { $tail = @($arr[$End..($arr.Count - 1)]) }
        return (($head + $ins + $tail) -join '')
    }
    if (-not $setE -or -not $setF) {
        $ins = @()
        if (-not $setE) { $ins += ($propIndent + '  enabled: ' + $ev + $Nl) }
        if (-not $setF) { $ins += ($propIndent + '  fullAccess: ' + $fv + $Nl) }
        $head = @($arr[0..$cfgIdx])
        $tail = @()
        if ($cfgIdx + 1 -le $arr.Count - 1) { $tail = @($arr[($cfgIdx + 1)..($arr.Count - 1)]) }
        return (($head + $ins + $tail) -join '')
    }
    return ($arr -join '')
}

# Profile 层只写「按 id 覆盖 config」，绝不写第二个 insert。
#
# 为什么必须这样（Lead 2026-10-07 实测的故障根因）：
#   bundle 自带的 cordis.patch.yml 已经 `- insert:` 了这个 row；
#   profile 层若再 `- insert:` 同一个 id，合成后会出现**两行同 id**。
#   而 Loader 的 EntryGroup.update() 用 Object.fromEntries 按 id 归并（后者胜），
#   一旦 profile 层那行是 `disabled: true`（plugin manager 关行时会这么写），
#   存活的那行就是 disabled → 整个插件静默不加载，芯片也随之消失。
#   正典做法（见 dsh-unrestricted）：bundle 负责 insert，profile 只覆盖 config。
function New-OverrideBlock([bool]$EnabledValue, [bool]$FullValue, [string]$Nl) {
    $ev = $EnabledValue.ToString().ToLower()
    $fv = $FullValue.ToString().ToLower()
    # 用 here-string 固化缩进：2 空格为子键、4 空格为 config 的子键。
    # YAML 对缩进敏感，这里必须与 profile 既有风格一致（否则 js-yaml 会报
    # "bad indentation of a mapping entry"）。
    $i2 = '  '
    $i4 = '    '
    $lines = @(
        '- id: armor-switch',
        ($i2 + "name: 'dsh-armor-switch'"),
        ($i2 + 'config:'),
        ($i4 + 'enabled: ' + $ev),
        ($i4 + 'fullAccess: ' + $fv)
    )
    return (($lines -join $Nl) + $Nl)
}

# 清除历史遗留的 armor-switch 顶层 insert 块（旧版脚本写过；留着就会造成同 id 两行）。
function Remove-ArmorInsertBlocks([string]$Text, [string]$Nl) {
    $pattern = '(?ms)^- insert:\s*\r?\n[ \t]*- id: armor-switch\s*\r?\n(?:[ \t]+.*\r?\n)*?(?=\S|\z)'
    $removed = 0
    while ($true) {
        $m = [regex]::Match($Text, $pattern)
        if (-not $m.Success) { break }
        $Text = $Text.Remove($m.Index, $m.Length)
        $removed++
    }
    return @{ Text = $Text; Removed = $removed }
}

# ---------------------------------------------------------------- 路径解析
if (-not $ProfilePath)     { $ProfilePath = Join-Path $env:USERPROFILE '.dsh\profiles\desktop' }
if (-not $StagingPath)     { $StagingPath = Join-Path $env:USERPROFILE '.dsh\plugins\dsh-armor-switch' }

$self    = $PSCommandPath; if (-not $self) { $self = $MyInvocation.MyCommand.Path }
$selfDir = Split-Path -Parent $self
$repoRoot = [System.IO.Path]::GetFullPath((Join-Path $selfDir '..'))

if (-not $WorkspaceSource) {
    # 发布树布局：仓库根目录**就是**包根（package.json 在 scripts\ 的上一级）。
    # 旧布局（工作区里的 armor-switch\ 子目录）作为回退保留，方便开发时使用。
    if (Test-Path -LiteralPath (Join-Path $repoRoot 'package.json')) {
        $WorkspaceSource = $repoRoot
    } else {
        $WorkspaceSource = [System.IO.Path]::GetFullPath((Join-Path $selfDir '..\armor-switch'))
    }
}

# ─────────────────────────────────────────────────────────────────────────────
# 安全检查：绝不允许把「正在运行的仓库自己」当作可删除的中转目录。
#
# 默认 StagingPath 恰好等于 README 建议的 clone 目标
# （%USERPROFILE%\.dsh\plugins\dsh-armor-switch）。如果用户就地把仓库 clone 在那里，
# 而源码又来自其它位置，脚本会先 Remove-DirSafely $StagingPath —— 那会连带删掉
# 用户刚 clone 的仓库（包括 .git）。这里直接拒绝执行并给出可复制的修复命令。
# ─────────────────────────────────────────────────────────────────────────────
function Test-SamePath([string]$a, [string]$b) {
    if (-not $a -or -not $b) { return $false }
    try {
        $fa = [System.IO.Path]::GetFullPath($a).TrimEnd('\', '/')
        $fb = [System.IO.Path]::GetFullPath($b).TrimEnd('\', '/')
        return $fa.Equals($fb, [System.StringComparison]::OrdinalIgnoreCase)
    } catch { return $false }
}

$stagingIsRepo = Test-SamePath $StagingPath $repoRoot
$sourceIsRepo  = Test-SamePath $WorkspaceSource $repoRoot
if ($stagingIsRepo -and -not $sourceIsRepo) {
    Say-Err "拒绝执行：中转目录与仓库根目录是同一个路径，但源码来自其它位置。"
    Write-Host ""
    Write-Host "  staging : $StagingPath" -ForegroundColor Yellow
    Write-Host "  repo    : $repoRoot" -ForegroundColor Yellow
    Write-Host "  source  : $WorkspaceSource" -ForegroundColor Yellow
    Write-Host ""
    Write-Host "  继续执行会先删除中转目录，从而连带删掉这个仓库（含 .git）。" -ForegroundColor Yellow
    Write-Host "  你的仓库就在 staging 位置，所以不需要同步源 —— 直接跳过该步骤：" -ForegroundColor Yellow
    Write-Host ""
    Write-Host "      powershell -NoProfile -ExecutionPolicy Bypass -File `"$self`" -SkipStaging" -ForegroundColor Cyan
    Write-Host ""
    exit 1
}

$packageJson = Join-Path $ProfilePath 'package.json'
$patchYml    = Join-Path $ProfilePath 'cordis.patch.yml'
$nodeModules = Join-Path $ProfilePath 'node_modules'
$target      = Join-Path $nodeModules $PN

Say-Head 'armor-switch 安装'
Say-Info "profile      : $ProfilePath"
Say-Info "staging      : $StagingPath"
Say-Info "workspace src: $WorkspaceSource"
Say-Info "target       : $target"
if ($dry) { Write-Host '  *** WhatIf 模式：只打印计划，不落盘 ***' -ForegroundColor Yellow }

if (-not (Test-Path -LiteralPath $ProfilePath)) { Say-Err "profile 目录不存在: $ProfilePath"; exit 1 }
if (-not (Test-Path -LiteralPath $packageJson)) { Say-Err "找不到 $packageJson"; exit 1 }
if (-not (Test-Path -LiteralPath $patchYml))    { Say-Err "找不到 $patchYml"; exit 1 }

# ---------------------------------------------------------------- 1/5 源目录
Say-Head '1/5 准备源目录'
$src = $null

if ((Test-Path -LiteralPath $WorkspaceSource) -and (Test-SamePath $WorkspaceSource $StagingPath)) {
    # 仓库就放在中转目录位置上（README 建议的 clone 目标）。源与中转目录是同一个目录，
    # 没有可同步的内容，也绝不能删除它 —— 直接原地安装。
    $src = $WorkspaceSource
    Say-Skip "源目录与中转目录同一位置，跳过同步（原地安装）: $src"
} elseif (-not $SkipStaging -and (Test-Path -LiteralPath $WorkspaceSource)) {
    if ($dry) {
        Say-Plan "删除并重建中转目录 $StagingPath"
        Say-Plan "robocopy `"$WorkspaceSource`" `"$StagingPath`" /E /NFL /NDL /NJH /NJS /NC /NS"
    } else {
        Remove-DirSafely $StagingPath
        New-Item -ItemType Directory -Path $StagingPath -Force | Out-Null
        $rc = Invoke-RobocopyCopy $WorkspaceSource $StagingPath
        if ($rc -ge 8) { Say-Err "robocopy 工作区 -> 中转目录 失败，退出码 $rc"; exit 1 }
        Say-Act "已同步工作区 -> 中转目录（robocopy rc=$rc）"
    }
    $src = $StagingPath
} elseif (Test-Path -LiteralPath $StagingPath) {
    $src = $StagingPath
    Say-Skip "跳过工作区同步（-SkipStaging），直接使用中转目录"
} elseif (Test-Path -LiteralPath $WorkspaceSource) {
    $src = $WorkspaceSource
    Say-Warn "中转目录不存在，直接从工作区源码安装: $WorkspaceSource"
} else {
    Say-Err "源目录不存在：中转目录($StagingPath) 与 工作区($WorkspaceSource) 都没有"
    exit 1
}
# 源完整性只在真实执行时校验（WhatIf 下 $src 可能尚未同步出来）
if ($dry) {
    foreach ($f in @('package.json', 'src\index.js')) {
        $probe = Join-Path $WorkspaceSource $f
        if (-not (Test-Path -LiteralPath $probe)) { Say-Warn "工作区缺少 $f : $probe（真实执行时会失败）" }
    }
    Say-Info "（WhatIf）待拷源目录: $src"
} else {
    foreach ($f in @('package.json', 'src\index.js')) {
        $probe = Join-Path $src $f
        if (-not (Test-Path -LiteralPath $probe)) { Say-Err "源目录缺少 $f : $probe"; exit 1 }
    }
    Say-Ok "源目录就绪: $src"
}

# ---------------------------------------------------------------- 2/5 真实拷贝
Say-Head '2/5 真实拷贝到 profile\node_modules（不用 junction）'
$copyNeeded = $true
if ($dry) {
    Say-Plan "若已存在则删除 $target（仅删除该目标目录，不动源目录）"
    Say-Plan "robocopy `"$src`" `"$target`" /E /NFL /NDL /NJH /NJS /NC /NS   (退出码 <8 视为成功)"
} else {
    if (Test-Path -LiteralPath $nodeModules) { } else { New-Item -ItemType Directory -Path $nodeModules -Force | Out-Null }
    if (Test-Path -LiteralPath $target) {
        Remove-DirSafely $target
        Say-Act "已删除旧的 $target（幂等重置）"
    }
    $rc = Invoke-RobocopyCopy $src $target
    if ($rc -ge 8) { Say-Err "robocopy 拷贝失败，退出码 $rc"; exit 1 }
    $idx = Join-Path $target 'src\index.js'
    if (-not (Test-Path -LiteralPath $idx)) { Say-Err "拷贝后找不到 $idx"; exit 1 }
    Say-Act "已真实拷贝 $src -> $target（robocopy rc=$rc）"
    Say-Ok "目标为真实目录（非 reparse point）: $(-not [bool]((Get-Item -LiteralPath $target -Force).Attributes -band [System.IO.FileAttributes]::ReparsePoint))"
}

# ---------------------------------------------------------------- 3/5 package.json
Say-Head '3/5 更新 package.json'
$pjText = Read-Text $packageJson
$pjNl   = Get-Nl $pjText
$depRes = Add-DependencyText $pjText $PN $DependencySpec $pjNl
$bunRes = Add-BundleText $depRes.Text $PN $pjNl
$pjNew  = $bunRes.Text
foreach ($r in @($depRes, $bunRes)) {
    if ($r.Changed) { Say-Info $r.Note } else { Say-Skip $r.Note }
}
if ($pjNew -eq $pjText) {
    Say-Skip 'package.json 无需改动（已完全安装）'
} elseif ($dry) {
    Say-Plan "备份 package.json -> package.json.bak-$stamp"
    Say-Plan "以 UTF8 无 BOM 写回（dependencies + bundles 各加 $PN）"
} else {
    $bak = Backup-File $packageJson $stamp
    Say-Act "已备份 -> $(Split-Path -Leaf $bak)"
    Write-TextUtf8NoBom $packageJson $pjNew
    $chk = Read-Text $packageJson
    & node -e "JSON.parse(require('fs').readFileSync(process.argv[1],'utf8'))" $packageJson
    if ($LASTEXITCODE -ne 0) { Say-Err 'package.json 写回后不是合法 JSON'; exit 1 }
    if ($chk -match "`r`n" -and $pjNl -eq "`n") { Say-Warn '换行风格发生变化' }
    Say-Ok 'package.json 已写回（合法 JSON / UTF8 无 BOM）'
}

# ---------------------------------------------------------------- 4/5 cordis.patch.yml
Say-Head '4/5 更新 cordis.patch.yml（纯文本，保留全部既有内容与中文注释）'
$ymlText = Read-Text $patchYml
$ymlNl   = Get-Nl $ymlText
# 先把历史遗留的 insert 块清掉，避免与 bundle 的 insert 形成同 id 两行（见 New-OverrideBlock 注释）
$cleanup = Remove-ArmorInsertBlocks $ymlText $ymlNl
if ($cleanup.Removed -gt 0) {
    Say-Warn "发现 $($cleanup.Removed) 个遗留的 armor-switch 顶层 insert 块（会造成同 id 两行、插件静默失效），将移除"
    $ymlText = $cleanup.Text
}
$lines   = [regex]::Split($ymlText, "(?<=\n)")
$bounds  = Get-ArmorEntryBounds $lines

if ($null -ne $bounds) {
    $start = $bounds[0]; $end = $bounds[1]; $idIdx = $bounds[2]
    $entryText = ($lines[$start..($end - 1)] -join '')
    $enabledValue = $false; $fullValue = $false
    if ($entryText -match 'enabled:\s*(true|false)')    { $enabledValue = [bool]::Parse($Matches[1]) }
    if ($entryText -match 'fullAccess:\s*(true|false)') { $fullValue    = [bool]::Parse($Matches[1]) }
    # 显式传 -Enable / -FullAccess 时按参数覆盖（-Enable:$false 也可用）
    if ($PSBoundParameters.ContainsKey('Enable'))     { $enabledValue = [bool]$Enable }
    if ($PSBoundParameters.ContainsKey('FullAccess')) { $fullValue    = [bool]$FullAccess }
    Say-Info "已存在 id: armor-switch（行 $($idIdx + 1)），就地规整 config（保留 enabled=$enabledValue fullAccess=$fullValue）"
    $ymlNew = Set-ArmorConfigValues -Lines $lines -Start $start -End $end -IdIdx $idIdx `
                                   -EnabledValue $enabledValue -FullValue $fullValue -Nl $ymlNl
    if ($ymlNew -eq $ymlText) {
        Say-Skip 'insert 块内容已是最新，无需改动'
    } elseif ($dry) {
        Say-Plan "备份 cordis.patch.yml -> cordis.patch.yml.bak-$stamp"
        Say-Plan "就地替换该条目的 config（不新增块，其它内容逐字保留）"
    } else {
        $bak = Backup-File $patchYml $stamp
        Say-Act "已备份 -> $(Split-Path -Leaf $bak)"
        Write-TextUtf8NoBom $patchYml $ymlNew
        Say-Ok "cordis.patch.yml 已就地规整（+$($ymlNew.Length - $ymlText.Length) 字节）"
    }
} else {
    $block = New-OverrideBlock ([bool]$Enable) ([bool]$FullAccess) $ymlNl
    if ($ymlText.EndsWith($ymlNl)) { $append = $block } else { $append = $ymlNl + $block }
    if ($dry) {
        Say-Plan "备份 cordis.patch.yml -> cordis.patch.yml.bak-$stamp"
        Say-Plan '在文件末尾追加（顶层「按 id 覆盖 config」，不写 insert）:'
        $block.TrimEnd("`r", "`n").Split($ymlNl) | ForEach-Object { Say-Plan ('    ' + $_) }
    } else {
        $bak = Backup-File $patchYml $stamp
        Say-Act "已备份 -> $(Split-Path -Leaf $bak)"
        Write-TextUtf8NoBom $patchYml ($ymlText + $append)
        Say-Ok "cordis.patch.yml 末尾已追加 id-override 块（+$($append.Length) 字节）"
    }
}

# ---------------------------------------------------------------- 5/5 后置验证
Say-Head '5/5 后置验证命令（可直接复制执行）'
$pjNode     = $packageJson.Replace('\', '/')
$idxNode    = (Join-Path $target 'src\index.js').Replace('\', '/')
$verifyCmd1 = "node -e ""const p=require('$pjNode');const b=p.dsh.profile.bundles,d=p.dependencies;if(!b.includes('$PN'))throw new Error('bundles 缺少 $PN');if(!d['$PN'])throw new Error('dependencies 缺少 $PN');console.log('PACKAGE_OK',JSON.stringify(d['$PN']))"""
$verifyCmd2 = "node -e ""import(require('url').pathToFileURL('$idxNode').href).then(m=>{console.log('IMPORT_OK',Object.keys(m).length);process.exit(0)}).catch(e=>{console.error('IMPORT_FAIL',e.code||e.message);process.exit(1)})"""
$verifyCmd3 = "node -e ""const fs=require('fs');const s=fs.readFileSync('$($patchYml.Replace('\','/'))','utf8');if(!/id:\s*armor-switch/.test(s))throw new Error('patch 缺少 armor-switch');console.log('PATCH_OK')"""
Write-Host ''
Say-Info $verifyCmd1
Write-Host ''
Say-Info $verifyCmd2
Write-Host ''
Say-Info $verifyCmd3

Say-Head '完成'
if ($dry) {
    Say-Info 'WhatIf 模式：未落盘。去掉 -WhatIf 即真实执行。'
} else {
    Say-Ok "安装完成：$PN (row id: $ROWID) -> $target"
}
Write-Host ''
Write-Host '  ⚠ 首次安装后必须**重启一次 DSH Desktop**，client 半才会加载（之后的开关热切换不需要重启）。' -ForegroundColor Yellow
Write-Host '  ⚠ 重启后确认输入框上方出现芯片「破甲 关」。' -ForegroundColor Yellow
exit 0
