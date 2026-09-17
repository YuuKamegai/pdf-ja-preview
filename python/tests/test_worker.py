"""ワーカーの入出力の試験。

Docling は import しない。変換層は差し替えて、契約（stdout に JSON 一つ）と
異常系だけを確かめる。実際の変換はコンテナで別に確認する。
"""

from __future__ import annotations

import json
import sys
from pathlib import Path

import pytest
from pypdf import PdfWriter

from pdf_ja import worker

HASH = "c" * 64


def _run(capsys, argv: list[str]) -> tuple[int, dict, str]:
    code = worker.main(argv)
    captured = capsys.readouterr()
    lines = [line for line in captured.out.splitlines() if line.strip()]
    assert len(lines) == 1, f"stdout に JSON が 1 行ではありません: {captured.out!r}"
    return code, json.loads(lines[0]), captured.err


@pytest.fixture
def fake_convert(monkeypatch):
    """`pdf_ja.convert` を差し替える。worker は遅延 import するので効く。"""

    def install(function):
        module = type(sys)("pdf_ja.convert")
        module.convert_to_raw = function
        monkeypatch.setitem(sys.modules, "pdf_ja.convert", module)

    return install


def _minimal_raw() -> dict:
    return {
        "schema_name": "DoclingDocument",
        "body": {"self_ref": "#/body", "children": [{"$ref": "#/texts/0"}]},
        "furniture": {"self_ref": "#/furniture", "children": []},
        "groups": [],
        "texts": [
            {
                "self_ref": "#/texts/0",
                "label": "text",
                "content_layer": "body",
                "parent": {"$ref": "#/body"},
                "text": "Hello.",
                "prov": [
                    {
                        "page_no": 1,
                        "charspan": [0, 6],
                        "bbox": {
                            "l": 60.0,
                            "t": 700.0,
                            "r": 200.0,
                            "b": 690.0,
                            "coord_origin": "BOTTOMLEFT",
                        },
                    }
                ],
            }
        ],
        "pictures": [],
        "tables": [],
        "pages": {"1": {"page_no": 1, "size": {"width": 600.0, "height": 800.0}}},
    }


def test_missing_input_is_reported(capsys, tmp_path: Path) -> None:
    code, payload, _ = _run(
        capsys, ["--input", str(tmp_path / "nope.pdf"), "--hash", HASH]
    )
    assert code == 1
    assert payload == {"ok": False, "error": {"code": "missing-input", "message": payload["error"]["message"]}}
    assert payload["error"]["code"] == "missing-input"


def test_invalid_hash_is_rejected(capsys, fixtures_dir: Path) -> None:
    code, payload, _ = _run(
        capsys, ["--input", str(fixtures_dir / "two-column.pdf"), "--hash", "short"]
    )
    assert code == 1
    assert payload["error"]["code"] == "invalid-hash"


def test_broken_pdf_is_rejected_before_converting(capsys, tmp_path: Path, fake_convert) -> None:
    def explode(path):  # pragma: no cover - 呼ばれてはいけない
        raise AssertionError("前検査で止まっていません")

    fake_convert(explode)
    broken = tmp_path / "broken.pdf"
    broken.write_bytes(b"%PDF-1.4 but not really")
    code, payload, _ = _run(capsys, ["--input", str(broken), "--hash", HASH])
    assert code == 1
    assert payload["error"]["code"] == "invalid-pdf"


def test_encrypted_pdf_is_rejected(capsys, tmp_path: Path, fixtures_dir: Path) -> None:
    writer = PdfWriter(clone_from=str(fixtures_dir / "two-column.pdf"))
    writer.encrypt("secret", algorithm="RC4-128")
    path = tmp_path / "encrypted.pdf"
    with path.open("wb") as handle:
        writer.write(handle)

    code, payload, _ = _run(capsys, ["--input", str(path), "--hash", HASH])
    assert code == 1
    assert payload["error"]["code"] == "encrypted-pdf"


def test_301_pages_is_rejected(capsys, tmp_path: Path) -> None:
    writer = PdfWriter()
    for _ in range(301):
        writer.add_blank_page(width=600, height=800)
    path = tmp_path / "big.pdf"
    with path.open("wb") as handle:
        writer.write(handle)

    code, payload, _ = _run(capsys, ["--input", str(path), "--hash", HASH])
    assert code == 1
    assert payload["error"]["code"] == "too-many-pages"


def test_success_emits_one_json_object(capsys, fixtures_dir: Path, fake_convert) -> None:
    fake_convert(lambda path: (_minimal_raw(), {}))
    code, payload, _ = _run(
        capsys, ["--input", str(fixtures_dir / "two-column.pdf"), "--hash", HASH]
    )
    assert code == 0
    assert payload["ok"] is True
    document = payload["document"]
    assert document["schema"] == "pdf-document.v1"
    assert document["hash"] == HASH
    assert [block["source"] for block in document["blocks"]] == ["Hello."]


def test_library_chatter_on_stdout_does_not_break_the_contract(
    capsys, fixtures_dir: Path, fake_convert
) -> None:
    """変換ライブラリが stdout へ書いても、stdout は JSON 一件のままにする。"""

    def noisy(path):
        print("Loading weights: 100%")
        print("not json at all")
        return _minimal_raw(), {}

    fake_convert(noisy)
    code, payload, err = _run(
        capsys, ["--input", str(fixtures_dir / "two-column.pdf"), "--hash", HASH]
    )
    assert code == 0
    assert payload["ok"] is True
    assert "Loading weights" in err


def test_page_level_failure_is_kept_as_a_partial_result(
    capsys, fixtures_dir: Path, fake_convert
) -> None:
    fake_convert(lambda path: (_minimal_raw(), {1: "failed"}))
    code, payload, _ = _run(
        capsys, ["--input", str(fixtures_dir / "two-column.pdf"), "--hash", HASH]
    )
    assert code == 0
    document = payload["document"]
    assert document["pages"][0]["status"] == "failed"
    assert any("抽出に失敗" in warning for warning in document["warnings"])


def test_conversion_error_is_reported_as_extraction_failed(
    capsys, fixtures_dir: Path, fake_convert
) -> None:
    def broken(path):
        raise RuntimeError("model blew up")

    fake_convert(broken)
    code, payload, err = _run(
        capsys, ["--input", str(fixtures_dir / "two-column.pdf"), "--hash", HASH]
    )
    assert code == 1
    assert payload["error"]["code"] == "extraction-failed"
    assert "model blew up" in payload["error"]["message"]
    assert "Traceback" in err


def test_normalize_error_is_reported_separately(
    capsys, fixtures_dir: Path, fake_convert
) -> None:
    fake_convert(lambda path: ("not a document", {}))
    code, payload, _ = _run(
        capsys, ["--input", str(fixtures_dir / "two-column.pdf"), "--hash", HASH]
    )
    assert code == 1
    assert payload["error"]["code"] == "normalize-failed"


def test_config_hash_changes_with_the_extractor_version(monkeypatch) -> None:
    first = worker.config_hash("/models")
    monkeypatch.setattr(worker, "EXTRACTOR_VERSION", "docling-2")
    assert worker.config_hash("/models") != first


def test_config_hash_ignores_where_the_models_live() -> None:
    """モデルの置き場所は結果を変えない。入れると環境ごとにキャッシュが割れる。"""
    assert worker.config_hash("/models") == worker.config_hash("/other/models")
