// FFmpeg post-processing service (Build Plan M1 · ffmpeg).
//
// Video models never emit WOW's exact pixel specs (1692x468, 768x384, ...),
// so every asset is generated at the closest supported ratio and then
// *conformed* here to the exact spec, encoded H.264, trimmed to spot length,
// and given a thumbnail.
//
// Design: the `build*Args` functions are PURE (string in → arg array out) so
// they can be unit-tested without spawning a process. The exported async
// functions wrap them with execution + ffprobe verification.

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import config from '../config/index.js';

const execFileP = promisify(execFile);

const FFMPEG = () => config.ffmpeg.ffmpegPath;
const FFPROBE = () => config.ffmpeg.ffprobePath;

// H.264 defaults shared by every video output. yuv420p + even dimensions =
// maximum player compatibility; +faststart moves the moov atom up for web.
const H264 = [
  '-c:v', 'libx264',
  '-preset', 'medium',
  '-crf', '20',
  '-pix_fmt', 'yuv420p',
  '-movflags', '+faststart',
  '-an', // artwork is silent
];

function assertEven(width, height) {
  if (width % 2 !== 0 || height % 2 !== 0) {
    throw new Error(`yuv420p requires even dimensions; got ${width}x${height}`);
  }
}

// ---------------------------------------------------------------------------
// Pure argument builders
// ---------------------------------------------------------------------------

/**
 * Conform an input to exactly width x height.
 *   fit="cover"   → fill the frame, crop the overflow (default; no distortion)
 *   fit="contain" → fit inside the frame, pad the remainder black
 *   fit="exact"   → plain scale to the target (≤ a few % of squash, zero
 *                   cropping) — for outputs whose EDGES are content: the
 *                   spectacular's painted frame and the EON masters' fold
 *                   alignment. cover's crop always paid for aspect error with
 *                   edge pixels, i.e. exactly the frame (found 2026-08-07).
 * Optional duration (seconds) trims the spot; optional fps sets frame rate.
 */
export function buildConformArgs({
  input,
  output,
  width,
  height,
  fit = 'cover',
  duration,
  fps,
  still = false,
}) {
  assertEven(width, height);
  let vf;
  if (fit === 'exact') {
    vf = `scale=${width}:${height},setsar=1`;
  } else if (fit === 'contain') {
    vf = `scale=${width}:${height}:force_original_aspect_ratio=decrease,` +
      `pad=${width}:${height}:(ow-iw)/2:(oh-ih)/2:color=black`;
  } else {
    vf = `scale=${width}:${height}:force_original_aspect_ratio=increase,` +
      `crop=${width}:${height}`;
  }

  const args = ['-y', '-i', input, '-vf', vf];
  if (still) {
    args.push('-frames:v', '1', output);
    return args;
  }
  if (fps) args.push('-r', String(fps));
  if (duration) args.push('-t', String(duration));
  args.push(...H264, output);
  return args;
}

/**
 * The deterministic FRAME PLATE filter for the spectacular: a solid black band
 * hugging the exact perimeter plus stepped translucent inner bands (the black
 * "depth" falloff into the scene). Applied DIRECTLY to the still/video via
 * drawbox — no intermediate RGBA overlay (drawbox fills color but not alpha,
 * so a transparent-canvas plate silently composites as a no-op; found
 * empirically 2026-08-07).
 *
 * Why this exists (Scott, 2026-08-07): generative models paint the frame as
 * SCENERY — niches, doorways, moldings somewhere inside the picture — so the
 * true perimeter ends up being water or floor, and the artwork can never sit
 * flush against the billboard structure's own bezel. Exact geometry is not a
 * model skill; it is compositing. The band guarantees the outermost pixels
 * are black on every still and every video frame, while the model keeps
 * ownership of everything inside — including subjects bursting OVER the
 * painted band (the solid part is only the outermost strip, and the
 * containment prompt keeps subjects short of the true edge).
 * Pure; unit-tested.
 */
export function buildFramePlateFilter({ width, height, band, stepAlphas = [0.55, 0.3, 0.15] }) {
  assertEven(width, height);
  const b = Math.max(2, Math.round(band));
  const step = Math.max(2, Math.round(b * 0.3));
  const boxes = [`drawbox=x=0:y=0:w=${width}:h=${height}:t=${b}:color=black@1`];
  stepAlphas.forEach((alpha, i) => {
    const inset = b + i * step;
    boxes.push(`drawbox=x=${inset}:y=${inset}:w=${width - 2 * inset}:h=${height - 2 * inset}:t=${step}:color=black@${alpha}`);
  });
  return boxes.join(',');
}

/** Apply the frame plate to a still (png/jpg output) or a video. */
export function buildFramePlateArgs({ input, output, width, height, band, still = false, duration, fps }) {
  const args = ['-y', '-i', input, '-vf', buildFramePlateFilter({ width, height, band })];
  if (still) {
    args.push('-frames:v', '1', output);
    return args;
  }
  if (fps) args.push('-r', String(fps));
  if (duration) args.push('-t', String(duration));
  args.push(...H264, output);
  return args;
}

export async function applyFramePlate(opts) {
  await run(buildFramePlateArgs(opts));
  return { output: opts.output };
}

/** Crop a single column/region: width x height at offset (x, y). */
export function buildCropArgs({ input, output, width, height, x = 0, y = 0, duration }) {
  assertEven(width, height);
  const args = ['-y', '-i', input, '-vf', `crop=${width}:${height}:${x}:${y}`];
  if (duration) args.push('-t', String(duration));
  args.push(...H264, output);
  return args;
}

/**
 * Extract the LAST frame of a clip as a PNG — the segment-A → segment-B
 * handoff of the 30s spectacular chain (B's image_url starts on A's literal
 * final pixel, so the splice is invisible). -sseof seeks from the end; -update
 * keeps overwriting so the final written image IS the last decoded frame.
 */
export function buildLastFrameArgs({ input, output, fromEndS = 0.5 }) {
  return ['-y', '-sseof', `-${fromEndS}`, '-i', input, '-update', '1', '-q:v', '1', output];
}

/**
 * Concatenate clips back to back into one file. filter-based concat with a
 * re-encode (not the stream-copy demuxer): the two Seedance segments are
 * separate encodes, and stream-copy across differing encoder params produces
 * players that stall at the joint. One clean re-encode guarantees a seamless
 * timeline — and it happens BEFORE the single Topaz pass, so the upscaler sees
 * one continuous stream and synthesizes uniform grain across the seam.
 */
export function buildConcatArgs({ inputs, output, fps }) {
  if (!inputs || inputs.length < 2) throw new Error('concat needs at least 2 inputs');
  const args = ['-y'];
  for (const i of inputs) args.push('-i', i);
  const heads = inputs.map((_, i) => `[${i}:v]`).join('');
  const filter = `${heads}concat=n=${inputs.length}:v=1:a=0[out]`;
  args.push('-filter_complex', filter, '-map', '[out]');
  if (fps) args.push('-r', String(fps));
  args.push(...H264, output);
  return args;
}

/**
 * LEGACY — no longer in the pipeline (2026-07-21). Compositing a border in
 * post clips the art BEHIND the frame, so nothing can ever pop out of it; the
 * 3D frame-break now lives in the generation prompts (trompe-l'oeil border
 * painted into the scene, subject rendered in front of it). Kept only because
 * it's a pure arg-builder with tests; delete alongside them when convenient.
 * Composite a subject clip onto a black canvas — the frame-break style.
 */
export function buildFrameBreakArgs({
  input,
  output,
  canvasWidth,
  canvasHeight,
  // inner frame: the "window" the subject pops out of, inset from the canvas
  inset = 40,
  borderThickness = 4,
  // how far (px) the subject overshoots the top of the inner frame
  overshoot = 60,
  duration,
  fps = 30,
}) {
  assertEven(canvasWidth, canvasHeight);
  const innerW = canvasWidth - inset * 2;
  const innerH = canvasHeight - inset * 2;

  // Subject is scaled to the inner frame's width and placed so its top edge
  // sits *above* the inner frame's top — it breaks the frame and reads as 3D.
  const subjectW = innerW;
  const subjY = inset - overshoot;

  // filter_complex:
  //  [0:v] scale subject to inner width, preserve ratio        -> [subj]
  //  color black canvas                                        -> [bg]
  //  draw the bright frame border on the canvas                -> [framed]
  //  overlay subject onto framed canvas at (inset, subjY)      -> [out]
  // The subject can move in front of or behind the frame edge for 3D effect.
  const filter = [
    `color=c=black:s=${canvasWidth}x${canvasHeight}:r=${fps}[bg]`,
    // Bright frame border: transparent inner area, opaque border on black canvas
    `[bg]drawbox=x=${inset}:y=${inset}:w=${innerW}:h=${innerH}:` +
      `color=white@0.85:t=${borderThickness}[framed]`,
    `[0:v]scale=${subjectW}:-2[subj]`,
    `[framed][subj]overlay=x=${inset}:y=${subjY}:shortest=1[out]`,
  ].join(';');

  const args = [
    '-y',
    '-i', input,
    '-filter_complex', filter,
    '-map', '[out]',
  ];
  if (duration) args.push('-t', String(duration));
  args.push(...H264, output);
  return { args, inner: { width: innerW, height: innerH }, subjY };
}

/**
 * Palindrome ("ping-pong") loop: forward then reversed, so the clip's last
 * frame equals its first and it loops seamlessly on a DOOH player. Doubles the
 * duration. For ambient motion only — directional travel would visibly reverse.
 */
export function buildPingPongArgs({ input, output }) {
  return [
    '-y',
    '-i', input,
    '-filter_complex', '[0:v]split[fwd][tmp];[tmp]reverse[rev];[fwd][rev]concat=n=2:v=1,format=yuv420p[out]',
    '-map', '[out]',
    ...H264,
    output,
  ];
}

/** Single-frame JPEG thumbnail at `atSeconds`. */
export function buildThumbnailArgs({ input, output, width, height, atSeconds = 0 }) {
  return [
    '-y',
    // -ss only when actually seeking: an input-side `-ss 0` on a single-image
    // input (live Seedream stills are mjpeg) makes ffmpeg encode ZERO frames
    // ("Output file is empty") — both storyboard thumbnails failed on the
    // first live run. Plain video thumbnails at 0s never needed the seek.
    ...(atSeconds > 0 ? ['-ss', String(atSeconds)] : []),
    '-i', input,
    '-frames:v', '1',
    '-vf', `scale=${width}:${height}:force_original_aspect_ratio=increase,crop=${width}:${height}`,
    '-q:v', '3',
    output,
  ];
}

// ---------------------------------------------------------------------------
// Execution + verification
// ---------------------------------------------------------------------------

async function run(args) {
  try {
    await execFileP(FFMPEG(), args, { maxBuffer: 1024 * 1024 * 64 });
  } catch (err) {
    const tail = (err.stderr || '').toString().split('\n').slice(-12).join('\n');
    throw new Error(`ffmpeg failed: ${err.message}\n${tail}`);
  }
}

/**
 * Detect the content region of a video, ignoring letterbox/pillarbox bars
 * (video models often return a fixed square with the art letterboxed inside).
 * Samples a few seconds with cropdetect and returns { width, height, x, y }
 * or null when the full frame is content.
 */
export async function detectContentCrop(input, { seconds = 2, limit = 24 } = {}) {
  const args = [
    '-i', input,
    '-t', String(seconds),
    '-vf', `cropdetect=limit=${limit}:round=2:reset=0`,
    '-f', 'null', '-',
  ];
  let stderr = '';
  try {
    ({ stderr } = await execFileP(FFMPEG(), args, { maxBuffer: 1024 * 1024 * 32 }));
  } catch (err) {
    stderr = String(err.stderr || '');
    if (!stderr.includes('crop=')) throw err;
  }
  const matches = [...stderr.matchAll(/crop=(\d+):(\d+):(\d+):(\d+)/g)];
  if (!matches.length) return null;
  const [, w, h, x, y] = matches[matches.length - 1].map(Number);
  const probed = await probe(input);
  // Treat near-full-frame as "no bars" (within 4px per axis).
  if (!probed.width || (probed.width - w <= 4 && probed.height - h <= 4)) return null;
  if (w < 16 || h < 16) return null; // degenerate detection (all-dark scene)
  return { width: w, height: h, x, y };
}

/** Sampling rate that yields at least ~8 frames from a clip of `durationS`. Pure. */
export function sampleFrameRate(durationS, sampleFps = 2, minFrames = 8) {
  if (!durationS || durationS <= 0) return sampleFps;
  return Math.max(sampleFps, Math.ceil(minFrames / durationS));
}

/**
 * Content bounding box over the WHOLE clip (sampled at `sampleFps`): the
 * largest non-black area cropdetect sees anywhere in the clip (reset=0 never
 * resets, so the box is the union across frames — a character that ever
 * reaches an edge keeps that edge). Returns { width, height, box } where box
 * is { width, height, x, y } or null when the full frame is content. Used by
 * bars.js to find padding the model left around the art after the geometric
 * strip (Jeff, 2026-10-21: letterboxed / L-shaped deliveries).
 */
export async function detectContentBox(input, { limit = 40, sampleFps = 2 } = {}) {
  const probed = await probe(input);
  // skip=0: cropdetect ignores its first two frames by default, which on a
  // short sampled clip is every frame. Short clips also sample faster so the
  // box is built from at least ~8 frames.
  const fps = sampleFrameRate(probed.duration, sampleFps);
  const args = [
    '-i', input,
    '-vf', `fps=${fps},cropdetect=limit=${limit}:round=2:reset=0:skip=0`,
    '-f', 'null', '-',
  ];
  let stderr = '';
  try {
    ({ stderr } = await execFileP(FFMPEG(), args, { maxBuffer: 1024 * 1024 * 32 }));
  } catch (err) {
    stderr = String(err.stderr || '');
    if (!stderr.includes('crop=')) throw err;
  }
  const matches = [...String(stderr).matchAll(/crop=(\d+):(\d+):(\d+):(\d+)/g)];
  if (!matches.length || !probed.width) return { width: probed.width, height: probed.height, box: null };
  const [, w, h, x, y] = matches[matches.length - 1].map(Number);
  if (w < 16 || h < 16) return { width: probed.width, height: probed.height, box: null }; // all-dark scene
  if (w >= probed.width && h >= probed.height) return { width: probed.width, height: probed.height, box: null };
  return { width: probed.width, height: probed.height, box: { width: w, height: h, x, y } };
}

/**
 * Luma statistics of a region over the clip (sampled): { yavg, ymax } on the
 * 0-255 scale — mean across frames and the single brightest pixel seen. The
 * proof that a band is flat padding (pure black pads at yavg ≈ 16, ymax ≈ 17)
 * rather than dark art. Returns null when unmeasurable.
 */
export async function regionStats(input, { width, height, x, y, sampleFps = 2 } = {}) {
  let fps = sampleFps;
  try { fps = sampleFrameRate((await probe(input)).duration, sampleFps); } catch { /* keep the default */ }
  const args = [
    '-i', input,
    '-vf', `fps=${fps},crop=${width}:${height}:${x}:${y},signalstats,` +
      'metadata=print:key=lavfi.signalstats.YAVG:file=-,metadata=print:key=lavfi.signalstats.YMAX:file=-',
    '-f', 'null', '-',
  ];
  try {
    const { stdout } = await execFileP(FFMPEG(), args, { maxBuffer: 1024 * 1024 * 32 });
    const avgs = [...String(stdout).matchAll(/YAVG=([\d.]+)/g)].map((m) => Number(m[1]));
    const maxs = [...String(stdout).matchAll(/YMAX=([\d.]+)/g)].map((m) => Number(m[1]));
    if (!avgs.length) return null;
    return {
      yavg: avgs.reduce((a, b) => a + b, 0) / avgs.length,
      ymax: maxs.length ? Math.max(...maxs) : null,
    };
  } catch {
    return null;
  }
}

/**
 * GEOMETRIC bar crop — where letterbox/pillarbox bars MUST be if the model
 * padded `wantAspect` content into a raw canvas, computed from shape alone.
 * Replaces cropdetect for extraction (live QA 2026-08-14: cropdetect cannot
 * tell Seedance's padding from the artwork's own painted black frame, and ate
 * the frame). Returns { width, height, x, y, bars: 'horizontal'|'vertical' }
 * or null when the raw canvas already matches. Pure.
 */
export function computeBarCrop({ rawWidth, rawHeight, wantAspect, tolerance = 0.03 } = {}) {
  if (!rawWidth || !rawHeight || !wantAspect) return null;
  const even = (n) => Math.max(2, Math.floor(n / 2) * 2);
  const rawAspect = rawWidth / rawHeight;
  if (Math.abs(rawAspect - wantAspect) / wantAspect <= tolerance) return null;
  if (rawAspect < wantAspect) {
    const height = even(rawWidth / wantAspect);
    return { width: rawWidth, height, x: 0, y: even((rawHeight - height) / 2), bars: 'horizontal' };
  }
  const width = even(rawHeight * wantAspect);
  return { width, height: rawHeight, x: even((rawWidth - width) / 2), y: 0, bars: 'vertical' };
}

/**
 * Mean luma (0-255) of a region over the first `seconds` — the proof step
 * before cropping: bars are only removed when the stripped regions are
 * actually near-black padding. Returns null when unmeasurable.
 */
export async function regionMeanLuma(input, { width, height, x, y, seconds = 1 } = {}) {
  const args = [
    '-i', input, '-t', String(seconds),
    '-vf', `crop=${width}:${height}:${x}:${y},signalstats,metadata=print:key=lavfi.signalstats.YAVG:file=-`,
    '-f', 'null', '-',
  ];
  try {
    const { stdout } = await execFileP(FFMPEG(), args, { maxBuffer: 1024 * 1024 * 32 });
    const vals = [...String(stdout).matchAll(/YAVG=([\d.]+)/g)].map((m) => Number(m[1]));
    if (!vals.length) return null;
    return vals.reduce((a, b) => a + b, 0) / vals.length;
  } catch {
    return null;
  }
}

/**
 * Grab one frame near the start or end of a clip as a JPEG — the two probes
 * of the frame-order fidelity check (does the clip START on the approved
 * still, or end on it?).
 */
export async function extractFrameAt({ input, output, position = 'first', offsetS = 0.15 }) {
  const args = position === 'last'
    ? ['-y', '-sseof', `-${offsetS + 0.2}`, '-i', input, '-update', '1', '-q:v', '2', output]
    : ['-y', '-ss', String(offsetS), '-i', input, '-frames:v', '1', '-q:v', '2', output];
  await run(args);
  return { output };
}

/**
 * SSIM similarity of two images (0..1), both normalized to a small gray
 * canvas so differing sizes/aspects compare fairly. Returns null when
 * unmeasurable. Used relatively (first-vs-last), never as an absolute gate.
 */
export async function imageSimilarity(a, b) {
  const args = [
    '-i', a, '-i', b,
    '-filter_complex',
    '[0:v]scale=512:288,setsar=1,format=gray[x];[1:v]scale=512:288,setsar=1,format=gray[y];[x][y]ssim',
    '-f', 'null', '-',
  ];
  try {
    const { stderr } = await execFileP(FFMPEG(), args, { maxBuffer: 1024 * 1024 * 32 });
    const m = String(stderr).match(/All:([\d.]+)/);
    return m ? Number(m[1]) : null;
  } catch {
    return null;
  }
}

/**
 * Canvas for letterboxing `width`x`height` content into `aspect` with pure
 * black margins, centered. Used to PRE-pad the Seedance reference to a canvas
 * the model can natively produce (live QA 2026-08-15: fed the raw 3.62:1 art,
 * Seedance sometimes re-staged it as a tiny picture floating in its own
 * canvas instead of letterboxing — the aspect decision must be OURS). Pure.
 */
export function computePadCanvas({ width, height, aspect } = {}) {
  if (!width || !height || !aspect) return null;
  const even = (n) => Math.max(2, Math.round(n / 2) * 2); // dimensions
  const off = (n) => Math.max(0, Math.round(n / 2) * 2); // offsets may be 0
  let canvasW = width;
  let canvasH = height;
  if (width / height >= aspect) canvasH = even(width / aspect);
  else canvasW = even(height * aspect);
  return { width: canvasW, height: canvasH, x: off((canvasW - width) / 2), y: off((canvasH - height) / 2) };
}

/** Letterbox an image into `aspect` with centered pure-black margins. */
export async function padToAspect({ input, output, width, height, aspect }) {
  const c = computePadCanvas({ width, height, aspect });
  if (!c) throw new Error('padToAspect needs width/height/aspect');
  await run(['-y', '-i', input, '-vf', `pad=${c.width}:${c.height}:${c.x}:${c.y}:black`, output]);
  return { output, ...c };
}

/** ffprobe → { width, height, duration } for an output file. */
export async function probe(input) {
  const args = [
    '-v', 'error',
    '-select_streams', 'v:0',
    '-show_entries', 'stream=width,height:format=duration',
    '-of', 'json',
    input,
  ];
  const { stdout } = await execFileP(FFPROBE(), args);
  const json = JSON.parse(stdout);
  const stream = json.streams?.[0] || {};
  return {
    width: stream.width,
    height: stream.height,
    duration: json.format?.duration ? Number(json.format.duration) : undefined,
  };
}

export async function conform(opts) {
  const args = buildConformArgs(opts);
  await run(args);
  return { output: opts.output, width: opts.width, height: opts.height };
}

export async function frameBreakComposite(opts) {
  const { args } = buildFrameBreakArgs(opts);
  await run(args);
  return { output: opts.output, width: opts.canvasWidth, height: opts.canvasHeight };
}

export async function thumbnail(opts) {
  await run(buildThumbnailArgs(opts));
  return { output: opts.output };
}

export async function cropColumn(opts) {
  await run(buildCropArgs(opts));
  return { output: opts.output, width: opts.width, height: opts.height };
}

export async function pingpong(opts) {
  await run(buildPingPongArgs(opts));
  return { output: opts.output };
}

export async function extractLastFrame(opts) {
  await run(buildLastFrameArgs(opts));
  return { output: opts.output };
}

export async function concatClips(opts) {
  await run(buildConcatArgs(opts));
  return { output: opts.output };
}

export default {
  buildConformArgs,
  buildCropArgs,
  buildFrameBreakArgs,
  buildThumbnailArgs,
  buildPingPongArgs,
  buildLastFrameArgs,
  buildConcatArgs,
  conform,
  applyFramePlate,
  buildFramePlateArgs,
  buildFramePlateFilter,
  frameBreakComposite,
  thumbnail,
  cropColumn,
  extractLastFrame,
  concatClips,
  pingpong,
  probe,
  detectContentCrop,
  detectContentBox,
  regionStats,
  sampleFrameRate,
  computeBarCrop,
  regionMeanLuma,
  extractFrameAt,
  imageSimilarity,
  computePadCanvas,
  padToAspect,
};
