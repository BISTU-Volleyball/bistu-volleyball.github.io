# -*- coding: utf-8 -*-
"""转载公众号 / 学校新闻网文章，生成发布助手格式的待审核稿。

由 GitHub Actions 处理 _import/*.json 请求时调用（见 .github/workflows/import.yml），也可以本地运行：
    python tools/import_article.py <链接> [栏目 news|matches|gallery] [投稿人]
    python tools/import_article.py --queue [提交说明输出文件]
输出：_pending/<日期>-<6位编号>.md 和 assets/posts/<同名>/p1.jpg …

规则（与人工整理时的取舍一致）：
- 图片：去掉 SVG/动图、过小的图、细长的页眉和分隔线、透明背景的插画、色彩很少的图形（色块、二维码等）
- 文字：去掉公众号排版用语（关注我们、END、左右滑动、版权声明、口号等）和正文前的标题装饰；
  正文中较短的独立行作小标题，很短的（如“授课现场”）视为图注去掉；
  署名只保留文字/图片/供稿/供图/图文/视频，文末加来源与“阅读原文”链接；原文有视频时注明见原文
- 排版：按原文顺序图文穿插，连续的照片 2~3 张一行，宽幅照片单独一行
"""
import datetime, html, io, json, os, re, secrets, ssl, sys, urllib.request

from PIL import Image

UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36'
ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
TZ = datetime.timezone(datetime.timedelta(hours=8))

BOILER = re.compile(r'^(点击蓝字|关注我们|END|左右滑动|查看更多|版权声明|以人为本|激发运动兴趣|长按|扫码|识别二维码|往期回顾|推荐阅读|- 分享 -|分享|[✦•·\-—_~～\s]+$)')
CREDIT = re.compile(r'^(文字|图片|图文|供稿|供图|视频|摄影|撰稿|文|图|图片、视频|图文、视频|视频、图片|今日编辑|责任编辑|编辑|责编|排版|审核|校对|美编|初审|复审|终审|来源)\s*[|｜:：]\s*(.+)$')
KEEP_CREDIT = {'文字', '图片', '图文', '供稿', '供图', '视频', '摄影', '撰稿', '文', '图', '图片、视频', '图文、视频', '视频、图片'}
SECTIONS = {'news', 'matches', 'gallery'}


def get(url, referer=None):
    headers = {'User-Agent': UA}
    if referer:
        headers['Referer'] = referer
    ctx = None
    if 'bistu.edu.cn' in url:  # 学校网站证书链不完整，单独放宽校验
        ctx = ssl.create_default_context()
        ctx.check_hostname = False
        ctx.verify_mode = ssl.CERT_NONE
    for attempt in range(4):  # 网络偶尔中断，重试几次
        try:
            return urllib.request.urlopen(urllib.request.Request(url, headers=headers), timeout=60, context=ctx).read()
        except Exception:
            if attempt == 3:
                raise


def sequence(content, img_re, base=''):
    """把正文 HTML 拆成按顺序排列的 {'t': 文字} / {'img': 链接}"""
    out = []
    for part in re.split(r'(<img[^>]*>)', content):
        if part.startswith('<img'):
            m = re.search(img_re, part)
            if m:
                out.append({'img': base + html.unescape(m.group(1))})
            continue
        text = re.sub(r'<(br|/p|/section|/h\d|/div|/li|/blockquote)[^>]*>', '\n', part)
        text = re.sub(r'<style[\s\S]*?</style>', '', text)
        text = html.unescape(re.sub(r'<[^>]+>', '', text))
        for line in text.split('\n'):
            line = re.sub(r'\s+', ' ', line.replace('\xa0', ' ')).strip()
            if line:
                out.append({'t': line})
    return out


def parse(url):
    page = get(url).decode('utf-8', 'replace')
    meta = {'url': url}
    if 'mp.weixin.qq.com' in url:
        m = re.search(r"msg_title = '([^']*)'", page) or re.search(r'<meta property="og:title" content="([^"]*)"', page)
        if not m or 'id="js_content"' not in page:
            raise RuntimeError('读不到文章内容（链接可能已失效、被删除，或需要在微信里验证）')
        meta['title'] = re.sub(r'\s+', ' ', html.unescape(m.group(1))).strip()
        m = re.search(r'var nickname = htmlDecode\("([^"]*)"\)', page)
        meta['source'] = (html.unescape(m.group(1)) if m else '微信公众号') + '微信公众号'
        m = re.search(r'var ct = "(\d+)"', page)
        meta['date'] = datetime.datetime.fromtimestamp(int(m.group(1)), TZ).strftime('%Y-%m-%d') if m else datetime.datetime.now(TZ).strftime('%Y-%m-%d')
        i = page.find('id="js_content"')
        content = page[page.find('>', i) + 1:page.find('<script', i)]
        meta['has_video'] = bool(re.search(r'mpvideo|video_iframe|js_tx_video|channels_iframe|mp-common-videosnap|wxv_', content))
        seq = sequence(content, r'(?:data-src|src)="(https?://mmbiz[^"]+)"')
        for e in seq:
            if 'img' in e:
                e['img'] = re.sub(r'/\d+\?', '/0?', e['img'].split('#')[0])  # 取原图
    elif 'bistu.edu.cn' in url:
        i = page.find('class="pageArticle"')
        if i < 0:
            raise RuntimeError('没认出这个页面的正文（目前支持公众号文章和学校新闻网）')
        art = page[i:]
        m = re.search(r'<h\d[^>]*>([\s\S]*?)</h\d>', art)
        meta['title'] = html.unescape(re.sub(r'<[^>]+>', '', m.group(1))).strip() if m else ''
        m = re.search(r'class="date">\s*(\d{4}-\d{2}-\d{2})', art)
        meta['date'] = m.group(1) if m else datetime.datetime.now(TZ).strftime('%Y-%m-%d')
        meta['source'] = '北京信息科技大学新闻网'
        body = art[art.find('</div>', art.find('class="date"')) + 6:]
        end = re.search(r'- 分享 -|class="share|bdsharebuttonbox', body)
        body = body[:end.start()] if end else body
        meta['has_video'] = '<video' in body
        base = url.split('/')[0] + '//' + url.split('/')[2] + '/'
        seq = sequence(body, r'src="(?:\.\./)+([^"]+\.(?:jpe?g|png|webp))"', base)
    else:
        raise RuntimeError('目前只支持微信公众号文章（mp.weixin.qq.com）和学校新闻网（bistu.edu.cn）')
    return meta, seq


def is_photo(im):
    """是不是值得放进网站的照片（排除装饰图）"""
    w, h = im.size
    if getattr(im, 'is_animated', False) or w < 300 or h < 200:
        return False
    r = w / h
    if r > 3.2 or r < 0.3:
        return False
    if im.mode in ('RGBA', 'LA') or (im.mode == 'P' and 'transparency' in im.info):
        a = im.convert('RGBA').getchannel('A').resize((64, 64))
        if sum(1 for v in a.getdata() if v < 250) > 64 * 64 * 0.03:
            return False
    small = im.convert('RGB').resize((64, 64))
    if len(set(small.getdata())) < 1200:
        return False
    return True


def cut_summary(text, limit=84):
    """摘要在标点处收尾，不要断在半句"""
    t = re.sub(r'【(图|视频)\d+】', '', text).strip()
    if len(t) <= limit:
        return t
    head = t[:limit]
    for ch in '。！？；':
        i = head.rfind(ch)
        if i >= limit * 0.5:
            return head[:i + 1]
    i = max(head.rfind('，'), head.rfind('、'))
    return (head[:i] if i >= limit * 0.5 else head) + '…'


def rows_of(n, ratios):
    """连续 n 张照片怎么分行：宽幅单独一行，其余 2~3 张一行"""
    rows, run = [], []
    def flush():
        k = len(run)
        while k:
            take = 2 if k == 4 else min(3, k)
            rows.append(run[:take]); del run[:take]; k = len(run)
    for i in range(n):
        if ratios[i] > 1.9:  # 宽幅合影等（比 16:9 更宽），单独一行
            flush(); rows.append([i])
        else:
            run.append(i)
    flush()
    return rows


def credit_line(seq_texts):
    keep = []
    for t in seq_texts:
        m = CREDIT.match(t)
        if m and m.group(1) in KEEP_CREDIT:
            who = re.sub(r'\s+', ' ', m.group(2)).strip()
            who = re.sub(r'(?<=[一-鿿]) (?=[一-鿿](?:$|[ ；;、，,]))', '', who)  # “王   鑫”→“王鑫”
            keep.append(f'{m.group(1)}：{who}')
    return '　'.join(keep)


def build(url, section='news', requester=''):
    meta, seq = parse(url)
    date = meta['date']
    slug = f'{date}-{secrets.token_hex(3)}'
    adir = os.path.join(ROOT, 'assets', 'posts', slug)

    # 下载并筛选图片
    kept = []  # (seq 序号, Image)
    first_text = next((i for i, e in enumerate(seq) if 't' in e and len(e['t']) >= 40), len(seq))
    for idx, e in enumerate(seq):
        if 'img' not in e:
            continue
        try:
            data = get(e['img'], url)
        except Exception as ex:
            raise RuntimeError(f'图片下载失败，请稍后重试（{ex}）')
        try:
            im = Image.open(io.BytesIO(data))
            im.load()
        except Exception:
            continue  # SVG 等打不开的图，都是装饰
        if idx < first_text and im.width / im.height >= 2 and im.width < 1000:
            continue  # 正文开始前的小横幅（公众号页眉、栏目头图）；宽幅合影通常更大，保留
        if is_photo(im):
            kept.append((idx, im))
    os.makedirs(adir, exist_ok=True)
    images, ratios, num_at = [], [], {}
    for k, (idx, im) in enumerate(kept, 1):
        im = im.convert('RGB')
        s = min(1, 1600 / max(im.size))
        im = im.resize((round(im.width * s), round(im.height * s)), Image.LANCZOS)
        im.save(os.path.join(adir, f'p{k}.jpg'), quality=85, optimize=True)
        images.append(f'/assets/posts/{slug}/p{k}.jpg')
        ratios.append(round(im.width / im.height, 3))
        num_at[idx] = k - 1

    # 文字：找到正文起点（第一段较长的文字），之前的短行是标题装饰
    texts = [e['t'] for e in seq if 't' in e]
    first_long = next((i for i, e in enumerate(seq) if 't' in e and len(e['t']) >= 40), 0)
    credits = credit_line(texts)
    blocks, pending = [], []  # pending：连续照片的序号

    def flush_imgs():
        if pending:
            for row in rows_of(len(pending), [ratios[j] for j in pending]):
                blocks.append(''.join(f'【图{pending[j] + 1}】' for j in row))
            pending.clear()

    ended = False
    for idx, e in enumerate(seq):
        if 'img' in e:
            if idx in num_at and not ended:
                pending.append(num_at[idx])
            continue
        t = e['t']
        if idx < first_long or ended:
            continue
        if t == 'END' or CREDIT.match(t) or t.startswith('版权声明'):
            ended = True
            continue
        if BOILER.match(t):
            continue
        # 段末括号里的署名（学校新闻网常见）
        m = re.search(r'[（(]((?:供稿|图片|文字|摄影|编辑|审核)[：:][^）)]*)[）)]\s*$', t)
        if m:
            t = t[:m.start()].rstrip()
            if not credits:
                parts = re.findall(r'(供稿|图片|文字|摄影)[：:]\s*(.+?)(?=\s*(?:供稿|图片|文字|摄影|编辑|审核)[：:]|$)', m.group(1))
                credits = '　'.join(f'{a}：{b.strip()}' for a, b in parts)
        flush_imgs()
        if len(t) < 6:
            continue  # 很短的独立行多是图注，如“授课现场”
        if len(t) <= 20 and not re.search(r'[。！？；，,.!?;]$', t):
            blocks.append('### ' + t)
        else:
            blocks.append(t)
    flush_imgs()
    if meta.get('has_video'):
        blocks.append('（原文含视频，请点下方“阅读原文”观看）')
    if credits:
        blocks.append(credits)
    blocks.append(f'来源：{meta["source"]}，[阅读原文]({url})')

    landscape = [i for i, r in enumerate(ratios) if 1.2 <= r <= 2.2]
    cover = images[landscape[0]] if landscape else (images[0] if images else '')
    summary = cut_summary(' '.join(b for b in blocks if not b.startswith(('###', '【'))))
    data = {'layout': 'post', 'title': meta['title'], 'date': f'{date} 12:00:00 +0800', 'section': section if section in SECTIONS else 'news',
            'author': meta['source'].replace('微信公众号', ''), 'summary': summary, 'cover': cover, 'images': images, 'ratios': ratios,
            'submitted': datetime.datetime.now(datetime.timezone.utc).strftime('%Y-%m-%dT%H:%M:%SZ'), 'submitted_by': requester, 'source_url': url}
    data = {k: v for k, v in data.items() if v not in ('', [], None)}
    fm = '\n'.join(f'{k}: {json.dumps(v, ensure_ascii=False)}' for k, v in data.items())
    body = '\n\n'.join(b.replace('{% endraw %}', '') for b in blocks)
    path = os.path.join(ROOT, '_pending', slug + '.md')
    with io.open(path, 'w', encoding='utf-8', newline='\n') as f:
        f.write(f'---\n{fm}\n---\n{{% raw %}}\n{body}\n{{% endraw %}}\n')
    return slug, meta['title'], len(images)


def process_queue():
    """处理 _import/*.json：成功则删除请求文件，失败改名为 *.err.json 并写入原因。返回提交说明"""
    qdir = os.path.join(ROOT, '_import')
    done = []
    for name in sorted(os.listdir(qdir)) if os.path.isdir(qdir) else []:
        if not name.endswith('.json') or name.endswith('.err.json'):
            continue
        path = os.path.join(qdir, name)
        req = json.load(io.open(path, encoding='utf-8'))
        try:
            slug, title, n = build(req['url'], req.get('section', 'news'), req.get('by', ''))
            os.remove(path)
            done.append(f'{title}（{n} 张照片）')
            print('OK', slug, title, n)
        except Exception as e:
            req['error'] = str(e)[:300]
            with io.open(path[:-5] + '.err.json', 'w', encoding='utf-8', newline='\n') as f:
                f.write(json.dumps(req, ensure_ascii=False, indent=1) + '\n')
            os.remove(path)
            done.append(f'失败 {req["url"]}')
            print('FAIL', req['url'], e)
    return '；'.join(done)


if __name__ == '__main__':
    a = sys.argv[1:]
    if a and a[0] == '--queue':
        msg = process_queue()
        if len(a) > 1:
            io.open(a[1], 'w', encoding='utf-8').write(msg)
    else:
        print(build(a[0], a[1] if len(a) > 1 else 'news', a[2] if len(a) > 2 else ''))
