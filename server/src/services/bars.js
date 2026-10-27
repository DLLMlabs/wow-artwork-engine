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

/** Mean luma (0-255) at or below which a band counts as padding. True black pads at ~16. (Kept for the geometric step.) */
export const BAR_YAVG_MAX = 28;
/** Brightest pixel a padding band may contain — anything brighter is art, not a bar. (Kept for the geometric step.) */
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
export const OVERSHOOT_FRAC = 0.012;  // the fade past a pure-black bar measured ~8px of 468 on a real file (2026-10-27)
export const OVERSHOOT_MIN_PX = 8;
/** Trimmed from EVERY edge at the final pass, bar or no bar: a 1px blended line from any upstream rounding can never ship. */
export const EDGE_SAFETY_PX = 2;
/** The final pass may never take more than this fraction of an axis from one edge (a dark scene is not a bar). */
export const FINAL_MAX_STRIP_FRAC = 0.1;
/** Final-resolution edge-line check: outer 2px vs the 6px just inside. */
export const EDGE_LINE_OUTER_PX = 2;
export const EDGE_LINE_INNER_PX = 6;
export const EDGE_LINE_MAX_LUMA = 80;   // an outer band brighter than this is not dark (VAE padding noise sits ~40-60)
export const EDGE_LINE_RATIO = 0.6;     // ...and must be this much darker than the art beside it
export const EDGE_LINE_TRIM_PX = 4;     // trimmed per pass (even for yuv420)
export const EDGE_LINE_MAX_PASSES = 3;
/**
 * cropdetect black threshold (0-255), per-row MEAN. 24 = pure black as the
 * renders actually carry it: on the two real files of 2026-10-27 the padding
 * measured 16-17 in every frame it was present, while the darkest night-scene
 * edges measured 37+ (and a limit of 32 already swallowed 298px of a dark sky).
 */
export const DETECT_LIMIT = 24;

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
 * Measure the black edges. Detection at DETECT_LIMIT (per-row mean ≤ 24,
 * frame by frame, worst case per edge) IS the proof: only padding is that
 * black. The old clip-wide luma gate is gone — a bar that is only present
 * part of the clip (the picture drifting in its canvas) averages bright over
 * the whole clip and the gate kept it (Shawn, 2026-10-27, Masquerade file).
 * A painted frame is protected by the allowance measured on the still, not
 * by a luma test. `rejected` stays in the result for callers; it is always [].
 * @returns {Promise<{width, height, box, thickness, plan, rejected}>}
 */
export async function proveResidualBars(input, { framed = false, frameFrac, sampleFps = 2 } = {}) {
  const m = await measureResidualBars(input, { framed, frameFrac, sampleFps });
  return { ...m, rejected: [] };
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

/**
 * Measure, at the DELIVERED size, the black edges beyond the painted-frame
 * allowance: per-frame, worst case per edge, pure-black threshold (see
 * detectContentBox). `lines` names the edges that carry one; `thickness` is
 * the full dark run; `framesWithBar` says in how many sampled frames.
 * @returns {Promise<{width, height, lines: string[], thickness: object, framesWithBar: object, frames: number}>}
 */
export async function measureEdgeLines(input, { sampleFps = 4, allowancePx, limit = DETECT_LIMIT } = {}) {
  const det = await ffmpeg.detectContentBox(input, { limit, sampleFps, mode: 'intersection' });
  const lines = EDGES.filter((e) => (det.thickness[e] || 0) > (allowancePx?.[e] || 0));
  return { width: det.width, height: det.height, lines, thickness: det.thickness, framesWithBar: det.framesWithBar, frames: det.frames };
}

/**
 * LAST PASS at the delivered size. Everything that survived the render-size
 * steps — a bar that comes and goes as the picture drifts, a fade, a 1px
 * rounding line — is removed here in one stable cut for the whole clip:
 *   cut[edge] = EDGE_SAFETY_PX (always, every edge)
 *             + max(0, worst-case black thickness − frame allowance) + overshoot
 * capped at FINAL_MAX_STRIP_FRAC of the axis; then scaled straight back to
 * the exact spec — 'exact' when the cut kept the aspect within 5%, 'cover'
 * (center-crop, no distortion) otherwise. Always produces `output`.
 * @returns {Promise<{path, cut, measured, fit, capped: string[]}>}
 */
export async function trimDarkEdgeLines({ input, output, width, height, allowancePx, sampleFps = 4, maxFrac = FINAL_MAX_STRIP_FRAC, safetyPx = EDGE_SAFETY_PX }) {
  const m = await measureEdgeLines(input, { sampleFps, allowancePx });
  const evenUp = (n) => Math.ceil(n / 2) * 2;
  const cut = {};
  const capped = [];
  for (const e of EDGES) {
    const axis = e === 'top' || e === 'bottom' ? height : width;
    const excess = Math.max(0, (m.thickness[e] || 0) - (allowancePx?.[e] || 0));
    let px = safetyPx + (excess > 0 ? excess + overshootFor(axis) : 0);
    const cap = Math.floor(axis * maxFrac);
    if (px > cap) { px = cap; capped.push(e); }
    cut[e] = evenUp(px);
  }
  const cw = width - cut.left - cut.right;
  const ch = height - cut.top - cut.bottom;
  const fit = fitForAspect({ width: cw, height: ch, wantAspect: width / height, tolerance: 0.05 });
  const cropped = `${output}.cut.mp4`;
  await ffmpeg.cropColumn({ input, output: cropped, width: cw, height: ch, x: cut.left, y: cut.top });
  await ffmpeg.conform({ input: cropped, output, width, height, fit });
  return { path: output, cut, measured: m, fit, capped };
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
  measureFrameFractions, allowanceFromFractions, edgeLineBands, isDarkEdgeLine, measureEdgeLines, trimDarkEdgeLines,
  EDGE_SAFETY_PX, FINAL_MAX_STRIP_FRAC,
};
