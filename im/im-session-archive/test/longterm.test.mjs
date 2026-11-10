/**
 * im-session-archive 长期上下文单元测试。
 * 运行：node --test test/longterm.test.mjs
 */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  matchChannel,
  sessionsDirName,
  extractFacts,
  upsertSession,
  renderLongterm,
  parseNotes,
  loadState,
  NOTES_BEGIN,
  NOTES_END,
} from "../lib/index.js";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "im-archive-"));

function makeProj(sessionId, { title = "微信 · 测试", cwd = "C:/Users/kh006/.dsh/im", turns = [] } = {}) {
  const projDir = path.join(tmp, "proj");
  fs.mkdirSync(path.join(projDir, "sessions"), { recursive: true });
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
  fs.writeFileSync(path.join(projDir, "sessions", sessionId + ".json"), JSON.stringify(doc), "utf8");
  return projDir;
}

test("matchChannel 只认「通道 + 分隔符」", () => {
  assert.equal(matchChannel("微信 · 测试", ["微信"]), "微信");
  assert.equal(matchChannel("微信：测试", ["微信"]), "微信");
  assert.equal(matchChannel("微信小程序开发", ["微信"]), null);
  assert.equal(matchChannel("微信", ["微信"]), null);
  assert.equal(matchChannel("QQ群聊", ["QQ"]), null);
  assert.equal(matchChannel(" 微信 · x", ["微信"]), "微信");
});

test("sessionsDirName 把工作区映射成 sessions 目录名", () => {
  assert.equal(sessionsDirName("C:/Users/kh006/.dsh/im"), "--C-Users-kh006-.dsh-im--");
});

test("extractFacts 从 projcache 提取事实", () => {
  const sid = "session-aaaa1111";
  const projDir = makeProj(sid, {
    turns: [
      { turn: 1, prompt: "帮我看看这个 bug", response: "好的，我先查一下。" },
      { turn: 2, prompt: "剩下的待办别忘了", response: "记下了。" },
    ],
  });
  const facts = extractFacts(projDir, sid, { channel: "微信" });
  assert.ok(facts);
  assert.equal(facts.sid, sid);
  assert.equal(facts.title, "微信 · 测试");
  assert.equal(facts.channel, "微信");
  assert.equal(facts.turns, 2);
  assert.equal(facts.lastUser, "剩下的待办别忘了");
  assert.equal(facts.pending.length, 1);
  assert.ok(facts.recent.length === 2);
  assert.ok(facts.at);
});

test("extractFacts 读不到 projcache 时返回 null", () => {
  assert.equal(extractFacts(path.join(tmp, "nope"), "session-xxxx", {}), null);
});

test("upsertSession：按 sid 去重、最新在上、只留最新 N 段", () => {
  const state = { version: 1, sessions: [], notes: "" };
  const f = (sid, at, title = "微信 · " + sid) => ({ sid, at, title, channel: "微信" });

  upsertSession(state, f("s1", "2026-11-09T01:00:00.000Z"), { maxSessions: 3 });
  upsertSession(state, f("s2", "2026-11-09T03:00:00.000Z"), { maxSessions: 3 });
  upsertSession(state, f("s3", "2026-11-09T02:00:00.000Z"), { maxSessions: 3 });
  assert.deepEqual(state.sessions.map((s) => s.sid), ["s2", "s3", "s1"]);

  // 同 sid 再更新：原地替换、不重复、保留旧待办
  state.sessions[1].pending = ["遗留：D 盘还没切"];
  upsertSession(state, { ...f("s3", "2026-11-09T04:00:00.000Z"), pending: [] }, { maxSessions: 3 });
  assert.deepEqual(state.sessions.map((s) => s.sid), ["s3", "s2", "s1"]);
  assert.deepEqual(state.sessions[0].pending, ["遗留：D 盘还没切"]);

  // 超过上限丢最旧
  upsertSession(state, f("s4", "2026-11-09T05:00:00.000Z"), { maxSessions: 3 });
  assert.deepEqual(state.sessions.map((s) => s.sid), ["s4", "s3", "s2"]);
});

test("renderLongterm：带长期状态 marker、时间线、可被 parseNotes 读回", () => {
  const state = {
    version: 1,
    updated: "2026-11-09T05:00:00.000Z",
    notes: "### 当前进展\n\n- 在改长期上下文",
    sessions: [
      {
        sid: "session-bbbb2222",
        title: "微信 · 测试",
        channel: "微信",
        at: "2026-11-09T04:00:00.000Z",
        turns: 2,
        steps: 6,
        lastUser: "把自动交接的内容改成长期上下文",
        lastAssistant: "已交接",
        pending: [],
        recent: [{ turn: 2, prompt: "交接了吗", response: "已交接" }],
      },
    ],
  };
  const md = renderLongterm(state, { title: "IM 工作区" });
  assert.ok(md.includes(NOTES_BEGIN) && md.includes(NOTES_END));
  assert.match(md, /### \d{4}-\d{2}-\d{2} \d{2}:\d{2} · 微信 · 测试/);
  assert.ok(md.includes("<!-- sid:session-bbbb2222 -->"));
  assert.ok(md.includes("最后提问：把自动交接的内容改成长期上下文"));
  assert.ok(md.includes("近几轮"));
  assert.ok(md.includes("用户：交接了吗"));
  assert.equal(parseNotes(md).trim(), "### 当前进展\n\n- 在改长期上下文");
});

test("renderLongterm：没有 notes 时用默认占位，不产出 NaN", () => {
  const md = renderLongterm({ sessions: [] });
  assert.ok(md.includes("### 当前进展"));
  assert.ok(!md.includes("NaN"));
  assert.ok(!md.includes("undefined"));
});

test("parseNotes：没有 marker 返回 null", () => {
  assert.equal(parseNotes("# 随便"), null);
  assert.equal(parseNotes(null), null);
});

test("loadState：文件不存在 / 损坏时给空 state", () => {
  const missing = loadState(path.join(tmp, "not-exist.json"));
  assert.deepEqual(missing.sessions, []);
  const bad = path.join(tmp, "bad.json");
  fs.writeFileSync(bad, "{oops", "utf8");
  assert.deepEqual(loadState(bad).sessions, []);
});
