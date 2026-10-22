// Centralised, validated config. Reads from process.env (after secrets are
// loaded). Importing this module also loads a local .env when dotenv is
// available, so individual scripts can `import config` without ceremony.
try {
  const { config: dotenvConfig } = await import('dotenv');
  dotenvConfig(); // ./.env (cwd — server/.env in production deploys)
  dotenvConfig({ path: '../.env' }); // repo-root .env when run from server/ (local dev)
} catch {
  // dotenv optional (e.g. before npm install or in CI with real env vars).
}

const num = (v, d) => (v === undefined || v === '' ? d : Number(v));
const bool = (v, d = false) =>
  v === undefined ? d : ['1', 'true', 'yes', 'on'].includes(String(v).toLowerCase());

const config = {
  env: process.env.NODE_ENV || 'development',
  port: num(process.env.PORT, 4000),
  logLevel: process.env.LOG_LEVEL || 'info',

  db: {
    url: process.env.DATABASE_URL,
    ssl: process.env.PGSSLMODE === 'require' ? { rejectUnauthorized: false } : false,
  },

  aws: {
    region: process.env.AWS_REGION || 'us-west-2',
    s3Bucket: process.env.S3_BUCKET,
  },

  // Asset store for generated media. `local` (default) keeps everything on
  // disk so the fixture pipeline runs at $0 without touching AWS; `s3` uploads
  // to the configured bucket for production.
  storage: {
    driver: process.env.STORAGE_DRIVER || 'local',
    localDir: process.env.STORAGE_LOCAL_DIR || 'var/storage',
    s3Bucket: process.env.S3_BUCKET,
  },

  // How many options per surface Scott reviews each week (locked: 3).
  optionsPerSurface: num(process.env.OPTIONS_PER_SURFACE, 3),

  // Generation defaults. durationS is the BASE clip length — one act of a
  // multi-act surface (the spectacular runs durationS × segments = 30s);
  // ping-pong surfaces loop out to 2× downstream. Seedance 2.5 allows up to
  // 30s in one call; 2.0 clamped at 15. (Was 6s — Scott: "videos are too
  // short", 2026-07-14.)
  generation: {
    durationS: num(process.env.GEN_DURATION_S, 15),
    // TOTAL spectacular clip length. FULL PIECE (Shawn, 2026-08-18: "extend
    // videos to 30 seconds now") — iteration mode is over; production renders
    // the complete 30s take (~$16.20/render with Topaz). Set
    // GEN_SPECTACULAR_DURATION_S=10 to drop back to cheap iteration rounds.
    spectacularDurationS: num(process.env.GEN_SPECTACULAR_DURATION_S, 30),
    // Optional EON override: set GEN_EON_DURATION_S=30 to render EON pieces at
    // Seedance 2.5's native 30s (halves visible loop repetition on the
    // pillars; ~2x the gen cost). Unset -> EON uses the base duration (15s).
    eonDurationS: process.env.GEN_EON_DURATION_S === undefined || process.env.GEN_EON_DURATION_S === ''
      ? undefined
      : Number(process.env.GEN_EON_DURATION_S),
    fps: num(process.env.GEN_FPS, 30),
  },

  // fixture | live  — see .env.example. `live` requires explicit opt-in so a
  // stray run can never spend generation credits by accident.
  generationMode: process.env.GENERATION_MODE || 'fixture',

  // Cost rates now live in the canonical price book — services/generation/
  // falPricing.js — which encodes fal's exact token formula (aspect-accurate)
  // and is shared by copy with wow-contract-query so every WOW dashboard bills
  // the one shared fal account identically. Override rates via the FAL_PRICE_*
  // env vars documented in .env.example. (The fal account is shared across WOW
  // Artwork + Content Automation + Broken News, so fal's billing API reports all
  // three combined — the per-generation ledger is the only project-specific
  // figure.)

  // Both models run on fal.ai: Seedance 2.5 (motion, image-to-video) + Seedream
  // (stills — its output URL feeds Seedance as the first frame). Slugs verified
  // against fal docs (2.5: 2026-08-10; the rest 2026-07).
  fal: {
    key: process.env.FAL_KEY,
    // Seedance app id (no "fal-ai/" prefix — matches Content Automation).
    // 2.5 (Shawn, 2026-08-10: "go directly into using 2.5"): native 30s
    // single-pass — the spectacular no longer stitches two 15s clips. Costs
    // $0.0214/1k tokens vs 2.0 standard's $0.014 (falPricing.js). Reverting to
    // a 2.0 slug re-caps clips at 15s and re-enables the two-segment chain.
    seedanceModel: process.env.FAL_SEEDANCE_MODEL || 'bytedance/seedance-2.5/image-to-video',
    seedreamModel: process.env.FAL_SEEDREAM_MODEL || 'fal-ai/bytedance/seedream/v4/text-to-image',
    // GPT Image 2.5 (Shawn, 2026-09-15: "crazy quality and more prompt
    // adherent"). Flare = fast high-quality generation; Sunburst = the slower
    // precision variant (openai/gpt-image-2.5/sunburst/text-to-image).
    // quality: auto | low | medium | high | xhigh | max — the cost lever.
    gptImageModel: process.env.FAL_GPTIMAGE_MODEL || 'openai/gpt-image-2.5/flare/text-to-image',
    gptImageQuality: process.env.FAL_GPTIMAGE_QUALITY || 'xhigh',
    queueBase: process.env.FAL_QUEUE_BASE || 'https://queue.fal.run',
    // fal REST base for storage uploads (the stitched 30s clip + the segment
    // handoff frame must be fal-fetchable URLs before Topaz / Seedance B).
    restBase: process.env.FAL_REST_BASE || 'https://rest.fal.ai',
    // 720p (Shawn, 2026-08-05): the sign is 1692x468 native, so a 21:9 720p
    // render already matches panel width; Topaz still delivers the 4K-class
    // file. NOTE: Seedance 2.5 offers 480p/720p ONLY — no 1080p tier on fal
    // (fal.js requests 720p if this is set to 1080p under a 2.5 model).
    resolution: process.env.FAL_RESOLUTION || '720p',
    generateAudio: process.env.FAL_GENERATE_AUDIO === '1', // artwork is silent by default
    // Topaz AI upscale to 4K-class after Seedance. ON by default (Shawn,
    // 2026-08-18: "enable upscale" — real deliveries resume; billboards DO
    // need it at street scale). FAL_UPSCALE=0 drops back to fast/cheap 720p
    // review renders (plain ffmpeg conform) for visual iteration.
    upscale: {
      enabled: process.env.FAL_UPSCALE === undefined ? true : ['1', 'true', 'yes', 'on'].includes(String(process.env.FAL_UPSCALE).toLowerCase()),
      model: process.env.FAL_UPSCALE_MODEL || 'fal-ai/topaz/upscale/video',
      // 4x pairs with the 720p Seedance tier: 1280x720 → 5120x2880, conformed
      // DOWN to the spec (1692-wide since Jeff's 2026-10-21 email; the art band
      // of a raw 720p render is only ~1280 wide, so the pass still adds real
      // detail). Topaz bills per output second tiered by resolution, so 4x
      // costs the same as 2x at >1080p output.
      factor: num(process.env.FAL_UPSCALE_FACTOR, 4),
    },
  },
  gemini: {
    apiKey: process.env.GEMINI_API_KEY,
  },

  // Which painter makes the stills in live mode: 'gptimage' (GPT Image 2.5,
  // default since 2026-09-15) or 'seedream'. The FRAMED spectacular track
  // always paints with Seedream while GPT Image caps aspect at 3:1 (the
  // painted border must sit at the sign's true 3.62:1 edges).
  stillProvider: (process.env.STILL_PROVIDER || 'gptimage').toLowerCase(),

  // OpenAI powers the plain-language "tweak" — an LLM edits ONLY the reviewer's
  // requested change into a design's existing prompt. Accepts either env name
  // (the shared prod .env already provides OPEN_AI_API_KEY for wow-contract-query).
  // Empty key is fine: refineTweak falls back to a labeled re-roll, never errors.
  openai: {
    apiKey: process.env.OPENAI_API_KEY || process.env.OPEN_AI_API_KEY || '',
    model: process.env.ARTWORK_TWEAK_MODEL || 'gpt-4o-mini',
    // Vision model for the story director (generation/director.js) — looks at
    // each generated still and scripts its motion story from what is actually
    // in the picture.
    directorModel: process.env.ARTWORK_DIRECTOR_MODEL || 'gpt-4o-mini',
    // Vision model for the STYLE ANALYST (services/styles/analyze.js) — looks
    // at the frames of an uploaded reference (an Instagram post, a screenshot,
    // a screen recording) and writes the style card. One call per new style,
    // ~12 images, so the bigger model is affordable and worth it.
    styleModel: process.env.ARTWORK_STYLE_MODEL || 'gpt-4o',
    baseUrl: process.env.OPENAI_BASE_URL || 'https://api.openai.com/v1',
  },

  // Style Library (2026-09-14). Instagram links are fetched through Apify's
  // Instagram scraper (public posts, no login) when a token is configured;
  // without one the link path refuses with a "screenshot it instead" message
  // and uploads still work. maxUploadBytes bounds a screen recording.
  styles: {
    apifyToken: process.env.APIFY_TOKEN || '',
    apifyActor: process.env.APIFY_INSTAGRAM_ACTOR || 'apify~instagram-scraper',
    maxUploadBytes: num(process.env.STYLE_MAX_UPLOAD_MB, 250) * 1024 * 1024,
    maxFrames: num(process.env.STYLE_MAX_FRAMES, 12),
  },

  // Brand guardrails (locked: loose — block nudity only). Config-driven so
  // more rules can be added later without code changes.
  guardrails: {
    blockNudity: bool(process.env.GUARDRAILS_BLOCK_NUDITY, true),
    // Optional comma-separated extra terms to deny in prompts.
    extraDenyTerms: (process.env.GUARDRAILS_EXTRA_DENY_TERMS || '')
      .split(',')
      .map((s) => s.trim().toLowerCase())
      .filter(Boolean),
  },

  // Handoff (locked: Google Drive). FTP kept as an optional fallback. When
  // Drive/Gmail aren't configured the handoff runs OFFLINE — files copied to a
  // local folder and the email written as a .eml — and is reported as NOT sent.
  delivery: {
    method: process.env.DELIVERY_METHOD || 'drive',
    localDir: process.env.HANDOFF_LOCAL_DIR || 'var/handoff',
  },

  // Jeff notification via the Gmail API + a Google service account with
  // domain-wide delegation — sends AS a real @wowmedia.com person, no SMTP.
  publish: {
    // Reuses the same service-account key as Drive.
    serviceAccountJson: process.env.GOOGLE_SERVICE_ACCOUNT_JSON,
    senders: (process.env.PUBLISH_SENDERS || 'scott@wowmedia.com,shawn@wowmedia.com')
      .split(',').map((s) => s.trim()).filter(Boolean),
    from: process.env.PUBLISH_FROM || 'scott@wowmedia.com',
    to: process.env.PUBLISH_TO || process.env.JEFF_EMAIL || 'jeff@wowmedia.com',
    domain: process.env.PUBLISH_DOMAIN || 'wowmedia.com',
  },
  drive: {
    // ID of the watched Drive folder picks are dropped into.
    folderId: process.env.GOOGLE_DRIVE_FOLDER_ID,
    // Service-account JSON (string) OR an OAuth refresh token — either path
    // yields an access token. See services/delivery/drive.js.
    serviceAccountJson: process.env.GOOGLE_SERVICE_ACCOUNT_JSON,
    oauthClientId: process.env.GOOGLE_OAUTH_CLIENT_ID,
    oauthClientSecret: process.env.GOOGLE_OAUTH_CLIENT_SECRET,
    oauthRefreshToken: process.env.GOOGLE_OAUTH_REFRESH_TOKEN,
  },
  ftp: {
    host: process.env.FTP_HOST,
    port: num(process.env.FTP_PORT, 21),
    user: process.env.FTP_USER,
    password: process.env.FTP_PASSWORD,
    secure: bool(process.env.FTP_SECURE),
    remoteDir: process.env.FTP_REMOTE_DIR || '/incoming',
  },

  mail: {
    from: process.env.MAIL_FROM,
    jeffEmail: process.env.JEFF_EMAIL || 'jeff@wowmedia.com',
    smtp: {
      host: process.env.SMTP_HOST,
      port: num(process.env.SMTP_PORT, 587),
      user: process.env.SMTP_USER,
      password: process.env.SMTP_PASSWORD,
    },
  },

  ffmpeg: {
    ffmpegPath: process.env.FFMPEG_PATH || 'ffmpeg',
    ffprobePath: process.env.FFPROBE_PATH || 'ffprobe',
  },

  scheduler: {
    weeklyCron: process.env.WEEKLY_RUN_CRON || '0 9 * * 1',
    // In-process scheduler is opt-in so dev/test/CI never auto-fire a run.
    // Enable in production (PM2) to fire the weekly batch automatically.
    enabled: bool(process.env.SCHEDULER_ENABLED, false),
  },
};

export default config;
