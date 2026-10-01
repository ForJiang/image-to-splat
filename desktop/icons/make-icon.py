#!/usr/bin/env python3
"""生成 Image2Splat 的 macOS 应用图标（icon.icns）。

纯标准库实现（zlib/struct/math），不依赖 PIL：把「等距立方体 + 泼溅圆点」的矢量图形
按目标尺寸重新光栅化，3x 超采样抗锯齿，然后用系统自带 iconutil 打成 .icns。
用法： python3 make-icon.py [输出目录]      （默认在脚本旁生成 icon.icns）
"""

import math
import os
import struct
import subprocess
import sys
import tempfile
import zlib

# ---- 配色（与站点设计系统一致：#0a0a0c 底、近白 #d8d8ff、绿 #3ddc97、紫 #7c6cff）----
BG_TOP = (0.090, 0.090, 0.110)     # #17171c
BG_BOT = (0.038, 0.038, 0.047)     # #0a0a0c
GLOW = (0.23, 0.18, 0.43)          # 右下紫色辉光
C_TOP = (0.847, 0.847, 1.0)        # 顶面近白
C_LEFT = (0.239, 0.863, 0.592)     # 左面绿
C_RIGHT = (0.486, 0.424, 1.0)      # 右面紫
LINE = (0.038, 0.038, 0.047)       # 棱线 = 底色（形成面间缝隙）
DOT = (1.0, 1.0, 1.0)
CORNER = 0.215                     # 圆角半径占边长比例

# ---- 等距立方体几何（1024 设计坐标系）----
CX, CY = 512.0, 545.0
W, D = 262.0, 282.0                # 半宽 / 侧面下垂量
T = (CX, CY - W)
R = (CX + W, CY - W + W * 0.5)
BO = (CX, CY - W + W)
L = (CX - W, CY - W + W * 0.5)
BL = (CX - W, CY - W + W * 0.5 + D)
BR = (CX + W, CY - W + W * 0.5 + D)
BB = (CX, CY - W + W + D)
TOP_FACE = [T, R, BO, L]
LEFT_FACE = [L, BO, BB, BL]
RIGHT_FACE = [R, BO, BB, BR]
FACES = [(TOP_FACE, C_TOP), (LEFT_FACE, C_LEFT), (RIGHT_FACE, C_RIGHT)]
STROKES = [(L, BO), (R, BO),                       # 两条共享棱
           (T, R), (R, BR), (BR, BB), (BB, BL), (BL, L), (L, T)]  # 外轮廓
DOTS = [(300, 762, 27, 0.50), (742, 238, 35, 0.34), (196, 316, 19, 0.42),
        (822, 604, 23, 0.30), (424, 158, 15, 0.36), (676, 812, 17, 0.30)]


def seg_dist(px, py, a, b):
    dx, dy = b[0] - a[0], b[1] - a[1]
    l2 = dx * dx + dy * dy
    t = 0.0 if l2 == 0 else max(0.0, min(1.0, ((px - a[0]) * dx + (py - a[1]) * dy) / l2))
    return math.hypot(px - (a[0] + t * dx), py - (a[1] + t * dy))


def in_poly(px, py, poly):
    inside = False
    n = len(poly)
    for i in range(n):
        x1, y1 = poly[i]
        x2, y2 = poly[(i + 1) % n]
        if (y1 > py) != (y2 > py):
            xin = (x2 - x1) * (py - y1) / (y2 - y1) + x1
            if px < xin:
                inside = not inside
    return inside


def rr_sdf(px, py, size, r):
    """圆角矩形（铺满 [0,size]^2，圆角半径 r）的有符号距离：内部为负。"""
    qx = max(abs(px - size / 2) - (size / 2 - r), 0.0)
    qy = max(abs(py - size / 2) - (size / 2 - r), 0.0)
    return math.hypot(qx, qy) - r


def render(size, sup=3):
    """把 1024 设计坐标的图形渲染成 size×size 的 RGBA 字节串（sup 倍超采样）。"""
    k = size / 1024.0
    lw = 7.2 * k                       # 棱线宽（设计坐标 7.2）
    corner_r = CORNER * size
    faces = [([(x * k, y * k) for x, y in poly], col) for poly, col in FACES]
    strokes = [((a[0] * k, a[1] * k), (b[0] * k, b[1] * k)) for a, b in STROKES]
    dots = [(x * k, y * k, r * k, a) for x, y, r, a in DOTS]

    px = bytearray(size * size * 4)
    n = sup * sup
    for y in range(size):
        for x in range(size):
            acc = [0.0, 0.0, 0.0]
            cov = 0
            for sy in range(sup):
                py = y + (sy + 0.5) / sup
                for sx in range(sup):
                    pxx = x + (sx + 0.5) / sup
                    if rr_sdf(pxx, py, size, corner_r) >= 0:
                        continue          # 圆角外 → 透明
                    cov += 1
                    # 背景：纵向渐变 + 右下紫色辉光
                    gy = py / size
                    col = [BG_TOP[i] + (BG_BOT[i] - BG_TOP[i]) * gy for i in range(3)]
                    gd = math.hypot(pxx / size - 0.80, py / size - 0.16) / 0.95
                    glow = max(0.0, 1.0 - gd) ** 2.2 * 0.55
                    col = [col[i] + GLOW[i] * glow for i in range(3)]
                    # 泼溅圆点
                    for dx, dy, dr, da in dots:
                        dd = 1.0 - math.hypot(pxx - dx, py - dy) / dr
                        if dd > 0:
                            soft = min(1.0, dd * 3.2) * da
                            col = [col[i] + DOT[i] * soft for i in range(3)]
                    # 立方体三个面
                    for poly, fc in faces:
                        if in_poly(pxx, py, poly):
                            col = list(fc)
                            break
                    # 棱线用底色压出缝隙与轮廓
                    if min(seg_dist(pxx, py, a, b) for a, b in strokes) < lw / 2:
                        col = list(LINE)
                    for i in range(3):
                        acc[i] += col[i]
            o = (y * size + x) * 4
            if cov:
                px[o] = min(255, round(acc[0] / cov * 255))
                px[o + 1] = min(255, round(acc[1] / cov * 255))
                px[o + 2] = min(255, round(acc[2] / cov * 255))
                px[o + 3] = round(cov / n * 255)
            # cov == 0：保持全 0（圆角外完全透明）
    return bytes(px)


def write_png(path, size, rgba):
    raw = b''.join(b'\x00' + rgba[y * size * 4:(y + 1) * size * 4] for y in range(size))

    def chunk(tag, data):
        return struct.pack('>I', len(data)) + tag + data + struct.pack('>I', zlib.crc32(tag + data) & 0xffffffff)

    hdr = struct.pack('>IIBBBBB', size, size, 8, 6, 0, 0, 0)
    with open(path, 'wb') as f:
        f.write(b'\x89PNG\r\n\x1a\n')
        f.write(chunk(b'IHDR', hdr))
        f.write(chunk(b'IDAT', zlib.compress(raw, 9)))
        f.write(chunk(b'IEND', b''))


def main():
    out_dir = sys.argv[1] if len(sys.argv) > 1 else os.path.dirname(os.path.abspath(__file__))
    with tempfile.TemporaryDirectory() as tmp:
        iconset = os.path.join(tmp, 'icon.iconset')
        os.makedirs(iconset)
        # (像素尺寸, 标注尺寸)：iconutil 要求的标准组合
        spec = [(16, 16), (32, 16), (32, 32), (64, 32), (128, 128), (256, 128), (256, 256), (512, 256), (512, 512), (1024, 512)]
        for px_size, out_size in spec:
            name = f'icon_{out_size}x{out_size}.png' if px_size == out_size else f'icon_{out_size}x{out_size}@2x.png'
            print(f'  rendering {name} ({px_size}px)')
            write_png(os.path.join(iconset, name), px_size, render(px_size, 3 if px_size >= 128 else 2))
        icns = os.path.join(out_dir, 'icon.icns')
        subprocess.run(['iconutil', '-c', 'icns', iconset, '-o', icns], check=True)
        print('written:', icns, os.path.getsize(icns), 'bytes')


if __name__ == '__main__':
    main()
