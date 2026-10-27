import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { runWeek, animateRun, varyStill, tweakStill, allocateCost, addStills } from '../src/services/orchestrator.js';
import { keepArtwork, promoteArtwork } from '../src/services/keeper.js';
import { createMemoryRepo } from '../src/db/memoryRepo.js';
import { createLocalStore } from '../src/services/storage/local.js';
import { SURFACES } from '../src/services/generation/catalog.js';
import { motionProvider, stillProvider } from '../src/services/generation/fixture.js';
import { styleFor } from '../src/services/generation/prompts.js';
import ffmpeg from '../src/services/ffmpeg.js';
import { proveResidualBars, isFramedPrompt, measureEdgeLines } from '../src/services/bars.js';
import { rename } from 'node:fs/promises';

const execFileP = promisify(execFile);
async function hasFfmpeg() {
  try { await execFileP('ffmpeg', ['-version']); return true; } catch { return false; }
}
const providers = { mode: 'fixture', motion: motionProvider, still: stillProvider };

async function harness() {
  const base = await mkdtemp(path.join(os.tmpdir(), 'wae-orch-'));
  return { base, repo: createMemoryRepo(), store: createLocalStore({ baseDir: base }) };
}

// One fal call is billed once but recorded across the panel rows it produced.
// spend.js prices that call by SUMMING those rows, so the split must be exact —
// a rounding leak here silently mis-reports what the month cost.
test('allocateCost splits one fal bill across panels exactly, weighted by width', () => {
  const face = 1280;
  const spine = 320;
  // Compared at the ledger's own precision (4dp): re-summing floats carries a
  // ~1e-15 representation error that is not a real accounting difference.
  const sum = (parts) => Math.round(parts.reduce((a, b) => a + b, 0) * 1e4) / 1e4;

  const connected = allocateCost(11.4021, [spine, face, spine, face, spine, face]);
  assert.equal(connected.length, 6);
  assert.equal(sum(connected), 11.4021);
  // A face is 4x a spine, so it carries 4x the cost.
  assert.ok(Math.abs(connected[1] / connected[0] - 4) < 0.01);

  const single = allocateCost(11.4021, [spine, face]);
  assert.equal(sum(single), 11.4021);

  // An awkward total still lands exactly — the last panel absorbs the remainder.
  assert.equal(sum(allocateCost(10, [1, 1, 1])), 10);

  // Degenerate cases stay sane.
  assert.deepEqual(allocateCost(0, [320, 1280]), [0, 0]);
  assert.deepEqual(allocateCost(5, [1]), [5]);
});

test('Phase 1: runWeek generates one still per surface/option (nothing animated)', async (t) => {
  if (!(await hasFfmpeg())) return t.skip('ffmpeg not installed');
  const { base, repo, store } = await harness();
  try {
    const summary = await runWeek({
      weekOf: '2026-08-10', triggeredBy: 'test',
      deps: { repo, store, providers, optionsPerSurface: 1, duration: 1 },
    });
    assert.equal(summary.phase, 'stills');
    assert.equal(summary.status, 'complete');
    assert.equal(summary.counts.ready, 3); // spectacular + eon_connected + eon_single

    const stills = await repo.listArtworks(summary.runId);
    assert.equal(stills.length, 3);
    assert.ok(stills.every((a) => a.stage === 'still' && a.media_type === 'still' && a.status === 'ready'));
    assert.ok(stills.every((a) => a.prompt && a.motion_prompt), 'each still carries a still + motion prompt');

    // The still is a real image at its catalog generation size.
    const spec = stills.find((a) => a.style === 'frame_break');
    const gen = SURFACES.find((s) => s.style === 'frame_break').gen;
    const probed = await ffmpeg.probe(store.localPath(spec.s3_key_final));
    assert.equal(probed.width, gen.width);
    assert.equal(probed.height, gen.height);

    // Storyboard OFF (Shawn, 2026-08-10): no closing still is generated and
    // no end frame anchors the video — the motion prompt IS the full
    // three-movement arc, stored as the design's single motion prompt.
    assert.ok(!spec.closing_prompt && !spec.closing_key, 'no closing still on new designs');
    assert.equal(spec.motion_prompt_act2, null, 'new designs store the whole arc in one motion prompt');
    assert.match(spec.motion_prompt, /One single continuous take/);
    for (const eon of stills.filter((a) => a.style !== 'frame_break')) {
      assert.ok(!eon.closing_key && !eon.motion_prompt_act2, `${eon.style} has no storyboard`);
    }
  } finally {
    await rm(base, { recursive: true, force: true });
  }
});

test('Phase 2: animateRun animates ONLY approved stills, conformed to spec, linked back', async (t) => {
  if (!(await hasFfmpeg())) return t.skip('ffmpeg not installed');
  const { base, repo, store } = await harness();
  try {
    const { runId } = await runWeek({ weekOf: '2026-08-10', triggeredBy: 'test', deps: { repo, store, providers, optionsPerSurface: 1, duration: 1 } });
    const stills = await repo.listArtworks(runId);
    for (const s of stills) await repo.updateArtwork(s.id, { status: 'approved' }); // approve all 3

    const summary = await animateRun({ runId, deps: { repo, store, providers, duration: 1 } });
    // spectacular 1 + eon_single (spine + face) 2 + eon_connected (3 pods x
    // spine + face) 6 = 9 motion artworks.
    assert.equal(summary.counts.ready, 9);

    const all = await repo.listArtworks(runId);
    const motions = all.filter((a) => a.stage === 'motion');
    assert.equal(motions.length, 9);
    assert.ok(motions.every((m) => m.media_type === 'video' && m.status === 'ready' && m.source_still_id));

    // Motions are conformed to the exact sign specs.
    const spec = motions.find((m) => m.style === 'frame_break');
    let p = await ffmpeg.probe(store.localPath(spec.s3_key_final));
    assert.equal(p.width, 1692); assert.equal(p.height, 468); // Jeff, 2026-10-21
    // The spectacular renders its configured TOTAL length in one call
    // (production: config.spectacularDurationS; the test script pins
    // GEN_SPECTACULAR_DURATION_S=2 so fixtures stay fast). EON clips use the
    // injected base duration (~1s).
    assert.ok((p.duration ?? 0) > 1.5, `spectacular should run its full 2s, got ${p.duration}s`);
    assert.equal(spec.duration_s, 2);
    // Every EON row is cut to its panel's spec and labelled with which panel
    // of which pod it drives — that label is what routes the file to Jeff.
    const eon = motions.filter((m) => m.surface === 'eon');
    assert.deepEqual(
      eon.filter((m) => m.style === 'eon_connected').map((m) => m.panel),
      ['pod1_spine', 'pod1_face', 'pod2_spine', 'pod2_face', 'pod3_spine', 'pod3_face'],
    );
    assert.deepEqual(
      eon.filter((m) => m.style === 'eon_single').map((m) => m.panel),
      ['pod1_spine', 'pod1_face'],
    );
    for (const panel of eon) {
      p = await ffmpeg.probe(store.localPath(panel.s3_key_final));
      // Panel-native per Jeff (2026-08-21): spine 64x384, face 256x384.
      const want = panel.panel.endsWith('spine') ? 64 : 256;
      assert.equal(p.width, want, `${panel.style}/${panel.panel} width`);
      assert.equal(p.height, 384);
      assert.equal(panel.spec_key, panel.panel.endsWith('spine') ? 'eon_spine' : 'eon_face');
    }
    // One sequence per wrapped master (connected + single). The connected one
    // records all six panels it produced; the single records its one pod.
    const sequences = await repo.listEonSequences(runId);
    assert.equal(sequences.length, 2);
    const connectedSeq = sequences.find((s) => s.face3_artwork_id);
    for (const col of ['face1', 'face2', 'face3', 'spine1', 'spine2', 'spine3']) {
      assert.ok(connectedSeq[`${col}_artwork_id`], `sequence is missing ${col}`);
    }
    const singleSeq = sequences.find((s) => !s.face3_artwork_id);
    assert.ok(singleSeq.face1_artwork_id && singleSeq.spine1_artwork_id);

    // Idempotent: re-animating produces nothing new.
    const again = await animateRun({ runId, deps: { repo, store, providers, duration: 1 } });
    assert.equal(again.counts.ready, 0);
  } finally {
    await rm(base, { recursive: true, force: true });
  }
});

test('spectacular single pass: ONE call, full arc prompt, NO end-frame anchor', async (t) => {
  if (!(await hasFfmpeg())) return t.skip('ffmpeg not installed');
  const { base, repo, store } = await harness();
  const calls = [];
  const spying = {
    mode: 'fixture',
    still: stillProvider,
    motion: { ...motionProvider, generate: (args) => { calls.push(args); return motionProvider.generate(args); } },
  };
  const spectacularOnly = SURFACES.filter((s) => s.key === 'spectacular');
  try {
    const { runId } = await runWeek({ weekOf: '2026-08-10', triggeredBy: 'test', deps: { repo, store, providers: spying, surfaces: spectacularOnly, optionsPerSurface: 1, duration: 1 } });
    const [still] = await repo.listArtworks(runId);
    // Pin a legacy closing URL on the row to prove it is deliberately IGNORED
    // (Shawn, 2026-08-10: the end-frame anchor made motion feel obligated).
    await repo.updateArtwork(still.id, { status: 'approved', closingRemoteUrl: 'https://fal.example/closing.png' });

    await animateRun({ runId, deps: { repo, store, providers: spying, duration: 1 } });
    assert.equal(calls.length, 1, 'the whole piece must render in a single Seedance call');
    const [call] = calls;
    assert.equal(call.durationS, 2, 'single pass runs the surface total (test-pinned 2s)');
    assert.match(call.prompt, /One single continuous take/, 'the stored minimal prompt drives the call');
    assert.match(call.prompt, /no cuts, no shot changes/);
    assert.equal(call.endImageUrl ?? null, null, 'no end frame is sent — even when a legacy closing still exists');
  } finally {
    await rm(base, { recursive: true, force: true });
  }
});

test('legacy rows (stored act 1 + act 2) still animate: acts joined into one single-pass prompt', async (t) => {
  if (!(await hasFfmpeg())) return t.skip('ffmpeg not installed');
  const { base, repo, store } = await harness();
  const calls = [];
  const spying = {
    mode: 'fixture',
    still: stillProvider,
    motion: { ...motionProvider, generate: (args) => { calls.push(args); return motionProvider.generate(args); } },
  };
  const spectacularOnly = SURFACES.filter((s) => s.key === 'spectacular');
  try {
    const { runId } = await runWeek({ weekOf: '2026-08-10', triggeredBy: 'test', deps: { repo, store, providers: spying, surfaces: spectacularOnly, optionsPerSurface: 1, duration: 1 } });
    const [still] = await repo.listArtworks(runId);
    // Rewrite the row into the pre-2.5 shape: act 1 as the motion prompt, a
    // separate stored act 2 (what every row generated before 2026-08-10 has).
    await repo.updateArtwork(still.id, {
      status: 'approved',
      motionPrompt: 'LEGACY ACT ONE motion prompt',
      motionPromptAct2: 'LEGACY ACT TWO motion prompt',
    });

    await animateRun({ runId, deps: { repo, store, providers: spying, duration: 1 } });
    assert.equal(calls.length, 1, 'legacy rows still render in one call — never chained');
    const [call] = calls;
    assert.match(call.prompt, /LEGACY ACT ONE/);
    assert.match(call.prompt, /LEGACY ACT TWO/, 'the stored act 2 must ride along');
    assert.match(call.prompt, /no cut or pause/, 'the acts are bridged, not concatenated bare');
  } finally {
    await rm(base, { recursive: true, force: true });
  }
});

test('guardrail blocks the MOTION spend before Seedance is ever called', async (t) => {
  if (!(await hasFfmpeg())) return t.skip('ffmpeg not installed');
  const { base, repo, store } = await harness();
  const exploding = {
    mode: 'fixture',
    still: stillProvider, // Phase 1 still is allowed
    motion: { model: 'boom', generate: async () => { throw new Error('should not spend'); } },
  };
  // Motion prompts contain "motion"; still prompts don't — use that to block
  // only the Seedance (motion) spend.
  const blockMotion = {
    checkPrompt: (p) => (/\bmotion\b/i.test(p) ? { allowed: false, reasons: ['test motion block'] } : { allowed: true, reasons: [] }),
    reviewArtwork: async () => ({ allowed: true, reasons: [] }),
  };
  try {
    const spectacularOnly = SURFACES.filter((s) => s.key === 'spectacular');
    const { runId } = await runWeek({ weekOf: '2026-08-10', triggeredBy: 'test', deps: { repo, store, providers: exploding, surfaces: spectacularOnly, optionsPerSurface: 1, duration: 1 } });
    const [still] = await repo.listArtworks(runId);
    await repo.updateArtwork(still.id, { status: 'approved' });

    const summary = await animateRun({ runId, deps: { repo, store, providers: exploding, guardrails: blockMotion, duration: 1 } });
    assert.equal(summary.counts.blocked, 1);
    assert.equal(summary.counts.ready, 0);
    // No motion produced, and the recorded error is the guardrail — not a provider spend.
    const motions = (await repo.listArtworks(runId)).filter((a) => a.stage === 'motion');
    assert.equal(motions.length, 0);
    const updated = await repo.getArtwork(still.id);
    assert.match(updated.error, /motion guardrail/);
    assert.doesNotMatch(updated.error || '', /should not spend/);
  } finally {
    await rm(base, { recursive: true, force: true });
  }
});

test('Phase 1 guardrail blocks a still prompt before the still spend', async (t) => {
  const { base, repo, store } = await harness();
  const explodingStill = {
    mode: 'fixture',
    still: { model: 'boom', generate: async () => { throw new Error('should not spend') } },
    motion: motionProvider,
  };
  const blockAll = { checkPrompt: () => ({ allowed: false, reasons: ['nudity'] }), reviewArtwork: async () => ({ allowed: true, reasons: [] }) };
  try {
    const summary = await runWeek({
      weekOf: '2026-08-10', triggeredBy: 'test',
      deps: { repo, store, providers: explodingStill, guardrails: blockAll, surfaces: SURFACES.filter((s) => s.key === 'spectacular'), optionsPerSurface: 1, duration: 1 },
    });
    assert.equal(summary.counts.blocked, 1);
    const [a] = await repo.listArtworks(summary.runId);
    assert.equal(a.status, 'failed');
    assert.match(a.error, /guardrail/);
    assert.doesNotMatch(a.error, /should not spend/);
  } finally {
    await rm(base, { recursive: true, force: true });
  }
});

// Scott's case (2026-07-26): he likes all 3 Spectacular designs and wants to
// see a 4th. regenerateStills is the wrong tool — it REPLACES, and refuses
// outright once everything is saved or approved.
test('addStills: appends a 4th design to one surface, retiring nothing', async (t) => {
  if (!(await hasFfmpeg())) return t.skip('ffmpeg not installed');
  const { base, repo, store } = await harness();
  try {
    const { runId } = await runWeek({
      weekOf: '2026-08-10', triggeredBy: 'test',
      deps: { repo, store, providers, optionsPerSurface: 3, duration: 1 },
    });
    const before = await repo.listArtworks(runId);
    const specBefore = before.filter((a) => a.style === 'frame_break');
    assert.equal(specBefore.length, 3);
    // Everything is spoken for — approved, saved, or both. regenerate would
    // refuse here; adding must not care.
    await repo.updateArtwork(specBefore[0].id, { status: 'approved' });
    await repo.addSelection(specBefore[1].id, 'scott@wow');
    // Baseline AFTER that setup — this is the state the add must not disturb.
    const untouched = (await repo.listArtworks(runId)).filter((a) => a.style === 'frame_break');

    const summary = await addStills({
      runId, surfaceKey: 'spectacular',
      deps: { repo, store, providers, optionsPerSurface: 3, duration: 1 },
    });
    assert.equal(summary.status, 'complete');
    assert.equal(summary.added, 1);

    const after = await repo.listArtworks(runId);
    const specAfter = after.filter((a) => a.style === 'frame_break');
    assert.equal(specAfter.length, 4, 'the surface should now hold four designs');
    // NOTHING was retired — every original row is byte-for-byte untouched.
    for (const a of untouched) {
      assert.deepEqual(await repo.getArtwork(a.id), a, `design ${a.id} must be untouched`);
    }
    // The 4th is a genuinely different piece, not a re-roll of one of the three.
    const fresh = specAfter.find((a) => !specBefore.some((b) => b.id === a.id));
    assert.equal(fresh.status, 'ready');
    for (const a of specBefore) assert.notEqual(fresh.prompt, a.prompt);
    // It took the next free slot, so its theme is seeded off option 4.
    assert.match(fresh.s3_key_final, /\/opt4\//);
    // Other surfaces never moved.
    for (const a of before.filter((x) => x.style !== 'frame_break')) {
      assert.deepEqual(await repo.getArtwork(a.id), a, `surface ${a.style} must be untouched`);
    }
    assert.equal((await repo.getRun(runId)).status, 'complete');

    // Clicking again keeps climbing rather than colliding with slot 4.
    await addStills({ runId, surfaceKey: 'spectacular', deps: { repo, store, providers, optionsPerSurface: 3, duration: 1 } });
    const five = (await repo.listArtworks(runId)).filter((a) => a.style === 'frame_break');
    assert.equal(five.length, 5);
    assert.equal(new Set(five.map((a) => a.s3_key_final)).size, 5, 'every design needs its own file');
  } finally {
    await rm(base, { recursive: true, force: true });
  }
});

// Regression (2026-07-26): a variation used to be stored under its SOURCE's
// key, so exploring silently overwrote the picture of the design you kept —
// "the original is never lost" was true of the row and false of the pixels.
test('a variation never overwrites the design it came from', async (t) => {
  if (!(await hasFfmpeg())) return t.skip('ffmpeg not installed');
  const { base, repo, store } = await harness();
  try {
    const only = SURFACES.filter((s) => s.key === 'spectacular');
    const deps = { repo, store, providers, surfaces: only, optionsPerSurface: 2, duration: 1 };
    const { runId } = await runWeek({ weekOf: '2026-08-10', triggeredBy: 'test', deps });
    const source = (await repo.listArtworks(runId))[0];
    const beforeBytes = await store.getBuffer(source.s3_key_final);

    await keepArtwork({ artworkId: source.id, repo });
    await varyStill({ artworkId: source.id, deps });

    const after = await repo.listArtworks(runId);
    const variation = after.find((a) => a.parent_artwork_id === source.id);
    const sourceNow = after.find((a) => a.id === source.id);
    assert.notEqual(sourceNow.s3_key_final, variation.s3_key_final, 'each design needs its own file');
    assert.deepEqual(await store.getBuffer(sourceNow.s3_key_final), beforeBytes, 'the kept design must be byte-identical');
    // The slot is still recoverable from the key (regen parses it back out).
    assert.match(variation.s3_key_final, /\/opt\d+\//);
  } finally {
    await rm(base, { recursive: true, force: true });
  }
});

test('regenerateStills: fresh options for ONE surface only, approved kept, new prompts', async (t) => {
  if (!(await hasFfmpeg())) return t.skip('ffmpeg not installed');
  const { base, repo, store } = await harness();
  try {
    const { runId } = await runWeek({
      weekOf: '2026-08-10', triggeredBy: 'test',
      deps: { repo, store, providers, optionsPerSurface: 2, duration: 1 },
    });
    const before = await repo.listArtworks(runId);
    const eonBefore = before.filter((a) => a.style === 'eon_single');
    const otherBefore = before.filter((a) => a.style !== 'eon_single');
    // Approve one EON single — it must survive the regenerate untouched.
    await repo.updateArtwork(eonBefore[0].id, { status: 'approved' });

    const { regenerateStills } = await import('../src/services/orchestrator.js');
    const summary = await regenerateStills({
      runId, surfaceKey: 'eon_single',
      deps: { repo, store, providers, optionsPerSurface: 2, duration: 1 },
    });
    assert.equal(summary.status, 'complete');
    // Only the ONE retired slot is refilled — the section must not balloon
    // past optionsPerSurface just because a design was kept.
    assert.equal(summary.counts.ready, 1);

    const after = await repo.listArtworks(runId);
    // Approved still kept, unapproved retired (hidden), 1 fresh one ready.
    assert.equal((await repo.getArtwork(eonBefore[0].id)).status, 'approved');
    assert.equal((await repo.getArtwork(eonBefore[1].id)).status, 'superseded');
    const fresh = after.filter((a) => a.style === 'eon_single' && a.status === 'ready');
    assert.equal(fresh.length, 1);
    // The salt gives a DIFFERENT prompt — not a rebuild of the retired design.
    assert.notEqual(fresh[0].prompt, eonBefore[1].prompt);
    // Other surfaces are completely untouched.
    for (const a of otherBefore) {
      assert.deepEqual(await repo.getArtwork(a.id), a, `surface ${a.style} must be untouched`);
    }
    // Run is reviewable again.
    assert.equal((await repo.getRun(runId)).status, 'complete');
  } finally {
    await rm(base, { recursive: true, force: true });
  }
});

test('regenerateStills: saved designs survive and only unsaved slots are replaced', async (t) => {
  if (!(await hasFfmpeg())) return t.skip('ffmpeg not installed');
  const { base, repo, store } = await harness();
  try {
    const { runId } = await runWeek({
      weekOf: '2026-08-10', triggeredBy: 'test',
      deps: { repo, store, providers, optionsPerSurface: 2, duration: 1 },
    });
    const eonBefore = (await repo.listArtworks(runId)).filter((a) => a.style === 'eon_single');
    // Save (bookmark) one — no approval, just "keep this while I re-roll".
    await repo.addSelection(eonBefore[0].id, 'reviewer@wow');
    const saved = await repo.getArtwork(eonBefore[0].id);
    const unsaved = eonBefore[1];

    const { regenerateStills } = await import('../src/services/orchestrator.js');
    const summary = await regenerateStills({
      runId, surfaceKey: 'eon_single',
      deps: { repo, store, providers, optionsPerSurface: 2, duration: 1 },
    });
    assert.equal(summary.status, 'complete');
    assert.equal(summary.counts.ready, 1);

    // Saved card is byte-for-byte untouched; only the unsaved one was retired.
    assert.deepEqual(await repo.getArtwork(saved.id), saved);
    assert.equal((await repo.getArtwork(unsaved.id)).status, 'superseded');

    // Exactly one fresh design, and it fills the retired card's option slot.
    const fresh = (await repo.listArtworks(runId))
      .filter((a) => a.style === 'eon_single' && a.status === 'ready' && a.id !== saved.id);
    assert.equal(fresh.length, 1);
    const slot = (k) => /\/opt(\d+)\//.exec(k)?.[1];
    assert.equal(slot(fresh[0].s3_key_final), slot(unsaved.s3_key_final), 'replacement fills the retired slot');

    // Everything now saved/approved → regenerate has nothing to do and says so
    // BEFORE touching the run (it must stay reviewable, not flip to running).
    await repo.updateArtwork(fresh[0].id, { status: 'approved' });
    await assert.rejects(
      () => regenerateStills({ runId, surfaceKey: 'eon_single', deps: { repo, store, providers, optionsPerSurface: 2, duration: 1 } }),
      /saved or approved/,
    );
    assert.equal((await repo.getRun(runId)).status, 'complete');
  } finally {
    await rm(base, { recursive: true, force: true });
  }
});

test('regenerateStill: replaces ONE design only — siblings, other signs, approved all untouched', async (t) => {
  if (!(await hasFfmpeg())) return t.skip('ffmpeg not installed');
  const { base, repo, store } = await harness();
  try {
    const { runId } = await runWeek({
      weekOf: '2026-08-10', triggeredBy: 'test',
      deps: { repo, store, providers, optionsPerSurface: 2, duration: 1 },
    });
    const before = await repo.listArtworks(runId);
    const eonBefore = before.filter((a) => a.style === 'eon_single');
    const others = before.filter((a) => a.style !== 'eon_single');
    const target = eonBefore[1];
    const sibling = eonBefore[0];

    const { regenerateStill } = await import('../src/services/orchestrator.js');
    const summary = await regenerateStill({
      artworkId: target.id,
      deps: { repo, store, providers, optionsPerSurface: 2, duration: 1 },
    });
    assert.equal(summary.status, 'complete');
    assert.equal(summary.counts.ready, 1);

    // Target retired; its SIBLING option is untouched (the whole point).
    assert.equal((await repo.getArtwork(target.id)).status, 'superseded');
    assert.deepEqual(await repo.getArtwork(sibling.id), sibling);
    for (const a of others) assert.deepEqual(await repo.getArtwork(a.id), a);

    // Exactly one fresh design, in the retired card's option slot, new theme.
    const after = await repo.listArtworks(runId);
    const fresh = after.filter((a) => a.style === 'eon_single' && a.status === 'ready' && a.id !== sibling.id);
    assert.equal(fresh.length, 1);
    assert.notEqual(fresh[0].prompt, target.prompt, 'salted seed must not rebuild the retired design');
    const slot = (k) => /\/opt(\d+)\//.exec(k)?.[1];
    assert.equal(slot(fresh[0].s3_key_final), slot(target.s3_key_final), 'replacement fills the same option slot');

    // Guards: non-stills and already-replaced cards are refused.
    await assert.rejects(() => regenerateStill({ artworkId: target.id, deps: { repo, store, providers } }), /already replaced/);
    assert.equal((await repo.getRun(runId)).status, 'complete');
  } finally {
    await rm(base, { recursive: true, force: true });
  }
});

test('varyStill: re-rolls the stored prompt into a new same-family still; source untouched', async (t) => {
  if (!(await hasFfmpeg())) return t.skip('ffmpeg not installed');
  const { base, repo, store } = await harness();
  try {
    const { runId } = await runWeek({
      weekOf: '2026-08-10', triggeredBy: 'test',
      deps: { repo, store, providers, optionsPerSurface: 1, duration: 1 },
    });
    const source = (await repo.listArtworks(runId)).find((a) => a.style === 'eon_single');
    const srcBefore = { ...source };

    const summary = await varyStill({ artworkId: source.id, deps: { repo, store, providers, duration: 1 } });
    assert.equal(summary.status, 'complete');
    assert.equal(summary.counts.ready, 1);

    const variation = (await repo.listArtworks(runId)).find((a) => a.parent_artwork_id === source.id);
    assert.ok(variation, 'a variation row was created');
    assert.equal(variation.stage, 'still');
    assert.equal(variation.status, 'ready');
    assert.equal(variation.style, source.style, 'same style as the source');
    assert.equal(variation.family_id, source.id, 'joins the (bootstrapped) family');
    assert.equal(variation.parent_artwork_id, source.id);
    assert.equal(variation.prompt, srcBefore.prompt, 're-roll reuses the stored prompt verbatim');
    assert.equal(variation.motion_prompt, srcBefore.motion_prompt, 'motion prompt preserved');
    assert.equal(variation.change_note, null, 'a re-roll writes no change note');

    // Source untouched except the family bootstrap (family_id = its own id).
    const srcAfter = await repo.getArtwork(source.id);
    assert.equal(srcAfter.status, 'ready');
    assert.equal(srcAfter.prompt, srcBefore.prompt);
    assert.equal(srcAfter.family_id, source.id);
    assert.equal((await repo.getRun(runId)).status, 'complete');
  } finally {
    await rm(base, { recursive: true, force: true });
  }
});

test('tweakStill: LLM-edited prompt + change note, refiner injected (offline)', async (t) => {
  if (!(await hasFfmpeg())) return t.skip('ffmpeg not installed');
  const { base, repo, store } = await harness();
  try {
    const { runId } = await runWeek({
      weekOf: '2026-08-10', triggeredBy: 'test',
      deps: { repo, store, providers, optionsPerSurface: 1, duration: 1 },
    });
    const source = (await repo.listArtworks(runId)).find((a) => a.style === 'eon_single');

    // Injected refiner — proves the tweak path runs with NO network.
    const refineTweak = async ({ prompt, instruction }) => ({ prompt: `${prompt} EDIT:${instruction}`, changeNote: `did ${instruction}` });
    const summary = await tweakStill({
      artworkId: source.id, instruction: 'make it teal',
      deps: { repo, store, providers, duration: 1, refineTweak },
    });
    assert.equal(summary.status, 'complete');
    assert.equal(summary.counts.ready, 1);

    const variation = (await repo.listArtworks(runId)).find((a) => a.parent_artwork_id === source.id);
    assert.ok(variation.prompt.includes('EDIT:make it teal'), 'the LLM-edited prompt was used');
    assert.notEqual(variation.prompt, source.prompt, 'a tweak changes the prompt');
    assert.equal(variation.change_note, 'did make it teal', 'change note stored');
    assert.equal(variation.family_id, source.id);
    assert.equal(variation.parent_artwork_id, source.id);
    assert.equal(variation.style, source.style);
  } finally {
    await rm(base, { recursive: true, force: true });
  }
});

test('keep + vary: a family of three has exactly one keeper; promote moves it', async (t) => {
  if (!(await hasFfmpeg())) return t.skip('ffmpeg not installed');
  const { base, repo, store } = await harness();
  try {
    const { runId } = await runWeek({
      weekOf: '2026-08-10', triggeredBy: 'test',
      deps: { repo, store, providers, optionsPerSurface: 1, duration: 1 },
    });
    const A = (await repo.listArtworks(runId)).find((a) => a.style === 'eon_single');

    // Keep A, then vary it twice → a family of 3 (A + two variations).
    await keepArtwork({ artworkId: A.id, repo });
    await varyStill({ artworkId: A.id, deps: { repo, store, providers, duration: 1 } });
    await varyStill({ artworkId: A.id, deps: { repo, store, providers, duration: 1 } });
    const family = (await repo.listArtworks(runId)).filter((x) => x.family_id === A.id && x.status !== 'superseded');
    assert.equal(family.length, 3, 'anchor + two variations share the family');

    // Keep one variation → it is the sole keeper; A (and the sibling) are demoted.
    const variation = family.find((x) => x.parent_artwork_id === A.id);
    await keepArtwork({ artworkId: variation.id, repo });
    let picks = (await repo.listSelections(runId)).filter((s) => family.some((f) => f.id === s.artwork_id));
    assert.deepEqual(picks.map((s) => s.artwork_id), [variation.id], 'exactly one keeper in the family');

    // Promote the original back → keeper moves to A; both still exist.
    await promoteArtwork({ artworkId: A.id, repo });
    picks = (await repo.listSelections(runId)).filter((s) => family.some((f) => f.id === s.artwork_id));
    assert.deepEqual(picks.map((s) => s.artwork_id), [A.id]);
    assert.ok(await repo.getArtwork(variation.id), 'the variation is never lost');
  } finally {
    await rm(base, { recursive: true, force: true });
  }
});

test('regenerateStills skips variations: a surface re-roll retires unsaved siblings but never the family', async (t) => {
  if (!(await hasFfmpeg())) return t.skip('ffmpeg not installed');
  const { base, repo, store } = await harness();
  try {
    // Two eon_single stills: A (kept + varied) and S (an unsaved sibling).
    const { runId } = await runWeek({
      weekOf: '2026-08-10', triggeredBy: 'test',
      deps: { repo, store, providers, optionsPerSurface: 2, duration: 1 },
    });
    const eon = (await repo.listArtworks(runId)).filter((a) => a.style === 'eon_single');
    const A = eon[0];
    const S = eon[1];
    await keepArtwork({ artworkId: A.id, repo });
    await varyStill({ artworkId: A.id, deps: { repo, store, providers, duration: 1 } });
    const B = (await repo.listArtworks(runId)).find((a) => a.parent_artwork_id === A.id);
    const bBefore = await repo.getArtwork(B.id);

    const { regenerateStills } = await import('../src/services/orchestrator.js');
    const summary = await regenerateStills({
      runId, surfaceKey: 'eon_single',
      deps: { repo, store, providers, optionsPerSurface: 2, duration: 1 },
    });
    assert.equal(summary.status, 'complete');

    // Only the unsaved sibling S is retired; the kept anchor A and the variation
    // B both survive (B byte-for-byte untouched).
    assert.equal((await repo.getArtwork(S.id)).status, 'superseded');
    assert.equal((await repo.getArtwork(A.id)).status, 'ready', 'kept anchor untouched');
    assert.deepEqual(await repo.getArtwork(B.id), bBefore, 'variation untouched by the surface re-roll');
  } finally {
    await rm(base, { recursive: true, force: true });
  }
});

test('run progress: runWeek and animateRun record phase/done/total for the dashboard', async (t) => {
  if (!(await hasFfmpeg())) return t.skip('ffmpeg not installed');
  const { base, repo, store } = await harness();
  try {
    const seen = [];
    const spyRepo = { ...repo, setRunProgress: async (id, p) => { seen.push({ ...p }); return repo.setRunProgress(id, p); } };
    const { runId } = await runWeek({
      weekOf: '2026-08-10', triggeredBy: 'test',
      deps: { repo: spyRepo, store, providers, optionsPerSurface: 1, duration: 1 },
    });
    // designs 0/3 … 3/3, monotonically.
    const designs = seen.filter((p) => p.phase === 'designs');
    assert.equal(designs[0].done, 0);
    assert.equal(designs.at(-1).done, 3);
    assert.equal(designs.at(-1).total, 3);
    assert.deepEqual((await repo.getRun(runId)).progress, { phase: 'designs', done: 3, total: 3 });

    // Animate one approved still → videos 0/1 … 1/1.
    const stills = await repo.listArtworks(runId);
    await repo.updateArtwork(stills.find((a) => a.style === 'eon_single').id, { status: 'approved' });
    seen.length = 0;
    await animateRun({ runId, deps: { repo: spyRepo, store, providers, duration: 1 } });
    const videos = seen.filter((p) => p.phase === 'videos');
    assert.equal(videos[0].done, 0);
    assert.deepEqual(videos.at(-1), { phase: 'videos', done: 1, total: 1 });
  } finally {
    await rm(base, { recursive: true, force: true });
  }
});

test('story director: the motion prompt is written from the ACTUAL still when a director runs', async (t) => {
  if (!(await hasFfmpeg())) return t.skip('ffmpeg not installed');
  const { base, repo, store } = await harness();
  const seen = [];
  // A still provider that (unlike the fixture) reports a hosted URL, so the
  // director step has an image to look at.
  const urlStill = {
    ...stillProvider,
    generate: async (args) => ({ ...(await stillProvider.generate(args)), url: 'https://fal.example/still.png' }),
  };
  const providersWithUrl = { mode: 'fixture', still: urlStill, motion: motionProvider };
  const directStory = async ({ imageUrl, framed }) => {
    seen.push({ imageUrl, framed });
    return 'THE DIRECTED SHARK STORY: the shark hunts the fish through the painted seaweed';
  };
  const spectacularOnly = SURFACES.filter((s) => s.key === 'spectacular');
  try {
    const { runId } = await runWeek({
      weekOf: '2026-08-17', triggeredBy: 'test',
      deps: { repo, store, providers: providersWithUrl, surfaces: spectacularOnly, optionsPerSurface: 2, duration: 1, directStory },
    });
    const stills = await repo.listArtworks(runId);
    // Split tracks (2026-08-18): the director is shown every generated still,
    // and told which track it is directing — option 1 framed, options 2+ not.
    assert.deepEqual(seen, [
      { imageUrl: 'https://fal.example/still.png', framed: true },
      { imageUrl: 'https://fal.example/still.png', framed: false },
    ], 'the director is shown each generated still with its track');
    for (const still of stills) {
      assert.match(still.motion_prompt, /THE DIRECTED SHARK STORY/, 'the directed story drives the motion prompt');
      // The fixed contract still wraps the directed story.
      assert.match(still.motion_prompt, /One single continuous take/);
      assert.match(still.motion_prompt, /Every character is in motion at every single moment/);
      assert.ok(still.motion_prompt.startsWith('Fixed camera, locked-off shot:'));
    }
    // The wrapped contract matches the track. (Artwork rows carry no option
    // column — the framed track is recognizable by its painted-border still.)
    const framedStill = stills.find((a) => /matte-black/.test(a.prompt));
    const borderless = stills.find((a) => !/matte-black/.test(a.prompt));
    assert.match(framedStill.motion_prompt, /IN FRONT of the frame/);
    assert.doesNotMatch(borderless.motion_prompt, /IN FRONT of the frame/);
    assert.match(borderless.motion_prompt, /Maximum intensity/);
  } finally {
    await rm(base, { recursive: true, force: true });
  }
});

test('every design in a batch carries its own rolled style label, and they differ', async (t) => {
  if (!(await hasFfmpeg())) return t.skip('ffmpeg not installed');
  const { base, repo, store } = await harness();
  const spectacularOnly = SURFACES.filter((s) => s.key === 'spectacular');
  try {
    const { runId } = await runWeek({
      weekOf: '2026-08-17', triggeredBy: 'test',
      deps: { repo, store, providers, surfaces: spectacularOnly, optionsPerSurface: 3, duration: 1 },
    });
    const stills = await repo.listArtworks(runId);
    assert.equal(stills.length, 3);
    // Every design is randomized now (2026-09-08) — no surface has a default
    // style, so every card carries a label for its badge.
    assert.equal(stills.filter((a) => a.theme_label).length, 3, 'all three designs are labeled');
    const seed = `2026-08-17#run${runId}`;
    for (const option of [1, 2, 3]) {
      const expected = styleFor({ specKey: 'spectacular_wow1_8', option, weekOf: seed });
      const row = stills.find((a) => a.prompt.includes(expected.style));
      assert.ok(row, `no design carries option ${option}'s rolled style`);
      assert.equal(row.theme_label, expected.label);
    }
    // The three options Scott compares are three different worlds.
    assert.equal(new Set(stills.map((a) => a.theme_label)).size, 3, 'a batch must not repeat a style');
    // The framed track keeps its painted border while wearing its style.
    const framed = stills.find((a) => /matte-black frame/.test(a.prompt));
    assert.ok(framed?.theme_label, 'the framed design is styled too');
  } finally {
    await rm(base, { recursive: true, force: true });
  }
});

test('story director: falls back to the template chase story without a director/URL', async (t) => {
  if (!(await hasFfmpeg())) return t.skip('ffmpeg not installed');
  const { base, repo, store } = await harness();
  const spectacularOnly = SURFACES.filter((s) => s.key === 'spectacular');
  try {
    // Plain fixture provider: no still URL -> the director step never runs.
    const { runId } = await runWeek({ weekOf: '2026-08-17', triggeredBy: 'test', deps: { repo, store, providers, surfaces: spectacularOnly, optionsPerSurface: 1, duration: 1 } });
    const [still] = await repo.listArtworks(runId);
    assert.match(still.motion_prompt, /A chase with real stakes/, 'template story stands when no director can run');
  } finally {
    await rm(base, { recursive: true, force: true });
  }
});

// Jeff (2026-10-21): "these final renders … are exporting out either
// letterboxed or with an L shape black box." Simulate what Seedance really
// returns — the art letterboxed inside a 16:9 canvas AND drifted off-centre so
// the bars are uneven — and prove every delivered file is edge-to-edge art
// at the exact spec: no letterbox, no L, no padding, and no stretch.
test('letterboxed + drifted model output ships edge-to-edge at spec (no bars, no L shape)', async (t) => {
  if (!(await hasFfmpeg())) return t.skip('ffmpeg not installed');
  const { base, repo, store } = await harness();
  const seedanceLike = {
    mode: 'fixture',
    still: stillProvider,
    motion: {
      ...motionProvider,
      async generate(args) {
        const res = await motionProvider.generate(args);
        // Re-stage the clip the way a drifting Seedance does: the art shrunk
        // into a 1280x720 canvas and pushed down + right, so the padding is
        // uneven — left 60, top 180, right 20, bottom whatever is left.
        const artH = Math.round(1200 / (args.width / args.height) / 2) * 2;
        const staged = `${args.output}.staged.mp4`;
        await execFileP('ffmpeg', [
          '-y', '-i', args.output,
          // gblur: the model + upscaler blend art into the bar — the boundary is
          // a fade, not a crisp line (Shawn, 2026-10-27: dark line along the bottom).
          '-vf', `scale=1200:${artH},pad=1280:720:60:180:black,gblur=sigma=3,format=yuv420p`,
          '-c:v', 'libx264', '-preset', 'fast', '-crf', '18', '-an', staged,
        ]);
        await rename(staged, args.output);
        return { ...res, model: 'seedance-sim@test', width: 1280, height: 720 };
      },
    },
  };
  const surfaces = SURFACES.filter((s) => s.key === 'spectacular' || s.key === 'eon_connected');
  try {
    // Two spectacular options: option 1 carries the painted frame, option 2 is
    // borderless — both must come out clean.
    const { runId } = await runWeek({ weekOf: '2026-10-19', triggeredBy: 'test', deps: { repo, store, providers: seedanceLike, surfaces, optionsPerSurface: 2, duration: 1 } });
    const stills = await repo.listArtworks(runId);
    for (const st of stills) await repo.updateArtwork(st.id, { status: 'approved' });
    const summary = await animateRun({ runId, deps: { repo, store, providers: seedanceLike, duration: 1 } });
    assert.equal(summary.counts.failed ?? 0, 0);

    const all = await repo.listArtworks(runId);
    const motions = all.filter((a) => a.stage === 'motion');
    assert.ok(motions.length >= 2 + 12, `expected spectaculars + 2x6 EON panels, got ${motions.length}`);
    for (const m of motions) {
      assert.ok(!/BLACK BARS/.test(m.error || ''), `${m.style}/${m.panel ?? 'final'} flagged: ${m.error}`);
    }

    // Spectaculars: exact 1692x468 and no black edge anywhere (borderless) /
    // no excess beyond a uniform frame (framed).
    const specs = motions.filter((m) => m.style === 'frame_break');
    assert.equal(specs.length, 2);
    for (const m of specs) {
      const file = store.localPath(m.s3_key_final);
      const p = await ffmpeg.probe(file);
      assert.equal(p.width, 1692); assert.equal(p.height, 468);
      const framed = isFramedPrompt(stills.find((st) => st.id === m.source_still_id).prompt);
      const audit = await proveResidualBars(file, { framed });
      assert.equal(audit.plan, null, `${framed ? 'framed' : 'borderless'} spectacular still has bars: ${JSON.stringify(audit.thickness)}`);
      if (!framed) {
        // No dark rim on any edge at the delivered size (the 2026-10-27 screenshot).
        const rim = await measureEdgeLines(file);
        assert.deepEqual(rim.lines, [], `dark edge line on the borderless spectacular: ${JSON.stringify(rim.stats)}`);
        // Every edge band of a borderless piece is ART: brighter than any pad.
        for (const band of [
          { x: 0, y: 0, width: 1692, height: 12 }, { x: 0, y: 456, width: 1692, height: 12 },
          { x: 0, y: 0, width: 40, height: 468 }, { x: 1652, y: 0, width: 40, height: 468 },
        ]) {
          const st = await ffmpeg.regionStats(file, band);
          assert.ok(st && st.ymax > 80, `edge band ${JSON.stringify(band)} is dark (ymax ${st?.ymax}) — a bar leaked through`);
        }
      }
    }

    // EON masters: the geometric proof FAILS here (art bleeds into the
    // bottom band), which used to ship the whole padded canvas squashed into
    // 960x384. Now the measured step strips the real edges.
    const sequences = await repo.listEonSequences(runId);
    assert.equal(sequences.length, 2);
    for (const seq of sequences) {
      const file = store.localPath(seq.master_s3_key);
      const p = await ffmpeg.probe(file);
      assert.equal(p.width, 960); assert.equal(p.height, 384);
      const audit = await proveResidualBars(file, { framed: false });
      assert.equal(audit.plan, null, `EON master still has bars: ${JSON.stringify(audit.thickness)}`);
      const rim = await measureEdgeLines(file);
      assert.deepEqual(rim.lines, [], `dark edge line on the EON master: ${JSON.stringify(rim.stats)}`);
      for (const band of [
        { x: 0, y: 0, width: 960, height: 10 }, { x: 0, y: 374, width: 960, height: 10 },
        { x: 0, y: 0, width: 24, height: 384 }, { x: 936, y: 0, width: 24, height: 384 },
      ]) {
        const st = await ffmpeg.regionStats(file, band);
        assert.ok(st && st.ymax > 80, `EON edge band ${JSON.stringify(band)} is dark (ymax ${st?.ymax})`);
      }
    }
  } finally {
    await rm(base, { recursive: true, force: true });
  }
});
