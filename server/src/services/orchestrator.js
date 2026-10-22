// Run orchestrator (Build Plan M1 · two-phase M2.5 — the generation engine).
//
// Two phases, gated on human approval so we never spend motion credits on a
// style Scott doesn't like:
//   Phase 1 — runWeek():   generate cheap Seedream STILLS (3 options/surface),
//                          each with its proposed Seedance motion prompt.
//   Phase 2 — animateRun(): for stills the reviewer APPROVED, run Seedance
//                          image-to-video off the still, then conform / slice.
//
// The guardrail runs BEFORE each provider call — before the still spend in
// Phase 1, and (the expensive one) before the motion spend in Phase 2.
//
// Every dependency is injected (repo, store, providers, guardrails) so the
// whole pipeline is unit-testable end-to-end on fixtures — no Postgres, no AWS,
// no spend.

import path from 'node:path';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';

import config from '../config/index.js';
import logger from '../config/logger.js';
import ffmpeg from './ffmpeg.js';
import { sliceMaster } from './eonSlicer.js';
import { isFramedPrompt, stripResidualBars, proveResidualBars, fitForAspect, describeEdges } from './bars.js';
import * as guardrailsModule from './guardrails.js';
import * as qaModule from './qa.js';
import { planJobs, POST, SURFACES, SPECS } from './generation/catalog.js';
import {
  buildStillPrompt, buildClosingStillPrompt, buildMotionPrompt,
  composeSpectacularMotionPrompt, combineSpectacularActs, sanitizeMotionPrompt,
  wildThemeInfo,
} from './generation/prompts.js';
import { directStory } from './generation/director.js';
import { refineTweak } from './generation/tweak.js';
import { resolveDesign } from './keeper.js';
import falPricing from './generation/falPricing.js';
import { getProviders } from './generation/index.js';
import { getStore, artworkKey } from './storage/index.js';
import { uploadToFalStorage } from './generation/fal.js';
import { getRepo } from '../db/index.js';
import { weekOfFor } from './dates.js';

// Ceiling on one "Add another design" click. Each still is a real (small)
// spend, so the button can't be turned into an unbounded batch by a stray
// payload — the reviewer clicks again if they want more.
const MAX_ADD_AT_ONCE = 3;

const even = (n) => Math.max(2, Math.floor(n / 2) * 2);
const thumbDims = (spec) => ({ width: even(spec.width / 2), height: even(spec.height / 2) });

// Review-grid preview size. Nothing on the dashboard renders a design wider
// than ~1400 CSS px, so a 4096px master is ~50x more bytes than the screen can
// use. Caps the long edge and keeps the aspect exactly.
const PREVIEW_MAX_EDGE = 1280;
function previewDims(width, height, maxEdge = PREVIEW_MAX_EDGE) {
  const scale = Math.min(1, maxEdge / Math.max(width, height));
  return { width: even(width * scale), height: even(height * scale) };
}

/**
 * Divide ONE fal bill across the rows it produced, weighted (EON panels are
 * weighted by width — a face is 4x a spine). The last row absorbs the rounding
 * remainder so the per-row ledger sums to exactly `total`, which is what
 * spend.js re-adds when it prices a call from its rows. Pure.
 * @returns {number[]} one USD amount per weight, in order
 */
export function allocateCost(total, weights) {
  const sum = weights.reduce((a, b) => a + b, 0);
  const round = (n) => Math.round(n * 1e4) / 1e4;
  let spent = 0;
  return weights.map((w, i) => {
    const usd = i === weights.length - 1 ? round(total - spent) : round((total * w) / sum);
    spent += usd;
    return usd;
  });
}

function resolveDeps(deps) {
  return {
    repo: deps.repo || getRepo(),
    guardrails: deps.guardrails || guardrailsModule,
    qa: deps.qa || qaModule,
    duration: deps.duration ?? config.generation.durationS,
    fps: deps.fps ?? config.generation.fps,
  };
}

// ===========================================================================
// PHASE 1 — stills (style review)
// ===========================================================================

/**
 * Generate the week's still options (Phase 1). Cheap; nothing is animated yet.
 * @returns {Promise<{ runId, phase, status, weekOf, counts, artworks }>}
 */
export async function runWeek({ weekOf, triggeredBy = 'manual', onStart, deps = {} } = {}) {
  const { repo, guardrails, qa, duration, fps } = resolveDeps(deps);
  const store = deps.store || (await getStore());
  const providers = deps.providers || getProviders();
  const week = weekOf || weekOfFor();
  const jobs = planJobs({ surfaces: deps.surfaces, optionsPerSurface: deps.optionsPerSurface });

  const run = await repo.createRun({ weekOf: week, triggeredBy, status: 'running' });
  await onStart?.(run);
  logger.info({ runId: run.id, weekOf: week, options: jobs.length, mode: providers.mode || config.generationMode }, 'Phase 1 (stills) started');

  const workDir = deps.workDir || (await mkdtemp(path.join(os.tmpdir(), `wae-still-${run.id}-`)));
  const counts = { ready: 0, failed: 0, blocked: 0 };
  try {
    // Live progress for the dashboard ("Creating designs… 3/9").
    let done = 0;
    await repo.setRunProgress?.(run.id, { phase: 'designs', done, total: jobs.length });
    for (const job of jobs) {
      // Seed by BATCH, not by week (Shawn, 2026-08-14): every new batch gets
      // fresh subjects and environments instead of repeating the week's picks.
      const r = await generateStill(job, { runId: run.id, weekOf: week, promptSeed: `${week}#run${run.id}`, directStory: deps.directStory, repo, store, providers, guardrails, qa, workDir });
      counts.ready += r.ready; counts.failed += r.failed; counts.blocked += r.blocked;
      done += 1;
      await repo.setRunProgress?.(run.id, { phase: 'designs', done, total: jobs.length });
    }
    const status = counts.ready === 0 && counts.failed + counts.blocked > 0 ? 'failed' : 'complete';
    await repo.setRunStatus(run.id, status);
    logger.info({ runId: run.id, status, counts }, 'Phase 1 (stills) finished');
    return { runId: run.id, phase: 'stills', status, weekOf: week, counts, artworks: await repo.listArtworks(run.id) };
  } catch (err) {
    await repo.setRunStatus(run.id, 'failed', err.message);
    logger.error({ runId: run.id, err: err.message }, 'Phase 1 crashed');
    throw err;
  } finally {
    if (!deps.workDir) await rm(workDir, { recursive: true, force: true }).catch(() => {});
  }
}

async function generateStill(job, ctx) {
  const { runId, weekOf, repo, store, providers, guardrails, qa, workDir } = ctx;
  // promptSeed defaults to the week — regeneration salts it (see
  // regenerateStills) so fresh options don't repeat the retired designs.
  const seed = ctx.promptSeed || weekOf;
  // "Keep & explore" callers (varyStill/tweakStill) pass an explicit prompt to
  // re-run verbatim or after an LLM edit — use it as-is (skipping the template
  // rebuild) and still run the guardrail on it below. Lineage threads the family
  // links through to EVERY insert path (ready, qa-failed, blocked, error) so a
  // variation stays attached to its family even if it fails.
  const prompt = ctx.promptOverride ?? buildStillPrompt({ style: job.style, specKey: job.specKey, option: job.option, weekOf: seed });
  let motionPrompt = ctx.motionPromptOverride ?? buildMotionPrompt({ style: job.style, specKey: job.specKey, option: job.option, weekOf: seed });
  // Storyboard surfaces (the spectacular) get a CLOSING still — the "ends
  // with" panel. Variations inherit their source's stored version via the
  // override; legacy rows without one rebuild from the template so re-rolls
  // of old designs still gain the storyboard. NO separate act-2 prompt is
  // stored on new designs — the motion prompt IS the full three-movement arc
  // (single-pass Seedance 2.5); the act2 override only carries a LEGACY
  // source's stored act 2 forward through vary/tweak.
  const isStoryboard = Boolean(job.storyboard);
  const closingPrompt = isStoryboard
    ? (ctx.closingPromptOverride ?? buildClosingStillPrompt({ style: job.style, specKey: job.specKey, option: job.option, weekOf: seed }))
    : null;
  const motionPromptAct2 = isStoryboard ? (ctx.motionPromptAct2Override ?? null) : null;
  // WILD SLOT (Shawn, 2026-08-18): spectacular option 3 and EON-connected
  // option 2 roll a randomized era/world theme each batch. The rolled theme's
  // label is stored on the row so the dashboard can mark the wild design and
  // say what it rolled. Vary/tweak inherit their source design's label
  // (the override path keeps the source prompt, hence its theme).
  const themeLabel = ctx.themeLabelOverride
    ?? (ctx.promptOverride ? null
      : wildThemeInfo({ style: job.style, specKey: job.specKey, option: job.option, weekOf: seed })?.label ?? null);
  const lineage = {
    familyId: ctx.familyId ?? null,
    parentArtworkId: ctx.parentArtworkId ?? null,
    changeNote: ctx.changeNote ?? null,
    themeLabel,
  };

  // Guardrail BEFORE the (cheap) still spend — covers BOTH storyboard frames.
  const check = guardrails.checkPrompt([prompt, closingPrompt].filter(Boolean).join(' '));
  if (!check.allowed) {
    const reason = `guardrail: ${check.reasons.join('; ')}`;
    await repo.insertArtwork({
      runId, surface: job.surface, style: job.style, mediaType: 'still', stage: 'still',
      specKey: job.specKey, width: job.spec.width, height: job.spec.height,
      prompt, motionPrompt, closingPrompt, motionPromptAct2, status: 'failed', error: reason, ...lineage,
    });
    logger.warn({ runId, surface: job.key, option: job.option, reason }, 'Still prompt blocked before spend');
    return { ready: 0, failed: 0, blocked: 1 };
  }

  try {
    const dir = path.join(workDir, `${job.key}_opt${job.option}`);
    await mkdir(dir, { recursive: true });
    const stillPath = path.join(dir, 'still.png');
    const gen = await providers.still.generate({
      width: job.gen.width, height: job.gen.height, ratio: job.gen.ratio, output: stillPath, prompt,
    });
    // NO frame plate anywhere (Shawn, 2026-08-14): the perimeter comes from
    // Seedream painting it (still prompt) and Seedance maintaining it — the
    // reviewed still, the stored file and the Seedance reference are the raw
    // model output, untouched.
    const finalStillPath = stillPath;
    const referenceUrl = gen.url ?? null;
    const live = !String(gen.model || '').startsWith('fixture');

    // Every generation gets its own file. Keying on (run, surface, option slot)
    // alone meant a variation, a re-roll or a per-design regenerate silently
    // overwrote the design it was spawned from — the kept "original" was still
    // a row, but its pixels had been replaced. The sequence is the count of
    // stills the run has already produced, so it is unique and monotonic
    // (generation is sequential) without needing the not-yet-assigned row id.
    // STORY DIRECTOR (Shawn, 2026-08-14): the motion story is written FROM
    // the actual generated still — a vision LLM looks at what Seedream really
    // painted (the real characters, the real scenery to hide in) and scripts
    // a chase/hunt/journey with a decisive payoff; the engine wraps it in the
    // fixed motion contract. Best-effort: on any failure (no key, fixture
    // mode, bad output) the template chase story stands. Overrides (vary/
    // tweak) keep their design's stored story.
    if (job.style === 'frame_break' && !ctx.motionPromptOverride && referenceUrl) {
      // SPLIT TRACKS (Shawn, 2026-08-18): only option 1 carries the painted
      // border; options 2+ are borderless full-bleed — the director and the
      // motion contract both switch variants on this flag.
      const framed = job.option === 1;
      const story = await (ctx.directStory ?? directStory)({ imageUrl: referenceUrl, framed });
      if (story) motionPrompt = composeSpectacularMotionPrompt(story, { framed });
    }

    const priorStills = (await repo.listArtworks(runId)).filter((a) => a.stage === 'still').length;
    const key = artworkKey({
      runId, surfaceKey: job.key, option: job.option, variant: `g${priorStills + 1}`, name: 'still.png',
    });
    const put = await store.put({ key, sourcePath: finalStillPath });

    // A REAL thumbnail. The design-review grid used to point at this key for
    // both the full image and the "thumbnail", so opening a week downloaded
    // nine 4K PNGs — measured at 2.4-4.8 MB each, ~30 MB before a single card
    // had pixels, and ~50 MB of decode memory apiece. That was the "slow and
    // laggy" complaint (perf audit, 2026-07-26). A JPEG capped at 1280 on the
    // long edge is ~45 KB — the same picture at review size, ~50x smaller.
    // Best-effort: if it fails, fall back to the master so a card is never blank.
    let thumbKey = put.key;
    try {
      const td = previewDims(job.gen.width, job.gen.height);
      const thumbPath = path.join(dir, 'still_thumb.jpg');
      await ffmpeg.thumbnail({ input: finalStillPath, output: thumbPath, width: td.width, height: td.height });
      const thumbPut = await store.put({
        key: artworkKey({ runId, surfaceKey: job.key, option: job.option, variant: `g${priorStills + 1}`, name: 'still_thumb.jpg' }),
        sourcePath: thumbPath,
      });
      thumbKey = thumbPut.key;
    } catch (err) {
      logger.warn({ runId, surface: job.key, err: err.message }, 'Still thumbnail failed; serving the full image');
    }

    // QA gate BEFORE review: outdoor readability (art review 2026-07-10). The
    // file is stored either way so a failed card can still show what happened.
    // Gate on the OPENING frame only — it's the piece's primary composition;
    // the closing still is generated after the gate so a failed design never
    // spends the second Seedream call.
    const stillLive = live;
    // Gate on the RAW art: readability is about the scene, and the plate's
    // black band would drag the average luma down artificially.
    const gate = await qa.lumaGate(stillPath);
    if (!gate.ok) {
      await repo.insertArtwork({
        runId, surface: job.surface, style: job.style, mediaType: 'still', stage: 'still',
        specKey: job.specKey, width: job.gen.width, height: job.gen.height,
        prompt, motionPrompt, closingPrompt, motionPromptAct2, model: gen.model, remoteUrl: referenceUrl,
        s3KeyFinal: put.key, thumbnailKey: thumbKey,
        status: 'failed', error: `qa: ${gate.reason}`,
        falRequestId: stillLive ? gen.jobId ?? null : null,
        costUsd: stillLive ? falPricing.seedreamCostUsd({ count: 1 }) : 0,
        ...lineage,
      });
      logger.warn({ runId, surface: job.key, option: job.option, yavg: gate.yavg }, 'Still failed luma QA gate');
      return { ready: 0, failed: 1, blocked: 0 };
    }

    // CLOSING still (storyboard surfaces): the frame the 30s piece must end
    // on — reviewed as the second storyboard panel, enforced in Phase 2 as
    // the Seedance call's end_image_url. Best-effort: a failed closing still
    // never sinks the design (the card degrades to a single opening panel).
    let closingFields = { closingPrompt, motionPromptAct2 };
    let stillCount = 1;
    if (isStoryboard && closingPrompt) {
      try {
        const closingPath = path.join(dir, 'closing.png');
        const cgen = await providers.still.generate({
          width: job.gen.width, height: job.gen.height, ratio: job.gen.ratio, output: closingPath, prompt: closingPrompt,
        });
        // No plate (2026-08-14): the raw model closing is stored/referenced.
        const closingUrl = cgen.url ?? null;
        const cput = await store.put({
          key: artworkKey({ runId, surfaceKey: job.key, option: job.option, variant: `g${priorStills + 1}`, name: 'closing.png' }),
          sourcePath: closingPath,
        });
        let cthumbKey = cput.key;
        try {
          const td = previewDims(job.gen.width, job.gen.height);
          const cthumbPath = path.join(dir, 'closing_thumb.jpg');
          await ffmpeg.thumbnail({ input: closingPath, output: cthumbPath, width: td.width, height: td.height });
          const ctp = await store.put({
            key: artworkKey({ runId, surfaceKey: job.key, option: job.option, variant: `g${priorStills + 1}`, name: 'closing_thumb.jpg' }),
            sourcePath: cthumbPath,
          });
          cthumbKey = ctp.key;
        } catch (err) {
          logger.warn({ runId, surface: job.key, err: err.message }, 'Closing thumbnail failed; serving the full image');
        }
        closingFields = {
          closingPrompt, motionPromptAct2,
          closingKey: cput.key, closingThumbKey: cthumbKey, closingRemoteUrl: closingUrl,
        };
        stillCount = 2;
      } catch (err) {
        logger.warn({ runId, surface: job.key, option: job.option, err: err.message }, 'Closing still failed; storyboard shows the opening only');
      }
    }

    // The Seedream images were billed the moment they generated ($0.03 flat
    // each — opening + closing when the storyboard rendered). Fixtures free.
    const stillLedger = {
      falRequestId: stillLive ? gen.jobId ?? null : null,
      costUsd: stillLive ? falPricing.seedreamCostUsd({ count: stillCount }) : 0,
    };

    await repo.insertArtwork({
      runId, surface: job.surface, style: job.style, mediaType: 'still', stage: 'still',
      specKey: job.specKey, width: job.gen.width, height: job.gen.height,
      prompt, motionPrompt, model: gen.model,
      // Phase 2 hands this to Seedance as the image-to-video first frame. For
      // the spectacular it is the FRAMED still (plate composited), so the
      // model animates from the exact-perimeter band (fixture mode: no URL).
      remoteUrl: referenceUrl,
      s3KeyFinal: put.key, thumbnailKey: thumbKey, status: 'ready',
      // Borderline-dark scenes reach review with an amber note (emissive LED
      // signs handle dark backgrounds; the reviewer decides).
      error: gate.warn ? `qa: ${gate.reason}` : null, ...stillLedger, ...closingFields, ...lineage,
    });
    return { ready: 1, failed: 0, blocked: 0 };
  } catch (err) {
    logger.error({ runId, surface: job.key, option: job.option, err: err.message }, 'Still generation failed');
    await repo.insertArtwork({
      runId, surface: job.surface, style: job.style, mediaType: 'still', stage: 'still',
      specKey: job.specKey, width: job.spec.width, height: job.spec.height,
      prompt, motionPrompt, closingPrompt, motionPromptAct2, status: 'failed', error: err.message, ...lineage,
    });
    return { ready: 0, failed: 1, blocked: 0 };
  }
}

/**
 * Regenerate the still options for ONE surface inside an existing run —
 * the per-sign "Redo unsaved designs" button. Unapproved, unsaved stills for
 * that surface are retired (status 'superseded', hidden by the dashboard) and
 * ONLY their option slots are refilled; approved stills, SAVED stills (a
 * selections row — Scott's "keep this one while I re-roll the rest",
 * 2026-07-21) and any videos already made are untouched. Other surfaces are
 * never touched — that's the whole point (UX feedback 2026-07-14: the global
 * regenerate forced a re-spend across every sign).
 * @returns {Promise<{ runId, phase, status, surface, counts, artworks }>}
 */
export async function regenerateStills({ runId, surfaceKey, triggeredBy = 'dashboard', onStart, deps = {} } = {}) {
  const { repo, guardrails, qa } = resolveDeps(deps);
  const store = deps.store || (await getStore());
  const providers = deps.providers || getProviders();

  const surface = (deps.surfaces || SURFACES).find((s) => s.key === surfaceKey);
  if (!surface) throw new Error(`Unknown surface "${surfaceKey}"`);
  const run = await repo.getRun(runId);
  if (!run) throw new Error(`Run ${runId} not found`);

  const week = run.week_of;
  const existing = await repo.listArtworks(runId);
  const mine = existing.filter((a) => a.stage === 'still' && a.style === surface.style);
  // "Saved" = the reviewer bookmarked it (selections row) — protected from
  // regeneration exactly like an approved design, but without committing to it.
  const selections = await repo.listSelections(runId);
  const savedIds = new Set(selections.map((s) => s.artwork_id));
  // Skip variations too (a parent_artwork_id): "keep & explore" designs are
  // managed inside their family (re-roll / tweak / promote), never nuked by a
  // whole-surface re-roll — same protection as kept/approved/superseded.
  const toRetire = mine.filter((x) => x.status !== 'approved' && x.status !== 'superseded' && !savedIds.has(x.id) && !x.parent_artwork_id);
  // Refuse BEFORE flipping the run to 'running' (and before onStart resolves
  // the route) — nothing changed, so the run must stay reviewable and the
  // dashboard gets a clean 409 instead of a phantom in-progress state.
  if (toRetire.length === 0) {
    throw Object.assign(
      new Error('Every design for this sign is saved or approved — unsave one first if you want to replace it.'),
      { code: 'nothing_to_regenerate' },
    );
  }
  // Mark running BEFORE onStart — same polling-race lesson as animateRun.
  await repo.setRunStatus(runId, 'running');
  await onStart?.(run);

  for (const a of toRetire) {
    await repo.updateArtwork(a.id, { status: 'superseded' });
  }

  // Salt the prompt seed with the attempt number. Prompts are deterministic in
  // (week, surface, option) — without the salt, "new designs" would rebuild the
  // exact themes and choreography that were just retired.
  const perBatch = deps.optionsPerSurface ?? config.optionsPerSurface;
  const attempt = Math.max(1, Math.ceil(mine.length / perBatch));
  const promptSeed = `${week}#r${attempt}`;

  // Replace ONLY the retired option slots — a full planJobs batch here would
  // balloon the section past optionsPerSurface whenever something was kept.
  // Slot recovery mirrors regenerateStill: the storage key records the slot
  // (runs/<id>/<surface>/opt<n>/still.png); keyless rows fall back to slot 1.
  const allJobs = planJobs({ surfaces: [surface], optionsPerSurface: deps.optionsPerSurface });
  const slots = [...new Set(toRetire.map((a) => {
    const m = /\/opt(\d+)\//.exec(a.s3_key_final || a.thumbnail_key || '');
    return m ? Number(m[1]) : 1;
  }))];
  const usedOptions = new Set();
  const jobs = [];
  for (const slot of slots) {
    // A slot from an older, larger batch may not exist in today's plan — fall
    // back to the first job not already claimed by another retired slot.
    const job = allJobs.find((j) => j.option === slot && !usedOptions.has(j.option))
      || allJobs.find((j) => !usedOptions.has(j.option));
    if (!job) continue;
    usedOptions.add(job.option);
    jobs.push(job);
  }
  logger.info({ runId, surface: surfaceKey, attempt, options: jobs.length, kept: mine.length - toRetire.length, triggeredBy, mode: providers.mode || config.generationMode }, 'Per-surface regenerate started');

  const workDir = deps.workDir || (await mkdtemp(path.join(os.tmpdir(), `wae-regen-${runId}-`)));
  const counts = { ready: 0, failed: 0, blocked: 0 };
  try {
    let done = 0;
    await repo.setRunProgress?.(runId, { phase: 'designs', done, total: jobs.length });
    for (const job of jobs) {
      const r = await generateStill(job, { runId, weekOf: week, promptSeed, directStory: deps.directStory, repo, store, providers, guardrails, qa, workDir });
      counts.ready += r.ready; counts.failed += r.failed; counts.blocked += r.blocked;
      done += 1;
      await repo.setRunProgress?.(runId, { phase: 'designs', done, total: jobs.length });
    }
    const status = counts.ready === 0 && counts.failed + counts.blocked > 0 ? 'failed' : 'complete';
    await repo.setRunStatus(runId, status);
    logger.info({ runId, surface: surfaceKey, status, counts }, 'Per-surface regenerate finished');
    return { runId, phase: 'stills', status, surface: surfaceKey, counts, artworks: await repo.listArtworks(runId) };
  } catch (err) {
    await repo.setRunStatus(runId, 'failed', err.message);
    logger.error({ runId, surface: surfaceKey, err: err.message }, 'Per-surface regenerate crashed');
    throw err;
  } finally {
    if (!deps.workDir) await rm(workDir, { recursive: true, force: true }).catch(() => {});
  }
}

/**
 * ADD more design options to ONE surface inside an existing run — the per-sign
 * "Add another design" button. Nothing is retired: every existing design (liked
 * or not, saved or not, approved or not) stays exactly where it is and the new
 * options land beside them in fresh slots.
 *
 * This is the counterpart to regenerateStills, which REPLACES. Scott's case
 * (2026-07-26): "I may like all 3 Spectacular pieces but want to see a 4th" —
 * regenerate refuses outright once everything is saved or approved, because
 * replacing is exactly what he doesn't want.
 *
 * The new option's slot number also drives its theme + choreography (prompts
 * are seeded on the option), so a 4th design is a genuinely different piece
 * rather than another roll of the same three.
 * @returns {Promise<{ runId, phase, status, surface, added, counts, artworks }>}
 */
export async function addStills({ runId, surfaceKey, count = 1, triggeredBy = 'dashboard', onStart, deps = {} } = {}) {
  const { repo, guardrails, qa } = resolveDeps(deps);
  const store = deps.store || (await getStore());
  const providers = deps.providers || getProviders();

  const surface = (deps.surfaces || SURFACES).find((s) => s.key === surfaceKey);
  if (!surface) throw new Error(`Unknown surface "${surfaceKey}"`);
  const run = await repo.getRun(runId);
  if (!run) throw new Error(`Run ${runId} not found`);

  const wanted = Math.max(1, Math.min(Number(count) || 1, MAX_ADD_AT_ONCE));
  const existing = await repo.listArtworks(runId);
  // Next free slot = one past the highest this surface has EVER used, including
  // superseded designs — reusing a retired design's slot would hand the new
  // piece that design's theme, which is the opposite of "show me another one".
  const mine = existing.filter((a) => a.stage === 'still' && a.style === surface.style);
  const highest = mine.reduce((max, a) => {
    const m = /\/opt(\d+)\//.exec(a.s3_key_final || a.thumbnail_key || '');
    return Math.max(max, m ? Number(m[1]) : 0);
  }, 0);
  const firstSlot = Math.max(highest, mine.length) + 1;

  // Mark running BEFORE onStart — same polling-race lesson as animateRun.
  await repo.setRunStatus(runId, 'running');
  await onStart?.(run);

  // planJobs is 1..N; we take only the tail slots we're adding.
  const allJobs = planJobs({ surfaces: [surface], optionsPerSurface: firstSlot + wanted - 1 });
  const jobs = allJobs.filter((j) => j.option >= firstSlot);
  logger.info({ runId, surface: surfaceKey, firstSlot, adding: jobs.length, triggeredBy, mode: providers.mode || config.generationMode }, 'Add designs started');

  const workDir = deps.workDir || (await mkdtemp(path.join(os.tmpdir(), `wae-add-${runId}-`)));
  const counts = { ready: 0, failed: 0, blocked: 0 };
  try {
    let done = 0;
    await repo.setRunProgress?.(runId, { phase: 'designs', done, total: jobs.length });
    for (const job of jobs) {
      const r = await generateStill(job, { runId, weekOf: run.week_of, repo, store, providers, guardrails, qa, workDir });
      counts.ready += r.ready; counts.failed += r.failed; counts.blocked += r.blocked;
      done += 1;
      await repo.setRunProgress?.(runId, { phase: 'designs', done, total: jobs.length });
    }
    const status = counts.ready === 0 && counts.failed + counts.blocked > 0 ? 'failed' : 'complete';
    await repo.setRunStatus(runId, status);
    logger.info({ runId, surface: surfaceKey, status, counts }, 'Add designs finished');
    return { runId, phase: 'stills', status, surface: surfaceKey, added: counts.ready, counts, artworks: await repo.listArtworks(runId) };
  } catch (err) {
    await repo.setRunStatus(runId, 'failed', err.message);
    logger.error({ runId, surface: surfaceKey, err: err.message }, 'Add designs crashed');
    throw err;
  } finally {
    if (!deps.workDir) await rm(workDir, { recursive: true, force: true }).catch(() => {});
  }
}

/**
 * Regenerate ONE design (a single still option) — the per-card "New design"
 * button. Only the clicked design is retired and replaced; its siblings, all
 * other surfaces, approved stills and existing videos are untouched. (UX
 * feedback 2026-07-21: per-surface regen still rebuilt 3 designs when the
 * reviewer only disliked one.)
 * @returns {Promise<{ runId, phase, status, artworkId, counts }>}
 */
export async function regenerateStill({ artworkId, triggeredBy = 'dashboard', onStart, deps = {} } = {}) {
  const { repo, guardrails, qa } = resolveDeps(deps);
  const store = deps.store || (await getStore());
  const providers = deps.providers || getProviders();

  const still = await repo.getArtwork(artworkId);
  if (!still) throw new Error(`Artwork ${artworkId} not found`);
  if (still.stage !== 'still') throw new Error('Only style designs can be regenerated');
  if (still.status === 'superseded') throw new Error('This design was already replaced');
  const surface = (deps.surfaces || SURFACES).find((s) => s.style === still.style);
  if (!surface) throw new Error(`No surface for style "${still.style}"`);
  const run = await repo.getRun(still.run_id);
  if (!run) throw new Error(`Run ${still.run_id} not found`);

  // Which option slot does this card occupy? The storage key records it
  // (runs/<id>/<surface>/opt<n>/still.png); blocked rows without a key fall
  // back to slot 1 — the slot only steers theme rotation, nothing structural.
  const optMatch = /\/opt(\d+)\//.exec(still.s3_key_final || still.thumbnail_key || '');
  const option = optMatch ? Number(optMatch[1]) : 1;

  // Mark running BEFORE onStart — same polling-race lesson as animateRun.
  await repo.setRunStatus(run.id, 'running');
  await onStart?.(run);
  await repo.updateArtwork(still.id, { status: 'superseded' });

  // Salt the seed with THIS card's id: deterministic, but guaranteed different
  // from the design being replaced and from every earlier regen attempt.
  const promptSeed = `${run.week_of}#a${still.id}`;
  const jobs = planJobs({ surfaces: [surface], optionsPerSurface: deps.optionsPerSurface });
  const job = jobs.find((j) => j.option === option) || jobs[0];
  logger.info({ runId: run.id, artworkId, surface: surface.key, option, triggeredBy, mode: providers.mode || config.generationMode }, 'Per-design regenerate started');

  const workDir = deps.workDir || (await mkdtemp(path.join(os.tmpdir(), `wae-regen1-${run.id}-`)));
  try {
    await repo.setRunProgress?.(run.id, { phase: 'designs', done: 0, total: 1 });
    const counts = await generateStill(job, { runId: run.id, weekOf: run.week_of, promptSeed, directStory: deps.directStory, repo, store, providers, guardrails, qa, workDir });
    await repo.setRunProgress?.(run.id, { phase: 'designs', done: 1, total: 1 });
    const status = counts.ready === 0 ? 'failed' : 'complete';
    await repo.setRunStatus(run.id, status);
    logger.info({ runId: run.id, artworkId, status }, 'Per-design regenerate finished');
    return { runId: run.id, phase: 'stills', status, artworkId, counts };
  } catch (err) {
    await repo.setRunStatus(run.id, 'failed', err.message);
    logger.error({ runId: run.id, artworkId, err: err.message }, 'Per-design regenerate crashed');
    throw err;
  } finally {
    if (!deps.workDir) await rm(workDir, { recursive: true, force: true }).catch(() => {});
  }
}

// ===========================================================================
// KEEP & EXPLORE — variations of a liked still (re-roll / plain-language tweak)
// ===========================================================================

/**
 * Shared machinery for a "keep & explore" variation: generate ONE new still
 * into `source`'s family from an explicit prompt. Mirrors regenerateStill's
 * run-status / workDir / progress / error handling — the only differences are
 * that the PROMPT is supplied (not template-rebuilt) and the new row carries the
 * family lineage. `resolvePrompt(source)` returns { promptOverride, changeNote }
 * and runs AFTER the fast 202 (so a tweak's LLM edit is off the request path).
 * @returns {Promise<{ runId, phase, status, artworkId, counts }>}
 */
async function spawnVariation({ source, resolvePrompt, triggeredBy, onStart, deps, label }) {
  const { repo, guardrails, qa } = resolveDeps(deps);
  const store = deps.store || (await getStore());
  const providers = deps.providers || getProviders();

  const surface = (deps.surfaces || SURFACES).find((s) => s.style === source.style);
  if (!surface) throw new Error(`No surface for style "${source.style}"`);
  const run = await repo.getRun(source.run_id);
  if (!run) throw new Error(`Run ${source.run_id} not found`);

  // Bootstrap the family: the first keep/vary/tweak of a plain still makes it the
  // anchor of its own family (family_id = its own id) so every variation shares it.
  let familyId = source.family_id;
  if (!familyId) {
    familyId = source.id;
    await repo.updateArtwork(source.id, { familyId });
  }

  // The option slot only supplies the surface's gen dims (the PROMPT is an
  // override); reuse regenerateStill's slot recovery from the storage key.
  const optMatch = /\/opt(\d+)\//.exec(source.s3_key_final || source.thumbnail_key || '');
  const option = optMatch ? Number(optMatch[1]) : 1;
  const jobs = planJobs({ surfaces: [surface], optionsPerSurface: deps.optionsPerSurface });
  const job = jobs.find((j) => j.option === option) || jobs[0];

  // Mark running BEFORE onStart — same polling-race lesson as animateRun.
  await repo.setRunStatus(run.id, 'running');
  await onStart?.(run);
  // Resolve the prompt after the 202 has been sent (a tweak's LLM call happens
  // here, in the background, not while the reviewer's request is blocking).
  const { promptOverride, changeNote = null } = await resolvePrompt(source);
  logger.info({ runId: run.id, artworkId: source.id, familyId, surface: surface.key, label, triggeredBy, mode: providers.mode || config.generationMode }, `${label} started`);

  const workDir = deps.workDir || (await mkdtemp(path.join(os.tmpdir(), `wae-${label}-${run.id}-`)));
  try {
    await repo.setRunProgress?.(run.id, { phase: 'designs', done: 0, total: 1 });
    const counts = await generateStill(job, {
      runId: run.id, weekOf: run.week_of, repo, store, providers, guardrails, qa, workDir,
      promptOverride, motionPromptOverride: source.motion_prompt,
      // Variations inherit the source's storyboard (closing frame, plus a
      // LEGACY act 2 where one is stored) so a re-roll/tweak explores the
      // OPENING while the arc stays the design's. Legacy sources without a
      // closing prompt fall back to the template build inside generateStill,
      // so old designs gain a storyboard on re-roll.
      closingPromptOverride: source.closing_prompt ?? undefined,
      motionPromptAct2Override: source.motion_prompt_act2 ?? undefined,
      // A variation of a wild-theme design stays that theme (the prompt is
      // the source's), so its label rides along.
      themeLabelOverride: source.theme_label ?? null,
      familyId, parentArtworkId: source.id, changeNote,
    });
    await repo.setRunProgress?.(run.id, { phase: 'designs', done: 1, total: 1 });
    const status = counts.ready === 0 ? 'failed' : 'complete';
    await repo.setRunStatus(run.id, status);
    logger.info({ runId: run.id, artworkId: source.id, status }, `${label} finished`);
    return { runId: run.id, phase: 'stills', status, artworkId: source.id, counts };
  } catch (err) {
    await repo.setRunStatus(run.id, 'failed', err.message);
    logger.error({ runId: run.id, artworkId: source.id, err: err.message }, `${label} crashed`);
    throw err;
  } finally {
    if (!deps.workDir) await rm(workDir, { recursive: true, force: true }).catch(() => {});
  }
}

/**
 * RE-ROLL a liked still: generate a fresh take by re-running its STORED prompt
 * verbatim (Seedream is stochastic, so the same prompt yields a new version of
 * the same piece). The new still joins the source's family; the source is
 * untouched. @returns {Promise<{ runId, phase, status, artworkId, counts }>}
 */
export async function varyStill({ artworkId, triggeredBy = 'dashboard', onStart, deps = {} } = {}) {
  const { repo } = resolveDeps(deps);
  const card = await repo.getArtwork(artworkId);
  if (!card) throw new Error(`Artwork ${artworkId} not found`);
  // A video resolves to the design behind it: another "version" of a video is
  // a new DESIGN for Scott to approve and animate, never an automatic re-render.
  const source = await resolveDesign({ artwork: card, repo });
  if (source.status === 'superseded') throw new Error('This design was already replaced');
  return spawnVariation({
    source, triggeredBy, onStart, deps, label: 'vary',
    // Re-roll reuses the stored prompt exactly; no change note.
    resolvePrompt: (s) => ({ promptOverride: s.prompt, changeNote: null }),
  });
}

/**
 * PLAIN-LANGUAGE TWEAK of a liked still: an LLM edits ONLY the reviewer's
 * requested change into the source's existing prompt (everything else
 * preserved), then that edited prompt is generated as a new same-family still
 * carrying the change note. The refiner is injectable (deps.refineTweak) so
 * tests run offline. @returns {Promise<{ runId, phase, status, artworkId, counts }>}
 */
export async function tweakStill({ artworkId, instruction, triggeredBy = 'dashboard', onStart, deps = {} } = {}) {
  const { repo } = resolveDeps(deps);
  const card = await repo.getArtwork(artworkId);
  if (!card) throw new Error(`Artwork ${artworkId} not found`);
  const source = await resolveDesign({ artwork: card, repo });
  if (source.status === 'superseded') throw new Error('This design was already replaced');
  // Injectable so tests never hit the network; refineTweak itself never throws
  // (falls back to the original prompt + the instruction as the note).
  const refine = deps.refineTweak || refineTweak;
  return spawnVariation({
    source, triggeredBy, onStart, deps, label: 'tweak',
    resolvePrompt: async (s) => {
      const { prompt, changeNote } = await refine({ prompt: s.prompt, instruction, style: s.style });
      return { promptOverride: prompt, changeNote };
    },
  });
}

// ===========================================================================
// PHASE 2 — animate approved stills
// ===========================================================================

/**
 * Animate the run's APPROVED stills (Phase 2). By default only approved,
 * not-yet-animated, non-errored stills are processed (safe to call repeatedly).
 * Pass `stillIds` to explicitly (re-)animate specific stills — that bypasses
 * both the already-animated and the error skip (the retry path).
 * @returns {Promise<{ runId, phase, status, animated, counts, artworks }>}
 */
export async function animateRun({ runId, stillIds, triggeredBy = 'dashboard', onStart, deps = {} } = {}) {
  const { repo, guardrails, qa, duration, fps } = resolveDeps(deps);
  const store = deps.store || (await getStore());
  const providers = deps.providers || getProviders();

  const run = await repo.getRun(runId);
  if (!run) throw new Error(`Run ${runId} not found`);
  // Mark running BEFORE responding to the route, so the dashboard reliably sees
  // status='running' on its immediate reload and starts polling (otherwise it
  // can read the stale 'complete' from Phase 1 and never poll — the UI looks
  // frozen while videos are actually being made).
  await repo.setRunStatus(runId, 'running');
  await onStart?.(run);

  const artworks = await repo.listArtworks(runId);
  const animatedStillIds = new Set(artworks.map((a) => a.source_still_id).filter(Boolean));
  const targeted = stillIds ? new Set(stillIds) : null;
  const toAnimate = artworks.filter((a) => {
    if (a.stage !== 'still' || a.status !== 'approved') return false;
    if (targeted) return targeted.has(a.id);
    // Bulk mode: skip already-animated stills AND ones whose last attempt
    // errored (e.g. a moderation refusal) — those need an explicit retry, not
    // a silent re-spend (UX review P0). "qa:"-prefixed notes are advisory
    // warnings (e.g. dark-scene), not failures — they don't block.
    const hardError = a.error && !a.error.startsWith('qa:');
    return !animatedStillIds.has(a.id) && !hardError;
  });
  logger.info({ runId, approved: toAnimate.length, targeted: Boolean(targeted), mode: providers.mode || config.generationMode }, 'Phase 2 (animate) started');

  const workDir = deps.workDir || (await mkdtemp(path.join(os.tmpdir(), `wae-motion-${runId}-`)));
  const counts = { ready: 0, failed: 0, blocked: 0 };
  try {
    // Live progress for the dashboard ("Making videos… 1/3"). One unit per
    // still being animated (an EON set is one Seedance call → one unit).
    let done = 0;
    await repo.setRunProgress?.(runId, { phase: 'videos', done, total: toAnimate.length });
    for (const still of toAnimate) {
      // Guardrail BEFORE the expensive motion spend — both acts when present
      // (the reviewer can edit either act from the dashboard).
      const check = guardrails.checkPrompt(
        [still.motion_prompt, still.motion_prompt_act2].filter(Boolean).join(' ') || '',
      );
      if (!check.allowed) {
        await repo.updateArtwork(still.id, { error: `motion guardrail: ${check.reasons.join('; ')}` });
        counts.blocked += 1;
        continue;
      }
      try {
        counts.ready += await animateStill(still, { runId, repo, store, providers, qa, duration, fps, workDir });
        if (still.error) await repo.updateArtwork(still.id, { error: null }); // clear a stale retry error
      } catch (err) {
        logger.error({ runId, stillId: still.id, err: err.message }, 'Animation failed');
        await repo.updateArtwork(still.id, { error: err.message });
        counts.failed += 1;
      }
      done += 1;
      await repo.setRunProgress?.(runId, { phase: 'videos', done, total: toAnimate.length });
    }
    await repo.setRunStatus(runId, 'complete');
    logger.info({ runId, counts }, 'Phase 2 (animate) finished');
    return { runId, phase: 'motion', status: 'complete', animated: counts.ready, counts, artworks: await repo.listArtworks(runId) };
  } catch (err) {
    await repo.setRunStatus(runId, 'failed', err.message);
    throw err;
  } finally {
    if (!deps.workDir) await rm(workDir, { recursive: true, force: true }).catch(() => {});
  }
}

// Animate one approved still into its motion deliverable(s). Returns the number
// of motion artworks created (3 for an EON connected set, else 1).
async function animateStill(still, ctx) {
  const { runId, repo, store, providers, qa, duration, fps, workDir } = ctx;
  const surface = SURFACES.find((s) => s.style === still.style);
  if (!surface) throw new Error(`No surface for style "${still.style}"`);
  const finalSpec = SPECS[surface.specKey];

  // Stills generated 2026-07-25..30 stored a motion prompt naming "vertical
  // bands at the one-third and two-thirds lines" — vocabulary Seedance
  // literalized into painted white lines at exactly those positions in the
  // finished pillar videos (Scott, 2026-07-31). Stripping the sentence here,
  // at the one place the motion spend happens, fixes re-animation of every
  // affected still without touching stored data. No-op on current prompts.
  const motionPrompt = sanitizeMotionPrompt(still.motion_prompt);

  const dir = path.join(workDir, `still${still.id}`);
  await mkdir(dir, { recursive: true });

  // Materialize the approved still as the first-frame reference (works for
  // local or S3 stores).
  const ref = path.join(dir, 'ref.png');
  await writeFile(ref, await store.getBuffer(still.s3_key_final));

  // ASPECT HANDLING (Shawn, 2026-08-14, rounds 2+4 · Jeff, 2026-10-21).
  // Seedance cannot output the spectacular's extreme 3.6:1 (or the EON
  // master's 2.5:1): the reference goes in pre-letterboxed to 16:9 (below)
  // and the render comes back with that padding, which must come OFF before
  // the file reaches the sign. Three steps, each the next one's safety net:
  //   1. GEOMETRY — the bars' position is computed from shape alone (the
  //      design's aspect vs the raw canvas), never from cropdetect, which
  //      cannot tell padding from the artwork's own painted black frame and
  //      ate the frame on the first live cheetah render (round 4). The crop
  //      happens only after PROOF that both bands measure near-black.
  //   2. MEASURED residue (bars.js) — Seedance drifts: a slow zoom or pan
  //      moves the art a few percent, so step 1 leaves a sliver on one or
  //      two edges (Jeff's "L shape black box"); or the drift fails step 1's
  //      proof and — until 2026-10-21 — the whole padded canvas went out
  //      ("letterboxed"). The clip's real content box is measured over its
  //      whole length and every proven-black edge is removed: a framed
  //      design keeps its uniform painted border, a borderless one keeps no
  //      black edge at all.
  //   3. FIT — content is NEVER stretched and, since 2026-10-21, NEVER padded
  //      either: an aspect that still mismatches is center-cropped to fill
  //      the spec edge to edge, and the row is flagged for the reviewer.
  const framed = surface.post === POST.FRAME_BREAK && isFramedPrompt(still.prompt);
  const extractContent = async (input, model) => {
    if (String(model || '').startsWith('fixture') || !still.width || !still.height) {
      return { path: input, warn: null, fit: 'exact' };
    }
    let contentPath = input;
    const want = still.width / still.height;
    // Step 1 — geometry + proof.
    try {
      const rawDims = await ffmpeg.probe(input);
      const bars = ffmpeg.computeBarCrop({ rawWidth: rawDims.width, rawHeight: rawDims.height, wantAspect: want });
      if (bars) {
        // Proof step: both stripped regions must be near-black padding.
        const strips = bars.bars === 'horizontal'
          ? [
            { width: rawDims.width, height: bars.y, x: 0, y: 0 },
            { width: rawDims.width, height: rawDims.height - bars.y - bars.height, x: 0, y: bars.y + bars.height },
          ]
          : [
            { width: bars.x, height: rawDims.height, x: 0, y: 0 },
            { width: rawDims.width - bars.x - bars.width, height: rawDims.height, x: bars.x + bars.width, y: 0 },
          ];
        const lumas = [];
        for (const strip of strips.filter((r) => r.width >= 2 && r.height >= 2)) {
          lumas.push(await ffmpeg.regionMeanLuma(input, strip));
        }
        const BLACK = 28; // mean 0-255 luma; true padding measures ~16
        if (lumas.length && lumas.every((l) => l !== null && l <= BLACK)) {
          const out = path.join(dir, 'content.mp4');
          await ffmpeg.cropColumn({ input, output: out, width: bars.width, height: bars.height, x: bars.x, y: bars.y });
          logger.info({ stillId: still.id, bars, lumas }, 'Model letterboxed the render — stripped the proven-black padding');
          contentPath = out;
        } else {
          logger.warn({ stillId: still.id, bars, lumas }, 'Aspect excess is NOT proven-black padding — geometry left alone; measuring the real edges next');
        }
      }
    } catch (err) {
      logger.warn({ stillId: still.id, err: err.message }, 'Letterbox extraction failed; using raw output');
    }
    // Step 2 — measured residue, proven flat-black edge by edge.
    try {
      const out = path.join(dir, 'content_edges.mp4');
      const r = await stripResidualBars({ input: contentPath, output: out, framed });
      if (r.path !== contentPath) {
        logger.info({ stillId: still.id, framed, stripped: describeEdges(r.strip), rejected: r.rejected }, 'Stripped residual black edges the model left around the art');
        contentPath = r.path;
      } else if (r.rejected.length) {
        logger.info({ stillId: still.id, rejected: r.rejected, thickness: r.thickness }, 'Dark edges are art, not padding — left in place');
      }
    } catch (err) {
      logger.warn({ stillId: still.id, err: err.message }, 'Residual edge measurement failed; keeping the geometric result');
    }
    // Step 3 — fit: exact when the aspect matches, center-crop otherwise.
    try {
      const dims = await ffmpeg.probe(contentPath);
      const fit = fitForAspect({ width: dims.width, height: dims.height, wantAspect: want });
      if (fit === 'cover') {
        const got = dims.width / dims.height;
        logger.warn({ stillId: still.id, content: `${dims.width}x${dims.height}`, want: want.toFixed(3) }, 'Content aspect mismatch after bar extraction — will center-crop to fill, never pad or stretch');
        return {
          path: contentPath, fit,
          warn: `qa: model content is ${dims.width}x${dims.height} (aspect ${got.toFixed(2)}) vs the design's ${want.toFixed(2)} — delivered edge-to-edge by center-cropping the excess (never padded, never stretched); check the edges`,
        };
      }
    } catch (err) {
      logger.warn({ stillId: still.id, err: err.message }, 'Aspect check failed');
    }
    return { path: contentPath, warn: null, fit: 'exact' };
  };

  // The whole piece — every act — in ONE Seedance call. The chain-era
  // stitching (2×15s + handoff frame + concat) was removed 2026-08-10; 2.5
  // renders the surface's total length natively. New designs
  // store the full three-movement arc as their motion prompt; pre-2.5 rows
  // store act 1 + act 2, which combineSpectacularActs joins here. NO end
  // frame is sent — deliberately, even for legacy rows that stored a closing
  // still (live QA 2026-08-10, Shawn: anchoring on a target frame made the
  // motion feel obligated instead of free) — the ending lives in the prompt.
  const totalS = surface.durationS ?? duration;
  const singlePrompt = combineSpectacularActs(motionPrompt, sanitizeMotionPrompt(still.motion_prompt_act2));

  // PRE-LETTERBOXED reference (live QA 2026-08-15, the "missed the mark on
  // the aspect ratio" render): fed the raw 3.62:1 art, Seedance sometimes
  // re-stages it as a tiny picture floating in its own canvas instead of
  // letterboxing — the snake slithered out of the picture into the void.
  // The aspect decision must be OURS: pad the approved still to 16:9 with
  // pure black margins (a canvas Seedance natively produces), so frame 1 IS
  // the padded image with the art spanning full width, and extraction strips
  // exactly the bars we added. Best-effort: any failure falls back to the
  // raw still URL (the old behavior).
  let referenceImageUrl = still.remote_url ?? null;
  if (referenceImageUrl && still.width && still.height && still.width / still.height > 16 / 9) {
    try {
      const paddedRef = path.join(dir, 'ref_letterboxed.png');
      await ffmpeg.padToAspect({ input: ref, output: paddedRef, width: still.width, height: still.height, aspect: 16 / 9 });
      referenceImageUrl = (await uploadToFalStorage({ sourcePath: paddedRef, contentType: 'image/png' })).url;
      logger.info({ stillId: still.id }, 'Seedance reference pre-letterboxed to 16:9');
    } catch (err) {
      logger.warn({ stillId: still.id, err: err.message }, 'Reference letterboxing failed — sending the raw still');
    }
  }

  const raw0 = path.join(dir, 'raw.mp4');
  const gen = await providers.motion.generate({
    width: surface.gen.width, height: surface.gen.height, ratio: surface.gen.ratio,
    durationS: totalS, fps, output: raw0, prompt: singlePrompt,
    referenceImage: ref,                       // local file — fixture mode
    referenceImageUrl,                         // fal-hosted URL — live Seedance
    // EON delivers at Jeff's panel-native 960×384 (2026-08-21) — a 720p
    // Seedance render is already ~2x that, so the Topaz 4K pass is pure spend
    // with zero visible benefit. The spectacular keeps it (3840-wide spec).
    skipUpscale: surface.post === POST.EON_SLICE,
  });
  const raw = raw0; // the model output the QA + ledger read
  const extracted = await extractContent(raw, gen.model);
  const content = extracted.path;
  const aspectWarn = extracted.warn;
  const contentFit = extracted.fit ?? 'exact';

  // QA: measure saturation drift on the model's raw output (Seedance colors
  // drain over a clip). Warning only — stored on the motion rows.
  let driftWarn;
  try {
    const drift = await qa.satDrift(raw);
    if (drift.warn) driftWarn = `qa: ${drift.reason}`;
  } catch { /* QA measurement is best-effort; never fail the render on it */ }

  // QA: FRAME-ORDER fidelity (Shawn, 2026-08-15: "appearing like the images
  // are being used as the last frame rather than the first — confirm").
  // Instead of trusting the fal contract (image_url IS the starting frame),
  // measure it per render: SSIM of the clip's first and last frames against
  // the approved still. When the END resembles the still more than the start,
  // the model animated TOWARD the input — flagged loudly on the card. The
  // measured pair is logged either way, so every render carries its answer.
  let orderWarn;
  if (!String(gen.model || '').startsWith('fixture')) {
    try {
      const firstFrame = path.join(dir, 'first.jpg');
      const lastFrame = path.join(dir, 'last.jpg');
      await ffmpeg.extractFrameAt({ input: content, output: firstFrame, position: 'first' });
      await ffmpeg.extractFrameAt({ input: content, output: lastFrame, position: 'last' });
      const firstSim = await ffmpeg.imageSimilarity(firstFrame, ref);
      const lastSim = await ffmpeg.imageSimilarity(lastFrame, ref);
      logger.info({ stillId: still.id, firstSim, lastSim }, 'Frame-order fidelity vs the approved still');
      if (firstSim !== null && lastSim !== null && lastSim > firstSim + 0.05) {
        orderWarn = `qa: the clip resembles the approved still MORE at its end (similarity ${lastSim.toFixed(2)}) than at its start (${firstSim.toFixed(2)}) — the model animated toward the input instead of away from it`;
      }
    } catch (err) {
      logger.warn({ stillId: still.id, err: err.message }, 'Frame-order fidelity check failed');
    }
  }
  const qaWarn = [aspectWarn, driftWarn, orderWarn].filter(Boolean).join(' | ') || null;

  // Ambient surfaces get a palindrome pass so the clip loops seamlessly on the
  // sign (art review: mismatched endpoints pop every cycle). Doubles duration.
  let srcVideo = content;
  let effDuration = totalS;
  if (surface.loop === 'pingpong') {
    srcVideo = path.join(dir, 'raw_loop.mp4');
    await ffmpeg.pingpong({ input: content, output: srcVideo });
    effDuration = totalS * 2;
  }

  const keyBase = `runs/${runId}/motion/still${still.id}`;
  const key = (name) => `${keyBase}/${name}`;
  const rawPut = await store.put({ key: key('raw.mp4'), sourcePath: raw });

  // Immutable cost ledger, computed here where BOTH the Seedance render dims
  // and the 4K final dims are known. Billed on the RAW generation seconds
  // (the surface's total seconds, one call); ping-pong doubles playback locally at no fal
  // cost. Fixtures are free. See falPricing.js for the rate book.
  const live = !String(gen.model || '').startsWith('fixture');
  const tier = falPricing.seedanceTier(gen.model);
  const aspect = finalSpec.width / finalSpec.height;
  // Price the RESOLUTION actually requested (fal bills pixels), with the tier
  // supplying only the $/token rate — standard-at-720p must not be billed as
  // 1080p (live validation 2026-08-05: ledger said $22.84 for a ~$12 run).
  const render = falPricing.renderDimsForResolution(aspect, config.fal.resolution);
  const seedanceUsd = live ? falPricing.seedanceCostUsd({ ...render, durationS: totalS, tier }) : 0;
  // Topaz bills its OUTPUT pixels — the upscaled Seedance canvas (render ×
  // factor), not the delivery spec: the spectacular ships at Jeff's native
  // 1692×468 (2026-10-21), far below what the 4x pass actually produced.
  const upFactor = config.fal.upscale.factor || 1;
  const topazUsd = live && falPricing.usedTopaz(gen.model)
    ? falPricing.topazCostUsd({ width: render.width * upFactor, height: render.height * upFactor, durationS: totalS, fps })
    : 0;
  const callCostUsd = Math.round((seedanceUsd + topazUsd) * 1e4) / 1e4;
  // One fal call = one bill. EON_SLICE stores a row per panel cut from that
  // single call, so the bill is divided across them; every other surface is one
  // row = full cost. `usd` is an absolute amount (see allocateCost).
  const ledger = (usd = callCostUsd) => ({
    falRequestId: live ? gen.jobId ?? null : null,
    upscaleRequestId: live ? gen.upscaleJobId ?? null : null,
    costUsd: live ? Math.round(usd * 1e4) / 1e4 : 0,
  });

  const insertMotion = (extra) => repo.insertArtwork({
    runId, surface: surface.surface, style: surface.style, mediaType: 'video', stage: 'motion',
    sourceStillId: still.id, prompt: still.prompt, motionPrompt, model: gen.model,
    // The video inherits its still's wild-theme label so the card keeps
    // saying which theme the wild design rolled.
    themeLabel: still.theme_label ?? null,
    s3KeyRaw: rawPut.key, error: qaWarn, ...extra,
  });
  const rowError = (extra) => [qaWarn, extra].filter(Boolean).join(' | ') || null;

  // LAST LINE OF DEFENCE (Jeff, 2026-10-21): measure the file that will
  // actually ship. Any proven-black edge still present — beyond a framed
  // design's uniform painted border — is flagged in red on the card so it
  // never goes out unnoticed. Fixtures are skipped (synthetic art, synthetic
  // edges).
  const auditDelivered = async (file) => {
    if (String(gen.model || '').startsWith('fixture')) return null;
    try {
      const p = await proveResidualBars(file, { framed });
      if (!p.plan) return null;
      logger.error({ stillId: still.id, thickness: p.thickness, strip: p.plan.strip }, 'BLACK BARS remain on the delivered file');
      return `qa: BLACK BARS remain on the delivered file (${describeEdges(p.plan.strip)}) — do not send; re-animate`;
    } catch (err) {
      logger.warn({ stillId: still.id, err: err.message }, 'Delivered-file bar audit failed');
      return null;
    }
  };

  if (surface.post === POST.EON_SLICE) {
    // The wrapped master covers every pod slab side by side (spine + face per
    // pod). Conform it, then cut each panel out so the art carries around the
    // corner onto the spine instead of the spine being a separate afterthought.
    const pods = surface.pods ?? 3;
    const master = path.join(dir, 'master.mp4');
    // fit 'exact' when the aspect matches (a pure scale — the master's edges
    // ARE content, the fold alignment for the panel cuts); on a flagged
    // mismatch 'cover' center-crops the excess. Never 'contain': padding is
    // the letterbox Jeff saw (2026-10-21).
    await ffmpeg.conform({ input: srcVideo, output: master, width: finalSpec.width, height: finalSpec.height, duration: effDuration, fps, fit: contentFit });
    const barsWarn = await auditDelivered(master);
    const masterPut = await store.put({ key: key('master.mp4'), sourcePath: master });
    const panels = await sliceMaster({ masterPath: master, outDir: dir, pods, duration: effDuration });

    // One fal bill, divided across the panels by how much of the master each
    // one is (a face is 4x a spine), remainder on the last so the ledger rows
    // sum to EXACTLY what the call cost.
    const shares = allocateCost(callCostUsd, panels.map((p) => p.width));

    const ids = {};
    for (const [i, panel] of panels.entries()) {
      const td = thumbDims(SPECS[panel.specKey]);
      const thumb = path.join(dir, `${panel.label}_thumb.jpg`);
      await ffmpeg.thumbnail({ input: panel.path, output: thumb, width: td.width, height: td.height, atSeconds: Math.min(2, effDuration / 2) });
      const panelPut = await store.put({ key: key(`${panel.label}.mp4`), sourcePath: panel.path });
      const thumbPut = await store.put({ key: key(`${panel.label}_thumb.jpg`), sourcePath: thumb });
      const probed = await ffmpeg.probe(panel.path);
      const a = await insertMotion({
        specKey: panel.specKey, panel: panel.label,
        width: panel.width, height: panel.height,
        durationS: Math.round(probed.duration ?? effDuration),
        s3KeyFinal: panelPut.key, thumbnailKey: thumbPut.key, status: 'ready',
        error: rowError(barsWarn),
        ...ledger(shares[i]),
      });
      ids[panel.label] = a.id;
    }
    await repo.insertEonSequence({
      runId, masterS3Key: masterPut.key,
      face1ArtworkId: ids.pod1_face, face2ArtworkId: ids.pod2_face, face3ArtworkId: ids.pod3_face,
      spine1ArtworkId: ids.pod1_spine, spine2ArtworkId: ids.pod2_spine, spine3ArtworkId: ids.pod3_spine,
    });
    return panels.length;
  }

  // Spectacular (frame-break): one motion artwork. Both EON surfaces cut into
  // panels above — a single pillar has a spine too, so it is never a lone face.
  //
  // FRAME_BREAK no longer composites a border in post (Shawn, 2026-07-21: a
  // post-drawn letterbox clips the art BEHIND the frame — nothing can ever pop
  // out of a border that's painted on top afterwards). The 3D frame now lives
  // IN the generation: the still prompt paints a trompe-l'oeil black border
  // into the scene and the motion prompt drives the subject through it, over
  // and in front — so the pop-out is real pixels, model-rendered. Here we just
  // conform full-bleed to spec like every other surface.
  const final = path.join(dir, 'final.mp4');
  // fit 'exact': the spectacular's painted frame lives in the outermost
  // pixels — cover's center-crop paid for any aspect error with exactly those
  // pixels, visibly thinning the frame even with a locked camera.
  // 'exact' is a pure scale when the aspect matched; on a flagged mismatch
  // 'cover' center-crops the excess — never 'contain' (padding IS the
  // letterbox Jeff saw, 2026-10-21) and never a stretch.
  await ffmpeg.conform({ input: srcVideo, output: final, width: finalSpec.width, height: finalSpec.height, duration: effDuration, fps, fit: contentFit });
  const barsWarn = await auditDelivered(final);
  // FRAME PLATE on the delivered video: OFF by default (Shawn, 2026-08-11).
  // The stamp was burying characters that Seedance correctly rendered IN FRONT
  // of its painted frame — the post-composited-letterbox failure of 2026-07-21
  // all over again; no pop-out survives an opaque band drawn on top. Frame
  // geometry is anchored by the PLATED STILL Seedance animates from instead;
  // FRAME_PLATE_ON_VIDEO=1 restores the stamp if painted frames drift.
  const deliverable = final;
  const td = thumbDims(finalSpec);
  const thumb = path.join(dir, 'thumb.jpg');
  await ffmpeg.thumbnail({ input: deliverable, output: thumb, width: td.width, height: td.height, atSeconds: Math.min(2, effDuration / 2) });
  const finalPut = await store.put({ key: key('final.mp4'), sourcePath: deliverable });
  const thumbPut = await store.put({ key: key('thumb.jpg'), sourcePath: thumb });
  const probed = await ffmpeg.probe(deliverable);
  await insertMotion({
    specKey: surface.specKey, width: finalSpec.width, height: finalSpec.height,
    durationS: Math.round(probed.duration ?? effDuration),
    s3KeyFinal: finalPut.key, thumbnailKey: thumbPut.key, status: 'ready',
    error: rowError(barsWarn),
    ...ledger(),
  });
  return 1;
}

export default { runWeek, animateRun, regenerateStills, addStills, regenerateStill, varyStill, tweakStill, allocateCost };
