/**
 * im-session-archive —— IM 通道会话的归档 + 长期上下文交接
 *
 * 归档（原有能力，逻辑未改）：
 *   新开一个 IM 通道会话时，把「同一个通道」的旧会话归档（只归档、绝不删除），
 *   按通道分组、保留最近 keep 个、永远不动当前会话。
 *
 * 长期上下文交接（2026-11-09 改版）：
 *   不再为「最后一段会话」写一次性快照，而是维护一份跨会话累积的长期上下文：
 *     · 长期状态（模型 / 人维护）—— 插件只原样保留，永不覆盖
 *     · 会话时间线（插件维护）—— 每段会话一条，最新在上，超过 maxSessions 滚动丢弃
 *   写入时机：
 *     · 新 IM 会话出现 → 把即将退场的旧会话的事实并进去（新会话开局就能读到）
 *     · 每个 turn/end  → 把当前会话的最新一轮并进去（「一直在更新」）
 *   单一事实源：longterm-state.json；渲染成 LONGTERM.md（并镜像一份 AUTO-latest.md）。
 *   模型对 LONGTERM.md「长期状态」区的编辑，会在下一次渲染前被读回 state，不会被覆盖。
 *
 * 铁律（别改）：
 *   · 只归档，绝不删除：只往 workspace.json 的 global.archivedSessionIds 里加 id
 *   · 绝不按工作区清：按「通道前缀」分组，微信只清微信、QQ 只清 QQ
 *   · 保留最近 keep 个（默认 1），且永远不动当前会话
 *   · dryRun 默认 true：第一次上线只写日志，确认规则对了再改 false
 *   · 交接文档是「机械摘要」：只读 projcache，不调用模型、不花 token
 *   · 长期状态区（notes）插件永不覆盖，只原样搬运
 */
import fs from "node:fs";
import path from "node:path";

const SEPS = [" ", "\t", "·", "・", "•", ":", "：", "-", "－", "—", "|", "｜", "/", "\\", "_"];

/** 标题是否以「通道名 + 分隔符」开头。 */
export function matchChannel(title, channels) {
  if (typeof title !== "string") return null;
  const t = title.trim();
  for (const ch of channels) {
    if (!t.startsWith(ch)) continue;
    const rest = t.slice(ch.length);
    if (!rest) continue;
    if (SEPS.includes(rest[0]) || /^\s/.test(rest[0])) return ch;
  }
  return null;
}

/** 工作区路径 → sessions 目录名（--C-Users-kh006-.dsh-im--）。 */
export function sessionsDirName(workspace) {
  return "--" + workspace.replace(/[:]/g, "").replace(/[\\/]/g, "-") + "--";
}

function readProj(projDir, id) {
  try {
    return JSON.parse(fs.readFileSync(path.join(projDir, "sessions", id + ".json"), "utf8"));
  } catch {
    return null;
  }
}

function readTitle(projDir, id) {
  return readProj(projDir, id)?.record?.rows?.title?.val ?? "";
}

/**
 * 纯函数：算出「该归档哪些」。
 */
export function planArchive({ sessionsDir, projDir, channel, keep = 1, currentId, archived = [] }) {
  let names = [];
  try {
    names = fs.readdirSync(sessionsDir, { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .map((d) => d.name);
  } catch {
    return { keep: [], archive: [], scanned: 0 };
  }

  const archivedSet = new Set(archived);
  const items = [];
  for (const id of names) {
    if (id === currentId || archivedSet.has(id)) continue;
    const title = readTitle(projDir, id);
    if (!title || matchChannel(title, [channel]) !== channel) continue;
    let mtime = 0;
    try { mtime = fs.statSync(path.join(sessionsDir, id)).mtimeMs; } catch {}
    items.push({ id, mtime });
  }

  items.sort((a, b) => b.mtime - a.mtime);
  const n = Math.max(0, Math.min(Number(keep) || 0, items.length));
  return {
    keep: items.slice(0, n).map((x) => x.id),
    archive: items.slice(n).map((x) => x.id),
    scanned: names.length,
  };
}

/** 把 id 合并进 workspace.json 的 archivedSessionIds（原子写）。 */
export function archiveSessions(workspaceFile, ids) {
  if (!ids.length) return [];
  const doc = JSON.parse(fs.readFileSync(workspaceFile, "utf8"));
  const cur = new Set(doc?.global?.archivedSessionIds ?? []);
  const added = ids.filter((id) => !cur.has(id));
  if (!added.length) return [];
  for (const id of added) cur.add(id);
  doc.global.archivedSessionIds = [...cur].sort();

  const tmp = workspaceFile + ".tmp";
  fs.writeFileSync(tmp, JSON.stringify(doc, null, 2), "utf8");
  fs.renameSync(tmp, workspaceFile);
  return added;
}

const clip = (s, n) => {
  const t = String(s ?? "").replace(/\s+/g, " ").trim();
  return t.length > n ? t.slice(0, n) + "…" : t;
};

/** 从 projcache 机械生成一份「单次会话」快照（不调用模型），仍写进 auto/ 目录供回看。 */
export function buildHandoff(projDir, sessionId, meta = {}) {
  const doc = readProj(projDir, sessionId);
  if (!doc) return null;
  const rows = doc?.record?.rows ?? {};
  const title = rows.title?.val ?? "(无标题)";
  const turns = rows.turnOutline?.val?.turns ?? [];
  const stats = rows.sessionStats?.val ?? {};
  const cwd = rows.workingDirectory?.val ?? "";

  const L = [];
  L.push(`# 自动交接 · ${title}`);
  L.push("");
  L.push(`> 由 \`im-session-archive\` 于 ${new Date().toISOString()} 机械生成；内容取自会话记录，未经模型润色。`);
  L.push("");
  L.push("## 基本");
  L.push("");
  L.push(`- 会话 id：\`${sessionId}\``);
  L.push(`- 标题：${title}`);
  L.push(`- 工作区：\`${cwd}\``);
  L.push(`- 轮次：${stats.turns ?? turns.length}　步数：${stats.steps ?? "?"}`);
  if (meta.channel) L.push(`- 通道：${meta.channel}`);
  L.push("");

  const recent = turns.slice(-8);
  if (recent.length) {
    L.push("## 最近对话");
    L.push("");
    for (const t of recent) {
      L.push(`### 第 ${t.turn} 轮`);
      L.push("");
      L.push(`**用户**：${clip(t.prompt, 200)}`);
      L.push("");
      L.push(`**助手**：${clip(t.response, 400)}`);
      L.push("");
    }
  }

  const prompts = turns.map((t) => String(t.prompt ?? ""));
  const pending = prompts.filter((p) => /未完成|待办|下一步|遗留|还没|待确认/.test(p)).slice(-5);
  if (pending.length) {
    L.push("## 用户提过的「待办 / 下一步」关键词");
    L.push("");
    for (const p of pending) L.push(`- ${clip(p, 120)}`);
    L.push("");
  }

  const last = turns[turns.length - 1];
  if (last?.response) {
    L.push("## 最后一条结论（原文摘要）");
    L.push("");
    L.push(clip(last.response, 1200));
    L.push("");
  }

  L.push("---");
  L.push("");
  L.push("> 接手的会话：读完这份，先确认哪几件事还没收尾，再决定要不要问用户。");
  return L.join("\n");
}

// ---------------------------------------------------------------------------
// 长期上下文：facts → state → markdown
// ---------------------------------------------------------------------------

export const NOTES_BEGIN = "<!-- longterm:notes:begin -->";
export const NOTES_END = "<!-- longterm:notes:end -->";

export const DEFAULT_NOTES = [
  "<!-- 由模型 / 人维护：当前进展、重要决定、未收尾事项。插件只原样保留，永不覆盖。 -->",
  "### 当前进展",
  "",
  "- （还没有记录）",
  "",
  "### 未收尾 / 待办",
  "",
  "- （没有）",
  "",
  "### 重要决定 / 坑",
  "",
  "- （没有）",
].join("\n");

/** 从 projcache 提取一段会话的「事实」（纯数据，不含渲染）。 */
export function extractFacts(projDir, sessionId, meta = {}) {
  const doc = readProj(projDir, sessionId);
  if (!doc) return null;
  const rows = doc?.record?.rows ?? {};
  const title = String(rows.title?.val ?? "").trim() || "(无标题)";
  const cwd = String(rows.workingDirectory?.val ?? "");
  const turns = (rows.turnOutline?.val?.turns ?? []).map((t) => ({
    turn: t.turn,
    prompt: String(t.prompt ?? ""),
    response: String(t.response ?? ""),
  }));
  const stats = rows.sessionStats?.val ?? {};

  // projcache 没有「开始时间」，用文件 mtime 当「最后活动」。
  let at = new Date().toISOString();
  try {
    at = new Date(fs.statSync(path.join(projDir, "sessions", sessionId + ".json")).mtimeMs).toISOString();
  } catch {}

  const last = turns[turns.length - 1];
  const pending = [...new Set(
    turns.map((t) => t.prompt)
      .filter((p) => /未完成|待办|下一步|遗留|还没|待确认/.test(p))
      .map((p) => clip(p, 120)),
  )].slice(-5);

  return {
    sid: sessionId,
    title,
    channel: meta.channel ?? null,
    cwd,
    at,
    turns: stats.turns ?? turns.length,
    steps: stats.steps ?? null,
    lastUser: clip(last?.prompt, 200),
    lastAssistant: clip(last?.response, 1500),
    pending,
    recent: turns.slice(-3).map((t) => ({
      turn: t.turn,
      prompt: clip(t.prompt, 150),
      response: clip(t.response, 400),
    })),
  };
}

/** 把一段会话的事实并进 state（按 sid 去重、最新在上、超过 maxSessions 丢弃最旧）。 */
export function upsertSession(state, facts, { maxSessions = 30 } = {}) {
  if (!state || typeof state !== "object") throw new TypeError("state must be an object");
  if (!facts?.sid) throw new TypeError("facts.sid is required");
  const list = Array.isArray(state.sessions) ? state.sessions : [];
  const i = list.findIndex((s) => s?.sid === facts.sid);
  const entry = {};
  for (const [k, v] of Object.entries(facts)) if (v !== undefined && v !== null) entry[k] = v;
  if (i >= 0) {
    const old = list[i];
    list[i] = {
      ...old,
      ...entry,
      // 新一轮如果没读出待办（比如只跑了半截），别把旧的冲掉
      pending: entry.pending?.length ? entry.pending : (old.pending ?? []),
    };
  } else {
    list.unshift(entry);
  }
  list.sort((a, b) => String(b.at ?? "").localeCompare(String(a.at ?? "")));
  const n = Math.max(1, Number(maxSessions) || 30);
  state.sessions = list.slice(0, n);
  state.updated = new Date().toISOString();
  return state;
}

/** ISO 时间 → 本地（插件运行机器的时区）`YYYY-MM-DD HH:mm`。 */
export function fmtLocal(iso) {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return String(iso ?? "?");
  const p = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

/** 渲染长期上下文 markdown。 */
export function renderLongterm(state, opts = {}) {
  const title = opts.title || "IM 工作区";
  const maxDetail = Number.isFinite(opts.maxDetail) ? opts.maxDetail : 2;
  const sessions = Array.isArray(state?.sessions) ? state.sessions : [];
  const notes = String(state?.notes ?? "").trim() || DEFAULT_NOTES;
  const updated = state?.updated ? fmtLocal(state.updated) : "?";

  const L = [];
  L.push(`# 长期上下文交接 · ${title}`);
  L.push("");
  L.push("> 这份文件是**跨会话持续更新**的长期上下文，不是某一次会话的快照。");
  L.push(`> 由 \`im-session-archive\` 自动维护（新会话开局时生成、之后每轮刷新）；上次更新：${updated}`);
  L.push("> 「长期状态」区由模型 / 人在两个 marker 之间维护，插件原样保留；「会话时间线」由插件维护，不要手改。");
  L.push("");
  L.push("## 长期状态");
  L.push("");
  L.push(NOTES_BEGIN);
  L.push(notes);
  L.push(NOTES_END);
  L.push("");
  L.push("## 会话时间线（新 → 旧）");
  L.push("");
  if (!sessions.length) {
    L.push("- （还没有记录）");
    L.push("");
  }
  sessions.forEach((s, i) => {
    const when = s.at ? fmtLocal(s.at) : "?";
    L.push(`### ${when} · ${s.title ?? "(无标题)"}`);
    L.push("");
    L.push(`<!-- sid:${s.sid ?? "?"} -->`);
    L.push(`- 轮次 ${s.turns ?? "?"}${s.steps != null ? ` / 步数 ${s.steps}` : ""}${s.channel ? ` · 通道 ${s.channel}` : ""}`);
    const lastRecent = s.recent?.[s.recent.length - 1]?.prompt;
    if (s.lastUser && s.lastUser !== lastRecent) L.push(`- 最后提问：${s.lastUser}`);
    if (s.lastAssistant) {
      const cap = i < maxDetail ? 900 : i < maxDetail + 3 ? 400 : 180;
      L.push(`- 最后结论：${clip(s.lastAssistant, cap)}`);
    }
    if (s.pending?.length) L.push(`- 待办线索：${s.pending.join("；")}`);
    if (i < maxDetail && Array.isArray(s.recent) && s.recent.length) {
      L.push("- 近几轮：");
      for (const t of s.recent) {
        L.push(`  - 第 ${t.turn} 轮 · 用户：${t.prompt || "（空）"}`);
        if (t.response) L.push(`    助手：${t.response}`);
      }
    }
    L.push("");
  });

  L.push("---");
  L.push("");
  L.push("> 接手的会话：先读「长期状态」，再有需要就看时间线里最近 2 段；做完重要的事记得把结论写回「长期状态」。");
  return L.join("\n");
}

/** 从已有 markdown 里取回「长期状态」区（模型 / 人的编辑以此为准）。 */
export function parseNotes(markdown) {
  if (typeof markdown !== "string") return null;
  const i = markdown.indexOf(NOTES_BEGIN);
  if (i < 0) return null;
  const j = markdown.indexOf(NOTES_END, i + NOTES_BEGIN.length);
  if (j < 0) return null;
  return markdown.slice(i + NOTES_BEGIN.length, j).replace(/^\s*\n/, "").replace(/\n\s*$/, "");
}

/** 新会话开局注入的交接正文：上一段会话摘要 + 长期状态摘要。 */
export function buildBridgeText(prevFacts, notes, { maxChars = 1800 } = {}) {
  const cut = (s, n) => {
    const t = String(s ?? "");
    return t.length > n ? t.slice(0, n) + "…" : t;
  };
  const L = [];
  L.push("【上一段对话的自动交接 · 系统注入，不是用户的新消息】");
  if (prevFacts?.title) {
    L.push(`上一段：${prevFacts.title}（${fmtLocal(prevFacts.at)}，${prevFacts.turns ?? "?"} 轮）`);
  }
  if (prevFacts?.lastUser) L.push(`用户最后在问：${cut(prevFacts.lastUser, 200)}`);
  if (prevFacts?.lastAssistant) L.push(`上次的结论：${cut(prevFacts.lastAssistant, 700)}`);
  if (prevFacts?.pending?.length) L.push(`待办线索：${prevFacts.pending.join("；")}`);
  const n = String(notes ?? "").trim();
  if (n) L.push(`长期状态摘要：\n${cut(n, 600)}`);
  L.push("直接接着聊即可，不用复述这段交接。");
  const text = L.join("\n");
  return text.length > maxChars ? text.slice(0, maxChars) + "…" : text;
}

export function loadState(file) {
  try {
    const doc = JSON.parse(fs.readFileSync(file, "utf8"));
    if (!doc || typeof doc !== "object") return { version: 1, sessions: [], notes: "" };
    return {
      version: 1,
      updated: typeof doc.updated === "string" ? doc.updated : null,
      notes: typeof doc.notes === "string" ? doc.notes : "",
      sessions: Array.isArray(doc.sessions) ? doc.sessions : [],
    };
  } catch {
    return { version: 1, sessions: [], notes: "" };
  }
}

export function saveState(file, state) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(state, null, 2), "utf8");
  fs.renameSync(tmp, file);
}

function writeTextAtomic(file, text) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, text, "utf8");
  fs.renameSync(tmp, file);
}

function readText(file) {
  try { return fs.readFileSync(file, "utf8"); } catch { return null; }
}

function appendLog(file, line) {
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.appendFileSync(file, line + "\n", "utf8");
  } catch {}
}

const MUTEX = { chain: Promise.resolve() };
function serial(fn) {
  MUTEX.chain = MUTEX.chain.then(fn, fn);
  return MUTEX.chain;
}

export const name = "im-session-archive";
export const inject = ["systemPrompt"];

export function apply(ctx, config = {}) {
  const channels = (Array.isArray(config.channels) ? config.channels : [])
    .map((c) => String(c ?? "").trim())
    .filter(Boolean);
  const workspace = String(config.imWorkspace || "").trim();
  const keep = Number(config.keep ?? 1);
  const dryRun = config.dryRun !== false;
  const autoHandoff = config.autoHandoff !== false;
  const logFile = String(config.logFile || "").trim();
  const maxSessions = Math.max(1, Number(config.maxSessions ?? 30));
  // 新会话开局自动交接：写一份文档到 handoff/auto，并把摘要注入新会话
  const injectOnNew = config.injectOnNewSession !== false;
  const injectDocDir = String(config.injectDocDir || "").trim()
    || path.join(workspace, ".dsh", "handoff", "auto");
  const injectMaxChars = Math.max(300, Number(config.injectMaxChars ?? 1800));
  // 轮询兜底：session/event、session/created 在 App 重启后实测可能收不到，
  // 用低频扫描 projcache 保证「长期上下文一直在更新」+「新会话能拿到注入」。
  const pollMs = Math.max(4000, Number(config.pollMs ?? 8000));

  if (!channels.length || !workspace) {
    ctx.logger?.info?.("[im-session-archive] 没配置 channels / imWorkspace，空转");
    return;
  }

  // 2026-11-09 15:06：插件进程里的 process.env.DSH_HOME 可能拿不到（实测读到了 C 的旧 home），
  // 所以显式配置 dshHome 优先。
  const home = String(config.dshHome || "").trim()
    || process.env.DSH_HOME
    || path.join(process.env.USERPROFILE || "", ".dsh");
  const sessionsDir = path.join(home, "sessions", sessionsDirName(workspace));
  const projDir = path.join(home, "storages", "session_projcache");
  const workspaceFile = path.join(home, "storages", "workspace.json");
  const handoffDir = String(config.handoffDir || "").trim() || path.join(workspace, ".dsh", "handoff", "auto");
  const handoffLatest = String(config.handoffLatest || "").trim()
    || path.join(path.dirname(handoffDir), "LONGTERM.md");
  const handoffMirror = String(config.handoffMirror || "").trim();
  const stateFile = String(config.handoffState || "").trim()
    || path.join(path.dirname(handoffLatest), "longterm-state.json");

  const done = new Set();
  const timers = new Set();
  const channelCache = new Map();
  const log = (msg) => {
    const line = `[${new Date().toISOString()}] ${msg}`;
    if (logFile) appendLog(logFile, line);
    ctx.logger?.info?.("[im-session-archive] " + msg);
  };

  log(`loaded: channels=${channels.join("/")} keep=${keep} dryRun=${dryRun} autoHandoff=${autoHandoff} maxSessions=${maxSessions} home=${home} pollMs=${pollMs}`);

  // 让「新会话」知道有这么一份长期上下文（静态规则，靠模型遵守；不强制）
  // 2026-11-09：字段名必须是 text（不是 content），否则每次请求都会炸：
  //   TypeError: Cannot read properties of undefined (reading 'indexOf')
  //   —— 表现就是「助手不说话」。WorkBuddy 的回滚日志里抓到的正是这条。
  if (autoHandoff && config.promptInjection !== false) {
    try {
      ctx.systemPrompt?.section?.({
        name: "im:auto-handoff",
        order: 150,
        interpolate: false,
        text:
          "【IM 长期上下文】工作区 ~/.dsh/im 的会话共享一份长期上下文文件 " +
          `${handoffLatest}（跨会话累积：长期状态 + 会话时间线，插件会自动更新）。` +
          "处理本会话第一条用户消息时，如果该文件存在，先用 read 读它（**不要**在回复里声明「已接上上一段对话…」，用户明确不喜欢这句）；文件不存在就跳过。\n" +
          "这份文件是长期记忆：本轮如果完成了重要工作、做出决定、或发现新的未收尾事项，" +
          "请用 edit 更新其中「长期状态」区（两个 marker 之间）——覆盖过时信息、保持精炼，别堆流水账；" +
          "「会话时间线」由插件维护，不要手改。",
      });
    } catch (e) {
      log(`systemPrompt section failed: ${e?.message ?? e}`);
    }
  }

  // ---------------- 长期上下文状态 ----------------
  const state = loadState(stateFile);
  const existing = readText(handoffLatest);
  const existingNotes = existing ? parseNotes(existing) : null;
  if (existingNotes !== null && existingNotes.trim()) state.notes = existingNotes;

  let lastRendered = "";

  function persist(reason) {
    try {
      // 模型可能刚编辑过 LONGTERM.md 的「长期状态」区 → 以磁盘上的为准
      const cur = readText(handoffLatest);
      const notes = cur ? parseNotes(cur) : null;
      if (notes !== null && notes.trim() && notes !== state.notes) state.notes = notes;

      state.updated = new Date().toISOString();
      const text = renderLongterm(state, {
        title: String(config.contextTitle || "").trim() || "IM 工作区",
        maxDetail: 2,
      });
      if (text === lastRendered && text === cur) return;

      saveState(stateFile, state);
      writeTextAtomic(handoffLatest, text);
      if (handoffMirror) writeTextAtomic(handoffMirror, text);
      lastRendered = text;
      log(`CONTEXT ${reason} sessions=${state.sessions.length} bytes=${text.length}`);
    } catch (e) {
      log(`CONTEXT-FAIL ${reason} ${e?.message ?? e}`);
    }
  }

  /** 会话 id → 通道（命中才算 IM 会话；只缓存命中，标题可能还没生成）。 */
  function channelFor(id) {
    const hit = channelCache.get(id);
    if (hit) return hit;
    const title = readTitle(projDir, id);
    const ch = matchChannel(title, channels);
    if (ch) channelCache.set(id, ch);
    return ch;
  }

  function factsFor(id) {
    const doc = readProj(projDir, id);
    if (!doc) return null;
    // 不再按 cwd 过滤：IM 会话中途 cd 到别处（例如 agent 切工作目录）也要继续跟踪；
    // 通道前缀（标题）已足够区分是不是 IM 会话。
    return extractFacts(projDir, id, { channel: channelFor(id) });
  }

  // ---------- 新会话开局自动交接 ----------
  const injected = new Set();
  const pendingInjects = new Set(); // 防并发重试（session/created 与轮询可能同时触发）

  /** 同工作区、最近的「另一段」IM 会话。 */
  function latestOtherImSession(currentId) {
    let names = [];
    try {
      names = fs.readdirSync(path.join(projDir, "sessions"))
        .filter((f) => f.startsWith("session-") && f.endsWith(".json"))
        .map((f) => f.slice(0, -".json".length));
    } catch {
      return null;
    }
    let best = null;
    for (const id of names) {
      if (id === currentId) continue;
      const title = readTitle(projDir, id);
      if (!matchChannel(title, channels)) continue;
      let mt = 0;
      try { mt = fs.statSync(path.join(projDir, "sessions", id + ".json")).mtimeMs; } catch {}
      if (!best || mt > best.mt) best = { id, mt, title };
    }
    return best;
  }

  /**
   * 给新会话注入交接：写一份文档到 handoff/auto，再把摘要 inject 进新会话。
   * agent 可能还没激活、projcache 也可能还没落盘 → 最多重试约 15 秒。
   */
  function tryInjectHandoff(sid, attempt = 0) {
    if (!injectOnNew || injected.has(sid)) return;
    if (attempt === 0) {
      if (pendingInjects.has(sid)) return; // 已有一个重试循环在跑
      pendingInjects.add(sid);
    }
    const retry = () => {
      if (attempt >= 200) {
        log(`INJECT-GIVEUP ${sid}（100 秒内没等到空闲/就绪）`);
        pendingInjects.delete(sid);
        return;
      }
      const t = setTimeout(() => { timers.delete(t); tryInjectHandoff(sid, attempt + 1); }, 500);
      timers.add(t);
      if (typeof t.unref === "function") t.unref();
    };

    // 确认新会话确实是本工作区的（projcache 还没写就等一等）
    const cur = readProj(projDir, sid);
    if (!cur) return retry();
    const curCwd = String(cur?.record?.rows?.workingDirectory?.val ?? "");
    const curTitle = String(cur?.record?.rows?.title?.val ?? "");
    if (curTitle) {
      // 标题已生成：以 IM 通道前缀为准（cwd 可能被 agent 中途改掉）
      if (!matchChannel(curTitle, channels)) { pendingInjects.delete(sid); return; }
    } else if (curCwd && path.resolve(curCwd).toLowerCase() !== path.resolve(workspace).toLowerCase()) {
      // 标题还没生成时用 cwd 兜底
      pendingInjects.delete(sid);
      return;
    }
    // 有较多历史的会话（例如被恢复的旧会话）不当作「新会话」注入
    const curTurns = cur?.record?.rows?.turnOutline?.val?.turns?.length ?? 0;
    if (curTurns > 2) { pendingInjects.delete(sid); return; }

    // 只在会话空闲时注入：首轮还在跑（append 中）就别抢——2026-11-09 15:20 实测
    // 注入和首条消息的 append 撞车会触发 INTERNAL_UNKNOWN，让用户那条消息失败。
    const stats = cur?.record?.rows?.sessionStats?.val ?? {};
    const turnList = cur?.record?.rows?.turnOutline?.val?.turns ?? [];
    const lastTurn = turnList[turnList.length - 1];
    const lastDone = lastTurn && String(lastTurn.response ?? "").trim().length > 0;
    if (stats.openStep || !lastDone) return retry();

    const prev = latestOtherImSession(sid);
    if (!prev) return; // 没有旧会话可交接

    const agents = (() => { try { return ctx.get?.("agents"); } catch { return null; } })();
    const agent = agents?.get?.(sid);
    if (!agent || typeof agent.inject !== "function") return retry();

    try {
      const channel = matchChannel(prev.title, channels);
      const facts = extractFacts(projDir, prev.id, { channel });
      const md = buildHandoff(projDir, prev.id, { channel });
      let docPath = "";
      if (md) {
        fs.mkdirSync(injectDocDir, { recursive: true });
        const stamp = new Date().toISOString().replace(/[-:T]/g, "").slice(0, 13);
        docPath = path.join(injectDocDir, `${stamp}-${prev.id.replace(/^session-/, "").slice(0, 8)}.md`);
        fs.writeFileSync(docPath, md, "utf8");
      }
      const text = buildBridgeText(facts, state.notes, { maxChars: injectMaxChars })
        + (docPath ? `\n（完整交接文档：${docPath}）` : "");
      agent.inject({ content: [{ type: "text", text }], source: { kind: "im-session-archive" } });
      injected.add(sid);
      pendingInjects.delete(sid);
      log(`INJECT new=${sid} prev=${prev.id} chars=${text.length} doc=${docPath || "-"}`);
    } catch (e) {
      // 常见：新会话正在发布第一条消息（append 重入限制）→ 退避重试，别只靠标题事件兜底
      log(`INJECT-FAIL ${sid} ${e?.message ?? e}`);
      retry();
    }
  }

  // 微信 /new 之后第一条消息会创建新会话 → 在这里把上一段交接注入进去
  ctx.on("session/created", (session) => {
    const sid = session?.id;
    if (!sid) return;
    const cwd = String(session?.header?.cwd ?? session?.cwd ?? "");
    if (cwd && path.resolve(cwd).toLowerCase() !== path.resolve(workspace).toLowerCase()) return;
    tryInjectHandoff(sid);
  }, { global: true });

  // ---------- 轮询兜底 ----------
  const metaCache = new Map(); // sid -> { mt, title, cwd, channel, im }
  let pollSeeded = false;

  function refreshFacts(sid, reason) {
    serial(async () => {
      const facts = factsFor(sid);
      if (!facts) return;
      upsertSession(state, facts, { maxSessions });
      persist(reason);
    });
  }

  let pollTick = 0;
  function scanOnce() {
    pollTick += 1;
    let names = [];
    try {
      names = fs.readdirSync(path.join(projDir, "sessions"))
        .filter((f) => f.startsWith("session-") && f.endsWith(".json"));
    } catch (e) {
      log(`POLL-FAIL readdir ${e?.message ?? e}`);
      return;
    }
    const changed = [];
    for (const f of names) {
      const sid = f.slice(0, -".json".length);
      let mt = 0;
      try { mt = fs.statSync(path.join(projDir, "sessions", f)).mtimeMs; } catch { continue; }
      const old = metaCache.get(sid);
      if (old && old.mt === mt) continue;
      const doc = readProj(projDir, sid);
      if (!doc) continue;
      const rows = doc?.record?.rows ?? {};
      const title = String(rows.title?.val ?? "");
      const cwd = String(rows.workingDirectory?.val ?? "");
      const ch = matchChannel(title, channels);
      metaCache.set(sid, { mt, title, cwd, channel: ch, im: !!ch });
      if (ch) changed.push({ sid, existed: !!old });
    }
    log(`POLL tick=${pollTick} files=${names.length} changed=${changed.length} known=${metaCache.size}`);
    if (!pollSeeded) {
      pollSeeded = true; // 第一次只建立基线，不注入、不刷新
      log(`POLL baseline sessions=${metaCache.size}`);
      return;
    }
    for (const s of changed) {
      if (!s.existed) {
        tryInjectHandoff(s.sid);
        archiveOnNewSession(s.sid, metaCache.get(s.sid)?.channel);
      } else {
        refreshFacts(s.sid, `poll ${s.sid.slice(-12)}`);
      }
    }
  }

  /**
   * 归档同通道旧会话（只加 id，不删文件）。
   * 只有「新会话已经真正用起来」（第一轮有回复）才归档——否则会出现
   * 「新对话还没建好，旧对话先被藏起来」的情况（2026-11-09 15:22 实测）。
   */
  function archiveOnNewSession(sid, channel, attempt = 0) {
    if (!channel) return;
    const cur = readProj(projDir, sid);
    const turns = cur?.record?.rows?.turnOutline?.val?.turns ?? [];
    const last = turns[turns.length - 1];
    const ready = last && String(last.response ?? "").trim().length > 0;
    if (!ready) {
      if (attempt < 12) {
        const t = setTimeout(() => {
          timers.delete(t);
          archiveOnNewSession(sid, channel, attempt + 1);
        }, 10000);
        timers.add(t);
        if (typeof t.unref === "function") t.unref();
      } else {
        log(`ARCHIVE-GIVEUP ${sid}（新会话一直没有完成首轮）`);
      }
      return;
    }
    try {
      const ws = JSON.parse(fs.readFileSync(workspaceFile, "utf8"));
      const archived = ws?.global?.archivedSessionIds ?? [];
      const plan = planArchive({ sessionsDir, projDir, channel, keep, currentId: sid, archived });
      const pretty = (ids) => ids.map((id) => id.replace(/^session-/, "").slice(0, 8)).join(",");
      if (!plan.archive.length) return;
      if (dryRun) {
        log(`POLL-DRY-RUN would archive: ${pretty(plan.archive)}`);
        return;
      }
      const added = archiveSessions(workspaceFile, plan.archive);
      log(`POLL-ARCHIVED ${added.length}: ${pretty(added)}`);
    } catch (e) {
      log(`POLL-ARCHIVE-FAIL ${e?.message ?? e}`);
    }
  }

  const pollTimer = setInterval(scanOnce, pollMs);
  if (typeof pollTimer.unref === "function") pollTimer.unref();
  // 启动即扫一次（建基线）
  scanOnce();

  // 每轮结束后刷新「当前会话」在长期上下文里的位置（「一直在更新」）
  function scheduleRefresh(sessionId) {
    if (timers.size > 64) return;
    const t = setTimeout(() => {
      timers.delete(t);
      serial(async () => {
        if (!channelFor(sessionId)) return;
        const facts = factsFor(sessionId);
        if (!facts) return;
        upsertSession(state, facts, { maxSessions });
        persist(`turn-end ${sessionId.slice(-12)}`);
      });
    }, 1200);
    timers.add(t);
    if (typeof t.unref === "function") t.unref();
  }

  // global: true —— 订阅所有会话的事件（否则 App 重启/会话恢复后可能收不到 turn/end，
  // 2026-11-09 14:30 后观察到 CONTEXT 日志不再出现）。过滤条件在 handler 内部。
  ctx.on("session/event", (session, event) => {
    if (!event) return;
    if (event.type === "turn/end") {
      const sid = session?.id;
      if (sid) scheduleRefresh(sid);
      return;
    }
    if (event.type !== "session/title") return;

    const title = event.data?.title;
    const channel = matchChannel(title, channels);
    if (!channel) return;

    const currentId = session?.id;
    if (!currentId || done.has(currentId)) return;
    done.add(currentId);
    channelCache.set(currentId, channel);
    // 兜底：如果 session/created 时没注入成功（例如 agent 还没激活），标题出来后补一次
    tryInjectHandoff(currentId);

    serial(async () => {
      let plan;
      try {
        plan = planArchive({ sessionsDir, projDir, channel, keep, currentId });
      } catch (e) {
        log(`PLAN-FAIL ${currentId} ${e?.message ?? e}`);
        return;
      }
      const pretty = (ids) => ids.map((id) => id.replace(/^session-/, "").slice(0, 8)).join(",");
      log(`TITLE "${String(title).slice(0, 24)}" channel=${channel} current=${currentId} scanned=${plan.scanned} keep=${plan.keep.length} archive=${plan.archive.length}`);

      // ① 给「即将退场的那个旧会话」留一份单次快照（审计用），并并进长期上下文
      if (autoHandoff && plan.keep[0]) {
        const prevId = plan.keep[0];
        try {
          const md = buildHandoff(projDir, prevId, { channel });
          if (md) {
            fs.mkdirSync(handoffDir, { recursive: true });
            const stamp = new Date().toISOString().replace(/[-:T]/g, "").slice(0, 13);
            const file = path.join(handoffDir, `${stamp}-${prevId.replace(/^session-/, "").slice(0, 8)}.md`);
            fs.writeFileSync(file, md, "utf8");
            log(`SNAPSHOT prev=${prevId} -> ${file} (${md.length} bytes)`);
          } else {
            log(`SNAPSHOT-SKIP prev=${prevId}（读不到 projcache）`);
          }
          const facts = factsFor(prevId);
          if (facts) {
            upsertSession(state, { ...facts, channel }, { maxSessions });
            log(`CONTEXT-MERGE prev=${prevId} title="${facts.title}"`);
          }
        } catch (e) {
          log(`HANDOFF-FAIL ${e?.message ?? e}`);
        }
        persist(`new-session ${currentId.slice(-12)}`);
      }

      // ② 归档旧会话（等新会话首轮真正完成后再归档）
      archiveOnNewSession(currentId, channel);
    });
  }, { global: true });

  // 清理未触发的定时器（插件卸载 / 进程退出时）
  if (typeof ctx.effect === "function") {
    ctx.effect(() => () => {
      for (const t of timers) clearTimeout(t);
      timers.clear();
      clearInterval(pollTimer);
    }, "im-session-archive: pending refresh timers");
  }
}
