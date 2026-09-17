"""Docling の生出力を `pdf-document.v1` へ正規化する。

標準ライブラリだけで動く。Docling も torch も import しないので、抽出器を入れられない
環境でも試験できる。

座標について（実出力で確認した事実）:

* bbox は **CropBox の原点を引いた** 座標で来る。MediaBox ではない。
* bbox は **回転を適用した後** の表示空間で来る。`pages[].size` も回転後の寸法。
  一方 PDF.js の `page.view` は回転前なので、ここで回転前へ戻してから 0..1 にする。
* `coord_origin` は `BOTTOMLEFT`。中間形式は左上原点なので上下を入れ替える。
"""

from __future__ import annotations

import re
from typing import Any, Iterable

SCHEMA = "pdf-document.v1"

#: 本文として訳す種別。
TRANSLATABLE_KINDS = frozenset({"heading", "paragraph", "list", "caption", "footnote"})

#: 訳すものがあると見なす最小の手がかり。英字が 2 つ以上続くこと。
_HAS_WORD = re.compile(r"[A-Za-z]{2}")


def _has_something_to_translate(source: str) -> bool:
    """訳す中身があるか。

    図の目盛り（`4.5`）、パネル記号（`a`）、記号だけ（`*`, `+`）のかたまりは、
    図の枠が取れなかったページで本文に混ざって出てくる。LLM を呼んでも訳す
    ものが無く、訳文側の並びを埋めて読みにくくするだけなので、原文のまま置く。

    実文書 4 件（26 ページの二段組み論文、CC BY の二段組み論文、CC BY の一般
    論文、80 ページの公的文書）で確かめた範囲では、この条件で落ちるのは図の
    断片だけで、本文は 1 件も落ちなかった。
    """
    return bool(_HAS_WORD.search(source))

#: Docling のラベル → 中間形式の kind。
LABEL_TO_KIND = {
    "title": "heading",
    "section_header": "heading",
    "subtitle": "heading",
    "paragraph": "paragraph",
    "text": "paragraph",
    "list_item": "list",
    "caption": "caption",
    "footnote": "footnote",
    "picture": "picture",
    "chart": "picture",
    "table": "table",
    "document_index": "table",
    "formula": "formula",
    # コードは訳さず原文の切り抜きを見せる。数式と同じ扱いにする。
    "code": "formula",
    "reference": "reference",
    "page_header": "furniture",
    "page_footer": "furniture",
    "form": "furniture",
    "key_value_region": "furniture",
    "checkbox_selected": "furniture",
    "checkbox_unselected": "furniture",
}

#: 90 度単位の回転だけを扱う。
_ROTATIONS = (0, 90, 180, 270)

_SIZE_TOLERANCE = 1.0


class NormalizeError(Exception):
    """正規化できない入力。"""


def _resolve(raw: dict[str, Any], ref: str) -> dict[str, Any] | None:
    """`#/texts/3` のような参照を引く。"""
    if not isinstance(ref, str) or not ref.startswith("#/"):
        return None
    parts = ref[2:].split("/")
    node: Any = raw
    for part in parts:
        if isinstance(node, list):
            try:
                node = node[int(part)]
            except (ValueError, IndexError):
                return None
        elif isinstance(node, dict):
            if part not in node:
                return None
            node = node[part]
        else:
            return None
    return node if isinstance(node, dict) else None


def _child_refs(node: dict[str, Any]) -> Iterable[str]:
    """子・キャプション・脚注の参照を、読み順に一度ずつ返す。

    キャプションは `children` と `captions` の両方に現れる。ID で重ねて弾く。
    """
    for key in ("children", "captions", "footnotes"):
        for entry in node.get(key) or []:
            if isinstance(entry, dict) and isinstance(entry.get("$ref"), str):
                yield entry["$ref"]


def _block_id(ref: str) -> str:
    return ref.removeprefix("#/").replace("/", "-")


def _display_size(width: float, height: float, rotation: int) -> tuple[float, float]:
    """回転後の表示寸法。90/270 度で幅と高さが入れ替わる。"""
    return (height, width) if rotation in (90, 270) else (width, height)


def _to_unrotated(
    x: float, y: float, width: float, height: float, rotation: int
) -> tuple[float, float]:
    """回転後の表示座標を、回転前のページ座標（左下原点）へ戻す。

    `width`/`height` は回転前の寸法。前進変換は
    0: (x, y) / 90: (y, W-x) / 180: (W-x, H-y) / 270: (H-y, x)。
    """
    if rotation == 90:
        return width - y, x
    if rotation == 180:
        return width - x, height - y
    if rotation == 270:
        return y, height - x
    return x, y


def _normalize_box(
    bbox: dict[str, Any], width: float, height: float, rotation: int, origin: str
) -> list[float] | None:
    try:
        left = float(bbox["l"])
        right = float(bbox["r"])
        top = float(bbox["t"])
        bottom = float(bbox["b"])
    except (KeyError, TypeError, ValueError):
        return None

    if origin.upper() == "TOPLEFT":
        # 上下を入れ替えて左下原点に揃えてから回転を戻す。
        display_height = _display_size(width, height, rotation)[1]
        top, bottom = display_height - top, display_height - bottom

    corners = [
        _to_unrotated(left, top, width, height, rotation),
        _to_unrotated(right, top, width, height, rotation),
        _to_unrotated(left, bottom, width, height, rotation),
        _to_unrotated(right, bottom, width, height, rotation),
    ]
    xs = [point[0] for point in corners]
    ys = [point[1] for point in corners]

    # 左下原点 → 左上原点。
    box = [
        min(xs) / width,
        (height - max(ys)) / height,
        max(xs) / width,
        (height - min(ys)) / height,
    ]
    if any(value != value for value in box):  # NaN
        return None
    clamped = [min(1.0, max(0.0, value)) for value in box]
    if clamped[0] >= clamped[2] or clamped[1] >= clamped[3]:
        return None
    return [round(value, 6) for value in clamped]



def _inside(inner: list[float], outer: list[float], tolerance: float) -> bool:
    """`inner` が `outer` に収まっているか。境界は許容幅だけ甘く見る。"""
    return (
        inner[0] >= outer[0] - tolerance
        and inner[1] >= outer[1] - tolerance
        and inner[2] <= outer[2] + tolerance
        and inner[3] <= outer[3] + tolerance
    )


class _Normalizer:
    def __init__(
        self,
        raw: dict[str, Any],
        page_geometry: list[dict[str, Any]],
    ) -> None:
        self.raw = raw
        self.warnings: list[str] = []
        self.blocks: list[dict[str, Any]] = []
        self.seen: set[str] = set()
        self.heading_stack: list[tuple[int, str]] = []
        self.pages: dict[int, dict[str, Any]] = {}
        self.positions_ok: dict[int, bool] = {}
        self._build_pages(page_geometry)

    # ---- ページ ---------------------------------------------------------
    def _build_pages(self, page_geometry: list[dict[str, Any]]) -> None:
        if not page_geometry:
            raise NormalizeError("ページ情報がありません")

        raw_pages = self.raw.get("pages") or {}
        for entry in page_geometry:
            number = int(entry["number"])
            width = float(entry["width"])
            height = float(entry["height"])
            rotation = int(entry.get("rotation", 0) or 0)
            if rotation not in _ROTATIONS:
                self.warnings.append(
                    f"ページ {number} の回転 {rotation} 度は扱えないため 0 度として扱います"
                )
                rotation = 0

            status = entry.get("status")
            if status not in ("ok", "no-text", "failed"):
                status = "ok" if entry.get("hasText", True) else "no-text"
            if status == "no-text":
                self.warnings.append(f"ページ {number} からは文章を抽出できません")
            elif status == "failed":
                self.warnings.append(f"ページ {number} の抽出に失敗しました")

            self.pages[number] = {
                "number": number,
                "width": width,
                "height": height,
                "rotation": rotation,
                "status": status,
            }
            self.positions_ok[number] = self._check_size(number, width, height, rotation, raw_pages)

    def _check_size(
        self,
        number: int,
        width: float,
        height: float,
        rotation: int,
        raw_pages: Any,
    ) -> bool:
        """抽出側と PDF 側のページ寸法を突き合わせる。合わなければ位置同期を切る。"""
        entry = None
        if isinstance(raw_pages, dict):
            entry = raw_pages.get(str(number)) or raw_pages.get(number)
        elif isinstance(raw_pages, list):
            for candidate in raw_pages:
                if isinstance(candidate, dict) and candidate.get("page_no") == number:
                    entry = candidate
                    break
        if not isinstance(entry, dict):
            self.warnings.append(f"ページ {number} の抽出側の寸法が無いため位置同期を無効にします")
            return False

        size = entry.get("size") or {}
        try:
            actual = (float(size["width"]), float(size["height"]))
        except (KeyError, TypeError, ValueError):
            self.warnings.append(f"ページ {number} の抽出側の寸法を読めないため位置同期を無効にします")
            return False

        expected = _display_size(width, height, rotation)
        if (
            abs(actual[0] - expected[0]) > _SIZE_TOLERANCE
            or abs(actual[1] - expected[1]) > _SIZE_TOLERANCE
        ):
            self.warnings.append(
                f"ページ {number} の寸法が一致しません"
                f"（抽出 {actual[0]:.1f}x{actual[1]:.1f} / PDF {expected[0]:.1f}x{expected[1]:.1f}）。"
                "位置同期を無効にします"
            )
            return False
        return True

    # ---- 走査 -----------------------------------------------------------
    def walk(self, ref: str) -> None:
        if ref in self.seen:
            return
        node = _resolve(self.raw, ref)
        if node is None:
            self.warnings.append(f"参照 {ref} を解決できませんでした")
            self.seen.add(ref)
            return
        self.seen.add(ref)

        label = str(node.get("label") or "")
        is_container = ref in ("#/body", "#/furniture") or ref.startswith("#/groups/")
        if not is_container:
            self._emit(ref, node, label)

        for child in _child_refs(node):
            self.walk(child)

    def _emit(self, ref: str, node: dict[str, Any], label: str) -> None:
        content_layer = str(node.get("content_layer") or "body")
        kind = LABEL_TO_KIND.get(label, "paragraph")
        if content_layer == "furniture":
            kind = "furniture"

        source = str(node.get("text") or "").strip()
        if kind in ("picture", "table"):
            # 表のセル翻訳と図中の文字は初期版の対象外。原文の切り抜きを見せる。
            source = ""

        translatable = (
            kind in TRANSLATABLE_KINDS
            and source != ""
            and _has_something_to_translate(source)
        )

        heading_context = " > ".join(text for _, text in self.heading_stack)
        if kind == "heading" and source:
            level = node.get("level")
            level = int(level) if isinstance(level, int) else 1
            while self.heading_stack and self.heading_stack[-1][0] >= level:
                self.heading_stack.pop()
            self.heading_stack.append((level, source))

        block = {
            "id": _block_id(ref),
            "kind": kind,
            "order": len(self.blocks),
            "source": source,
            "headingContext": heading_context,
            "translatable": translatable,
            "regions": self._regions(ref, node, source),
            "relatedIds": [],
        }
        self.blocks.append(block)

    def _regions(self, ref: str, node: dict[str, Any], source: str) -> list[dict[str, Any]]:
        regions: list[dict[str, Any]] = []
        for prov in node.get("prov") or []:
            if not isinstance(prov, dict):
                continue
            try:
                page_no = int(prov.get("page_no"))
            except (TypeError, ValueError):
                continue
            page = self.pages.get(page_no)
            if page is None:
                self.warnings.append(f"{ref} が文書に無いページ {page_no} を指しています")
                continue
            if not self.positions_ok.get(page_no, False):
                continue

            bbox = prov.get("bbox")
            if not isinstance(bbox, dict):
                continue
            box = _normalize_box(
                bbox,
                page["width"],
                page["height"],
                page["rotation"],
                str(bbox.get("coord_origin") or "BOTTOMLEFT"),
            )
            if box is None:
                self.warnings.append(f"{ref} のページ {page_no} の座標を使えません")
                continue

            region: dict[str, Any] = {"page": page_no, "box": box}
            span = prov.get("charspan")
            if (
                source
                and isinstance(span, (list, tuple))
                and len(span) == 2
                and all(isinstance(value, int) for value in span)
            ):
                start = max(0, span[0])
                end = min(len(source), span[1])
                if end > start:
                    region["charRange"] = [start, end]
            regions.append(region)
        return regions

    # ---- 図の中の文字 ---------------------------------------------------
    def fold_into_figures(self) -> None:
        """図や表の枠の中に収まる文字を、その図の一部として扱う。

        実際の論文では、軸ラベルや凡例が 1〜3 文字の断片として何百個も出てくる
        （26 ページの論文で 3,700 ブロック中 2,000 以上）。図中の文字の置き換えは
        初期版の対象外なので、訳さずに図へ畳む。中身は図の切り抜きで読める。
        """
        containers = [
            block
            for block in self.blocks
            if block["kind"] in ("picture", "table") and block["regions"]
        ]
        if not containers:
            return

        folded = 0
        for block in self.blocks:
            if block["kind"] in ("picture", "table", "caption", "furniture"):
                continue
            if not block["translatable"] or not block["regions"]:
                continue

            parent = self._container_of(block, containers)
            if parent is None:
                continue
            block["translatable"] = False
            if parent["id"] not in block["relatedIds"]:
                block["relatedIds"].append(parent["id"])
            if block["id"] not in parent["relatedIds"]:
                parent["relatedIds"].append(block["id"])
            folded += 1

        if folded:
            self.warnings.append(
                f"図や表の中の文字 {folded} 件は訳しません（原文の切り抜きで見てください）"
            )

    @staticmethod
    def _container_of(
        block: dict[str, Any], containers: list[dict[str, Any]]
    ) -> dict[str, Any] | None:
        """すべての領域が同じ図の枠に収まっていれば、その図を返す。"""
        tolerance = 0.004
        for container in containers:
            pages = {region["page"]: region["box"] for region in container["regions"]}
            if all(
                region["page"] in pages
                and _inside(region["box"], pages[region["page"]], tolerance)
                for region in block["regions"]
            ):
                return container
        return None

    # ---- 関連付け -------------------------------------------------------
    def link_related(self) -> None:
        """図表とそのキャプション・脚注を相互に結ぶ。"""
        by_id = {block["id"]: block for block in self.blocks}
        for container_key in ("pictures", "tables"):
            for node in self.raw.get(container_key) or []:
                if not isinstance(node, dict):
                    continue
                parent_id = _block_id(str(node.get("self_ref") or ""))
                parent = by_id.get(parent_id)
                if parent is None:
                    continue
                for key in ("captions", "footnotes"):
                    for entry in node.get(key) or []:
                        if not isinstance(entry, dict):
                            continue
                        child_id = _block_id(str(entry.get("$ref") or ""))
                        child = by_id.get(child_id)
                        if child is None or child_id == parent_id:
                            continue
                        if child_id not in parent["relatedIds"]:
                            parent["relatedIds"].append(child_id)
                        if parent_id not in child["relatedIds"]:
                            child["relatedIds"].append(parent_id)


def normalize_document(
    raw: dict[str, Any],
    pdf_hash: str,
    extractor_version: str,
    config_hash: str,
    page_geometry: list[dict[str, Any]],
) -> dict[str, Any]:
    """Docling の生出力と PDF 側のページ情報から `pdf-document.v1` を作る。

    読み順は **body の階層** から取る。座標の縦位置で並べ替えない。二段組みでは
    右段の先頭が左段の続きより上に来るので、縦位置で並べると順序が壊れる。
    """
    if not isinstance(raw, dict):
        raise NormalizeError("抽出結果がオブジェクトではありません")

    normalizer = _Normalizer(raw, page_geometry)
    normalizer.walk("#/body")
    normalizer.walk("#/furniture")
    normalizer.link_related()
    normalizer.fold_into_figures()

    return {
        "schema": SCHEMA,
        "hash": pdf_hash,
        "extractor": {"version": extractor_version, "configHash": config_hash},
        "pages": [normalizer.pages[number] for number in sorted(normalizer.pages)],
        "blocks": normalizer.blocks,
        "warnings": normalizer.warnings,
    }
