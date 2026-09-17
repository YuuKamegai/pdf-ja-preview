<#
.SYNOPSIS
    実文書を実 Docling・実 Ollama で通し、結果を記録する。

.DESCRIPTION
    文書も訳文もリポジトリへは書かない。結果は -OutDir（リポジトリの外）へ出す。

    先に `scripts/setup-pdf.ps1` を実行して抽出イメージを作り、Ollama を起動して
    おくこと。

.PARAMETER PdfPath
    通す PDF の絶対パス。

.PARAMETER Model
    翻訳に使う Ollama のモデル名。入っているものから選ぶ。勝手に取得しない。

.PARAMETER OutDir
    結果の置き場所。リポジトリの外を指すこと。

.PARAMETER MaxBlocks
    訳すブロック数の上限。実文書は数百ブロックあるので、既定は先頭 30 件。

.EXAMPLE
    pwsh -File scripts/validate-pdf.ps1 -PdfPath C:\papers\example.pdf `
        -Model qwen3.5:9b-q4_K_M -OutDir $env:TEMP\pdf-ja-validation
#>
[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)][string]$PdfPath,
    [string]$Model = 'qwen3.5:9b-q4_K_M',
    [string]$OutDir = (Join-Path $env:TEMP 'pdf-ja-validation'),
    [int]$MaxBlocks = 30,
    [string]$Image = 'pdf-ja-extractor:1',
    [string]$Endpoint = 'http://127.0.0.1:11434'
)

$ErrorActionPreference = 'Stop'
$repo = Split-Path -Parent $PSScriptRoot

if (-not (Test-Path $PdfPath)) { throw "PDF がありません: $PdfPath" }

Write-Host '==> Docker と Ollama を確認する' -ForegroundColor Cyan
docker version --format '{{.Server.Version}}' | Out-Null
if ($LASTEXITCODE -ne 0) { throw 'Docker に接続できません。Docker Desktop を起動してください。' }

$tags = try { Invoke-RestMethod -Uri "$Endpoint/api/tags" -TimeoutSec 5 } catch { $null }
if ($null -eq $tags) { throw "Ollama に接続できません: $Endpoint" }
$available = $tags.models | ForEach-Object { $_.name }
Write-Host "    使えるモデル: $($available -join ', ')"
if ($available -notcontains $Model) {
    throw "モデルが入っていません: $Model。上の一覧から選んでください（勝手に取得しません）。"
}

Write-Host '==> 抽出と翻訳を通す' -ForegroundColor Cyan
& node --import tsx (Join-Path $repo 'scripts/validate-pdf.ts') `
    --pdf $PdfPath --model $Model --out $OutDir --max-blocks $MaxBlocks `
    --image $Image --endpoint $Endpoint
$code = $LASTEXITCODE

Write-Host ''
if ($code -eq 0) {
    Write-Host "完了しました。結果: $OutDir" -ForegroundColor Green
} elseif ($code -eq 3) {
    Write-Host "翻訳に失敗したブロックがあります。結果: $OutDir" -ForegroundColor Yellow
} else {
    Write-Host "失敗しました (exit $code)" -ForegroundColor Red
}
exit $code
