#!/usr/bin/env python3
"""Generate simple branded PNG icons without external deps."""
import struct
import zlib
from pathlib import Path

OUT = Path(__file__).resolve().parent.parent / 'public'


def png_chunk(tag: bytes, data: bytes) -> bytes:
    crc = zlib.crc32(tag + data) & 0xFFFFFFFF
    return struct.pack('>I', len(data)) + tag + data + struct.pack('>I', crc)


def write_png(path: Path, size: int) -> None:
    pixels = bytearray()
    cx = cy = size / 2
    r_outer = size * 0.36
    r_mic = size * 0.07

    for y in range(size):
        row = bytearray([0])  # filter byte
        for x in range(size):
            dx = x + 0.5 - cx
            dy = y + 0.5 - cy
            dist = (dx * dx + dy * dy) ** 0.5

            # Emerald wave bars
            bar_color = None
            base_y = size * 0.82
            bar_w = size * 0.06
            gap = size * 0.04
            heights = [0.08, 0.14, 0.2, 0.14, 0.08]
            total_w = len(heights) * bar_w + (len(heights) - 1) * gap
            x0 = cx - total_w / 2
            for i, h in enumerate(heights):
                bx = x0 + i * (bar_w + gap)
                bh = size * h
                if bx <= x + 0.5 <= bx + bar_w and base_y - bh <= y + 0.5 <= base_y:
                    bar_color = (16, 185, 129)

            if bar_color:
                row.extend((*bar_color, 255))
                continue

            # White circle
            if dist <= r_outer:
                # Mic body (black cutout)
                mic_top = cy - size * 0.22
                mic_bottom = cy + size * 0.08
                mic_left = cx - size * 0.07
                mic_right = cx + size * 0.07
                if mic_left <= x + 0.5 <= mic_right and mic_top <= y + 0.5 <= mic_bottom:
                    row.extend((0, 0, 0, 255))
                    continue
                # Mic stem
                stem_w = size * 0.035
                if cx - stem_w <= x + 0.5 <= cx + stem_w and mic_bottom <= y + 0.5 <= cy + size * 0.14:
                    row.extend((0, 0, 0, 255))
                    continue
                row.extend((255, 255, 255, 255))
                continue

            row.extend((0, 0, 0, 255))

        pixels.extend(row)

    compressed = zlib.compress(bytes(pixels), 9)
    ihdr = struct.pack('>IIBBBBB', size, size, 8, 6, 0, 0, 0)
    png = b'\x89PNG\r\n\x1a\n'
    png += png_chunk(b'IHDR', ihdr)
    png += png_chunk(b'IDAT', compressed)
    png += png_chunk(b'IEND', b'')
    path.write_bytes(png)


def main() -> None:
    OUT.mkdir(parents=True, exist_ok=True)
    for size, name in [(32, 'favicon-32.png'), (192, 'icon-192.png'), (512, 'icon-512.png')]:
        write_png(OUT / name, size)
        print(f'wrote {OUT / name}')


if __name__ == '__main__':
    main()