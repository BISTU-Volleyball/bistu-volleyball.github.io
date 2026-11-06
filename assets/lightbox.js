// 文章页看大图：点照片在本页弹出浏览层（不新开网页，微信里不会每张都弹风险提示）
// 左右滑动 / 方向键切换，× / Esc / 手机返回键关闭；有原图的可点「查看原图」在浏览层里加载
// 照片链接写法不变：<a href="原图"><img src="网页显示版"></a>；没开 JS 时照旧打开原图
(function () {
  var links = [].slice.call(document.querySelectorAll('article.post a[href]')).filter(function (a) {
    var img = a.querySelector('img');
    return img && a.children.length === 1 && /\.(jpe?g|png|webp|gif)(\?|$)/i.test(a.getAttribute('href'));
  });
  if (!links.length) return;
  var items = links.map(function (a) { return { show: a.querySelector('img').currentSrc || a.querySelector('img').src, full: a.href }; });

  var box = document.createElement('div');
  box.className = 'lb';
  box.hidden = true;
  box.innerHTML = '<div class="lb-stage"><img class="lb-img" alt=""><div class="lb-load">加载中…</div></div>' +
    '<button class="lb-btn lb-close" type="button" aria-label="关闭">×</button>' +
    '<button class="lb-btn lb-prev" type="button" aria-label="上一张">‹</button>' +
    '<button class="lb-btn lb-next" type="button" aria-label="下一张">›</button>' +
    '<div class="lb-bar"><span class="lb-n"></span><button class="lb-orig" type="button">查看原图</button><span class="lb-tip">长按图片可保存</span></div>';
  document.body.appendChild(box);
  var img = box.querySelector('.lb-img'), load = box.querySelector('.lb-load'), n = box.querySelector('.lb-n'), orig = box.querySelector('.lb-orig');
  var cur = 0, open = false;

  function show(i) {
    cur = (i + items.length) % items.length;
    var it = items[cur];
    load.hidden = false;
    img.onload = function () { load.hidden = true; };
    img.src = it.show;
    n.textContent = (cur + 1) + ' / ' + items.length;
    orig.hidden = it.full === it.show || it.full === new URL(it.show, location.href).href;
    orig.textContent = '查看原图';
    // 预先加载前后两张，切换更快
    [cur - 1, cur + 1].forEach(function (k) { var p = items[(k + items.length) % items.length]; new Image().src = p.show; });
  }
  function openAt(i) {
    open = true;
    box.hidden = false;
    document.documentElement.classList.add('lb-on');
    show(i);
    // 占一条浏览记录：手机上按返回键是关闭浏览层，而不是离开文章
    history.pushState({ lb: 1 }, '');
  }
  function close(fromPop) {
    if (!open) return;
    open = false;
    box.hidden = true;
    img.removeAttribute('src');
    document.documentElement.classList.remove('lb-on');
    if (!fromPop && history.state && history.state.lb) history.back();
  }

  links.forEach(function (a, i) {
    a.addEventListener('click', function (e) {
      if (e.ctrlKey || e.metaKey || e.shiftKey || e.button) return; // 电脑上 Ctrl/中键点击仍可新窗口打开原图
      e.preventDefault();
      openAt(i);
    });
  });
  box.querySelector('.lb-close').onclick = function () { close(); };
  box.querySelector('.lb-prev').onclick = function () { show(cur - 1); };
  box.querySelector('.lb-next').onclick = function () { show(cur + 1); };
  orig.onclick = function () {
    orig.textContent = '原图加载中…';
    load.hidden = false;
    img.onload = function () { load.hidden = true; orig.hidden = true; };
    img.src = items[cur].full;
  };
  box.addEventListener('click', function (e) { if (e.target === box || e.target.classList.contains('lb-stage')) close(); });
  window.addEventListener('popstate', function () { close(true); });
  document.addEventListener('keydown', function (e) {
    if (!open) return;
    if (e.key === 'Escape') close();
    else if (e.key === 'ArrowLeft') show(cur - 1);
    else if (e.key === 'ArrowRight') show(cur + 1);
  });
  // 手机左右滑动切换（双指缩放时不切换）
  var sx = 0, sy = 0, multi = false;
  box.addEventListener('touchstart', function (e) { multi = e.touches.length > 1; sx = e.touches[0].clientX; sy = e.touches[0].clientY; }, { passive: true });
  box.addEventListener('touchend', function (e) {
    if (multi || (window.visualViewport && visualViewport.scale > 1.05)) return;
    var t = e.changedTouches[0], dx = t.clientX - sx, dy = t.clientY - sy;
    if (Math.abs(dx) > 50 && Math.abs(dx) > Math.abs(dy) * 1.5) show(cur + (dx < 0 ? 1 : -1));
  }, { passive: true });
})();
