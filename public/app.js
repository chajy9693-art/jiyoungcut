// jiyoungcut 프론트엔드 (빌드 없이 동작하는 단일 ES 모듈)
const $app = document.getElementById('app');
const $toast = document.getElementById('toast');
let config = { templates: {} };
let pollTimer = null;
let cleanup = null; // 현재 화면 정리 함수

const el = (html) => { const t = document.createElement('template'); t.innerHTML = html.trim(); return t.content.firstElementChild; };
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const fmt = (s) => { s = Math.max(0, s); const m = Math.floor(s / 60); return `${m}:${String(Math.floor(s % 60)).padStart(2, '0')}`; };
const fmtP = (s) => { s = Math.max(0, s); const m = Math.floor(s / 60); return `${m}:${(s % 60).toFixed(1).padStart(4, '0')}`; };
const parseT = (v) => { const m = String(v).trim().match(/^(?:(\d+):)?(\d+(?:\.\d+)?)$/); return m ? Number(m[1] || 0) * 60 + Number(m[2]) : NaN; };
const debounce = (fn, ms) => { let t; const d = (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); }; d.flush = () => { clearTimeout(t); }; return d; };

function toast(msg, isErr) {
  $toast.textContent = msg;
  $toast.className = 'toast' + (isErr ? ' err' : '');
  $toast.hidden = false;
  clearTimeout(toast.t);
  toast.t = setTimeout(() => ($toast.hidden = true), isErr ? 6000 : 2500);
}

async function api(path, opts = {}) {
  const res = await fetch(path, {
    ...opts,
    headers: opts.body && !(opts.body instanceof FormData) ? { 'Content-Type': 'application/json' } : undefined,
    body: opts.body && !(opts.body instanceof FormData) ? JSON.stringify(opts.body) : opts.body,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `요청 실패 (${res.status})`);
  return data;
}

function titleLines(t) {
  t = String(t || '').trim();
  if (!t) return [];
  if (t.includes('\n')) return t.split('\n').map((x) => x.trim()).filter(Boolean).slice(0, 2);
  if (t.length <= 14 || !t.includes(' ')) return [t];
  let best = -1;
  for (let i = 0; i < t.length; i++) if (t[i] === ' ' && (best < 0 || Math.abs(i - t.length / 2) < Math.abs(best - t.length / 2))) best = i;
  return [t.slice(0, best).trim(), t.slice(best + 1).trim()];
}

const PHONE_HTML = '<div class="vwrap"></div><div class="ov-title"></div><div class="ov-sub"></div><div class="ov-acc"></div>';

/** 템플릿(레이아웃/색/계정명)을 9:16 미리보기 박스에 반영 — 편집기와 템플릿 설정 화면이 공용 */
function paintPhone(phone, tpl, { title = [], sub = '' } = {}) {
  const framed = tpl.layout === 'framed';
  phone.classList.toggle('framed', framed);
  phone.style.background = framed ? tpl.bgColor : '#000';
  const t = phone.querySelector('.ov-title');
  t.style.fontSize = `${tpl.titleSize / 10.8}cqw`;
  t.style.color = tpl.titleColor1;
  t.innerHTML = !title.length ? '' : title.length === 1 ? esc(title[0]) : `${esc(title[0])}\n<b style="color:${esc(tpl.titleColor2)}">${esc(title[1])}</b>`;
  const s = phone.querySelector('.ov-sub');
  s.className = `ov-sub ${tpl.subStyle}`;
  s.innerHTML = sub ? `<span>${esc(sub)}</span>` : '';
  const a = phone.querySelector('.ov-acc');
  a.textContent = tpl.account || '';
  a.style.fontSize = `${tpl.accountSize / 10.8}cqw`;
  a.style.color = tpl.accountColor;
}

// ───────────────────────── 라우터 ─────────────────────────

async function route() {
  clearTimeout(pollTimer);
  cleanup?.(); cleanup = null;
  const h = location.hash.replace(/^#/, '') || '/';
  document.querySelectorAll('[data-nav]').forEach((a) => a.classList.toggle('active', (a.dataset.nav === 'new' && h === '/') || (a.dataset.nav === 'list' && h === '/projects') || (a.dataset.nav === 'tpl' && h === '/templates')));
  const m = h.match(/^\/p\/([a-f0-9]+)/);
  try {
    if (m) await projectPage(m[1]);
    else if (h === '/projects') await listPage();
    else if (h === '/templates') await templatesPage();
    else homePage();
  } catch (e) {
    $app.innerHTML = `<div class="page"><div class="err-box">${esc(e.message)}</div><a class="btn" href="#/">홈으로</a></div>`;
  }
}
window.addEventListener('hashchange', route);

async function init() {
  config = await api('/api/config').catch(() => config);
  const dot = (cls) => `<span class="dot ${cls}"></span>`;
  document.getElementById('ai-status').innerHTML = config.mock
    ? `<span class="chip">${dot('mid')}데모 모드 (MOCK_AI)</span>`
    : `<span class="chip">${dot(config.transcription ? 'on' : '')}음성 인식 (OpenAI)</span>
       <span class="chip">${dot(config.highlights ? 'on' : 'mid')}하이라이트 (Claude)</span>`;
  route();
}

// ───────────────────────── 홈 / 업로드 ─────────────────────────

function homePage() {
  $app.innerHTML = '';
  const page = el(`<div class="page">
    <h1>하이라이트 쇼츠 편집 프로젝트</h1>
    <p class="sub">롱폼을 올리면 AI가 바이럴 구간을 잡아 9:16 쇼츠로 만듭니다.</p>
    <div class="drop" id="drop"><div class="big">⬆</div><p><b>영상 파일을 끌어다 놓거나 클릭해서 선택</b></p><p>MP4 · MOV · MKV · WEBM · 최대 ${config.maxDurationMin || 180}분</p>
      <input type="file" id="file" accept="video/*,.mkv" hidden></div>
    <div id="up" hidden class="box" style="margin-top:16px"><div id="upname" style="margin-bottom:8px"></div><div class="progress"><i id="upbar"></i></div><div class="meta" style="margin-top:6px"><span id="uppct"></span></div></div>
    ${!config.transcription ? `<div class="err-box">OPENAI_API_KEY가 설정되지 않아 음성 인식을 할 수 없습니다. <code>.env</code>를 설정하거나 <code>MOCK_AI=1</code>로 데모 모드를 사용하세요. (README 참고)</div>` : ''}
    <h2>최근 프로젝트</h2><div id="recent" class="grid"></div></div>`);
  $app.append(page);
  const drop = page.querySelector('#drop');
  const input = page.querySelector('#file');
  drop.onclick = () => input.click();
  input.onchange = () => input.files[0] && upload(input.files[0]);
  drop.ondragover = (e) => { e.preventDefault(); drop.classList.add('over'); };
  drop.ondragleave = () => drop.classList.remove('over');
  drop.ondrop = (e) => { e.preventDefault(); drop.classList.remove('over'); e.dataTransfer.files[0] && upload(e.dataTransfer.files[0]); };
  loadCards(page.querySelector('#recent'), 6);

  function upload(file) {
    const up = page.querySelector('#up');
    up.hidden = false; drop.hidden = true;
    page.querySelector('#upname').textContent = file.name;
    const fd = new FormData();
    fd.append('video', file);
    const xhr = new XMLHttpRequest();
    xhr.open('POST', '/api/projects');
    xhr.upload.onprogress = (e) => {
      if (!e.lengthComputable) return;
      const pct = Math.round((e.loaded / e.total) * 100);
      page.querySelector('#upbar').style.width = pct + '%';
      page.querySelector('#uppct').textContent = pct < 100 ? `업로드 중 ${pct}%` : '영상 확인 중…';
    };
    xhr.onload = () => {
      const data = JSON.parse(xhr.responseText || '{}');
      if (xhr.status === 201) location.hash = `#/p/${data.id}`;
      else { toast(data.error || '업로드 실패', true); up.hidden = true; drop.hidden = false; input.value = ''; }
    };
    xhr.onerror = () => { toast('업로드 중 네트워크 오류가 발생했습니다.', true); up.hidden = true; drop.hidden = false; };
    xhr.send(fd);
  }
}

async function listPage() {
  $app.innerHTML = `<div class="page"><h1>내 프로젝트</h1><p class="sub">&nbsp;</p><div id="all" class="grid"></div></div>`;
  await loadCards($app.querySelector('#all'));
}

const STATUS = { uploaded: ['분석 대기', ''], analyzing: ['분석 중', 'warn'], ready: ['완료', 'ok'], error: ['오류', 'err'] };

async function loadCards(box, limit) {
  let list = await api('/api/projects');
  if (limit) list = list.slice(0, limit);
  if (!list.length) { box.outerHTML = '<p class="sub" style="text-align:left">아직 프로젝트가 없습니다.</p>'; return; }
  box.innerHTML = '';
  for (const p of list) {
    const [label, cls] = STATUS[p.status] || ['', ''];
    const c = el(`<a class="card" href="#/p/${p.id}">
      <div class="thumb" style="background-image:url(/media/${p.id}/thumb)"><span class="dur">${fmt(p.video.duration)}</span></div>
      <div class="body"><div class="name">${esc(p.name)}</div>
        <div class="meta"><span class="badge ${cls}">${label}</span><span>${p.clips.length ? `쇼츠 ${p.clips.length}개` : ''}</span></div>
        <div class="meta"><span>${new Date(p.createdAt).toLocaleDateString('ko-KR')}</span><button class="btn sm danger">삭제</button></div></div></a>`);
    c.querySelector('button').onclick = async (e) => {
      e.preventDefault(); e.stopPropagation();
      if (!confirm(`"${p.name}" 프로젝트를 삭제할까요? 원본과 결과 영상이 모두 삭제됩니다.`)) return;
      try { await api(`/api/projects/${p.id}`, { method: 'DELETE' }); c.remove(); } catch (err) { toast(err.message, true); }
    };
    box.append(c);
  }
}

// ───────────────────────── 프로젝트 ─────────────────────────

async function projectPage(id) {
  const p = await api(`/api/projects/${id}`);
  if (p.status === 'analyzing') return analyzingPage(p);
  const templates = await api('/api/templates');
  if (p.status === 'ready' && p.clips.length) return editorPage(p, templates);
  return setupPage(p, templates);
}

function setupPage(p, templates) {
  const hasErr = p.status === 'error' && p.error;
  $app.innerHTML = '';
  const page = el(`<div class="page"><a class="back" href="#/">← 프로젝트</a>
    <h1>${esc(p.name)}</h1><p class="sub">${fmt(p.video.duration)} · ${p.video.width}×${p.video.height}</p>
    ${hasErr ? `<div class="err-box">${esc(p.error)}</div>` : ''}
    <div class="box"><div class="row">
      <div class="field"><label>쇼츠 길이</label><select id="len">
        <option value="15-30">15~30초</option><option value="30-60" selected>30~60초</option><option value="60-90">60~90초</option><option value="45-120">45~120초</option></select></div>
      <div class="field"><label>후보 개수</label><select id="count"><option>3</option><option selected>5</option><option>8</option><option>10</option></select></div>
      <div class="field"><label>편집 방식</label><select id="mode"><option value="context" selected>맥락 편집 (후킹·군더더기 제거)</option><option value="single">단순 구간 (연속 한 구간)</option></select></div>
      <div class="field"><label>템플릿</label><select id="tplsel">${templates.map((t) => `<option value="${t.id}">${esc(t.name)}${t.account ? ' · ' + esc(t.account) : ''}</option>`).join('')}</select></div>
      <div class="field"><label>영상 언어</label><select id="lang"><option value="ko">한국어</option><option value="en">English</option><option value="ja">日本語</option><option value="auto">자동 감지</option></select></div>
      <button class="btn primary big" id="go" style="margin-left:auto">AI로 쇼츠 찾기 →</button></div></div></div>`);
  $app.append(page);
  page.querySelector('#go').onclick = async (e) => {
    e.target.disabled = true;
    const [minLen, maxLen] = page.querySelector('#len').value.split('-').map(Number);
    try {
      await api(`/api/projects/${p.id}/analyze`, { method: 'POST', body: { minLen, maxLen, count: +page.querySelector('#count').value, language: page.querySelector('#lang').value, templateId: page.querySelector('#tplsel').value, mode: page.querySelector('#mode').value } });
      route();
    } catch (err) { toast(err.message, true); e.target.disabled = false; }
  };
}

function analyzingPage(p) {
  $app.innerHTML = `<div class="page"><div class="box analyzing"><div class="spin"></div><h2 style="margin:0" id="msg"></h2>
    <div class="progress"><i id="bar"></i></div><div class="meta" style="justify-content:center">영상 길이에 따라 몇 분 걸릴 수 있습니다. 이 창을 닫아도 분석은 계속됩니다.</div></div></div>`;
  const tick = async () => {
    const q = await api(`/api/projects/${p.id}?subs=0`);
    if (q.status !== 'analyzing') return route();
    $app.querySelector('#msg').textContent = q.progress?.message || '분석 중';
    $app.querySelector('#bar').style.width = (q.progress?.pct || 0) + '%';
    pollTimer = setTimeout(tick, 1000);
  };
  tick();
}

// ───────────────────────── 에디터 ─────────────────────────

function editorPage(p, templates) {
  const S = { p, sel: p.clips[0].id, seg: 0, cur: 0, t: 0, playing: false };
  const clip = () => S.p.clips.find((c) => c.id === S.sel);
  const src = p.video.proxy ? `/media/${p.id}/proxy` : `/media/${p.id}/source`;
  const subsIn = (c) => S.p.subtitles.filter((s) => c.segments.some((g) => s.end > g.start && s.start < g.end));
  const segTotal = (c) => c.segments.reduce((n, g) => n + g.end - g.start, 0);
  const segOffset = (c, i) => c.segments.slice(0, i).reduce((n, g) => n + g.end - g.start, 0);
  const segIdxOf = (c, t) => c.segments.findIndex((g) => t >= g.start - 0.001 && t < g.end);
  const syncBounds = (c) => { c.start = Math.min(...c.segments.map((g) => g.start)); c.end = Math.max(...c.segments.map((g) => g.end)); };
  const outStart = (c, s) => { const i = c.segments.findIndex((g) => s.end > g.start && s.start < g.end); return i < 0 ? Infinity : segOffset(c, i) + Math.max(0, s.start - c.segments[i].start); };
  const ROLE = { hook: '후킹', body: '본론', ending: '마무리' };
  const tplOf = (c) => templates.find((t) => t.id === c.templateId) || templates[0];
  const videoW = () => (tplOf(clip()).layout === 'framed' ? aspect * 100 : aspect * (16 / 9) * 100);

  $app.innerHTML = '';
  const root = el(`<div class="editor">
    <div class="col left"><a class="back" href="#/">← 프로젝트</a><h3>AI 추천 쇼츠 <span class="meta" style="display:inline">(${p.clips.length})</span></h3>
      <div class="cliplist" id="list"></div>
      <div style="display:grid;gap:8px;margin-top:14px"><button class="btn" id="addclip">＋ 현재 위치에서 새 쇼츠 추가</button><button class="btn" id="reanalyze">다시 분석</button></div></div>
    <div class="col center">
      <div class="topbar"><span class="name">${esc(p.name)}</span></div>
      <div class="phone" id="phone"><video id="vid" src="${src}" preload="auto" playsinline></video></div>
      <div class="hint">미리보기를 좌우로 드래그해 크롭 위치를 조정하세요</div>
      <div class="transport"><button class="btn" id="play">▶ 재생</button><span id="time" class="meta"></span></div>
      <div class="timeline"><div class="tl" id="tl"></div><div class="tl-labels"><span id="tl0"></span><span id="tl1"></span></div>
        <div class="times"><div class="field"><label>선택 구간 시작</label><input type="text" id="tin"></div><div class="field"><label>선택 구간 종료</label><input type="text" id="tout"></div><div class="field"><label>선택 구간 길이</label><input type="text" id="tlen" disabled></div></div></div>
      <div class="segs" id="segs"></div>
    </div>
    <div class="col right" id="right"></div></div>`);
  $app.append(root);
  const $ = (s) => root.querySelector(s);
  const phone = $('#phone');
  const vidEl = $('#vid');
  phone.innerHTML = PHONE_HTML;
  phone.querySelector('.vwrap').append(vidEl);
  const vid = vidEl;
  const aspect = p.video.width / p.video.height;
  let win = [0, p.video.duration]; // 타임라인 표시 구간

  // ── 저장 (디바운스) ──
  const pending = new Map();
  async function reloadClips() {
    try {
      const q = await api(`/api/projects/${p.id}?subs=0`);
      for (const qc of q.clips) { const c = S.p.clips.find((x) => x.id === qc.id); if (c) Object.assign(c, qc); }
      S.seg = Math.min(S.seg, clip().segments.length - 1); S.cur = Math.min(S.cur, clip().segments.length - 1);
      computeWin(); renderAllCenter(); renderRight();
    } catch {}
  }
  const flushClip = debounce(async () => {
    for (const [id, patch] of [...pending]) {
      pending.delete(id);
      try { const c = await api(`/api/projects/${p.id}/clips/${id}`, { method: 'PATCH', body: patch }); Object.assign(S.p.clips.find((x) => x.id === id), c); }
      catch (e) { toast(e.message, true); await reloadClips(); }
    }
    renderList(); renderRender(); renderSegs();
  }, 500);
  function patchClip(patch) {
    const c = clip();
    Object.assign(c, patch);
    if (patch.segments) { syncBounds(c); patch = { segments: c.segments }; }
    if (c.render?.status === 'done') c.render.stale = true;
    pending.set(c.id, { ...(pending.get(c.id) || {}), ...patch });
    flushClip();
  }

  // ── 목록 ──
  function renderList() {
    const box = $('#list'); box.innerHTML = '';
    S.p.clips.forEach((c, i) => {
      const n = c.segments.length;
      const it = el(`<div class="clipitem ${c.id === S.sel ? 'sel' : ''}"><div class="meta"><span class="score">${c.score ? `★ ${c.score}` : '직접 추가'}</span><span>${Math.round(segTotal(c))}초${n > 1 ? ` · ${n}개 구간 편집` : ''}</span></div>
        <div class="t">${esc(c.title || `쇼츠 ${i + 1}`)}</div>${c.summary ? `<div class="meta flow">${esc(c.summary)}</div>` : c.reason ? `<div class="meta">${esc(c.reason)}</div>` : ''}
        ${c.render?.status === 'done' ? `<span class="badge ${c.render.stale ? 'warn' : 'ok'}">${c.render.stale ? '수정됨' : '렌더 완료'}</span>` : ''}</div>`);
      it.onclick = () => select(c.id);
      box.append(it);
    });
  }
  function select(id) { S.sel = id; S.seg = 0; S.cur = 0; renderList(); renderRight(); computeWin(); renderAllCenter(); seek(clip().segments[0].start); updatePreview(); }
  function renderAllCenter() { renderTimeline(); renderSegs(); }

  // ── 미리보기 ──
  function seek(t) { vid.currentTime = t; S.t = t; }
  function updatePreview() {
    const c = clip(); const tpl = tplOf(c);
    const W = videoW(); // 영상 폭 (phone 폭 = 100cqw)
    if (W > 100) { vid.style.width = `${W}cqw`; vid.style.left = `${-(W - 100) * c.cropX}cqw`; vid.style.objectFit = ''; }
    else { vid.style.width = '100%'; vid.style.left = '0'; vid.style.objectFit = 'cover'; }
    const s = c.subtitleOn ? subsIn(c).find((x) => S.t >= x.start && S.t < x.end) : null;
    paintPhone(phone, tpl, { title: c.titleOn ? titleLines(c.title) : [], sub: s?.text || '' });
    const idx = S.playing ? S.cur : Math.max(0, segIdxOf(c, S.t));
    const g = c.segments[idx];
    const out = segOffset(c, idx) + Math.min(Math.max(0, S.t - g.start), g.end - g.start);
    $('#time').textContent = `${fmtP(out)} / ${fmtP(segTotal(c))}`;
    root.querySelectorAll('.subrow').forEach((r) => r.classList.toggle('active', r.dataset.id === s?.id));
    root.querySelectorAll('.segrow').forEach((r) => r.classList.toggle('playing', S.playing && +r.dataset.i === S.cur));
    renderHead();
  }
  // 재생 중에는 구간 경계를 프레임 단위로 감시해 다음 구간으로 건너뛴다 (실제 렌더 결과와 같은 흐름)
  function loop() {
    if (!S.playing) return;
    const c = clip();
    S.t = vid.currentTime;
    const g = c.segments[S.cur];
    if (S.t >= g.end - 0.03 || S.t < g.start - 0.5) {
      S.cur = (S.cur + 1) % c.segments.length;
      seek(c.segments[S.cur].start);
    }
    updatePreview();
    requestAnimationFrame(loop);
  }
  vid.addEventListener('timeupdate', () => { if (!S.playing) { S.t = vid.currentTime; updatePreview(); } });
  vid.addEventListener('error', () => toast('브라우저에서 이 영상을 재생할 수 없습니다. 잠시 후 다시 시도하세요(미리보기 변환 중일 수 있음).', true));
  function stop() { vid.pause(); S.playing = false; $('#play').textContent = '▶ 재생'; }
  $('#play').onclick = () => {
    const c = clip();
    if (S.playing) { stop(); return; }
    const i = segIdxOf(c, S.t);
    if (i < 0) { S.cur = 0; seek(c.segments[0].start); } else S.cur = i;
    S.playing = true; vid.play(); $('#play').textContent = '⏸ 일시정지';
    requestAnimationFrame(loop);
  };

  // 크롭 드래그
  let drag = null;
  phone.addEventListener('pointerdown', (e) => { drag = { x: e.clientX, crop: clip().cropX }; phone.setPointerCapture(e.pointerId); });
  phone.addEventListener('pointermove', (e) => {
    if (!drag) return;
    const W = videoW();
    if (W <= 100) return;
    const px = (phone.clientWidth * (W - 100)) / 100;
    const c = clip();
    c.cropX = Math.min(1, Math.max(0, drag.crop - (e.clientX - drag.x) / px));
    updatePreview(); renderRight(true);
  });
  const endDrag = () => { if (drag) { drag = null; patchClip({ cropX: clip().cropX }); } };
  phone.addEventListener('pointerup', endDrag); phone.addEventListener('pointercancel', endDrag);

  // ── 타임라인 (선택한 구간 중심) ──
  const selSeg = () => clip().segments[S.seg];
  function computeWin() {
    const g = selSeg(); const len = g.end - g.start; const pad = Math.max(20, len * 0.8);
    win = [Math.max(0, g.start - pad), Math.min(p.video.duration, g.end + pad)];
  }
  const pos = (t) => ((t - win[0]) / (win[1] - win[0])) * 100;
  const block = (cls, a, b, extra = '') => { const l = pos(Math.max(a, win[0])); return `<div class="${cls}" style="left:${l}%;width:${pos(Math.min(b, win[1])) - l}%">${extra}</div>`; };
  function renderTimeline() {
    const c = clip(); const g = selSeg(); const tl = $('#tl');
    tl.innerHTML = '';
    for (const o of S.p.clips) if (o !== c) for (const og of o.segments) if (og.end > win[0] && og.start < win[1]) tl.insertAdjacentHTML('beforeend', block('other', og.start, og.end));
    c.segments.forEach((sg, i) => { if (i !== S.seg && sg.end > win[0] && sg.start < win[1]) tl.insertAdjacentHTML('beforeend', block('sib', sg.start, sg.end, `<i>${i + 1}</i>`)); });
    tl.insertAdjacentHTML('beforeend', block('sel', g.start, g.end, `<i>${S.seg + 1}</i>`));
    tl.insertAdjacentHTML('beforeend', `<div class="handle" data-h="start" style="left:${pos(g.start)}%"></div><div class="handle" data-h="end" style="left:${pos(g.end)}%"></div><div class="head" id="head"></div>`);
    $('#tl0').textContent = fmt(win[0]); $('#tl1').textContent = fmt(win[1]);
    $('#tin').value = fmtP(g.start); $('#tout').value = fmtP(g.end); $('#tlen').value = `${(g.end - g.start).toFixed(1)}초`;
    renderHead();
  }
  function renderHead() { const h = root.querySelector('#head'); if (h) h.style.left = `${Math.min(100, Math.max(0, pos(S.t)))}%`; }
  // 다른 구간과 겹치지 않는 범위
  function bounds(c, i) {
    const g = c.segments[i]; let lo = 0, hi = p.video.duration;
    c.segments.forEach((o, j) => { if (j === i) return; if (o.end <= g.start + 1e-6) lo = Math.max(lo, o.end); if (o.start >= g.end - 1e-6) hi = Math.min(hi, o.start); });
    return [lo, hi];
  }
  const tlEl = $('#tl');
  let th = null;
  tlEl.addEventListener('pointerdown', (e) => {
    const h = e.target.dataset?.h;
    if (!h) { const r = tlEl.getBoundingClientRect(); stop(); seek(win[0] + ((e.clientX - r.left) / r.width) * (win[1] - win[0])); return; }
    th = { h, lim: bounds(clip(), S.seg) }; tlEl.setPointerCapture(e.pointerId);
  });
  tlEl.addEventListener('pointermove', (e) => {
    if (!th) return;
    const r = tlEl.getBoundingClientRect(); const g = selSeg();
    let t = win[0] + (Math.min(1, Math.max(0, (e.clientX - r.left) / r.width))) * (win[1] - win[0]);
    t = Math.round(t * 10) / 10;
    if (th.h === 'start') g.start = Math.max(th.lim[0], Math.min(t, g.end - 1)); else g.end = Math.min(th.lim[1], Math.max(t, g.start + 1));
    syncBounds(clip()); renderTimeline(); updatePreview();
  });
  const endTl = () => {
    if (!th) return; const h = th.h; th = null; const c = clip(); const g = selSeg();
    stop(); patchClip({ segments: c.segments }); seek(h === 'start' ? g.start : Math.max(g.start, g.end - 2)); S.cur = S.seg; computeWin(); renderAllCenter(); renderRight();
  };
  tlEl.addEventListener('pointerup', endTl); tlEl.addEventListener('pointercancel', endTl);
  const timeInput = (id, key) => $(id).addEventListener('change', (e) => {
    const v = parseT(e.target.value); const c = clip(); const g = selSeg(); const [lo, hi] = bounds(c, S.seg);
    const ns = key === 'start' ? v : g.start, ne = key === 'end' ? v : g.end;
    if (!(ns >= lo && ne <= hi && ne - ns >= 1)) { toast(`올바른 시간을 입력하세요 (이 구간은 ${fmtP(lo)} ~ ${fmtP(hi)} 사이, 최소 1초). 예) 1:23.5`, true); renderTimeline(); return; }
    stop(); g.start = ns; g.end = ne; patchClip({ segments: c.segments }); computeWin(); renderAllCenter(); renderRight(); seek(ns); S.cur = S.seg;
  });
  timeInput('#tin', 'start'); timeInput('#tout', 'end');

  // ── 영상 구성 (이어 붙일 구간 목록) ──
  function excerpt(g) { const s = S.p.subtitles.find((x) => x.end > g.start && x.start < g.end && x.text); return s ? s.text : ''; }
  function renderSegs() {
    const c = clip(); const box = $('#segs'); const n = c.segments.length;
    box.innerHTML = `<div class="segs-head"><b>영상 구성</b><span class="meta">${n}개 구간 · 총 ${segTotal(c).toFixed(1)}초 · 위에서 아래 순서로 이어 붙여 재생됩니다</span><button class="btn sm" id="addseg">＋ 구간 추가</button></div>`;
    c.segments.forEach((g, i) => {
      const row = el(`<div class="segrow ${i === S.seg ? 'sel' : ''}" data-i="${i}">
        <span class="no">${i + 1}</span>
        <select class="role ${g.role || 'body'}">${Object.entries(ROLE).map(([k, v]) => `<option value="${k}" ${(g.role || 'body') === k ? 'selected' : ''}>${v}</option>`).join('')}</select>
        <span class="rng">${fmtP(g.start)}–${fmtP(g.end)} <em>${(g.end - g.start).toFixed(1)}초</em></span>
        <span class="ex">${esc(excerpt(g))}</span>
        <button class="x" data-a="up" title="위로" ${i === 0 ? 'disabled' : ''}>▲</button><button class="x" data-a="down" title="아래로" ${i === n - 1 ? 'disabled' : ''}>▼</button><button class="x" data-a="del" title="삭제" ${n === 1 ? 'disabled' : ''}>✕</button></div>`);
      row.onclick = (e) => {
        const a = e.target.dataset?.a;
        if (e.target.tagName === 'SELECT' || e.target.tagName === 'OPTION') return;
        if (a) {
          stop();
          if (a === 'del') { c.segments.splice(i, 1); S.seg = Math.min(S.seg, c.segments.length - 1); }
          else { const j = a === 'up' ? i - 1 : i + 1; [c.segments[i], c.segments[j]] = [c.segments[j], c.segments[i]]; S.seg = j; }
          S.cur = S.seg; patchClip({ segments: c.segments }); computeWin(); renderAllCenter(); renderRight(); seek(selSeg().start); updatePreview(); renderList();
          return;
        }
        stop(); S.seg = i; S.cur = i; computeWin(); renderAllCenter(); seek(g.start); updatePreview();
      };
      row.querySelector('select').onchange = (e) => { g.role = e.target.value; e.target.className = `role ${g.role}`; patchClip({ segments: c.segments }); };
      box.append(row);
    });
    $('#addseg').onclick = () => {
      stop();
      let start = Math.min(S.t, p.video.duration - 1);
      const inside = c.segments.find((g) => start >= g.start && start < g.end);
      if (inside) start = inside.end;
      let end = Math.min(p.video.duration, start + 8);
      for (const g of c.segments) if (g.start >= start && g.start < end) end = g.start;
      if (end - start < 1) { toast('현재 위치에 구간을 추가할 공간이 없습니다. 재생 위치를 옮겨 보세요.', true); return; }
      c.segments.push({ start: Math.round(start * 10) / 10, end: Math.round(end * 10) / 10, role: 'body' });
      S.seg = c.segments.length - 1; S.cur = S.seg;
      patchClip({ segments: c.segments }); computeWin(); renderAllCenter(); renderRight(); renderList(); seek(selSeg().start); updatePreview();
    };
  }

  // ── 오른쪽 패널 ──
  const subSave = { updates: new Map(), deletes: new Set() };
  const flushSubs = debounce(async () => {
    const body = { updates: [...subSave.updates].map(([id, text]) => ({ id, text })), deletes: [...subSave.deletes] };
    subSave.updates.clear(); subSave.deletes.clear();
    try { await api(`/api/projects/${p.id}/subtitles`, { method: 'PATCH', body }); renderList(); renderRender(); } catch (e) { toast(e.message, true); }
  }, 600);

  function renderRight(cropOnly) {
    const c = clip();
    if (cropOnly) { const r = root.querySelector('#crop'); if (r) r.value = Math.round(c.cropX * 100); return; }
    const r = $('#right');
    r.innerHTML = `
      <div class="sect"><h4>제목</h4>
        <div class="field"><textarea id="title" rows="2" placeholder="쇼츠 제목 (줄바꿈으로 2줄)">${esc(c.title)}</textarea></div>
        <label class="toggle"><span>제목 표시</span><input type="checkbox" id="titleOn" ${c.titleOn ? 'checked' : ''}></label></div>
      <div class="sect"><h4>화면 (9:16 크롭)</h4><div class="field"><label>크롭 위치 (왼쪽 ↔ 오른쪽)</label><input type="range" id="crop" min="0" max="100" value="${Math.round(c.cropX * 100)}"></div></div>
      <div class="sect"><h4>템플릿 <a href="#/templates" style="color:var(--accent);font-weight:400">편집 →</a></h4>
        <div class="field"><select id="tplsel">${templates.map((t) => `<option value="${t.id}" ${t.id === tplOf(c).id ? 'selected' : ''}>${esc(t.name)}${t.account ? ' · ' + esc(t.account) : ''}</option>`).join('')}</select></div>
        <div class="meta">계정명·배경색·제목/자막 스타일이 템플릿으로 적용됩니다.</div></div>
      <div class="sect"><h4>자막</h4>
        <label class="toggle"><span>자막 표시</span><input type="checkbox" id="subOn" ${c.subtitleOn ? 'checked' : ''}></label>
        <div class="subrows" id="subrows"></div><button class="btn sm" id="addsub">＋ 현재 위치에 자막 추가</button></div>
      <div class="sect"><h4>게시글 정보 <button class="btn sm" id="copy">복사</button></h4>
        <div class="field"><textarea id="desc" rows="3" placeholder="설명">${esc(c.description)}</textarea></div>
        <div class="field"><input type="text" id="tags" placeholder="해시태그 (공백으로 구분)" value="${esc(c.hashtags.map((h) => '#' + h).join(' '))}"></div></div>
      <div class="sect" id="renderbox"></div>
      <div class="sect"><button class="btn danger" id="del">이 쇼츠 삭제</button></div>`;
    const q = (s) => r.querySelector(s);
    q('#title').oninput = (e) => { patchClip({ title: e.target.value }); updatePreview(); };
    q('#titleOn').onchange = (e) => { patchClip({ titleOn: e.target.checked }); updatePreview(); };
    q('#crop').oninput = (e) => { clip().cropX = e.target.value / 100; updatePreview(); };
    q('#crop').onchange = () => patchClip({ cropX: clip().cropX });
    q('#subOn').onchange = (e) => { patchClip({ subtitleOn: e.target.checked }); updatePreview(); };
    q('#tplsel').onchange = (e) => { patchClip({ templateId: e.target.value }); updatePreview(); };
    q('#desc').oninput = (e) => patchClip({ description: e.target.value });
    q('#tags').onchange = (e) => patchClip({ hashtags: e.target.value.split(/[\s,]+/).map((h) => h.replace(/^#/, '')).filter(Boolean) });
    q('#copy').onclick = () => navigator.clipboard?.writeText(`${clip().title.replace(/\n/g, ' ')}\n\n${q('#desc').value}\n\n${q('#tags').value}`).then(() => toast('복사했습니다'));
    q('#del').onclick = async () => {
      if (!confirm('이 쇼츠를 삭제할까요?')) return;
      try { await api(`/api/projects/${p.id}/clips/${c.id}`, { method: 'DELETE' }); } catch (e) { return toast(e.message, true); }
      S.p.clips = S.p.clips.filter((x) => x.id !== c.id);
      if (!S.p.clips.length) return route();
      select(S.p.clips[0].id);
    };
    q('#addsub').onclick = async () => {
      const cg = c.segments[Math.max(0, segIdxOf(c, S.t))];
      const t = Math.min(Math.max(S.t, cg.start), cg.end - 0.5);
      try {
        const res = await api(`/api/projects/${p.id}/subtitles`, { method: 'PATCH', body: { adds: [{ start: t, end: Math.min(cg.end, t + 2), text: '새 자막' }] } });
        S.p.subtitles.push(...res.created); S.p.subtitles.sort((a, b) => a.start - b.start); renderSubRows(); updatePreview(); renderList(); renderRender();
      } catch (e) { toast(e.message, true); }
    };
    renderSubRows(); renderRender();
  }

  function renderSubRows() {
    const c = clip(); const box = root.querySelector('#subrows'); if (!box) return;
    const subs = subsIn(c).sort((x, y) => outStart(c, x) - outStart(c, y));
    box.innerHTML = subs.length ? '' : '<div class="meta">이 구간에는 자막이 없습니다.</div>';
    for (const s of subs) {
      const si = c.segments.findIndex((g) => s.end > g.start && s.start < g.end);
      const sg = c.segments[si];
      const row = el(`<div class="subrow" data-id="${s.id}"><span class="tm">${fmtP(outStart(c, s))}</span><input type="text" value="${esc(s.text)}"><button class="x" title="삭제">✕</button></div>`);
      row.querySelector('.tm').onclick = () => { stop(); S.cur = si; seek(Math.max(sg.start, s.start)); };
      row.querySelector('input').oninput = (e) => { s.text = e.target.value; subSave.updates.set(s.id, s.text); flushSubs(); updatePreview(); };
      row.querySelector('.x').onclick = () => { S.p.subtitles = S.p.subtitles.filter((x) => x !== s); subSave.deletes.add(s.id); subSave.updates.delete(s.id); flushSubs(); renderSubRows(); updatePreview(); };
      box.append(row);
    }
  }

  // ── 렌더링 ──
  function renderRender() {
    const box = root.querySelector('#renderbox'); if (!box) return;
    const c = clip(); const r = c.render || {};
    const busy = r.status === 'queued' || r.status === 'rendering';
    box.innerHTML = `<h4>내보내기 (1080×1920 MP4)</h4>
      ${busy ? `<div class="progress"><i style="width:${r.pct || 0}%"></i></div><div class="meta">${r.status === 'queued' ? '대기 중…' : `렌더링 중 ${r.pct || 0}%`}</div>` : ''}
      ${r.status === 'error' ? `<div class="err-box" style="margin:0">${esc(r.error)}</div>` : ''}
      ${r.status === 'done' ? `<div class="meta"><span class="badge ${r.stale ? 'warn' : 'ok'}">${r.stale ? '수정 사항이 반영되지 않았습니다' : '렌더링 완료'}</span><span>${(r.size / 1048576).toFixed(1)}MB</span></div>` : ''}
      <button class="btn primary" id="render" ${busy ? 'disabled' : ''}>${r.status === 'done' ? '다시 렌더링' : '쇼츠 만들기'}</button>
      ${r.status === 'done' ? `<div class="row" style="gap:8px"><a class="btn" id="dl" href="/api/projects/${p.id}/clips/${c.id}/download">⬇ MP4 다운로드</a><button class="btn" id="view">결과 보기</button></div>` : ''}`;
    box.querySelector('#render').onclick = async () => {
      flushClip.flush(); await flushPendingNow();
      try { const res = await api(`/api/projects/${p.id}/clips/${c.id}/render`, { method: 'POST' }); c.render = res.render; renderRender(); schedulePoll(); } catch (e) { toast(e.message, true); }
    };
    box.querySelector('#view')?.addEventListener('click', () => {
      const m = el(`<div class="modal"><video src="/api/projects/${p.id}/clips/${c.id}/download?inline=1&v=${r.at}" controls autoplay></video></div>`);
      m.onclick = (e) => { if (e.target === m) m.remove(); };
      document.body.append(m);
    });
  }
  async function flushPendingNow() {
    for (const [id, patch] of [...pending]) { pending.delete(id); try { await api(`/api/projects/${p.id}/clips/${id}`, { method: 'PATCH', body: patch }); } catch (e) { toast(e.message, true); } }
    if (subSave.updates.size || subSave.deletes.size) {
      const body = { updates: [...subSave.updates].map(([id, text]) => ({ id, text })), deletes: [...subSave.deletes] };
      subSave.updates.clear(); subSave.deletes.clear();
      await api(`/api/projects/${p.id}/subtitles`, { method: 'PATCH', body }).catch((e) => toast(e.message, true));
    }
  }
  function schedulePoll() {
    clearTimeout(pollTimer);
    if (!S.p.clips.some((c) => ['queued', 'rendering'].includes(c.render?.status))) return;
    pollTimer = setTimeout(async () => {
      try {
        const q = await api(`/api/projects/${p.id}?subs=0`);
        for (const qc of q.clips) { const c = S.p.clips.find((x) => x.id === qc.id); if (c) c.render = qc.render; }
        renderRender(); renderList();
      } catch {}
      schedulePoll();
    }, 1000);
  }

  $('#addclip').onclick = async () => {
    const c = clip(); const start = Math.min(S.t, p.video.duration - 5);
    try { const n = await api(`/api/projects/${p.id}/clips`, { method: 'POST', body: { start, end: Math.min(p.video.duration, start + 30) } }); S.p.clips.push(n); select(n.id); } catch (e) { toast(e.message, true); }
  };
  $('#reanalyze').onclick = async () => {
    if (!confirm('다시 분석하면 현재 쇼츠 후보와 편집 내용이 모두 사라집니다. 계속할까요?')) return;
    try { await api(`/api/projects/${p.id}/reset`, { method: 'POST' }); route(); } catch (e) { toast(e.message, true); }
  };

  cleanup = () => { S.playing = false; vid.pause(); };
  renderList(); renderRight(); computeWin(); renderAllCenter();
  vid.addEventListener('loadedmetadata', () => { seek(clip().segments[0].start); updatePreview(); }, { once: true });
  updatePreview(); schedulePoll();
}

// ───────────────────────── 템플릿 설정 ─────────────────────────

async function templatesPage() {
  let list = await api('/api/templates');
  let selId = list[0].id;
  let d = { ...list[0] };
  let dirty = false;
  $app.innerHTML = '';
  const page = el('<div class="page" style="max-width:1250px"><h1>템플릿 설정</h1><p class="sub">쇼츠 제목 스타일, 하단 계정명, 배경, 자막 스타일을 템플릿으로 저장해 두고 쇼츠마다 골라 쓰세요.</p><div class="tplpage"><div><div class="tpllist" id="tl"></div><button class="btn" id="new" style="margin-top:10px;width:100%">＋ 새 템플릿</button></div><div class="box formgrid" id="form"></div><div><div class="phone static" id="ph">' + PHONE_HTML + '</div></div></div></div>');
  $app.append(page);
  const $ = (s) => page.querySelector(s);
  $('#ph').querySelector('.vwrap').innerHTML = '<div class="sample"></div>';

  const repaint = () => paintPhone($('#ph'), d, { title: ['쇼츠 제목 첫번째 줄', '쇼츠 제목 마지막 줄'], sub: '자막은 이렇게 보입니다' });

  function renderList() {
    $('#tl').innerHTML = '';
    for (const t of list) {
      const it = el(`<div class="tplitem ${t.id === selId ? 'sel' : ''}"><div><div>${esc(t.name)}</div><div class="meta">${t.account ? esc(t.account) : '계정명 없음'} · ${t.layout === 'framed' ? '프레임' : '전체화면'}</div></div></div>`);
      it.onclick = () => { if (t.id === selId) return; if (dirty && !confirm('저장하지 않은 변경 사항이 사라집니다. 계속할까요?')) return; select(t.id); };
      $('#tl').append(it);
    }
  }
  function select(id) { selId = id; d = { ...list.find((t) => t.id === id) }; dirty = false; renderList(); renderForm(); }

  function renderForm() {
    const f = $('#form');
    f.innerHTML = `
      <div class="two"><div class="field"><label>템플릿 이름</label><input type="text" id="name" maxlength="30" value="${esc(d.name)}"></div>
        <div class="field"><label>계정명 (영상 하단)</label><input type="text" id="account" maxlength="40" placeholder="@내채널" value="${esc(d.account)}"></div></div>
      <div class="field"><label>레이아웃</label><div class="seg" id="layout"><button data-k="full" class="${d.layout === 'full' ? 'on' : ''}">전체화면</button><button data-k="framed" class="${d.layout === 'framed' ? 'on' : ''}">프레임 (배경색 + 정사각 영상)</button></div></div>
      <div class="field"><label>배경색 (프레임 레이아웃)</label><div class="colorrow"><input type="color" id="bgColor" value="${d.bgColor}"><span class="meta">${d.layout === 'framed' ? '' : '전체화면에서는 사용되지 않습니다'}</span></div></div>
      <div class="two"><div class="field"><label>제목 첫째 줄 색</label><div class="colorrow"><input type="color" id="titleColor1" value="${d.titleColor1}"></div></div>
        <div class="field"><label>제목 둘째 줄 색</label><div class="colorrow"><input type="color" id="titleColor2" value="${d.titleColor2}"></div></div></div>
      <div class="field"><label>제목 크기 <span id="tsv">${d.titleSize}</span></label><input type="range" id="titleSize" min="50" max="110" value="${d.titleSize}"></div>
      <div class="two"><div class="field"><label>계정명 색</label><div class="colorrow"><input type="color" id="accountColor" value="${d.accountColor}"></div></div>
        <div class="field"><label>계정명 크기 <span id="asv">${d.accountSize}</span></label><input type="range" id="accountSize" min="30" max="90" value="${d.accountSize}"></div></div>
      <div class="field"><label>자막 스타일</label><div class="seg" id="subStyle">${Object.entries(config.subStyles || {}).map(([k, v]) => `<button data-k="${k}" class="${d.subStyle === k ? 'on' : ''}">${esc(v)}</button>`).join('')}</div></div>
      <div class="row" style="margin-top:6px"><button class="btn primary" id="save">저장</button><button class="btn" id="dup">복제</button><button class="btn danger" id="del" style="margin-left:auto">삭제</button></div>`;
    const set = (k, v) => { d[k] = v; dirty = true; repaint(); };
    for (const k of ['name', 'account']) f.querySelector('#' + k).oninput = (e) => { set(k, e.target.value); };
    for (const k of ['bgColor', 'titleColor1', 'titleColor2', 'accountColor']) f.querySelector('#' + k).oninput = (e) => set(k, e.target.value);
    f.querySelector('#titleSize').oninput = (e) => { f.querySelector('#tsv').textContent = e.target.value; set('titleSize', +e.target.value); };
    f.querySelector('#accountSize').oninput = (e) => { f.querySelector('#asv').textContent = e.target.value; set('accountSize', +e.target.value); };
    for (const k of ['layout', 'subStyle']) f.querySelector('#' + k).onclick = (e) => { const v = e.target.dataset.k; if (!v) return; set(k, v); f.querySelectorAll(`#${k} button`).forEach((b) => b.classList.toggle('on', b.dataset.k === v)); };
    f.querySelector('#save').onclick = async () => {
      try {
        const t = await api(`/api/templates/${selId}`, { method: 'PUT', body: d });
        list = list.map((x) => (x.id === t.id ? t : x)); d = { ...t }; dirty = false; renderList(); toast('저장했습니다');
      } catch (e) { toast(e.message, true); }
    };
    f.querySelector('#dup').onclick = async () => {
      try { const t = await api('/api/templates', { method: 'POST', body: { ...d, name: d.name + ' 복사' } }); list.push(t); select(t.id); toast('복제했습니다'); } catch (e) { toast(e.message, true); }
    };
    f.querySelector('#del').onclick = async () => {
      if (!confirm(`"${d.name}" 템플릿을 삭제할까요? 이 템플릿을 쓰던 쇼츠는 첫 번째 템플릿으로 바뀝니다.`)) return;
      try { await api(`/api/templates/${selId}`, { method: 'DELETE' }); list = list.filter((x) => x.id !== selId); select(list[0].id); } catch (e) { toast(e.message, true); }
    };
    repaint();
  }

  $('#new').onclick = async () => {
    if (dirty && !confirm('저장하지 않은 변경 사항이 사라집니다. 계속할까요?')) return;
    try { const t = await api('/api/templates', { method: 'POST', body: {} }); list.push(t); select(t.id); } catch (e) { toast(e.message, true); }
  };
  cleanup = () => {};
  renderList(); renderForm();
}

init();
