/**
 * Unit tests for the pure helpers added on 2026-11-10.
 * No host imports: these run with a bare `node --test`.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  buildArmArgs,
  needsExtendedScript,
  normalizeWatchSeconds,
  parseTaskStatus,
  WATCH_GAP_SECONDS,
  MAX_WATCH_SECONDS,
} from "../lib/args.js";

test("normalizeWatchSeconds: 0 / missing / junk / negative disable the watchdog", () => {
  for (const value of [0, undefined, null, "", "abc", -5, NaN]) {
    assert.equal(normalizeWatchSeconds(value, { startSeconds: 56 }), 0, String(value));
  }
});

test("normalizeWatchSeconds: too close to the start half is pushed past the floor", () => {
  assert.equal(normalizeWatchSeconds(60, { startSeconds: 56 }), 56 + WATCH_GAP_SECONDS);
  assert.equal(normalizeWatchSeconds(100, { startSeconds: 56 }), 116);
});

test("normalizeWatchSeconds: clamps to MAX_WATCH_SECONDS and rounds", () => {
  assert.equal(normalizeWatchSeconds(99999, { startSeconds: 56 }), MAX_WATCH_SECONDS);
  assert.equal(normalizeWatchSeconds(100.6, { startSeconds: 56 }), 116);
});

test("needsExtendedScript: only a custom start half or a watchdog needs arm2", () => {
  assert.equal(needsExtendedScript({}), false);
  assert.equal(needsExtendedScript({ startScript: "   " }), false);
  assert.equal(needsExtendedScript({ watchSeconds: 0 }), false);
  assert.equal(needsExtendedScript({ startScript: "C:/x.cmd" }), true);
  assert.equal(needsExtendedScript({ watchSeconds: 5 }), true);
});

test("buildArmArgs: plain restart keeps the vetted argument list", () => {
  assert.deepEqual(
    buildArmArgs({ script: "C:/a.ps1", killSeconds: 45, startSeconds: 56 }),
    ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", "C:/a.ps1",
      "-KillAfterSeconds", "45", "-StartAfterSeconds", "56"],
  );
});

test("buildArmArgs: extended flags are appended only when set", () => {
  const args = buildArmArgs({
    script: "C:/arm2.ps1", killSeconds: 120, startSeconds: 131,
    startScript: "C:/maint.cmd", watchSeconds: 300,
  });
  assert.deepEqual(args.slice(-4), ["-StartScript", "C:/maint.cmd", "-WatchAfterSeconds", "300"]);

  const onlyWatch = buildArmArgs({ script: "C:/arm2.ps1", killSeconds: 45, startSeconds: 56, watchSeconds: 200 });
  assert.ok(onlyWatch.includes("-WatchAfterSeconds"));
  assert.ok(!onlyWatch.includes("-StartScript"));
});

test("parseTaskStatus: parses registered and missing rows", () => {
  const rows = parseTaskStatus([
    "DSH-Restart-Start=Ready;next=2026-11-10 14:20:05",
    "DSH-Restart-Kill=-",
    "",
    "noise without separator",
  ].join("\r\n"));
  assert.deepEqual(rows, [
    { name: "DSH-Restart-Start", state: "Ready", next: "2026-11-10 14:20:05" },
    { name: "DSH-Restart-Kill", state: "", next: "" },
  ]);
});
