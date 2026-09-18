from __future__ import annotations

from pathlib import Path

import pytest
from pypdf import PdfReader, PdfWriter

from pdf_ja.pdfinfo import PdfInputError, read_pdf_info

# read_pdf_info 自体の境界を見るための、この試験だけの上限。
# アプリが実際に使う値は pdf_ja.worker.MAX_PAGES（下の基準文書の試験で見る）。
LIMIT = 300


def test_two_column_page_geometry(fixtures_dir: Path) -> None:
    info = read_pdf_info(str(fixtures_dir / "two-column.pdf"), LIMIT)
    assert info.page_count == 1
    page = info.pages[0]
    assert (page.width, page.height) == (600.0, 800.0)
    assert (page.origin_x, page.origin_y) == (0.0, 0.0)
    assert page.rotation == 0
    assert page.has_text is True


def test_cropbox_origin_is_reported(fixtures_dir: Path) -> None:
    """MediaBox 620x840 / CropBox 10 20 610 820。表示領域は 600x800。"""
    info = read_pdf_info(str(fixtures_dir / "cropbox.pdf"), LIMIT)
    page = info.pages[0]
    assert (page.width, page.height) == (600.0, 800.0)
    assert (page.origin_x, page.origin_y) == (10.0, 20.0)


def test_rotation_is_read_per_page(fixtures_dir: Path) -> None:
    info = read_pdf_info(str(fixtures_dir / "rotated.pdf"), LIMIT)
    assert [page.rotation for page in info.pages] == [0, 90, 180, 270]


def test_image_only_page_has_no_text(fixtures_dir: Path) -> None:
    info = read_pdf_info(str(fixtures_dir / "image-only.pdf"), LIMIT)
    assert info.pages[0].has_text is False


def test_rejects_non_pdf(tmp_path: Path) -> None:
    broken = tmp_path / "broken.pdf"
    broken.write_bytes(b"not a pdf at all")
    with pytest.raises(PdfInputError) as caught:
        read_pdf_info(str(broken), LIMIT)
    assert caught.value.code == "invalid-pdf"


def test_rejects_encrypted(tmp_path: Path, fixtures_dir: Path) -> None:
    writer = PdfWriter(clone_from=str(fixtures_dir / "two-column.pdf"))
    writer.encrypt("secret", algorithm="RC4-128")
    encrypted = tmp_path / "encrypted.pdf"
    with encrypted.open("wb") as handle:
        writer.write(handle)

    with pytest.raises(PdfInputError) as caught:
        read_pdf_info(str(encrypted), LIMIT)
    assert caught.value.code == "encrypted-pdf"


def test_rejects_one_page_over_the_given_limit(tmp_path: Path) -> None:
    writer = PdfWriter()
    for _ in range(LIMIT + 1):
        writer.add_blank_page(width=600, height=800)
    big = tmp_path / "big.pdf"
    with big.open("wb") as handle:
        writer.write(handle)

    with pytest.raises(PdfInputError) as caught:
        read_pdf_info(str(big), LIMIT)
    assert caught.value.code == "too-many-pages"
    assert str(LIMIT + 1) in str(caught.value)


def test_accepts_exactly_the_limit(tmp_path: Path) -> None:
    writer = PdfWriter()
    for _ in range(3):
        writer.add_blank_page(width=600, height=800)
    small = tmp_path / "small.pdf"
    with small.open("wb") as handle:
        writer.write(handle)

    info = read_pdf_info(str(small), 3)
    assert info.page_count == 3
    assert all(page.has_text is False for page in info.pages)


def test_empty_password_encryption_is_opened(tmp_path: Path, fixtures_dir: Path) -> None:
    """所有者パスワードだけの PDF は空パスワードで開けるので拒否しない。"""
    writer = PdfWriter(clone_from=str(fixtures_dir / "two-column.pdf"))
    writer.encrypt("", owner_password="owner", algorithm="RC4-128")
    path = tmp_path / "owner-only.pdf"
    with path.open("wb") as handle:
        writer.write(handle)

    info = read_pdf_info(str(path), LIMIT)
    assert info.page_count == 1
    assert PdfReader(str(path)).is_encrypted is True


def test_reference_document_page_count_passes_the_real_limit(tmp_path: Path) -> None:
    """基準文書と同じ 390 ページが、実際に使う上限を通ること。

    上限は `pdf_ja.worker` から取る。この試験に値を書き写すと、上限を下げても
    試験が緑のままになる。
    """
    from pdf_ja.worker import MAX_PAGES as REAL_MAX_PAGES

    writer = PdfWriter()
    for _ in range(390):
        writer.add_blank_page(width=505, height=720)
    path = tmp_path / "reference-sized.pdf"
    with path.open("wb") as handle:
        writer.write(handle)

    info = read_pdf_info(str(path), REAL_MAX_PAGES)
    assert info.page_count == 390
