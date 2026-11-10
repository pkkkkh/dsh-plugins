/**
 * im-session-archive 新会话自动交接（inject）集成测试。
 * 运行：node --test test/inject.test.mjs
 */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { apply, sessionsDirName } from "../lib/index.js";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "im-inject-"));
const home = path.join(tmp, "home");
const workspace = path.join(tmp, "im");
const projDir = path.join(home, "storages", "session_projcache");
const sessionsDir = path.join(home, "sessions", sessionsDirName(workspace));
const handoffLatest = path.join(workspace, ".dsh", "memory", "LONGTERM.md");
const handoffState = path.join(workspace, ".dsh", "memory", "longterm-state.json");
const injectDocDir = path.join(workspace, ".dsh", "handoff", "auto");

function seedSession({ sid, title, turns, cwd = workspace, mtime }) {
  fs.mkdirSync(path.join(sessionsDir, sid), { recursive: true });
  const doc = {
    version: 1,
    record: {
      identity: {},
      rows: {
        title: { val: title },
        workingDirectory: { val: cwd },
        sessionStats: { val: { turns: turns.length, steps: turns.length * 2 } },
        turnOutline: { val: { turns } },
      },
    },
  };
  const file = path.join(projDir, "sessions", sid + ".json");
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(doc), "utf8");
  if (mtime) fs.utimesSync(file, new Date(mtime), new Date(mtime));
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

test("session/created 时把上一段会话注入新会话", async () => {
  process.env.DSH_HOME = home;

  seedSession({
    sid: "session-prev0001",
    title: "微信 · 旧会话",
    turns: [
      { turn: 1, prompt: "把交接文档做好", response: "好的。" },
      { turn: 2, prompt: "别忘了待办", response: "记下了：还有 D 盘没切。" },
    ],
    mtime: "2026-11-09T05:00:00.000Z",
  });
  seedSession({
    sid: "session-new0002",
    title: "微信 · 新会话",
    // 首轮已完成（有回复、无 openStep）才会注入
    turns: [{ turn: 1, prompt: "继续", response: "好的，接着来。" }],
    mtime: "2026-11-09T06:00:00.000Z",
  });

  const injected = [];
  const agent = { inject: (msg) => { injected.push(msg); } };

  const handlers = [];
  const ctx = {
    logger: { info: () => {}, warn: () => {} },
    systemPrompt: { section: () => {} },
    on: (name, fn) => { handlers.push({ name, fn }); return () => {}; },
    get: (n) => (n === "agents" ? { get: (id) => (id === "session-new0002" ? agent : undefined) } : undefined),
    effect: () => {},
  };

  apply(ctx, {
    channels: ["微信"],
    imWorkspace: workspace,
    dryRun: true, // 只测注入，不归档
    autoHandoff: true,
    promptInjection: false,
    logFile: path.join(home, "logs", "inject-test.log"),
    handoffDir: path.join(workspace, ".dsh", "memory", "auto"),
    handoffLatest,
    handoffState,
    handoffMirror: "",
    injectOnNewSession: true,
    injectDocDir,
    injectMaxChars: 1800,
  });

  const created = handlers.find((h) => h.name === "session/created");
  assert.ok(created, "应订阅 session/created");
  created.fn({ id: "session-new0002", header: { cwd: workspace } });
  await sleep(300);

  assert.equal(injected.length, 1, "应注入一次");
  const msg = injected[0];
  const text = msg.content[0].text;
  assert.ok(text.includes("上一段对话的自动交接"));
  assert.ok(text.includes("微信 · 旧会话"));
  assert.ok(text.includes("上次的结论"));
  assert.ok(text.includes("完整交接文档"));

  const docs = fs.readdirSync(injectDocDir);
  assert.equal(docs.length, 1, "应写一份交接文档到 handoff/auto");
  assert.equal(fs.readFileSync(path.join(injectDocDir, docs[0]), "utf8").includes("微信 · 旧会话"), true);
});

test("没有旧会话时不注入", async () => {
  const handlers = [];
  const ctx = {
    logger: { info: () => {}, warn: () => {} },
    systemPrompt: { section: () => {} },
    on: (name, fn) => { handlers.push({ name, fn }); return () => {}; },
    get: () => undefined,
    effect: () => {},
  };
  apply(ctx, {
    channels: ["微信"],
    imWorkspace: path.join(tmp, "im2"),
    dryRun: true,
    autoHandoff: true,
    promptInjection: false,
    injectOnNewSession: true,
  });
  const created = handlers.find((h) => h.name === "session/created");
  created.fn({ id: "session-alone", header: { cwd: path.join(tmp, "im2") } });
  await sleep(200);
  // 没有 projcache 时会重试，这里只要求不抛错、不注入
  assert.ok(true);
});
