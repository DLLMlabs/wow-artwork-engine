// WOW Artwork Engine — weekly review dashboard (Build Plan M2 · two-phase M2.5).
//
// Phase 1: review the Seedream STILLS (styles) + their proposed motion prompt,
// approve the ones Scott likes. Phase 2: "Animate approved" runs Seedance only
// on approved stills. Standalone shell for dev; ReviewDashboard lifts into the
// wow-contract-query "Artwork Engine" tab.
//
// 2026-07-22 UX/perf pass (CEO feedback: slow load, clunky, unclear flow):
//   · videos stream only while on screen (ui.jsx LazyVideo)
//   · card actions are optimistic with per-card pending — no global lock
//   · skeleton first paint, visibility-aware polling, spend refetched on
//     run transitions + animate/send instead of every poll/action
//   · 3-step guide, single primary CTA, per-section review chips, toasts
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { api } from './api.js';
import {
  StatusBadge, Card, AnchorCard, VariationCard, PodSet, WrapLegend, PendingDesignCard,
  ModePill, SpendPill, Stepper, Spinner, SkeletonCard, Toasts, useToasts,
  focusRing, progressLabel, latestPanels, dirtyDraftDesigns, saveDraft,
} from './ui.jsx';
import SendDialog from './SendDialog.jsx';
import SentHistory from './SentHistory.jsx';

export default function App() {
  return (
    <div className="min-h-screen bg-neutral-950 text-neutral-100">
      <ReviewDashboard />
    </div>
  );
}

// Merge a fetched run detail over local state without clobbering cards whose
// optimistic action is still in flight: their local status / saved flag wins
// until the API settles — the next poll agrees with the server anyway.
function mergeDetail(fetched, cur, pendingIds) {
  if (!cur || pendingIds.size === 0) return fetched;
  const curById = new Map(cur.artworks.map((a) => [a.id, a]));
  const artworks = fetched.artworks.map((a) => {
    const local = pendingIds.has(a.id) ? curById.get(a.id) : null;
    return local ? { ...a, status: local.status } : a;
  });
  const locallySaved = new Set((cur.selections || []).map((s) => s.artwork_id));
  const selections = (fetched.selections || [])
    .filter((s) => !pendingIds.has(s.artwork_id) || locallySaved.has(s.artwork_id));
  for (const id of pendingIds) {
    if (locallySaved.has(id) && !selections.some((s) => s.artwork_id === id)) {
      selections.push({ artwork_id: id });
    }
  }
  return { ...fetched, artworks, selections };
}

// The DESIGN behind a card. A video is a render OF a design, so its Save/Keep
// state lives on `source_still_id`, not on the video row. Mirrors the server's
// resolveDesign. Pure.
const designIdOf = (a) => (a.stage === 'still' ? a.id : a.source_still_id ?? a.id);

// Optimistic status helpers (pure — safe to share across renders).
const setStatuses = (ids, status) => (d) => ({
  ...d,
  artworks: d.artworks.map((a) => (ids.includes(a.id) ? { ...a, status } : a)),
});
const restoreStatuses = (prev) => (d) => ({
  ...d,
  artworks: d.artworks.map((a) => (prev.has(a.id) ? { ...a, status: prev.get(a.id) } : a)),
});

// Group a surface's stills into "Keep & explore" families for rendering.
// A family = stills sharing a family_id (or a kept still with none). The kept
// member (its id is in keptSet) is the ANCHOR; its other non-rejected members
// are its variations rail. Stills with no family and no keeper — and any family
// that has lost its keeper — fall through as plain cards. Every still lands in
// exactly ONE place: an anchor, a variation, or a plain card (never double).
// Note the family_id test is what separates SAVE from KEEP: both write a
// selections row (so both are protected from a redo), but only Keep bootstraps
// a family_id. A merely-saved design therefore stays a plain card in its
// original position with a Saved badge, instead of being promoted into a
// full-width exploration anchor the reviewer never asked for.
function partitionFamilies(stills, keptSet) {
  const byFamily = new Map();
  const loners = [];
  for (const s of stills) {
    if (s.family_id != null) {
      if (!byFamily.has(s.family_id)) byFamily.set(s.family_id, []);
      byFamily.get(s.family_id).push(s);
    } else {
      loners.push(s);
    }
  }
  const anchors = [];
  for (const members of byFamily.values()) {
    const live = members.filter((m) => m.status !== 'rejected'); // dismissed variations vanish
    if (!live.length) continue;
    const keeper = live.find((m) => keptSet.has(m.id));
    if (keeper) {
      const variations = live.filter((m) => m.id !== keeper.id).sort((a, b) => a.id - b.id);
      anchors.push({ keeper, variations });
    } else {
      for (const m of live) loners.push(m); // keeper gone → members become plain cards
    }
  }
  anchors.sort((a, b) => a.keeper.id - b.keeper.id);
  loners.sort((a, b) => a.id - b.id);
  return { anchors, loners };
}

export function ReviewDashboard() {
  const [runs, setRuns] = useState([]);
  const [runsLoaded, setRunsLoaded] = useState(false);
  const [runId, setRunId] = useState(null);
  const [detail, setDetail] = useState(null);
  // Global lock ONLY for the heavy actions (generate/animate/regenerate/send).
  const [busy, setBusy] = useState(false);
  // Per-card in-flight optimistic actions — only the clicked card disables.
  const [pendingIds, setPendingIds] = useState(() => new Set());
  const [error, setError] = useState(null);
  const [showSend, setShowSend] = useState(false);
  const [showHistory, setShowHistory] = useState(false);
  const [spend, setSpend] = useState(null);
  // Which sign is generating a new design (drives the in-place placeholder).
  const [pendingSurface, setPendingSurface] = useState(null);
  const { toasts, push: pushToast, dismiss: dismissToast } = useToasts();

  const runIdRef = useRef(null);
  const pendingIdsRef = useRef(new Set());
  const detailRef = useRef(null); // latest detail, for snapshot-based optimistic reverts

  const markPending = useCallback((ids, on) => {
    setPendingIds((prev) => {
      const next = new Set(prev);
      for (const id of ids) { if (on) next.add(id); else next.delete(id); }
      pendingIdsRef.current = next;
      return next;
    });
  }, []);

  const refreshSpend = useCallback(() => { api.spend().then(setSpend).catch(() => {}); }, []);

  const refreshRuns = useCallback(async () => {
    const { runs: list } = await api.listRuns();
    setRuns(list);
    return list;
  }, []);

  // Fetch a run's detail. Drops the payload if the user switched runs while it
  // was in flight, and keeps optimistic statuses for still-pending cards.
  const loadDetail = useCallback(async (id) => {
    if (id == null) { setDetail(null); return; }
    const d = await api.getRun(id);
    if (runIdRef.current !== id) return; // stale — user moved on
    setDetail((cur) => mergeDetail(d, cur, pendingIdsRef.current));
  }, []);

  // First paint: runs list and spend fetch in PARALLEL (spend used to wait for
  // runs, and detail then waited for both).
  useEffect(() => {
    refreshSpend();
    refreshRuns()
      .then((list) => setRunId((cur) => cur ?? list[0]?.id ?? null))
      .catch((e) => setError(e.message))
      .finally(() => setRunsLoaded(true));
  }, [refreshRuns, refreshSpend]);

  // Detail loads the moment the run id is known (and on every week switch).
  useEffect(() => {
    runIdRef.current = runId;
    setError(null);
    if (runId == null) { setDetail(null); return undefined; }
    let cancelled = false;
    loadDetail(runId).catch((e) => { if (!cancelled) setError(e.message); });
    return () => { cancelled = true; };
  }, [runId, loadDetail]);

  const detailReady = !!detail && detail.run?.id === runId;
  const running = detailReady && detail.run.status === 'running';

  // Mirror detail into a ref so optimistic handlers can snapshot the pre-click
  // state for an exact rollback without re-subscribing to every change.
  useEffect(() => { detailRef.current = detail; }, [detail]);

  // Retire the placeholder once the run stops running. Guarded on having SEEN
  // it run, because `running` is still false in the moment between the click
  // and the 202 coming back.
  const sawRunning = useRef(false);
  useEffect(() => {
    if (running) sawRunning.current = true;
    else if (sawRunning.current) { sawRunning.current = false; setPendingSurface(null); }
  }, [running]);

  // Poll every 2s ONLY while a job runs — and not in a hidden tab. Resuming
  // visibility refetches immediately so the page catches up at a glance.
  useEffect(() => {
    if (!running) return undefined;
    let timer = null;
    const tick = () => loadDetail(runId).catch(() => {});
    const start = () => { if (timer == null) timer = setInterval(tick, 2000); };
    const stop = () => { if (timer != null) { clearInterval(timer); timer = null; } };
    const onVisibility = () => { if (document.hidden) stop(); else { tick(); start(); } };
    if (!document.hidden) start();
    document.addEventListener('visibilitychange', onVisibility);
    return () => { stop(); document.removeEventListener('visibilitychange', onVisibility); };
  }, [running, runId, loadDetail]);

  // Spend only moves when money is spent: refetch on running → done/failed
  // (was refetched on every poll and every card action).
  const lastRunState = useRef({ id: null, status: null });
  useEffect(() => {
    const id = detail?.run?.id ?? null;
    const status = detail?.run?.status ?? null;
    const last = lastRunState.current;
    if (id != null && id === last.id && last.status === 'running' && status && status !== 'running') {
      refreshSpend();
    }
    lastRunState.current = { id, status };
  }, [detail?.run?.id, detail?.run?.status, refreshSpend]);

  // ---- Heavy actions: global lock + full refetch (they replace whole cards
  // or kick off paid jobs — optimism would lie about what exists). ----

  const generate = async () => {
    setBusy(true); setError(null);
    try {
      const { runId: newId } = await api.generate();
      await refreshRuns();
      setRunId(newId); // the detail effect fetches the new run immediately
    } catch (e) { setError(e.message); } finally { setBusy(false); }
  };

  const animate = async () => {
    // Typed-but-unsaved video directions must never be silently ignored by a
    // paid video run (UX review P0, 2026-08-05). Offer to save them first —
    // OK saves every unsaved edit and continues; Cancel goes back to review.
    const dirty = dirtyDraftDesigns(detail?.artworks);
    if (dirty.length) {
      const n = dirty.length;
      const ok = window.confirm(
        `You changed the video directions on ${n} design${n === 1 ? '' : 's'} but didn't save.\n\n`
        + 'OK — save those changes and make the videos with them.\n'
        + 'Cancel — go back and review first.',
      );
      if (!ok) return;
      setBusy(true); setError(null);
      try {
        for (const a of dirty) await saveDraft(a);
      } catch (e) {
        setError(`Couldn't save your video directions — ${e.message}`);
        setBusy(false);
        return;
      }
    }
    setBusy(true); setError(null);
    try { await api.animate(runId); await loadDetail(runId); refreshSpend(); }
    catch (e) { setError(e.message); } finally { setBusy(false); }
  };

  // Per-sign regenerate: fresh options for ONE surface, others untouched.
  const regenerate = async (surfaceKey) => {
    setBusy(true); setError(null);
    try { await api.regenerate(runId, surfaceKey); await loadDetail(runId); }
    catch (e) { setError(e.message); } finally { setBusy(false); }
  };

  // Per-sign ADD: one more option for ONE surface. Nothing is retired — this is
  // the "I like all three but want to see a fourth" path, which regenerate
  // can't serve because it replaces (and refuses once everything is spoken for).
  //
  // `pendingSurface` is what makes the wait visible: the button shows its own
  // spinner and the section renders a placeholder card in the slot the new
  // design will fill. Before this, the ONLY feedback was a spinner in the page
  // header — frequently scrolled far out of view from the button you just
  // pressed, so the click looked like it did nothing (Shawn, 2026-07-29).
  const addDesign = async (surfaceKey) => {
    setBusy(true); setError(null); setPendingSurface(surfaceKey);
    try {
      await api.addDesign(runId, surfaceKey);
      await loadDetail(runId);
    } catch (e) {
      setError(e.message);
      setPendingSurface(null); // the request never started — drop the placeholder
    } finally { setBusy(false); }
  };

  // Per-design regenerate: replace ONE card only — its siblings stay.
  const regenerateOne = async (artworkId) => {
    setBusy(true); setError(null);
    try { await api.regenerateOne(artworkId); await loadDetail(runId); }
    catch (e) { setError(e.message); } finally { setBusy(false); }
  };

  // Explicit retry for an approved design whose video errored (UX P0) —
  // an animate, so it keeps the global lock + spend refresh.
  const retryAnimate = async (artworkId) => {
    setBusy(true); setError(null);
    try { await api.animateOne(artworkId); await loadDetail(runId); refreshSpend(); }
    catch (e) { setError(e.message); } finally { setBusy(false); }
  };

  // ---- Card actions: OPTIMISTIC. Local state flips instantly, the API call
  // settles in the background, a failure rolls back and explains. No
  // loadDetail() here — the 2s poll or the next navigation reconciles. ----
  const runOptimistic = useCallback(async ({ ids, apply, revert, call, success, tone }) => {
    markPending(ids, true);
    setDetail((d) => (d ? apply(d) : d));
    try {
      await call();
      if (success) pushToast(success, tone);
    } catch (e) {
      setDetail((d) => (d ? revert(d) : d)); // roll back just the touched cards
      pushToast(`Couldn't save that — ${e.message}`, 'error');
    } finally {
      markPending(ids, false);
    }
  }, [markPending, pushToast]);

  // Approve one card, or a whole EON 3-pillar set at once.
  const approveArtworks = useCallback((arts) => {
    const ids = arts.map((a) => a.id);
    const prev = new Map(arts.map((a) => [a.id, a.status]));
    const video = arts.length > 1 || arts[0].stage === 'motion';
    return runOptimistic({
      ids,
      apply: setStatuses(ids, 'approved'),
      revert: restoreStatuses(prev),
      call: () => Promise.all(ids.map((id) => api.approve(id))),
      success: video ? 'Video approved' : 'Design approved',
      tone: 'success',
    });
  }, [runOptimistic]);

  const rejectArtworks = useCallback((arts) => {
    const ids = arts.map((a) => a.id);
    const prev = new Map(arts.map((a) => [a.id, a.status]));
    return runOptimistic({
      ids,
      apply: setStatuses(ids, 'rejected'),
      revert: restoreStatuses(prev),
      call: () => Promise.all(ids.map((id) => api.reject(id))),
      success: 'Passed',
      tone: 'neutral',
    });
  }, [runOptimistic]);

  // ---- Save. The lightweight one: set a design aside so a redo can't replace
  // it, WITHOUT approving it and without opening a variations rail. Backed by
  // the same selections row as Keep, so it gets the same protection; the
  // difference is that Save leaves family_id null, which is what keeps the card
  // in place instead of promoting it to an exploration anchor. ----
  // The selection always lands on the DESIGN, never on a video row — the server
  // resolves it the same way, so the optimistic state has to match or the card
  // shows a Saved badge next to an un-saved button (QA, 2026-07-26).
  const addSelection = (id) => (d) => ((d.selections || []).some((s) => s.artwork_id === id)
    ? d
    : { ...d, selections: [...(d.selections || []), { artwork_id: id }] });
  const dropSelection = (id) => (d) => ({ ...d, selections: (d.selections || []).filter((s) => s.artwork_id !== id) });

  const saveArtwork = useCallback((art) => {
    const id = designIdOf(art);
    return runOptimistic({
      ids: [art.id, id],
      apply: addSelection(id),
      revert: dropSelection(id),
      call: () => api.select(art.id),
      success: 'Saved — a redo won’t replace it',
      tone: 'violet',
    });
  }, [runOptimistic]);

  const unsaveArtwork = useCallback((art) => {
    const id = designIdOf(art);
    return runOptimistic({
      ids: [art.id, id],
      apply: dropSelection(id),
      revert: addSelection(id),
      call: () => api.unselect(art.id),
      success: 'No longer saved',
      tone: 'neutral',
    });
  }, [runOptimistic]);

  // ---- Keep & explore. keep/unkeep/promote only move the keeper marker, so
  // they're OPTIMISTIC like the other card actions (the 2s poll / next nav
  // reconciles). vary/tweak GENERATE a family member — heavy path below. ----

  // Anchor a favourite so regeneration skips it and its variations rail opens.
  // Keep must ALSO set family_id optimistically. The dashboard tells Keep from
  // Save by family_id, and only the server was setting it — so keeping looked
  // like it did nothing at all until the page was reloaded (QA, 2026-07-26).
  const keepArtwork = useCallback((art) => {
    const id = designIdOf(art);
    const design = detailRef.current?.artworks.find((a) => a.id === id);
    const familyId = design?.family_id ?? id;
    const priorFamily = design?.family_id ?? null;
    const setFamily = (value) => (d) => ({
      ...d,
      artworks: d.artworks.map((a) => (a.id === id ? { ...a, family_id: value } : a)),
    });
    return runOptimistic({
      ids: [art.id, id],
      apply: (d) => setFamily(familyId)(addSelection(id)(d)),
      revert: (d) => setFamily(priorFamily)(dropSelection(id)(d)),
      call: () => api.keep(art.id),
      success: 'Kept — exploring versions',
      tone: 'violet',
    });
  }, [runOptimistic]);

  const unkeepArtwork = useCallback((art) => {
    const id = designIdOf(art);
    return runOptimistic({
      ids: [art.id, id],
      apply: dropSelection(id),
      revert: addSelection(id),
      // The server also clears family_id when nothing else is in the family;
      // refetch so the card demotes back to a plain card rather than lingering
      // as an anchor with no keeper.
      call: () => api.unkeep(art.id).then(() => loadDetail(runId)),
      success: 'No longer keeping that one',
      tone: 'neutral',
    });
  }, [runOptimistic, loadDetail, runId]);

  // Promote a variation to keeper: the old keeper in its family steps down.
  // familyIds carries every member so the previous keeper's marker is cleared.
  const promoteArtwork = useCallback((art, familyIds) => {
    const prevSelections = detailRef.current?.selections || [];
    return runOptimistic({
      // Whole family pending: a concurrent poll must not resurrect the old
      // keeper's selection mid-swap (mergeDetail holds pending selections).
      ids: [...familyIds],
      apply: (d) => ({
        ...d,
        selections: [
          ...(d.selections || []).filter((s) => !familyIds.has(s.artwork_id)),
          { artwork_id: art.id },
        ],
      }),
      revert: (d) => ({ ...d, selections: prevSelections }),
      call: () => api.promote(art.id),
      success: 'New keeper set',
      tone: 'violet',
    });
  }, [runOptimistic]);

  // vary / tweak spawn a new variation ($0.03): 202 + the run flips to
  // 'running', so they take the global lock + the existing poll/progress path.
  const vary = async (artworkId) => {
    setBusy(true); setError(null);
    try { await api.vary(artworkId); await loadDetail(runId); }
    catch (e) { setError(e.message); } finally { setBusy(false); }
  };
  const tweak = async (artworkId, instruction) => {
    setBusy(true); setError(null);
    try { await api.tweak(artworkId, instruction); await loadDetail(runId); }
    catch (e) { setError(e.message); } finally { setBusy(false); }
  };

  // Everything below derives from the CURRENT run only — while switching
  // weeks the stale detail shows skeletons, never last week's art.
  const view = detailReady ? detail : null;

  // Approved stills not yet animated → the Animate button's count. Stills whose
  // last attempt ERRORED are excluded — they get an explicit per-card Retry
  // instead of a silent re-spend (UX P0).
  const pendingAnimate = useMemo(() => {
    if (!view) return 0;
    const animated = new Set(view.artworks.map((a) => a.source_still_id).filter(Boolean));
    // "qa:" notes are advisory warnings, not failures — they don't block.
    return view.artworks.filter(
      (a) => a.stage === 'still' && a.status === 'approved' && !animated.has(a.id)
        && !(a.error && !a.error.startsWith('qa:')),
    ).length;
  }, [view]);

  const mode = view?.generationMode;

  // Approved animated pieces → ready to send to Jeff.
  const readyToSend = useMemo(
    () => (view ? view.artworks.filter((a) => a.stage === 'motion' && a.status === 'approved').length : 0),
    [view],
  );

  // Is a job actively running, and is it the video-making phase?
  const makingVideos = useMemo(() => {
    if (!running || !view) return false;
    const animated = new Set(view.artworks.map((a) => a.source_still_id).filter(Boolean));
    return view.artworks.some((a) => a.stage === 'still' && a.status === 'approved' && !animated.has(a.id));
  }, [running, view]);

  // Skeletons while the first runs/detail fetches are in flight (or when
  // switching weeks) — never a blank page, never last week's cards.
  const showSkeleton = !error && (!runsLoaded || (runId != null && !detailReady));

  // Mobile bottom bar: on a phone the header CTA ends up ~5,000px above the
  // last card it acts on (mobile audit 2026-08-01). Shown only when there is a
  // next step to take; main gets matching bottom padding so it never covers
  // the last card's buttons.
  const showActionBar = !running && !busy && (pendingAnimate > 0 || readyToSend > 0);

  return (
    <main className={`mx-auto max-w-6xl p-4 sm:p-6 ${showActionBar ? 'pb-28 sm:pb-6' : ''}`}>
      <Header
        runs={runs} runId={runId} onSelectRun={setRunId}
        onGenerate={generate} onAnimate={animate} pendingAnimate={pendingAnimate}
        readyToSend={readyToSend} onSend={() => setShowSend(true)}
        onHistory={() => setShowHistory(true)}
        busy={busy} run={view?.run} mode={mode} detail={view}
        running={running} makingVideos={makingVideos} spend={spend}
      />
      {error && <p role="alert" className="mb-4 break-words rounded bg-rose-950 px-3 py-2 text-sm text-rose-200">{error}</p>}
      {/* A failed batch says exactly WHY — never a silent page of missing art. */}
      {view?.run?.status === 'failed' && (
        <p role="alert" className="mb-4 rounded border border-rose-900 bg-rose-950 px-3 py-2 text-sm text-rose-200">
          <span className="font-semibold">This batch failed.</span>{' '}
          {view.run.error || 'Some designs could not be generated — the cards below show details.'}{' '}
          You can retry with a new batch, or regenerate just the affected designs below.
        </p>
      )}
      {showSkeleton ? (
        <SkeletonPage />
      ) : view ? (
        <RunView
          detail={view} busy={busy} running={running} pendingIds={pendingIds}
          onApprove={approveArtworks} onReject={rejectArtworks}
          onSave={saveArtwork} onUnsave={unsaveArtwork}
          onKeep={keepArtwork} onUnkeep={unkeepArtwork}
          onVary={vary} onTweak={tweak} onPromote={promoteArtwork}
          onRetry={retryAnimate} onRegenerate={regenerate} onAdd={addDesign} onRegenerateOne={regenerateOne}
          pendingSurface={pendingSurface}
          mode={mode}
        />
      ) : (
        <Empty onGenerate={generate} busy={busy} mode={mode} />
      )}
      {showSend && (
        <SendDialog
          runId={runId} onClose={() => setShowSend(false)}
          onSent={() => { loadDetail(runId).catch(() => {}); refreshSpend(); }}
        />
      )}
      {showHistory && <SentHistory onClose={() => setShowHistory(false)} />}
      {showActionBar && (
        <div className="fixed inset-x-0 bottom-0 z-40 flex gap-2 border-t border-neutral-800 bg-neutral-950/95 p-3 pb-[max(0.75rem,env(safe-area-inset-bottom))] backdrop-blur sm:hidden">
          {pendingAnimate > 0 && (
            <button
              type="button" onClick={animate} disabled={busy}
              className={`flex min-h-12 flex-1 items-center justify-center rounded bg-emerald-600 px-3 text-sm font-medium text-white transition-colors hover:bg-emerald-500 disabled:opacity-50 ${focusRing}`}
            >
              🎬 Make {pendingAnimate} video{pendingAnimate === 1 ? '' : 's'}
            </button>
          )}
          {readyToSend > 0 && (
            <button
              type="button" onClick={() => setShowSend(true)} disabled={busy}
              className={`flex min-h-12 flex-1 items-center justify-center rounded bg-amber-500 px-3 text-sm font-medium text-neutral-950 transition-colors hover:bg-amber-400 disabled:opacity-50 ${focusRing}`}
            >
              ✉ Send {readyToSend} to Jeff
            </button>
          )}
        </div>
      )}
      <Toasts items={toasts} onDismiss={dismissToast} />
    </main>
  );
}

function Header({ runs, runId, onSelectRun, onGenerate, onAnimate, pendingAnimate, readyToSend, onSend, onHistory, busy, run, mode, detail, running, makingVideos, spend }) {
  const [health, setHealth] = useState(null);
  useEffect(() => { api.health().then(setHealth); }, []);
  const effectiveMode = mode || health?.generationMode;
  // ONE primary CTA at a time — the next step in the flow is solid, everything
  // else drops to a quiet outline (CEO feedback: three loud buttons = "which?").
  const primary = pendingAnimate > 0 ? 'animate' : readyToSend > 0 ? 'send' : 'generate';
  // min-h-11 with NO width gate: the old sm:min-h-0 shrank these back to
  // 32-34px on touch iPads, which are ≥sm but still thumbs (mobile audit
  // 2026-08-01).
  const btnBase = `inline-flex min-h-11 items-center rounded px-3 py-1.5 text-sm font-medium transition-colors disabled:opacity-50 ${focusRing}`;
  return (
    <header className="mb-6 flex flex-wrap items-center justify-between gap-3 border-b border-neutral-800 pb-4">
      <div className="space-y-1">
        {/* flex-wrap: the mode + spend pills are long enough to overflow the h1
            on a phone and land on top of the title. Below `sm` they wrap to
            their own line beneath it. */}
        <h1 className="flex flex-wrap items-center gap-x-2 gap-y-1 text-xl font-semibold">
          <span>WOW Artwork Engine</span>
          <span className="flex w-full flex-wrap items-center gap-x-2 gap-y-1 sm:w-auto">
            <ModePill mode={effectiveMode} />
            <SpendPill spend={spend} />
          </span>
        </h1>
        <p className="text-xs text-neutral-400">
          Weekly AI artwork for the WOW signs — you approve everything before anything is made or sent
          {run && <> · week of {run.week_of} · <StatusBadge status={run.status} /></>}
        </p>
        <Stepper detail={detail} />
      </div>
      {/* flex-wrap + w-full below sm: without it this row measured 565px in a
          390px viewport, pushing "Send to Jeff" and "Create designs" entirely
          off-screen and giving the page 199px of horizontal scroll
          (QA, 2026-07-26). */}
      <div className="flex w-full flex-wrap items-center gap-2 sm:w-auto">
        {running ? (
          <span role="status" aria-live="polite" className="flex items-center gap-2 rounded-md bg-amber-950 px-3 py-1.5 text-sm font-medium text-amber-200">
            <Spinner className="border-amber-700 border-t-amber-300" />
            {progressLabel(run) || (makingVideos ? 'Making videos… (about 5–10 min each)' : 'Creating designs… (about 1 min)')}
          </span>
        ) : (
          <>
            {runs.length > 0 && (
              <select
                value={runId ?? ''}
                onChange={(e) => onSelectRun(Number(e.target.value))}
                title="Look back at earlier weeks"
                // text-base below sm: iOS force-zooms a focused select under
                // 16px. Full-width there — it shares a stacked column anyway.
                className={`min-h-11 w-full rounded border border-neutral-700 bg-neutral-900 px-2 py-1.5 text-base transition-colors sm:w-auto sm:text-sm ${focusRing}`}
              >
                {runs.map((r) => <option key={r.id} value={r.id}>Week of {r.week_of} · batch #{r.id}</option>)}
              </select>
            )}
            <button
              type="button" onClick={onHistory}
              title="Everything ever sent to Jeff, across all weeks"
              className={`${btnBase} border border-neutral-700 bg-neutral-900 text-neutral-300 hover:border-neutral-500 hover:text-white`}
            >
              📤 Sent history
            </button>
            {pendingAnimate > 0 && (
              <button
                type="button" onClick={onAnimate} disabled={busy}
                title="Turns every design you approved into a video (~$8–16 each: 30s spectacular ~$16, 15s EON ~$8)."
                className={`${btnBase} ${primary === 'animate'
                  ? 'bg-emerald-600 text-white hover:bg-emerald-500'
                  : 'border border-emerald-700/70 bg-transparent text-emerald-300 hover:border-emerald-600 hover:bg-emerald-600 hover:text-white'}`}
              >
                {busy ? 'Starting…' : `🎬 Make ${pendingAnimate} video${pendingAnimate === 1 ? '' : 's'} (~$8–16 each)`}
              </button>
            )}
            {readyToSend > 0 && (
              <button
                type="button" onClick={onSend} disabled={busy}
                title="Review the email, then deliver the approved videos to Jeff"
                className={`${btnBase} ${primary === 'send'
                  ? 'bg-amber-500 text-neutral-950 hover:bg-amber-400'
                  : 'border border-amber-600/70 bg-transparent text-amber-300 hover:border-amber-500 hover:bg-amber-500 hover:text-neutral-950'}`}
              >
                ✉ Send {readyToSend} to Jeff
              </button>
            )}
            <button
              type="button" onClick={onGenerate} disabled={busy}
              title="Makes 9 brand-new design options — 3 per sign type. To redo just one sign, use the button next to that sign below."
              className={`${btnBase} ${primary === 'generate'
                ? 'bg-[#0247FE] text-white hover:bg-[#0235c9]'
                : 'border border-neutral-700 bg-transparent text-neutral-400 hover:border-[#0247FE] hover:text-white'}`}
            >
              {busy ? 'Starting…' : effectiveMode === 'live' ? '✨ New batch — all signs (~$0.30)' : '✨ Create sample designs (free)'}
            </button>
          </>
        )}
      </div>
    </header>
  );
}

function Empty({ onGenerate, busy, mode }) {
  const live = mode === 'live';
  return (
    <div className="grid place-items-center rounded border border-dashed border-neutral-800 px-4 py-12 text-center sm:py-24">
      <div className="max-w-md">
        <p className="text-neutral-400">No artwork yet this week.</p>
        <p className="mt-1 text-xs text-neutral-400">
          Click below to create 9 design options (3 per sign type). Nothing becomes a video
          and nothing goes to Jeff until you approve it.
        </p>
        <button
          type="button" onClick={onGenerate} disabled={busy}
          className={`mt-3 min-h-11 rounded bg-[#0247FE] px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-[#0235c9] disabled:opacity-50 ${focusRing}`}
        >
          {busy ? 'Creating designs…' : live ? 'Create new designs (~$0.30)' : 'Create sample designs (free)'}
        </button>
      </div>
    </div>
  );
}

// Pulse placeholders in the real page shape — 3 per section at each sign's
// true aspect ratio — so the first paint reads "loading", not "broken".
function SkeletonPage() {
  return (
    <div className="space-y-10" aria-hidden="true">
      <section>
        <SkeletonHeading />
        <div className="space-y-4">
          {[0, 1, 2].map((i) => <SkeletonCard key={i} aspect="1692 / 468" />)}
        </div>
      </section>
      <section>
        <SkeletonHeading />
        <div className="max-w-2xl space-y-6">
          {[0, 1, 2].map((i) => <SkeletonCard key={i} aspect="4096 / 1638" />)}
        </div>
      </section>
      <section>
        <SkeletonHeading />
        {/* Mirrors the REAL single-pillar grid (grid-cols-1 lg:2 xl:3) — the
            skeleton's whole job is to hold the page's shape, and a 2-col
            skeleton reflowing into a 1-col page was the most-seen frame on a
            slow phone connection (mobile audit 2026-08-01). */}
        <div className="grid grid-cols-1 gap-4 lg:grid-cols-2 xl:grid-cols-3">
          {[0, 1, 2].map((i) => <SkeletonCard key={i} aspect="2 / 3" />)}
        </div>
      </section>
    </div>
  );
}

function SkeletonHeading() {
  return (
    <div className="mb-3 space-y-1.5">
      <div className="h-3.5 w-56 max-w-full rounded bg-neutral-800 motion-safe:animate-pulse" />
      <div className="h-3 w-80 max-w-full rounded bg-neutral-800 motion-safe:animate-pulse" />
    </div>
  );
}

function RunView({ detail, busy, running, pendingIds, onApprove, onReject, onSave, onUnsave, onKeep, onUnkeep, onVary, onTweak, onPromote, onRetry, onRegenerate, onAdd, onRegenerateOne, mode, pendingSurface }) {
  const { artworks } = detail;
  // Saved (bookmarked) design ids — kept while regenerating, without approving.
  const savedSet = useMemo(() => new Set((detail.selections || []).map((s) => s.artwork_id)), [detail.selections]);
  // An approved design with no video yet, while a job is running → it's being made.
  const isAnimating = (still, motion) => running && !motion && still.status === 'approved';
  const motionsByStill = useMemo(() => {
    const m = new Map();
    for (const a of artworks) {
      if (a.stage === 'motion' && a.source_still_id) {
        if (!m.has(a.source_still_id)) m.set(a.source_still_id, []);
        m.get(a.source_still_id).push(a);
      }
    }
    return m;
  }, [artworks]);

  // Design rows by id — the remake path needs the source design behind a video.
  const stillById = useMemo(
    () => new Map(artworks.filter((x) => x.stage === 'still').map((x) => [x.id, x])),
    [artworks],
  );

  // Per-card busy: only the clicked card's buttons disable while its call is
  // in flight; the global lock still applies during heavy actions/runs.
  const actionsFor = (a) => ({
    status: a.status, busy: busy || running || pendingIds.has(a.id),
    onApprove: () => onApprove([a]),
    onReject: () => onReject([a]),
    // Explicit retry for an approved design whose video errored (UX P0).
    // "qa:" notes are warnings, not failures — no retry needed.
    ...(a.stage === 'still' && a.status === 'approved' && a.error && !a.error.startsWith('qa:')
      ? { onRetry: () => onRetry(a.id) }
      : {}),
    // A passed (rejected) video gets a remake path: surface the source
    // design's editable directions and re-render (UX review P1, 2026-08-05).
    ...(a.stage === 'motion' && a.status === 'rejected' && stillById.get(a.source_still_id)
      ? {
        remakeStill: stillById.get(a.source_still_id),
        remakeCost: mode === 'live' ? ' (~$12)' : ' (free)',
        onRemake: () => onRetry(a.source_still_id),
      }
      : {}),
    // Plain stills get "⭐ Keep & explore" — anchor a favourite, then spin off
    // variations (Scott: keep one he likes while re-rolling the rest, 2026-07-21).
    // A kept still isn't a plain card anymore — it renders as an anchor instead.
    // Save = set aside without approving; a redo can't replace it. Toggling
    // off is offered on the same button so a saved card isn't a dead end.
    // Both work from a VIDEO card too (Shawn, 2026-07-26): a video is a render
    // OF a design, so they act on the design behind it. Exploring from a video
    // yields a new DESIGN to approve and animate — never an automatic re-render.
    ...(a.status !== 'superseded' && a.status !== 'sent' && (a.stage === 'still' || a.source_still_id)
      ? {
        saved: savedSet.has(designIdOf(a)),
        onToggleSave: () => (savedSet.has(designIdOf(a)) ? onUnsave(a) : onSave(a)),
        // Keep & explore is the heavier commitment: it also opens a versions rail.
        ...(savedSet.has(designIdOf(a)) ? {} : { onKeep: () => onKeep(a) }),
      }
      : {}),
    // Replace just THIS design (approved and saved ones are protected —
    // Pass / unsave first).
    ...(a.stage === 'still' && a.status !== 'approved' && !savedSet.has(a.id)
      ? { onRegen: () => onRegenerateOne(a.id) }
      : {}),
  });
  // One decision covers every panel of a pillar set. Save/Keep act on the
  // DESIGN the set was rendered from, which all its panels share.
  const groupActions = (faces) => {
    const design = faces[0] ? designIdOf(faces[0]) : null;
    const isSaved = design != null && savedSet.has(design);
    return {
      status: faces[0]?.status,
      busy: busy || faces.some((f) => pendingIds.has(f.id)),
      onApprove: () => onApprove(faces),
      onReject: () => onReject(faces),
      ...(faces[0]?.source_still_id && faces[0]?.status !== 'sent'
        ? {
          saved: isSaved,
          onToggleSave: () => (isSaved ? onUnsave(faces[0]) : onSave(faces[0])),
          ...(isSaved ? {} : { onKeep: () => onKeep(faces[0]) }),
        }
        : {}),
    };
  };

  // Superseded = retired by a per-sign regenerate; hidden from review.
  const stillsOf = (style) =>
    artworks.filter((a) => a.stage === 'still' && a.style === style && a.status !== 'superseded');

  // "n of N reviewed" — counts each surface's families/plain cards (NOT every
  // variation, which would inflate the total). A kept anchor counts as
  // reviewed; a plain card counts once it's approved or passed. `extra` folds
  // in already-animated designs that live outside the family partition.
  const chipFromUnits = ({ anchors, loners }, extra = []) => {
    const items = [...loners, ...extra];
    const total = anchors.length + items.length;
    if (!total) return null;
    const reviewed = anchors.length
      + items.filter((s) => s.status === 'approved' || s.status === 'rejected').length;
    return { reviewed, total };
  };

  // Per-sign header buttons. Two deliberately different verbs:
  //   Add another  — one MORE option; nothing you already have is touched.
  //   Replace unsaved — REPLACES the ones you haven't saved or approved.
  // The pair matters: with all three designs liked, Replace refuses outright, and
  // "I want to see a fourth" had no button at all before (Scott, 2026-07-26).
  const cost = mode === 'live' ? ' (~$0.03)' : ' (free)';
  // 26.5px measured before — under half the phone tap target (QA, 2026-07-26).
  // min-h-11 unconditional + justify-center: labels wrap to two lines inside
  // full-width stacked buttons below sm (mobile audit 2026-08-01).
  const headerBtn = `inline-flex min-h-11 items-center justify-center rounded border px-2.5 py-2 text-center text-xs font-medium leading-snug transition-colors disabled:opacity-50 sm:justify-start sm:text-left ${focusRing}`;
  const sectionActions = (surfaceKey) => (
    <span className="flex w-full flex-col gap-2 sm:w-auto sm:flex-row sm:flex-wrap sm:items-center sm:gap-1.5">
      {/* The button says what it is doing. Dimming a disabled button is far too
          quiet a signal for an action that takes ~20 seconds. */}
      <button
        type="button" disabled={busy || running} onClick={() => onAdd(surfaceKey)}
        title="Generate one more option for this sign — everything you already have stays exactly as it is."
        className={`${headerBtn} gap-1.5 border-[#0247FE]/60 bg-transparent text-[#7FA3FF] hover:border-[#0247FE] hover:bg-[#0247FE] hover:text-white disabled:hover:bg-transparent`}
      >
        {pendingSurface === surfaceKey
          ? <><Spinner className="h-3.5 w-3.5" /> Making a new design…</>
          : <>+ Add another design{cost}</>}
      </button>
      <button
        type="button" disabled={busy || running} onClick={() => onRegenerate(surfaceKey)}
        title="Replaces the designs you haven't saved or approved."
        className={`${headerBtn} border-neutral-700 bg-neutral-900 text-neutral-300 hover:border-[#0247FE] hover:text-white`}
      >
        ↻ Replace unsaved designs{mode === 'live' ? ' (~$0.03 each)' : ' (free)'}
      </button>
      {/* The Add-vs-Replace distinction lived only in title tooltips, which
          never fire on touch (mobile audit 2026-08-01). */}
      <span className="text-[11px] leading-snug text-neutral-400 sm:hidden">
        Add = one more option, nothing changes. Replace = re-rolls the ones you haven’t saved or approved.
      </span>
    </span>
  );

  const spectacular = stillsOf('frame_break');
  const connected = stillsOf('eon_connected');
  const singles = stillsOf('eon_single');

  // Keep & explore grouping. keep/unkeep/promote flow to the whole family; the
  // per-card approve/pass/vary/tweak are bound inside ExplorationFamily.
  const familyHandlers = { onApprove, onReject, onUnkeep, onVary, onTweak, onPromote };
  const spectacularU = partitionFamilies(spectacular, savedSet);
  // Both EON surfaces animate into a SET of panels (each pillar's spine + its
  // face, cut from one design), so both use the same grouping: once a design
  // has panels it leaves the exploration stage and renders as a pod set.
  // `latestPanels` picks the newest row per panel, so a re-roll replaces the
  // set rather than stacking a stale one alongside it.
  const panelsFor = (still) => latestPanels(motionsByStill.get(still.id), still.style);
  const splitAnimated = (stills) => {
    const animated = stills.filter((s) => panelsFor(s).length);
    const units = partitionFamilies(stills.filter((s) => !panelsFor(s).length), savedSet);
    return { animated, units, rest: [...animated, ...units.loners].sort((a, b) => a.id - b.id) };
  };
  const conn = splitAnimated(connected);
  const connectedU = conn.units;
  const sing = splitAnimated(singles);
  const singlesU = sing.units;

  // Anchors (kept designs + their variation rails) render full-width above each
  // surface's plain-card layout. getMotion swaps in the keeper's video once it's
  // been animated (EON keepers stay stills — their motion is a set of panels,
  // shown as a pod set below rather than as one card).
  // `maxW` caps the anchor for tall surfaces. A kept single pillar is 2:3, so
  // full-width rendered it 1078x1436 — 1.6 screen-heights for one card, versus
  // 357x546 as a plain card in the same section (QA, 2026-07-26). Wide
  // surfaces (the 3.6:1 billboard) genuinely want the full width.
  const renderAnchors = (anchors, getMotion, maxW = '') => (anchors.length > 0 ? (
    <div className={`mb-6 space-y-6 ${maxW}`}>
      {anchors.map(({ keeper, variations }) => {
        const keeperMotion = getMotion(keeper);
        return (
          <ExplorationFamily
            key={keeper.id} keeper={keeper} keeperMotion={keeperMotion} variations={variations} mode={mode}
            animating={isAnimating(keeper, keeperMotion || null)} busy={busy} running={running}
            pendingIds={pendingIds} handlers={familyHandlers}
          />
        );
      })}
    </div>
  ) : null);
  const latestMotion = (k) => motionsByStill.get(k.id)?.at(-1);
  const noMotion = () => undefined;

  // Option counts are computed, never hardcoded: "Add another design" means a
  // sign can hold any number now, and a header still claiming "3 design
  // options" above four cards is the kind of small lie that erodes trust.
  const specChip = chipFromUnits(spectacularU);
  const connChip = chipFromUnits(connectedU, conn.animated);
  const singChip = chipFromUnits(singlesU, sing.animated);
  const options = (chip) => `${chip?.total ?? 0} design option${chip?.total === 1 ? '' : 's'}`;

  // The placeholder occupies the slot the new design will fill, at that sign's
  // real aspect ratio so nothing jumps when the design arrives.
  const GEN_ASPECT = { spectacular: '4096 / 1132', eon_connected: '4096 / 1638', eon_single: '3200 / 3840' };
  const pendingCard = (surfaceKey) => (pendingSurface === surfaceKey
    ? <PendingDesignCard aspect={GEN_ASPECT[surfaceKey]} sub={mode === 'live' ? 'about 20 seconds' : 'a moment'} />
    : null);

  return (
    <div className="space-y-10">
      <Section title="Spectacular — big street billboard" subtitle={`${options(specChip)} · Approved designs become one-take 30-second 4K videos that tell a story in motion.`} chip={specChip} action={sectionActions('spectacular')}>
        {renderAnchors(spectacularU.anchors, latestMotion)}
        <div className="space-y-4">
          {spectacularU.loners.map((still) => {
            // .at(-1): after a re-roll, show the LATEST video.
            const motion = motionsByStill.get(still.id)?.at(-1);
            const a = motion || still;
            return <Card key={still.id} artwork={a} actions={actionsFor(a)} animating={isAnimating(still, motion)} saved={savedSet.has(designIdOf(a))} />;
          })}
          {pendingCard('spectacular')}
        </div>
      </Section>

      <Section
        title="EON — 3-pillar set"
        subtitle={`${options(connChip)} · One wide design spread across all three pillars. Approved designs become 15-second videos.`}
        chip={connChip} action={sectionActions('eon_connected')}
      >
        {renderAnchors(connectedU.anchors, noMotion)}
        <WrapLegend pods={3} />
        <div className="space-y-6">
          {conn.rest.map((still) => {
            const panels = panelsFor(still); // latest spine+face set per pillar
            return panels.length
              ? <PodSet key={still.id} panels={panels} actions={groupActions(panels)} caption="The finished 3-pillar set — watch the artwork cross from one pillar to the next, and wrap onto each spine" />
              : <div key={still.id} className="max-w-2xl"><Card artwork={still} actions={actionsFor(still)} animating={isAnimating(still, null)} saved={savedSet.has(designIdOf(still))} /></div>;
          })}
          <div className="max-w-2xl">{pendingCard('eon_connected')}</div>
        </div>
      </Section>

      <Section
        title="EON — single pillar"
        subtitle={`${options(singChip)} · Approved designs become a 15-second 4K pillar video — the face plus the side strip.`}
        chip={singChip} action={sectionActions('eon_single')}
      >
        {renderAnchors(singlesU.anchors, noMotion, 'max-w-md')}
        <WrapLegend pods={1} />
        {/* One column on a phone: each card carries four action buttons under
            it, which are unusable squeezed into a half-width column. */}
        <div className="grid grid-cols-1 gap-4 lg:grid-cols-2 xl:grid-cols-3">
          {sing.rest.map((still) => {
            const panels = panelsFor(still);
            return panels.length
              ? <PodSet key={still.id} panels={panels} actions={groupActions(panels)} caption="The finished pillar — its face plus the spine that wraps around its left edge" />
              : <Card key={still.id} artwork={still} actions={actionsFor(still)} animating={isAnimating(still, null)} saved={savedSet.has(designIdOf(still))} />;
          })}
          {pendingCard('eon_single')}
        </div>
      </Section>
    </div>
  );
}

function Section({ title, subtitle, chip, action, children }) {
  return (
    <section>
      <div className="mb-3 flex flex-wrap items-end justify-between gap-2">
        <div>
          <h2 className="flex flex-wrap items-center gap-2 text-sm font-semibold uppercase tracking-wide text-neutral-300">
            {title}
            {chip && (
              <span className={`rounded-full border px-2 py-0.5 text-[10px] font-medium normal-case tracking-normal ${
                chip.reviewed >= chip.total
                  ? 'border-emerald-800 bg-emerald-950 text-emerald-300'
                  : 'border-neutral-700 bg-neutral-900 text-neutral-400'
              }`}
              >
                {chip.reviewed} of {chip.total} reviewed
              </span>
            )}
          </h2>
          <p className="text-xs text-neutral-400">{subtitle}</p>
        </div>
        {action}
      </div>
      {children}
    </section>
  );
}

// A Keep & explore family: the kept ANCHOR up top, its variations rail beneath.
// Approve/Pass/Un-keep settle optimistically; Vary/Tweak generate ($0.03) and
// flip the run to 'running'. Every button is pre-bound to the right artwork id
// here so AnchorCard/VariationCard stay purely presentational.
function ExplorationFamily({ keeper, keeperMotion, variations, animating, busy, running, pendingIds, handlers, mode }) {
  const { onApprove, onReject, onUnkeep, onVary, onTweak, onPromote } = handlers;
  const preview = keeperMotion || keeper; // show the keeper's video once animated
  const familyIds = useMemo(
    () => new Set([keeper.id, ...variations.map((v) => v.id)]),
    [keeper.id, variations],
  );
  const gen = busy || running; // a generation locks the whole family
  // Fixture mode really is free — quoting $0.03 there contradicts the section
  // buttons, which already say "(free)" (QA, 2026-07-26).
  const cost = mode === 'live' ? ' (~$0.03)' : ' (free)';
  return (
    <div className="rounded-xl border border-amber-500/30 bg-amber-500/[0.03] p-2 sm:p-3">
      <AnchorCard
        artwork={preview}
        animating={animating}
        busy={gen || pendingIds.has(keeper.id)}
        onApprove={() => onApprove([preview])}
        onReject={() => onReject([preview])}
        onVary={() => onVary(keeper.id)}
        onTweak={(t) => onTweak(keeper.id, t)}
        onUnkeep={() => onUnkeep(keeper)}
        cost={cost}
      />
      <div className="mt-3">
        <p className="mb-2 text-[11px] leading-snug text-neutral-400">
          {mode === 'live' ? 'Each version costs ~$0.03.' : 'Each version is free.'} This design stays.
        </p>
        {variations.length > 0 ? (
          // grid-cols-1 base: at 2-up a phone-width 3.6:1 variation preview
          // measured 42px tall under ~230px of buttons (mobile audit 2026-08-01).
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-3 lg:grid-cols-4">
            {variations.map((v) => (
              <VariationCard
                key={v.id}
                artwork={v}
                busy={gen || pendingIds.has(v.id)}
                onApprove={() => onApprove([v])}
                onReject={() => onReject([v])}
                onPromote={() => onPromote(v, familyIds)}
                onVary={() => onVary(v.id)}
                onTweak={(t) => onTweak(v.id, t)}
                cost={cost}
              />
            ))}
          </div>
        ) : (
          <p className="rounded border border-dashed border-neutral-800 px-3 py-2 text-[11px] text-neutral-400">
            No versions yet.
          </p>
        )}
      </div>
    </div>
  );
}
