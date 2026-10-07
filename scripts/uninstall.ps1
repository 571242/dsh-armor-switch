<#
.SYNOPSIS
    幂等卸载 dsh-armor-switch（破甲开关），把 profile 恢复到安装前的文本状态。

.DESCRIPTION
    做四件事，全部可重复执行、改前先备份：
      1. 删除 <profile>\node_modules\dsh-armor-switch（真实拷贝目录；若历史遗留的是
         junction/符号链接，只删链接本身，绝不递归删到源目录）
      2. 从 package.json 的 dependencies 移除 "dsh-armor-switch"
      3. 从 package.json 的 dsh.profile.bundles 移除 "dsh-armor-switch"
      4. 从 cordis.patch.yml 移除 armor-switch 的 insert 条目（纯文本精确匹配，
         其余内容与中文注释逐字保留）

    **绝不删除 %USERPROFILE%\.dsh\plugins\dsh-armor-switch 源目录**，除非显式传 -PurgeSource。
    写回一律 UTF8 无 BOM。

.PARAMETER ProfilePath
    profile 目录。默认 %USERPROFILE%\.dsh\profiles\desktop

.PARAMETER StagingPath
    中转源目录（~/.dsh/plugins/dsh-armor-switch）。只在 -PurgeSource 时被删除。

.PARAMETER PurgeSource
    同时删除中转源目录。默认关闭（以后重装更快，且源目录是唯一真源）。

.PARAMETER KeepBackups
    即使没有任何实际改动，也照样生成一份 .bak 时间戳备份。

.EXAMPLE
    powershell -NoProfile -ExecutionPolicy Bypass -File .\uninstall-armor-switch.ps1 -WhatIf
    powershell -NoProfile -ExecutionPolicy Bypass -File .\uninstall-armor-switch.ps1
#>
[CmdletBinding(SupportsShouldProcess = $true, ConfirmImpact = 'Medium')]
param(
    [string]$ProfilePath,
    [string]$StagingPath,
    [switch]$PurgeSource,
    [switch]$KeepBackups
)

$ErrorActionPreference = 'Stop'

function Say-Head([string]$t) { Write-Host ''; Write-Host "==== $t ====" -ForegroundColor Cyan }
function Say-Info([string]$t) { Write-Host "  $t" }
function Say-Act([string]$t)  { Write-Host "  [DO]     $t" -ForegroundColor Green }
function Say-Plan([string]$t) { Write-Host "  [WhatIf] $t" -ForegroundColor Yellow }
function Say-Skip([string]$t) { Write-Host "  [SKIP]   $t" -ForegroundColor DarkGray }
function Say-Warn([string]$t) { Write-Host "  [WARN]   $t" -ForegroundColor Yellow }
function Say-Ok([string]$t)   { Write-Host "  [OK]     $t" -ForegroundColor Green }
function Say-Err([string]$t)  { Write-Host "  [ERROR]  $t" -ForegroundColor Red }

$dry   = [bool]$WhatIfPreference
$stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
$PN    = 'dsh-armor-switch'
$ROWID = 'armor-switch'

function Get-Nl([string]$t) { if ($t -match "`r`n") { return "`r`n" } else { return "`n" } }
function Read-Text([string]$p) { return [System.IO.File]::ReadAllText($p) }

function Write-TextUtf8NoBom([string]$p, [string]$t) {
    $enc = New-Object System.Text.UTF8Encoding($false)
    [System.IO.File]::WriteAllText($p, $t, $enc)
    $b = [System.IO.File]::ReadAllBytes($p)
    if ($b.Length -ge 3 -and $b[0] -eq 0xEF -and $b[1] -eq 0xBB -and $b[2] -eq 0xBF) {
        throw "写回后检测到 BOM: $p"
    }
}

function Backup-File([string]$p, [string]$suffix) {
    $bak = "$p.bak-$suffix"
    $i = 1
    while (Test-Path -LiteralPath $bak) { $bak = "$p.bak-$suffix-$i"; $i++ }
    Copy-Item -LiteralPath $p -Destination $bak -Force
    return $bak
}

function Remove-DirSafely([string]$p) {
    $item = Get-Item -LiteralPath $p -Force
    $isLink = [bool]($item.Attributes -band [System.IO.FileAttributes]::ReparsePoint)
    if ($isLink) { [System.IO.Directory]::Delete($p, $false) } else { Remove-Item -LiteralPath $p -Recurse -Force }
}

# 找到 "key": { ... } 的括号区间
function Get-ObjectBounds([string]$text, [string]$keyPattern) {
    $m = [regex]::Match($text, $keyPattern)
    if (-not $m.Success) { return $null }
    $open = $m.Index + $m.Length - 1
    $openCh = $text[$open]
    if ($openCh -ne '{' -and $openCh -ne '[') { return $null }
    $closeCh = if ($openCh -eq '{') { '}' } else { ']' }
    $depth = 0
    for ($i = $open; $i -lt $text.Length; $i++) {
        $c = $text[$i]
        if ($c -eq $openCh) { $depth++ }
        elseif ($c -eq $closeCh) { $depth--; if ($depth -eq 0) { return @($open, $i) } }
    }
    return $null
}

# 逐行删除块内某一行；并修正末项多余逗号
function Remove-LineFromBlock([string]$text, [array]$bounds, [string]$lineRegex, [string]$nl) {
    $open = $bounds[0]; $close = $bounds[1]
    $inner = $text.Substring($open + 1, $close - $open - 1)
    $parts = [regex]::Split($inner, "(?<=\n)")
    $kept = New-Object System.Collections.Generic.List[string]
    $removed = 0
    foreach ($p in $parts) {
        $probe = $p.Trim()
        if ($probe -ne '' -and [regex]::IsMatch($p, $lineRegex)) { $removed++; continue }
        $kept.Add($p)
    }
    if ($removed -eq 0) {
        # 回退：同一行内联形式（正常 profile 是逐行展开的，这里只为稳健）
        $bare = [regex]::Escape($PN)
        $inline = [regex]::Replace($inner, '(?:,\s*)?"' + $bare + '"\s*:\s*"[^"]*"', '', 1)
        if ($inline -eq $inner) { return @{ Changed = $false; Text = $text } }
        $innerNew = $inline
    } else {
        $innerNew = ($kept.ToArray() -join '')
    }
    # 末项多余逗号：只去掉逗号本身，保留换行与缩进（捕获组回填空白）
    $lines2 = [regex]::Split($innerNew, "(?<=\n)")
    for ($i = $lines2.Count - 1; $i -ge 0; $i--) {
        if ($lines2[$i].Trim() -eq '') { continue }
        $lines2[$i] = [regex]::Replace($lines2[$i], ',(\s*)$', '$1')
        break
    }
    $innerNew = ($lines2 -join '')
    return @{ Changed = $true; Text = $text.Substring(0, $open + 1) + $innerNew + $text.Substring($close); Count = $removed }
}

function Get-ArmorEntryBounds([string[]]$lines) {
    $idIdx = -1
    for ($i = 0; $i -lt $lines.Count; $i++) {
        if ($lines[$i] -match '^[ \t]*-?\s*id:\s*armor-switch\s*$') { $idIdx = $i; break }
    }
    if ($idIdx -lt 0) { return $null }
    $start = 0
    for ($i = $idIdx; $i -ge 0; $i--) { if ($lines[$i] -match '^-(?:\s|$)') { $start = $i; break } }
    $end = $lines.Count
    for ($i = $start + 1; $i -lt $lines.Count; $i++) { if ($lines[$i] -match '^-(?:\s|$)') { $end = $i; break } }
    return @($start, $end, $idIdx)
}

# 删除整条 armor-switch 条目，并把结尾多余空行收成一个换行
function Remove-ArmorEntry([string]$text, [string]$nl) {
    $lines = [regex]::Split($text, "(?<=\n)")
    $bounds = Get-ArmorEntryBounds $lines
    if ($null -eq $bounds) { return @{ Changed = $false; Text = $text } }
    $start = $bounds[0]; $end = $bounds[1]
    # 条目是我们追加在末尾的：连带它前面的那个空分隔行一起删掉
    if ($start -gt 0 -and $lines[$start - 1].Trim() -eq '' -and $end -ge ($lines.Count - 1)) { $start = $start - 1 }
    $before = @()
    if ($start -gt 0) { $before = @($lines[0..($start - 1)]) }
    $after = @()
    if ($end -le ($lines.Count - 1)) { $after = @($lines[$end..($lines.Count - 1)]) }
    $out = (($before + $after) -join '')
    $out = [regex]::Replace($out, '(\r?\n){2,}$', $nl)
    return @{ Changed = $true; Text = $out }
}

# ---------------------------------------------------------------- 路径解析
if (-not $ProfilePath) { $ProfilePath = Join-Path $env:USERPROFILE '.dsh\profiles\desktop' }
if (-not $StagingPath) { $StagingPath = Join-Path $env:USERPROFILE '.dsh\plugins\dsh-armor-switch' }

$packageJson = Join-Path $ProfilePath 'package.json'
$patchYml    = Join-Path $ProfilePath 'cordis.patch.yml'
$target      = Join-Path (Join-Path $ProfilePath 'node_modules') $PN

Say-Head 'armor-switch 卸载'
Say-Info "profile : $ProfilePath"
Say-Info "target  : $target"
Say-Info "source  : $StagingPath  (PurgeSource=$([bool]$PurgeSource))"
if ($dry) { Write-Host '  *** WhatIf 模式：只打印计划，不落盘 ***' -ForegroundColor Yellow }

$anyChange = $false

# ---------------------------------------------------------------- 1/4 删除安装副本
Say-Head '1/4 删除 profile\node_modules 下的安装副本'
if (Test-Path -LiteralPath $target) {
    $item = Get-Item -LiteralPath $target -Force
    $isLink = [bool]($item.Attributes -band [System.IO.FileAttributes]::ReparsePoint)
    $kind = if ($isLink) { 'reparse point/junction（只删链接）' } else { '真实目录' }
    if ($dry) {
        Say-Plan "删除 $target  [$kind]"
    } else {
        Remove-DirSafely $target
        Say-Act "已删除 $target  [$kind]"
        if (Test-Path -LiteralPath $target) { Say-Err "删除失败: $target"; exit 1 }
        $anyChange = $true
    }
} else {
    Say-Skip "不存在，无需删除: $target"
}
if (Test-Path -LiteralPath $StagingPath) {
    if ($PurgeSource) {
        if ($dry) { Say-Plan "删除中转源目录 $StagingPath（-PurgeSource）" }
        else { Remove-DirSafely $StagingPath; Say-Act "已删除中转源目录 $StagingPath"; $anyChange = $true }
    } else {
        Say-Skip "保留中转源目录（未传 -PurgeSource）: $StagingPath"
    }
}

# ---------------------------------------------------------------- 2/4 package.json
Say-Head '2/4 清理 package.json'
if (Test-Path -LiteralPath $packageJson) {
    $pjText = Read-Text $packageJson
    $pjNl   = Get-Nl $pjText
    $cur = $pjText
    $depCount = 0; $bunCount = 0

    $dB = Get-ObjectBounds $cur '"dependencies"\s*:\s*\{'
    if ($null -ne $dB) {
        $r = Remove-LineFromBlock $cur $dB ('^\s*"' + [regex]::Escape($PN) + '"\s*:') $pjNl
        if ($r.Changed) { $cur = $r.Text; $depCount = 1 }
    }
    $bB = Get-ObjectBounds $cur '"bundles"\s*:\s*\['
    if ($null -ne $bB) {
        $r = Remove-LineFromBlock $cur $bB ('^\s*"' + [regex]::Escape($PN) + '"\s*,?\s*$') $pjNl
        if ($r.Changed) { $cur = $r.Text; $bunCount = 1 }
    }

    if ($cur -eq $pjText) {
        Say-Skip 'package.json 无 armor-switch 残留，无需改动'
        if ($KeepBackups) {
            if ($dry) { Say-Plan "仍生成备份 package.json.bak-$stamp（-KeepBackups）" }
            else { $b = Backup-File $packageJson $stamp; Say-Act "已备份 -> $(Split-Path -Leaf $b)" }
        }
    } elseif ($dry) {
        Say-Plan "备份 package.json -> package.json.bak-$stamp"
        Say-Plan "移除 dependencies 项（$depCount）、bundles 项（$bunCount），UTF8 无 BOM 写回"
    } else {
        $b = Backup-File $packageJson $stamp
        Say-Act "已备份 -> $(Split-Path -Leaf $b)"
        Write-TextUtf8NoBom $packageJson $cur
        & node -e "JSON.parse(require('fs').readFileSync(process.argv[1],'utf8'))" $packageJson
        if ($LASTEXITCODE -ne 0) { Say-Err 'package.json 写回后不是合法 JSON'; exit 1 }
        Say-Ok "package.json 已清理（dependencies=$depCount bundles=$bunCount，合法 JSON / UTF8 无 BOM）"
        $anyChange = $true
    }
} else {
    Say-Warn "找不到 $packageJson，跳过"
}

# ---------------------------------------------------------------- 3/4 cordis.patch.yml
Say-Head '3/4 从 cordis.patch.yml 移除 armor-switch 条目'
if (Test-Path -LiteralPath $patchYml) {
    $ymlText = Read-Text $patchYml
    $ymlNl   = Get-Nl $ymlText
    $res     = Remove-ArmorEntry $ymlText $ymlNl
    if (-not $res.Changed) {
        Say-Skip 'cordis.patch.yml 里没有 armor-switch 条目，无需改动'
        if ($KeepBackups) {
            if ($dry) { Say-Plan "仍生成备份 cordis.patch.yml.bak-$stamp（-KeepBackups）" }
            else { $b = Backup-File $patchYml $stamp; Say-Act "已备份 -> $(Split-Path -Leaf $b)" }
        }
    } elseif ($dry) {
        Say-Plan "备份 cordis.patch.yml -> cordis.patch.yml.bak-$stamp"
        Say-Plan '精确移除 - insert: / id: armor-switch 条目，其余行（含中文注释）逐字保留'
    } else {
        $b = Backup-File $patchYml $stamp
        Say-Act "已备份 -> $(Split-Path -Leaf $b)"
        Write-TextUtf8NoBom $patchYml $res.Text
        Say-Ok "cordis.patch.yml 已移除 armor-switch 条目（$($ymlText.Length) -> $($res.Text.Length) 字节）"
        $anyChange = $true
    }
} else {
    Say-Warn "找不到 $patchYml，跳过"
}

# ---------------------------------------------------------------- 4/4 后置验证
Say-Head '4/4 后置验证命令（可直接复制执行）'
$pjNode  = $packageJson.Replace('\', '/')
$ymlNode = $patchYml.Replace('\', '/')
$dstNode = $target.Replace('\', '/')
$v1 = "node -e ""const p=require('$pjNode');const b=p.dsh.profile.bundles;const d=p.dependencies;if(b.includes('$PN'))throw new Error('bundles 仍含 $PN');if(d['$PN'])throw new Error('dependencies 仍含 $PN');console.log('CLEAN_OK',b.length,Object.keys(d).length)"""
$v2 = "node -e ""const fs=require('fs');const s=fs.readFileSync('$ymlNode','utf8');if(/id:\s*armor-switch/.test(s))throw new Error('patch 仍含 armor-switch');console.log('PATCH_CLEAN_OK',s.length)"""
$v3 = "node -e ""const fs=require('fs');console.log(fs.existsSync('$dstNode')?'COPY_REMAINS':'COPY_REMOVED')"""
Write-Host ''
Say-Info $v1
Write-Host ''
Say-Info $v2
Write-Host ''
Say-Info $v3

Say-Head '完成'
if ($dry) {
    Say-Info 'WhatIf 模式：未落盘。去掉 -WhatIf 即真实执行。'
} elseif (-not $anyChange) {
    Say-Info '没有任何改动（本来就没装或已卸载干净）。'
} else {
    Say-Ok '卸载完成。'
}
Write-Host ''
Write-Host '  ⚠ 芯片不会立刻消失：需要重启一次 DSH Desktop 才会从 UI 卸载。' -ForegroundColor Yellow
Write-Host '  ⚠ 中转源目录保留在 ~/.dsh/plugins/dsh-armor-switch（未传 -PurgeSource 时不删除）。' -ForegroundColor Yellow
exit 0
