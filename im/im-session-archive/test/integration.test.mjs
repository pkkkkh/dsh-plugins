/**
 * im-session-archive 集成测试：用假 ctx 跑 apply()，验证
 *   · 新 IM 会话出现 → 旧会话归档 + 旧会话并进长期上下文
 *   · turn/end → 当前会话被刷新进长期上下文（「一直在更新」）
 * 运行：node --test test/integration.test.mjs
 */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { apply, sessionsDirName, parseNotes } from "../lib/index.js";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "im-integration-"));
const home = path.join(tmp, "home");
const workspace = path.join(tmp, "im");
const projDir = path.join(home, "storages", "session_projcache");
const sessionsDir = path.join(home, "sessions", sessionsDirName(workspace));
const handoffDir = path.join(workspace, ".dsh", "handoff", "auto");
const latest = path.join(workspace, ".dsh", "handoff", "LONGTERM.md");
const mirror = path.join(workspace, ".dsh", "handoff", "AUTO-latest.md");
const stateFile = path.join(workspace, ".dsh", "handoff", "longterm-state.json");
const workspaceFile = path.join(home, "storages", "workspace.json");

function seedSession({ sid, title, turns, cwd = workspace, mtime }) {
  fs.mkdirSync(path.join(sessionsDir, sid), { recursive: true });
  const doc = {
    version: 1,
    record: {
      identity: {},
      rows: {
        title: { val: title },
        workingDirectory: { val: cwd },
        sessionStats: { val: { turns: turns.length, steps: turns.length * 3 } },
        turnOutline: { val: { turns } },
      },
    },
  };
  const file = path.join(projDir, "sessions", sid + ".json");
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(doc), "utf8");
  if (mtime) fs.utimesSync(file, new Date(mtime), new Date(mtime));
  return file;
}

function fakeCtx() {
  const handlers = [];
  const sections = [];
  return {
    handlers,
    sections,
    logger: { info: () => {}, warn: () => {} },
    systemPrompt: { section: (s) => sections.push(s) },
    on: (name, fn) => {
      handlers.push({ name, fn });
      return () => {};
    },
    effect: () => {},
    emit(event) {
      for (const h of handlers) if (h.name === "session/event") h.fn({ id: event.sessionId }, event);
    },
  };
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

test("apply：归档 + 长期上下文累积 + turn/end 刷新", async () => {
  process.env.DSH_HOME = home;
  fs.mkdirSync(path.join(home, "storages"), { recursive: true });
  fs.writeFileSync(workspaceFile, JSON.stringify({ global: { archivedSessionIds: [] } }), "utf8");

  seedSession({
    sid: "session-old0001",
    title: "微信 · 更旧的会话",
    turns: [
      { turn: 1, prompt: "把长期上下文改好", response: "好的，正在改。" },
      { turn: 2, prompt: "还有遗留吗", response: "没有，收尾了。" },
    ],
    mtime: "2026-11-09T03:00:00.000Z",
  });
  seedSession({
    sid: "session-old0002",
    title: "微信 · 旧会话",
    turns: [
      { turn: 1, prompt: "装自动归档", response: "装好了。" },
      { turn: 2, prompt: "试一下", response: "跑通了。" },
    ],
    mtime: "2026-11-09T04:00:00.000Z",
  });
  seedSession({
    sid: "session-new0002",
    title: "微信 · 新会话",
    // 首轮已完成（有回复）才会归档旧会话
    turns: [{ turn: 1, prompt: "接着来", response: "好的，这里接着处理。" }],
    mtime: "2026-11-09T05:00:00.000Z",
  });
  // planArchive 按 sessions 目录的 mtime 排序，这里把它固定下来
  fs.utimesSync(path.join(sessionsDir, "session-old0001"), new Date("2026-11-09T03:00:00Z"), new Date("2026-11-09T03:00:00Z"));
  fs.utimesSync(path.join(sessionsDir, "session-old0002"), new Date("2026-11-09T04:00:00Z"), new Date("2026-11-09T04:00:00Z"));

  const ctx = fakeCtx();
  apply(ctx, {
    channels: ["微信"],
    imWorkspace: workspace,
    keep: 1,
    dryRun: false,
    autoHandoff: true,
    logFile: path.join(home, "logs", "test.log"),
    handoffDir,
    handoffLatest: latest,
    handoffMirror: mirror,
    handoffState: stateFile,
    maxSessions: 30,
    promptInjection: true,
  });

  // ① 注入的规则指向长期上下文
  assert.equal(ctx.sections.length, 1);
  assert.ok(ctx.sections[0].text.includes(latest));
  assert.ok(ctx.sections[0].text.includes("长期状态"));

  // ② 新会话标题事件：旧会话被归档 + 并进长期上下文
  ctx.emit({ type: "session/title", sessionId: "session-new0002", data: { title: "微信 · 新会话" } });
  await sleep(400);

  assert.ok(fs.existsSync(latest), "LONGTERM.md 应已生成");
  const md = fs.readFileSync(latest, "utf8");
  assert.ok(md.includes("微信 · 旧会话"));
  assert.ok(md.includes("<!-- sid:session-old0002 -->"));
  assert.ok(parseNotes(md) !== null);

  const ws = JSON.parse(fs.readFileSync(workspaceFile, "utf8"));
  assert.deepEqual(ws.global.archivedSessionIds, ["session-old0001"]);

  const state = JSON.parse(fs.readFileSync(stateFile, "utf8"));
  assert.ok(state.sessions.some((s) => s.sid === "session-old0002"));

  assert.equal(fs.readFileSync(mirror, "utf8"), md, "镜像应与正文一致");

  // ③ turn/end：当前会话被刷新进时间线（「一直在更新」）
  ctx.emit({ type: "turn/end", sessionId: "session-new0002", data: { turn: 1 } });
  await sleep(1800);

  const md2 = fs.readFileSync(latest, "utf8");
  assert.ok(md2.includes("微信 · 新会话"), "turn/end 后当前会话应出现在长期上下文里");
  assert.ok(md2.includes("<!-- sid:session-new0002 -->"));
  assert.ok(md2.includes("微信 · 旧会话"), "旧会话不能被冲掉");

  const state2 = JSON.parse(fs.readFileSync(stateFile, "utf8"));
  assert.ok(state2.sessions.some((s) => s.sid === "session-new0002"));
});
