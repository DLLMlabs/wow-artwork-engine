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
/** Ignore slivers below this many px (encoder/rounding noise). */
export const MIN_STRIP_PX = 4;
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
export function planResidualStrip({
  width, height, box, framed = false, maxFrac = MAX_STRIP_FRAC, minPx = MIN_STRIP_PX, skipEdges = [],
} = {}) {
  if (!width || !height || !box) return null;
  const thickness = edgeThickness({ width, height, box });
  const sorted = EDGES.map((e) => thickness[e]).sort((a, b) => a - b);
  const allowance = framed ? sorted[1] : 0;
  const strip = {};
  for (const edge of EDGES) {
    const axis = edge === 'top' || edge === 'bottom' ? height : width;
    const excess = thickness[edge] - allowance;
    const cap = Math.floor(axis * maxFrac);
    strip[edge] = !skipEdges.includes(edge) && excess >= minPx ? Math.min(excess, cap) : 0;
  }
  if (!EDGES.some((e) => strip[e] > 0)) return null;
  const even = (n) => Math.floor(n / 2) * 2;
  const x = even(strip.left);
  const y = even(strip.top);
  const cropW = even(width - x - strip.right);
  const cropH = even(height - y - strip.bottom);
  if (cropW < 16 || cropH < 16) return null; // degenerate — never cut the picture away
  return { crop: { x, y, width: cropW, height: cropH }, strip, allowance, thickness };
}

/** The band a strip would remove, shrunk by `guard` px on the content side (encoder ringing). Pure. */
export function bandRegion({ edge, px, width, height, guard = 2 } = {}) {
  const size = px - guard;
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
 * Measure the black edges of a clip over its whole length.
 * @returns {Promise<{width, height, box, thickness, plan}>} plan is null when clean.
 */
export async function measureResidualBars(input, { framed = false, limit = DETECT_LIMIT, sampleFps = 2 } = {}) {
  const det = await ffmpeg.detectContentBox(input, { limit, sampleFps });
  const thickness = edgeThickness(det);
  const plan = planResidualStrip({ width: det.width, height: det.height, box: det.box, framed });
  return { ...det, thickness, plan };
}

/**
 * Measure, then PROVE: each band the plan would remove must be flat black
 * padding (mean luma ≤ BAR_YAVG_MAX and no pixel above BAR_YMAX_MAX across
 * the sampled clip). A band that fails proof is art — a dark sky, a lit
 * painted frame — and is dropped from the plan. Shared by the strip step and
 * the delivered-file audit so both apply the same judgement.
 * @returns {Promise<{width, height, box, thickness, plan, rejected}>}
 */
export async function proveResidualBars(input, { framed = false, sampleFps = 2 } = {}) {
  const m = await measureResidualBars(input, { framed, sampleFps });
  if (!m.plan) return { ...m, rejected: [] };
  const rejected = [];
  for (const edge of EDGES) {
    const px = m.plan.strip[edge];
    if (!px) continue;
    const band = bandRegion({ edge, px, width: m.width, height: m.height });
    if (!band) continue;
    const stats = await ffmpeg.regionStats(input, { ...band, sampleFps });
    if (!stats || stats.yavg > BAR_YAVG_MAX || stats.ymax > BAR_YMAX_MAX) rejected.push(edge);
  }
  const plan = rejected.length
    ? planResidualStrip({ width: m.width, height: m.height, box: m.box, framed, skipEdges: rejected })
    : m.plan;
  return { ...m, plan, rejected };
}

/**
 * Remove the proven black edges from a clip.
 * @returns {Promise<{path, strip, rejected, thickness}>} path === input when nothing was stripped.
 */
export async function stripResidualBars({ input, output, framed = false, sampleFps = 2 }) {
  const p = await proveResidualBars(input, { framed, sampleFps });
  if (!p.plan) return { path: input, strip: null, rejected: p.rejected, thickness: p.thickness };
  await ffmpeg.cropColumn({ input, output, ...p.plan.crop });
  return { path: output, strip: p.plan.strip, rejected: p.rejected, thickness: p.thickness };
}

/** One-line description of a strip/thickness map for logs and QA flags. */
export function describeEdges(map) {
  if (!map) return 'none';
  return EDGES.filter((e) => map[e] > 0).map((e) => `${e} ${map[e]}px`).join(', ') || 'none';
}

export default {
  BAR_YAVG_MAX, BAR_YMAX_MAX, MAX_STRIP_FRAC, MIN_STRIP_PX, DETECT_LIMIT,
  edgeThickness, isFramedPrompt, planResidualStrip, bandRegion, fitForAspect,
  measureResidualBars, proveResidualBars, stripResidualBars, describeEdges,
};
