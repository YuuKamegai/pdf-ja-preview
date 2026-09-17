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


def _figure_raw() -> dict:
    """図の枠の中に小さな文字が並ぶ、実際の論文でよくある形。"""

    def text(index: int, label: str, box: tuple[float, float, float, float]) -> dict:
        left, bottom, right, top = box
        return {
            "self_ref": f"#/texts/{index}",
            "label": "text",
            "content_layer": "body",
            "parent": {"$ref": "#/body"},
            "text": label,
            "prov": [
                {
                    "page_no": 1,
                    "charspan": [0, len(label)],
                    "bbox": {
                        "l": left, "b": bottom, "r": right, "t": top,
                        "coord_origin": "BOTTOMLEFT",
                    },
                }
            ],
        }

    return {
        "schema_name": "DoclingDocument",
        "body": {
            "self_ref": "#/body",
            "children": [
                {"$ref": "#/texts/0"},
                {"$ref": "#/pictures/0"},
                {"$ref": "#/texts/1"},
                {"$ref": "#/texts/2"},
                {"$ref": "#/texts/3"},
            ],
        },
        "furniture": {"self_ref": "#/furniture", "children": []},
        "groups": [],
        "texts": [
            text(0, "Body paragraph outside the figure.", (60, 700, 500, 720)),
            # 図の中の軸ラベルと凡例
            text(1, "NS", (120, 420, 140, 432)),
            text(2, "24", (200, 420, 220, 432)),
            text(3, "Figure 1 | The caption below the figure.", (60, 360, 500, 380)),
        ],
        "pictures": [
            {
                "self_ref": "#/pictures/0",
                "label": "picture",
                "content_layer": "body",
                "parent": {"$ref": "#/body"},
                "children": [],
                "captions": [{"$ref": "#/texts/3"}],
                "footnotes": [],
                "prov": [
                    {
                        "page_no": 1,
                        "charspan": [0, 0],
                        "bbox": {"l": 80, "b": 400, "r": 520, "t": 660, "coord_origin": "BOTTOMLEFT"},
                    }
                ],
            }
        ],
        "tables": [],
        "pages": {"1": {"page_no": 1, "size": {"width": 600.0, "height": 800.0}}},
    }


def test_text_inside_a_figure_is_not_translated() -> None:
    """図中の文字の置き換えは対象外。訳さずに図へ畳む。"""
    out = normalize_document(_figure_raw(), HASH, VERSION, CONFIG, [_page()])
    by_id = {block["id"]: block for block in out["blocks"]}

    assert by_id["texts-1"]["translatable"] is False, "軸ラベルは訳さない"
    assert by_id["texts-2"]["translatable"] is False
    assert by_id["texts-0"]["translatable"] is True, "図の外の本文は訳す"
    assert by_id["texts-3"]["translatable"] is True, "キャプションは訳す"
    assert any("図や表の中の文字" in warning for warning in out["warnings"])


def test_figure_text_is_linked_to_its_figure() -> None:
    out = normalize_document(_figure_raw(), HASH, VERSION, CONFIG, [_page()])
    by_id = {block["id"]: block for block in out["blocks"]}
    assert "pictures-0" in by_id["texts-1"]["relatedIds"]
    assert "texts-1" in by_id["pictures-0"]["relatedIds"]


def _axis_labels_raw() -> dict:
    """図の枠が取れなかったページ。目盛りとパネル記号だけが素の文字として出てくる。

    実文書（Nature Aging 2024、26 ページ）の 6 ページ目がこの形だった。図の
    picture が立たないので「図へ畳む」が効かず、"a" や "4.5" が訳す対象に残る。
    """
    texts = ["a", "4.5", "3.0", "*", "+", "24", "Age (months)", "Shannon index"]
    return {
        "schema_name": "DoclingDocument",
        "body": {"children": [{"$ref": f"#/texts/{i}"} for i in range(len(texts))]},
        "furniture": {"children": []},
        "groups": [],
        "texts": [
            {
                "self_ref": f"#/texts/{i}",
                "label": "text",
                "text": text,
                "prov": [
                    {
                        "page_no": 1,
                        "charspan": [0, len(text)],
                        "bbox": {"l": 80, "b": 700 - i * 10, "r": 140,
                                 "t": 710 - i * 10, "coord_origin": "BOTTOMLEFT"},
                    }
                ],
            }
            for i, text in enumerate(texts)
        ],
        "pictures": [],
        "tables": [],
        "pages": {"1": {"page_no": 1, "size": {"width": 600.0, "height": 800.0}}},
    }


def test_axis_ticks_and_panel_letters_are_not_queued_for_translation() -> None:
    """訳すものが無い断片は訳す対象にしない。

    目盛り・パネル記号・記号だけのかたまりは、LLM を呼んでも意味が無く、
    訳文側の並びを埋めるだけになる。英字が 2 つ続かないものは訳さない。
    """
    out = normalize_document(_axis_labels_raw(), HASH, VERSION, CONFIG, [_page()])
    by_id = {block["id"]: block for block in out["blocks"]}

    for ref, text in ((0, "a"), (1, "4.5"), (2, "3.0"), (3, "*"), (4, "+"), (5, "24")):
        assert by_id[f"texts-{ref}"]["translatable"] is False, f"{text!r} に訳すものは無い"

    assert by_id["texts-6"]["translatable"] is True, "Age (months) は訳す"
    assert by_id["texts-7"]["translatable"] is True, "Shannon index は訳す"


def test_short_words_are_still_translated() -> None:
    """短いだけの本文を落とさない。"""
    raw = _axis_labels_raw()
    raw["texts"][0]["text"] = "Go"
    raw["texts"][1]["text"] = "No. 5"
    out = normalize_document(raw, HASH, VERSION, CONFIG, [_page()])
    by_id = {block["id"]: block for block in out["blocks"]}
    assert by_id["texts-0"]["translatable"] is True
    assert by_id["texts-1"]["translatable"] is True


def test_real_paper_keeps_body_text_translatable(fixtures_dir) -> None:
    """合成 fixture では図の中に文字が無いので、畳み込みは何もしない。"""
    raw = _load(fixtures_dir, "docling-two-column.json")
    out = normalize_document(raw, HASH, VERSION, CONFIG, [_page()])
    assert [b["source"][:11] for b in out["blocks"] if b["translatable"]][1] == "Left first."
    assert not any("図や表の中の文字" in warning for warning in out["warnings"])


# ---- manifest 照合 --------------------------------------------------------


def _geometry_from_manifest(entry: dict) -> list[dict]:
    return [
        {
            "number": page["number"],
            "width": page["width"],
            "height": page["height"],
            "rotation": page["rotation"],
            "hasText": page["status"] != "no-text",
        }
        for page in entry["pages"]
    ]


@pytest.mark.parametrize(
    "name",
    ["two-column.pdf", "general.pdf", "cropbox.pdf", "rotated.pdf", "image-only.pdf"],
)
def test_every_fixture_matches_the_manifest(fixtures_dir: Path, expected: dict, name: str) -> None:
    """manifest に記録した期待矩形を、実 Docling の出力が含んでいること。

    manifest は pypdfium2（抽出器とは別経路）と描画位置から作ってある。
    """
    entry = expected["fixtures"][name]
    tolerance = expected["boxTolerance"]
    raw = _load(fixtures_dir, "docling-%s.json" % name.replace(".pdf", ""))
    out = normalize_document(raw, HASH, VERSION, CONFIG, _geometry_from_manifest(entry))

    assert [page["status"] for page in out["pages"]] == [
        page["status"] for page in entry["pages"]
    ]

    for want in entry["blocks"]:
        matches = [
            block
            for block in out["blocks"]
            if block["source"].startswith(want["source"])
            and any(region["page"] == want["page"] for region in block["regions"])
        ]
        assert matches, f"{name}: 「{want['source']}」がページ {want['page']} にありません"
        region = next(r for r in matches[0]["regions"] if r["page"] == want["page"])
        got, exp = region["box"], want["box"]
        assert got[0] <= exp[0] + tolerance and got[1] <= exp[1] + tolerance, (name, want["source"], got, exp)
        assert got[2] >= exp[2] - tolerance and got[3] >= exp[3] - tolerance, (name, want["source"], got, exp)
