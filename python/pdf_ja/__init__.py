"""PDF 抽出ワーカー。

`normalize` は標準ライブラリだけで動く（Windows の venv でも試験できる）。
`worker` は Docling を遅延 import し、前検査は pypdf で行う。
"""

__all__ = ["EXTRACTOR_VERSION"]

#: 抽出結果のキャッシュ鍵に入る。抽出の出力が変わったら上げる。
EXTRACTOR_VERSION = "docling-1"
