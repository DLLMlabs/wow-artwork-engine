-- WOW Artwork Engine — Spectacular delivery goes panel-native.
-- (Jeff, 2026-10-21 email: "final renders should be: Spectaculars - 1692w x
-- 468h · EONs - 960w x 384h".) Same 3.615:1 aspect as the 4K-class 3840x1062
-- it replaces, so every composition survives; the sign simply receives its
-- own pixels. EON rows are unchanged (already panel-native since 010).
-- Syncs the specs reference table with catalog.js SPECS (the runtime source).
-- Idempotent.

BEGIN;

INSERT INTO specs (key, surface, width, height, format, max_duration_s) VALUES
  ('spectacular_wow1_8', 'spectacular', 1692,  468, 'MP4 / JPEG / PNG', 60),
  ('eon_face',           'eon',          256,  384, 'MP4 / JPEG / PNG', 60),
  ('eon_spine',          'eon',           64,  384, 'MP4 / JPEG / PNG', 60),
  ('eon_master_3pod',    'eon',          960,  384, 'MP4',              60),
  ('eon_master_pod',     'eon',          320,  384, 'MP4',              60)
ON CONFLICT (key) DO UPDATE SET
  surface        = EXCLUDED.surface,
  width          = EXCLUDED.width,
  height         = EXCLUDED.height,
  format         = EXCLUDED.format,
  max_duration_s = EXCLUDED.max_duration_s;

COMMIT;
