// Generation catalog — WHAT a weekly run produces (Build Plan §4, §5).
//
// Pure data + helpers, no I/O, so it is trivially unit-testable and the
// orchestrator stays a thin coordinator. Two constants:
//   SPECS    — the exact pixel specs (mirrors migrations/002_seed_specs.sql /
//              Build Plan §4). The DB `specs` table remains source of truth;
//              this constant is what the media pipeline conforms to.
//   SURFACES — the generation targets for a week. Each expands into
//              `optionsPerSurface` (locked: 3) options.

import config from '../../config/index.js';

// key → exact output pixels.
// SPECTACULAR is PANEL-NATIVE per Jeff (2026-10-21 email: "final renders
// should be: Spectaculars - 1692w x 468h"). It was 4K-class 3840×1062 (Shawn,
// 2026-07-14) — same 3.615:1 aspect, so compositions are untouched; the sign
// now gets exactly its own pixels instead of downscaling a 4K file.
// EON is PANEL-NATIVE per Jeff (2026-08-21 email): "Spines: 64w x 384h each ·
// Faces: 256w x 384h each · Total master size: 960w x 384". The old 5x
// oversize made his players downscale every panel; delivering his exact LED
// resolution (and one master file — see delivery/handoff.js) speeds up his
// turnaround. Aspects are identical (spine 1:6, face 2:3, pod split 20/80),
// so compositions are untouched — only pixels change.
export const SPECS = {
  spectacular_wow1_8: { surface: 'spectacular', width: 1692, height: 468 },
  eon_face: { surface: 'eon', width: 256, height: 384 },
  eon_spine: { surface: 'eon', width: 64, height: 384 },
  // Wrapped masters — see EON_POD below. 3 pods = 960 wide, 1 pod = 320.
  eon_master_3pod: { surface: 'eon', width: 960, height: 384 },
  eon_master_pod: { surface: 'eon', width: 320, height: 384 },
};

// An EON pod is NOT a flat face: it carries a narrow LED **spine** down its
// LEFT side, angled away from the face and aimed at approaching drivers
// (WOW template spec sheet — "each EON POD has 3 spines & 3 faces", face
// 256×384, spine 64×384). Both are part of one 3D piece, so the engine
// generates a single continuous panorama and cuts BOTH panels out of it: the
// art wraps around the corner instead of the spine being an afterthought.
//
// Panel order within a pod is left → right as a driver sees it: spine, then
// face. A pod slab is therefore spine + face wide.
export const EON_POD = [
  { kind: 'spine', specKey: 'eon_spine' },
  { kind: 'face', specKey: 'eon_face' },
];

/** Width of one pod slab (spine + face) in delivery pixels. Pure. */
export const POD_WIDTH = EON_POD.reduce((w, p) => w + SPECS[p.specKey].width, 0);

// Post-processing kinds the orchestrator knows how to run:
//   frame_break → composite subject onto the black canvas (the 3D style)
//   conform     → scale/crop straight to the target spec
//   eon_slice   → conform to the wrapped master, then cut each pod's spine +
//                 face out of it (`pods` on the surface says how many)
export const POST = { FRAME_BREAK: 'frame_break', CONFORM: 'conform', EON_SLICE: 'eon_slice' };

// The surfaces generated every week. `gen` is the ratio/size handed to the
// model (a standard ratio at high res); the pipeline conforms to `specKey`.
// Gen sizes: high-res, every dimension >= 960 (Seedream's minimum), aspect as
// close to the delivery spec as possible so compositions survive downstream.
// `loop: 'pingpong'` = ambient motion gets a palindrome pass so it loops
// seamlessly on the sign (directional travel must NOT ping-pong — it would
// visibly reverse).
export const SURFACES = [
  {
    key: 'spectacular',
    surface: 'spectacular',
    specKey: 'spectacular_wow1_8',
    style: 'frame_break', // the WOW signature 3D frame-break look
    mediaType: 'video',
    // Native ~3.6:1 (matches the spec) — the whole composition survives the
    // band; no center-crop lottery (art review, 2026-07-10). Seedream max 4096.
    gen: { kind: 'motion', width: 4096, height: 1132, ratio: '21:9' },
    post: POST.FRAME_BREAK,
    // storyboard — OFF since 2026-08-10 (Shawn, live QA): generating a
    //              closing still and anchoring the video on it as an end
    //              frame made the motion feel obligated to reach a target
    //              frame instead of moving freely. The ending is left free.
    //              Flip back to true to restore the closing-still flow.
    // durationS  — the piece's TOTAL length, one native Seedance 2.5 call
    //              (stitching removed 2026-08-10). The full 30s piece
    //              (config.spectacularDurationS; Shawn, 2026-08-18 —
    //              production mode); GEN_SPECTACULAR_DURATION_S=10 drops
    //              back to cheap iteration rounds.
    storyboard: false,
    durationS: config.generation.spectacularDurationS,
    // No ping-pong: continuous kinetic motion throughout (user: "whole scene active")
    // makes seamless looping less critical than full-frame activity.
  },
  {
    key: 'eon_connected',
    surface: 'eon',
    specKey: 'eon_master_3pod',
    style: 'eon_connected', // one wide master that travels across the 3 pods
    mediaType: 'video',
    pods: 3,
    // 2.5:1 — the true wrapped geometry of three pods (3 x 320 x 384 native).
    // Each pod slab is exactly one THIRD of this master, which is why the
    // 3-act "one act per third" choreography in prompts.js still lines up.
    gen: { kind: 'motion', width: 4096, height: 1638, ratio: '5:2' },
    post: POST.EON_SLICE,
    // Directional travel: no ping-pong. Loop policy = enter/exit clip.
    // GEN_EON_DURATION_S=30 opts EON pieces into Seedance 2.5's native 30s
    // (halves visible loop repetition on the pillars; ~2x the gen cost).
    durationS: config.generation.eonDurationS,
  },
  {
    key: 'eon_single',
    surface: 'eon',
    specKey: 'eon_master_pod',
    style: 'eon_single', // a standalone single pod — its spine + its face
    mediaType: 'video',
    pods: 1,
    // 5:6 — one pod slab. A lone pillar still has a spine on the real
    // structure, so the piece is composed to wrap the corner (Shawn,
    // 2026-07-25); it is cut into a spine + a face exactly like a connected pod.
    gen: { kind: 'motion', width: 3200, height: 3840, ratio: '5:6' },
    post: POST.EON_SLICE,
    // No ping-pong: continuous kinetic motion throughout (user: "whole scene active")
    // makes seamless looping less critical than full-frame activity.
    durationS: config.generation.eonDurationS,
  },
];

/**
 * Expand the catalog into a flat job list for one run: every surface × option.
 * Pure. @returns {Array<{ surface, specKey, style, option, spec }>}
 */
export function planJobs({ surfaces = SURFACES, optionsPerSurface = config.optionsPerSurface } = {}) {
  const jobs = [];
  for (const s of surfaces) {
    const spec = SPECS[s.specKey];
    if (!spec) throw new Error(`Unknown spec_key "${s.specKey}" for surface "${s.key}"`);
    for (let option = 1; option <= optionsPerSurface; option += 1) {
      jobs.push({ ...s, option, spec });
    }
  }
  return jobs;
}

export default { SPECS, SURFACES, POST, EON_POD, POD_WIDTH, planJobs };
