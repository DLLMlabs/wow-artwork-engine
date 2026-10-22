import { test } from 'node:test';
import assert from 'node:assert/strict';

import { SPECS, SURFACES, POST, EON_POD, POD_WIDTH, planJobs } from '../src/services/generation/catalog.js';

test('SPECS: spectacular (2026-10-21) and EON (2026-08-21) are Jeff\'s panel-native sizes', () => {
  assert.deepEqual(SPECS.spectacular_wow1_8, { surface: 'spectacular', width: 1692, height: 468 });
  // Jeff, verbatim: "Spines: 64w x 384h each · Faces: 256w x 384h each ·
  // Total master size: 960w x 384".
  assert.deepEqual(SPECS.eon_face, { surface: 'eon', width: 256, height: 384 });
  assert.deepEqual(SPECS.eon_spine, { surface: 'eon', width: 64, height: 384 });
  // Wrapped masters: a pod is its spine + its face, so the 3-pod master is
  // 3 x 320 and a single pod is its own 320-wide master.
  assert.deepEqual(SPECS.eon_master_3pod, { surface: 'eon', width: 960, height: 384 });
  assert.deepEqual(SPECS.eon_master_pod, { surface: 'eon', width: 320, height: 384 });
});

test('a pod slab is spine + face, and each pod is exactly one third of the 3-pod master', () => {
  assert.equal(POD_WIDTH, SPECS.eon_spine.width + SPECS.eon_face.width);
  assert.equal(SPECS.eon_master_3pod.width, POD_WIDTH * 3);
  assert.equal(SPECS.eon_master_pod.width, POD_WIDTH);
  // Spine first, then face — left to right as a driver sees a pod.
  assert.deepEqual(EON_POD.map((p) => p.kind), ['spine', 'face']);
  // The 3-act choreography in prompts.js assumes one act per third of the
  // frame; that only lines up with the hardware while this holds.
  assert.equal(POD_WIDTH / SPECS.eon_master_3pod.width, 1 / 3);
});

test('every EON surface generates at its master aspect so nothing is cropped away', () => {
  for (const s of SURFACES.filter((x) => x.post === POST.EON_SLICE)) {
    const spec = SPECS[s.specKey];
    assert.equal(spec.width, POD_WIDTH * s.pods, `${s.key} master is not ${s.pods} pod slab(s) wide`);
    const drift = Math.abs(s.gen.width / s.gen.height - spec.width / spec.height);
    assert.ok(drift < 0.01, `${s.key} gen aspect ${s.gen.width}x${s.gen.height} drifts from its spec`);
    // Seedream: max 4096 per axis, min 960.
    assert.ok(s.gen.width <= 4096 && s.gen.height <= 4096, `${s.key} gen exceeds Seedream's 4096 limit`);
    assert.ok(Math.min(s.gen.width, s.gen.height) >= 960, `${s.key} gen is under Seedream's 960 minimum`);
  }
});

test('every surface references a known spec and a known post-step', () => {
  const posts = new Set(Object.values(POST));
  for (const s of SURFACES) {
    assert.ok(SPECS[s.specKey], `surface ${s.key} has unknown spec ${s.specKey}`);
    assert.ok(posts.has(s.post), `surface ${s.key} has unknown post ${s.post}`);
  }
});

test('planJobs expands to optionsPerSurface options per surface', () => {
  const jobs = planJobs({ optionsPerSurface: 3 });
  assert.equal(jobs.length, SURFACES.length * 3);
  const spectacular = jobs.filter((j) => j.key === 'spectacular');
  assert.deepEqual(spectacular.map((j) => j.option), [1, 2, 3]);
  // each job carries its resolved spec
  assert.deepEqual(spectacular[0].spec, SPECS.spectacular_wow1_8);
});

test('planJobs honours a custom option count and surface list', () => {
  const only = SURFACES.filter((s) => s.key === 'eon_single');
  const jobs = planJobs({ surfaces: only, optionsPerSurface: 2 });
  assert.equal(jobs.length, 2);
  assert.ok(jobs.every((j) => j.key === 'eon_single'));
});
