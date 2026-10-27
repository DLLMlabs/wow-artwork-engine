// Black-bar policy for delivered video (Jeff, 2026-10-21: "final renders …
// are exporting out either letterboxed or with an L shape black box").
//
// Why bars appear at all: Seedance cannot render the spectacular's 3.6:1 (or
// the EON master's 2.5:1), so the engine feeds it the approved still
// pre-letterboxed into a 16:9 canvas and strips those bars back off after
// the render (orchestrator.js, extractContent). That strip was computed from
// GEOMETRY and gated on a proof that the stripped bands were black. Two ways
// that leaked bars into Jeff's files:
//   1. The model drifts — a slow zoom or pan moves the art a few percent, so
//      the geometric crop leaves a sliver of padding on one or two edges
//      (the "L shape").
//   2. Drift also fails the proof (art bleeds into the band being measured),
//      and the fallback was to deliver the WHOLE 16:9 canvas padded into the
//      spec ("contain") — the full letterbox, bars and all.
//
// This module is the second line of defence: it MEASURES where black edges
// actually are over the whole clip and removes them, and the final conform
// never pads again (fitForAspect). Pure planning functions are unit-tested
// on their own; the async ones drive ffmpeg.

import ffmpeg from './ffmpeg.js';

/** Mean luma (0-255) at or below which a band counts as padding. True black pads at ~16. */
export const BAR_YAVG_MAX = 28;
/** Brightest pixel a padding band may contain — anything brighter is art, not a bar. */
export const BAR_YMAX_MAX = 80;
/** Never strip more than this fraction of a dimension from one edge. */
export const MAX_STRIP_FRAC = 0.4;
/** Ignore slivers below this many px. 2 = anything measurable: a 2-3px
 * sliver at render size becomes a visible 1px dark line on the sign
 * (Shawn, 2026-10-27 screenshot: "a thin black line across the right side"). */
export const MIN_STRIP_PX = 2;
/**
 * OVERSHOOT: when an edge is stripped, cut this far INTO the art as well.
 * The model and the upscaler blend art into the padding over a few pixels,
 * so the measured boundary is a dark fade, not a crisp line — stop exactly
 * there and the fade ships as a dark edge line (Shawn, 2026-10-27: "a long
 * black line along the bottom"). A few pixels out of thousands is invisible
 * on the sign; a dark line is not.
 */
export const OVERSHOOT_FRAC = 0.004;
export const OVERSHOOT_MIN_PX = 4;
/** Final-resolution edge-line check: outer 2px vs the 6px just inside. */
export const EDGE_LINE_OUTER_PX = 2;
export const EDGE_LINE_INNER_PX = 6;
export const EDGE_LINE_MAX_LUMA = 80;   // an outer band brighter than this is not dark (VAE padding noise sits ~40-60)
export const EDGE_LINE_RATIO = 0.6;     // ...and must be this much darker than the art beside it
export const EDGE_LINE_TRIM_PX = 4;     // trimmed per pass (even for yuv420)
export const EDGE_LINE_MAX_PASSES = 3;
/**
 * How deep (px, at the delivered size) the final pass scans for a dark BAND,
 * not just a 2px line (Shawn, 2026-10-27 second screenshot: the bars were
 * ~8-16px of dark grey, thicker than the line check looked and too noisy
 * for the black proof). The reference "art" brightness is read from the
 * strip just beyond the scan depth.
 */
export const EDGE_BAND_SCAN_PX = 48;
export const EDGE_BAND_SCAN_FRAC = 0.05;  // ...and never deeper than 5% of the axis: a dark floor is not a bar
export const EDGE_BAND_STEP_PX = 2;
export const EDGE_TRIM_MAX_FRAC = 0.06;   // the final pass may never take more than 6% of an axis from one edge
/** cropdetect black threshold (0-255). Topaz-lifted blacks sit around 20-30. */
export const DETECT_LIMIT = 40;

const EDGES = ['top', 'bottom', 'left', 'right'];

/** Black thickness per edge implied by a content bounding box. Pure. */
export function edgeThickness({ width, height, box } = {}) {
  if (!width || !height || !box) return { top: 0, bottom: 0, left: 0, right: 0 };
  return {
    top: Math.max(0, box.y),
    bottom: Math.max(0, height - box.y - box.height),
    left: Math.max(0, box.x),
    right: Math.max(0, width - box.x - box.width),
  };
}

/**
 * Does this design carry a painted frame (spectacular option 1, the framed
 * "mastery" track) or is it borderless full-bleed (options 2-3, every EON)?
 * Read off the still prompt because option numbers aren't stored on rows.
 * Unknown → false: a piece that should have no border gets every black edge
 * removed, which is the safe direction for what ships to the sign.
 */
export function isFramedPrompt(prompt) {
  const p = String(prompt || '');
  if (/no border, no frame|full-bleed/i.test(p)) return false;
  return /matte-black frame|black frame|trompe-l/i.test(p);
}

/**
 * Plan which black edges to remove, given the clip's content bounding box.
 *
 *   framed=false  → no border belongs in the picture: strip every black edge.
 *   framed=true   → a uniform painted border IS the design. Keep the common
 *                   thickness and strip only the EXCESS on any edge. The
 *                   allowance is the second-smallest thickness, so a single
 *                   pop-out that reaches one edge (thickness 0 there) does
 *                   not cause the frame to be stripped from the other three.
 *
 * Returns null when nothing needs stripping. Pure.
 * @returns {{crop:{x,y,width,height}, strip:{top,bottom,left,right}, allowance:number, thickness:object}|null}
 */
export function overshootFor(axis, { frac = OVERSHOOT_FRAC, minPx = OVERSHOOT_MIN_PX } = {}) {
  return Math.max(minPx, Math.round((axis || 0) * frac));
}

export function planResidualStrip({
  width, height, box, framed = false, maxFrac = MAX_STRIP_FRAC, minPx = MIN_STRIP_PX, skipEdges = [],
  overshoot, // px cut into the art on every stripped edge; default overshootFor(axis); 0 disables
  allowancePx, // per-edge px of black that BELONGS to the design (the painted frame, measured on the approved still)
} = {}) {
  if (!width || !height || !box) return null;
  const thickness = edgeThickness({ width, height, box });
  const sorted = EDGES.map((e) => thickness[e]).sort((a, b) => a - b);
  // Allowance = black that is part of the picture. Best: measured on the
  // approved still (the frame is painted there, so it is ground truth —
  // 2026-10-27: guessing it from the video kept 16px of padding on three
  // sides of a framed piece). Fallback for a framed design without a still
  // measurement: the second-smallest edge. Borderless: nothing.
  const allowance = allowancePx
    ? Object.fromEntries(EDGES.map((e) => [e, Math.max(0, Math.round(allowancePx[e] || 0))]))
    : Object.fromEntries(EDGES.map((e) => [e, framed ? sorted[1] : 0]));
  const strip = {};
  for (const edge of EDGES) {
    const axis = edge === 'top' || edge === 'bottom' ? height : width;
    const excess = thickness[edge] - allowance[edge];
    const cap = Math.floor(axis * maxFrac);
    const over = overshoot === undefined ? overshootFor(axis) : overshoot;
    strip[edge] = !skipEdges.includes(edge) && excess >= minPx ? Math.min(excess + over, cap) : 0;
  }
  if (!EDGES.some((e) => strip[e] > 0)) return null;
  // Round offsets UP and sizes DOWN to even numbers (yuv420): rounding must
  // eat one more pixel of art, never leave one pixel of bar.
  const evenUp = (n) => Math.ceil(n / 2) * 2;
  const evenDown = (n) => Math.floor(n / 2) * 2;
  const x = evenUp(strip.left);
  const y = evenUp(strip.top);
  const cropW = evenDown(width - x - strip.right);
  const cropH = evenDown(height - y - strip.bottom);
  if (cropW < 16 || cropH < 16) return null; // degenerate — never cut the picture away
  return { crop: { x, y, width: cropW, height: cropH }, strip, allowance, thickness };
}

/**
 * The band a strip would remove, shrunk by `guard` px on the content side.
 * Default guard = 30% of the band (min 2px): the upscaler's halo and the
 * model's fade live at the boundary and must not count against the proof
 * that the band is padding. Pure.
 */
export function bandRegion({ edge, px, width, height, guard } = {}) {
  const g = guard === undefined ? Math.max(2, Math.round(px * 0.3)) : guard;
  const size = px - g;
  if (size < 2) return null;
  switch (edge) {
    case 'top': return { x: 0, y: 0, width, height: size };
    case 'bottom': return { x: 0, y: height - size, width, height: size };
    case 'left': return { x: 0, y: 0, width: size, height };
    case 'right': return { x: width - size, y: 0, width: size, height };
    default: return null;
  }
}

/**
 * How the final conform must fit content into the spec: a pure scale when
 * the aspect already matches (within tolerance), otherwise CENTER-CROP the
 * excess. Never 'contain' — padding is exactly the black bar Jeff sees. Pure.
 */
export function fitForAspect({ width, height, wantAspect, tolerance = 0.03 } = {}) {
  if (!width || !height || !wantAspect) return 'exact';
  const got = width / height;
  return Math.abs(got - wantAspect) / wantAspect <= tolerance ? 'exact' : 'cover';
}

/**
 * The painted frame of a FRAMED design, measured on its approved still as a
 * fraction of each dimension — ground truth for how much black belongs at
 * each edge of the finished video. A borderless still measures 0 all round.
 * @returns {Promise<{top:number,bottom:number,left:number,right:number}>}
 */
export async function measureFrameFractions(stillPath, { limit = DETECT_LIMIT } = {}) {
  const det = await ffmpeg.detectContentBox(stillPath, { limit, sampleFps: 1 });
  const t = edgeThickness(det);
  if (!det.width || !det.height) return { top: 0, bottom: 0, left: 0, right: 0 };
  return { top: t.top / det.height, bottom: t.bottom / det.height, left: t.left / det.width, right: t.right / det.width };
}

/** Frame fractions → px at a given clip size. Pure. */
export function allowanceFromFractions(frac, { width, height } = {}) {
  if (!frac) return undefined;
  return {
    top: Math.round((frac.top || 0) * height), bottom: Math.round((frac.bottom || 0) * height),
    left: Math.round((frac.left || 0) * width), right: Math.round((frac.right || 0) * width),
  };
}

/**
 * Measure the black edges of a clip over its whole length.
 * @returns {Promise<{width, height, box, thickness, plan}>} plan is null when clean.
 */
export async function measureResidualBars(input, { framed = false, frameFrac, limit = DETECT_LIMIT, sampleFps = 2 } = {}) {
  const det = await ffmpeg.detectContentBox(input, { limit, sampleFps });
  const thickness = edgeThickness(det);
  const allowancePx = allowanceFromFractions(frameFrac, det);
  const plan = planResidualStrip({ width: det.width, height: det.height, box: det.box, framed, allowancePx });
  return { ...det, thickness, allowancePx, plan };
}

/**
 * Measure, then PROVE: each band the plan would remove must be flat black
 * padding (mean luma ≤ BAR_YAVG_MAX and no pixel above BAR_YMAX_MAX across
 * the sampled clip). A band that fails proof is art — a dark sky, a lit
 * painted frame — and is dropped from the plan. Shared by the strip step and
 * the delivered-file audit so both apply the same judgement.
 * @returns {Promise<{width, height, box, thickness, plan, rejected}>}
 */
export async function proveResidualBars(input, { framed = false, frameFrac, sampleFps = 2 } = {}) {
  const m = await measureResidualBars(input, { framed, frameFrac, sampleFps });
  if (!m.plan) return { ...m, rejected: [] };
  const rejected = [];
  for (const edge of EDGES) {
    const px = m.plan.strip[edge];
    if (!px) continue;
    const band = bandRegion({ edge, px, width: m.width, height: m.height });
    if (!band) continue; // a sliver too thin to measure is stripped on the box's word
    const stats = await ffmpeg.regionStats(input, { ...band, sampleFps });
    if (!stats || stats.yavg > BAR_YAVG_MAX) { rejected.push(edge); continue; }
    // Brightest pixel is judged on the OUTER half only: a fade or halo at the
    // boundary is not a reason to keep a bar (Shawn, 2026-10-27).
    const outer = bandRegion({ edge, px, width: m.width, height: m.height, guard: Math.max(2, Math.round(px * 0.5)) });
    const outerStats = outer ? await ffmpeg.regionStats(input, { ...outer, sampleFps }) : stats;
    if (outerStats && outerStats.ymax !== null && outerStats.ymax > BAR_YMAX_MAX) rejected.push(edge);
  }
  const plan = rejected.length
    ? planResidualStrip({ width: m.width, height: m.height, box: m.box, framed, allowancePx: m.allowancePx, skipEdges: rejected })
    : m.plan;
  return { ...m, plan, rejected };
}

/**
 * Remove the proven black edges from a clip.
 * @returns {Promise<{path, strip, rejected, thickness}>} path === input when nothing was stripped.
 */
export async function stripResidualBars({ input, output, framed = false, frameFrac, sampleFps = 2 }) {
  const p = await proveResidualBars(input, { framed, frameFrac, sampleFps });
  if (!p.plan) return { path: input, strip: null, rejected: p.rejected, thickness: p.thickness };
  await ffmpeg.cropColumn({ input, output, ...p.plan.crop });
  return { path: output, strip: p.plan.strip, rejected: p.rejected, thickness: p.thickness };
}

/** Outer / inner band pair for one edge at the delivered size. Pure. */
export function edgeLineBands({ edge, width, height, outerPx = EDGE_LINE_OUTER_PX, innerPx = EDGE_LINE_INNER_PX } = {}) {
  const gap = outerPx * 2; // skip the blend zone between outer and inner
  switch (edge) {
    case 'top': return { outer: { x: 0, y: 0, width, height: outerPx }, inner: { x: 0, y: gap, width, height: innerPx } };
    case 'bottom': return { outer: { x: 0, y: height - outerPx, width, height: outerPx }, inner: { x: 0, y: height - gap - innerPx, width, height: innerPx } };
    case 'left': return { outer: { x: 0, y: 0, width: outerPx, height }, inner: { x: gap, y: 0, width: innerPx, height } };
    case 'right': return { outer: { x: width - outerPx, y: 0, width: outerPx, height }, inner: { x: width - gap - innerPx, y: 0, width: innerPx, height } };
    default: return null;
  }
}

/** Is this edge a dark LINE: an outer rim much darker than the art right beside it? Pure. */
export function isDarkEdgeLine({ outer, inner, maxLuma = EDGE_LINE_MAX_LUMA, ratio = EDGE_LINE_RATIO } = {}) {
  if (!outer || !inner || outer.yavg === undefined || inner.yavg === undefined) return false;
  if (inner.yavg <= 0) return false;
  return outer.yavg < maxLuma && outer.yavg < inner.yavg * ratio;
}

/** The strip `depth` px in from an edge, `size` px thick, full length. Pure. */
export function edgeStrip({ edge, depth, size, width, height } = {}) {
  switch (edge) {
    case 'top': return { x: 0, y: depth, width, height: size };
    case 'bottom': return { x: 0, y: height - depth - size, width, height: size };
    case 'left': return { x: depth, y: 0, width: size, height };
    case 'right': return { x: width - depth - size, y: 0, width: size, height };
    default: return null;
  }
}

/**
 * Measure, at the DELIVERED size, how thick a dark BAND each edge carries.
 * Reference = the art just beyond the scan depth (scanPx..2*scanPx in). From
 * the edge inward, every `step` that is dark (below EDGE_LINE_MAX_LUMA and
 * below EDGE_LINE_RATIO × reference) is band; the first bright step ends it.
 * A painted frame is excused by `allowancePx` (measured on the still); a
 * dark scene edge (reference dark too) never qualifies; a 2px rounding line
 * and a 16px model-padding band are both caught.
 * @returns {Promise<{width, height, lines: string[], thickness: object, stats: object}>}
 */
export async function measureEdgeLines(input, { sampleFps = 2, scanPx = EDGE_BAND_SCAN_PX, step = EDGE_BAND_STEP_PX, allowancePx } = {}) {
  const { width, height } = await ffmpeg.probe(input);
  const lines = [];
  const thickness = { top: 0, bottom: 0, left: 0, right: 0 };
  const stats = {};
  for (const edge of EDGES) {
    const axis = edge === 'top' || edge === 'bottom' ? height : width;
    const scan = Math.max(step, Math.min(scanPx, Math.floor(axis * EDGE_BAND_SCAN_FRAC)));
    const allowed = allowancePx?.[edge] || 0;
    // Reference art is read beyond the painted frame (if any) AND the scan depth.
    const refBand = edgeStrip({ edge, depth: allowed + scan, size: scan, width, height });
    const ref = await ffmpeg.regionStats(input, { ...refBand, sampleFps });
    const outer = await ffmpeg.regionStats(input, { ...edgeStrip({ edge, depth: 0, size: step, width, height }), sampleFps });
    stats[edge] = { outer: outer?.yavg ?? null, ref: ref?.yavg ?? null };
    if (!ref || !outer || !isDarkEdgeLine({ outer, inner: ref })) continue;
    let dark = step;
    while (dark < scan) {
      const st = await ffmpeg.regionStats(input, { ...edgeStrip({ edge, depth: dark, size: step, width, height }), sampleFps });
      if (!st || !isDarkEdgeLine({ outer: st, inner: ref })) break;
      dark += step;
    }
    if (dark > allowed) { thickness[edge] = dark; lines.push(edge); }
  }
  return { width, height, lines, thickness, stats };
}

/**
 * LAST PASS at the delivered size (Shawn, 2026-10-27: a thin dark line was
 * still visible along the bottom and the right edge of a shipped file).
 * Whatever got past the render-size steps — a 1px rounding sliver, a fade
 * the box stopped short of — reads here as a dark rim beside bright art.
 * Trim EDGE_LINE_TRIM_PX from each such edge and scale straight back to the
 * exact spec (≤1% squash per pass, invisible). Up to maxPasses passes.
 * @returns {Promise<{path, passes, trimmed: object, remaining: string[]}>} path === input when nothing was trimmed.
 */
export async function trimDarkEdgeLines({ input, output, width, height, maxPasses = EDGE_LINE_MAX_PASSES, trimPx = EDGE_LINE_TRIM_PX, sampleFps = 2, allowancePx }) {
  let current = input;
  let passes = 0;
  const trimmed = { top: 0, bottom: 0, left: 0, right: 0 };
  let m = await measureEdgeLines(current, { sampleFps, allowancePx });
  let lines = m.lines;
  const evenUp = (n) => Math.ceil(n / 2) * 2;
  while (lines.length && passes < maxPasses) {
    passes += 1;
    const cut = { top: 0, bottom: 0, left: 0, right: 0 };
    // Cut the band beyond the painted-frame allowance plus the usual overshoot
    // (never less than trimPx); a framed design keeps its frame.
    for (const e of lines) {
      const axis = e === 'top' || e === 'bottom' ? height : width;
      const excess = Math.max(0, (m.thickness[e] || 0) - (allowancePx?.[e] || 0));
      const want = evenUp(Math.max(trimPx, excess + trimPx));
      const room = Math.floor((Math.floor(axis * EDGE_TRIM_MAX_FRAC) - trimmed[e]) / 2) * 2;
      cut[e] = room >= trimPx ? Math.min(want, room) : 0;
      trimmed[e] += cut[e];
    }
    if (!EDGES.some((e) => cut[e] > 0)) break; // budget spent: stop, the audit will flag what is left
    const cropped = `${output}.pass${passes}.mp4`;
    await ffmpeg.cropColumn({
      input: current, output: cropped,
      width: width - cut.left - cut.right, height: height - cut.top - cut.bottom, x: cut.left, y: cut.top,
    });
    const next = passes === maxPasses ? output : `${output}.scaled${passes}.mp4`;
    await ffmpeg.conform({ input: cropped, output: next, width, height, fit: 'exact' });
    current = next;
    m = await measureEdgeLines(current, { sampleFps, allowancePx });
    lines = m.lines;
  }
  if (passes === 0) return { path: input, passes, trimmed, remaining: lines };
  if (current !== output) await ffmpeg.conform({ input: current, output, width, height, fit: 'exact' });
  return { path: output, passes, trimmed, remaining: lines };
}

/** One-line description of a strip/thickness map for logs and QA flags. */
export function describeEdges(map) {
  if (!map) return 'none';
  return EDGES.filter((e) => map[e] > 0).map((e) => `${e} ${map[e]}px`).join(', ') || 'none';
}

export default {
  BAR_YAVG_MAX, BAR_YMAX_MAX, MAX_STRIP_FRAC, MIN_STRIP_PX, DETECT_LIMIT,
  OVERSHOOT_FRAC, OVERSHOOT_MIN_PX, EDGE_LINE_TRIM_PX, EDGE_LINE_MAX_PASSES,
  edgeThickness, isFramedPrompt, overshootFor, planResidualStrip, bandRegion, fitForAspect,
  measureResidualBars, proveResidualBars, stripResidualBars, describeEdges,
  measureFrameFractions, allowanceFromFractions, edgeLineBands, edgeStrip, isDarkEdgeLine, measureEdgeLines, trimDarkEdgeLines, EDGE_BAND_SCAN_PX, EDGE_BAND_SCAN_FRAC, EDGE_TRIM_MAX_FRAC,
};
