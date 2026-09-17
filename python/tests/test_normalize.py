"""正規化の試験。

入力は **実際の Docling が合成 fixture を変換した生出力**。形を推測して書いた
fixture は、実装と同じ誤解を共有したまま緑になる。

期待する読み順は `test/fixtures/pdf/expected.json` に人が独立に記録したもので、
fixture を並べ替えて作っていない。
"""

from __future__ import annotations

import json
from pathlib import Path

import pytest

from pdf_ja.normalize import NormalizeError, normalize_document

HASH = "a" * 64
CONFIG = "b" * 64
VERSION = "test"


def _load(fixtures_dir: Path, name: str) -> dict:
    return json.loads((fixtures_dir / name).read_text(encoding="utf-8"))


@pytest.fixture(scope="session")
def expected(fixtures_dir: Path) -> dict:
    return _load(fixtures_dir, "expected.json")


@pytest.fixture
def two_column(fixtures_dir: Path) -> dict:
    return _load(fixtures_dir, "docling-two-column.json")


def _page(number: int = 1, width: float = 600, height: float = 800, rotation: int = 0,
          has_text: bool = True) -> dict:
    return {
        "number": number,
        "width": width,
        "height": height,
        "rotation": rotation,
        "hasText": has_text,
    }


def _sources(out: dict) -> list[str]:
    return [block["source"] for block in out["blocks"] if block["translatable"]]


def _marker_order(sources: list[str], markers: list[str]) -> list[str]:
    """各ブロックの先頭に置いた目印を、出てきた順に返す。"""
    found = []
    for source in sources:
        for marker in markers:
            if source.startswith(marker):
                found.append(marker)
                break
    return found


def test_body_tree_wins_over_vertical_position(two_column, expected) -> None:
    """二段組みの読み順は body の階層から取る。縦位置で並べると壊れる。

    fixture では 'Right first.' が 'Left second.' より **上** にある。
    """
    out = normalize_document(two_column, HASH, VERSION, CONFIG, [_page()])
    markers = expected["fixtures"]["two-column.pdf"]["readingOrder"]
    assert _marker_order(_sources(out), markers) == markers


def test_vertical_order_would_differ(two_column, expected) -> None:
    """縦位置で並べた順が期待順と違うことを確かめ、上の試験が効いていることを示す。"""
    out = normalize_document(two_column, HASH, VERSION, CONFIG, [_page()])
    translatable = [b for b in out["blocks"] if b["translatable"] and b["regions"]]
    by_top = sorted(translatable, key=lambda b: b["regions"][0]["box"][1])
    markers = expected["fixtures"]["two-column.pdf"]["readingOrder"]
    assert _marker_order([b["source"] for b in by_top], markers) != markers


def test_caption_is_not_duplicated(two_column) -> None:
    """キャプションは picture の children と captions の両方に出る。ID で弾く。"""
    out = normalize_document(two_column, HASH, VERSION, CONFIG, [_page()])
    ids = [block["id"] for block in out["blocks"]]
    assert len(ids) == len(set(ids))
    captions = [b for b in out["blocks"] if b["source"].startswith("Figure caption.")]
    assert len(captions) == 1


def test_caption_and_picture_are_linked(two_column) -> None:
    out = normalize_document(two_column, HASH, VERSION, CONFIG, [_page()])
    caption = next(b for b in out["blocks"] if b["source"].startswith("Figure caption."))
    picture = next(b for b in out["blocks"] if b["kind"] == "picture")
    assert picture["id"] in caption["relatedIds"]
    assert caption["id"] in picture["relatedIds"]
    assert picture["translatable"] is False
    assert picture["source"] == ""


def test_furniture_is_collected_but_not_translated(two_column) -> None:
    out = normalize_document(two_column, HASH, VERSION, CONFIG, [_page()])
    furniture = [b for b in out["blocks"] if b["kind"] == "furniture"]
    assert [b["source"] for b in furniture] == ["Preprint - page 1"]
    assert all(b["translatable"] is False for b in furniture)


def test_heading_context_is_carried_into_body_blocks(fixtures_dir: Path) -> None:
    raw = _load(fixtures_dir, "docling-general.json")
    out = normalize_document(
        raw, HASH, VERSION, CONFIG,
        [_page(1, 612, 792), _page(2, 612, 792)],
    )
    body = next(b for b in out["blocks"] if b["source"].startswith("Samples were held"))
    assert "Method" in body["headingContext"]


def test_boxes_match_independently_recorded_expectations(two_column, expected) -> None:
    spec = expected["fixtures"]["two-column.pdf"]
    tolerance = expected["boxTolerance"]
    out = normalize_document(two_column, HASH, VERSION, CONFIG, [_page()])

    for want in spec["blocks"]:
        marker = want["source"]
        block = next(b for b in out["blocks"] if b["source"].startswith(marker))
        region = next(r for r in block["regions"] if r["page"] == want["page"])
        got, exp = region["box"], want["box"]
        # 抽出の矩形は行の外接矩形より広い。期待矩形を含み、外へはみ出さないこと。
        assert got[0] <= exp[0] + tolerance and got[1] <= exp[1] + tolerance
        assert got[2] >= exp[2] - tolerance and got[3] >= exp[3] - tolerance
        assert all(0.0 <= value <= 1.0 for value in got)


def test_picture_box_matches_expectation(two_column, expected) -> None:
    spec = expected["fixtures"]["two-column.pdf"]["pictures"][0]
    tolerance = expected["boxTolerance"]
    out = normalize_document(two_column, HASH, VERSION, CONFIG, [_page()])
    picture = next(b for b in out["blocks"] if b["kind"] == "picture")
    got = picture["regions"][0]["box"]
    for index in range(4):
        assert abs(got[index] - spec["box"][index]) <= tolerance


def test_char_range_is_end_exclusive_and_within_source(two_column) -> None:
    out = normalize_document(two_column, HASH, VERSION, CONFIG, [_page()])
    for block in out["blocks"]:
        for region in block["regions"]:
            span = region.get("charRange")
            if span is None:
                continue
            assert 0 <= span[0] < span[1] <= len(block["source"])


def test_cropbox_origin_is_already_removed_by_the_extractor(fixtures_dir: Path) -> None:
    """抽出側の座標は CropBox 原点を引いた後。表示領域の寸法でそのまま割れる。"""
    raw = _load(fixtures_dir, "docling-cropbox.json")
    out = normalize_document(raw, HASH, VERSION, CONFIG, [_page(1, 600, 800)])
    heading = next(b for b in out["blocks"] if b["source"] == "Cropped Page")
    box = heading["regions"][0]["box"]
    # CropBox 原点 (10, 20) を引いた後の l=60, t=752.9 に対応する。
    assert abs(box[0] - 60.0 / 600.0) < 0.01
    assert abs(box[1] - (800.0 - 752.9) / 800.0) < 0.01


@pytest.mark.parametrize(
    "page_number,rotation",
    [(1, 0), (2, 90), (3, 180), (4, 270)],
)
def test_rotation_is_undone_into_pre_rotation_coordinates(
    fixtures_dir: Path, page_number: int, rotation: int
) -> None:
    """抽出は回転後の座標を返す。中間形式は回転前に戻す（PDF.js の view に合わせる）。

    どのページも同じ内容を同じ位置に描いてあるので、回転を戻せば box は一致する。
    """
    raw = _load(fixtures_dir, "docling-rotated.json")
    geometry = [_page(n, 600, 800, r) for n, r in ((1, 0), (2, 90), (3, 180), (4, 270))]
    out = normalize_document(raw, HASH, VERSION, CONFIG, geometry)

    blocks = [
        b
        for b in out["blocks"]
        if b["regions"] and b["regions"][0]["page"] == page_number
        and b["source"].startswith("Body text of page")
    ]
    assert blocks, f"ページ {page_number} に本文がありません"
    box = blocks[0]["regions"][0]["box"]
    # 全ページ共通の描画位置: x 60..、y は上から約 0.14。
    assert abs(box[0] - 0.1) < 0.02, box
    assert abs(box[1] - 0.1414) < 0.02, box


def test_no_text_page_is_marked_and_warned(fixtures_dir: Path) -> None:
    raw = _load(fixtures_dir, "docling-image-only.json")
    out = normalize_document(raw, HASH, VERSION, CONFIG, [_page(has_text=False)])
    assert out["pages"][0]["status"] == "no-text"
    assert any("文章を抽出できません" in warning for warning in out["warnings"])
    assert _sources(out) == []


def test_size_mismatch_disables_positions_with_a_warning(two_column) -> None:
    """抽出側と PDF 側でページ寸法が違えば、位置は捨てて警告する。"""
    out = normalize_document(two_column, HASH, VERSION, CONFIG, [_page(1, 400, 500)])
    assert any("寸法が一致しません" in warning for warning in out["warnings"])
    assert all(block["regions"] == [] for block in out["blocks"])
    # 位置が無くても本文は残る。見失わせない。
    assert any(source.startswith("Left first.") for source in _sources(out))


def test_unknown_page_reference_is_warned_not_fatal(two_column) -> None:
    out = normalize_document(two_column, HASH, VERSION, CONFIG, [_page(2)])
    assert any("ページ 1" in warning for warning in out["warnings"])


def test_rejects_non_dict_input() -> None:
    with pytest.raises(NormalizeError):
        normalize_document([], HASH, VERSION, CONFIG, [_page()])


def test_rejects_missing_page_geometry(two_column) -> None:
    with pytest.raises(NormalizeError):
        normalize_document(two_column, HASH, VERSION, CONFIG, [])


def test_order_is_zero_based_and_unique(two_column) -> None:
    out = normalize_document(two_column, HASH, VERSION, CONFIG, [_page()])
    orders = [block["order"] for block in out["blocks"]]
    assert orders == list(range(len(orders)))


def test_schema_and_hashes_are_passed_through(two_column) -> None:
    out = normalize_document(two_column, HASH, VERSION, CONFIG, [_page()])
    assert out["schema"] == "pdf-document.v1"
    assert out["hash"] == HASH
    assert out["extractor"] == {"version": VERSION, "configHash": CONFIG}
