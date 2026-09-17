"""Docling の生出力をそのまま JSON で吐く開発用ツール。

正規化の fixture は **実出力から** 作る。形を推測して書いた fixture は、実装と
同じ誤解を共有したまま緑になり、実データでだけ壊れる。

    docker run --rm -v <dir>:/in:ro --entrypoint python pdf-ja-extractor \
        -m pdf_ja.dump_raw /in/two-column.pdf
"""

from __future__ import annotations

import json
import sys

from .convert import convert_to_raw


def main(argv: list[str]) -> int:
    if len(argv) != 2:
        print("usage: python -m pdf_ja.dump_raw <pdf>", file=sys.stderr)
        return 2
    raw, page_status = convert_to_raw(argv[1])
    if page_status:
        print(f"page failures: {page_status}", file=sys.stderr)
    json.dump(raw, sys.stdout, ensure_ascii=False, indent=2, sort_keys=True)
    sys.stdout.write("\n")
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv))
