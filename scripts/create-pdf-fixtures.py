"""合成 fixture PDF を生成する。

実行には fixture 専用の環境を使う（本番の抽出ワーカーとは依存を分ける）:

    py -3.13 -m venv .venv-pdf-fixtures
    ./.venv-pdf-fixtures/Scripts/python.exe -m pip install -r python/requirements-fixtures.in
    ./.venv-pdf-fixtures/Scripts/python.exe scripts/create-pdf-fixtures.py

出力は `test/fixtures/pdf/`。期待するブロック・座標・順序は本スクリプトではなく
`test/fixtures/pdf/manifest.json` に人が確認した値として別に記録する。
ここは「紙を作る」だけで、「何が正しいか」は決めない。
"""

from __future__ import annotations

import io
import sys
from pathlib import Path

from pypdf import PdfReader, PdfWriter
from reportlab.lib.colors import HexColor, black
from reportlab.pdfgen import canvas

ROOT = Path(__file__).resolve().parents[1]
OUT = ROOT / "test" / "fixtures" / "pdf"

BODY_FONT = "Helvetica"
HEAD_FONT = "Helvetica-Bold"


def _paragraph(c: canvas.Canvas, x: float, top: float, width: float, lines: list[str],
               size: float = 11, leading: float = 14) -> float:
    """左上 (x, top) から下向きに行を描く。戻り値は次に使える top。"""
    c.setFont(BODY_FONT, size)
    y = top
    for line in lines:
        c.drawString(x, y - size, line)
        y -= leading
    return y


def _figure_image(width: int = 440, height: int = 280):
    """図として埋め込むラスター画像。ベクタの矩形だけでは図として検出されない。"""
    from reportlab.lib.utils import ImageReader
    from PIL import Image, ImageDraw

    image = Image.new("RGB", (width, height), (247, 249, 252))
    draw = ImageDraw.Draw(image)
    draw.rectangle((0, 0, width - 1, height - 1), outline=(120, 130, 150))
    for index, value in enumerate((60, 140, 100, 210, 170)):
        x = 40 + index * 76
        draw.rectangle((x, height - 40 - value, x + 48, height - 40), fill=(90, 120, 190))
    draw.line((30, height - 40, width - 30, height - 40), fill=(40, 40, 40), width=2)
    buffer = io.BytesIO()
    image.save(buffer, format="PNG")
    buffer.seek(0)
    return ImageReader(buffer)


def two_column(path: Path) -> None:
    """二段組み。読み順は 左段 → 右段 で、上下位置だけでは決まらないようにする。

    右段の先頭は左段の 2 つ目より **上** にあるので、縦位置で並べると順序が壊れる。
    段組みが検出できる程度に、各段落は複数行の実文にしてある。
    """
    c = canvas.Canvas(str(path), pagesize=(600, 800))

    # 5 文字を大きく中央に置くとレイアウト検出が「図」と誤判定する。論文らしく、
    # 段をまたいで左揃えの長い表題にする。
    c.setFont(HEAD_FONT, 17)
    c.drawString(60, 742, "Title: Recovery of Metabolite Signals After Cold Storage")

    left_x, right_x, column = 60, 320, 220

    _paragraph(c, left_x, 700, column, [
        "Left first. The instrument was calibrated",
        "before each of the 12 runs, and the drift",
        "was kept below 0.5 percent over 30 min.",
        "Every sample was measured three times",
        "and the median value was retained.",
    ])
    _paragraph(c, left_x, 560, column, [
        "Left second. Cooling was applied at a",
        "fixed rate of 2 C per minute until the",
        "target of 25 C was reached. The holding",
        "time was 10 min for all conditions.",
    ])

    _paragraph(c, right_x, 700, column, [
        "Right first. Two independent operators",
        "repeated the protocol on separate days.",
        "Agreement between operators was 98.2",
        "percent, and no systematic offset was",
        "detected in the paired comparison.",
    ])

    c.drawImage(_figure_image(), right_x, 420, width=column, height=140)
    _paragraph(c, right_x, 410, column, [
        "Figure caption. Recovery by condition,",
        "shown as the median of three runs.",
    ], size=9, leading=11)

    # ページ下端の飾り（本文ではない）
    c.setFont(BODY_FONT, 8)
    c.setFillColor(HexColor("#666666"))
    c.drawCentredString(300, 40, "Preprint - page 1")
    c.setFillColor(black)

    c.showPage()
    c.save()


def general(path: Path) -> None:
    """一段組みの一般文書。2 ページにまたがる段落を含む。"""
    c = canvas.Canvas(str(path), pagesize=(612, 792))

    c.setFont(HEAD_FONT, 22)
    c.drawString(72, 716, "Quarterly Notes")

    body = [
        "The device was calibrated at 25 degrees Celsius before every run.",
        "Each measurement was repeated three times and averaged.",
        "Results are reported with a tolerance of 0.5 percent.",
        "The operator recorded the ambient humidity for each session.",
    ]
    _paragraph(c, 72, 676, 468, body)

    # 見出しは本文と見分けがつく大きさにする。1-2 pt の差では本文と区別されない。
    c.setFont(HEAD_FONT, 16)
    c.drawString(72, 588, "Method")
    _paragraph(c, 72, 558, 468, [
        "Samples were held at 25 C for 10 min and then cooled.",
        "The cooling rate was fixed at 2 C per minute.",
        "Each condition was repeated on two separate days.",
    ])

    c.showPage()

    c.setFont(HEAD_FONT, 16)
    c.drawString(72, 716, "Discussion")
    _paragraph(c, 72, 686, 468, [
        "The second page continues the discussion of the method.",
        "No further calibration was required.",
        "The observed spread is consistent with the stated tolerance.",
    ])
    c.showPage()
    c.save()


def formula(path: Path) -> None:
    """数式を含む一段組み。数式は訳さず原文のまま残るべきもの。

    数式は本文と行を分け、記号を単独行に置く。本文に混ぜると、抽出器は
    ただの文として扱い、数式として立たない。
    """
    c = canvas.Canvas(str(path), pagesize=(612, 792))

    c.setFont(HEAD_FONT, 20)
    c.drawString(72, 716, "Diffusion of the Tracer")

    _paragraph(c, 72, 676, 468, [
        "The tracer spreads according to the diffusion equation below.",
        "The coefficient D was measured for each temperature.",
    ])

    # 数式。イタリック体で中央寄せにし、前後を空ける。
    c.setFont("Times-Italic", 15)
    c.drawCentredString(306, 596, "dC/dt = D * d2C/dx2 + k * C")
    c.setFont("Times-Italic", 15)
    c.drawCentredString(306, 560, "D = D0 * exp(-Ea / (R * T))")

    _paragraph(c, 72, 520, 468, [
        "Here C is the concentration and t is time in seconds.",
        "The activation energy Ea was 42.5 kJ per mole in every run.",
    ])
    c.showPage()
    c.save()


def page_spanning(path: Path) -> None:
    """段落が改ページをまたぐ一段組み。

    1 ページ目の本文を最後の行まで詰め、文を途中で切って 2 ページ目の先頭へ続ける。
    抽出器が 2 ページ分を 1 ブロックとしてまとめるかどうかを見るための紙。
    まとめない場合もそれが事実なので、期待値は抽出結果から作らず別に記録する。
    """
    c = canvas.Canvas(str(path), pagesize=(612, 792))

    c.setFont(HEAD_FONT, 20)
    c.drawString(72, 716, "Continuous Record")

    # 1 ページ目の下端まで本文で埋める。最後の行は文の途中で終える。
    lines = [
        "The instrument logged a reading every thirty seconds for the whole",
        "campaign, and the operator confirmed that the pump stayed within its",
        "rated range on each of the fourteen days that the campaign lasted.",
        "No interruption was recorded in the primary channel, although the",
        "secondary channel was offline for two hours on the seventh day while",
        "the filter was replaced, and the gap was later filled by interpolating",
        "between the two neighbouring readings, which differed by less than",
        "0.3 percent, so the correction changed none of the reported totals and",
        "the campaign was therefore treated as a single uninterrupted record",
        "for the purposes of the analysis that follows in the next section of",
        "this report, where the daily means are compared against the reference",
        "values that the laboratory published before the campaign began and",
    ]
    _paragraph(c, 72, 676, 468, lines)
    c.showPage()

    # 2 ページ目は見出し無しで、前ページの文の続きから始める。
    _paragraph(c, 72, 716, 468, [
        "that were themselves derived from an earlier campaign carried out at",
        "the same site under comparable conditions three years previously.",
    ])
    _paragraph(c, 72, 640, 468, [
        "The comparison is summarised in the following paragraph.",
    ])
    c.showPage()
    c.save()


def image_only(path: Path) -> None:
    """文字が一切ない、図だけのページ。`no-text` になる想定。"""
    from reportlab.lib.utils import ImageReader
    from PIL import Image, ImageDraw

    image = Image.new("RGB", (400, 300), "white")
    draw = ImageDraw.Draw(image)
    draw.ellipse((40, 40, 360, 260), fill=(90, 120, 190))
    draw.rectangle((120, 110, 280, 190), fill=(240, 240, 240))
    buffer = io.BytesIO()
    image.save(buffer, format="PNG")
    buffer.seek(0)

    c = canvas.Canvas(str(path), pagesize=(600, 800))
    c.drawImage(ImageReader(buffer), 100, 300, width=400, height=300)
    c.showPage()
    c.save()


def _crop_source(path: Path) -> None:
    c = canvas.Canvas(str(path), pagesize=(620, 840))
    c.setFont(HEAD_FONT, 18)
    c.drawString(70, 760, "Cropped Page")
    _paragraph(c, 70, 730, 480, [
        "This page has a CropBox whose origin is not zero.",
        "Coordinates must be taken from the crop box, not the media box.",
    ])
    c.showPage()
    c.save()


def crop_box(path: Path) -> None:
    """MediaBox 0 0 620 840、CropBox 10 20 610 820。表示領域の原点が 0 でない。"""
    source = path.with_suffix(".src.pdf")
    _crop_source(source)
    reader = PdfReader(str(source))
    writer = PdfWriter()
    page = reader.pages[0]
    page.cropbox.lower_left = (10, 20)
    page.cropbox.upper_right = (610, 820)
    writer.add_page(page)
    with path.open("wb") as handle:
        writer.write(handle)
    source.unlink()


def rotated(path: Path) -> None:
    """同じ内容を 0/90/180/270 度で持つ 4 ページ。"""
    source = path.with_suffix(".src.pdf")
    c = canvas.Canvas(str(source), pagesize=(600, 800))
    for index in range(4):
        c.setFont(HEAD_FONT, 16)
        c.drawString(60, 720, f"Rotation page {index}")
        _paragraph(c, 60, 690, 480, [f"Body text of page {index}."])
        c.showPage()
    c.save()

    reader = PdfReader(str(source))
    writer = PdfWriter()
    for index, page in enumerate(reader.pages):
        if index:
            page.rotate(90 * index)
        writer.add_page(page)
    with path.open("wb") as handle:
        writer.write(handle)
    source.unlink()


def render_previews(target: Path) -> None:
    """目視確認用に各ページを PNG へ描く。リポジトリには入れない。"""
    import pypdfium2

    target.mkdir(parents=True, exist_ok=True)
    for pdf in sorted(OUT.glob("*.pdf")):
        document = pypdfium2.PdfDocument(str(pdf))
        for index in range(len(document)):
            bitmap = document[index].render(scale=1.5)
            bitmap.to_pil().save(target / f"{pdf.stem}-p{index + 1}.png")
        document.close()


def main() -> int:
    OUT.mkdir(parents=True, exist_ok=True)
    two_column(OUT / "two-column.pdf")
    general(OUT / "general.pdf")
    formula(OUT / "formula.pdf")
    page_spanning(OUT / "page-spanning.pdf")
    image_only(OUT / "image-only.pdf")
    crop_box(OUT / "cropbox.pdf")
    rotated(OUT / "rotated.pdf")

    if len(sys.argv) > 1:
        render_previews(Path(sys.argv[1]))
        print(f"previews -> {sys.argv[1]}")

    for pdf in sorted(OUT.glob("*.pdf")):
        reader = PdfReader(str(pdf))
        print(f"{pdf.name}: {len(reader.pages)} page(s)")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
