"""抽出ワーカーの入出力。

stdout には JSON オブジェクトを **一つだけ** 書く。ログ・進捗・ライブラリの警告は
すべて stderr へ出す。Docling も torch も stdout へ書きうるので、変換中は stdout を
差し替えて守る。

    python -m pdf_ja.worker --input <path> --hash <sha256> --models <path>

成功: {"ok": true, "document": {...}}
失敗: {"ok": false, "error": {"code": "...", "message": "..."}}
"""

from __future__ import annotations

import argparse
import contextlib
import hashlib
import json
import os
import sys
import traceback
from typing import Any

from . import EXTRACTOR_VERSION
from .normalize import normalize_document
from .pdfinfo import PdfInputError, read_pdf_info

MAX_PAGES = 300


def config_hash(models: str) -> str:
    """変換設定の指紋。設定が変わったらキャッシュを外す。

    モデルの**置き場所**は結果を変えないので入れない。入れると環境ごとに
    キャッシュが割れる。
    """
    config = {
        "extractor": EXTRACTOR_VERSION,
        "ocr": False,
        "tableStructure": True,
        "device": "cpu",
        "remoteServices": False,
        "modelsPresent": bool(models),
    }
    payload = json.dumps(config, sort_keys=True, separators=(",", ":"))
    return hashlib.sha256(payload.encode("utf-8")).hexdigest()


def emit(payload: dict[str, Any]) -> None:
    json.dump(payload, sys.stdout, ensure_ascii=False)
    sys.stdout.write("\n")
    sys.stdout.flush()


def emit_error(code: str, message: str) -> int:
    emit({"ok": False, "error": {"code": code, "message": message}})
    return 1


def run(input_path: str, pdf_hash: str, models: str) -> int:
    if not os.path.isfile(input_path):
        return emit_error("missing-input", f"入力が見つかりません: {input_path}")

    try:
        info = read_pdf_info(input_path, MAX_PAGES)
    except PdfInputError as error:
        return emit_error(error.code, str(error))

    if models:
        os.environ.setdefault("DOCLING_ARTIFACTS_PATH", models)

    try:
        # Docling は stdout へ書くことがある。契約は「stdout に JSON 一つ」なので
        # 変換の間だけ stdout を stderr へ向ける。
        from .convert import convert_to_raw

        with contextlib.redirect_stdout(sys.stderr):
            raw, page_status = convert_to_raw(input_path)
    except PdfInputError as error:
        return emit_error(error.code, str(error))
    except Exception as error:  # 変換は多様な例外を投げる
        traceback.print_exc(file=sys.stderr)
        return emit_error("extraction-failed", f"変換に失敗しました: {error}")

    geometry = info.geometry_dicts()
    for entry in geometry:
        override = page_status.get(entry["number"])
        if override:
            entry["status"] = override

    try:
        document = normalize_document(
            raw,
            pdf_hash,
            EXTRACTOR_VERSION,
            config_hash(models),
            geometry,
        )
    except Exception as error:
        traceback.print_exc(file=sys.stderr)
        return emit_error("normalize-failed", f"正規化に失敗しました: {error}")

    emit({"ok": True, "document": document})
    return 0


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(prog="pdf_ja.worker", add_help=True)
    parser.add_argument("--input", required=True, help="変換する PDF のパス")
    parser.add_argument("--hash", required=True, help="PDF の sha256")
    parser.add_argument("--models", default="", help="事前取得したモデルの置き場所")
    args = parser.parse_args(argv)

    if not (len(args.hash) == 64 and all(c in "0123456789abcdef" for c in args.hash)):
        return emit_error("invalid-hash", "--hash は 64 桁の 16 進で渡してください")

    return run(args.input, args.hash, args.models)


if __name__ == "__main__":
    raise SystemExit(main())
