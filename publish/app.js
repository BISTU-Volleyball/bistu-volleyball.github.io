// 发布助手：投稿 → 待审核（_pending/）→ 管理员通过后移到 _posts/ 上线
// 钥匙 = GitHub 细粒度令牌，只存在本浏览器。只带 Contents 权限的是发布人钥匙；
// 额外带 Pages 写权限的是管理员钥匙（能审核、管理已发布内容、重新构建网站）
// 子模块带上与 app.js 相同的版本号，网站更新后不会用到浏览器里缓存的旧版本
const VER = new URL(import.meta.url).search;
const { ghClient, commitFiles, speedTest, shrinkImage, keepOriginal } = await import('./gh.js' + VER);

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
// 各栏目的画质：排球课堂、风采相册用高清视频；风采相册的照片保留原图（其余栏目照片缩到长边 1600）
const HQ_VIDEO = ['learn', 'gallery'], ORIGINAL_PHOTO = ['gallery'];
const SPH_SECS = ['learn', 'gallery']; // 可以附视频号链接的栏目
const MAX_MB = { standard: 38, high: 38 }; // GitHub 上传接口单个文件约 40MB 封顶（见 media.js）
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
const FM_KEYS = ['layout', 'title', 'date', 'section', 'album', 'album_name', 'author', 'summary', 'cover', 'cover_pos', 'images', 'originals', 'ratios', 'videos', 'attachments', 'channels', 'topic', 'level', 'submitted', 'submitted_by', 'source_url', 'approved_by'];

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

// ---------- 风采相册的小相册 ----------
// _data/albums.json：[{ id, name }]，排在前面的显示在前面；每个小相册一个页面 gallery/<id>/index.html（_layouts/album.html）
// 文章 front matter 的 album 存相册编号；投稿时新建的相册先记在 album_name 里，审核通过时才写进 albums.json
const NEW_ALBUM = '__new';
const loadAlbums = async () => { const a = await readData('albums'); return Array.isArray(a) ? a : []; };
const newAlbumId = () => `${today().replace(/-/g, '')}-${crypto.getRandomValues(new Uint16Array(1))[0].toString(16).padStart(4, '0')}`;
const albumPage = a => ({ path: `gallery/${a.id}/index.html`, text: `---\nlayout: album\ntitle: ${JSON.stringify(a.name)}\nalbum: ${JSON.stringify(a.id)}\n---\n` });
const albumsFile = list => ({ path: '_data/albums.json', text: JSON.stringify(list.map(({ id, name }) => ({ id, name })), null, 1) + '\n' });
// 投稿用的小相册选择框（x 是 id 前缀：c 自己写 / i 转载）
const albumPicker = x => `
      <div id="${x}AlbumBox" hidden><div class="row">
        <label>小相册<select id="${x}Album"><option value="">读取中…</option></select></label>
        <label id="${x}AlbumNewL" hidden>新相册名称<input id="${x}AlbumNew" maxlength="30" placeholder="例如：2027年教职工迎新赛"></label>
      </div><p class="hint">选一个已有的小相册，或选「＋ 新建小相册」；新建的相册审核通过后出现在网站上。</p></div>`;
let albumCache = null;
function bindAlbumPicker(x) {
  const sel = $(`#${x}Album`), fill = list => {
    sel.innerHTML = '<option value="">请选择小相册</option>' + list.map(a => `<option value="${esc(a.id)}">${esc(a.name)}</option>`).join('') + `<option value="${NEW_ALBUM}">＋ 新建小相册…</option>`;
  };
  sel.onchange = () => { $(`#${x}AlbumNewL`).hidden = sel.value !== NEW_ALBUM; if (sel.value === NEW_ALBUM) $(`#${x}AlbumNew`).focus(); };
  (albumCache ? Promise.resolve(albumCache) : loadAlbums().then(l => albumCache = l)).then(fill).catch(() => fill([]));
}
// 读选择结果：{ album } 或新建的 { album, album_name }；没选好返回 null 并提示
function readAlbumPicker(x) {
  const v = $(`#${x}Album`).value;
  if (!v) { toast('请选择小相册（或新建一个）', true); $(`#${x}Album`).focus(); return null; }
  if (v !== NEW_ALBUM) return { album: v };
  const name = $(`#${x}AlbumNew`).value.trim();
  if (!name) { toast('请填写新相册的名称', true); $(`#${x}AlbumNew`).focus(); return null; }
  const same = (albumCache || []).find(a => a.name === name);
  return same ? { album: same.id } : { album: newAlbumId(), album_name: name };
}

// ---------- 投稿 ----------
let composeMode = 'write';
function renderCompose() {
  $('#view').innerHTML = `
    <div class="modes"><button data-mode="write" class="${composeMode === 'write' ? 'on' : ''}">✍️ 自己写</button><button data-mode="import" class="${composeMode === 'import' ? 'on' : ''}">🔗 转载公众号 / 视频号</button></div>
    <div id="cbody"></div>`;
  root.querySelectorAll('[data-mode]').forEach(b => b.onclick = () => { if (!busy) { composeMode = b.dataset.mode; renderCompose(); } });
  (composeMode === 'import' ? renderImport : renderWrite)();
}

// 视频号链接：weixin.qq.com/sph/<编号> 或 channels.weixin.qq.com/...?id=<编号>，统一成短链接
const SPH_OK = /^https:\/\/(weixin\.qq\.com\/sph\/[A-Za-z0-9_-]+|channels\.weixin\.qq\.com\/.*[?&]id=[A-Za-z0-9_-]+)/;
const normSph = u => { const m = u.match(/sph\/([A-Za-z0-9_-]+)|[?&]id=([A-Za-z0-9_-]+)/); return m ? `https://weixin.qq.com/sph/${m[1] || m[2]}` : u; };
async function submitChannelsOnly(link, title, section, album) {
  const btn = $('#cSubmit');
  busy = true; btn.disabled = true;
  try {
    const id = `${Date.now()}-${crypto.getRandomValues(new Uint32Array(1))[0].toString(16).slice(0, 4)}`;
    const req = { url: normSph(link), section, by: me.name, at: new Date().toISOString(), title, ...(section === 'learn' ? { topic: $('.cTopic').value, level: $('.cLevel').value } : {}), ...album };
    await commitFiles(cfg(), [{ path: `_import/${id}.json`, text: JSON.stringify(req, null, 1) + '\n' }], `转载请求：${req.url}（${me.name}）`);
    toast('已提交，约 1 分钟后在「待审核」里出现');
    tab = 'pending'; busy = false; render();
  } catch (e) { toast('提交失败：' + explain(e), true); }
  finally { busy = false; btn.disabled = false; }
}

// 转载：提交一个请求文件 _import/<编号>.json，GitHub Actions 抓取后生成待审核稿（tools/import_article.py）
const IMPORT_OK = /^https:\/\/(mp\.weixin\.qq\.com\/s|news\.bistu\.edu\.cn\/|weixin\.qq\.com\/sph\/|channels\.weixin\.qq\.com\/)/;
function renderImport() {
  const v = $('#cbody');
  v.innerHTML = `
    <div class="panel">
      <label>文章链接<input id="iUrl" placeholder="https://mp.weixin.qq.com/s/..."></label>
      <p class="hint">支持<b>公众号文章</b>、<b>视频号视频</b>和学校新闻网（news.bistu.edu.cn）。在微信里打开文章或视频 → 右上角「···」→「复制链接」。视频号的视频不会搬到网站上，网站会生成一张卡片，点击直接跳到视频号观看（标题、封面自动获取），不占网站空间、不限时长。</p>
      <label>栏目<select id="iSec">${SECTIONS.map(s => `<option value="${s.key}">${s.name}</option>`).join('')}</select></label>${albumPicker('i')}
      <p class="hint">提交后网站会自动抓取标题、日期、正文和照片，按原文顺序排好，约 1~2 分钟后出现在「待审核」里，由管理员检查后发布。</p>
      <button class="primary" id="iGo">开始转载</button>
    </div>`;
  bindAlbumPicker('i');
  $('#iSec').onchange = () => { $('#iAlbumBox').hidden = $('#iSec').value !== 'gallery'; };
  $('#iGo').onclick = async () => {
    const link = $('#iUrl').value.trim().replace(/#.*$/, '');
    if (!IMPORT_OK.test(link)) return toast('请粘贴公众号文章（mp.weixin.qq.com/s/…）、视频号（weixin.qq.com/sph/…）或学校新闻网的链接', true);
    const section = $('#iSec').value, album = section === 'gallery' ? readAlbumPicker('i') : {};
    if (!album) return;
    const btn = $('#iGo');
    busy = true; btn.disabled = true;
    try {
      const id = `${Date.now()}-${crypto.getRandomValues(new Uint32Array(1))[0].toString(16).slice(0, 4)}`;
      const req = { url: link, section, by: me.name, at: new Date().toISOString(), ...album };
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
      <div class="row" id="cLearn" hidden>${learnSelects('c')}</div>${albumPicker('c')}
      <label>正文<textarea id="cText" rows="9" placeholder="直接输入文字，每按一次回车就是新的一段"></textarea></label>
      <p class="hint">想让照片或视频出现在正文某个位置：把光标放到那里，点缩略图下方的「插入正文」（会写入【图1】这样的标记）。同一行写两个标记会并排显示；没插入的照片视频会排在文末。</p>
      <div class="media">
        <div class="media-head"><b>照片</b><span class="hint" id="hintPhoto"></span><label class="btn">＋ 添加照片<input id="cPhotos" type="file" accept="image/*" multiple hidden></label></div>
        <div class="thumbs" id="tPhotos"></div>
      </div>
      <div class="media">
        <div class="media-head"><b>视频</b><span class="hint" id="hintVideo"></span><label class="btn">＋ 添加视频<input id="cVideos" type="file" accept="video/*" multiple hidden></label></div>
        <div class="thumbs" id="tVideos"></div>
        <div id="cSphBox" class="sph-only" hidden>
          <label>没有视频文件、视频只发在视频号？贴它的视频号链接（选填）<input id="cSph" placeholder="https://weixin.qq.com/sph/..."></label>
          <p class="hint">在视频号里点「···」→「复制链接」。网站会生成一张卡片，点击跳到视频号观看。<br>上传了视频文件的，链接框会出现在每个视频缩略图下面，各填各的。</p>
        </div>
        <div class="sph-ask" id="cSphAsk" hidden>📌 <span id="cSphAskWhat"></span><br>
          哪个视频<b>已经发在协会视频号</b>，就在它下面填上<b>它自己的</b>视频号链接，网页会在该视频下注明“高清原版在视频号”并附跳转。</div>
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
    const withSph = SPH_SECS.includes($('#cSec').value);
    $('#tVideos').innerHTML = draft.videos.map((f, i) => `<div class="thw${withSph ? ' thw-sph' : ''}"><div class="th vid"><video src="${f.preview}" muted preload="metadata"></video><button data-rm="videos:${i}">×</button><span>视频${i + 1} · ${(f.size / 1048576).toFixed(0)}MB</span></div><button class="ins" data-ins="videos:${i}">插入正文</button>${withSph ? `<input class="vsph" data-vs="${i}" value="${esc(f.sph || '')}" placeholder="视频号链接（选填）">` : ''}</div>`).join('');
    v.querySelectorAll('[data-vs]').forEach(el => el.oninput = () => { draft.videos[+el.dataset.vs].sph = el.value; });
    $('#cSphBox').hidden = !withSph || draft.videos.length > 0;
    const ask = $('#cSphAsk');
    if (ask) ask.hidden = !(SPH_SECS.includes($('#cSec').value) && draft.videos.length);
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
    // 排球课堂、风采相册加了视频：提醒会压缩（课堂还会加水印），并问有没有视频号链接
    if (k === 'videos' && SPH_SECS.includes($('#cSec').value)) {
      toast(($('#cSec').value === 'learn' ? '视频会压缩成高清并加水印' : '视频会压缩成高清') + '；已发在视频号的，请在该视频下面填上它的视频号链接');
      const empty = [...v.querySelectorAll('[data-vs]')].find(el => !el.value.trim());
      if (empty) empty.focus();
    }
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
  const hints = () => {
    const k = sec.value;
    $('#cLearn').hidden = k !== 'learn';
    $('#cAlbumBox').hidden = k !== 'gallery';
    $('#cSphAsk').hidden = !(SPH_SECS.includes(k) && draft.videos.length);
    $('#cSphAskWhat').innerHTML = k === 'learn' ? '排球课堂的视频会<b>压缩成高清并在画面右下角加上 BISTU-Volleyball 水印</b>。' : '风采相册的视频会<b>压缩成高清</b>（1 分半以上的改为 720p）。';
    $('#hintPhoto').textContent = ORIGINAL_PHOTO.includes(k)
      ? '保留原图（点开照片看原图，网页上显示高清版）；第一张作为封面'
      : '自动缩小到适合网页的大小；第一张作为封面';
    $('#hintVideo').textContent = k === 'learn'
      ? '高清（1080p）并自动加 BISTU-Volleyball 水印；一个动作一段；1 分半以上自动改 720p，最长约 3 分 50 秒'
      : HQ_VIDEO.includes(k) ? '高清（1080p），符合条件的原片直接使用；1 分半以上自动改 720p，最长约 3 分 50 秒' : '自动压缩；建议 1 分钟以内';
  };
  sec.onchange = () => { hints(); drawThumbs(); };
  bindAlbumPicker('c');
  hints();
  drawThumbs();
  $('#cSubmit').onclick = submit;
}

async function submit() {
  const title = $('#cTitle').value.trim(), text = $('#cText').value, date = $('#cDate').value, section = $('#cSec').value;
  if (!title) return toast('请填写标题', true);
  if (!text.trim() && !draft.photos.length && !draft.videos.length && !draft.files.length) return toast('正文、照片、视频、附件至少要有一样', true);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return toast('请选择日期', true);
  const BAD_SPH = '视频号链接不对：请在视频号里点「···」→「复制链接」后粘贴（weixin.qq.com/sph/…）';
  // 整篇的视频号链接：只在没有上传视频文件时用；上传了视频的，每个视频各自的链接记在 f.sph
  const sph = SPH_SECS.includes(section) && !draft.videos.length ? $('#cSph').value.trim().replace(/#.*$/, '') : '';
  if (sph && !SPH_OK.test(sph)) return toast(BAD_SPH, true);
  const vsph = draft.videos.map(f => SPH_SECS.includes(section) ? (f.sph || '').trim().replace(/#.*$/, '') : '');
  const badV = vsph.findIndex(l => l && !SPH_OK.test(l));
  if (badV >= 0) return toast(`视频${badV + 1}的${BAD_SPH}`, true);
  const sameV = vsph.findIndex((l, i) => l && vsph.indexOf(l) < i);
  if (sameV >= 0) return toast(`视频${sameV + 1}和视频${vsph.indexOf(vsph[sameV]) + 1}填了同一个视频号链接，请检查`, true);
  const album = section === 'gallery' ? readAlbumPicker('c') : {};
  if (!album) return;
  if (SPH_SECS.includes(section) && sph && !draft.videos.length && !draft.photos.length) {
    // 只有视频号链接：走转载，自动取封面（标题用填写的）
    if (!confirm('只填了视频号链接、没有上传视频：将自动获取视频号的封面，在网站上生成跳转视频号的卡片。继续吗？')) return;
    return submitChannelsOnly(sph, title, section, album);
  }
  const noLink = vsph.map((l, i) => l ? 0 : i + 1).filter(Boolean);
  if (section === 'learn' && noLink.length &&
      !confirm(`视频${noLink.join('、')}没有填写视频号链接。\n\n如果已经发在协会视频号，建议在该视频下面附上链接：网页会注明“高清原版在视频号”并提供跳转。\n\n点「确定」直接提交，点「取消」返回填写。`)) return root.querySelector(`[data-vs="${noLink[0] - 1}"]`)?.focus();
  const btn = $('#cSubmit'), status = $('#cStatus');
  const step = s => { status.textContent = s; };
  busy = true; btn.disabled = true;
  window.onbeforeunload = () => '正在提交，离开会中断';
  try {
    const slug = `${date}-${crypto.getRandomValues(new Uint32Array(1))[0].toString(16).padStart(8, '0').slice(0, 6)}`;
    const dir = `assets/posts/${slug}`;
    const files = [], images = [], originals = [], ratios = [], videos = [], attachments = [];
    const keepOrig = ORIGINAL_PHOTO.includes(section), quality = HQ_VIDEO.includes(section) ? 'high' : 'standard';
    for (const [i, f] of draft.photos.entries()) {
      step(`处理照片 ${i + 1}/${draft.photos.length}`);
      const path = `${dir}/p${i + 1}.jpg`;
      if (keepOrig) {
        const { blob, ratio, original, ext } = await keepOriginal(f);
        const opath = `${dir}/p${i + 1}-orig.${ext}`;
        files.push({ path, blob }, { path: opath, blob: original });
        images.push('/' + path); originals.push('/' + opath); ratios.push(ratio);
      } else {
        const { blob, ratio } = await shrinkImage(f);
        files.push({ path, blob });
        images.push('/' + path); ratios.push(ratio);
      }
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
          const label = `${quality === 'high' ? '高清' : ''}${wm ? '处理并加水印' : '压缩'}`;
          step(`${label}${tag}…`);
          blob = (await media.compress(f, p => step(`${label}${tag}：${Math.round(p * 100)}%`), wm, quality).catch(e => { throw new Error(`「${f.name}」${e.message}`); })).blob;
        } else if (wm) throw new Error('排球课堂的视频要在浏览器里加水印，这个浏览器不支持，请换用电脑上最新版的 Chrome 或 Edge');
        else if (/\.mp4$/i.test(f.name) && f.size <= 20 * 1048576) blob = f;
        else throw new Error('这个浏览器不能压缩视频，请换用电脑上最新版的 Chrome 或 Edge');
        const lim = MAX_MB[quality];
        if (blob.size > lim * 1048576) throw new Error(`「${f.name}」处理后仍超过 ${lim}MB，请剪短一些（${quality === 'high' ? '高清视频最长约 3 分 50 秒，更长的请发视频号后在视频区贴链接' : '建议 1 分钟以内'}）`);
        const path = `${dir}/v${i + 1}.mp4`;
        files.push({ path, blob });
        const v = { src: '/' + path };
        if (duration) v.duration = duration;
        if (vsph[i]) v.channels = normSph(vsph[i]);
        const cover = await media.poster(blob, quality === 'high' ? 1280 : 640).catch(() => null);
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
    if (sph) learn.channels = normSph(sph);
    const post = { title, date, section, ...album, text, author: me.name, cover: images[0] || videos[0]?.poster, images, originals: keepOrig ? originals : undefined, ratios, videos, attachments, ...learn, submitted: new Date().toISOString() };
    files.push({ path: `_pending/${slug}.md`, text: buildPost(post) });
    await commitFiles(cfg(), files, `投稿：${title}（${me.name}）`, step);
    [...draft.photos, ...draft.videos].forEach(f => URL.revokeObjectURL(f.preview));
    draft.photos = []; draft.videos = []; draft.files = [];
    if (album.album_name) albumCache = null;
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
      ${p.videos.map(v => `<div class="pvv"><video controls preload="none" src="${url(v.src)}" ${v.poster ? `poster="${url(v.poster)}"` : ''}></video>${v.channels ? `<a class="hint" href="${esc(v.channels)}" target="_blank">视频号：${esc(v.channels)}</a>` : ''}</div>`).join('')}
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
  let albums = [];
  try { [posts, queue, albums] = await Promise.all([loadPosts('_pending'), loadQueue(), isAdmin ? loadAlbums() : []]); } catch (e) { v.innerHTML = `<p class="err">读取失败：${esc(explain(e))}</p>`; return; }
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
        <div class="row eGallery"${p.section === 'gallery' ? '' : ' hidden'}><label>小相册<select class="eAlbum"><option value="">请选择小相册</option>${albums.map(a => `<option value="${esc(a.id)}"${a.id === p.album ? ' selected' : ''}>${esc(a.name)}</option>`).join('')}${p.album_name && !albums.some(a => a.id === p.album) ? `<option value="${esc(p.album)}" selected>新建：${esc(p.album_name)}</option>` : ''}</select></label></div>
        <div class="row eSphRow"${SPH_SECS.includes(p.section) && !p.videos.length ? '' : ' hidden'}><label>视频号链接（选填）<input class="eSph" value="${esc(p.channels || '')}" placeholder="https://weixin.qq.com/sph/..."></label></div>
        ${p.cover ? `<div class="cover-pick"><span>首页封面（卡片按这个范围截取）</span>
          <div class="cover-box"><img class="eCoverImg" src="${url(p.cover)}" style="object-position: 50% ${esc(p.cover_pos || '50%')}"></div>
          <select class="eCoverPos">${COVER_POS.map(([v, n]) => `<option value="${v}"${v === (p.cover_pos || '50%') ? ' selected' : ''}>${n}</option>`).join('')}</select></div>` : ''}
        <label>正文<textarea class="eText" rows="6">${esc(p.text)}</textarea></label>`
      : `<h3>${esc(p.title)}</h3><div class="meta">${esc(secName(p.section))}${p.album_name ? ` · 新建相册：${esc(p.album_name)}` : ''} · ${esc(p.date)}</div><div class="pv-text">${p.text.split('\n').map(s => `<p>${esc(s)}</p>`).join('')}</div>`}
      ${isAdmin ? '<div class="pv-media eMedia"></div>' + attachList(p.attachments) : preview(p)}
      ${isAdmin ? '<div class="actions"><button class="primary" data-act="ok">通过并发布</button><button class="danger" data-act="no">退回（删除）</button></div>' : ''}
    </div>`).join('');
  if (!isAdmin) return;
  list.querySelectorAll('.item').forEach(card => {
    const p = posts[+card.dataset.i];
    // 可删除单张照片：st 记录当前保留的照片，删掉的在发布时一并从仓库删除
    const st = { images: [...p.images], ratios: p.ratios && p.ratios.length === p.images.length ? [...p.ratios] : null,
      originals: p.originals && p.originals.length === p.images.length ? [...p.originals] : null, removed: [], cover: p.cover,
      vsph: p.videos.map(v => v.channels || '') };
    const drawMedia = () => {
      const box = card.querySelector('.eMedia');
      const withSph = SPH_SECS.includes(card.querySelector('.eSec').value);
      box.innerHTML = p.videos.map((v, k) => `<div class="pvv"><video controls preload="none" src="${url(v.src)}" ${v.poster ? `poster="${url(v.poster)}"` : ''}></video><input class="evSph" data-k="${k}" value="${esc(st.vsph[k])}" placeholder="视频${k + 1}的视频号链接（选填）"${withSph ? '' : ' hidden'}></div>`).join('') +
        st.images.map((im, k) => `<div class="pvi"><a href="${url(im)}" target="_blank"><img loading="lazy" src="${url(im)}"></a><span>图${k + 1}${im === st.cover ? ' · 封面' : ''}</span><button data-del="${k}" title="删除这张照片">×</button></div>`).join('');
      box.querySelectorAll('.evSph').forEach(el => el.oninput = () => { st.vsph[+el.dataset.k] = el.value; });
      box.querySelectorAll('[data-del]').forEach(b => b.onclick = () => {
        const k = +b.dataset.del;
        const [gone] = st.images.splice(k, 1);
        if (st.ratios) st.ratios.splice(k, 1);
        st.removed.push(gone);
        if (st.originals) st.removed.push(...st.originals.splice(k, 1));
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
    secSel.addEventListener('change', () => {
      card.querySelector('.eLearn').hidden = secSel.value !== 'learn';
      card.querySelector('.eGallery').hidden = secSel.value !== 'gallery';
      card.querySelector('.eSphRow').hidden = !SPH_SECS.includes(secSel.value) || p.videos.length > 0;
      card.querySelectorAll('.evSph').forEach(el => { el.hidden = !SPH_SECS.includes(secSel.value); });
    });
    const sel = card.querySelector('.eCoverPos');
    if (sel) sel.onchange = () => { card.querySelector('.eCoverImg').style.objectPosition = `50% ${sel.value}`; };
    card.querySelector('[data-act="ok"]').onclick = () => act(card, async () => {
      const pos = card.querySelector('.eCoverPos')?.value;
      const q = { ...p, title: card.querySelector('.eTitle').value.trim(), section: card.querySelector('.eSec').value, date: card.querySelector('.eDate').value, text: card.querySelector('.eText').value, cover_pos: pos && pos !== '50%' ? pos : undefined, approved_by: me.name,
        images: st.images, originals: st.originals || undefined, ratios: st.ratios || undefined, cover: st.cover || undefined };
      if (q.section === 'learn') { q.topic = card.querySelector('.eTopic').value; q.level = card.querySelector('.eLevel').value; }
      else { delete q.topic; delete q.level; }
      if (SPH_SECS.includes(q.section)) {
        if (p.videos.length) {
          // 每个视频各自的视频号链接
          q.videos = p.videos.map((v, k) => {
            const sl = st.vsph[k].trim().replace(/#.*$/, '');
            if (sl && !SPH_OK.test(sl)) throw new Error(`视频${k + 1}的视频号链接不对，请重新复制（weixin.qq.com/sph/…）`);
            const { channels, ...rest } = v;
            return sl ? { ...rest, channels: normSph(sl) } : rest;
          });
        } else {
          const sl = card.querySelector('.eSph').value.trim();
          if (sl && !SPH_OK.test(sl)) throw new Error('视频号链接不对，请重新复制（weixin.qq.com/sph/…）');
          q.channels = sl ? normSph(sl) : undefined;
        }
      }
      if (!q.title || !/^\d{4}-\d{2}-\d{2}$/.test(q.date)) throw new Error('标题和日期不能为空');
      // 风采相册：投稿时新建的小相册，在这里正式加进 albums.json 并建好相册页面（同名的并入已有相册）
      const extra = [];
      if (q.section === 'gallery') {
        q.album = card.querySelector('.eAlbum').value;
        if (!q.album) throw new Error('请选择小相册');
        const fresh = await loadAlbums();
        if (!fresh.some(a => a.id === q.album)) {
          if (q.album !== p.album || !p.album_name) throw new Error('这个小相册已不存在，请重新选择');
          const same = fresh.find(a => a.name === p.album_name);
          if (same) q.album = same.id;
          else { const a = { id: q.album, name: p.album_name }; extra.push(albumsFile([a, ...fresh]), albumPage(a)); }
        }
      } else delete q.album;
      delete q.album_name;
      await commitFiles(cfg(), [{ path: `_posts/${p.slug}.md`, text: buildPost(q) }, { path: p.path, del: true }, ...st.removed.map(f => ({ path: f.replace(/^\//, ''), del: true })), ...extra], `发布：${q.title}（审核：${me.name}）`);
      albumCache = null;
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
  let posts, albums;
  try { [posts, albums] = await Promise.all([loadPosts('_posts'), loadAlbums()]); } catch (e) { v.innerHTML = `<p class="err">读取失败：${esc(explain(e))}</p>`; return; }
  const albumName = id => (albums.find(a => a.id === id) || {}).name;
  const trash = `<div class="panel"><h3>🗑️ 最近删除 <span class="hint">误删、误退回的文章可以在这里一键恢复</span></h3><div id="trash"><button id="trashLoad">查看最近删除的内容</button></div></div>`;
  if (!posts.length) { v.innerHTML = '<p class="empty">还没有已发布的内容。</p>' + trash; $('#trashLoad').onclick = () => renderTrash($('#trash')); return; }
  v.innerHTML = `<div class="panel" id="albPanel"></div><p class="hint">要修改已发布的文章（包括换小相册）：先「撤回到待审核」，在「审核」里改好再发布。</p>` + posts.map((p, i) => `
    <div class="panel item row-item" data-i="${i}">
      <div class="ri-main">
        <a href="${postUrl(p)}" target="_blank"><b>${esc(p.title)}</b></a>
        <div class="meta">${esc(secName(p.section))}${p.album && albumName(p.album) ? ` › ${esc(albumName(p.album))}` : ''} · ${esc(p.date)} · ${esc(p.author || '')}${p.approved_by ? ` · 审核 ${esc(p.approved_by)}` : ''}</div>
      </div>
      <div class="actions"><button data-act="back">撤回到待审核</button><button class="danger" data-act="del">删除</button></div>
    </div>`).join('') + trash;
  $('#trashLoad').onclick = () => renderTrash($('#trash'));
  drawAlbums($('#albPanel'), albums, posts);
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

// 小相册管理：改名、调顺序、新建、删除空相册，一次保存（albums.json + 各相册页面）
function drawAlbums(box, albums, posts) {
  const list = albums.map(a => ({ ...a, was: a.name }));
  const count = id => posts.filter(p => p.album === id).length;
  const draw = () => {
    box.innerHTML = `<h3>📁 风采相册的小相册 <span class="hint">投稿到风采相册时从这里选；排在前面的在网站上显示在前面</span></h3>
      ${list.map((a, k) => `<div class="row alb-row" data-k="${k}">
        <label>名称<input class="aName" maxlength="30" value="${esc(a.name)}"></label>
        <span class="hint alb-n">${a.id ? `${count(a.id)} 篇` : '新建'}</span>
        ${k ? '<button data-a="up" title="前移">↑ 前移</button>' : ''}
        <button class="danger" data-a="del"${a.id && count(a.id) ? ' disabled title="相册里还有内容，不能删除"' : ''}>删除</button>
      </div>`).join('') || '<p class="hint">还没有小相册。</p>'}
      <div class="actions"><button data-a="add">＋ 新建小相册</button><button class="primary" data-a="save">保存小相册</button></div>`;
    box.querySelectorAll('.aName').forEach((el, k) => el.oninput = () => { list[k].name = el.value; });
    box.querySelectorAll('.alb-row').forEach(row => {
      const k = +row.dataset.k;
      const b = n => row.querySelector(`[data-a="${n}"]`);
      if (b('up')) b('up').onclick = () => { [list[k - 1], list[k]] = [list[k], list[k - 1]]; draw(); };
      b('del').onclick = () => { if (confirm(`删除小相册「${list[k].name}」？`)) { list.splice(k, 1); draw(); } };
    });
    box.querySelector('[data-a="add"]').onclick = () => { list.unshift({ id: '', name: '' }); draw(); box.querySelector('.aName').focus(); };
    box.querySelector('[data-a="save"]').onclick = () => act(box, async () => {
      const names = list.map(a => a.name.trim());
      if (names.some(n => !n)) throw new Error('相册名称不能为空');
      if (new Set(names).size < names.length) throw new Error('有两个相册同名');
      const fresh = await loadAlbums();
      if (JSON.stringify(fresh) !== JSON.stringify(albums)) throw new Error('小相册刚被别人改过（可能有投稿新建了相册），请刷新后再改');
      const out = list.map((a, k) => ({ id: a.id || newAlbumId() + k, name: names[k], was: a.was }));
      const files = [albumsFile(out), ...out.filter(a => a.name !== a.was).map(albumPage),
        ...albums.filter(a => !out.some(o => o.id === a.id)).map(a => ({ path: `gallery/${a.id}/index.html`, del: true }))];
      await commitFiles(cfg(), files, `更新小相册（${me.name}）`);
      albumCache = null;
      return '已保存，约 1 分钟后生效';
    });
  };
  draw();
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
      const msg = c.commit.message.split('\n')[0];
      return { sha: c.sha, msg, title: msg.replace(/^(删除|退回)：/, '').replace(/（[^（）]*）$/, ''), when: c.commit.author.date, files: (d.files || []).filter(f => f.status === 'removed').map(f => ({ path: f.filename, sha: f.sha })) };
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
    if (!confirm(`恢复「${x.title}」？会放回${where}。`)) return;
    act(b.closest('.trash-item'), async () => {
      await commitFiles(cfg(), x.files.map(f => ({ path: f.path, sha: f.sha })), `恢复：${x.title}（${me.name}）`);
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
      <h3>网站容量</h3>
      <p id="capStatus" class="hint">读取中…</p>
      <p class="hint">GitHub 建议整个网站不超过 1GB，高清视频最占空间；接近上限时请把较长的视频改发 B 站。</p>
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
  (async () => {
    // 统计当前网站里所有文件的大小（不含历史版本），按类型分开
    try {
      const t = await gh('/git/trees/main?recursive=1');
      let total = 0, video = 0, photo = 0;
      for (const f of t.tree) if (f.type === 'blob') {
        total += f.size;
        if (/\.(mp4|mov|webm)$/i.test(f.path)) video += f.size;
        else if (/\.(jpe?g|png|webp|gif)$/i.test(f.path)) photo += f.size;
      }
      const mb = n => (n / 1048576).toFixed(0) + 'MB', pct = Math.round(total / 1073741824 * 100);
      $('#capStatus').innerHTML = `已用 <b>${mb(total)}</b> / 1GB（${pct}%）　其中视频 ${mb(video)}、照片 ${mb(photo)}` +
        (pct >= 70 ? '<br><b style="color:var(--bad)">已超过 70%，新视频请尽量改发 B 站。</b>' : '');
    } catch (e) { $('#capStatus').textContent = '读取失败：' + explain(e); }
  })();
  $('#bRebuild').onclick = async () => {
    try { await gh('/pages/builds', { method: 'POST' }); toast('已开始重新构建'); setTimeout(loadBuild, 3000); }
    catch (e) { toast('失败：' + explain(e), true); }
  };
}

(async () => {
  if (me && !(await verify())) return;
  render();
})();
