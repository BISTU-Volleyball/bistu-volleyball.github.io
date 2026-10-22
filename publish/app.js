// 发布助手：投稿 → 待审核（_pending/）→ 管理员通过后移到 _posts/ 上线
// 钥匙 = GitHub 细粒度令牌，只存在本浏览器。只带 Contents 权限的是发布人钥匙；
// 额外带 Pages 写权限的是管理员钥匙（能审核、管理已发布内容、重新构建网站）
// 子模块带上与 app.js 相同的版本号，网站更新后不会用到浏览器里缓存的旧版本
const VER = new URL(import.meta.url).search;
const { ghClient, commitFiles, speedTest, shrinkImage } = await import('./gh.js' + VER);

const root = document.getElementById('pub');
const REPO = root.dataset.repo;
const BASE = root.dataset.base; // 网站根路径，一般是 "/"
const SECTIONS = JSON.parse(root.dataset.sections);
const LEARN = JSON.parse(root.dataset.learn || '{}'); // 排球课堂的分类、难度（_config.yml 的 learn）
const MAX_FILE_MB = 20;
const learnSelects = (cls, p = {}) => `<label>分类<select class="${cls}Topic">${(LEARN.topics || []).map(t => `<option${t === p.topic ? ' selected' : ''}>${t}</option>`).join('')}</select></label>`
  + `<label>难度<select class="${cls}Level">${(LEARN.levels || []).map(t => `<option${t === p.level ? ' selected' : ''}>${t}</option>`).join('')}</select></label>`;
const fmtSize = n => n >= 1048576 ? (n / 1048576).toFixed(1) + ' MB' : Math.max(1, Math.round(n / 1024)) + ' KB';
const attachList = list => (list || []).length ? `<div class="pv-files">${list.map(a => `<a href="${url(a.src)}" target="_blank">📄 ${esc(a.name)} <span>${fmtSize(a.size || 0)}</span></a>`).join('')}</div>` : '';
const LS = 'bv_pub';
const MAX_VIDEO_MB = 50;
const COVER_POS = [['15%', '偏上'], ['50%', '居中'], ['85%', '偏下']]; // 首页卡片封面的截取位置
const MARK = { photos: '图', videos: '视频' }; // 正文里插图标记：【图1】【视频1】

let me = JSON.parse(localStorage.getItem(LS) || 'null'); // { key, name }
let isAdmin = false;
let roleCheck = 0; // 管理员检测的 HTTP 状态码，显示在「设置」里便于排查
let tab = 'compose';
let busy = false;
const draft = { photos: [], videos: [], files: [] }; // 待提交的 File

// 邀请链接 #k=钥匙&n=名字：存下后立刻从地址栏抹掉
{
  const h = new URLSearchParams(location.hash.slice(1));
  if (h.get('k')) {
    me = { key: h.get('k').trim(), name: (h.get('n') || '').trim() };
    localStorage.setItem(LS, JSON.stringify(me));
    history.replaceState(null, '', location.pathname);
  }
}

const cfg = () => ({ repo: REPO, token: me.key, branch: 'main' });
const gh = (path, opts) => ghClient(cfg())(path, opts);
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const url = p => p ? BASE + String(p).replace(/^\//, '') : '';
const today = () => new Date(Date.now() + 8 * 3600e3).toISOString().slice(0, 10);
const secName = k => (SECTIONS.find(s => s.key === k) || {}).name || k;
const $ = sel => root.querySelector(sel);

function toast(msg, bad) {
  const t = document.createElement('div');
  t.className = 'toast' + (bad ? ' bad' : '');
  t.textContent = msg;
  document.body.appendChild(t);
  setTimeout(() => t.remove(), bad ? 6000 : 3000);
}

function explain(e) {
  if (e.status === 401) return '钥匙无效或已过期，请联系管理员换一把新钥匙';
  if (e.status === 403 || e.status === 404) return '钥匙没有这个网站的权限（可能还没被组织批准），请联系管理员';
  return e.message;
}

// ---------- 文章文件格式 ----------
// front matter 每行一个 key: JSON 值（JSON 也是合法 YAML）；正文每段一行，包在 raw 里防止 Liquid 误解析
const FM_KEYS = ['layout', 'title', 'date', 'section', 'author', 'summary', 'cover', 'cover_pos', 'images', 'ratios', 'videos', 'attachments', 'topic', 'level', 'submitted', 'submitted_by', 'source_url', 'approved_by'];

function buildPost(p) {
  const paras = p.text.split('\n').map(s => s.trim().replace(/\{%\s*endraw\s*%\}/g, '')).filter(Boolean);
  const data = { ...p, layout: 'post', date: `${p.date} 12:00:00 +0800`, summary: paras.join(' ').replace(/【(图|视频)\d+】/g, '').trim().slice(0, 80) };
  const fm = FM_KEYS.filter(k => data[k] !== undefined && data[k] !== '' && !(Array.isArray(data[k]) && !data[k].length))
    .map(k => `${k}: ${JSON.stringify(data[k])}`);
  return `---\n${fm.join('\n')}\n---\n{% raw %}\n${paras.join('\n\n')}\n{% endraw %}\n`;
}

function parsePost(src) {
  const m = src.replace(/\r/g, '').match(/^---\n([\s\S]*?)\n---\n?([\s\S]*)$/);
  if (!m) return { title: '（格式无法识别）', text: src, date: '', images: [], videos: [] };
  const p = {};
  for (const line of m[1].split('\n')) {
    const i = line.indexOf(':');
    if (i < 0) continue;
    const v = line.slice(i + 1).trim();
    try { p[line.slice(0, i).trim()] = JSON.parse(v); } catch { p[line.slice(0, i).trim()] = v.replace(/^['"]|['"]$/g, ''); }
  }
  const body = m[2].replace(/\{%\s*(end)?raw\s*%\}/g, '').trim();
  return { ...p, date: String(p.date || '').slice(0, 10), images: p.images || [], videos: p.videos || [], text: body.split(/\n\s*\n/).map(s => s.trim()).join('\n') };
}

const b64text = b64 => new TextDecoder().decode(Uint8Array.from(atob(b64.replace(/\s/g, '')), c => c.charCodeAt(0)));

async function listDir(dir) {
  try { return (await gh(`/contents/${dir}?ref=main`)).filter(f => f.type === 'file'); }
  catch (e) { if (e.status === 404) return []; throw e; }
}

async function loadPost(f) {
  const d = await gh(`/contents/${f.path}?ref=main`);
  return { ...parsePost(b64text(d.content)), path: f.path, slug: f.name.replace(/\.md$/, '') };
}

const loadPosts = async dir => (await Promise.all((await listDir(dir)).filter(f => f.name.endsWith('.md')).map(loadPost)))
  .sort((a, b) => (b.date + b.slug).localeCompare(a.date + a.slug));

// 与 _config.yml 的 permalink: /posts/:year/:month:day-:title/ 对应
const postUrl = p => url(`posts/${p.date.slice(0, 4)}/${p.date.slice(5, 7)}${p.date.slice(8, 10)}-${p.slug.slice(11)}/`);

// ---------- 页面框架 ----------
function render() {
  if (!me) return renderSetup();
  const tabs = [['compose', '✍️ 投稿'], ['pending', isAdmin ? '🗂️ 审核' : '⏳ 待审核'], ...(isAdmin ? [['published', '📰 已发布'], ['home', '🏠 首页'], ['about', '🏛️ 关于协会']] : []), ['settings', '⚙️ 设置']];
  root.innerHTML = `
    <div class="pub-head"><h1>发布助手</h1><span class="who">${esc(me.name || '未署名')}${isAdmin ? ' · <b>管理员</b>' : ''}</span></div>
    <div class="tabs">${tabs.map(([k, n]) => `<button data-tab="${k}" class="${tab === k ? 'on' : ''}">${n}</button>`).join('')}</div>
    <div id="view"></div>`;
  root.querySelectorAll('[data-tab]').forEach(b => b.onclick = () => {
    if (busy) return toast('正在提交，请稍候', true);
    tab = b.dataset.tab; render();
  });
  ({ compose: renderCompose, pending: renderPending, published: renderPublished, home: renderHome, about: renderAbout, settings: renderSettings })[tab]();
}

function renderSetup(err, name = me?.name || '') {
  root.innerHTML = `
    <div class="panel">
      <h1>发布助手</h1>
      <p>第一次使用，请填写署名和管理员发给你的<b>发布钥匙</b>（以 <code>github_pat_</code> 开头的一长串字符）。
      钥匙只保存在这个浏览器里；如果管理员直接发给你的是一个链接，点开链接就会自动设置好。</p>
      ${err ? `<p class="err">${esc(err)}</p>` : ''}
      <label>署名（会显示在文章上）<input id="sName" value="${esc(name)}" placeholder="例如：张老师"></label>
      <label>发布钥匙<input id="sKey" placeholder="github_pat_..." autocomplete="off"></label>
      <button class="primary" id="sSave">保存并进入</button>
    </div>`;
  $('#sSave').onclick = async () => {
    const name = $('#sName').value.trim(), key = $('#sKey').value.trim();
    if (!name || !key) return toast('署名和钥匙都要填', true);
    me = { name, key };
    if (await verify()) { localStorage.setItem(LS, JSON.stringify(me)); render(); }
  };
}

// 检查钥匙能否访问仓库，并判断是不是管理员钥匙
async function verify() {
  try { await gh(''); }
  catch (e) { const name = me.name; me = null; renderSetup(explain(e), name); return false; }
  // 读取类接口不能用来判断：细粒度钥匙对公开仓库自带只读权限，发布人钥匙也能读到 Pages 信息。
  // 修改 Pages 设置的接口又额外要求 Administration 权限，也不行。
  // 所以发一个缺少必填参数的「Pages 部署」请求（只要求 Pages 写权限）：
  // 有权限 → GitHub 回 422（参数不全，什么都不会发生）；没有 → 403
  try { await gh('/pages/deployments', { method: 'POST', body: '{}' }); roleCheck = 200; }
  catch (e) { roleCheck = e.status || 0; }
  isAdmin = roleCheck === 422;
  return true;
}

// ---------- 投稿 ----------
let composeMode = 'write';
function renderCompose() {
  $('#view').innerHTML = `
    <div class="modes"><button data-mode="write" class="${composeMode === 'write' ? 'on' : ''}">✍️ 自己写</button><button data-mode="import" class="${composeMode === 'import' ? 'on' : ''}">🔗 转载公众号文章</button></div>
    <div id="cbody"></div>`;
  root.querySelectorAll('[data-mode]').forEach(b => b.onclick = () => { if (!busy) { composeMode = b.dataset.mode; renderCompose(); } });
  (composeMode === 'import' ? renderImport : renderWrite)();
}

// 转载：提交一个请求文件 _import/<编号>.json，GitHub Actions 抓取后生成待审核稿（tools/import_article.py）
const IMPORT_OK = /^https:\/\/(mp\.weixin\.qq\.com\/s|news\.bistu\.edu\.cn\/)/;
function renderImport() {
  const v = $('#cbody');
  v.innerHTML = `
    <div class="panel">
      <label>文章链接<input id="iUrl" placeholder="https://mp.weixin.qq.com/s/..."></label>
      <p class="hint">支持微信公众号文章和学校新闻网（news.bistu.edu.cn）。在微信里打开文章 → 右上角「…」→「复制链接」。</p>
      <label>栏目<select id="iSec">${SECTIONS.map(s => `<option value="${s.key}">${s.name}</option>`).join('')}</select></label>
      <p class="hint">提交后网站会自动抓取标题、日期、正文和照片，按原文顺序排好，约 1~2 分钟后出现在「待审核」里，由管理员检查后发布。</p>
      <button class="primary" id="iGo">开始转载</button>
    </div>`;
  $('#iGo').onclick = async () => {
    const link = $('#iUrl').value.trim().replace(/#.*$/, '');
    if (!IMPORT_OK.test(link)) return toast('请粘贴公众号文章（mp.weixin.qq.com/s/…）或学校新闻网的链接', true);
    const btn = $('#iGo');
    busy = true; btn.disabled = true;
    try {
      const id = `${Date.now()}-${crypto.getRandomValues(new Uint32Array(1))[0].toString(16).slice(0, 4)}`;
      const req = { url: link, section: $('#iSec').value, by: me.name, at: new Date().toISOString() };
      await commitFiles(cfg(), [{ path: `_import/${id}.json`, text: JSON.stringify(req, null, 1) + '\n' }], `转载请求：${link}（${me.name}）`);
      toast('已提交，约 1~2 分钟后在「待审核」里出现');
      tab = 'pending'; busy = false; render();
    } catch (e) { toast('提交失败：' + explain(e), true); }
    finally { busy = false; btn.disabled = false; }
  };
}

function renderWrite() {
  const v = $('#cbody');
  v.innerHTML = `
    <div class="panel">
      <label>标题<input id="cTitle" maxlength="60" placeholder="例如：我校教职工气排球团体赛圆满落幕"></label>
      <div class="row">
        <label>栏目<select id="cSec">${SECTIONS.map(s => `<option value="${s.key}">${s.name}</option>`).join('')}</select></label>
        <label>日期<input id="cDate" type="date" value="${today()}"></label>
      </div>
      <div class="row" id="cLearn" hidden>${learnSelects('c')}</div>
      <label>正文<textarea id="cText" rows="9" placeholder="直接输入文字，每按一次回车就是新的一段"></textarea></label>
      <p class="hint">想让照片或视频出现在正文某个位置：把光标放到那里，点缩略图下方的「插入正文」（会写入【图1】这样的标记）。同一行写两个标记会并排显示；没插入的照片视频会排在文末。</p>
      <div class="media">
        <div class="media-head"><b>照片</b><span class="hint">自动缩小到适合网页的大小；第一张作为封面</span><label class="btn">＋ 添加照片<input id="cPhotos" type="file" accept="image/*" multiple hidden></label></div>
        <div class="thumbs" id="tPhotos"></div>
      </div>
      <div class="media">
        <div class="media-head"><b>视频</b><span class="hint">自动压缩；比赛片段建议 1 分钟以内，教学视频建议一个动作一段、5 分钟以内</span><label class="btn">＋ 添加视频<input id="cVideos" type="file" accept="video/*" multiple hidden></label></div>
        <div class="thumbs" id="tVideos"></div>
      </div>
      <div class="media">
        <div class="media-head"><b>附件</b><span class="hint">规则文件、讲义等（PDF、Word、PPT、Excel），每个不超过 ${MAX_FILE_MB}MB，读者可以在线查看或下载</span><label class="btn">＋ 添加附件<input id="cFiles" type="file" accept=".pdf,.doc,.docx,.ppt,.pptx,.xls,.xlsx" multiple hidden></label></div>
        <div class="files" id="tFiles"></div>
      </div>
      <p class="hint">提交后需要管理员审核，通过后才会出现在网站上。</p>
      <button class="primary" id="cSubmit">提交审核</button>
      <div id="cStatus" class="status"></div>
    </div>`;
  const drawThumbs = () => {
    $('#tPhotos').innerHTML = draft.photos.map((f, i) => `<div class="thw"><div class="th"><img src="${f.preview}"><button data-rm="photos:${i}">×</button><span>${i === 0 ? '封面 · ' : ''}图${i + 1}</span></div><button class="ins" data-ins="photos:${i}">插入正文</button></div>`).join('');
    $('#tVideos').innerHTML = draft.videos.map((f, i) => `<div class="thw"><div class="th vid"><video src="${f.preview}" muted preload="metadata"></video><button data-rm="videos:${i}">×</button><span>视频${i + 1} · ${(f.size / 1048576).toFixed(0)}MB</span></div><button class="ins" data-ins="videos:${i}">插入正文</button></div>`).join('');
    $('#tFiles').innerHTML = draft.files.map((f, i) => `<div class="fileitem">📄 ${esc(f.name)} <span class="hint">${fmtSize(f.size)}</span><button data-rmf="${i}">×</button></div>`).join('');
    v.querySelectorAll('[data-rmf]').forEach(b => b.onclick = () => { draft.files.splice(+b.dataset.rmf, 1); drawThumbs(); });
    v.querySelectorAll('[data-rm]').forEach(b => b.onclick = () => {
      const [k, i] = b.dataset.rm.split(':');
      URL.revokeObjectURL(draft[k][i].preview);
      draft[k].splice(+i, 1);
      // 删掉这张的标记，后面的编号依次减一
      const word = MARK[k], ta = $('#cText');
      ta.value = ta.value.replace(new RegExp(`【${word}(\\d+)】`, 'g'), (m, n) => +n === +i + 1 ? '' : +n > +i + 1 ? `【${word}${n - 1}】` : m);
      drawThumbs();
    });
    v.querySelectorAll('[data-ins]').forEach(b => b.onclick = () => {
      const [k, i] = b.dataset.ins.split(':');
      const ta = $('#cText'), mark = `【${MARK[k]}${+i + 1}】`;
      const a = ta.selectionStart ?? ta.value.length, z = ta.selectionEnd ?? a;
      const before = ta.value.slice(0, a), after = ta.value.slice(z);
      // 标记单独成行；如果光标前紧挨着另一个标记，就放在同一行（并排）
      const pre = !before || before.endsWith('\n') || /】$/.test(before) ? '' : '\n';
      const post = !after || after.startsWith('\n') ? '' : '\n';
      ta.value = before + pre + mark + post + after;
      const pos = (before + pre + mark).length;
      ta.focus(); ta.setSelectionRange(pos, pos);
    });
  };
  const add = k => e => {
    for (const f of e.target.files) { f.preview = URL.createObjectURL(f); draft[k].push(f); }
    e.target.value = ''; drawThumbs();
  };
  $('#cPhotos').onchange = add('photos');
  $('#cVideos').onchange = add('videos');
  $('#cFiles').onchange = e => {
    for (const f of e.target.files) {
      if (f.size > MAX_FILE_MB * 1048576) { toast(`「${f.name}」超过 ${MAX_FILE_MB}MB，请压缩后再传`, true); continue; }
      draft.files.push(f);
    }
    e.target.value = ''; drawThumbs();
  };
  const sec = $('#cSec');
  sec.onchange = () => { $('#cLearn').hidden = sec.value !== 'learn'; };
  drawThumbs();
  $('#cSubmit').onclick = submit;
}

async function submit() {
  const title = $('#cTitle').value.trim(), text = $('#cText').value, date = $('#cDate').value, section = $('#cSec').value;
  if (!title) return toast('请填写标题', true);
  if (!text.trim() && !draft.photos.length && !draft.videos.length && !draft.files.length) return toast('正文、照片、视频、附件至少要有一样', true);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return toast('请选择日期', true);
  const btn = $('#cSubmit'), status = $('#cStatus');
  const step = s => { status.textContent = s; };
  busy = true; btn.disabled = true;
  window.onbeforeunload = () => '正在提交，离开会中断';
  try {
    const slug = `${date}-${crypto.getRandomValues(new Uint32Array(1))[0].toString(16).padStart(8, '0').slice(0, 6)}`;
    const dir = `assets/posts/${slug}`;
    const files = [], images = [], ratios = [], videos = [], attachments = [];
    for (const [i, f] of draft.photos.entries()) {
      step(`处理照片 ${i + 1}/${draft.photos.length}`);
      const path = `${dir}/p${i + 1}.jpg`;
      const { blob, ratio } = await shrinkImage(f);
      files.push({ path, blob });
      images.push('/' + path); ratios.push(ratio);
    }
    if (draft.videos.length) {
      step('加载视频压缩组件…');
      let media;
      try { media = await import('./media.js' + VER); } catch { throw new Error('视频压缩组件加载失败，请刷新页面重试'); }
      for (const [i, f] of draft.videos.entries()) {
        const tag = `视频 ${i + 1}/${draft.videos.length}`;
        const duration = await videoDuration(f);
        let blob;
        // 排球课堂（自制教学视频）把 BISTU-Volleyball 水印烧进画面
        const wm = section === 'learn' ? 'BISTU-Volleyball' : '';
        if (media.supported()) {
          step(`压缩${tag}${wm ? '并加水印' : ''}…`);
          blob = (await media.compress(f, p => step(`压缩${tag}${wm ? '并加水印' : ''}：${Math.round(p * 100)}%`), wm).catch(e => { throw new Error(`「${f.name}」${e.message}`); })).blob;
        } else if (wm) throw new Error('排球课堂的视频要在浏览器里加水印，这个浏览器不支持，请换用电脑上最新版的 Chrome 或 Edge');
        else if (/\.mp4$/i.test(f.name) && f.size <= 20 * 1048576) blob = f;
        else throw new Error('这个浏览器不能压缩视频，请换用电脑上最新版的 Chrome 或 Edge');
        if (blob.size > MAX_VIDEO_MB * 1048576) throw new Error(`「${f.name}」压缩后仍超过 ${MAX_VIDEO_MB}MB，请剪短一些（建议 1 分钟以内）`);
        const path = `${dir}/v${i + 1}.mp4`;
        files.push({ path, blob });
        const v = { src: '/' + path };
        if (duration) v.duration = duration;
        const cover = await media.poster(blob).catch(() => null);
        if (cover) { files.push({ path: `${dir}/v${i + 1}.jpg`, blob: cover }); v.poster = `/${dir}/v${i + 1}.jpg`; }
        videos.push(v);
      }
    }
    for (const [i, f] of draft.files.entries()) {
      const ext = (f.name.match(/\.(\w+)$/) || [, 'bin'])[1].toLowerCase();
      const path = `${dir}/f${i + 1}.${ext}`;
      files.push({ path, blob: f });
      attachments.push({ name: f.name, src: '/' + path, size: f.size });
    }
    const learn = section === 'learn' ? { topic: $('.cTopic').value, level: $('.cLevel').value } : {};
    const post = { title, date, section, text, author: me.name, cover: images[0] || videos[0]?.poster, images, ratios, videos, attachments, ...learn, submitted: new Date().toISOString() };
    files.push({ path: `_pending/${slug}.md`, text: buildPost(post) });
    await commitFiles(cfg(), files, `投稿：${title}（${me.name}）`, step);
    [...draft.photos, ...draft.videos].forEach(f => URL.revokeObjectURL(f.preview));
    draft.photos = []; draft.videos = []; draft.files = [];
    toast('已提交，等待管理员审核');
    tab = 'pending';
    busy = false; render();
  } catch (e) {
    step('');
    toast('提交失败：' + explain(e), true);
  } finally {
    busy = false; btn.disabled = false;
    window.onbeforeunload = null;
  }
}

// 视频时长（秒），读不出来返回 0
function videoDuration(file) {
  return new Promise(ok => {
    const v = document.createElement('video'), u = URL.createObjectURL(file);
    const done = d => { URL.revokeObjectURL(u); ok(d); };
    v.preload = 'metadata'; v.muted = true;
    v.onloadedmetadata = () => done(isFinite(v.duration) ? Math.round(v.duration) : 0);
    v.onerror = () => done(0);
    setTimeout(() => done(0), 10000);
    v.src = u;
  });
}

// ---------- 预览（审核、已发布共用）----------
function preview(p) {
  return `
    <div class="pv-media">
      ${p.videos.map(v => `<video controls preload="none" src="${url(v.src)}" ${v.poster ? `poster="${url(v.poster)}"` : ''}></video>`).join('')}
      ${p.images.map(im => `<a href="${url(im)}" target="_blank"><img loading="lazy" src="${url(im)}"></a>`).join('')}
    </div>${attachList(p.attachments)}`;
}

// 转载请求队列：_import/*.json 正在抓取，*.err.json 失败
async function loadQueue() {
  const files = (await listDir('_import')).filter(f => f.name.endsWith('.json'));
  return Promise.all(files.map(async f => {
    const d = await gh(`/contents/${f.path}?ref=main`);
    return { ...JSON.parse(b64text(d.content)), path: f.path, name: f.name, failed: f.name.endsWith('.err.json') };
  }));
}

function drawQueue(box, queue) {
  box.innerHTML = queue.map((q, i) => `
    <div class="panel queue ${q.failed ? 'bad' : ''}" data-q="${i}">
      ${q.failed ? `❌ 转载失败：${esc(q.error || '')}` : '⏳ 正在抓取，约 1~2 分钟…'}
      <div class="meta">${esc(q.url)} · ${esc(q.by || '')} · ${esc(secName(q.section))}</div>
      ${q.failed ? '<div class="actions"><button data-qa="retry">重试</button><button class="danger" data-qa="del">删除</button></div>' : ''}
    </div>`).join('');
  box.querySelectorAll('[data-q]').forEach(el => {
    const q = queue[+el.dataset.q];
    const btn = k => el.querySelector(`[data-qa="${k}"]`);
    if (!q.failed) return;
    btn('retry').onclick = () => act(el, async () => {
      const { path, name, failed, error, ...req } = q;
      await commitFiles(cfg(), [{ path: path.replace('.err.json', '.json'), text: JSON.stringify(req, null, 1) + '\n' }, { path, del: true }], `重试转载：${q.url}`);
      return '已重新提交';
    });
    btn('del').onclick = () => act(el, async () => {
      await commitFiles(cfg(), [{ path, del: true }], `删除转载请求：${q.url}`);
      return '已删除';
    });
  });
}

let queueTimer = null;
async function renderPending() {
  const v = $('#view');
  clearTimeout(queueTimer);
  v.innerHTML = '<p class="hint">读取中…</p>';
  let posts, queue;
  try { [posts, queue] = await Promise.all([loadPosts('_pending'), loadQueue()]); } catch (e) { v.innerHTML = `<p class="err">读取失败：${esc(explain(e))}</p>`; return; }
  v.innerHTML = '<div id="queue"></div><div id="plist"></div>';
  drawQueue($('#queue'), queue);
  // 有正在抓取的请求时，每 15 秒查一次；完成后提示刷新（不自动刷新，免得冲掉正在修改的内容）
  const waiting = queue.filter(q => !q.failed).length;
  const poll = async () => {
    if (tab !== 'pending' || !$('#queue')) return;
    try {
      const q2 = await loadQueue();
      const left = q2.filter(q => !q.failed).length;
      drawQueue($('#queue'), q2);
      if (left < waiting) {
        $('#queue').insertAdjacentHTML('afterbegin', '<div class="panel queue ok">✅ 转载完成 <button class="primary" id="qReload">刷新查看</button></div>');
        $('#qReload').onclick = () => render();
        return;
      }
    } catch { }
    queueTimer = setTimeout(poll, 15000);
  };
  if (waiting) queueTimer = setTimeout(poll, 15000);
  const list = $('#plist');
  if (!posts.length) { list.innerHTML = '<p class="empty">没有待审核的投稿。</p>'; return; }
  list.innerHTML = `<p class="hint">${isAdmin ? '可以直接修改标题、栏目、日期和正文后再点「通过并发布」。' : '以下投稿正在等待管理员审核。'}刚提交的投稿，照片和视频约 1 分钟后才能预览。</p>` +
    posts.map((p, i) => `
    <div class="panel item" data-i="${i}">
      <div class="meta">${esc(p.author || '未署名')} · 投稿于 ${esc((p.submitted || '').slice(0, 10))}</div>
      ${isAdmin ? `
        <label>标题<input class="eTitle" value="${esc(p.title)}"></label>
        <div class="row">
          <label>栏目<select class="eSec">${SECTIONS.map(s => `<option value="${s.key}"${s.key === p.section ? ' selected' : ''}>${s.name}</option>`).join('')}</select></label>
          <label>日期<input class="eDate" type="date" value="${esc(p.date)}"></label>
        </div>
        <div class="row eLearn"${p.section === 'learn' ? '' : ' hidden'}>${learnSelects('e', p)}</div>
        ${p.cover ? `<div class="cover-pick"><span>首页封面（卡片按这个范围截取）</span>
          <div class="cover-box"><img class="eCoverImg" src="${url(p.cover)}" style="object-position: 50% ${esc(p.cover_pos || '50%')}"></div>
          <select class="eCoverPos">${COVER_POS.map(([v, n]) => `<option value="${v}"${v === (p.cover_pos || '50%') ? ' selected' : ''}>${n}</option>`).join('')}</select></div>` : ''}
        <label>正文<textarea class="eText" rows="6">${esc(p.text)}</textarea></label>`
      : `<h3>${esc(p.title)}</h3><div class="meta">${esc(secName(p.section))} · ${esc(p.date)}</div><div class="pv-text">${p.text.split('\n').map(s => `<p>${esc(s)}</p>`).join('')}</div>`}
      ${isAdmin ? '<div class="pv-media eMedia"></div>' + attachList(p.attachments) : preview(p)}
      ${isAdmin ? '<div class="actions"><button class="primary" data-act="ok">通过并发布</button><button class="danger" data-act="no">退回（删除）</button></div>' : ''}
    </div>`).join('');
  if (!isAdmin) return;
  list.querySelectorAll('.item').forEach(card => {
    const p = posts[+card.dataset.i];
    // 可删除单张照片：st 记录当前保留的照片，删掉的在发布时一并从仓库删除
    const st = { images: [...p.images], ratios: p.ratios && p.ratios.length === p.images.length ? [...p.ratios] : null, removed: [], cover: p.cover };
    const drawMedia = () => {
      const box = card.querySelector('.eMedia');
      box.innerHTML = p.videos.map(v => `<video controls preload="none" src="${url(v.src)}" ${v.poster ? `poster="${url(v.poster)}"` : ''}></video>`).join('') +
        st.images.map((im, k) => `<div class="pvi"><a href="${url(im)}" target="_blank"><img loading="lazy" src="${url(im)}"></a><span>图${k + 1}${im === st.cover ? ' · 封面' : ''}</span><button data-del="${k}" title="删除这张照片">×</button></div>`).join('');
      box.querySelectorAll('[data-del]').forEach(b => b.onclick = () => {
        const k = +b.dataset.del;
        const [gone] = st.images.splice(k, 1);
        if (st.ratios) st.ratios.splice(k, 1);
        st.removed.push(gone);
        const ta = card.querySelector('.eText');
        ta.value = ta.value.replace(/【图(\d+)】/g, (m, n) => +n === k + 1 ? '' : +n > k + 1 ? `【图${n - 1}】` : m)
          .split('\n').filter(l => l.trim()).join('\n');
        if (gone === st.cover) {
          st.cover = st.images[0] || '';
          const ci = card.querySelector('.eCoverImg');
          if (ci) { if (st.cover) ci.src = url(st.cover); else card.querySelector('.cover-pick').remove(); }
        }
        drawMedia();
      });
    };
    drawMedia();
    const secSel = card.querySelector('.eSec');
    secSel.addEventListener('change', () => { card.querySelector('.eLearn').hidden = secSel.value !== 'learn'; });
    const sel = card.querySelector('.eCoverPos');
    if (sel) sel.onchange = () => { card.querySelector('.eCoverImg').style.objectPosition = `50% ${sel.value}`; };
    card.querySelector('[data-act="ok"]').onclick = () => act(card, async () => {
      const pos = card.querySelector('.eCoverPos')?.value;
      const q = { ...p, title: card.querySelector('.eTitle').value.trim(), section: card.querySelector('.eSec').value, date: card.querySelector('.eDate').value, text: card.querySelector('.eText').value, cover_pos: pos && pos !== '50%' ? pos : undefined, approved_by: me.name,
        images: st.images, ratios: st.ratios || undefined, cover: st.cover || undefined };
      if (q.section === 'learn') { q.topic = card.querySelector('.eTopic').value; q.level = card.querySelector('.eLevel').value; }
      else { delete q.topic; delete q.level; }
      if (!q.title || !/^\d{4}-\d{2}-\d{2}$/.test(q.date)) throw new Error('标题和日期不能为空');
      await commitFiles(cfg(), [{ path: `_posts/${p.slug}.md`, text: buildPost(q) }, { path: p.path, del: true }, ...st.removed.map(f => ({ path: f.replace(/^\//, ''), del: true }))], `发布：${q.title}（审核：${me.name}）`);
      return '已发布，约 1 分钟后出现在网站上';
    });
    card.querySelector('[data-act="no"]').onclick = () => {
      if (!confirm(`确定退回「${p.title}」？投稿和它的照片视频都会被删除（GitHub 历史里仍可找回）。`)) return;
      act(card, async () => {
        const assets = await listDir(`assets/posts/${p.slug}`);
        await commitFiles(cfg(), [{ path: p.path, del: true }, ...assets.map(f => ({ path: f.path, del: true }))], `退回：${p.title}（${me.name}）`);
        return '已退回';
      });
    };
  });
}

async function act(card, fn) {
  if (busy) return;
  busy = true;
  card.querySelectorAll('button').forEach(b => b.disabled = true);
  try { toast(await fn()); busy = false; render(); }
  catch (e) { toast('操作失败：' + explain(e), true); card.querySelectorAll('button').forEach(b => b.disabled = false); }
  finally { busy = false; }
}

// ---------- 已发布（管理员）----------
async function renderPublished() {
  const v = $('#view');
  v.innerHTML = '<p class="hint">读取中…</p>';
  let posts;
  try { posts = await loadPosts('_posts'); } catch (e) { v.innerHTML = `<p class="err">读取失败：${esc(explain(e))}</p>`; return; }
  const trash = `<div class="panel"><h3>🗑️ 最近删除 <span class="hint">误删、误退回的文章可以在这里一键恢复</span></h3><div id="trash"><button id="trashLoad">查看最近删除的内容</button></div></div>`;
  if (!posts.length) { v.innerHTML = '<p class="empty">还没有已发布的内容。</p>' + trash; $('#trashLoad').onclick = () => renderTrash($('#trash')); return; }
  v.innerHTML = `<p class="hint">要修改已发布的文章：先「撤回到待审核」，在「审核」里改好再发布。</p>` + posts.map((p, i) => `
    <div class="panel item row-item" data-i="${i}">
      <div class="ri-main">
        <a href="${postUrl(p)}" target="_blank"><b>${esc(p.title)}</b></a>
        <div class="meta">${esc(secName(p.section))} · ${esc(p.date)} · ${esc(p.author || '')}${p.approved_by ? ` · 审核 ${esc(p.approved_by)}` : ''}</div>
      </div>
      <div class="actions"><button data-act="back">撤回到待审核</button><button class="danger" data-act="del">删除</button></div>
    </div>`).join('') + trash;
  $('#trashLoad').onclick = () => renderTrash($('#trash'));
  v.querySelectorAll('.item').forEach(card => {
    const p = posts[+card.dataset.i];
    card.querySelector('[data-act="back"]').onclick = () => act(card, async () => {
      const { approved_by, ...q } = p;
      await commitFiles(cfg(), [{ path: `_pending/${p.slug}.md`, text: buildPost(q) }, { path: p.path, del: true }], `撤回：${p.title}（${me.name}）`);
      return '已撤回到待审核，网站上约 1 分钟后消失';
    });
    card.querySelector('[data-act="del"]').onclick = () => {
      if (!confirm(`确定删除「${p.title}」？文章和它的照片视频都会从网站删除（GitHub 历史里仍可找回）。`)) return;
      act(card, async () => {
        const assets = await listDir(`assets/posts/${p.slug}`);
        await commitFiles(cfg(), [{ path: p.path, del: true }, ...assets.map(f => ({ path: f.path, del: true }))], `删除：${p.title}（${me.name}）`);
        return '已删除';
      });
    };
  });
}

// ---------- 首页设置（管理员）----------
// _data/home.json：slogan 口号；heroes 首屏大图 [{src, pos}]；stats 数字卡片 [{icon, num, label}]；
// notice 近期活动 {show, title, desc, url, image, button}；wall 照片墙 [{src, post}]（空则自动取最新报道）
const HERO_POS = [['20%', '偏上'], ['35%', '稍偏上'], ['50%', '居中'], ['65%', '稍偏下'], ['80%', '偏下']];
const relUrl = p => `/posts/${p.date.slice(0, 4)}/${p.date.slice(5, 7)}${p.date.slice(8, 10)}-${p.slug.slice(11)}/`;
const readData = async name => {
  const d = await gh(`/contents/_data/${name}.json?ref=main`).catch(e => { if (e.status === 404) return null; throw e; });
  return d ? JSON.parse(b64text(d.content)) : {};
};
const val = (root, sel) => root.querySelector(sel).value.trim();

async function renderHome() {
  const v = $('#view');
  v.innerHTML = '<p class="hint">读取中…</p>';
  let home, posts;
  try { [home, posts] = await Promise.all([readData('home'), loadPosts('_posts')]); }
  catch (e) { v.innerHTML = `<p class="err">读取失败：${esc(explain(e))}</p>`; return; }
  const nt = home.notice || {};
  const stats = [...(home.stats || [])];
  while (stats.length < 4) stats.push({ icon: '', num: '', label: '' });
  const st = { heroes: [...(home.heroes || [])], wall: [...(home.wall || [])], noticeImg: nt.image || '', noticeFile: null };
  const ratioOf = src => { for (const p of posts) { const i = p.images.indexOf(src); if (i >= 0 && p.ratios) return p.ratios[i]; } return 0; };

  v.innerHTML = `
    <p class="hint">这里改的是首页的各个板块。改完点最下面的「保存首页设置」，约 1 分钟后生效。</p>
    <div class="panel">
      <h3>① 首屏口号</h3>
      <label>口号（显示在协会名称下面）<input id="hSlogan" value="${esc(home.slogan || '')}"></label>
    </div>
    <div class="panel">
      <h3>② 首屏大图 <span class="hint">1~3 张，多张时每 6 秒轮播；在最下面的照片里点「大图」添加</span></h3>
      <div id="hHeroes" class="hs-list"></div>
    </div>
    <div class="panel">
      <h3>③ 数字卡片 <span class="hint">首屏下方的 4 张卡片；图标可以填一个表情符号，留空的卡片不显示</span></h3>
      ${stats.slice(0, 4).map((s, k) => `
      <div class="row hs-stat" data-s="${k}">
        <label style="flex:0 0 70px">图标<input class="sIcon" value="${esc(s.icon || '')}"></label>
        <label>数字<input class="sNum" value="${esc(s.num || '')}" placeholder="例如：200余"></label>
        <label>说明<input class="sLabel" value="${esc(s.label || '')}" placeholder="例如：名会员"></label>
      </div>`).join('')}
    </div>
    <div class="panel">
      <h3>④ 近期活动</h3>
      <label class="hs-check"><input type="checkbox" id="nShow"${nt.show ? ' checked' : ''}> 在首页显示「近期活动」</label>
      <label>标题<input id="nTitle" value="${esc(nt.title || '')}" placeholder="例如：2026 教职工气排球团体赛 · 精彩视频评选"></label>
      <label>说明<textarea id="nDesc" rows="3">${esc(nt.desc || '')}</textarea></label>
      <div class="row">
        <label>按钮文字<input id="nBtn" value="${esc(nt.button || '')}" placeholder="例如：去投票、查看详情"></label>
        <label>点击后打开的网址<input id="nUrl" value="${esc(nt.url || '')}" placeholder="https://..."></label>
      </div>
      <div class="hs-nimg">
        <div class="hs-nimg-box" id="nImgBox"></div>
        <div><b>活动图片</b><p class="hint">上传一张横幅图片，或在最下面的照片里点「活动图」。</p>
          <label class="btn">上传图片<input type="file" id="nFile" accept="image/*" hidden></label> <button id="nImgDel">不用图片</button></div>
      </div>
    </div>
    <div class="panel">
      <h3>⑤ 照片墙 <span class="hint">最多 8 张，第 1 张为大图、第 4 张为宽图；不选时自动用最新 8 篇报道的照片</span></h3>
      <div id="hWall" class="hs-wall"></div>
    </div>
    <div class="panel savebar">
      <button class="primary" id="hSave">保存首页设置</button> <span class="hint">保存后约 1 分钟生效</span>
    </div>
    <div class="panel">
      <h3>从已发布的文章里选照片</h3>
      <div id="hPick"></div>
    </div>`;

  const drawNotice = () => {
    const src = st.noticeFile ? st.noticeFile.preview : (st.noticeImg ? url(st.noticeImg) : '');
    $('#nImgBox').innerHTML = src ? `<img src="${src}">` : '<span class="hint">未设置图片</span>';
  };
  const draw = () => {
    $('#hHeroes').innerHTML = st.heroes.length ? st.heroes.map((h, k) => `
      <div class="hs-hero">
        <div class="hs-hero-box" style="background-image: url('${url(h.src)}'); background-position: center ${esc(h.pos || '50%')}"></div>
        <div class="hs-ctl">
          <span>第 ${k + 1} 张</span>
          <select data-hpos="${k}">${HERO_POS.map(([x, n]) => `<option value="${x}"${x === (h.pos || '50%') ? ' selected' : ''}>${n}</option>`).join('')}</select>
          ${k ? `<button data-hup="${k}">↑ 前移</button>` : ''}
          <button class="danger" data-hdel="${k}">移除</button>
        </div>
      </div>`).join('') : '<p class="hint">还没有选择。至少选一张，否则首屏只显示深蓝底色。</p>';
    $('#hWall').innerHTML = st.wall.length ? st.wall.map((w, k) => `
      <div class="hs-w${k === 0 ? ' big' : ''}"><img src="${url(w.src)}"><span>${k + 1}</span>
        <div class="hs-wb">${k ? `<button data-wup="${k}" title="前移">↑</button>` : ''}<button data-wdel="${k}" title="移除">×</button></div></div>`).join('') +
      '<button id="hWallAuto" class="hs-auto">清空，恢复自动</button>'
      : '<p class="hint">当前为自动：取最新 8 篇报道各一张现场照片。</p>';
    v.querySelectorAll('[data-hpos]').forEach(el => el.onchange = () => { st.heroes[+el.dataset.hpos].pos = el.value; draw(); });
    v.querySelectorAll('[data-hup]').forEach(el => el.onclick = () => { const k = +el.dataset.hup; [st.heroes[k - 1], st.heroes[k]] = [st.heroes[k], st.heroes[k - 1]]; draw(); });
    v.querySelectorAll('[data-hdel]').forEach(el => el.onclick = () => { st.heroes.splice(+el.dataset.hdel, 1); draw(); });
    v.querySelectorAll('[data-wup]').forEach(el => el.onclick = () => { const k = +el.dataset.wup; [st.wall[k - 1], st.wall[k]] = [st.wall[k], st.wall[k - 1]]; draw(); });
    v.querySelectorAll('[data-wdel]').forEach(el => el.onclick = () => { st.wall.splice(+el.dataset.wdel, 1); draw(); });
    const auto = $('#hWallAuto');
    if (auto) auto.onclick = () => { st.wall = []; draw(); };
    v.querySelectorAll('[data-pick]').forEach(el => {
      const [kind, src] = [el.dataset.kind, el.dataset.pick];
      const on = kind === 'hero' ? st.heroes.some(h => h.src === src) : kind === 'wall' ? st.wall.some(w => w.src === src) : !st.noticeFile && st.noticeImg === src;
      el.classList.toggle('on', on);
    });
    drawNotice();
  };

  $('#hPick').innerHTML = posts.map((p, pi) => `
    <div class="hs-post">
      <div class="meta">${esc(p.date)} · ${esc(p.title)}</div>
      <div class="hs-thumbs">${p.images.map(im => `
        <div class="hs-t"><img loading="lazy" src="${url(im)}">
          <div><button data-kind="hero" data-pick="${esc(im)}" data-post="${pi}">大图</button><button data-kind="wall" data-pick="${esc(im)}" data-post="${pi}">照片墙</button><button data-kind="notice" data-pick="${esc(im)}" data-post="${pi}">活动图</button></div>
        </div>`).join('')}</div>
    </div>`).join('');
  $('#hPick').querySelectorAll('[data-pick]').forEach(el => el.onclick = () => {
    const src = el.dataset.pick, p = posts[+el.dataset.post], kind = el.dataset.kind;
    if (kind === 'hero') {
      const i = st.heroes.findIndex(h => h.src === src);
      if (i >= 0) st.heroes.splice(i, 1);
      else {
        if (st.heroes.length >= 3) return toast('首屏大图最多 3 张，先移除一张', true);
        const r = ratioOf(src);
        if (r && r < 1.2) toast('这是一张竖图，放在首屏会被裁掉很多，建议选横幅照片', true);
        st.heroes.push({ src, pos: '50%' });
      }
    } else if (kind === 'wall') {
      const i = st.wall.findIndex(w => w.src === src);
      if (i >= 0) st.wall.splice(i, 1);
      else {
        if (st.wall.length >= 8) return toast('照片墙最多 8 张，先移除一张', true);
        st.wall.push({ src, post: relUrl(p) });
      }
    } else { st.noticeFile = null; st.noticeImg = src; }
    draw();
  });
  $('#nFile').onchange = e => {
    const f = e.target.files[0];
    if (!f) return;
    f.preview = URL.createObjectURL(f);
    st.noticeFile = f; e.target.value = ''; draw();
  };
  $('#nImgDel').onclick = () => { st.noticeFile = null; st.noticeImg = ''; draw(); };
  draw();

  $('#hSave').onclick = () => act($('#view'), async () => {
    const files = [];
    if (st.noticeFile) {
      const { blob } = await shrinkImage(st.noticeFile);
      const path = `assets/img/notice-${Date.now()}.jpg`;
      files.push({ path, blob });
      st.noticeImg = '/' + path;
    }
    const data = {
      ...home,
      slogan: val(v, '#hSlogan'),
      heroes: st.heroes,
      stats: [...v.querySelectorAll('.hs-stat')].map(r => ({ icon: val(r, '.sIcon'), num: val(r, '.sNum'), label: val(r, '.sLabel') })).filter(s => s.num || s.label),
      notice: { show: $('#nShow').checked, title: val(v, '#nTitle'), desc: val(v, '#nDesc'), url: val(v, '#nUrl'), image: st.noticeImg, button: val(v, '#nBtn') },
      wall: st.wall,
    };
    if (data.notice.show && !data.notice.title) throw new Error('近期活动要在首页显示，请填写标题');
    files.push({ path: '_data/home.json', text: JSON.stringify(data, null, 1) + '\n' });
    await commitFiles(cfg(), files, `首页设置（${me.name}）`);
    return '已保存，约 1 分钟后首页更新';
  });
}

// ---------- 关于协会（管理员）----------
// _data/about.json：title、intro[段落]、stats[{num,label}]、timeline[{date,text,link}]、training、location、join[行]、contact{name,email}
async function renderAbout() {
  const v = $('#view');
  v.innerHTML = '<p class="hint">读取中…</p>';
  let A, posts;
  try { [A, posts] = await Promise.all([readData('about'), loadPosts('_posts')]); }
  catch (e) { v.innerHTML = `<p class="err">读取失败：${esc(explain(e))}</p>`; return; }
  const stats = [...(A.stats || [])];
  while (stats.length < 4) stats.push({ num: '', label: '' });
  const tl = (A.timeline || []).map(t => ({ ...t }));
  const opts = sel => `<option value="">（不关联报道）</option>` + posts.map(p => `<option value="${relUrl(p)}"${relUrl(p) === sel ? ' selected' : ''}>${esc(p.date)} ${esc(p.title.slice(0, 30))}</option>`).join('');

  v.innerHTML = `
    <p class="hint">这里改的是「关于协会」页面，首页底部「加入我们」的地点和联系人也取自这里。改完点最下面的「保存」，约 1 分钟后生效。</p>
    <div class="panel">
      <h3>协会简介</h3>
      <label>标题<input id="aTitle" value="${esc(A.title || '')}"></label>
      <label>简介（每按一次回车就是新的一段）<textarea id="aIntro" rows="6">${esc((A.intro || []).join('\n'))}</textarea></label>
      <p class="hint">数字卡片（留空的不显示）：</p>
      ${stats.slice(0, 4).map(s => `<div class="row a-stat"><label>数字<input class="sNum" value="${esc(s.num || '')}"></label><label>说明<input class="sLabel" value="${esc(s.label || '')}"></label></div>`).join('')}
    </div>
    <div class="panel">
      <h3>我们走过的路 <span class="hint">按时间先后排列；可以关联一篇已发布的报道，页面上会出现「阅读报道」链接</span></h3>
      <div id="aTl"></div>
      <button id="aTlAdd">＋ 添加一条</button>
    </div>
    <div class="panel">
      <h3>日常训练与加入我们</h3>
      <label>日常训练<textarea id="aTrain" rows="3">${esc(A.training || '')}</textarea></label>
      <label>活动地点<input id="aLoc" value="${esc(A.location || '')}"></label>
      <label>加入我们（每行一句）<textarea id="aJoin" rows="3">${esc((A.join || []).join('\n'))}</textarea></label>
      <div class="row"><label>联系人<input id="aCName" value="${esc(A.contact?.name || '')}"></label><label>联系邮箱<input id="aCMail" value="${esc(A.contact?.email || '')}"></label></div>
    </div>
    <div class="panel savebar"><button class="primary" id="aSave">保存「关于协会」</button> <span class="hint">保存后约 1 分钟生效</span></div>`;

  const readTl = () => [...v.querySelectorAll('.tl-row')].forEach((r, k) => { tl[k] = { date: val(r, '.tDate'), text: val(r, '.tText'), link: r.querySelector('.tLink').value }; });
  const drawTl = () => {
    $('#aTl').innerHTML = tl.map((t, k) => `
      <div class="tl-row">
        <div class="tl-no">${k + 1}</div>
        <div class="tl-fields">
          <div class="row"><label style="flex:0 0 150px">时间<input class="tDate" value="${esc(t.date || '')}" placeholder="例如：2026年11月"></label>
            <label>关联报道<select class="tLink">${opts(t.link || '')}</select></label></div>
          <label>内容<textarea class="tText" rows="2">${esc(t.text || '')}</textarea></label>
        </div>
        <div class="tl-ops">${k ? `<button data-tup="${k}" title="上移">↑</button>` : ''}${k < tl.length - 1 ? `<button data-tdown="${k}" title="下移">↓</button>` : ''}<button class="danger" data-tdel="${k}" title="删除">×</button></div>
      </div>`).join('') || '<p class="hint">还没有内容。</p>';
    v.querySelectorAll('[data-tup]').forEach(b => b.onclick = () => { readTl(); const k = +b.dataset.tup; [tl[k - 1], tl[k]] = [tl[k], tl[k - 1]]; drawTl(); });
    v.querySelectorAll('[data-tdown]').forEach(b => b.onclick = () => { readTl(); const k = +b.dataset.tdown; [tl[k + 1], tl[k]] = [tl[k], tl[k + 1]]; drawTl(); });
    v.querySelectorAll('[data-tdel]').forEach(b => b.onclick = () => { readTl(); if (confirm('删除这一条？')) { tl.splice(+b.dataset.tdel, 1); drawTl(); } });
  };
  $('#aTlAdd').onclick = () => { readTl(); tl.push({ date: '', text: '' }); drawTl(); v.querySelector('.tl-row:last-child .tDate').focus(); };
  drawTl();

  $('#aSave').onclick = () => act($('#view'), async () => {
    readTl();
    const lines = s => s.split('\n').map(x => x.trim()).filter(Boolean);
    const data = {
      ...A,
      title: val(v, '#aTitle'),
      intro: lines($('#aIntro').value),
      stats: [...v.querySelectorAll('.a-stat')].map(r => ({ num: val(r, '.sNum'), label: val(r, '.sLabel') })).filter(s => s.num || s.label),
      timeline: tl.filter(t => t.date || t.text).map(t => t.link ? t : { date: t.date, text: t.text }),
      training: $('#aTrain').value.trim(),
      location: val(v, '#aLoc'),
      join: lines($('#aJoin').value),
      contact: { name: val(v, '#aCName'), email: val(v, '#aCMail') },
    };
    await commitFiles(cfg(), [{ path: '_data/about.json', text: JSON.stringify(data, null, 1) + '\n' }], `关于协会（${me.name}）`);
    return '已保存，约 1 分钟后页面更新';
  });
}

// ---------- 最近删除（回收站，管理员）----------
// 从 GitHub 提交记录里找「删除：」「退回：」，一键把当时删掉的文件原样放回去
async function renderTrash(box) {
  box.innerHTML = '<p class="hint">读取中…</p>';
  let list;
  try {
    const commits = (await gh('/commits?per_page=60')).filter(c => /^(删除|退回)：/.test(c.commit.message)).slice(0, 15);
    list = await Promise.all(commits.map(async c => {
      const d = await gh(`/commits/${c.sha}`);
      return { sha: c.sha, msg: c.commit.message.split('\n')[0], when: c.commit.author.date, files: (d.files || []).filter(f => f.status === 'removed').map(f => ({ path: f.filename, sha: f.sha })) };
    }));
  } catch (e) { box.innerHTML = `<p class="err">读取失败：${esc(explain(e))}</p>`; return; }
  list = list.filter(x => x.files.some(f => f.path.endsWith('.md')));
  if (!list.length) { box.innerHTML = '<p class="hint">最近没有删除或退回的内容。</p>'; return; }
  box.innerHTML = list.map((x, i) => `
    <div class="trash-item" data-t="${i}">
      <div><b>${esc(x.msg)}</b><div class="meta">${new Date(x.when).toLocaleString('zh-CN')} · ${x.files.length} 个文件</div></div>
      <button data-restore="${i}">恢复</button>
    </div>`).join('');
  box.querySelectorAll('[data-restore]').forEach(b => b.onclick = () => {
    const x = list[+b.dataset.restore];
    const md = x.files.find(f => f.path.endsWith('.md'));
    const where = md.path.startsWith('_pending/') ? '待审核' : '网站上';
    if (!confirm(`恢复「${x.msg.replace(/^(删除|退回)：/, '')}」？会放回${where}。`)) return;
    act(b.closest('.trash-item'), async () => {
      await commitFiles(cfg(), x.files.map(f => ({ path: f.path, sha: f.sha })), `恢复：${x.msg.replace(/^(删除|退回)：/, '')}（${me.name}）`);
      return `已恢复，放回${where}`;
    });
  });
}

// ---------- 设置 ----------
function renderSettings() {
  const v = $('#view');
  v.innerHTML = `
    <div class="panel">
      <p>钥匙类型：<b>${isAdmin ? '管理员' : '发布人'}</b> <span class="hint">（检测结果 ${roleCheck}${isAdmin ? '' : '；如果这应该是管理员钥匙，请确认生成时加了 Pages：Read and write'}）</span></p>
      <label>署名<input id="nName" value="${esc(me.name)}"></label>
      <button id="nSave">保存署名</button>
      <hr>
      <p><b>上传测速</b>：传 1MB 测试数据（不会提交到网站），看看这里的网络传视频是否够快。</p>
      <button id="nSpeed">开始测速</button> <span id="nSpeedOut" class="hint"></span>
      <hr>
      <p>换电脑或换人使用时，可以退出（会清除这个浏览器里保存的钥匙）。</p>
      <button class="danger" id="nOut">退出</button>
    </div>
    ${isAdmin ? `
    <div class="panel">
      <h3>生成发布人邀请链接</h3>
      <p class="hint">在 GitHub 上为对方新建一把钥匙后，把钥匙和对方署名填在这里，生成的链接发给对方，点开即可使用。链接里含钥匙，请私发，不要发到群里。</p>
      <div class="row"><label>署名<input id="iName" placeholder="例如：张老师"></label><label>钥匙<input id="iKey" placeholder="github_pat_..." autocomplete="off"></label></div>
      <button id="iMake">生成链接</button>
      <textarea id="iOut" rows="3" readonly hidden></textarea>
    </div>
    <div class="panel">
      <h3>网站构建状态</h3>
      <p id="bStatus" class="hint">读取中…</p>
      <button id="bRebuild">重新构建网站</button>
      <p class="hint">发布后网站一般 1 分钟内更新；如果状态显示失败，点「重新构建」即可。</p>
    </div>` : ''}`;
  $('#nSave').onclick = () => {
    const n = $('#nName').value.trim();
    if (!n) return toast('署名不能为空', true);
    me.name = n; localStorage.setItem(LS, JSON.stringify(me)); toast('已保存'); render();
  };
  $('#nSpeed').onclick = async () => {
    const out = $('#nSpeedOut');
    out.textContent = '测速中…';
    try {
      const r = await speedTest(cfg(), 1);
      const mbMin = r.kbps * 60 / 1024;
      out.textContent = `约 ${r.kbps.toFixed(0)} KB/秒（单个视频压缩后最大约 ${mbMin.toFixed(0)}MB）` + (mbMin < 5 ? '，偏慢，建议换个网络传视频' : '，可以正常上传');
    } catch (e) { out.textContent = '测速失败：' + explain(e); }
  };
  $('#nOut').onclick = () => {
    if (!confirm('确定退出？下次使用需要重新填写钥匙。')) return;
    localStorage.removeItem(LS); me = null; isAdmin = false; tab = 'compose'; render();
  };
  if (!isAdmin) return;
  $('#iMake').onclick = () => {
    const n = $('#iName').value.trim(), k = $('#iKey').value.trim();
    if (!n || !k) return toast('署名和钥匙都要填', true);
    const out = $('#iOut');
    out.hidden = false;
    out.value = `${location.origin}${location.pathname}#k=${encodeURIComponent(k)}&n=${encodeURIComponent(n)}`;
    out.select();
    navigator.clipboard?.writeText(out.value).then(() => toast('已复制链接'), () => {});
  };
  const loadBuild = async () => {
    try {
      const b = await gh('/pages/builds/latest');
      const st = { built: '✅ 正常', building: '⏳ 构建中', queued: '⏳ 排队中', errored: '❌ 失败' }[b.status] || b.status;
      $('#bStatus').textContent = `${st}（${new Date(b.updated_at).toLocaleString('zh-CN')}）${b.error?.message ? '：' + b.error.message : ''}`;
    } catch (e) { $('#bStatus').textContent = '读取失败：' + explain(e); }
  };
  loadBuild();
  $('#bRebuild').onclick = async () => {
    try { await gh('/pages/builds', { method: 'POST' }); toast('已开始重新构建'); setTimeout(loadBuild, 3000); }
    catch (e) { toast('失败：' + explain(e), true); }
  };
}

(async () => {
  if (me && !(await verify())) return;
  render();
})();
