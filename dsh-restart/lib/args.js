/**
 * Pure argument/timing helpers for dsh-restart.
 *
 * Kept free of @deepseek-ai imports so `node --test` runs without the host
 * profile (index.js does import the host modules).
 *
 * @module dsh-restart/args
 */

/** Watchdog must be at least this many seconds after the start half. */
export const WATCH_GAP_SECONDS = 60;
export const MAX_WATCH_SECONDS = 1800;

/**
 * Clamp a watchdog delay.
 *
 * 0 / missing / non-numeric / negative → 0 (no watchdog).
 * Otherwise: at least startSeconds + WATCH_GAP_SECONDS, at most 1800.
 *
 * @param {unknown} requested
 * @param {{ startSeconds?: number }} [timings]
 * @returns {number} 0 = disabled
 */
export function normalizeWatchSeconds(requested, timings = {}) {
  const raw = Number(requested);
  if (!Number.isFinite(raw) || raw <= 0) return 0;
  const start = Number(timings?.startSeconds) || 0;
  const floor = start + WATCH_GAP_SECONDS;
  return Math.min(MAX_WATCH_SECONDS, Math.max(floor, Math.round(raw)));
}

/**
 * Parse the "NAME=STATE;next=TIME" lines produced by scripts/dsh-restart-tasks.ps1.
 * A missing task prints "NAME=-" and becomes {state:"", next:""}.
 *
 * @param {unknown} output
 * @returns {{ name: string, state: string, next: string }[]}
 */
export function parseTaskStatus(output) {
  const rows = [];
  for (const line of String(output ?? "").split(/\r?\n/)) {
    const text = line.trim();
    const eq = text.indexOf("=");
    if (!text || eq <= 0) continue;
    const name = text.slice(0, eq);
    const rest = text.slice(eq + 1);
    const parts = rest.split(";");
    const rawState = (parts[0] ?? "-").trim();
    const nextPart = parts.find((p) => p.startsWith("next=")) ?? "next=-";
    const next = nextPart.slice("next=".length).trim();
    rows.push({
      name: name.trim(),
      state: rawState === "-" ? "" : rawState,
      next: next === "-" ? "" : next,
    });
  }
  return rows;
}

/**
 * Does this call need the extended arm script (custom start half / watchdog)?
 *
 * The plain arm script is the long-verified path; everything that only needs
 * "kill + default start" must keep using it.
 */
export function needsExtendedScript({ startScript, watchSeconds } = {}) {
  return String(startScript ?? "").trim().length > 0 || Number(watchSeconds) > 0;
}

/**
 * Build the PowerShell argument list for an arm script.
 *
 * @param {{ script: string, killSeconds: number, startSeconds: number,
 *           startScript?: string, watchSeconds?: number }} options
 * @returns {string[]}
 */
export function buildArmArgs({ script, killSeconds, startSeconds, startScript, watchSeconds }) {
  const args = [
    "-NoProfile",
    "-ExecutionPolicy", "Bypass",
    "-File", String(script),
    "-KillAfterSeconds", String(killSeconds),
    "-StartAfterSeconds", String(startSeconds),
  ];
  const start = String(startScript ?? "").trim();
  if (start) args.push("-StartScript", start);
  const watch = Number(watchSeconds) || 0;
  if (watch > 0) args.push("-WatchAfterSeconds", String(watch));
  return args;
}
