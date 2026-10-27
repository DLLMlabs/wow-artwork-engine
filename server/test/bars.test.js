// Black-bar policy (Jeff, 2026-10-21: "exporting out either letterboxed or
// with an L shape black box"). Pure planning tests plus real ffmpeg
// round-trips on synthetic clips.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import {
  planResidualStrip, edgeThickness, bandRegion, fitForAspect, isFramedPrompt,
  stripResidualBars, proveResidualBars, describeEdges, overshootFor,
  isDarkEdgeLine, edgeLineBands, measureEdgeLines, trimDarkEdgeLines,
  measureFrameFractions, allowanceFromFractions, EDGE_SAFETY_PX,
} from '../src/services/bars.js';
import { fileURLToPath } from 'node:url';
const FIXTURES = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures');
import ffmpeg from '../src/services/ffmpeg.js';
import { buildStillPrompt } from '../src/services/generation/prompts.js';

const execFileP = promisify(execFile);
async function hasFfmpeg() {
  try { await execFileP('ffmpeg', ['-version']); return true; } catch { return false; }
}

test('edgeThickness: a content box implies black thickness per edge', () => {
  assert.deepEqual(edgeThickness({ width: 1280, height: 720, box: { x: 60, y: 180, width: 1200, height: 332 } }),
    { top: 180, bottom: 208, left: 60, right: 20 });
  assert.deepEqual(edgeThickness({ width: 100, height: 50, box: null }), { top: 0, bottom: 0, left: 0, right: 0 });
});

test('planResidualStrip: borderless piece — every black edge goes (the L shape)', () => {
  const plan = planResidualStrip({ width: 1280, height: 352, box: { x: 60, y: 0, width: 1200, height: 328 }, framed: false, overshoot: 0 });
  assert.deepEqual(plan.strip, { top: 0, bottom: 24, left: 60, right: 20 });
  assert.deepEqual(plan.crop, { x: 60, y: 0, width: 1200, height: 328 });
  assert.deepEqual(plan.allowance, { top: 0, bottom: 0, left: 0, right: 0 });
  // Nothing to strip → null (the common good case: no re-encode).
  assert.equal(planResidualStrip({ width: 1280, height: 352, box: null }), null);
  assert.equal(planResidualStrip({ width: 1280, height: 352, box: { x: 0, y: 0, width: 1280, height: 352 } }), null);
});

test('planResidualStrip: framed piece keeps its uniform painted border, strips only the excess', () => {
  // Letterbox residue on a framed design: 150 top/bottom, 50 left/right.
  const lb = planResidualStrip({ width: 2000, height: 1000, box: { x: 50, y: 150, width: 1900, height: 700 }, framed: true, overshoot: 0 });
  assert.deepEqual(lb.allowance, { top: 50, bottom: 50, left: 50, right: 50 });
  assert.deepEqual(lb.strip, { top: 100, bottom: 100, left: 0, right: 0 });
  assert.deepEqual(lb.crop, { x: 0, y: 100, width: 2000, height: 800 });
  // A pop-out that reaches ONE edge must not strip the frame from the other three.
  const pop = planResidualStrip({ width: 2000, height: 1000, box: { x: 50, y: 50, width: 1950, height: 900 }, framed: true });
  assert.equal(pop, null);
  // The same geometry on a borderless piece IS a residual bar.
  const bl = planResidualStrip({ width: 2000, height: 1000, box: { x: 50, y: 50, width: 1950, height: 900 }, framed: false, overshoot: 0 });
  assert.deepEqual(bl.strip, { top: 50, bottom: 50, left: 50, right: 0 });
});

test('planResidualStrip: slivers count, strips are capped, rejected edges are skipped', () => {
  // A 1px edge is below the floor; 2px IS a bar (it becomes a visible line on the sign).
  assert.equal(planResidualStrip({ width: 1000, height: 500, box: { x: 1, y: 0, width: 998, height: 500 }, overshoot: 0 }), null);
  const sliver = planResidualStrip({ width: 1000, height: 500, box: { x: 2, y: 0, width: 995, height: 500 }, overshoot: 0 });
  assert.deepEqual(sliver.strip, { top: 0, bottom: 0, left: 2, right: 3 });
  // Never more than 40% of an axis from one edge.
  const cap = planResidualStrip({ width: 1000, height: 500, box: { x: 0, y: 300, width: 1000, height: 200 }, overshoot: 0 });
  assert.equal(cap.strip.top, 200);
  // An edge that failed proof (dark art, not padding) is left alone.
  const skip = planResidualStrip({ width: 1000, height: 500, box: { x: 100, y: 100, width: 800, height: 400 }, skipEdges: ['top'], overshoot: 0 });
  assert.deepEqual(skip.strip, { top: 0, bottom: 0, left: 100, right: 100 });
});

test('planResidualStrip: OVERSHOOT cuts into the art past the measured boundary; rounding never leaves a pixel of bar', () => {
  // Default overshoot: 1.2% of the axis, at least 8px (the fade past a real
  // pure-black bar measured ~8px of 468 on 2026-10-27).
  assert.equal(overshootFor(468), 8);
  assert.equal(overshootFor(1692), 20);
  assert.equal(overshootFor(5120), 61);
  // A 3px sliver right + 6px bottom on a 5120x1414 clip.
  const p = planResidualStrip({ width: 5120, height: 1414, box: { x: 0, y: 0, width: 5117, height: 1408 } });
  assert.deepEqual(p.strip, { top: 0, bottom: 6 + 17, left: 0, right: 3 + 61 });
  assert.deepEqual(p.crop, { x: 0, y: 0, width: 5056, height: 1390 });
  // Odd offsets round UP (into the art), odd sizes round DOWN — never a leftover line.
  const odd = planResidualStrip({ width: 1001, height: 501, box: { x: 3, y: 3, width: 995, height: 495 }, overshoot: 0 });
  assert.deepEqual(odd.crop, { x: 4, y: 4, width: 994, height: 494 });
  // Untouched edges get no overshoot.
  assert.equal(p.strip.top, 0);
  assert.equal(p.strip.left, 0);
});

test('isDarkEdgeLine / edgeLineBands: a black rim beside bright art is a line; a frame or a dark scene is not', () => {
  assert.equal(isDarkEdgeLine({ outer: { yavg: 30 }, inner: { yavg: 140 } }), true);
  assert.equal(isDarkEdgeLine({ outer: { yavg: 20 }, inner: { yavg: 22 } }), false); // painted frame / dark scene
  assert.equal(isDarkEdgeLine({ outer: { yavg: 90 }, inner: { yavg: 200 } }), false); // not dark
  assert.equal(isDarkEdgeLine({ outer: { yavg: 60 }, inner: { yavg: 100 } }), false); // not enough contrast
  const b = edgeLineBands({ edge: 'bottom', width: 1692, height: 468 });
  assert.deepEqual(b.outer, { x: 0, y: 466, width: 1692, height: 2 });
  assert.deepEqual(b.inner, { x: 0, y: 458, width: 1692, height: 6 });
  const r = edgeLineBands({ edge: 'right', width: 1692, height: 468 });
  assert.deepEqual(r.outer, { x: 1690, y: 0, width: 2, height: 468 });
});

test('bandRegion: the band a strip removes, guarded on the content side (30% by default)', () => {
  assert.deepEqual(bandRegion({ edge: 'top', px: 100, width: 1280, height: 720 }), { x: 0, y: 0, width: 1280, height: 70 });
  assert.deepEqual(bandRegion({ edge: 'bottom', px: 100, width: 1280, height: 720 }), { x: 0, y: 650, width: 1280, height: 70 });
  assert.deepEqual(bandRegion({ edge: 'left', px: 60, width: 1280, height: 720, guard: 2 }), { x: 0, y: 0, width: 58, height: 720 });
  assert.deepEqual(bandRegion({ edge: 'right', px: 20, width: 1280, height: 720 }), { x: 1266, y: 0, width: 14, height: 720 });
  assert.equal(bandRegion({ edge: 'top', px: 3, width: 1280, height: 720 }), null);
});

test('fitForAspect: exact scale when the aspect matches, center-crop otherwise — never pad', () => {
  const AR = 1692 / 468;
  assert.equal(fitForAspect({ width: 1200, height: 332, wantAspect: AR }), 'exact');
  assert.equal(fitForAspect({ width: 1280, height: 720, wantAspect: AR }), 'cover');
  assert.equal(fitForAspect({ width: 0, height: 0, wantAspect: AR }), 'exact');
});

test('isFramedPrompt: option 1 is the framed track, options 2-3 and EON are borderless', () => {
  const weekOf = '2026-10-19';
  assert.equal(isFramedPrompt(buildStillPrompt({ style: 'frame_break', specKey: 'spectacular_wow1_8', option: 1, weekOf })), true);
  assert.equal(isFramedPrompt(buildStillPrompt({ style: 'frame_break', specKey: 'spectacular_wow1_8', option: 2, weekOf })), false);
  assert.equal(isFramedPrompt(buildStillPrompt({ style: 'frame_break', specKey: 'spectacular_wow1_8', option: 3, weekOf })), false);
  assert.equal(isFramedPrompt(buildStillPrompt({ style: 'eon_connected', specKey: 'eon_master_3pod', option: 1, weekOf })), false);
  assert.equal(isFramedPrompt(''), false);
  assert.equal(isFramedPrompt(null), false);
});

test('describeEdges', () => {
  assert.equal(describeEdges({ top: 0, bottom: 24, left: 60, right: 0 }), 'bottom 24px, left 60px');
  assert.equal(describeEdges({ top: 0, bottom: 0, left: 0, right: 0 }), 'none');
  assert.equal(describeEdges(null), 'none');
});

// ---------------------------------------------------------------------------
// Real ffmpeg round-trips
// ---------------------------------------------------------------------------

async function clip(dir, name, filter, { size = '1200x332', seconds = 2 } = {}) {
  const out = path.join(dir, name);
  await execFileP('ffmpeg', [
    '-y', '-v', 'error', '-f', 'lavfi', '-i', `testsrc2=s=${size}:d=${seconds}:r=10`,
    '-vf', `${filter},format=yuv420p`, '-c:v', 'libx264', '-crf', '18', '-an', out,
  ]);
  return out;
}

test('stripResidualBars: the L shape — uneven black padding is measured and removed', async (t) => {
  if (!(await hasFfmpeg())) return t.skip('ffmpeg not installed');
  const dir = await mkdtemp(path.join(os.tmpdir(), 'wae-bars-'));
  try {
    // Art 1200x332 pushed into a 1280x720 canvas at (60,180): left 60, top 180, right 20, bottom 208.
    const input = await clip(dir, 'lshape.mp4', 'pad=1280:720:60:180:black');
    const r = await stripResidualBars({ input, output: path.join(dir, 'out.mp4'), framed: false });
    assert.notEqual(r.path, input);
    // Every measured bar is removed plus the overshoot into the art (15px on 1280, 9px on 720).
    assert.deepEqual(r.strip, { top: 189, bottom: 217, left: 75, right: 35 });
    assert.deepEqual(r.rejected, []);
    const p = await ffmpeg.probe(r.path);
    assert.equal(p.width, 1168); // 75 rounds UP to 76 (into the art), 1169 rounds DOWN
    assert.equal(p.height, 312);
    // And the result audits clean.
    const audit = await proveResidualBars(r.path, { framed: false });
    assert.equal(audit.plan, null);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('stripResidualBars: a framed piece keeps its painted border, loses only the extra bottom bar', async (t) => {
  if (!(await hasFfmpeg())) return t.skip('ffmpeg not installed');
  const dir = await mkdtemp(path.join(os.tmpdir(), 'wae-bars-'));
  try {
    // 1000x300 art inside a uniform 50px black frame (1100x400), then 100px of
    // letterbox residue under it (1100x500).
    const input = await clip(dir, 'framed.mp4', 'pad=1100:400:50:50:black,pad=1100:500:0:0:black', { size: '1000x300' });
    const r = await stripResidualBars({ input, output: path.join(dir, 'out.mp4'), framed: true });
    assert.deepEqual(r.strip, { top: 0, bottom: 108, left: 0, right: 0 });
    const p = await ffmpeg.probe(r.path);
    assert.equal(p.width, 1100);
    assert.equal(p.height, 392);
    // The same clip judged as borderless loses the frame too (that is the point).
    const b = await stripResidualBars({ input, output: path.join(dir, 'out2.mp4'), framed: false });
    assert.deepEqual(b.strip, { top: 58, bottom: 158, left: 63, right: 63 });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('stripResidualBars: only pure black is a bar — a speck in a black band changes nothing, a grey edge is never detected', async (t) => {
  if (!(await hasFfmpeg())) return t.skip('ffmpeg not installed');
  const dir = await mkdtemp(path.join(os.tmpdir(), 'wae-bars-'));
  try {
    // A black bar with one bright speck is still padding (its rows average ~17).
    const lit = await clip(dir, 'lit.mp4', 'pad=1200:532:0:100:black,drawbox=x=600:y=40:w=6:h=6:color=white@1:t=fill');
    const r = await stripResidualBars({ input: lit, output: path.join(dir, 'out.mp4'), framed: false });
    assert.deepEqual(r.strip, { top: 100 + 8, bottom: 100 + 8, left: 0, right: 0 });
    // A dark-grey (not black) edge is scenery (night sky measures 37+ on real renders): nothing is stripped.
    const grey = await clip(dir, 'grey.mp4', 'pad=1200:532:0:100:0x303030');
    const g = await stripResidualBars({ input: grey, output: path.join(dir, 'out2.mp4'), framed: false });
    assert.equal(g.path, grey);
    assert.equal(g.strip, null);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

// The 2026-10-27 screenshot: a dark line along the bottom and a thin one on
// the right of a shipped file. Two causes, two round-trips:
//   1. the model/upscaler BLEND the art into the bar — the boundary is a fade,
//      the box stops short of it and the proof used to reject the band;
//   2. a 1-3px sliver (rounding, drift) that used to fall under the floor.
async function edgeReport(file) {
  const m = await measureEdgeLines(file);
  return m;
}

test('a faded (blurred) boundary is still stripped, and no dark rim survives', async (t) => {
  if (!(await hasFfmpeg())) return t.skip('ffmpeg not installed');
  const dir = await mkdtemp(path.join(os.tmpdir(), 'wae-bars-'));
  try {
    // Pad, then blur the WHOLE frame: the bar's inner rows pick up art (a fade),
    // the art's outer rows darken — exactly what Topaz + Seedance produce.
    const input = await clip(dir, 'faded.mp4', 'pad=1280:720:60:180:black,gblur=sigma=6');
    const r = await stripResidualBars({ input, output: path.join(dir, 'out.mp4'), framed: false });
    assert.notEqual(r.path, input, 'faded bars must still be stripped');
    assert.deepEqual(r.rejected, [], `proof must not reject a faded bar: ${JSON.stringify(r)}`);
    const p = await ffmpeg.probe(r.path);
    // The blur moves the measured boundary a few px into the bar; what matters
    // is the result: inside the art's footprint and no dark rim (checked below).
    assert.ok(p.width <= 1200 && p.height <= 332, `strip must not leave bar: ${p.width}x${p.height}`);
    const rep = await edgeReport(r.path);
    assert.deepEqual(rep.lines, [], `dark rim left: ${JSON.stringify(rep.stats)}`);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('trimDarkEdgeLines: always trims the safety margin and keeps the file exactly at spec; a painted frame is excused', async (t) => {
  if (!(await hasFfmpeg())) return t.skip('ffmpeg not installed');
  const dir = await mkdtemp(path.join(os.tmpdir(), 'wae-bars-'));
  try {
    const clean = await clip(dir, 'clean.mp4', 'scale=1692:468', { size: '1692x468' });
    const c = await trimDarkEdgeLines({ input: clean, output: path.join(dir, 'out.mp4'), width: 1692, height: 468 });
    assert.deepEqual(c.cut, { top: EDGE_SAFETY_PX, bottom: EDGE_SAFETY_PX, left: EDGE_SAFETY_PX, right: EDGE_SAFETY_PX });
    assert.equal(c.fit, 'exact');
    const p = await ffmpeg.probe(c.path);
    assert.equal(p.width, 1692); assert.equal(p.height, 468);
    // 20px black frame all round: with the still's allowance only the safety margin goes; as borderless it is a bar.
    const framed = await clip(dir, 'framed.mp4', 'pad=1692:468:20:20:black', { size: '1652x428' });
    const allowancePx = { top: 20, bottom: 20, left: 20, right: 20 };
    const f = await trimDarkEdgeLines({ input: framed, output: path.join(dir, 'out2.mp4'), width: 1692, height: 468, allowancePx });
    assert.deepEqual(f.cut, { top: 2, bottom: 2, left: 2, right: 2 });
    const b = await trimDarkEdgeLines({ input: framed, output: path.join(dir, 'out3.mp4'), width: 1692, height: 468 });
    assert.ok(b.cut.top >= 20 + 8 && b.cut.left >= 20 + 20, JSON.stringify(b.cut));
    // Never more than 10% of an axis from one edge (a dark floor is not a bar), and it says so.
    const floor = await clip(dir, 'floor.mp4', 'pad=1692:468:0:0:black', { size: '1692x380' });
    const fl = await trimDarkEdgeLines({ input: floor, output: path.join(dir, 'out4.mp4'), width: 1692, height: 468 });
    assert.deepEqual(fl.capped, ['bottom']);
    assert.equal(fl.cut.bottom, 46);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

// 2026-10-27: the frame allowance comes from the APPROVED STILL, not from a
// guess over the video's own edges (that guess protected 16px of padding on
// three sides of a framed piece whose frame was thinner on one side).
test('planResidualStrip: a per-edge allowance from the still beats the second-smallest guess', () => {
  // Video: 40px frame + 8px residue bottom, 10px residue right, pop-out touching the top.
  const box = { x: 40, y: 0, width: 1910, height: 952 };
  const guess = planResidualStrip({ width: 2000, height: 1000, box, framed: true, overshoot: 0 });
  // The guess: second-smallest = 40 → strips bottom 8, right 10. Fine here...
  assert.deepEqual(guess.strip, { top: 0, bottom: 8, left: 0, right: 10 });
  // ...but with padding on three sides and no frame at the top it keeps padding:
  const lop = planResidualStrip({ width: 2000, height: 1000, box: { x: 56, y: 0, width: 1928, height: 980 }, framed: true, overshoot: 0 });
  assert.deepEqual(lop.strip, { top: 0, bottom: 4, left: 40, right: 0 }); // 16px kept on three sides
  // With the still's measured frame (none — a borderless still), everything goes:
  const truth = planResidualStrip({ width: 2000, height: 1000, box: { x: 56, y: 0, width: 1928, height: 980 }, framed: true, overshoot: 0, allowancePx: { top: 0, bottom: 0, left: 0, right: 0 } });
  assert.deepEqual(truth.strip, { top: 0, bottom: 20, left: 56, right: 16 });
  // And with a real 40px frame on the still, only the excess beyond it goes:
  const real = planResidualStrip({ width: 2000, height: 1000, box, framed: true, overshoot: 0, allowancePx: { top: 40, bottom: 40, left: 40, right: 40 } });
  assert.deepEqual(real.strip, { top: 0, bottom: 8, left: 0, right: 10 });
  assert.deepEqual(allowanceFromFractions({ top: 0.04, bottom: 0.04, left: 0.02, right: 0.02 }, { width: 2000, height: 1000 }), { top: 40, bottom: 40, left: 40, right: 40 });
  assert.equal(allowanceFromFractions(null, { width: 10, height: 10 }), undefined);
});

test('measureFrameFractions: reads the painted frame off a still; a borderless still measures zero', async (t) => {
  if (!(await hasFfmpeg())) return t.skip('ffmpeg not installed');
  const dir = await mkdtemp(path.join(os.tmpdir(), 'wae-bars-'));
  try {
    const framed = path.join(dir, 'framed.png');
    await execFileP('ffmpeg', ['-y', '-v', 'error', '-f', 'lavfi', '-i', 'testsrc2=s=1000x300', '-vf', 'pad=1100:400:50:50:black', '-frames:v', '1', framed]);
    const f = await measureFrameFractions(framed);
    for (const e of ['top', 'bottom']) assert.ok(Math.abs(f[e] - 50 / 400) < 0.01, `${e}: ${f[e]}`);
    for (const e of ['left', 'right']) assert.ok(Math.abs(f[e] - 50 / 1100) < 0.01, `${e}: ${f[e]}`);
    const plain = path.join(dir, 'plain.png');
    await execFileP('ffmpeg', ['-y', '-v', 'error', '-f', 'lavfi', '-i', 'testsrc2=s=1000x300', '-frames:v', '1', plain]);
    assert.deepEqual(await measureFrameFractions(plain), { top: 0, bottom: 0, left: 0, right: 0 });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

// 2026-10-27, the two REAL delivered files Shawn uploaded (3-second excerpts,
// full resolution, in test/fixtures). These are the failures every synthetic
// case missed:
//   real_drifting_bars — the picture drifts inside its canvas: pure-black
//     bottom/right edges in a third of the frames, full art in the rest. Any
//     whole-clip average sees "dark grey" and keeps it.
//   real_static_bar    — a steady 16-18px black band at the bottom with a
//     fade above it, and a 2px dark column on the right.
// The delivered-size pass must leave NO frame with a black edge, at spec.
for (const [name, want] of [
  ['real_drifting_bars_1692x468.mp4', { bottom: 18, right: 48 }],
  ['real_static_bar_1692x468.mp4', { bottom: 16, right: 2 }],
]) {
  test(`real file: ${name} ships with no black edge in any frame`, async (t) => {
    if (!(await hasFfmpeg())) return t.skip('ffmpeg not installed');
    const dir = await mkdtemp(path.join(os.tmpdir(), 'wae-bars-'));
    try {
      const input = path.join(FIXTURES, name);
      const before = await measureEdgeLines(input);
      assert.deepEqual(before.lines.sort(), ['bottom', 'right'], JSON.stringify(before));
      assert.ok(before.thickness.bottom >= want.bottom && before.thickness.right >= want.right, JSON.stringify(before.thickness));
      const r = await trimDarkEdgeLines({ input, output: path.join(dir, 'out.mp4'), width: 1692, height: 468 });
      assert.ok(r.cut.bottom >= want.bottom + 8 && r.cut.right >= want.right + 8, JSON.stringify(r.cut));
      assert.deepEqual(r.capped, []);
      const p = await ffmpeg.probe(r.path);
      assert.equal(p.width, 1692); assert.equal(p.height, 468);
      const after = await measureEdgeLines(r.path, { sampleFps: 8 });
      assert.deepEqual(after.lines, [], `black edge remains: ${JSON.stringify(after)}`);
      // And the old whole-clip audit agrees.
      const audit = await proveResidualBars(r.path, { framed: false });
      assert.equal(audit.plan, null);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
}
