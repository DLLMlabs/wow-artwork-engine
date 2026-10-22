# WOW Artwork Engine — Status Update

**Last updated:** 2026-08-10 · **State:** ✅ Live in production, fully featured · **Maintainer:** shawn@wowmedia.com

> **🚀 LIVE.** The **Artwork Engine** tab is in WOW's dashboard (wow-contract-query,
> **wowautomation.ai**). Scott can generate, review, keep/explore, tweak, approve, and
> ship artwork to Jeff today. Runs in **LIVE mode** (real AI spend on button-press).
> The weekly auto-scheduler stays **OFF** until you flip it on.

---

## What this is (one line)

A weekly "art studio" for WOW's billboards: it **makes** fresh AI artwork → Scott
**reviews and picks** on a screen → it **ships** the picks to Jeff, already sized and
ready to run. Two-phase and human-gated: cheap **style stills** first ($0.03 each),
then expensive **4K videos** only on the designs Scott approves.

---

## The signs it makes each week

| Sign | Final output | Look |
|---|---|---|
| **Spectacular** (street billboard) | 1692×468 (panel-native per Jeff, 2026-10-21) | 3D "pop-out" — subject bursts out of a black frame painted into the art |
| **EON — 3-pillar set** | ONE master strip **960×384** (per pillar: spine 64×384 + face 256×384 — Jeff's panel-native, 2026-08-21) | the artwork travels pillar-to-pillar and wraps around each corner |
| **EON — single pillar** | ONE master strip **320×384** (spine 64×384 + face 256×384) | standalone vertical piece, wrapping its own corner |

Every EON pillar has a narrow LED **spine** down its left side facing oncoming
drivers. Both the spine and the face are cut from **one** design, so the artwork
carries around the corner instead of the spine being a separate afterthought.

3 options per sign each week. Psychedelic, high-saturation, characterful creatures
(koi, octopus, peacock, jellyfish…), full-scene motion with real 3D depth.

---

## What Scott can do on the dashboard

1. **Generate** a week of designs (or redo one sign, or one design).
2. **Review** each option — approve, pass, or explore.
3. **⭐ Keep & explore** a design he likes → it's locked safe, with a **variations rail**:
   - **↻ Vary** — another version of the same piece
   - **✎ Tweak…** — type a plain-language change ("more electric blue, calmer background");
     an LLM edits *only that* into the prompt and regenerates, with a note on what changed
   - **⭐ Make keeper** — promote a variation; the original is never lost
4. **Make videos** from approved designs (4K, ~$8–16 each) — with a live progress counter.
5. **Approve videos**, then **✉ Send to Jeff** (Google Drive + Gmail).
6. **📤 Sent history** — every delivery ever made to Jeff, with Drive links.

Guided **1 Pick designs → 2 Make videos → 3 Send to Jeff** flow, one clear next action
at a time, "N of 3 reviewed" progress per sign.

---

## Build stages

| Stage | Plain terms | Status |
|---|---|---|
| **M1 — The art machine** | Makes a full week automatically; two-phase (stills → approved-only videos). | ✅ Done, live |
| **M2 — The review screen** | The Artwork Engine tab: review, approve, keep/explore, tweak. | ✅ Done, live |
| **M3 — Send to Jeff** | One-click ship to Google Drive + Gmail; sent-history log. | ✅ Done, live |
| **M4 — Go live + polish** | 4K pop-out, accurate costs, per-design regen, keep & explore, perf/UX overhaul. | ✅ Shipped |

---

## Changelog (this delivery arc)

- **2026-09-02 — Boundary refusals: retry once + de-weaponized Wild West.** The Wild
  West wild-theme still was refused by ByteDance's likeness filter — but a full
  forensic ablation (the exact image, its regions, the padded production copy, even a
  byte-faithful replica with the real motion prompt) passed 6/6 on resubmission. So
  unlike the deterministic merfolk case, this was a NOISY boundary refusal: the
  semi-realistic armed riflemen Seedream invented in the mid-ground sit right at the
  filter's threshold. Three fixes: (1) Seedance calls now auto-retry ONCE on a
  content-policy refusal (flakes become renders; true refusals refuse twice, unbilled);
  (2) the Wild West hero is now a lasso-swinging cowgirl — "gunslinger" was seeding
  rifles on every background figure, and guns don't belong on a WOW billboard anyway;
  (3) every still prompt now bans weapons outright. Card copy updated to match.

- **2026-08-26 — Photoreal humans stylized (Seedance refusals fixed).** Two wild-theme
  designs (the Atlantis merfolk, the Deep Space crowd) were refused by ByteDance's
  anti-deepfake moderation: it blocks animating any image containing what reads as a
  PHOTOGRAPH of a person — fictional or not. Proven with a controlled test: the same
  merfolk still passed at 1280px preview detail and was refused at the full 4096px
  master, benign prompt both times. Fix at the source: every still prompt now demands
  stylized painterly characters ("never a photorealistic human likeness") — humans stay
  allowed, just illustrated. And the card now translates the refusal into plain language
  ("a character looks too much like a real person… Replace or Tweak the design — Try
  again resends the same image and will be refused again") instead of raw JSON.

- **2026-08-21 — EON goes panel-native, delivered as ONE master file (Jeff's email).**
  Jeff: "Spines: 64w x 384h each · Faces: 256w x 384h each · Total master size:
  960w x 384 … If you are able to send it as one master file that would speed up
  the turnaround time." Done on all counts: EON specs are now his exact LED
  resolutions (aspects unchanged — spine 1:6, face 2:3, 20/80 pod split, so
  compositions are untouched), and Send-to-Jeff ships each approved pillar set as
  ONE wrapped master strip (960×384 for the 3-pillar, 320×384 for a single)
  instead of six per-panel files. Panel files still exist for the review screen's
  wrap preview; a master delivery marks every panel of its set sent. Bonus: EON
  renders now skip the Topaz 4K pass (720p already exceeds 384px output) —
  meaningfully cheaper per EON video. The spectacular is unchanged (4K, Topaz).

- **2026-08-18 (3) — Wild-theme slots.** Spectacular option 3 and EON-connected option 2
  now roll a RANDOMIZED era/world theme every batch (Cyberpunk, Roaring Twenties,
  Steampunk, Synthwave, Wild West, Feudal Japan, Ancient Egypt, Deep Space, Medieval
  Fantasy, Lost Atlantis, Prehistoric, Masquerade Carnival) — always digital art in that
  theme with theme-relevant characters, instead of the house psychedelic families. The
  rolled theme's name is stored on the row (`theme_label`, migration 009) and the
  dashboard shows a "🎲 Random theme: <name>" badge next to that generation. Wild picks
  are batch-seeded (fresh every "New batch", reproducible per run); vary/tweak inherit
  the source's theme. All other rules (borderless track, one take, camera lock, QA)
  unchanged.
- **2026-08-18 (2) — Production mode: 30-second pieces + 4K upscale.** Iteration mode
  is over: spectacular clips are back to the full 30s take and the Topaz 4× upscale is
  ON by default again (~$16.20 per spectacular render, ~10–20 min per video). The old
  knobs still work in reverse — `GEN_SPECTACULAR_DURATION_S=10` and `FAL_UPSCALE=0`
  bring back cheap fast iteration rounds. NOTE: these are now the CODE defaults; if the
  production env file (S3) still carries explicit `GEN_SPECTACULAR_DURATION_S` or
  `FAL_UPSCALE` values, those win — make sure neither is set there (or set them to
  30 / 1).
- **2026-08-18 — Split tracks: option 1 framed, options 2–3 borderless (shipping to
  WOW).** Shawn: "it's already late… I wanna get this out and running to WOW" — so the
  three spectacular options stop being three tries at the same thing. Option 1 keeps the
  signature trompe-l'oeil painted border and all frame rules (the mastery track). Options
  2 and 3 are now borderless full-bleed cinematic scenes — no frame, no vignette, scenery
  to every edge — with the vision director and the motion contract switched to a
  maximum-intensity variant (relentless speed, dramatic near-misses, a genuinely exciting
  story). Frame rules drop out for the borderless tracks; edges become free entrances and
  exits, and only a character filling the whole screen stays banned. Shared law is
  unchanged for all three: one take, camera lock, departure-shaped stories, living
  environment, letterbox-margin dead space, color constancy, and every QA instrument.
- **2026-08-15 (3) — The aspect decision is ours: pre-letterboxed references.**
  video_2 "completely missed the mark on the aspect ratio": given the raw
  3.62:1 art, Seedance re-staged it as a tiny framed picture floating in its
  own ~square canvas (the snake slithered out of the picture into the void),
  and the never-stretch rule delivered it honestly tiny. Fix: the engine now
  pads the approved still to EXACTLY 16:9 with pure black margins before
  sending — a canvas Seedance natively produces — so frame 1 is our padded
  image with the art spanning full width, and extraction strips precisely the
  bars we added. The motion prompt declares the margins dead space (nothing
  enters or lights them; the picture band never moves or resizes). Best-effort
  with fallback to the raw still URL.
- **2026-08-15 (2) — The boundary rule, stated right.** Shawn's clarification
  after the eagle render: passing IN FRONT of the frame is always allowed —
  wingtips over the strips, paint bursting across it, even briefly covering
  it; that IS the pop-out. The ONE inviolable line is the picture's outer
  edge: nothing may be clipped by the image boundary or fill the whole screen
  (the eagle's flyby broke exactly that). Wrapper + director brief now state
  it precisely: "in front of the frame: yes; past the picture's edge: never —
  even at its closest and largest, a character fits entirely within the
  picture."
- **2026-08-15 — The environment moves too + frame-order measured.** (1) The
  scenes read static because every environment-motion demand had been stripped
  in the minimal-contract pass — only characters were compelled to move, and
  the director cast scenery as static "cover and props". Restored on all three
  layers: the wrapper ("the environment is a character too… no region ever
  calm; every pixel is alive"), the director brief (script how the visible
  scenery moves and reacts — currents, whipping plants, churning mist), and
  the opening still itself now depicts the scenery mid-motion so the video
  inherits momentum from frame 1. (2) Frame-order is now MEASURED per render:
  SSIM of the clip's first and last frames vs the approved still is logged,
  and a card flag fires whenever the end resembles the still more than the
  start ("the model animated toward the input") — no more guessing which end
  of the video the preview became.
- **2026-08-14 (4) — Frame-eating crop fixed + departure stories.** The cheetah
  render exposed two defects. (1) cropdetect couldn't tell Seedance's letterbox
  padding from the artwork's own painted black frame and cropped INTO the
  frame. Extraction is now pure geometry (design aspect vs raw canvas) and
  only strips bars after PROVING they measure near-black — it can never eat
  the frame. (2) The approved still was showing up as the video's LAST frame:
  arrival-shaped stories (decisive payoff ≈ the still's composed tableau) made
  the model animate toward the input image. The director and the prompt
  wrapper now demand DEPARTURE — the story starts exactly on the still's
  frozen moment, immediately moves away, and must end visibly different from
  where it began.
- **2026-08-14 (3) — Squish fixed + a story restored.** The first no-plate render
  came out vertically squished: Seedance can't produce 3.6:1, letterboxes the
  art in a taller canvas, and the exact-fit conform then STRETCHED bars+art to
  spec. Fix: cropdetect removes the actual black padding (extraction, not
  repair), and stretching is gone for good — a true aspect mismatch delivers
  undistorted (padded) with a loud card flag. And because "there's no real
  story to it": the motion prompt gains ONE untimed story sentence naming the
  design's own cast (beginning → journey → payoff) — narrative without the
  timestamped beats that caused cuts.
- **2026-08-14 (2) — Shawn's flow-review change set.** From the ARTWORK_FLOW.md
  read-through: (1) frame plate fully retired — nothing is ever composited on
  stills OR videos; the perimeter is Seedream's to paint and Seedance's to
  keep. (2) Topaz upscale OFF during iteration (FAL_UPSCALE=1 restores it for
  real deliveries) — a 10s render is now ~$4.60 and ~3–6 min. (3) The silent
  aspect center-crop is gone: wrong-shaped renders deliver as-is with a loud
  flag on the card. (4) Fresh subjects + environments every batch (prompt
  seed salts with the batch id) and full creative freedom — humans and any
  characters allowed; only text/logos stay banned. (5) Motion: characters go
  ONTO the frame with their whole form always inside the picture (leaving the
  bounds ruins the illusion), first-frame=last-frame line removed, "smooth,
  premium" replaced with "rapid, exciting".
- **2026-08-14 — 10-second iteration mode + the flow documented.** Movement still
  minimal and cuts still appearing after the minimal-prompt round, so the
  spectacular renders at **10s (~$5.40, ~4–8 min)** while the visuals get
  nailed — `GEN_SPECTACULAR_DURATION_S=30` restores the full piece without a
  deploy. The complete criteria + flow (exact prompts included) now lives in
  `ARTWORK_FLOW.md`.
- **2026-08-10 (night) — Nothing on top of the video + hands-off motion.** Review
  of the first Test Art render (Shawn): the video cut to a different shot at
  ~9.7s — exactly on the prompt's "movement" beat boundary, proving Seedance
  2.5 reads timestamped sections as a shot list — and the composited frame
  plate's translucent depth rings floated as a black gradient IN FRONT of the
  painted frame. Both gone: (1) the video is delivered exactly as the model
  made it — nothing is superimposed; the frame plate is applied to the STILL
  only, and the video keeps the frame it inherits from that still as real
  pixels everything can interact with. (2) The motion prompt is now minimal
  by design: one continuous take (never cut), keep the framing, never remove
  the frame, characters interact with it, colors hold. No choreography, no
  story beats, no timestamps — the model owns the motion.
- **2026-08-10 (evening) — Free endings + story-driven movement.** First live 2.5
  creative reviewed subpar (Shawn): the end-frame anchor made the motion feel
  obligated to reach a target frame, and the characters circled in the center.
  Both causes removed. (1) The video is no longer anchored on a closing still —
  no end frame is sent (even for older designs that have one), and new designs
  skip generating the closing still entirely; the ending is described in the
  prompt and left free to move. (2) The four scene arcs were rewritten as
  stories told through movement — pursuits, meetings of forces, awakenings,
  rivalries — that travel the full width and depth of the canvas, with the
  circling vocabulary ("orbit", "vortex", "figure-eights") banned and an
  explicit no-circling rule in every prompt. Designs generated BEFORE this
  change keep their stored circling-era prompts — generate fresh designs to
  get the new arcs. Dashboard copy updated (honest ~5–10 min per video,
  one-take 30s wording).
- **2026-08-10 (later) — Stitching deleted + three-movement aggressive motion.**
  The dormant two-segment chain code is gone entirely — every piece is one
  Seedance call, full stop (a 2.0 revert now just yields a 15s piece). The
  spectacular's motion prompt was rebuilt for single-pass 2.5: one prompt,
  three explicit time-beat movements (ignition → metamorphosis → crescendo),
  every camera/frame rule stated once instead of twice. Aggression turned up
  across the board: constant frame-breaking (at every moment a character is
  mid-burst through the opening), near-camera flybys and scale surges, a
  living ambient particle layer so no corner idles, an explosive slam-into-
  formation ending (the closing still still anchors WHERE it lands), EON
  journeys that accelerate in surges, and the EON single's "smooth and
  hypnotic" brake replaced with relentless high-velocity motion. New knob:
  `GEN_EON_DURATION_S=30` renders EON pieces at a native 30s (off by default).
- **2026-08-10 — Seedance 2.5: native 30s, no more stitching.** Motion moved to
  Seedance 2.5 on fal (Shawn: "go directly into using 2.5"). The 30s spectacular
  is now ONE generation call — no more chaining two 15s clips through a handoff
  frame and an ffmpeg splice; the approved closing still anchors the finale as
  the call's end frame, and both act prompts drive a single continuous piece.
  The two-segment chain stays in the code as an automatic fallback if the model
  is ever reverted to 2.0 (which caps clips at 15s). Note: 2.5 on fal renders
  480p/720p only (no 1080p tier — same 720p the engine has run since 08-05);
  Topaz still delivers the 4K-class file. Costs ~53%/gen-second more than 2.0
  standard: a 30s spectacular ≈ **$16.20** (was ~$14.30 stitched), a 15s EON
  ≈ **$8.15** (was ~$5.75); one video per sign ≈ **$32.50/week**.
- **2026-07-25 — EON spines.** The signs were being built face-only; every EON
  pillar also has a narrow LED spine down its left side. The EON output was
  re-cut around the real geometry: designs now generate as one wrapped panorama
  (3-pillar 2.5:1, single pillar 5:6) and get cut into **each pillar's spine +
  face**, so the art wraps the corner. Single pillars get a spine too. The
  dashboard shows each pillar the way it physically stands (spine hard against
  its face) and marks on the un-cut design which strips wrap around the side.
- **2026-07-24 — Keep & explore.** Anchor a liked design; generate variations (re-roll
  *or* plain-language LLM tweak) in a rail beneath it; original never lost; promote a
  variation to keeper. First LLM in the engine (OpenAI, graceful fallback to a re-roll).
- **2026-07-22 — Perf + UX overhaul.** Lazy in-view video (was 9+ 4K streams on load →
  thumbnails first), optimistic per-card actions (no more whole-page freeze on a click),
  skeletons, guided 1→2→3 stepper, "N reviewed" chips.
- **2026-07-22 — Save + Sent history.** Keep a design through regenerations; cross-run
  "Sent to Jeff" history.
- **2026-07-21 — Real 3D pop-out.** The black frame is now painted into the artwork (subject
  bursts through it), replacing the post-composited letterbox that clipped the art behind it.
- **2026-07-21 — Per-design regen, live progress, loud failures.** Regenerate one card;
  "Creating designs… 3/9" counters; failed batches say why instead of showing nothing.
- **2026-07-19–21 — Accurate cost model + cross-project reconciliation.** fal's exact
  token-formula pricing; immutable per-generation cost ledger; a reconciliation view that
  splits the shared fal bill across Artwork + Content Automation (Broken News is separate).
- **2026-07-14–15 — 4K pipeline + motion overhaul.** Seedance 1080p → Topaz 2× upscale to
  4K; 15s clips; aggressive 3D choreography and dynamic backgrounds. Per-sign regeneration.
- **2026-07-11–12 — Live in production.** Tab shipped to wowautomation.ai; state persists
  across restarts; plain-English UX; media-URL + polling-race fixes.

---

## Money & safety

- **Real cost model (verified against fal; 2.5 rate 2026-08-10).** Still = **$0.03**;
  full-4K video (Seedance 2.5 @720p + Topaz 4K) = **~$16.20** for the 30s spectacular,
  **~$8.15** per 15s EON master. A batch where Scott animates one option per sign
  ≈ **~$32.50**; every option ≈ **~$97**.
- **The gate that protects the budget:** stills are cheap and reviewed first; only
  approved designs ever become $8–16 videos. Exploring variations/tweaks is $0.03 each.
- **Shared fal account.** One fal account bills **Artwork + Content Automation + Broken
  News** together, so fal's own dashboard shows all three combined. Our per-generation
  **ledger** (recorded on each row) is the only artwork-specific figure; the reconciliation
  view (needs the fal admin key, now set) shows the split + any unattributed remainder.
- **Safety guardrail runs before every spend** — including on LLM-tweaked prompts — so a
  blocked idea (people/text/nudity) can't run up a bill.

---

## Open items

- **🔒 Rotate the leaked Google service-account key** (`google-drive-server-account.json`,
  historically committed in `wow-contract-query`). Standing security task — confirm it's
  rotated + scrubbed from git history if not already done. Tracked in Linear (DEL-143).
- **Weekly auto-run** (`SCHEDULER_ENABLED`) stays OFF until you want hands-off Mondays.
- **Housekeeping:** `wow-contract-query` `dev` branch is behind `master` — sync when convenient.

---

<details>
<summary>Under the hood (for the technically curious)</summary>

- **Two repos.** `wow-artwork-engine` = the engine (Node + Express, generation worker,
  scheduler, local/S3 store) running as its own PM2 app on :4000. The **Artwork Engine tab**
  lives inside `wow-contract-query` (React + Vite + Tailwind), which proxies to the engine.
- **Generation.** Stills = Seedream v4; motion = Seedance 2.5 (720p, native 30s single
  pass) → Topaz 4× upscale to 4K-class; all on fal.ai. The 30s spectacular is one call —
  a three-movement story arc prompt, free-moving with no end-frame anchor (and no closing
  still generated); the chain-era stitching code was removed 2026-08-10. Prompts are deterministic templates; the **tweak** feature adds an OpenAI prompt-editor
  (`services/generation/tweak.js`) that never throws (falls back to a re-roll with no key).
- **EON geometry.** A pillar slab is spine (320) + face (1280) = 1600 wide, so the 3-pillar
  master is 4800×1920 and a single pillar is its own 1600×1920 master. Because a slab is
  exactly one third of the wide master, the 3-act "one act per third" choreography still
  lines up with the hardware. `eonSlicer.js` is layout-driven; each row records which panel
  it is (`pod2_spine`), which drives the ledger split, the dashboard grouping and Jeff's
  filenames. One fal call is still one bill, divided across the panels by width.
- **Data.** File-backed in-memory repo persisted to JSON (survives PM2 restarts); Postgres
  path kept in parity (migrations for new columns). Lineage for keep & explore: `family_id`,
  `parent_artwork_id`, `change_note`; keeper = a `selections` row.
- **Cost.** Canonical price book (`services/generation/falPricing.js`, fal's exact token
  formula) mirrored into `wow-contract-query`; immutable `cost_usd` + `fal_request_id` per
  row; reconciliation endpoint `GET /api/cost/reconciliation`.
- **Deploy.** EC2 + PM2; GitHub `dev`→staging / `master`→production. Prod `.env` +
  service-account JSON pulled from S3 (`wow-server--use2-az1--x-s3`, a directory bucket in
  us-east-2) at deploy time. A `master` merge deploys **both** repos.
- **Tests.** 83/83 in the engine (`server/`), fully offline (LLM injectable). Frontends
  build clean (tsc + vite).
- See `WOW_Artwork_Engine_Build_Plan.md`, `KEYS.md`, `DEPLOY.md`, `server/README.md`,
  and the fast-load `PROJECT_STATUS.json` for detail.

</details>
