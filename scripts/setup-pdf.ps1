<#
.SYNOPSIS
    PDF 日本語プレビューの抽出環境を用意する。

.DESCRIPTION
    抽出ワーカーは Docker のコンテナで動かす。この machine では Windows の
    Smart App Control が Enforce で、torch などの未署名ネイティブライブラリを
    ローカル venv から読み込めないため。

    ここでは次を行う:
      1. Docker が動いているか確認する
      2. 抽出イメージを構築し、レイアウトモデルをイメージへ焼き込む
      3. 依存の実バージョンを requirements.lock.txt へ固定する
      4. 正規化と前検査の試験用に Windows 側の .venv-pdf を作る（Docling は入れない）

    どの手順もグローバルの Python 環境を変更しない。

.PARAMETER SkipImage
    イメージ構築を飛ばし、Windows 側の試験環境だけ作る。

.PARAMETER Tag
    構築するイメージのタグ。既定は pdf-ja-extractor:1。
#>
[CmdletBinding()]
param(
    [switch]$SkipImage,
    [string]$Tag = 'pdf-ja-extractor:1'
)

$ErrorActionPreference = 'Stop'
$repo = Split-Path -Parent $PSScriptRoot

function Write-Step([string]$text) {
    Write-Host "==> $text" -ForegroundColor Cyan
}

if (-not $SkipImage) {
    Write-Step 'Docker の状態を確認する'
    $server = docker version --format '{{.Server.Version}}' 2>&1
    if ($LASTEXITCODE -ne 0) {
        throw "Docker に接続できません。Docker Desktop を起動してから実行してください。`n$server"
    }
    Write-Host "    Docker Engine $server"

    Write-Step "抽出イメージを構築する ($Tag)"
    $lock = Join-Path $repo 'python/requirements.lock.txt'
    $requirements = if (Test-Path $lock) { 'requirements.lock.txt' } else { 'requirements.in' }
    Write-Host "    依存ファイル: $requirements"
    docker build --build-arg "REQUIREMENTS=$requirements" -t $Tag -f (Join-Path $repo 'python/Dockerfile') (Join-Path $repo 'python')
    if ($LASTEXITCODE -ne 0) { throw 'イメージの構築に失敗しました。' }

    if ($requirements -eq 'requirements.in') {
        Write-Step '解決できた実バージョンを requirements.lock.txt へ固定する'
        $frozen = docker run --rm --entrypoint python $Tag -m pip freeze
        if ($LASTEXITCODE -ne 0) { throw 'pip freeze に失敗しました。' }
        $header = @(
            '# scripts/setup-pdf.ps1 が python/Dockerfile のイメージ内で解決した実バージョン。',
            '# 手で編集しない。更新するときは requirements.in を直し、lock を消して再実行する。'
        )
        ($header + $frozen) -join "`n" | Set-Content -Path $lock -Encoding utf8
        Write-Host "    $lock を更新しました"
    }

    Write-Step 'イメージのモデルと import を確認する'
    docker run --rm --network none --entrypoint python $Tag -c @'
from pathlib import Path
from pdf_ja.convert import build_converter
build_converter()
models = sorted(p.name for p in Path('/models').iterdir())
print('models:', ', '.join(models))
'@
    if ($LASTEXITCODE -ne 0) { throw 'イメージ内の Docling を初期化できませんでした。' }
}

Write-Step 'Windows 側の試験環境 (.venv-pdf) を作る'
$venv = Join-Path $repo '.venv-pdf'
$python = Join-Path $venv 'Scripts/python.exe'
if (-not (Test-Path $python)) {
    py -3.13 -m venv $venv
    if ($LASTEXITCODE -ne 0) { throw 'venv を作れませんでした。Python 3.13 を用意してください。' }
}
& $python -m pip install --upgrade pip --quiet
& $python -m pip install --quiet -r (Join-Path $repo 'python/requirements-test.in')
if ($LASTEXITCODE -ne 0) { throw '試験用の依存を入れられませんでした。' }

Write-Step '合成 fixture を作る環境 (.venv-pdf-fixtures) を作る'
$fixtureVenv = Join-Path $repo '.venv-pdf-fixtures'
$fixturePython = Join-Path $fixtureVenv 'Scripts/python.exe'
if (-not (Test-Path $fixturePython)) {
    py -3.13 -m venv $fixtureVenv
    if ($LASTEXITCODE -ne 0) { throw 'fixture 用 venv を作れませんでした。' }
}
& $fixturePython -m pip install --quiet -r (Join-Path $repo 'python/requirements-fixtures.in')
if ($LASTEXITCODE -ne 0) { throw 'fixture 用の依存を入れられませんでした。' }

Write-Host ''
Write-Host '完了しました。' -ForegroundColor Green
Write-Host "  抽出イメージ : $Tag"
Write-Host "  試験用 python: $python"
Write-Host '  サーバーへは PDF_JA_EXTRACTOR_IMAGE でタグを渡します。'
