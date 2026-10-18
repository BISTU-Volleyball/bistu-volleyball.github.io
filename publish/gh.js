// 发布助手与 GitHub 的通信：带进度提示的一次性提交、上传测速、照片缩小

const toBase64 = blob => new Promise((ok, bad) => {
  const r = new FileReader();
  r.onload = () => ok(String(r.result).split(',')[1]);
  r.onerror = () => bad(new Error('读取文件失败'));
  r.readAsDataURL(blob);
});

// GitHub 单个请求超过约 60 秒会被拒（并误报 Bad credentials），所以慢网络下要换成可读的提示
const SLOW_MSG = '上传太慢被 GitHub 中断：这台电脑的网络到 GitHub 速度不够，请在「设置」里点「上传测速」看看，或换个网络再试';
export const ghClient = cfg => async (path, opts = {}) => {
  const t0 = Date.now();
  let res;
  try {
    // no-store：浏览器默认会缓存 GitHub 的 GET 结果约 60 秒，拿到旧版本号会导致提交失败
    res = await fetch(`https://api.github.com/repos/${cfg.repo}${path}`, {
      cache: 'no-store', ...opts,
      headers: { Authorization: 'Bearer ' + cfg.token, Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28', ...(opts.body ? { 'Content-Type': 'application/json' } : {}) },
    });
  } catch (e) { throw new Error('连不上 GitHub，请检查网络'); }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const e = new Error(res.status === 401 && Date.now() - t0 > 40000 ? SLOW_MSG : `GitHub：${data.message || res.status}`);
    e.status = res.status; throw e;
  }
  return data;
};

// 上传测速：传一个随机内容的 blob（不提交、不影响网站），按实际传输字节算速度
export async function speedTest(cfg, mb = 1) {
  const bytes = crypto.getRandomValues(new Uint8Array(65536));
  const parts = Array.from({ length: mb * 16 }, () => bytes.map(b => b ^ (Math.random() * 256)));
  const body = JSON.stringify({ content: await toBase64(new Blob(parts)), encoding: 'base64' });
  const t0 = performance.now();
  await ghClient(cfg)('/git/blobs', { method: 'POST', body });
  const secs = (performance.now() - t0) / 1000;
  return { secs, kbps: body.length / 1024 / secs };
}

// 把多个文件作为一次提交推到仓库（只触发一次 Pages 构建）。并发冲突时重试
// files 每项：{ path, blob } 二进制文件 / { path, text } 文本文件 / { path, del: true } 删除
export async function commitFiles(cfg, files, message, onStep) {
  const gh = ghClient(cfg);
  const items = [];
  const bins = files.filter(f => f.blob);
  for (const f of files) {
    if (f.del) items.push({ path: f.path, mode: '100644', type: 'blob', sha: null });
    else if (f.text !== undefined) items.push({ path: f.path, mode: '100644', type: 'blob', content: f.text });
    else {
      onStep && onStep(`上传文件 ${bins.indexOf(f) + 1}/${bins.length}`);
      const { sha } = await gh('/git/blobs', { method: 'POST', body: JSON.stringify({ content: await toBase64(f.blob), encoding: 'base64' }) });
      items.push({ path: f.path, mode: '100644', type: 'blob', sha });
    }
  }
  for (let attempt = 0; ; attempt++) {
    onStep && onStep('提交到仓库');
    const ref = await gh(`/git/ref/heads/${cfg.branch}`);
    const head = await gh(`/git/commits/${ref.object.sha}`);
    const tree = await gh('/git/trees', { method: 'POST', body: JSON.stringify({ base_tree: head.tree.sha, tree: items }) });
    const commit = await gh('/git/commits', { method: 'POST', body: JSON.stringify({ message, tree: tree.sha, parents: [ref.object.sha] }) });
    try {
      await gh(`/git/refs/heads/${cfg.branch}`, { method: 'PATCH', body: JSON.stringify({ sha: commit.sha }) });
      return commit.sha;
    } catch (e) {
      if (e.status === 422 && attempt < 3) continue; // 别人刚好也提交了，基于最新版本重来
      throw e;
    }
  }
}

// 照片：按 EXIF 方向摆正，长边缩到 1600 的 JPEG
export async function shrinkImage(file) {
  let bmp;
  try { bmp = await createImageBitmap(file, { imageOrientation: 'from-image' }); }
  catch (e) { throw new Error(`「${file.name}」读不出来：iPhone 的 HEIC 照片请先转成 JPG（通过微信发送一次即可）`); }
  const k = Math.min(1, 1600 / Math.max(bmp.width, bmp.height));
  const c = document.createElement('canvas');
  c.width = Math.round(bmp.width * k); c.height = Math.round(bmp.height * k);
  c.getContext('2d').drawImage(bmp, 0, 0, c.width, c.height);
  return new Promise(ok => c.toBlob(ok, 'image/jpeg', 0.85));
}
