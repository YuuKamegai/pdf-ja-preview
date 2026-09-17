"""Docling 呼び出しだけを閉じ込める層。

ここだけが Docling に依存する。`normalize` は辞書しか見ないので、Docling が
入っていない環境でも試験できる。
"""

from __future__ import annotations

import os
from typing import Any


def build_converter() -> Any:
    """CPU・OCR 無効・リモートサービス無効の変換器を作る。

    モデルはイメージへ焼いた `DOCLING_ARTIFACTS_PATH` からだけ読む。実行時に
    取りに行かせない（コンテナは `--network none` で回す）。
    """
    from docling.datamodel.accelerator_options import AcceleratorDevice, AcceleratorOptions
    from docling.datamodel.base_models import InputFormat
    from docling.datamodel.pipeline_options import PdfPipelineOptions
    from docling.document_converter import DocumentConverter, PdfFormatOption

    options = PdfPipelineOptions()
    options.do_ocr = False
    options.do_table_structure = True
    options.generate_page_images = False
    options.generate_picture_images = False
    options.enable_remote_services = False
    options.artifacts_path = os.environ.get("DOCLING_ARTIFACTS_PATH") or None
    options.accelerator_options = AcceleratorOptions(
        num_threads=int(os.environ.get("OMP_NUM_THREADS", "4")),
        device=AcceleratorDevice.CPU,
    )

    return DocumentConverter(
        format_options={InputFormat.PDF: PdfFormatOption(pipeline_options=options)},
    )


class ConversionFailed(Exception):
    """文書全体の変換に失敗した。"""


def convert_to_raw(path: str) -> tuple[dict[str, Any], dict[int, str]]:
    """PDF を Docling で変換する。

    戻り値は `(DoclingDocument の素の辞書, ページ番号 -> 状態)`。ページ単位の失敗で
    文書全体を捨てない。ページ番号は 1 始まりへ直して返す。
    """
    from docling.datamodel.base_models import ConversionStatus

    result = build_converter().convert(path, raises_on_error=False)

    page_status: dict[int, str] = {}
    for error in result.errors or []:
        page_no = getattr(error, "page_no", None)
        if page_no is None:
            continue
        # Docling の Page.page_no は 0 始まり。中間形式は 1 始まり。
        page_status[int(page_no) + 1] = "failed"

    if result.status == ConversionStatus.FAILURE:
        messages = "; ".join(
            str(getattr(error, "error_message", error)) for error in (result.errors or [])
        )
        raise ConversionFailed(messages or "変換に失敗しました")

    return result.document.export_to_dict(), page_status
