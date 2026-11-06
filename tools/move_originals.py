# -*- coding: utf-8 -*-
"""把主站里的原图（assets/posts/**/*-orig.*）搬到原图仓库，并把文章里的原图地址改过去

主站网站有 1GB 上限，原图最占地方，所以单独放在 BISTU-Volleyball/originals（网址 /originals/…，同一个域名）。
由 .github/workflows/originals.yml 自动运行：python tools/move_originals.py <主站目录> <原图仓库目录>
- assets/posts/<文章>/pN-orig.jpg  →  原图仓库 <文章>/pN-orig.jpg，主站里删掉
- 文章（_posts、_pending）里的 /assets/posts/<文章>/pN-orig.jpg  →  /originals/<文章>/pN-orig.jpg
  （管理员审核时页面里还是旧地址也没关系：发布后这一步会再改一次）
可以重复运行，没有要搬的就什么都不做。
"""
import os
import re
import shutil
import sys

site, orig = sys.argv[1], sys.argv[2]
posts_dir = os.path.join(site, 'assets', 'posts')

moved = 0
for dirpath, _, names in os.walk(posts_dir):
    for n in names:
        if '-orig.' not in n.lower():
            continue
        src = os.path.join(dirpath, n)
        rel = os.path.relpath(src, posts_dir).replace(os.sep, '/')
        dst = os.path.join(orig, rel)
        os.makedirs(os.path.dirname(dst), exist_ok=True)
        shutil.copy2(src, dst)
        os.remove(src)
        moved += 1

REF = re.compile(r'/assets/posts/([^"\s,\]]+-orig\.[A-Za-z0-9]+)')
fixed = 0
for d in ('_posts', '_pending'):
    for n in sorted(os.listdir(os.path.join(site, d))) if os.path.isdir(os.path.join(site, d)) else []:
        if not n.endswith('.md'):
            continue
        p = os.path.join(site, d, n)
        s = open(p, encoding='utf-8').read()
        # 原图已经在原图仓库里（刚搬的或以前搬的）才改地址
        t = REF.sub(lambda m: '/originals/' + m.group(1) if os.path.exists(os.path.join(orig, m.group(1))) else m.group(0), s)
        if t != s:
            open(p, 'w', encoding='utf-8', newline='\n').write(t)
            fixed += 1
print(f'搬了 {moved} 张原图，改了 {fixed} 篇文章的原图地址')
