<#
.SYNOPSIS
    ショートカット用のアイコン media/pdf-ja.ico を作る。

.DESCRIPTION
    一度作れば済むもの。生成物はリポジトリに入れてあるので、普段は実行しなくてよい。
    見た目を変えたいときだけ走らせる。

    寸法ごとに描き、ICO の容器へ入れる。256 だけ PNG、それ以外は古典的な DIB で
    書く。Explorer は PNG も読めるが System.Drawing.Icon は読めないので、全部を
    PNG にすると「書けたが確かめられない」状態になる。DIB を混ぜておけば、
    最後に読み返して壊れていないことを確かめられる。

    16px では字が潰れるので、下辺の帯は 32px 以上でだけ描く。

.PARAMETER Path
    出力先。既定は media/pdf-ja.ico。
#>
[CmdletBinding()]
param(
    [string]$Path = ''
)

$ErrorActionPreference = 'Stop'
$repo = Split-Path -Parent $PSScriptRoot
if ($Path -eq '') { $Path = Join-Path $repo 'media/pdf-ja.ico' }

Add-Type -AssemblyName System.Drawing

# 日本語の字が要るので、無い環境でも落ちないよう候補を順に試す。
function Resolve-Family {
    foreach ($name in @('Yu Gothic UI', 'Yu Gothic', 'Meiryo', 'MS Gothic')) {
        try { return [System.Drawing.FontFamily]::new($name) } catch { continue }
    }
    return [System.Drawing.FontFamily]::GenericSansSerif
}

$family = Resolve-Family
Write-Host "==> 字体: $($family.Name)"

function New-IconBitmap([int]$size) {
    $bitmap = [System.Drawing.Bitmap]::new($size, $size, [System.Drawing.Imaging.PixelFormat]::Format32bppArgb)
    $graphics = [System.Drawing.Graphics]::FromImage($bitmap)
    try {
        $graphics.SmoothingMode = 'AntiAlias'
        $graphics.TextRenderingHint = 'AntiAliasGridFit'
        $graphics.InterpolationMode = 'HighQualityBicubic'

        # 角丸の下地。小さい寸法では丸みと余白を詰める。
        $pad = [Math]::Max(1, [int]($size * 0.06))
        $radius = [Math]::Max(2, [int]($size * 0.18))
        $box = [System.Drawing.Rectangle]::new($pad, $pad, $size - 2 * $pad, $size - 2 * $pad)

        $path = [System.Drawing.Drawing2D.GraphicsPath]::new()
        $d = $radius * 2
        $path.AddArc($box.Left, $box.Top, $d, $d, 180, 90)
        $path.AddArc($box.Right - $d, $box.Top, $d, $d, 270, 90)
        $path.AddArc($box.Right - $d, $box.Bottom - $d, $d, $d, 0, 90)
        $path.AddArc($box.Left, $box.Bottom - $d, $d, $d, 90, 90)
        $path.CloseFigure()

        $background = [System.Drawing.Drawing2D.LinearGradientBrush]::new(
            $box,
            [System.Drawing.Color]::FromArgb(255, 30, 41, 59),
            [System.Drawing.Color]::FromArgb(255, 15, 23, 42),
            90.0)
        $graphics.FillPath($background, $path)
        $background.Dispose()

        # 「訳」一字。寸法に対する比で置くので、どの大きさでも同じ見え方になる。
        $lift = if ($size -ge 32) { $size * 0.06 } else { 0.0 }
        $font = [System.Drawing.Font]::new($family, $size * 0.60, [System.Drawing.FontStyle]::Regular, 'Pixel')
        $format = [System.Drawing.StringFormat]::new()
        $format.Alignment = 'Center'
        $format.LineAlignment = 'Center'
        $white = [System.Drawing.SolidBrush]::new([System.Drawing.Color]::FromArgb(255, 248, 250, 252))
        $graphics.DrawString('訳', $font, $white,
            [System.Drawing.RectangleF]::new(0, -$lift, $size, $size), $format)
        $white.Dispose()
        $font.Dispose()
        $format.Dispose()

        # 下辺の帯。赤を一本だけ入れて、他の Node の窓と見分ける。
        if ($size -ge 32) {
            $barHeight = [Math]::Max(2, [int]($size * 0.08))
            $bar = [System.Drawing.Rectangle]::new(
                $box.Left + [int]($box.Width * 0.24),
                $box.Bottom - $barHeight - [int]($size * 0.11),
                [int]($box.Width * 0.52),
                $barHeight)
            $red = [System.Drawing.SolidBrush]::new([System.Drawing.Color]::FromArgb(255, 220, 38, 38))
            $graphics.FillRectangle($red, $bar)
            $red.Dispose()
        }

        $path.Dispose()
        return $bitmap
    }
    finally {
        $graphics.Dispose()
    }
}

function ConvertTo-Png([System.Drawing.Bitmap]$bitmap) {
    $stream = [System.IO.MemoryStream]::new()
    try {
        $bitmap.Save($stream, [System.Drawing.Imaging.ImageFormat]::Png)
        return $stream.ToArray()
    }
    finally { $stream.Dispose() }
}

<#
    ICO の中の DIB は BITMAPINFOHEADER + XOR 画素 + AND マスク。
    高さは 2 倍で書き（XOR と AND の二枚ぶん）、行は下から上へ並べる。
    32bit なので透過は画素の alpha で決まり、AND マスクは 0 で埋めてよい。
#>
function ConvertTo-Dib([System.Drawing.Bitmap]$bitmap) {
    $size = $bitmap.Width
    $rect = [System.Drawing.Rectangle]::new(0, 0, $size, $size)
    $data = $bitmap.LockBits($rect, [System.Drawing.Imaging.ImageLockMode]::ReadOnly,
        [System.Drawing.Imaging.PixelFormat]::Format32bppArgb)
    try {
        $rowBytes = $size * 4
        $pixels = [byte[]]::new($rowBytes * $size)
        for ($y = 0; $y -lt $size; $y++) {
            # 上から y 行目を、下から y 行目へ写す。
            $source = [IntPtr]::Add($data.Scan0, $data.Stride * ($size - 1 - $y))
            [System.Runtime.InteropServices.Marshal]::Copy($source, $pixels, $rowBytes * $y, $rowBytes)
        }
    }
    finally { $bitmap.UnlockBits($data) }

    $maskStride = [int][Math]::Floor(($size + 31) / 32) * 4
    $mask = [byte[]]::new($maskStride * $size)

    $stream = [System.IO.MemoryStream]::new()
    $writer = [System.IO.BinaryWriter]::new($stream)
    try {
        $writer.Write([uint32]40)                  # biSize
        $writer.Write([int32]$size)                # biWidth
        $writer.Write([int32]($size * 2))          # biHeight: XOR と AND の二枚ぶん
        $writer.Write([uint16]1)                   # biPlanes
        $writer.Write([uint16]32)                  # biBitCount
        $writer.Write([uint32]0)                   # biCompression: BI_RGB
        $writer.Write([uint32]($pixels.Length + $mask.Length))
        $writer.Write([int32]0); $writer.Write([int32]0)   # 解像度
        $writer.Write([uint32]0); $writer.Write([uint32]0) # 使用色数
        $writer.Write($pixels)
        $writer.Write($mask)
        $writer.Flush()
        return $stream.ToArray()
    }
    finally {
        $writer.Dispose()
        $stream.Dispose()
    }
}

$sizes = @(16, 24, 32, 48, 64, 128, 256)
$entries = @{}
foreach ($size in $sizes) {
    $bitmap = New-IconBitmap $size
    try {
        # 256 は DIB だと 1 件 256 KiB を超える。ここだけ PNG にする。
        $entries[$size] = if ($size -ge 256) { ConvertTo-Png $bitmap } else { ConvertTo-Dib $bitmap }
    }
    finally { $bitmap.Dispose() }
}

# ICO の容器を組む。ICONDIR 6 バイト + ICONDIRENTRY 16 バイト × 件数 + 各画像。
$output = [System.IO.MemoryStream]::new()
$writer = [System.IO.BinaryWriter]::new($output)
try {
    $writer.Write([uint16]0)              # 予約
    $writer.Write([uint16]1)              # 種別: アイコン
    $writer.Write([uint16]$sizes.Count)

    $offset = 6 + 16 * $sizes.Count
    foreach ($size in $sizes) {
        $bytes = $entries[$size]
        # 256 は 0 で表す（1 バイトに収まらないため）。
        $dimension = [byte]$(if ($size -ge 256) { 0 } else { $size })
        $writer.Write($dimension)
        $writer.Write($dimension)
        $writer.Write([byte]0)            # 色数: 32bit なので 0
        $writer.Write([byte]0)            # 予約
        $writer.Write([uint16]1)          # プレーン数
        $writer.Write([uint16]32)         # ビット深度
        $writer.Write([uint32]$bytes.Length)
        $writer.Write([uint32]$offset)
        $offset += $bytes.Length
    }
    # 明示的に byte[] へ。ハッシュテーブルから出た値をそのまま渡すと、PowerShell が
    # Write(byte[]) ではなく Write(bool) を選び、1 件 1 バイトで黙って書き潰す。
    foreach ($size in $sizes) { $writer.Write([byte[]]$entries[$size]) }
    $writer.Flush()

    $expected = 6 + 16 * $sizes.Count
    foreach ($size in $sizes) { $expected += $entries[$size].Length }
    if ($output.Length -ne $expected) {
        throw "ICO の大きさが合いません: $($output.Length) バイト（$expected のはず）"
    }

    $directory = Split-Path -Parent $Path
    if (-not (Test-Path $directory)) { New-Item -ItemType Directory -Path $directory | Out-Null }
    [System.IO.File]::WriteAllBytes($Path, $output.ToArray())
}
finally {
    $writer.Dispose()
    $output.Dispose()
}

# 書いたものを読み返す。壊れた ICO は無言で既定アイコンに化けるので、ここで確かめる。
$icon = [System.Drawing.Icon]::new($Path)
try {
    $largest = [System.Drawing.Icon]::new($icon, 128, 128)
    try {
        Write-Host "==> $Path"
        Write-Host "    $((Get-Item $Path).Length) バイト / $($sizes.Count) 寸法 / 読み返し $($largest.Width)x$($largest.Height)"
    }
    finally { $largest.Dispose() }
}
finally { $icon.Dispose() }
