// 무음·군말 제거 계산 — 서버(렌더링)와 브라우저(미리보기)가 같은 파일을 써서 결과가 항상 일치한다.

export const TIGHTEN_DEFAULTS = { silence: true, minSilence: 0.6, pad: 0.15, filler: true };
export const TIGHTEN_LIMITS = { minSilence: [0.3, 2], pad: [0, 0.5] };

const MIN_KEEP = 0.2; // 이보다 짧게 남는 조각은 버린다

/**
 * 쇼츠의 원본 구간(segments)에서 무음·군말을 걷어낸 "실제로 이어 붙일 구간" 목록을 계산한다.
 * - cuts.silences: 소리가 없는 구간, cuts.fillers: 군말(음, 어…) 구간 (원본 영상 시간, 초)
 * - 결과 항목에는 어느 원본 구간에서 나왔는지(src)가 들어 있고, 재생 순서는 입력 순서를 유지한다.
 * - 옵션이 꺼져 있거나 데이터가 없으면 원본 구간 그대로.
 */
export function effectiveSegments(segments, cuts, opts) {
  const plain = () => segments.map((s, i) => ({ ...s, src: i }));
  if (!opts || (!opts.silence && !opts.filler) || !cuts) return plain();
  const pad = opts.pad ?? TIGHTEN_DEFAULTS.pad;
  const minSilence = opts.minSilence ?? TIGHTEN_DEFAULTS.minSilence;
  const out = [];
  segments.forEach((seg, i) => {
    const remove = [];
    if (opts.silence) {
      for (const s of cuts.silences || []) {
        if (s.end <= seg.start || s.start >= seg.end) continue;
        if (s.end - s.start < minSilence) continue;
        // 말소리 앞뒤로 pad만큼 여백을 남기고 나머지를 제거 → 긴 침묵이 2*pad 길이의 자연스러운 쉼으로 줄어든다
        const a = s.start + pad; const b = s.end - pad;
        if (b - a > 0.05) remove.push([a, b]);
      }
    }
    if (opts.filler) {
      for (const f of cuts.fillers || []) {
        if (f.end <= seg.start || f.start >= seg.end) continue;
        remove.push([f.start, f.end]);
      }
    }
    remove.sort((x, y) => x[0] - y[0]);
    // 제거 구간의 여집합 = 남길 구간
    const keeps = [];
    let cur = seg.start;
    for (const [a, b] of remove) {
      if (a > cur) keeps.push([cur, Math.min(a, seg.end)]);
      cur = Math.max(cur, b);
      if (cur >= seg.end) break;
    }
    if (cur < seg.end) keeps.push([cur, seg.end]);
    const kept = keeps.filter(([a, b]) => b - a >= MIN_KEEP);
    if (!kept.length) { out.push({ ...seg, src: i }); return; } // 전부 지워지면 원본을 유지
    for (const [a, b] of kept) out.push({ ...seg, start: round(a), end: round(b), src: i });
  });
  return out;
}

const round = (n) => Math.round(n * 1000) / 1000;

/** 줄어든 길이(초)와 제거된 무음/군말 개수 요약 */
export function tightenSummary(segments, cuts, opts) {
  const eff = effectiveSegments(segments, cuts, opts);
  const before = segments.reduce((n, s) => n + s.end - s.start, 0);
  const after = eff.reduce((n, s) => n + s.end - s.start, 0);
  const count = (list, on, minLen = 0) => (on ? (list || []).filter((x) => segments.some((s) => x.end > s.start && x.start < s.end) && x.end - x.start >= minLen).length : 0);
  return {
    saved: Math.max(0, before - after),
    silences: count(cuts?.silences, opts?.silence, opts?.minSilence ?? 0),
    fillers: count(cuts?.fillers, opts?.filler),
    after,
  };
}

export function sanitizeTighten(input) {
  if (!input || typeof input !== 'object') return null;
  const clamp = (v, [lo, hi], d) => { const n = Number(v); return Number.isFinite(n) ? Math.min(hi, Math.max(lo, Math.round(n * 100) / 100)) : d; };
  return {
    silence: !!input.silence,
    minSilence: clamp(input.minSilence, TIGHTEN_LIMITS.minSilence, TIGHTEN_DEFAULTS.minSilence),
    pad: clamp(input.pad, TIGHTEN_LIMITS.pad, TIGHTEN_DEFAULTS.pad),
    filler: !!input.filler,
  };
}
