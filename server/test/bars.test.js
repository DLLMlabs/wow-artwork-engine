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
  measureFrameFractions, allowanceFromFractions, edgeStrip,
} from '../src/services/bars.js';
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
  // Default overshoot: 0.4% of the axis, at least 4px.
  assert.equal(overshootFor(1000), 4);
  assert.equal(overshootFor(5120), 20);
  assert.equal(overshootFor(2880), 12);
  // The 2026-10-27 case: a 3px sliver right + 6px bottom on a 5120x1414 clip.
  const p = planResidualStrip({ width: 5120, height: 1414, box: { x: 0, y: 0, width: 5117, height: 1408 } });
  assert.deepEqual(p.strip, { top: 0, bottom: 6 + 6, left: 0, right: 3 + 20 });
  assert.deepEqual(p.crop, { x: 0, y: 0, width: 5096, height: 1402 });
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
    // Every measured bar is removed plus the overshoot into the art (5px on 1280, 4px on 720).
    assert.deepEqual(r.strip, { top: 184, bottom: 212, left: 65, right: 25 });
    assert.deepEqual(r.rejected, []);
    const p = await ffmpeg.probe(r.path);
    assert.equal(p.width, 1188); // 65 rounds UP to 66 (into the art), 1189 rounds DOWN
    assert.equal(p.height, 324);
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
    assert.deepEqual(r.strip, { top: 0, bottom: 104, left: 0, right: 0 });
    const p = await ffmpeg.probe(r.path);
    assert.equal(p.width, 1100);
    assert.equal(p.height, 396);
    // The same clip judged as borderless loses the frame too (that is the point).
    const b = await stripResidualBars({ input, output: path.join(dir, 'out2.mp4'), framed: false });
    assert.deepEqual(b.strip, { top: 54, bottom: 154, left: 54, right: 54 });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('stripResidualBars: dark art is NOT padding — a lit band survives proof, a grey edge is never detected', async (t) => {
  if (!(await hasFfmpeg())) return t.skip('ffmpeg not installed');
  const dir = await mkdtemp(path.join(os.tmpdir(), 'wae-bars-'));
  try {
    // Black bar on top with one bright speck in it (a star, a glint): the band
    // fails the max-luma proof and is kept; the clean bottom bar is removed.
    const lit = await clip(dir, 'lit.mp4', 'pad=1200:532:0:100:black,drawbox=x=600:y=40:w=6:h=6:color=white@1:t=fill');
    const r = await stripResidualBars({ input: lit, output: path.join(dir, 'out.mp4'), framed: false });
    assert.deepEqual(r.rejected, ['top']);
    assert.deepEqual(r.strip, { top: 0, bottom: 104, left: 0, right: 0 });
    const p = await ffmpeg.probe(r.path);
    assert.equal(p.height, 428);
    // A dark-grey (not black) edge is scenery, not a bar: nothing is stripped.
    const grey = await clip(dir, 'grey.mp4', 'pad=1200:532:0:100:0x404040');
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

test('trimDarkEdgeLines: a 1-2px dark rim at the delivered size is trimmed and the file stays exactly at spec', async (t) => {
  if (!(await hasFfmpeg())) return t.skip('ffmpeg not installed');
  const dir = await mkdtemp(path.join(os.tmpdir(), 'wae-bars-'));
  try {
    // Art 1689x466 with a 3px black sliver right + 2px bottom, scaled to the
    // 1692x468 spec the way a leftover sliver reaches the sign: a blended,
    // not-quite-black line that cropdetect cannot see.
    const input = await clip(dir, 'rim.mp4', 'pad=1692:468:0:0:black,scale=5120:1414,scale=1692:468', { size: '1689x466' });
    const before = await edgeReport(input);
    assert.ok(before.lines.includes('bottom') && before.lines.includes('right'), `expected rims before: ${JSON.stringify(before.stats)}`);
    const r = await trimDarkEdgeLines({ input, output: path.join(dir, 'out.mp4'), width: 1692, height: 468 });
    assert.notEqual(r.path, input);
    assert.ok(r.passes >= 1 && r.passes <= 3);
    assert.ok(r.trimmed.bottom > 0 && r.trimmed.right > 0 && r.trimmed.top === 0 && r.trimmed.left === 0, JSON.stringify(r.trimmed));
    const p = await ffmpeg.probe(r.path);
    assert.equal(p.width, 1692); assert.equal(p.height, 468);
    const after = await edgeReport(r.path);
    assert.deepEqual(after.lines, [], `rim remains: ${JSON.stringify(after.stats)}`);
    // A clean file is returned untouched (no re-encode).
    const clean = await clip(dir, 'clean.mp4', 'scale=1692:468', { size: '1692x468' });
    const c = await trimDarkEdgeLines({ input: clean, output: path.join(dir, 'out2.mp4'), width: 1692, height: 468 });
    assert.equal(c.path, clean);
    assert.equal(c.passes, 0);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('trimDarkEdgeLines: a uniform painted frame is NOT a line and is left alone', async (t) => {
  if (!(await hasFfmpeg())) return t.skip('ffmpeg not installed');
  const dir = await mkdtemp(path.join(os.tmpdir(), 'wae-bars-'));
  try {
    // 20px black frame all round at the delivered size. With the frame measured
    // on the still (allowance 20px) it is left alone; judged as borderless it is
    // a band like any other and goes (2026-10-27: the scan now sees bands, so
    // the allowance — not a guess — is what protects a painted frame).
    const input = await clip(dir, 'framed.mp4', 'pad=1692:468:20:20:black', { size: '1652x428' });
    const allowancePx = { top: 20, bottom: 20, left: 20, right: 20 };
    const r = await trimDarkEdgeLines({ input, output: path.join(dir, 'out.mp4'), width: 1692, height: 468, allowancePx });
    assert.equal(r.path, input);
    assert.equal(r.passes, 0);
    const b = await trimDarkEdgeLines({ input, output: path.join(dir, 'out2.mp4'), width: 1692, height: 468 });
    assert.ok(b.passes >= 1 && b.trimmed.top >= 20 && b.trimmed.left >= 20, JSON.stringify(b));
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

// 2026-10-27, second screenshot (Masquerade Carnival): the SAME L shape again
// — bottom and right — after the line fix. The bars are thicker than a 2px
// line (~8-16px at delivery) and dark grey, not black: the signature of a
// model padding its canvas at the bottom and right. The final pass now scans
// for a dark BAND beside bright art, up to 32px deep.
test('trimDarkEdgeLines: thick dark-grey bands on the bottom and right (model canvas padding) are removed at delivery', async (t) => {
  if (!(await hasFfmpeg())) return t.skip('ffmpeg not installed');
  const dir = await mkdtemp(path.join(os.tmpdir(), 'wae-bars-'));
  try {
    // 1676x458 art + 16px dark-grey band right, 10px bottom (0x2c2c2c ≈ luma 54:
    // too bright for the black proof, too thick for the 2px line check).
    const input = await clip(dir, 'bands.mp4', 'pad=1692:468:0:0:0x2c2c2c', { size: '1676x458' });
    const before = await measureEdgeLines(input);
    assert.deepEqual(before.lines.sort(), ['bottom', 'right'], JSON.stringify(before));
    assert.ok(before.thickness.right >= 14 && before.thickness.bottom >= 8, JSON.stringify(before.thickness));
    const r = await trimDarkEdgeLines({ input, output: path.join(dir, 'out.mp4'), width: 1692, height: 468 });
    assert.notEqual(r.path, input);
    assert.ok(r.trimmed.right >= 16 && r.trimmed.bottom >= 10 && r.trimmed.top === 0 && r.trimmed.left === 0, JSON.stringify(r.trimmed));
    const p = await ffmpeg.probe(r.path);
    assert.equal(p.width, 1692); assert.equal(p.height, 468);
    const after = await measureEdgeLines(r.path);
    assert.deepEqual(after.lines, [], `band remains: ${JSON.stringify(after)}`);
    // And the delivered edges are now art, not grey.
    for (const edge of ['bottom', 'right']) {
      const outer = await ffmpeg.regionStats(r.path, { ...edgeStrip({ edge, depth: 0, size: 2, width: 1692, height: 468 }) });
      assert.ok(outer.yavg > 80, `${edge} edge still dark: ${outer.yavg}`);
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('measureEdgeLines: a painted frame excused by the still-measured allowance; a dark scene edge is never a band', async (t) => {
  if (!(await hasFfmpeg())) return t.skip('ffmpeg not installed');
  const dir = await mkdtemp(path.join(os.tmpdir(), 'wae-bars-'));
  try {
    // 20px black frame all round: a band by measurement, excused by a 20px allowance.
    const framed = await clip(dir, 'framed.mp4', 'pad=1692:468:20:20:black', { size: '1652x428' });
    const seen = await measureEdgeLines(framed);
    assert.deepEqual(seen.lines.sort(), ['bottom', 'left', 'right', 'top']);
    const excused = await measureEdgeLines(framed, { allowancePx: { top: 20, bottom: 20, left: 20, right: 20 } });
    assert.deepEqual(excused.lines, []);
    // But a frame PLUS 12px of padding under it is still caught beyond the allowance.
    const framedPlus = await clip(dir, 'framedplus.mp4', 'pad=1672:448:20:20:black,pad=1692:468:0:0:0x2c2c2c', { size: '1632x408' });
    const beyond = await measureEdgeLines(framedPlus, { allowancePx: { top: 20, bottom: 20, left: 20, right: 20 } });
    assert.deepEqual(beyond.lines.sort(), ['bottom', 'right'], JSON.stringify(beyond));
    // A dark scene edge: the reference band is dark too, so nothing qualifies.
    const dusk = await clip(dir, 'dusk.mp4', 'drawbox=x=0:y=400:w=1692:h=68:color=0x202020@1:t=fill', { size: '1692x468' });
    const d = await measureEdgeLines(dusk);
    assert.deepEqual(d.lines, [], JSON.stringify(d));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
