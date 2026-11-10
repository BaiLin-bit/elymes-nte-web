"""
BDF（点阵位图字体）→ TTF。

浏览器认 woff2 / woff / ttf / otf，不认 bdf。破晓像素给的是 bdf.gz，
所以这里把每个点阵像素拆成一个小矩形，拼成 glyf 轮廓，做成普通 TTF。

坐标口径：1 像素 = 100 字体单位，em = 1200 单位，正好等于 12px（FONT_ASCENT 9 + DESCENT 3）。
所以浏览器里 font-size 用 12px 的整数倍时，每个像素刚好对齐到整数像素格。
"""

import gzip
import json
import os
import re
import sys

from fontTools.fontBuilder import FontBuilder
from fontTools.pens.ttGlyphPen import TTGlyphPen

BDF_PATH = r"E:\XiaZai\poxiao-pixel--PoxiaoPixel-CN-12px.bdf.gz"

PX = 100          # 每个点阵像素占多少字体单位
UPEM = 1200       # 12px * 100
ASCENT = 900      # FONT_ASCENT 9 * 100
DESCENT = 300     # FONT_DESCENT 3 * 100


def parse_bdf(path):
    """返回 {codepoint: (bbx, dwidth, rows)}，rows 是十六进制位图行。"""
    out = {}
    enc = bbx = dwidth = rows = None
    in_bitmap = False
    with gzip.open(path, "rt", encoding="latin-1") as fh:
        for raw in fh:
            line = raw.rstrip("\n").rstrip("\r")
            key = line.split(" ", 1)[0]
            if key == "ENCODING":
                enc = int(line.split()[1])
            elif key == "DWIDTH":
                dwidth = int(line.split()[1])
            elif key == "BBX":
                bbx = tuple(int(v) for v in line.split()[1:5])
            elif key == "BITMAP":
                in_bitmap = True
                rows = []
            elif key == "ENDCHAR":
                in_bitmap = False
                if enc is not None and enc >= 0 and bbx and rows is not None:
                    out[enc] = (bbx, dwidth if dwidth is not None else bbx[0], rows)
                enc = bbx = dwidth = rows = None
            elif in_bitmap and line:
                rows.append(line.strip())
    return out


def row_bits(hexrow, width):
    """一行十六进制 → 每位一个 0/1，只取前 width 位。"""
    text = hexrow.strip()
    if not text:
        return [0] * width
    value = int(text, 16)
    total = len(text) * 4
    return [(value >> (total - 1 - i)) & 1 for i in range(width)]


def rects(rows, width, height):
    """Greedy 矩形分解：先把连续黑的横向像素连成一段，再向上向下吃掉同样的段。"""
    grid = []
    for r in range(height):
        bits = row_bits(rows[r], width) if r < len(rows) else []
        grid.append((bits + [0] * width)[:width])

    used = [[False] * width for _ in range(height)]
    out = []
    for y in range(height):
        x = 0
        while x < width:
            if grid[y][x] and not used[y][x]:
                x2 = x
                while x2 + 1 < width and grid[y][x2 + 1] and not used[y][x2 + 1]:
                    x2 += 1
                y2 = y
                while y2 + 1 < height:
                    if all(grid[y2 + 1][k] and not used[y2 + 1][k] for k in range(x, x2 + 1)):
                        y2 += 1
                    else:
                        break
                for yy in range(y, y2 + 1):
                    for xx in range(x, x2 + 1):
                        used[yy][xx] = True
                out.append((x, y, x2 - x + 1, y2 - y + 1))
                x = x2 + 1
            else:
                x += 1
    return out


def glyph_for(bbx, rows):
    width, height, xoff, yoff = bbx
    pen = TTGlyphPen(None)
    for (rx, ry, rw, rh) in rects(rows, width, height):
        x0 = (xoff + rx) * PX
        x1 = (xoff + rx + rw) * PX
        y_top = (yoff + height - ry) * PX
        y_bot = (yoff + height - ry - rh) * PX
        pen.moveTo((x0, y_bot))
        pen.lineTo((x0, y_top))
        pen.lineTo((x1, y_top))
        pen.lineTo((x1, y_bot))
        pen.closePath()
    return pen.glyph()


def gb2312_codepoints():
    points = set()
    for hi in range(0xA1, 0xF8):
        for lo in range(0xA1, 0xFF):
            try:
                text = bytes([hi, lo]).decode("gb2312")
            except Exception:
                continue
            points.add(ord(text))
    return points


def js_codepoints(path):
    """把皮肤脚本里用到的非 ASCII 字符（颜文字、菜单文案）也带上。"""
    if not os.path.exists(path):
        return set()
    with open(path, encoding="utf-8") as fh:
        text = fh.read()
    return {ord(ch) for ch in text if ord(ch) > 0x7F}


def build(fonts, out_path, wanted=None):
    encs = [enc for enc in sorted(fonts) if wanted is None or enc in wanted]
    if not encs:
        raise SystemExit("没有可用的字符")

    names = []
    glyphs = {}
    metrics = {}
    cmap = {}

    empty = TTGlyphPen(None).glyph()
    glyphs[".notdef"] = empty
    metrics[".notdef"] = (UPEM // 2, 0)
    names.append(".notdef")

    for enc in encs:
        bbx, dwidth, rows = fonts[enc]
        name = "u%04X" % enc
        glyphs[name] = glyph_for(bbx, rows)
        metrics[name] = (dwidth * PX, 0)
        cmap[enc] = name
        names.append(name)

    fb = FontBuilder(UPEM, isTTF=True)
    fb.setupGlyphOrder(names)
    fb.setupCharacterMap(cmap)
    fb.setupGlyf(glyphs)
    fb.setupHorizontalMetrics(metrics)
    fb.setupHorizontalHeader(ascent=ASCENT, descent=-DESCENT)
    fb.setupNameTable({
        "familyName": "Poxiao Pixel CN 12",
        "styleName": "Regular",
        "uniqueFontIdentifier": "PoxiaoPixel-CN-12-Regular",
        "fullName": "Poxiao Pixel CN 12px",
        "psName": "PoxiaoPixel-CN-12-Regular",
        "version": "Version 1.0",
        "copyright": "Poxiao Pixel · 破晓像素字体",
    })
    fb.setupOS2(
        sTypoAscender=ASCENT,
        sTypoDescender=-DESCENT,
        sTypoLineGap=0,
        usWinAscent=ASCENT,
        usWinDescent=DESCENT,
        sxHeight=600,
        sCapHeight=900,
        achVendID="POXI",
    )
    fb.setupPost()
    fb.save(out_path)
    return len(encs)


def main():
    argv = sys.argv[1:]
    limit = 0
    out_path = os.path.join(os.path.dirname(os.path.abspath(__file__)), "build", "poxiao.ttf")
    for i, a in enumerate(argv):
        if a == "--limit":
            limit = int(argv[i + 1])
        elif a == "--out":
            out_path = argv[i + 1]

    fonts = parse_bdf(BDF_PATH)
    print("bdf 字符数:", len(fonts))

    wanted = set(range(0x20, 0x7F)) | gb2312_codepoints()
    wanted |= js_codepoints(os.path.join(os.path.dirname(os.path.abspath(__file__)), "webui.source.js"))
    wanted &= set(fonts)
    print("目标字符数:", len(wanted))

    if limit:
        wanted = set(sorted(wanted)[:limit])
        print("限制到:", len(wanted))

    os.makedirs(os.path.dirname(out_path), exist_ok=True)
    count = build(fonts, out_path, wanted)
    size = os.path.getsize(out_path)
    print("写出 %d 个字形 → %s (%.2f MB)" % (count, out_path, size / 1048576))


if __name__ == "__main__":
    main()
