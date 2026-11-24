#!/usr/bin/env python3
"""Capacitor Android APK 커스텀 아이콘 자동 주입 스크립트.

assets/app-icon.png (1024x1024 풀블리드 PNG)를 읽어:
  - mipmap-mdpi ~ xxxhdpi: ic_launcher.png, ic_launcher_round.png, ic_launcher_foreground.png
  - values/ic_launcher_background.xml: Adaptive Icon 배경색 (#21242d)
를 모두 일괄 교체한다.
"""
import os
import sys
from PIL import Image, ImageDraw

BG_RGB = (33, 36, 45)
BG_HEX = "#21242d"

LAUNCHER_SIZES = {
    "mipmap-mdpi": 48,
    "mipmap-hdpi": 72,
    "mipmap-xhdpi": 96,
    "mipmap-xxhdpi": 144,
    "mipmap-xxxhdpi": 192,
}

FOREGROUND_SIZES = {
    "mipmap-mdpi": 108,
    "mipmap-hdpi": 162,
    "mipmap-xhdpi": 216,
    "mipmap-xxhdpi": 324,
    "mipmap-xxxhdpi": 432,
}


def make_round(img_rgba):
    size = img_rgba.size[0]
    mask = Image.new("L", (size, size), 0)
    draw = ImageDraw.Draw(mask)
    draw.ellipse((0, 0, size - 1, size - 1), fill=255)
    out = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    out.paste(img_rgba, (0, 0), mask)
    return out


def make_adaptive_foreground(src_rgb, fg_size):
    canvas = Image.new("RGBA", (fg_size, fg_size), BG_RGB + (255,))
    inner_size = int(round(fg_size * 0.72))
    inner = src_rgb.resize((inner_size, inner_size), Image.LANCZOS).convert("RGBA")
    offset = (fg_size - inner_size) // 2
    canvas.paste(inner, (offset, offset), inner)
    return canvas


def main():
    icon_path = sys.argv[1] if len(sys.argv) > 1 else "assets/app-icon.png"
    res_dir = sys.argv[2] if len(sys.argv) > 2 else "android/app/src/main/res"

    if not os.path.isfile(icon_path):
        print(f"::error::아이콘 파일 없음: {icon_path}")
        sys.exit(1)

    src = Image.open(icon_path).convert("RGB")
    if src.size[0] != src.size[1]:
        side = min(src.size)
        left = (src.size[0] - side) // 2
        top = (src.size[1] - side) // 2
        src = src.crop((left, top, left + side, top + side))

    for folder, sz in LAUNCHER_SIZES.items():
        out_dir = os.path.join(res_dir, folder)
        os.makedirs(out_dir, exist_ok=True)
        sq = src.resize((sz, sz), Image.LANCZOS).convert("RGBA")
        sq.save(os.path.join(out_dir, "ic_launcher.png"), "PNG")
        make_round(sq).save(os.path.join(out_dir, "ic_launcher_round.png"), "PNG")

    for folder, fg_sz in FOREGROUND_SIZES.items():
        out_dir = os.path.join(res_dir, folder)
        os.makedirs(out_dir, exist_ok=True)
        fg = make_adaptive_foreground(src, fg_sz)
        fg.save(os.path.join(out_dir, "ic_launcher_foreground.png"), "PNG")

    values_dir = os.path.join(res_dir, "values")
    os.makedirs(values_dir, exist_ok=True)
    bg_xml_path = os.path.join(values_dir, "ic_launcher_background.xml")
    bg_xml = (
        '<?xml version="1.0" encoding="utf-8"?>
'
        '<resources>
'
        f'    <color name="ic_launcher_background">{BG_HEX}</color>
'
        '</resources>
'
    )
    with open(bg_xml_path, "w", encoding="utf-8") as fp:
        fp.write(bg_xml)

    print(f"✅ 커스텀 APK 아이콘 주입 완료: {icon_path} -> {res_dir} (bg={BG_HEX})")


if __name__ == "__main__":
    main()
