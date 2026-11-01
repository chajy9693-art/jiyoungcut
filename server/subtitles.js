// 전사(transcript) 세그먼트를 쇼츠용 짧은 자막 줄로 분할

export function chunkSegments(segments, { maxChars = 16 } = {}) {
  const out = [];
  for (const seg of segments) {
    const text = String(seg.text || '').replace(/\s+/g, ' ').trim();
    if (!text) continue;
    const lines = splitText(text, maxChars);
    const total = lines.reduce((n, l) => n + l.length, 0) || 1;
    const span = Math.max(0.2, seg.end - seg.start);
    let t = seg.start;
    for (const line of lines) {
      const d = (span * line.length) / total;
      out.push({ start: round(t), end: round(t + d), text: line });
      t += d;
    }
  }
  return out.map((s, i) => ({ id: `s${i}`, ...s }));
}

function splitText(text, maxChars) {
  if (text.length <= maxChars) return [text];
  const words = text.split(' ');
  const lines = [];
  let cur = '';
  for (let w of words) {
    while (w.length > maxChars) {
      if (cur) { lines.push(cur); cur = ''; }
      lines.push(w.slice(0, maxChars));
      w = w.slice(maxChars);
    }
    if (!cur) cur = w;
    else if ((cur + ' ' + w).length <= maxChars) cur += ' ' + w;
    else { lines.push(cur); cur = w; }
  }
  if (cur) lines.push(cur);
  return lines;
}

const round = (n) => Math.round(n * 100) / 100;

/** 제목이 한 줄로 길면 중간 공백에서 두 줄로 나눈다 */
export function splitTitle(title) {
  const t = String(title || '').trim();
  if (!t) return [];
  if (t.includes('\n')) return t.split('\n').map((s) => s.trim()).filter(Boolean).slice(0, 2);
  if (t.length <= 14 || !t.includes(' ')) return [t];
  const mid = t.length / 2;
  let best = -1;
  for (let i = 0; i < t.length; i++) {
    if (t[i] === ' ' && (best < 0 || Math.abs(i - mid) < Math.abs(best - mid))) best = i;
  }
  return [t.slice(0, best).trim(), t.slice(best + 1).trim()];
}
