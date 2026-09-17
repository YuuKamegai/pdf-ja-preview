# PDF fixture

ここには **合成した PDF だけ** を置く。実文書（論文・配布資料など）はリポジトリへ入れない。

## 合成 PDF

`scripts/create-pdf-fixtures.py` が作る。生成には fixture 専用の環境を使い、抽出ワーカー本体の
依存とは分ける。

```powershell
py -3.13 -m venv .venv-pdf-fixtures
./.venv-pdf-fixtures/Scripts/python.exe -m pip install -r python/requirements-fixtures.in
./.venv-pdf-fixtures/Scripts/python.exe scripts/create-pdf-fixtures.py <目視確認用 PNG の出力先>
```

| ファイル | 何を試すためのものか |
|---|---|
| `two-column.pdf` | 二段組みの読み順。右段の先頭が左段の 2 つ目より上にあるので、縦位置で並べると壊れる |
| `general.pdf` | 一段組みの一般文書。見出しと本文、2 ページにまたがる構成 |
| `cropbox.pdf` | MediaBox 620x840 / CropBox `10 20 610 820`。表示領域の原点が 0 でない |
| `rotated.pdf` | 0 / 90 / 180 / 270 度の 4 ページ |
| `image-only.pdf` | 文字が一切ない図だけのページ。`no-text` になる |
| `formula.pdf` | 行を分けて中央に置いた数式。**実 Docling はこれを `formula` として立てない**（1 行目は paragraph、2 行目は heading）。現状を固定する試験がある |
| `page-spanning.pdf` | 改ページをまたぐ段落。1 ページ目の最後の行が文の途中で終わり、2 ページ目の先頭へ続く。実 Docling は 2 ページ分の provenance を持つ 1 ブロックで返すので、中間形式では `regions` が 2 件になる |

生成し直すと、中身が同じでも PDF のバイト列は変わります（生成日時と file ID が入る）。
`extracted-<name>.json` の `hash` は元の PDF の sha256 なので、**中身を変えていないなら
PDF を差し替えないでください。** 差し替えるなら `docling-<name>.json` と
`extracted-<name>.json` も一緒に作り直します。

## 期待値（manifest）

`expected.json` が**人が独立に確認した期待値**。すべての合成 fixture について、
ページ寸法・回転・CropBox 原点・状態と、段落ごとの期待矩形・読み順を持ちます。抽出器の出力から作っていない。値は
生成スクリプトの描画位置と、pypdfium2 が返す文字矩形（抽出器とは別経路）から求め、
レンダリング画像を目で見て確かめた。

矩形の照合は `boxTolerance` と「期待矩形を含むこと」で行う。レイアウト抽出の矩形は
行の外接矩形より広く取られるので、ピクセル一致は求めない。

## 抽出器の生出力

`docling-<name>.json` は **実際の Docling が各 PDF を変換した生出力**。
手で書いていない。作り直すときは:

```powershell
docker run --rm --network none -v "${PWD}/test/fixtures/pdf:/in:ro" `
  --entrypoint python pdf-ja-extractor:1 -m pdf_ja.dump_raw /in/two-column.pdf `
  > test/fixtures/pdf/docling-two-column.json
```

形を推測して書いた fixture は、実装と同じ誤解を共有したまま緑になり、実データでだけ壊れる。

## 正規化済みの中間形式

`extracted-<name>.json` は、**実 Docling の出力を `normalize` に通し、TypeScript の
`parseDocument` で検証したもの**。ブラウザ試験の fixture server がこれを返します。
作り直すときは:

```powershell
$sha = (Get-FileHash test/fixtures/pdf/two-column.pdf -Algorithm SHA256).Hash.ToLower()
docker run --rm --network none -v "${PWD}/test/fixtures/pdf:/in:ro" pdf-ja-extractor:1 `
  --input /in/two-column.pdf --hash $sha --models /models > worker.json
node --import tsx scripts/inspect-document.ts worker.json --json test/fixtures/pdf/extracted-two-column.json
```

## 契約試験用の最小例

`document-v1.json` は `pdf-document.v1` の契約試験用。PDF からは作っていない、
手書きの最小例。
