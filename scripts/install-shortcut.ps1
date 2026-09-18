<#
.SYNOPSIS
    PDF 日本語プレビューを起動するショートカットを作る。

.DESCRIPTION
    この machine は Smart App Control が Enforce で、自分で作った未署名の .exe は
    OS に弾かれる（`failures/smart-app-control-blocks-torch-dlls.md` と同じ壁）。
    そこで実行ファイルは作らず、署名済みの node.exe を指すショートカットを置く。

    ショートカットは次を起動する:

        node.exe "<repo>\dist-web\server.cjs" --open --launcher

    `--open` で既定のブラウザが開く。`--launcher` は、前提が足りないときに窓を
    開いたままにして、何が足りないかを読ませるための印。

.PARAMETER Destination
    置き場所。フォルダを渡すとその中へ、.lnk を渡すとその名前で作る。
    既定はデスクトップ。

.PARAMETER Name
    ショートカットの名前。既定は「PDF 日本語プレビュー」。

.PARAMETER Force
    既にあるショートカットを上書きする。

.EXAMPLE
    powershell -ExecutionPolicy Bypass -File scripts/install-shortcut.ps1
#>
[CmdletBinding()]
param(
    [string]$Destination = '',
    [string]$Name = 'PDF 日本語プレビュー',
    [switch]$Force
)

$ErrorActionPreference = 'Stop'
$repo = Split-Path -Parent $PSScriptRoot

function Write-Step([string]$text) {
    Write-Host "==> $text" -ForegroundColor Cyan
}

Write-Step 'node.exe を探す'
$node = Get-Command node -CommandType Application -ErrorAction SilentlyContinue |
    Select-Object -First 1
if ($null -eq $node) {
    throw 'node が PATH にありません。Node.js を入れてから実行してください。'
}
# ショートカットは PATH を見ないので、絶対パスで固定する。
$nodePath = $node.Source
Write-Host "    $nodePath"

$entry = Join-Path $repo 'dist-web\server.cjs'
if (-not (Test-Path $entry)) {
    # 止めはしない。先にビルドしていなくてもショートカットは作れる。
    Write-Host '    注意: dist-web がまだありません。npm run build:web を先に実行してください。' -ForegroundColor Yellow
}

Write-Step '置き場所を決める'
if ($Destination -eq '') {
    $Destination = [Environment]::GetFolderPath('Desktop')
}
if ($Destination -like '*.lnk') {
    $linkPath = $Destination
} else {
    if (-not (Test-Path $Destination)) {
        throw "置き場所がありません: $Destination"
    }
    $linkPath = Join-Path $Destination "$Name.lnk"
}
Write-Host "    $linkPath"

if ((Test-Path $linkPath) -and -not $Force) {
    throw "既にあります: $linkPath`n上書きするなら -Force を付けてください。"
}

Write-Step 'ショートカットを作る'
$shell = New-Object -ComObject WScript.Shell
$link = $shell.CreateShortcut($linkPath)
$link.TargetPath = $nodePath
# 引用符で包む。リポジトリの場所に空白が入っていても壊れないように。
$link.Arguments = '"{0}" --open --launcher' -f $entry
$link.WorkingDirectory = $repo
$link.Description = 'PDF を原文と日本語訳で並べて読む（ローカル）'
$link.WindowStyle = 1   # 通常の窓。ログと終了操作を見せる。

$icon = Join-Path $repo 'media\pdf-ja.ico'
if (Test-Path $icon) {
    $link.IconLocation = "$icon,0"
} else {
    Write-Host '    注意: media\pdf-ja.ico がありません。node.exe のアイコンになります。' -ForegroundColor Yellow
}
$link.Save()

Write-Step '書いたものを読み返す'
$saved = $shell.CreateShortcut($linkPath)
if ($saved.TargetPath -ne $nodePath) {
    throw "ショートカットの指す先が違います: $($saved.TargetPath)"
}
Write-Host "    指す先  : $($saved.TargetPath)"
Write-Host "    引数    : $($saved.Arguments)"
Write-Host "    作業先  : $($saved.WorkingDirectory)"
Write-Host "    アイコン: $(if ($saved.IconLocation -eq ',0') { '(既定)' } else { $saved.IconLocation })"
Write-Host ''
Write-Host "できました。ダブルクリックで起動します: $linkPath" -ForegroundColor Green
