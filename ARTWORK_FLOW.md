# Artwork Automation — Exact Criteria & Flow

**As deployed 2026-08-18** (full 30-second pieces + 4K upscale · split tracks). This is the
complete, honest map of what happens between "New batch" and a file landing in Jeff's Drive
folder — every step, every rule, and the exact text sent to the AI models.

## Split tracks (Shawn, 2026-08-18 — shipping to WOW)

The three spectacular options are no longer three tries at the same thing:

- **Option 1 — the FRAMED track (mastery)**: the signature trompe-l'oeil painted black
  border, all the frame rules below. This is where the border illusion keeps being
  perfected.
- **Options 2 & 3 — the BORDERLESS tracks (shipping)**: full-bleed cinematic scenes with
  no frame at all — the scene owns every pixel, edge to edge. Built to go out to WOW now:
  the director and the motion contract both switch to a maximum-intensity variant focused
  on relentless speed and a genuinely exciting story. Frame rules don't apply; characters
  may sweep in and out across the picture's edges like any cinematic shot, and the only
  ban is a single character filling the whole screen and blotting out the scene.

Everything below that mentions the frame applies to option 1 only; everything else
(one take, camera lock, departure, living environment, letterbox handling, QA, color
constancy) applies to all three.

## Wild-theme slots (Shawn, 2026-08-18)

Two slots go fully off-book every batch — a **randomized era/world theme** instead of
the house psychedelic families, always **digital art grounded in that theme** with
characters and scenery that belong to it:

- **Spectacular option 3** (also borderless — the wild theme replaces its style family
  and cast; the vision director still writes the story from the actual still).
- **EON-connected option 2** (the wild theme's hero travels the triptych; the wrap/seam
  and travel rules are unchanged).

The pool (12 themes): Cyberpunk, Roaring Twenties, Steampunk, Synthwave, Wild West,
Feudal Japan, Ancient Egypt, Deep Space, Medieval Fantasy, Lost Atlantis, Prehistoric,
Masquerade Carnival. The pick is seeded by the batch id — every "New batch" rolls fresh,
each run stays reproducible. The rolled theme's name is stored on the row
(`theme_label`) and the dashboard shows a **🎲 Random theme: <name>** badge next to that
generation, so the reviewer always knows which design is the wild one and what it
rolled. Variations/tweaks of a wild design inherit its theme and label.

---

## The flow, end to end

### Phase 1 — Designs (stills) · ~$0.03 each, ~20–40s each

1. **Plan.** A batch = 3 signs (spectacular, EON 3-pillar, EON single) × 3 options = 9 designs.
2. **Build prompts.** Deterministic templates (seeded by week + option, so runs are
   reproducible) produce TWO prompts per design: the still prompt (what the picture is)
   and the motion prompt (stored now, used later in Phase 2).
3. **Guardrail.** The still prompt is checked (no nudity + configured deny-terms) BEFORE spend.
4. **Generate.** Seedream v4 renders the still (spectacular: 4096×1132).
5. **No frame plate — anywhere** *(2026-08-14)*. Nothing is ever composited. The frame
   exists only because Seedream paints it (the still prompt demands it) and Seedance
   maintains it. What Scott reviews and what Seedance animates from is the raw model still.
6. **Story director** *(2026-08-14, round 3 — "the movement keeps most of the creatures
   still… need story")*. A vision LLM is shown the ACTUAL generated still and scripts one
   story paragraph from what is really in it — the real characters, the real painted
   scenery used as cover and props (the shark hunts the fish through the seaweed *it
   generated*), constant travel between the deep distance and the frame plane, and a
   decisive payoff (the catch, the escape, the transformation). The engine wraps that
   paragraph in the fixed motion contract; the LLM writes story, never rules. Any
   shot-list vocabulary in its output is rejected. Fallback (no key / failure): a
   template chase story with the design's cast. ~$0.01/design (`ARTWORK_DIRECTOR_MODEL`,
   default gpt-4o-mini).
7. **QA.** A luma check catches black/blank renders.
8. The design lands on the dashboard for review (approve / pass / keep & explore / tweak).

### Phase 2 — Videos · one Seedance call per design, only on APPROVED designs

8. **Guardrail again** on the stored motion prompt, before the expensive spend.
9. **One Seedance 2.5 call.** Inputs, exactly:
   - `image_url` — the approved still, **pre-letterboxed by us to 16:9** *(2026-08-15:
     fed the raw 3.62:1 art, Seedance sometimes re-staged it as a tiny picture floating
     in its own canvas — the aspect decision is now OURS: pure black margins we add,
     art spanning full width, a canvas the model natively produces; extraction strips
     exactly the bars we added)*
   - `prompt` — the stored motion prompt (full text below)
   - `duration` — **30s** (the full piece; env `GEN_SPECTACULAR_DURATION_S=10` drops back
     to cheap iteration rounds). EON pieces: 15s.
   - `resolution: 720p` · `aspect_ratio: auto` · `generate_audio: false`
   - **No end frame.** Nothing else. No stitching exists anywhere.
10. **Topaz 4K upscale — ON** *(re-enabled 2026-08-18)*. The 720p Seedance render is
    upscaled 4× by Topaz before download (billboards need it at street scale). Best-effort:
    a failed upscale delivers the un-upscaled clip rather than losing the paid generation.
    `FAL_UPSCALE=0` turns it back off for fast/cheap visual iteration.
11. **Letterbox extraction: geometry + measured edges, never-pad, never-stretch**
    *(2026-08-14 rounds 2+4; 2026-10-21 Jeff: "letterboxed or with an L shape black box")*.
    Seedance can't output the extreme 3.6:1, so it letterboxes the art in a taller canvas.
    Three steps, each the next one's safety net (`bars.js`):
    1. **Geometry** — the bars' position is computed from the design aspect vs the raw
       canvas — never cropdetect alone, which couldn't tell padding from the artwork's own
       painted black frame and ate the frame on the cheetah render. The crop happens only
       after PROOF that the stripped regions measure near-black.
    2. **Measured residue** — Seedance drifts (a slow zoom or pan), so step 1 could leave a
       sliver of padding on one or two edges (the L shape), or fail its proof and ship the
       whole padded canvas (the letterbox). The clip's real content box is now measured
       over its full length and every edge that is proven flat black (mean luma ≤ 28, no
       pixel above 80) is removed. A framed design (option 1) keeps its uniform painted
       border — only the excess over it is stripped; a borderless design keeps no black
       edge at all.
    3. **Fit** — content is never stretched and never padded: if the aspect still mismatches
       the spec it is center-cropped to fill edge to edge, with a loud flag on the card.
    Finally the **delivered file itself is audited**: any proven-black edge left on it raises
    a red "BLACK BARS remain — do not send" flag on the row.
12. **QA.** Saturation-drift measurement (warning only — Seedance colors can drain), and
    **frame-order fidelity** *(2026-08-15)*: SSIM of the clip's first and last frames vs
    the approved still, logged on every render — a card flag fires whenever the END
    resembles the still more than the start ("the model animated toward the input"), so
    the first-frame-vs-last-frame question is answered with data, not eyeballing.
13. **Conform.** Exact-fit scale to delivery spec — spectacular **1692×468** *(Jeff's
    2026-10-21 email: "final renders should be: Spectaculars - 1692w x 468h"; was 4K-class
    3840×1062, identical aspect)*; EON at
    **Jeff's panel-native sizes** *(2026-08-21 email: spine 64×384, face 256×384,
    3-pillar master 960×384)*. **Nothing is composited onto the video** — the file
    ships exactly as the model made it. EON masters are still sliced into per-panel
    files for the review screen, but **delivery to Jeff is the ONE master file** —
    spines + faces side by side in a single 960×384 strip (320×384 for a single
    pillar), which he asked for to speed up his turnaround. EON also skips the Topaz
    pass (720p already exceeds 384px output — pure savings); the spectacular keeps it.
14. **Ledger.** Exact cost recorded per row from fal's token formula + the real model string.

### Phase 3 — Ship

15. Scott approves videos → **Send to Jeff** → Google Drive upload — the spectacular as
    its own file, each EON set as ONE wrapped master strip — + Gmail notification +
    Sent-history log.

---

## The exact prompts (live now)

### Still prompt — spectacular (example: option 1, week of 2026-08-17)

> An ultra-wide trompe-l'oeil deep-relief composition in perfectly frontal, dead-centered, symmetrical one-point perspective. Style: *[family style — rotates per batch]*. Composition: the picture's border IS a thick matte-black frame — flat matte-black strips run along the top edge, bottom edge, left edge and right edge of the picture, meeting at the four corners, flush with the picture's edges on all sides. Just inside those black strips the image darkens into pure matte-black depth on all four sides — a soft black inner shadow, as if the scene sits deep behind the black border — and through the opening the scene recedes into deep vivid distance. The frame is never shown as an object […] The black frame is perfectly plain and flat: uniform width on all four sides, sharp square corners, a smooth matte surface — no molding, no ornament. The scene is home to an ensemble of characters: *[cast — rotates per batch]*. **Beyond that cast there is full creative freedom — any characters and scenery that serve the scene are welcome: creatures, people, living objects, anything with personality.** This is how the story opens: *[opening tableau]*. **Whatever moves onto the frame's inner edge is rendered IN FRONT of the black strips**, partially covering them and casting soft shadows onto them — unmistakably closer to the viewer than the frame plane. Every element stays well inside the picture's borders: nothing but the black frame itself ever touches the picture's edge, and nothing is cropped by the picture's boundary […] High-contrast lighting: a bright, saturated hero subject against a deep, dark background […] Ultra high detail. **No text, no logos, no watermarks.**

*(Style family + cast + opening tableau now rotate per BATCH — every "New batch" gets fresh
subjects and environments; the frame and containment language is identical every time.)*

### Still prompt — spectacular options 2 & 3 (borderless, 2026-08-18)

> An ultra-wide cinematic full-bleed composition with sweeping 3D depth. Style: *[family
> style]*. The scene fills the ENTIRE picture edge to edge and corner to corner — one
> continuous, deep, living world with no border, no frame, no vignette, no dark edges:
> pure immersive scenery everywhere. *[cast + creative freedom + opening tableau: keeper
> dominating one third mid-motion, hero streaking in from the far edge trailing light,
> companion sweeping through the deep middle distance — the whole scene already surging]*
> […mid-motion, contrast and no-text clauses as above.]

*(Options 2 and 3 mirror which side the keeper holds, so they don't read as clones.)*

### Motion prompt — spectacular (per-design: the story is written FROM the design's still)

> Fixed camera, locked-off shot […] **One single continuous take — no cuts, no shot changes, no new angles, no transitions, ever.** ***[STORY — written by the vision director from the actual still: a hunt/chase/journey using the real characters and real painted scenery as cover, traveling between the deep distance and the frame plane, ending in a decisive payoff. Template fallback: "A chase with real stakes plays out across this one take: [hero] flees across the full width of the scene with [companion] in relentless pursuit — weaving through the painted scenery, ducking behind it, breaking cover, diving from the deep distance up to the frame itself and back — until the chase peaks at [keeper], where the pursuit ends in one decisive dramatic payoff and the whole world erupts with light."]*** **The clip begins exactly on the picture's frozen moment and immediately moves AWAY from it — the story never returns to, recreates, or ends on the arrangement shown at the start (arrival-shaped stories made the model animate TOWARD the still, turning the preview into the last frame).** **Every character is in motion at every single moment of the clip — none of them ever stands still, poses, hovers or waits. The environment is a character too: the ENTIRE scene is in constant vigorous motion — water flows, plants whip, drips run, mist churns, light pulses — the scenery visibly reacts to every character passing through it; no region of the picture is ever calm; every pixel is alive.** **The action travels in depth the whole time — from the deep distance up to the frame plane at the very front and back again.** The characters interact with the frame — climbing onto the black border, sliding along its strips, leaning over its inner edge, casting light and moving shadows onto it — with their entire form inside the picture at all times. The matte-black frame stays perfectly fixed […] The viewpoint never travels into the scene. **Rapid, exciting, high-energy movement — never static, never jittery.** Saturation stays rich and maxed for the entire duration.

The **minimal contract**, tuned per your 2026-08-14 notes: framing locked (the
first-frame=last-frame line is gone), one take, characters work ONTO the frame with their
whole form always inside the picture, rapid + exciting motion welcomed, colors held —
everything else is the model's choice.

### Motion prompt — spectacular options 2 & 3 (borderless variant)

Same contract minus every frame rule, plus a maximum-intensity clause. The story is still
written by the vision director from the actual still (its brief switches to the borderless
edition: full-bleed, free edge entries/exits, "the most exciting ten seconds of a great
film"). The wrapper keeps: camera lock, one take, departure, every-character motion,
living environment, letterbox-margin dead space, anti-drift. It swaps in:

> The scene is full-bleed with no frame or border: characters may sweep in and out across
> the picture's edges freely, entering and exiting the shot like living things crossing a
> window. No single character ever fills the whole screen or blots out the scene — even at
> its closest and largest, the world around it stays visible. […] Maximum intensity: this
> is the most kinetic, most breathtaking version of this scene possible — relentless
> speed, dramatic near-misses, explosive turns, the whole world surging with the story.

---

## The criteria (what "correct" means)

| # | Criterion | Enforced by |
|---|---|---|
| 1 | **Option 1 only:** black frame flush at the perimeter, all 4 sides, the whole clip. **Options 2–3:** NO frame anywhere — pure full-bleed scenery to every edge | Still prompt paints it (or bans it); motion prompt maintains it — no compositing anywhere |
| 2 | One continuous take — zero cuts | Motion prompt (no timestamps/beats anywhere — they read as a shot list) |
| 3 | Camera never moves, never enters the scene | CAMERA_LOCK + viewpoint rule in motion prompt |
| 4 | **Option 1:** anything may pass IN FRONT of the frame — wingtips over the strips, paint bursting across it, even briefly covering it (that IS the pop-out). The ONE boundary is the picture's outer edge: nothing is ever clipped by the image edge or fills the whole screen. **Options 2–3:** edges are free crossings (normal cinematography); only a character filling the whole screen stays banned | Motion prompt + director brief (clarified 2026-08-15: frame = playground, image edge = law; split 2026-08-18) |
| 5 | Nothing composited over the still OR the video, ever | Pipeline: frame plate fully removed 2026-08-14 |
| 6 | Colors never wash out / drift grey | Constancy clause + post-hoc saturation QA warning |
| 7 | Any characters welcome — creatures, people, living objects; no text/logos/watermarks | Still prompt creative-freedom clause; nudity guardrail before every spend |
| 8 | Fresh subjects + environments every batch | Prompt seed now salts with the batch id — no weekly repetition |
| 9 | Failures are visible, never masked, never stretched, **never padded** | Geometry + measured edge strip (`bars.js`); a true aspect mismatch → center-cropped to fill + flagged; the delivered file is audited for leftover black edges |
| 11 | The motion has a story — beginning, journey, payoff — with zero timestamps | One untimed story sentence naming the design's own cast |
| 10 | Delivery: exact pixels (spectacular 1692×468 per Jeff 2026-10-21; EON one master 960×384 — spine 64 + face 256 per pillar, per Jeff 2026-08-21) | Conform exact-fit; EON ships the single wrapped master and skips Topaz |

## Current knobs & numbers

| Setting | Value now | Change via |
|---|---|---|
| Spectacular length | **30s** (full piece) | `GEN_SPECTACULAR_DURATION_S` (10 = iteration mode) |
| EON length | 15s | `GEN_EON_DURATION_S` |
| Motion model | Seedance 2.5 @720p | `FAL_SEEDANCE_MODEL` / `FAL_RESOLUTION` |
| Upscale | **ON** — Topaz 4× to 4K-class | `FAL_UPSCALE=0` turns it off for iteration |
| Cost per spectacular render | **~$16.20** at 30s + Topaz (~$4.60 at 10s, no upscale) | — |
| Time per video | ~10–20 min at 30s + Topaz | — |
| Still / design | $0.03, ~20–40s | — |

## Iteration log (why things are the way they are)

- **08-10:** Seedance 2.5 adopted (native long take). Stitching deleted. End-frame anchor
  removed (motion felt obligated). Story arcs attempted.
- **08-11:** Geography/role-based arcs attempted; video frame plate turned off (it stamped
  a band + gradient OVER characters).
- **08-14 (Test Art review):** hard cut found at t=9.67s — exactly a prompt "movement"
  boundary → **all beat/timestamp structure removed; prompt reduced to the minimal
  contract**. Remaining plate gradient killed for good.
- **08-14 (now):** movement still minimal, cuts still appearing → **10s iteration mode**
  for ~$5.40/round. Next levers if cuts persist at 10s: reference-to-video endpoint,
  first-frame-weight parameters, or an automated cut-detector QA gate that auto-rejects
  and re-rolls a clip containing a scene change (scdet — the same detector used to find
  the 9.67s cut — costs nothing and could save a bad $5 render from reaching review).
- **08-18 (split tracks):** "it's already late — I wanna get this out and running to WOW"
  → option 1 stays the framed mastery track; options 2 & 3 go borderless full-bleed,
  tuned for maximum intensity and story, ready to ship while the border keeps being
  mastered on option 1.
- **10-21 (Jeff: "letterboxed or with an L shape black box"):** the week-of-10-19 files
  reached Jeff with padding on them. Root cause: the post-render bar strip trusted
  geometry alone — when Seedance drifted the art a few percent, the strip left a sliver
  (the L shape), and when the drift failed the proof step the fallback delivered the whole
  padded canvas (the letterbox). Now the real edges are measured over the whole clip and
  stripped after proof, the final fit never pads (center-crop instead), and the delivered
  file is audited for leftover black. Same email: spectacular delivery size is now his
  native **1692×468** (was 4K-class 3840×1062, same aspect).
- **08-18 (production mode):** iteration mode over — spectaculars back to the full 30s
  piece and Topaz 4K upscale re-enabled for real deliveries (~$16.20/render).
  `GEN_SPECTACULAR_DURATION_S=10` + `FAL_UPSCALE=0` bring back cheap iteration rounds.
