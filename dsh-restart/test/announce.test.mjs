/**
 * Unit tests for the "我回来啦" marker helpers.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  DEFAULT_ANNOUNCE_TEXT,
  clearMarker,
  resolveDelivery,
  isFresh,
  readMarker,
  writeMarker,
} from "../lib/announce.js";

function tempFile() {
  const dir = mkdtempSync(join(tmpdir(), "dsh-restart-announce-"));
  return { dir, file: join(dir, "marker.json") };
}

test("writeMarker → readMarker roundtrip keeps the text", () => {
  const { dir, file } = tempFile();
  try {
    const now = new Date("2026-11-10T06:00:00Z");
    assert.equal(writeMarker(file, "我回来啦", now).ok, true);
    const marker = readMarker(file);
    assert.equal(marker.text, "我回来啦");
    assert.equal(marker.at, now.getTime());
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("writeMarker falls back to the default text when given an empty string", () => {
  const { dir, file } = tempFile();
  try {
    writeMarker(file, "   ");
    assert.equal(readMarker(file).text, DEFAULT_ANNOUNCE_TEXT);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("readMarker returns null for a missing or broken file", () => {
  const { dir, file } = tempFile();
  try {
    assert.equal(readMarker(file), null);
    writeFileSync(file, "{not json", "utf8");
    assert.equal(readMarker(file), null);
    writeFileSync(file, JSON.stringify({ version: 1, at: "nope", text: "hi" }), "utf8");
    assert.equal(readMarker(file), null);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("isFresh honours the max age window", () => {
  const now = new Date("2026-11-10T06:00:00Z");
  const at = (minutes) => ({ at: now.getTime() - minutes * 60_000 });
  assert.equal(isFresh(at(0), now, 30), true);
  assert.equal(isFresh(at(29), now, 30), true);
  assert.equal(isFresh(at(31), now, 30), false);
  assert.equal(isFresh(at(-1), now, 30), false, "future timestamps are not fresh");
  assert.equal(isFresh(null, now, 30), false);
});

test("clearMarker removes the file and stays idempotent", () => {
  const { dir, file } = tempFile();
  try {
    writeMarker(file, "x");
    assert.equal(clearMarker(file), true);
    assert.equal(existsSync(file), false);
    assert.equal(clearMarker(file), false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ---- resolveDelivery: mirrors the REAL dshIm service surface ----

test("resolveDelivery: configured bot+target wins without touching the service", async () => {
  let called = false;
  const im = { listBots: () => { called = true; return []; }, listTargets: () => { called = true; return []; } };
  const route = await resolveDelivery(im, { botId: "bot_x", targetId: "tgt_y" });
  assert.deepEqual(route, { botId: "bot_x", targetId: "tgt_y" });
  assert.equal(called, false);
});

test("resolveDelivery: falls back to the first bot and its first target (array shape)", async () => {
  const im = {
    listBots: async () => [{ botId: "bot_wx", channel: "weixin" }],
    listTargets: async (botId) => [{ targetId: "restart-hello", name: "重启播报" }],
  };
  assert.deepEqual(await resolveDelivery(im, {}), { botId: "bot_wx", targetId: "restart-hello" });
});

test("resolveDelivery: tolerates the { targets } wrapper shape too", async () => {
  const im = {
    listBots: async () => [{ botId: "b1" }],
    listTargets: async () => ({ targets: [{ targetId: "t1" }] }),
  };
  assert.deepEqual(await resolveDelivery(im, {}), { botId: "b1", targetId: "t1" });
});

test("resolveDelivery: reports no-bot / no-target instead of throwing", async () => {
  assert.equal((await resolveDelivery({ listBots: async () => [] }, {})).error, "no-bot");
  const noTarget = await resolveDelivery({ listBots: async () => [{ botId: "b" }], listTargets: async () => [] }, {});
  assert.equal(noTarget.error, "no-target");
  assert.equal(noTarget.botId, "b");
});

test("resolveDelivery: a listTargets failure is reported, not thrown", async () => {
  const im = {
    listBots: async () => [{ botId: "b" }],
    listTargets: async () => { throw new Error("boom"); },
  };
  const route = await resolveDelivery(im, {});
  assert.match(route.error, /list-targets-failed: boom/);
});

test("resolveDelivery: scans every bot and uses the one that has a target", async () => {
  const im = {
    listBots: async () => [{ botId: "b_empty" }, { botId: "b_with" }],
    listTargets: async (botId) => (botId === "b_with" ? [{ targetId: "t_saved" }] : []),
  };
  assert.deepEqual(await resolveDelivery(im, {}), { botId: "b_with", targetId: "t_saved" });
});

test("resolveDelivery: a failing bot is skipped, not fatal", async () => {
  const im = {
    listBots: async () => [{ botId: "b_bad" }, { botId: "b_ok" }],
    listTargets: async (botId) => {
      if (botId === "b_bad") throw new Error("nope");
      return [{ targetId: "t_ok" }];
    },
  };
  assert.deepEqual(await resolveDelivery(im, {}), { botId: "b_ok", targetId: "t_ok" });
});
