// 比赛赛程与比分：数据在 _data/games2026.json（发布助手「🏆 比分」里修改）
// 计算（胜负、C 值、Z 值、小组排名、淘汰赛对阵）全在这里，网站页面、首页「今日比赛」和发布助手共用
// 对阵里的队伍写法：A1 = 小组签位；C#1 = C 组第一（小组赛全部打完才确定）；E#W / E#L = E 组那场的胜者 / 负者
(function (g) {
  const STAGE = { group: '小组赛', cross: '交叉赛', semi: '半决赛', final: '决赛' };
  const WEEK = '日一二三四五六';

  // 一场的结果：有小分（sets）按小分算局分；否则用直接填的局分 sa:sb
  function result(m) {
    const sets = (m.sets || []).filter(s => s && s.length === 2 && s[0] !== s[1]);
    if (sets.length) {
      const sa = sets.filter(s => s[0] > s[1]).length, sb = sets.length - sa;
      return { done: sa === 2 || sb === 2, sa, sb, sets, pa: sets.reduce((t, s) => t + s[0], 0), pb: sets.reduce((t, s) => t + s[1], 0) };
    }
    if (m.sa == null || m.sb == null) return { done: false, sets: [] };
    return { done: m.sa === 2 || m.sb === 2, sa: m.sa, sb: m.sb, sets: [], pa: null, pb: null };
  }

  const ratio = (x, y) => y ? x / y : (x ? Infinity : 0);

  // 小组积分榜（按竞赛规则）：胜场 → 比赛积分（2:0 胜 3 负 0，2:1 胜 2 负 1）→ C 值 → Z 值
  function standings(G, grp) {
    const ids = G.groups[grp], ms = G.matches.filter(m => m.stage === 'group' && ids.includes(m.a));
    const rows = ids.map(id => ({ id, name: G.teams[id], p: 0, w: 0, l: 0, pts: 0, sw: 0, sl: 0, pf: 0, pa: 0, ptsOk: true }));
    const R = Object.fromEntries(rows.map(r => [r.id, r]));
    for (const m of ms) {
      const r = result(m);
      if (!r.done) continue;
      for (const [me, op, mine, theirs, pm, po] of [[m.a, m.b, r.sa, r.sb, r.pa, r.pb], [m.b, m.a, r.sb, r.sa, r.pb, r.pa]]) {
        const t = R[me];
        t.p++; t.sw += mine; t.sl += theirs;
        if (mine > theirs) t.w++; else t.l++;
        t.pts += mine === 2 ? (theirs === 0 ? 3 : 2) : (mine === 1 ? 1 : 0);
        if (pm == null) t.ptsOk = false; else { t.pf += pm; t.pa += po; }
      }
    }
    for (const t of rows) { t.c = ratio(t.sw, t.sl); t.z = t.ptsOk && t.p ? ratio(t.pf, t.pa) : null; }
    rows.sort((x, y) => (y.w - x.w) || (y.pts - x.pts) || (y.c - x.c) || ((y.z ?? 0) - (x.z ?? 0)) || x.id.localeCompare(y.id));
    const complete = ms.length > 0 && ms.every(m => result(m).done);
    return { rows, complete };
  }

  // 把对阵里的写法换成队伍：{ id, name } 或还没确定时 { name: 'C组第一', tbd: true }
  function team(G, ref) {
    if (G.teams[ref]) return { id: ref, name: G.teams[ref] };
    let m = ref.match(/^([A-D])#(\d)$/);
    if (m) {
      const s = standings(G, m[1]);
      return s.complete ? team(G, s.rows[+m[2] - 1].id) : { name: `${m[1]}组第${'一二三四'[+m[2] - 1]}`, tbd: true };
    }
    m = ref.match(/^(\w+)#([WL])$/);
    if (m) {
      const src = G.matches.find(x => x.id === m[1]), r = src && result(src);
      const label = src ? (src.label || src.id) : m[1];
      if (!r || !r.done) return { name: `${label}${m[2] === 'W' ? '胜' : '负'}`, tbd: true };
      const aWon = r.sa > r.sb;
      return team(G, (m[2] === 'W') === aWon ? src.a : src.b);
    }
    return { name: ref, tbd: true };
  }

  const bjToday = () => new Date(Date.now() + 8 * 3600e3).toISOString().slice(0, 10);
  const dayLabel = d => { const t = new Date(d + 'T00:00:00Z'); return `${+d.slice(5, 7)}月${+d.slice(8, 10)}日（周${WEEK[t.getUTCDay()]}）`; };
  const stageName = m => m.stage === 'group' ? `${m.a[0]}组` : (m.label || STAGE[m.stage] || '');
  const fmt = x => x == null ? '—' : x === Infinity ? '∞' : x.toFixed(2);
  const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

  // ---------- 网页渲染 ----------
  function matchCard(G, m, today) {
    const r = result(m), A = team(G, m.a), B = team(G, m.b);
    const win = r.done ? (r.sa > r.sb ? 'a' : 'b') : '';
    const side = (t, k) => `<div class="gm-team gm-${k}${win === k ? ' win' : ''}${t.tbd ? ' tbd' : ''}">${t.id && m.stage === 'group' ? `<i>${t.id}</i>` : ''}${esc(t.name)}</div>`;
    return `<div class="gm${m.date === today ? ' today' : ''}${r.done ? ' done' : ''}">
      <div class="gm-meta"><span class="gm-stage gm-${m.stage}">${esc(stageName(m))}</span>${esc(m.time)}${m.court ? ` · ${esc(m.court)}` : ''}</div>
      <div class="gm-body">${side(A, 'a')}<div class="gm-score">${r.done || r.sa != null ? `<b>${r.sa}</b><em>:</em><b>${r.sb}</b>` : '<span>VS</span>'}</div>${side(B, 'b')}</div>
      ${r.sets.length ? `<div class="gm-sets">${r.sets.map((s, i) => `<span>第${i + 1}局 ${s[0]}:${s[1]}</span>`).join('')}</div>` : ''}
    </div>`;
  }

  function scheduleHTML(G, opts = {}) {
    const today = bjToday(), days = [...new Set([...G.matches.map(m => m.date), ...(G.events || []).map(e => e.date)])].sort();
    return days.map(d => {
      const items = [...G.matches.filter(m => m.date === d).map(m => ({ t: m.time, h: matchCard(G, m, today) })),
        ...(G.events || []).filter(e => e.date === d).map(e => ({ t: e.time, h: `<div class="gm gm-event"><div class="gm-meta">${esc(e.time)}</div><b>🎉 ${esc(e.name)}</b></div>` }))]
        .sort((x, y) => x.t.localeCompare(y.t));
      return `<div class="gday${d === today ? ' today' : ''}${d < today ? ' past' : ''}" id="d${d}"><h3>${dayLabel(d)}${d === today ? '<span class="gday-tag">今天</span>' : ''}</h3><div class="gday-list">${items.map(x => x.h).join('')}</div></div>`;
    }).join('');
  }

  function standingsHTML(G) {
    return Object.keys(G.groups).map(grp => {
      const { rows, complete } = standings(G, grp);
      return `<div class="gtable"><h3>${grp} 组${complete ? '<span class="gday-tag done">已结束</span>' : ''}</h3>
        <table><thead><tr><th>名次</th><th class="l">队伍</th><th>场</th><th>胜</th><th>负</th><th>积分</th><th>胜局/负局</th><th>C 值</th><th>得分/失分</th><th>Z 值</th></tr></thead><tbody>
        ${rows.map((t, i) => `<tr${complete && i < 2 ? ' class="adv"' : ''}><td>${i + 1}</td><td class="l"><i>${t.id}</i>${esc(t.name)}</td><td>${t.p}</td><td>${t.w}</td><td>${t.l}</td><td><b>${t.pts}</b></td><td>${t.sw}/${t.sl}</td><td>${t.p ? fmt(t.c) : '—'}</td><td>${t.ptsOk && t.p ? `${t.pf}/${t.pa}` : '—'}</td><td>${fmt(t.z)}</td></tr>`).join('')}
        </tbody></table></div>`;
    }).join('') + '<p class="gnote">名次依次比较：胜场数、比赛积分（2:0 胜队 3 分负队 0 分，2:1 胜队 2 分负队 1 分）、C 值、Z 值；小组前两名（绿色）进入交叉赛。“—”表示有场次只记录了局分、没有每局小分，暂时算不出。</p>';
  }

  function bracketHTML(G) {
    const today = bjToday(), col = (title, ids) => `<div class="gcol"><h3>${title}</h3>${ids.map(id => G.matches.find(m => m.id === id)).filter(Boolean).map(m => matchCard(G, m, today)).join('')}</div>`;
    return `<div class="gbracket">${col('交叉赛', ['E', 'F', 'G', 'H'])}${col('半决赛', ['I', 'J'])}${col('决赛', ['final', 'third'])}</div>`;
  }

  // 首页「今日比赛」：今天有比赛显示今天，否则显示下一个比赛日；全部结束后显示决赛
  function homeHTML(G, url) {
    const today = bjToday(), days = [...new Set(G.matches.map(m => m.date))].sort();
    const d = days.find(x => x >= today) || days[days.length - 1];
    const ms = G.matches.filter(m => m.date === d);
    return `<div class="ghome-head"><b>${d === today ? '今日比赛' : d > today ? '下一比赛日' : '最后一个比赛日'}</b><span>${dayLabel(d)}</span><a href="${url}#schedule">全部赛程 ›</a></div>
      <div class="ghome-list">${ms.map(m => matchCard(G, m, today)).join('')}</div>`;
  }

  g.GamesCore = { result, standings, team, stageName, dayLabel, bjToday, scheduleHTML, standingsHTML, bracketHTML, homeHTML };

  // 页面上有对应容器就渲染
  if (typeof document !== 'undefined' && g.GAMES) {
    const G = g.GAMES, put = (id, f) => { const el = document.getElementById(id); if (el) el.innerHTML = f(); };
    put('g-schedule', () => scheduleHTML(G));
    put('g-standings', () => standingsHTML(G));
    put('g-bracket', () => bracketHTML(G));
    const home = document.getElementById('g-home');
    if (home) home.innerHTML = homeHTML(G, home.dataset.url);
  }
})(globalThis);
