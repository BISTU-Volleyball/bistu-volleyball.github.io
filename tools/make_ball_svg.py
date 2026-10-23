# -*- coding: utf-8 -*-
# 生成网站底纹 assets/img/bg-pattern.svg 和装饰大排球 assets/img/ball-line.svg：python tools/make_ball_svg.py
# 排球线稿（同心圆弧，向外鼓）：第 k 组圆心 O_k 在球外，主缝线（半径 D）穿过球心，
# 另两条半径 D+w、D+2w；每组只保留落在相邻一组主缝线圆内的部分，三组像风车一样咬合、铺满球面
import math
import os


def ball(stroke='#1f5fd6', sw=4.4, r=46, cx=50, cy=50, D=1.25, w=0.30, phi0=-90, uid='b', n=3, nxt=1, inside=True):
    def pt(a, dist):
        a = math.radians(a)
        return cx + dist * math.cos(a), cy + dist * math.sin(a)
    Dp = D * r
    centers = [pt(phi0 + 120 * k, Dp) for k in range(3)]
    defs = [f'<clipPath id="{uid}c"><circle cx="{cx}" cy="{cy}" r="{r}"/></clipPath>']
    body = []
    for k in range(3):
        ox, oy = centers[k]
        nx, ny = centers[(k + nxt) % 3]
        bg, fg = ('#000', '#fff') if inside else ('#fff', '#000')
        defs.append(f'<mask id="{uid}m{k}" maskUnits="userSpaceOnUse" x="-50" y="-50" width="200" height="200">'
                    f'<rect x="-50" y="-50" width="200" height="200" fill="{bg}"/>'
                    f'<circle cx="{nx:.2f}" cy="{ny:.2f}" r="{Dp:.2f}" fill="{fg}"/></mask>')
        arcs = ''.join(f'<circle cx="{ox:.2f}" cy="{oy:.2f}" r="{Dp + i * w * r:.2f}"/>' for i in range(n))
        body.append(f'<g mask="url(#{uid}m{k})">{arcs}</g>')
    return (f'<defs>{"".join(defs)}</defs><g fill="none" stroke="{stroke}" stroke-width="{sw}">'
            f'<g clip-path="url(#{uid}c)">{"".join(body)}</g><circle cx="{cx}" cy="{cy}" r="{r}"/></g>')


DOTS = ('<circle cx="230" cy="60" r="2"/><circle cx="250" cy="60" r="2"/><circle cx="270" cy="60" r="2"/>'
        '<circle cx="230" cy="80" r="2"/><circle cx="250" cy="80" r="2"/><circle cx="270" cy="80" r="2"/>'
        '<circle cx="60" cy="330" r="2"/><circle cx="80" cy="330" r="2"/><circle cx="60" cy="350" r="2"/><circle cx="80" cy="350" r="2"/>')

if __name__ == '__main__':
    img = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), 'assets', 'img')
    b1 = ball(uid='a', sw=4.6)
    b2 = ball(uid='b', sw=5.4)
    pattern = '\n'.join([
        '<svg xmlns="http://www.w3.org/2000/svg" width="420" height="420" viewBox="0 0 420 420">',
        '  <!-- 全站淡底纹：排球线稿 + 点阵，透明度很低。由 tools/make_ball_svg.py 生成 -->',
        f'  <g opacity=".06"><g transform="translate(25 35) rotate(-18 45 45) scale(.9)">{b1}</g>'
        f'<g transform="translate(272 262) rotate(24 30 30) scale(.6)">{b2}</g></g>',
        f'  <g fill="#1f5fd6" opacity=".09">{DOTS}</g>',
        '  <path d="M150 210 h40 M170 190 v40" fill="none" stroke="#ef7e00" stroke-width="1.8" stroke-linecap="round" opacity=".11"/>',
        '</svg>', ''])
    with open(os.path.join(img, 'bg-pattern.svg'), 'w', encoding='utf-8', newline='\n') as f:
        f.write(pattern)
    line = '\n'.join([
        '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100">',
        '  <!-- 排球线稿（蓝色通栏装饰），由 tools/make_ball_svg.py 生成 -->',
        '  ' + ball(uid='w', sw=3.6, stroke='#ffffff'),
        '</svg>', ''])
    with open(os.path.join(img, 'ball-line.svg'), 'w', encoding='utf-8', newline='\n') as f:
        f.write(line)
    print('已生成 bg-pattern.svg、ball-line.svg')
