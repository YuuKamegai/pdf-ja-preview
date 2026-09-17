"""PDF そのものから読む情報。Docling とは独立に pypdf で確認する。

ページ寸法・CropBox・回転をここで取り、Docling 側の値と突き合わせる。片方だけを
信じると、CropBox の原点が 0 でないページで位置がずれたまま気づけない。
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any


class PdfInputError(Exception):
    """PDF として扱えない、または対象外の入力。"""

    def __init__(self, code: str, message: str) -> None:
        super().__init__(message)
        self.code = code


@dataclass
class PageGeometry:
    number: int
    """CropBox の幅・高さ（表示領域）。"""
    width: float
    height: float
    """CropBox の原点。0 でないことがある。"""
    origin_x: float
    origin_y: float
    rotation: int
    has_text: bool

    def to_dict(self) -> dict[str, Any]:
        return {
            "number": self.number,
            "width": self.width,
            "height": self.height,
            "originX": self.origin_x,
            "originY": self.origin_y,
            "rotation": self.rotation,
            "hasText": self.has_text,
        }


@dataclass
class PdfInfo:
    page_count: int
    pages: list[PageGeometry] = field(default_factory=list)

    def geometry_dicts(self) -> list[dict[str, Any]]:
        return [page.to_dict() for page in self.pages]


def _normalize_rotation(value: Any) -> int:
    try:
        rotation = int(value or 0)
    except (TypeError, ValueError):
        return 0
    rotation %= 360
    if rotation < 0:
        rotation += 360
    # 90 の倍数でない回転は初期版の対象外。近い値へ丸めず 0 として扱い、
    # 位置同期は上位で警告のうえ無効にする。
    return rotation if rotation in (0, 90, 180, 270) else 0


def read_pdf_info(path: str, max_pages: int) -> PdfInfo:
    """ページ数・暗号化・寸法・文字の有無を調べる。

    `max_pages` を超える文書は、変換を始める前に拒否する。
    """
    from pypdf import PdfReader
    from pypdf.errors import PdfReadError

    try:
        reader = PdfReader(path)
    except PdfReadError as error:
        raise PdfInputError("invalid-pdf", f"PDF として読めません: {error}") from error
    except Exception as error:  # pypdf は壊れた入力で多様な例外を投げる
        raise PdfInputError("invalid-pdf", f"PDF として読めません: {error}") from error

    if reader.is_encrypted:
        # 空パスワードで開けるものだけ通す。開けなければ対象外。
        try:
            opened = reader.decrypt("")
        except Exception:
            opened = 0
        if not opened:
            raise PdfInputError("encrypted-pdf", "暗号化された PDF は扱えません")

    try:
        page_count = len(reader.pages)
    except Exception as error:
        raise PdfInputError("invalid-pdf", f"ページを読めません: {error}") from error

    if page_count == 0:
        raise PdfInputError("empty-pdf", "ページがありません")
    if page_count > max_pages:
        raise PdfInputError(
            "too-many-pages",
            f"ページ数が上限 {max_pages} を超えています: {page_count}",
        )

    pages: list[PageGeometry] = []
    for index in range(page_count):
        page = reader.pages[index]
        box = page.cropbox
        left, bottom = float(box.left), float(box.bottom)
        right, top = float(box.right), float(box.top)
        width, height = abs(right - left), abs(top - bottom)
        if width <= 0 or height <= 0:
            raise PdfInputError("invalid-pdf", f"ページ {index + 1} の表示領域が空です")

        try:
            text = page.extract_text() or ""
        except Exception:
            text = ""

        pages.append(
            PageGeometry(
                number=index + 1,
                width=width,
                height=height,
                origin_x=min(left, right),
                origin_y=min(bottom, top),
                rotation=_normalize_rotation(page.get("/Rotate", 0)),
                has_text=text.strip() != "",
            )
        )

    return PdfInfo(page_count=page_count, pages=pages)
