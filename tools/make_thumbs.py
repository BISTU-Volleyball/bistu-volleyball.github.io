# -*- coding: utf-8 -*-
"""给网站图片生成缩略图：assets/posts/** 和 assets/img/*.jpg → assets/thumbs/<同样路径>（宽 ≤720、高 ≤1080 的 JPEG）

卡片封面、照片墙、首页列表都用缩略图（_includes/thumb-src.html），文章页里点开仍是原图。
已有的缩略图不重做；原图被删了，对应缩略图也删掉。GitHub Actions（.github/workflows/thumbs.yml）在每次有新图片时自动运行。
用法：python tools/make_thumbs.py
"""
import io
import os
import sys

from PIL import Image, ImageOps

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
THUMBS = os.path.join(ROOT, 'assets', 'thumbs')
MAX_W, MAX_H, QUALITY = 720, 1080, 80
EXTS = ('.jpg', '.jpeg', '.png', '.webp')


def sources():
    for base in ('assets/posts', 'assets/img'):
        for dirpath, _, names in os.walk(os.path.join(ROOT, base)):
            for n in names:
                low = n.lower()
                # 风采相册的原图（*-orig.*）只在点开时用，不做缩略图；assets/img 里只做照片（logo 等 png 不需要）
                if not low.endswith(EXTS) or '-orig.' in low or (base == 'assets/img' and not low.endswith(('.jpg', '.jpeg'))):
                    continue
                yield os.path.relpath(os.path.join(dirpath, n), os.path.join(ROOT, 'assets'))


def make(rel):
    src, dst = os.path.join(ROOT, 'assets', rel), os.path.join(THUMBS, rel)
    os.makedirs(os.path.dirname(dst), exist_ok=True)
    im = ImageOps.exif_transpose(Image.open(src))
    if im.mode in ('RGBA', 'LA', 'P'):
        bg = Image.new('RGB', im.size, 'white')
        im = im.convert('RGBA')
        bg.paste(im, mask=im.split()[-1])
        im = bg
    im = im.convert('RGB')
    im.thumbnail((MAX_W, MAX_H), Image.LANCZOS)
    buf = io.BytesIO()
    im.save(buf, 'JPEG', quality=QUALITY, optimize=True, progressive=True)
    # 原图本来就很小时，直接用原图内容（缩略图反而更大就没意义）
    data = buf.getvalue() if buf.tell() < os.path.getsize(src) else open(src, 'rb').read()
    with open(dst, 'wb') as f:
        f.write(data)


def main():
    want = set(sources())
    made = 0
    for rel in sorted(want):
        if not os.path.exists(os.path.join(THUMBS, rel)):
            try:
                make(rel)
                made += 1
            except Exception as e:  # 坏图跳过，网页会退回原图
                print('跳过', rel, e, file=sys.stderr)
    gone = 0
    for dirpath, _, names in os.walk(THUMBS, topdown=False):
        for n in names:
            rel = os.path.relpath(os.path.join(dirpath, n), THUMBS)
            if rel not in want:
                os.remove(os.path.join(dirpath, n))
                gone += 1
        if dirpath != THUMBS and not os.listdir(dirpath):
            os.rmdir(dirpath)
    print(f'新做 {made} 张，删除 {gone} 张，共 {len(want)} 张')


if __name__ == '__main__':
    main()
