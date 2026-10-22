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
  stripResidualBars, proveResidualBars, describeEdges,
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
  const plan = planResidualStrip({ width: 1280, height: 352, box: { x: 60, y: 0, width: 1200, height: 328 }, framed: false });
  assert.deepEqual(plan.strip, { top: 0, bottom: 24, left: 60, right: 20 });
  assert.deepEqual(plan.crop, { x: 60, y: 0, width: 1200, height: 328 });
  assert.equal(plan.allowance, 0);
  // Nothing to strip → null (the common good case: no re-encode).
  assert.equal(planResidualStrip({ width: 1280, height: 352, box: null }), null);
  assert.equal(planResidualStrip({ width: 1280, height: 352, box: { x: 0, y: 0, width: 1280, height: 352 } }), null);
});

test('planResidualStrip: framed piece keeps its uniform painted border, strips only the excess', () => {
  // Letterbox residue on a framed design: 150 top/bottom, 50 left/right.
  const lb = planResidualStrip({ width: 2000, height: 1000, box: { x: 50, y: 150, width: 1900, height: 700 }, framed: true });
  assert.equal(lb.allowance, 50);
  assert.deepEqual(lb.strip, { top: 100, bottom: 100, left: 0, right: 0 });
  assert.deepEqual(lb.crop, { x: 0, y: 100, width: 2000, height: 800 });
  // A pop-out that reaches ONE edge must not strip the frame from the other three.
  const pop = planResidualStrip({ width: 2000, height: 1000, box: { x: 50, y: 50, width: 1950, height: 900 }, framed: true });
  assert.equal(pop, null);
  // The same geometry on a borderless piece IS a residual bar.
  const bl = planResidualStrip({ width: 2000, height: 1000, box: { x: 50, y: 50, width: 1950, height: 900 }, framed: false });
  assert.deepEqual(bl.strip, { top: 50, bottom: 50, left: 50, right: 0 });
});

test('planResidualStrip: slivers are ignored, strips are capped, rejected edges are skipped', () => {
  // 2px of encoder rounding is not a bar.
  assert.equal(planResidualStrip({ width: 1000, height: 500, box: { x: 2, y: 0, width: 996, height: 500 } }), null);
  // Never more than 40% of an axis from one edge.
  const cap = planResidualStrip({ width: 1000, height: 500, box: { x: 0, y: 300, width: 1000, height: 200 } });
  assert.equal(cap.strip.top, 200);
  // An edge that failed proof (dark art, not padding) is left alone.
  const skip = planResidualStrip({ width: 1000, height: 500, box: { x: 100, y: 100, width: 800, height: 400 }, skipEdges: ['top'] });
  assert.deepEqual(skip.strip, { top: 0, bottom: 0, left: 100, right: 100 });
});

test('bandRegion: the band a strip removes, guarded on the content side', () => {
  assert.deepEqual(bandRegion({ edge: 'top', px: 100, width: 1280, height: 720 }), { x: 0, y: 0, width: 1280, height: 98 });
  assert.deepEqual(bandRegion({ edge: 'bottom', px: 100, width: 1280, height: 720 }), { x: 0, y: 622, width: 1280, height: 98 });
  assert.deepEqual(bandRegion({ edge: 'left', px: 60, width: 1280, height: 720 }), { x: 0, y: 0, width: 58, height: 720 });
  assert.deepEqual(bandRegion({ edge: 'right', px: 20, width: 1280, height: 720 }), { x: 1262, y: 0, width: 18, height: 720 });
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
    assert.deepEqual(r.strip, { top: 180, bottom: 208, left: 60, right: 20 });
    assert.deepEqual(r.rejected, []);
    const p = await ffmpeg.probe(r.path);
    assert.equal(p.width, 1200);
    assert.equal(p.height, 332);
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
    assert.deepEqual(r.strip, { top: 0, bottom: 100, left: 0, right: 0 });
    const p = await ffmpeg.probe(r.path);
    assert.equal(p.width, 1100);
    assert.equal(p.height, 400);
    // The same clip judged as borderless loses the frame too (that is the point).
    const b = await stripResidualBars({ input, output: path.join(dir, 'out2.mp4'), framed: false });
    assert.deepEqual(b.strip, { top: 50, bottom: 150, left: 50, right: 50 });
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
    assert.deepEqual(r.strip, { top: 0, bottom: 100, left: 0, right: 0 });
    const p = await ffmpeg.probe(r.path);
    assert.equal(p.height, 432);
    // A dark-grey (not black) edge is scenery, not a bar: nothing is stripped.
    const grey = await clip(dir, 'grey.mp4', 'pad=1200:532:0:100:0x404040');
    const g = await stripResidualBars({ input: grey, output: path.join(dir, 'out2.mp4'), framed: false });
    assert.equal(g.path, grey);
    assert.equal(g.strip, null);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
