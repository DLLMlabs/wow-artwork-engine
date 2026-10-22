// Month-to-date spend estimate — the dashboard's "what has THIS project cost"
// strip.
//
// Why this exists at all: the fal.ai account is SHARED across WOW Artwork,
// WOW Content Automation, and WOW Broken News. fal's own billing API
// (GET /v1/account/billing, /v1/account/focus) reports the three projects
// COMBINED and cannot isolate artwork. This per-generation estimate — computed
// from what THIS engine actually generated — is the only project-specific
// number. Reconcile the fal account total as an all-projects ceiling, never as
// the artwork figure.
//
// It's itemized per billable fal operation, at fal's real published prices
// (verified 2026-07-19), so it tracks an invoice rather than a blended guess:
//   still            → Seedream v4, $0.03 / image (flat)
//   Seedance seconds → per RAW second; rate depends on tier (std 1080p vs fast
//                      720p), read from the row's model string
//   Topaz seconds    → per second of output, only when the model string records
//                      that the upscale actually ran ('+topaz')
//
// Accuracy rules:
// - Fixtures are free — rows whose model starts with 'fixture' (or was never
//   set, e.g. a guardrail-blocked still that never called an API) are excluded.
// - A motion row bills a Seedance call ONLY if it produced raw output
//   (s3_key_raw set). An EON connected set is 3 rows from ONE call sharing that
//   raw key, so grouping by it bills the set once, not three times. Rows with
//   no raw key never completed a billable generation and are skipped.
// - Seconds are the row's RAW generation length (duration_s). Ping-pong was
//   retired 2026-07-16, so duration_s == raw for all current runs; a handful of
//   pre-retirement 30s ambient rows may read 2x — a negligible historical tail.
// - QA-failed stills still spent (generated on Seedream, then gated) — counted.

import config from '../config/index.js';
import falPricing from './generation/falPricing.js';

/** 'YYYY-MM' for a date-ish value (Date, ISO string, 'YYYY-MM-DD'), else null. */
export function monthKey(v) {
  if (!v) return null;
  const d = v instanceof Date ? v : new Date(v);
  return Number.isNaN(d.getTime()) ? null : d.toISOString().slice(0, 7);
}

const isLive = (a) => Boolean(a.model) && !String(a.model).startsWith('fixture');

// Estimate the Seedance + Topaz cost of a pre-ledger motion row from its stored
// FINAL dims (the row predates cost_usd being recorded). Seedance is billed on
// its 1080p render, so re-derive the render dims for the row's aspect + tier.
function estimateMotionUsd(a) {
  const seconds = a.duration_s || config.generation.durationS;
  const aspect = a.width && a.height ? a.width / a.height : 16 / 9;
  const tier = falPricing.seedanceTier(a.model);
  const render = falPricing.renderDimsForTier(aspect, tier);
  const seedance = falPricing.seedanceCostUsd({ ...render, durationS: seconds, tier });
  // Topaz bills its OUTPUT — the upscaled render canvas, not the delivery
  // spec (the spectacular ships at 1692x468 since 2026-10-21, far below the
  // 4x pass's actual output), so price render × factor.
  const upFactor = config.fal.upscale.factor || 1;
  const topaz = falPricing.usedTopaz(a.model)
    ? falPricing.topazCostUsd({ width: render.width * upFactor, height: render.height * upFactor, durationS: seconds })
    : 0;
  return { seedance, topaz };
}

/**
 * Estimated spend for one calendar month across all runs.
 * @param {{ repo, month?: string }} opts month defaults to the current month.
 * @returns {Promise<object>} itemized estimate; see `return` below for shape.
 */
export async function computeSpend({ repo, month } = {}) {
  const m = month || monthKey(new Date());

  const runs = await repo.listRuns({ limit: 1000 });
  let stillCount = 0;
  let stillsUsd = 0;
  // raw key → the rows of ONE Seedance call (EON's 3 faces share a key).
  const calls = new Map();

  for (const run of runs) {
    const runMonth = monthKey(run.week_of) || monthKey(run.created_at);
    const artworks = await repo.listArtworks(run.id);
    for (const a of artworks) {
      if (!isLive(a)) continue;
      // Rows predating created_at stamping fall back to the run's week.
      if ((monthKey(a.created_at) || runMonth) !== m) continue;

      if (a.stage === 'still') {
        stillCount += 1;
        // Prefer the immutable ledger; fall back to the flat Seedream price.
        stillsUsd += a.cost_usd != null ? a.cost_usd : falPricing.seedreamCostUsd({ count: 1 });
      } else if (a.stage === 'motion') {
        const keyOf = a.s3_key_raw;
        if (!keyOf) continue; // no raw produced → this call never billed
        if (!calls.has(keyOf)) calls.set(keyOf, []);
        calls.get(keyOf).push(a);
      }
    }
  }

  let seedanceUsd = 0;
  let topazUsd = 0;
  let videoSeconds = 0;
  let topazSeconds = 0;
  for (const rows of calls.values()) {
    const seconds = Math.max(...rows.map((r) => r.duration_s || config.generation.durationS));
    const rep = rows[0];
    // Seedance/Topaz split, from the canonical formula (informational breakdown).
    const est = estimateMotionUsd({ ...rep, duration_s: seconds });
    const estTotal = est.seedance + est.topaz;
    // Immutable-ledger rows carry cost_usd (EON split across its 3 faces, so the
    // call's true cost is their SUM). Older rows have no ledger → use the estimate.
    const ledgered = rows.some((r) => r.cost_usd != null);
    const callTotal = ledgered
      ? rows.reduce((s, r) => s + (r.cost_usd || 0), 0)
      : estTotal;
    // Scale the seedance:topaz split to match the (exact) ledger total.
    const f = estTotal > 0 ? callTotal / estTotal : 1;
    seedanceUsd += estTotal > 0 ? est.seedance * f : callTotal;
    topazUsd += est.topaz * f;
    videoSeconds += seconds;
    if (est.topaz > 0) topazSeconds += seconds;
  }

  const videosUsd = seedanceUsd + topazUsd; // full per-video cost (gen + upscale)
  const round = (n) => Math.round(n * 100) / 100;
  return {
    month: m,
    estimate: true,
    // Reminder for any UI: fal's account bill covers all three WOW projects.
    sharedAccount: true,
    stills: { count: stillCount, usd: round(stillsUsd) },
    // `videos.usd` is the combined gen+upscale cost so existing UIs stay correct.
    videos: { count: calls.size, seconds: round(videoSeconds), usd: round(videosUsd) },
    // Itemized so the dashboard can show where the money went.
    breakdown: {
      seedance: { seconds: round(videoSeconds), usd: round(seedanceUsd) },
      topaz: { seconds: round(topazSeconds), usd: round(topazUsd) },
    },
    totalUsd: round(stillsUsd + videosUsd),
    // The canonical rate book these figures come from (for display/audit).
    rates: falPricing.REFERENCE_PER_SECOND,
  };
}

export default { computeSpend, monthKey };
