/**
 * Pure timing helpers for dsh-restart.
 *
 * Kept free of any @deepseek-ai imports so `node --test` can run without the
 * host profile (the plugin's index.js does import the host modules).
 *
 * @module dsh-restart/timings
 */

export const DEFAULT_KILL_SECONDS = 45;
export const DEFAULT_START_GAP_SECONDS = 11;
export const MIN_KILL_SECONDS = 20;
export const MAX_KILL_SECONDS = 600;

/**
 * Clamp a requested delay and derive the start-task delay.
 *
 * Rules (mirrors the PowerShell side, which clamps again):
 *   - non-numeric / <= 0 → fall back to the default
 *   - clamp to [20, 600] seconds
 *   - start always runs `startGapSeconds` (default 11s) after kill
 *
 * @param {unknown} requested delay in seconds, as passed by the tool caller
 * @param {{ defaultKillSeconds?: number, startGapSeconds?: number }} [options]
 * @returns {{ killSeconds: number, startSeconds: number }}
 */
export function resolveTimings(requested, options = {}) {
  const fallback = Number.isFinite(Number(options.defaultKillSeconds))
    ? Number(options.defaultKillSeconds)
    : DEFAULT_KILL_SECONDS;
  const gap = Number.isFinite(Number(options.startGapSeconds))
    ? Math.max(1, Math.round(Number(options.startGapSeconds)))
    : DEFAULT_START_GAP_SECONDS;

  const raw = Number(requested);
  const base = Number.isFinite(raw) && raw > 0 ? raw : fallback;
  const killSeconds = Math.min(MAX_KILL_SECONDS, Math.max(MIN_KILL_SECONDS, Math.round(base)));

  return { killSeconds, startSeconds: killSeconds + gap };
}

/** Human-readable one-liner, also used in the tool result. */
export function describeTimings({ killSeconds, startSeconds }) {
  return `kill at +${killSeconds}s, start at +${startSeconds}s`;
}
