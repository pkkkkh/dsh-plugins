#!/usr/bin/env node
/**
 * 从 projcache 重建「长期上下文交接」（一次性 / 修复用）。
 *
 * 它会：
 *   1. 扫 session_projcache，挑出「标题带通道前缀 + 工作区是本工作区」的最近 N 段会话
 *   2. 把每段会话的事实并进 longterm-state.json（保留已有的「长期状态」区）
 *   3. 渲染 LONGTERM.md，并镜像到 AUTO-latest.md
 *
 * 用法（在 apps/im-session-archive 下）：
 *   node scripts/seed-longterm.mjs                 # 默认 12 段，直接写
 *   node scripts/seed-longterm.mjs --limit 25
 *   node scripts/seed-longterm.mjs --dry           # 只打印、不写
 *
 * 注意：不会删除任何文件；只覆盖 LONGTERM.md / AUTO-latest.md / longterm-state.json。
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  matchChannel,
  extractFacts,
  upsertSession,
  renderLongterm,
  loadState,
  saveState,
  parseNotes,
} from "../lib/index.js";

const argv = process.argv.slice(2);
const arg = (name, fallback) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith("--") ? argv[i + 1] : fallback;
};
const has = (name) => argv.includes(`--${name}`);

const home = process.env.DSH_HOME || path.join(os.homedir(), ".dsh");
const workspace = path.resolve(arg("workspace", "C:/Users/kh006/.dsh/im"));
const channels = String(arg("channels", "微信,QQ,飞书,企业微信,钉钉,Telegram"))
  .split(",").map((s) => s.trim()).filter(Boolean);
const limit = Math.max(1, Number(arg("limit", 12)) || 12);
const dry = has("dry");

const base = path.join(workspace, ".dsh", "memory");
const outFile = path.resolve(arg("out", path.join(base, "LONGTERM.md")));
const mirrorFile = arg("mirror", ""); // 默认不写镜像（2026-11-09 起独立到 .dsh/memory）
const stateFile = path.resolve(arg("state", path.join(base, "longterm-state.json")));

const projDir = path.join(home, "storages", "session_projcache");

function readProj(id) {
  try {
    return JSON.parse(fs.readFileSync(path.join(projDir, "sessions", id + ".json"), "utf8"));
  } catch {
    return null;
  }
}

/** 列出本工作区里带通道前缀的会话（按最后活动倒序）。 */
function listSessions() {
  let names = [];
  try {
    names = fs.readdirSync(path.join(projDir, "sessions"))
      .filter((f) => f.endsWith(".json") && f.startsWith("session-"))
      .map((f) => f.slice(0, -".json".length));
  } catch {
    return [];
  }

  const items = [];
  for (const sid of names) {
    const doc = readProj(sid);
    if (!doc) continue;
    const rows = doc.record?.rows ?? {};
    const title = String(rows.title?.val ?? "").trim();
    const cwd = String(rows.workingDirectory?.val ?? "");
    const channel = matchChannel(title, channels);
    if (!channel) continue;
    if (cwd && path.resolve(cwd).toLowerCase() !== workspace.toLowerCase()) continue;
    let mtime = 0;
    try {
      mtime = new Date(fs.statSync(path.join(projDir, "sessions", sid + ".json")).mtimeMs).toISOString();
    } catch {}
    items.push({ sid, channel, at: mtime });
  }
  items.sort((a, b) => String(b.at).localeCompare(String(a.at)));
  return items;
}

const state = loadState(stateFile);
if (fs.existsSync(outFile)) {
  const notes = parseNotes(fs.readFileSync(outFile, "utf8"));
  if (notes !== null && notes.trim()) state.notes = notes;
}

const picked = listSessions().slice(0, limit);
let merged = 0;
for (const s of picked) {
  const facts = extractFacts(projDir, s.sid, { channel: s.channel });
  if (!facts) continue;
  upsertSession(state, facts, { maxSessions: Math.max(limit, 30) });
  merged += 1;
}

state.updated = new Date().toISOString();
const text = renderLongterm(state, { title: "IM 工作区", maxDetail: 2 });

console.log(`workspace   = ${workspace}`);
console.log(`sessions    = 扫描 ${listSessions().length} 段，并入 ${merged} 段（上限 ${limit}）`);
console.log(`state       = ${stateFile}（${state.sessions.length} 段）`);
console.log(`doc bytes   = ${Buffer.byteLength(text, "utf8")}`);

if (dry) {
  console.log("--dry：不写文件");
} else {
  saveState(stateFile, state);
  fs.mkdirSync(path.dirname(outFile), { recursive: true });
  fs.writeFileSync(outFile, text, "utf8");
  if (mirrorFile) fs.writeFileSync(mirrorFile, text, "utf8");
  console.log(`written     = ${outFile}`);
  if (mirrorFile) console.log(`mirror      = ${mirrorFile}`);
}
