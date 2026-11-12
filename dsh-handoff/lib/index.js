import { defineTool } from "@deepseek-ai/dsh-tools";
import { appendFileSync } from "node:fs";
import { isAbsolute, join, normalize, relative, resolve } from "node:path";
import { mkdir, readFile, readdir, rename, stat, writeFile } from "node:fs/promises";
import Schema from "@deepseek-ai/schemastery";
// src/errors.ts
/** A failure with a stable machine code, safe to surface in a command result. */
var HandoffError = class extends Error {
	code;
	constructor(code, message, options) {
		super(message, options);
		this.code = code;
		this.name = "HandoffError";
	}
};
/** Render any thrown value as a short, user-facing line. */
function describeError(error) {
	if (error instanceof HandoffError) return `${error.code}: ${error.message}`;
	if (error instanceof Error) return error.message;
	return String(error);
}
// src/markdown.ts
function yamlString(value) {
	if (/^[\w./@-]+$/u.test(value)) return value;
	return JSON.stringify(value);
}
/** `2026-10-26 15:36:12 +08:00` — readable, unambiguous, sortable. */
function readableTime(iso) {
	const match = /^(\d{4}-\d{2}-\d{2})T(\d{2}:\d{2}:\d{2})([+-]\d{2}:\d{2})$/u.exec(iso);
	return match === null ? iso : `${match[1]} ${match[2]} ${match[3]}`;
}
/** One line under the title: version, freshness, and the version it replaces. */
function metaLine(meta) {
	const parts = [
		`v${meta.version}`,
		`生成于 ${readableTime(meta.createdAt)}`,
		`会话最后活动 ${readableTime(meta.sessionActivityAt)}`
	];
	if (meta.previous !== void 0 && meta.previous !== "") parts.push(`上一份 \`${meta.previous}\``);
	return `> ${parts.join(" · ")}`;
}
/** Render the complete document: YAML front matter, title, meta line, and model-written body. */
function renderDocument(meta, body) {
	const fields = [
		["title", yamlString(meta.title)],
		["session", yamlString(meta.sessionId)],
		["cwd", yamlString(meta.cwd)],
		["created", yamlString(meta.createdAt)],
		["updated", yamlString(meta.updatedAt)],
		["version", meta.version],
		["session-activity", yamlString(meta.sessionActivityAt)]
	];
	if (meta.previous !== void 0 && meta.previous !== "") fields.push(["previous", yamlString(meta.previous)]);
	fields.push(["provider", yamlString(meta.provider)]);
	fields.push(["model", yamlString(meta.model)]);
	fields.push(["messages", meta.messages]);
	if (meta.focus !== void 0 && meta.focus !== "") fields.push(["focus", yamlString(meta.focus)]);
	fields.push(["generator", yamlString(meta.generator)]);
	return `${[
		"---",
		...fields.map(([key, value]) => `${key}: ${value}`),
		"---"
	].join("\n")}\n\n# 交接文档 · ${meta.title}\n\n${metaLine(meta)}\n\n${body.trim()}\n`;
}
/**
* Render `latest.md` as a pointer rather than a duplicate.
*
* A full copy made "which file is newest" ambiguous (two identical files with
* the same mtime). The pointer states the answer and keeps `latest.md` cheap;
* `/handoff resume` follows it to the real document.
*/
function renderLatestPointer(meta) {
	return `${[
		"---",
		"kind: latest-pointer",
		`latest: ${yamlString(meta.name)}`,
		`version: ${meta.version}`,
		`updated: ${yamlString(meta.updatedAt)}`,
		"---"
	].join("\n")}\n\n${[
		"# 最新交接文档",
		"",
		`最新一份是 \`${meta.name}\`（v${meta.version}，${readableTime(meta.updatedAt)}）。`,
		"",
		"直接打开它；或者在新会话里运行 `/handoff resume`，会自动跟上这里指向的文件。"
	].join("\n")}\n`;
}
/** YAML front matter: `---` line, fields, closing `---`, then the body. */
const FRONT_MATTER = /^---\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/u;
/** A scalar as written by `yamlString`: bare, `"quoted"`, or a plain number. */
function scalar(raw) {
	const value = raw.trim();
	if (value.startsWith("\"") && value.endsWith("\"") && value.length >= 2) try {
		const parsed = JSON.parse(value);
		if (typeof parsed === "string") return parsed;
	} catch {}
	return value;
}
/**
* Split front matter from the body without a YAML dependency.
*
* The generator writes only flat `key: scalar` pairs, so a full parser would be
* dead weight; a document edited by hand with nested YAML keeps the flat fields
* it does have and ignores the rest.
*/
function splitFrontMatter(content) {
	const match = FRONT_MATTER.exec(content);
	if (match === null) return {
		meta: {},
		body: content
	};
	const meta = {};
	for (const line of (match[1] ?? "").split(/\r?\n/u)) {
		const field = /^([A-Za-z][\w-]*):[ \t]*(.*)$/u.exec(line);
		if (field?.[1] !== void 0 && field[2] !== void 0 && field[2].trim() !== "") meta[field[1]] = scalar(field[2]);
	}
	return {
		meta,
		body: content.slice(match[0].length)
	};
}
/** First level-one heading, with the generated `交接文档 · ` prefix removed. */
function headingTitle(body) {
	const match = /^#[ \t]+(.+)$/mu.exec(body);
	if (match?.[1] === void 0) return void 0;
	const text = match[1].trim().replace(/^交接文档\s*[·:：-]\s*/u, "");
	return text === "" ? void 0 : text;
}
/**
* Read the fields the sidebar lists for each document.
*
* Best effort by design: an older or hand-edited file still lists, it just
* carries fewer facts. Nothing here throws.
*/
function parseDocumentSummary(content) {
	const { meta, body } = splitFrontMatter(content);
	const title = meta.title ?? headingTitle(body);
	const version = Number(meta.version);
	const messages = Number(meta.messages);
	const summary = {};
	if (title !== void 0 && title !== "") summary.title = title;
	if (Number.isSafeInteger(version) && version > 0) summary.version = version;
	if (meta.created !== void 0) summary.created = meta.created;
	if (meta.updated !== void 0) summary.updated = meta.updated;
	if (meta["session-activity"] !== void 0) summary.sessionActivityAt = meta["session-activity"];
	if (meta.previous !== void 0) summary.previous = meta.previous;
	if (meta.provider !== void 0) summary.provider = meta.provider;
	if (meta.model !== void 0) summary.model = meta.model;
	if (Number.isSafeInteger(messages) && messages >= 0) summary.messages = messages;
	if (meta.focus !== void 0) summary.focus = meta.focus;
	if (meta.generator !== void 0) summary.generator = meta.generator;
	return summary;
}
/** Read `latest: <name>` out of a pointer document; `undefined` for a legacy full copy. */
function parseLatestPointer(content) {
	const front = /^---\n([\s\S]*?)\n---/u.exec(content);
	if (front === null) return void 0;
	return /^latest:\s*"?([^"\n]+)"?\s*$/mu.exec(front[1] ?? "")?.[1]?.trim();
}
/** Read the `version:` counter out of an existing document. */
function parseDocumentVersion(content) {
	const field = /^version:\s*(\d+)\s*$/mu.exec(content);
	if (field === null) return void 0;
	const value = Number(field[1]);
	return Number.isSafeInteger(value) && value > 0 ? value : void 0;
}
/**
* Clean model output: drop an accidental whole-document fence, a duplicated
* front matter block, or a top-level heading the prompt asked it not to add.
*/
function normalizeBody(raw) {
	let body = raw.trim();
	const fence = /^```[a-zA-Z]*\n([\s\S]*?)\n```$/u.exec(body);
	if (fence?.[1] !== void 0) body = fence[1].trim();
	if (body.startsWith("---\n")) {
		const end = body.indexOf("\n---", 4);
		if (end !== -1) body = body.slice(end + 4).trim();
	}
	body = body.replace(/^# [^\n]*\n+/u, "");
	return body.trim();
}
/** File-name-safe slug that keeps CJK characters. */
function slugify(text, maxChars = 28) {
	const slug = text.normalize("NFKC").toLowerCase().replace(/[^\p{Script=Han}\p{Letter}\p{Number}]+/gu, "-").replace(/^-+|-+$/gu, "").slice(0, maxChars).replace(/-+$/u, "");
	return slug === "" ? "session" : slug;
}
/** `20261025-2140` in the host's local time, sortable as a file name. */
function stamp(date) {
	const pad = (value) => String(value).padStart(2, "0");
	return `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}-${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}`;
}
/** Build the timestamped document file name. */
function documentFileName(prefix, date, slug) {
	return `${slugify(prefix, 24)}-${stamp(date)}-${slug}.md`;
}
/** ISO-ish local timestamp for front matter and prompts. */
function localTimestamp(date) {
	const offset = -date.getTimezoneOffset();
	const sign = offset >= 0 ? "+" : "-";
	const pad = (value) => String(Math.trunc(Math.abs(value))).padStart(2, "0");
	return `${(/* @__PURE__ */ new Date(date.getTime() - date.getTimezoneOffset() * 6e4)).toISOString().slice(0, 19)}${sign}${pad(offset / 60)}:${pad(offset % 60)}`;
}
// src/prompt.ts
/**
* The document contract.
*
* Order is deliberate: the summary comes first so a reader that only sees the
* head of the file (injection is capped, and people skim) still gets the state
* and the next action. Decisions sit above execution detail because the next
* session's most expensive mistake is re-litigating a settled choice.
*/
const SECTIONS_ZH = [
	"## 接手摘要",
	"## 任务与目标",
	"## 已确认的决定",
	"## 当前状态",
	"## 下一步",
	"## 未完成与风险",
	"## 踩过的坑",
	"## 关键文件、命令与环境",
	"## 给下一个会话的开场白"
];
const SECTIONS_EN = [
	"## Handoff summary",
	"## Task and goals",
	"## Decisions already made",
	"## Where things stand",
	"## Next steps",
	"## Open items and risks",
	"## Traps hit and how to avoid them",
	"## Key files, commands, and environment",
	"## Opening message for the next session"
];
const SYSTEM_ZH = `你是 DeepSeek Harness 的交接文档撰写器。用户会给你一段编程会话记录（用户原话、助手的回答、工具调用与结果），有时还会附上一份旧的交接文档。

你的读者是「下一个接手这个任务的 AI 会话」：它没有这段对话的任何记录，只拿到你写的文档，就要能接着干。判断写得好不好的唯一标准是——它读完不需要再问「之前到底发生了什么、为什么这样做、我该从哪开始」。

写作规则：
1. 只写记录能证实的事实。不确定的写「待确认」；有依据的推断标「推测：」并给出依据，不要当成事实。
2. 用户原话里的硬性要求、禁止项、验收标准、偏好要保留原意并尽量引用关键词；后来的消息改变了要求时，写明「最新要求推翻了……」。这一条最容易被漏掉，也最影响接手。
3. 逐字保留路径、命令、版本号、接口/函数名、报错原文和关键数值。不要改写或概括报错。「工具活动」是自动统计的权威清单，写「关键文件、命令与环境」时以它为准，不要写出它没有的路径。
4. 决定要连理由一起写：选了什么、为什么、否掉了什么。下一个人最需要知道「哪条路已经走不通」。
5. 「当前状态」逐条给证据（文件、命令输出、测试名），不要写「基本完成」「差不多了」。
6. 「下一步」按顺序写，每步可执行、带验证方式；第一步要小到可以立刻动手。
7. 「接手摘要」必须能单独使用：在做什么、现在到哪、下一个动作、绝对不能做什么。控制在 200 字内。
8. 不复述对话过程，不写寒暄、情绪和「我们讨论了……」；同一件事只写一次。
9. 提供旧文档时：保留仍然成立的事实与决定，更新状态，删掉已被推翻的结论，不要整段照抄。
10. 总长度控制在 1800 字以内，信息密度优先。
11. 只输出 markdown 正文：不要一级标题，不要 front matter，不要用代码块包住整篇。
12. 严格按下面小节与顺序输出，一个都不能少；确实没有内容时写「（无）」：
${SECTIONS_ZH.join("\n")}
13. 「给下一个会话的开场白」是一段可直接粘贴的话：先读哪些文件、当前状态、第一件事做什么。`;
const SYSTEM_EN = `You write handoff documents for DeepSeek Harness. The user gives you a programming session transcript (the user's own words, assistant replies, tool calls and results), sometimes with a previous handoff document attached.

Your reader is "the next AI session that takes over this work". It has none of this conversation, only your document, and must be able to continue. The only test that matters: after reading it, the reader never has to ask "what happened, why was it done this way, where do I start?".

Rules:
1. State only what the transcript supports. Mark unknowns as "unconfirmed"; label an inference as "inference:" with its evidence instead of presenting it as fact.
2. Preserve the user's hard requirements, prohibitions, acceptance criteria and preferences, quoting their wording where it matters. When a later message changes direction, say so explicitly: "the latest request overrides ...". This is the most commonly missed and most costly detail.
3. Keep paths, commands, versions, API/function names, verbatim error text and key numbers exactly as written. Never paraphrase an error. The "tool activity" digest is the authoritative list of paths and commands; never introduce a path that is not in it.
4. Record decisions with their reasons: what was chosen, why, what was rejected. The next session most needs to know which roads are already closed.
5. "Where things stand" gives evidence per item (files, command output, test names). No "mostly done".
6. "Next steps" is ordered, each step actionable and verifiable; the first step is small enough to start immediately.
7. "Handoff summary" must stand alone: what this is, where it stopped, the next action, and what must not be done. Keep it under 120 words.
8. Do not retell the conversation; no pleasantries, no emotion, no "we discussed"; state each fact once.
9. When a previous document is attached, keep the facts and decisions that still hold, update the state, drop superseded conclusions, and never copy it wholesale.
10. Keep the whole document under 1200 words. Density beats completeness.
11. Output markdown body only: no top-level heading, no front matter, no code fence around the document.
12. Follow these sections in this exact order. Never skip one; write "(none)" when a section genuinely has nothing:
${SECTIONS_EN.join("\n")}
13. "Opening message for the next session" is a ready-to-paste paragraph: which files to read, where things stand, and the first action.`;
function line(label, value) {
	return `- ${label}：${value}`;
}
function lineEn(label, value) {
	return `- ${label}: ${value}`;
}
/** Build the summarizer prompt for one session. */
function buildPrompt(input) {
	const zh = input.language === "zh";
	const system = zh ? SYSTEM_ZH : SYSTEM_EN;
	const meta = zh ? [
		line("工作目录", input.cwd),
		line("会话 ID", input.sessionId),
		line("生成时间", input.createdAt),
		line("模型", input.model),
		line("消息数", input.messageCount),
		line("记录是否被截断", input.truncated ? "是（中间部分已省略）" : "否"),
		line("是否附带旧文档", input.previous === void 0 ? "否" : `是（${input.previous.name}）`)
	] : [
		lineEn("Working directory", input.cwd),
		lineEn("Session", input.sessionId),
		lineEn("Generated at", input.createdAt),
		lineEn("Model", input.model),
		lineEn("Messages", input.messageCount),
		lineEn("Transcript truncated", input.truncated ? "yes (middle omitted)" : "no"),
		lineEn("Previous document attached", input.previous === void 0 ? "no" : `yes (${input.previous.name})`)
	];
	if (input.focus !== "") meta.push(zh ? `- 本次关注点：${input.focus}` : `- Focus for this handoff: ${input.focus}`);
	if (input.extraInstructions !== "") meta.push(zh ? `- 额外要求：${input.extraInstructions}` : `- Extra requirements: ${input.extraInstructions}`);
	const header = zh ? "会话信息" : "Session facts";
	const recordLabel = zh ? "会话记录" : "Session transcript";
	const activity = input.activity ?? "";
	const activityBlock = activity === "" ? "" : zh ? [
		"",
		"工具活动（自动统计，覆盖全部消息、不受截断影响；「关键文件、命令与环境」以它为准，记录里没出现过的路径不要写）：",
		activity
	].join("\n") : [
		"",
		"Tool activity (counted over every message, unaffected by truncation; use it as the source of truth for \"Key files, commands, and environment\", and never invent a path that does not appear):",
		activity
	].join("\n");
	const previousBlock = input.previous === void 0 ? "" : zh ? [
		"",
		`下面是上一份交接文档（${input.previous.name}）。只用于延续：保留仍然成立的事实，更新变化，删掉已经被推翻的结论，不要整段照抄。`,
		"<上一份交接文档>",
		input.previous.content.trimEnd(),
		"</上一份交接文档>"
	].join("\n") : [
		"",
		`Below is the previous handoff (${input.previous.name}). Use it only to continue: keep facts that still hold, update what changed, drop superseded conclusions, and do not copy it wholesale.`,
		"<previous-handoff>",
		input.previous.content.trimEnd(),
		"</previous-handoff>"
	].join("\n");
	const footer = zh ? "请按要求的格式输出交接文档正文。" : "Write the handoff document body in the required format.";
	return {
		system,
		user: `${header}\n${meta.join("\n")}\n${activityBlock}${previousBlock}\n\n<${recordLabel}>\n${input.transcript}\n</${recordLabel}>\n\n${footer}`
	};
}
/** Section headings the model is asked to emit, exported for tests and doc tooling. */
function expectedSections(language) {
	return language === "zh" ? SECTIONS_ZH : SECTIONS_EN;
}
function sectionPattern(title) {
	const escaped = title.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
	return new RegExp(`^#{2,3}[ \\t]*${escaped}[ \\t]*$`, "mu");
}
/**
* Section headings the model failed to emit.
*
* A handoff without its summary is much worse than a slow one: the next
* session reads the top first, and a missing "接手摘要" leaves it without the
* one paragraph that says where to start. The generator retries once when this
* is non-empty.
*/
function missingSections(body, language) {
	return expectedSections(language).map((section) => section.replace(/^##[ \t]*/u, "")).filter((title) => !sectionPattern(title).test(body));
}
/** Ask for the same document again, naming the sections the first attempt skipped. */
function buildRepairPrompt(user, missing, language) {
	const list = missing.map((title) => `## ${title}`).join("\n");
	return `${user}\n\n${language === "zh" ? `你上一版漏掉了下面这些小節：\n${list}\n\n请重新输出完整文档，包含全部小节且顺序不变；不要只输出补充部分，也不要解释。` : `Your previous answer skipped these sections:\n${list}\n\nWrite the complete document again, with every section in order. Do not output only the missing parts and do not explain.`}`;
}
// src/store.ts
const DEFAULT_DIR = ".dsh/handoff";
/** Resolve the configured output directory against the session working directory. */
function resolveOutputDir(cwd, configured) {
	const value = configured.trim() === "" ? DEFAULT_DIR : configured.trim();
	return isAbsolute(value) ? normalize(value) : resolve(cwd, value);
}
/**
* Accept one bare file name, on any platform.
*
* Both separators are rejected explicitly: on POSIX a name like
* `..\escape.md` contains no `/` and would otherwise pass a `basename` check
* while still being a Windows path traversal on the other side.
*/
function assertBareName(name) {
	if (name === "" || name === "." || name === ".." || name.includes("/") || name.includes("\\") || name.includes("\0")) throw new HandoffError("BAD_NAME", `非法的文件名：${name}`);
}
/** Write one document, creating the directory when needed.
*  Write to a temporary file first and rename it into place: a crash or a
*  failed write must never leave a half-written handoff document behind. */
async function writeDocument(dir, name, content) {
	assertBareName(name);
	await mkdir(dir, { recursive: true });
	const target = join(dir, name);
	const temp = target + ".tmp";
	await writeFile(temp, content, "utf8");
	await rename(temp, target);
	return target;
}
/** Newest documents first, without the `latest.md` convenience copy. */
async function listDocuments(dir, limit = 50) {
	let names;
	try {
		names = await readdir(dir);
	} catch (error) {
		if (error.code === "ENOENT") return [];
		throw error;
	}
	const entries = [];
	for (const name of names) {
		if (!name.endsWith(".md") || name === "latest.md" || name.endsWith(".tmp")) continue;
		const path = join(dir, name);
		try {
			const info = await stat(path);
			if (!info.isFile()) continue;
			entries.push({
				name,
				path,
				size: info.size,
				modifiedAt: info.mtimeMs
			});
		} catch {}
	}
	entries.sort((a, b) => b.modifiedAt - a.modifiedAt);
	return entries.slice(0, limit);
}
/**
* List documents with the summary the sidebar renders.
*
* The list is the panel's first paint, so a document whose front matter cannot
* be read must not remove the row: the failure is swallowed and the row keeps
* its name, size, and time.
*/
async function listDocumentSummaries(dir, limit = 50) {
	const entries = await listDocuments(dir, limit);
	return Promise.all(entries.map(async (entry) => {
		try {
			return {
				...entry,
				...parseDocumentSummary(await readFile(entry.path, "utf8"))
			};
		} catch {
			return { ...entry };
		}
	}));
}
/** Read one document by bare file name. */
async function readDocument(dir, name) {
	assertBareName(name);
	return readFile(join(dir, name), "utf8");
}
// src/transcript.ts
const ENTRY_LIMIT = 4e3;
const ENTRY_HEAD = 2600;
const ENTRY_TAIL = 1200;
const CALL_ARGS_LIMIT = 300;
function clip(text, limit = ENTRY_LIMIT) {
	if (text.length <= limit) return text;
	const omitted = text.length - ENTRY_HEAD - ENTRY_TAIL;
	return `${text.slice(0, ENTRY_HEAD)}\n…（此处截断 ${omitted} 字符）…\n${text.slice(text.length - ENTRY_TAIL)}`;
}
/** Single-line clip for one argument value. */
function inline(text, limit) {
	const flat = text.replace(/\s+/gu, " ").trim();
	return flat.length <= limit ? flat : `${flat.slice(0, limit)}…`;
}
/** Flatten content blocks into readable text, skipping images and files. */
function contentText(blocks, includeReasoning) {
	const parts = [];
	for (const block of blocks) if (block.type === "text") parts.push(block.text);
	else if (block.type === "reasoning" && includeReasoning) parts.push(`[思考] ${block.text}`);
	else if (block.type === "image") parts.push("[图片]");
	else if (block.type === "file") parts.push("[文件]");
	return parts.join("\n").trim();
}
/**
* The signal-bearing fields of a tool call, in one line.
*
* Dumping raw JSON spends the budget on `content` bodies that the summarizer
* cannot use, and hides the one thing it can use: which file or command the
* call touched. Known argument names are lifted out; bulk payloads collapse to
* their size so a `write` still says *what* file and *how much* was written.
*/
function argumentsSummary(raw) {
	const text = raw.trim();
	if (text === "") return "";
	let value;
	try {
		value = JSON.parse(text);
	} catch {
		return inline(text, CALL_ARGS_LIMIT);
	}
	if (typeof value !== "object" || value === null || Array.isArray(value)) return inline(text, CALL_ARGS_LIMIT);
	const record = value;
	const parts = [];
	for (const key of [
		"path",
		"file_path",
		"cmd",
		"command",
		"pattern",
		"url",
		"query",
		"name",
		"skill",
		"description",
		"focus"
	]) {
		const hit = record[key];
		if (typeof hit === "string" && hit.trim() !== "") parts.push(`${key}=${inline(hit, 160)}`);
		else if (typeof hit === "number" || typeof hit === "boolean") parts.push(`${key}=${String(hit)}`);
	}
	for (const key of [
		"content",
		"old_string",
		"new_string",
		"text",
		"old_str",
		"new_str"
	]) {
		const hit = record[key];
		if (typeof hit === "string" && hit !== "") parts.push(`${key}(${hit.length}ch)`);
		else if (Array.isArray(hit)) parts.push(`${key}(${hit.length}项)`);
	}
	if (parts.length === 0) return inline(text, CALL_ARGS_LIMIT);
	return inline(parts.join(" "), 400);
}
function toolNameOf(message, names) {
	if (message.role !== "tool") return "tool";
	return names.get(String(message.source.callId)) ?? "tool";
}
/** Collect `callId → tool name` so results can name their call. */
function collectToolNames(messages) {
	const names = /* @__PURE__ */ new Map();
	for (const message of messages) {
		if (message.role !== "assistant") continue;
		for (const block of message.content) if (block.type === "tool-call") names.set(String(block.id), block.name);
	}
	return names;
}
function toEntries(messages, options) {
	const names = collectToolNames(messages);
	const entries = [];
	let turn = 0;
	for (const message of messages) switch (message.role) {
		case "system":
		case "developer": break;
		case "user": {
			const injected = message.source.kind !== "user";
			if (!injected) turn += 1;
			if (injected && !options.includeInjectedContext) break;
			const text = contentText(message.content, options.includeReasoning);
			if (text === "") break;
			entries.push({
				kind: injected ? "context" : "user",
				turn,
				text: clip(text)
			});
			break;
		}
		case "assistant": {
			const text = contentText(message.content, options.includeReasoning);
			if (text !== "") entries.push({
				kind: "assistant",
				turn,
				text: clip(text)
			});
			for (const block of message.content) {
				if (block.type !== "tool-call") continue;
				const summary = argumentsSummary(block.arguments);
				entries.push({
					kind: "tool-call",
					turn,
					callId: String(block.id),
					text: clip(summary === "" ? block.name : `${block.name} ${summary}`, 700)
				});
			}
			break;
		}
		case "tool": {
			if (!options.includeToolResults) break;
			const text = contentText(message.content, false);
			const name = toolNameOf(message, names);
			const label = message.isError === true ? `✗ ${name}` : `← ${name}`;
			entries.push({
				kind: "tool-result",
				turn,
				callId: String(message.source.callId),
				text: clip(`${label} ${text}`, 1200)
			});
			break;
		}
	}
	return entries;
}
function renderEntry(entry) {
	const at = entry.turn === 0 ? "" : ` #${entry.turn}`;
	switch (entry.kind) {
		case "user": return `[用户${at}] ${entry.text}`;
		case "context": return `[上下文${at}] ${entry.text}`;
		case "assistant": return `[助手${at}] ${entry.text}`;
		case "tool-call": return `[调用${at}] ${entry.text}`;
		case "tool-result": return `[结果${at}] ${entry.text}`;
		case "reasoning": return `[思考${at}] ${entry.text}`;
	}
}
/**
* Render the conversation into a compact transcript under a character budget.
*
* The budget keeps the beginning (the task statement) and the newest entries
* (where the work actually is), dropping the middle with an explicit marker so
* the summarizer knows the record is incomplete instead of silently missing it.
*/
function buildTranscript(messages, options) {
	const entries = toEntries(messages, options);
	const budget = Math.max(2e3, options.maxChars);
	const rendered = entries.map(renderEntry);
	const total = rendered.reduce((sum, text) => sum + text.length + 2, 0);
	if (total <= budget) {
		const text = rendered.join("\n\n");
		return {
			text,
			stats: {
				messages: messages.length,
				included: entries.length,
				chars: text.length,
				truncated: false,
				omitted: 0
			}
		};
	}
	const headBudget = Math.floor(budget * .35);
	const tailBudget = Math.max(1e3, budget - headBudget - 240);
	const head = [];
	let headChars = 0;
	for (const text of rendered) {
		if (headChars + text.length + 2 > headBudget) break;
		head.push(text);
		headChars += text.length + 2;
	}
	const tail = [];
	let tailChars = 0;
	for (let index = rendered.length - 1; index >= head.length; index--) {
		const text = rendered[index];
		if (tailChars + text.length + 2 > tailBudget) break;
		tail.unshift(text);
		tailChars += text.length + 2;
	}
	const omitted = entries.length - head.length - tail.length;
	const marker = `…（会话中段省略 ${omitted} 条消息，约 ${Math.max(0, total - headChars - tailChars)} 字符未展示）…`;
	const text = [
		...head,
		marker,
		...tail
	].join("\n\n");
	return {
		text,
		stats: {
			messages: messages.length,
			included: head.length + tail.length,
			chars: text.length,
			truncated: true,
			omitted
		}
	};
}
/** Could not parse a tool call's arguments; the summary simply skips it. */
function parsedArguments(raw) {
	try {
		const value = JSON.parse(raw);
		if (typeof value !== "object" || value === null || Array.isArray(value)) return void 0;
		return value;
	} catch {
		return;
	}
}
function stringArgument(args, keys) {
	if (args === void 0) return "";
	for (const key of keys) {
		const hit = args[key];
		if (typeof hit === "string" && hit.trim() !== "") return hit.trim();
	}
	return "";
}
const EDIT_TOOL = /write|edit|patch|replace/iu;
const READ_TOOL = /^read$|read_file|read_text|notebook_read/iu;
const SHELL_TOOL = /bash|pwsh|shell|terminal|exec/iu;
const SEARCH_TOOL = /grep|glob|search|find/iu;
const WEB_TOOL = /web_fetch|web_search/iu;
function bump(map, key) {
	map.set(key, (map.get(key) ?? 0) + 1);
}
function items(map, limit) {
	return [...map.entries()].slice(0, limit).map(([text, count]) => ({
		text,
		count
	}));
}
/** Collect edited/read files, commands, searches, and failures across the session. */
function summarizeActivity(messages) {
	const edited = /* @__PURE__ */ new Map();
	const read = /* @__PURE__ */ new Map();
	const commands = /* @__PURE__ */ new Map();
	const searches = /* @__PURE__ */ new Map();
	const failures = /* @__PURE__ */ new Map();
	const names = collectToolNames(messages);
	for (const message of messages) {
		if (message.role === "assistant") {
			for (const block of message.content) {
				if (block.type !== "tool-call") continue;
				const args = parsedArguments(block.arguments);
				const path = stringArgument(args, [
					"path",
					"file_path",
					"notebook_path"
				]);
				if (EDIT_TOOL.test(block.name)) {
					if (path !== "") bump(edited, path);
					continue;
				}
				if (READ_TOOL.test(block.name)) {
					if (path !== "") bump(read, path);
					continue;
				}
				if (SHELL_TOOL.test(block.name)) {
					const command = stringArgument(args, ["cmd", "command"]);
					if (command !== "") bump(commands, inline(command.split("\n")[0] ?? "", 90));
					continue;
				}
				if (SEARCH_TOOL.test(block.name)) {
					const pattern = stringArgument(args, ["pattern", "query"]);
					if (pattern !== "") bump(searches, `${block.name} ${inline(pattern, 60)}`);
					continue;
				}
				if (WEB_TOOL.test(block.name)) {
					const target = stringArgument(args, ["url", "query"]);
					if (target !== "") bump(searches, `${block.name} ${inline(target, 60)}`);
				}
			}
			continue;
		}
		if (message.role === "tool" && message.isError === true) {
			const first = contentText(message.content, false).split("\n")[0] ?? "";
			bump(failures, `${toolNameOf(message, names)}: ${inline(first, 80)}`);
		}
	}
	return {
		edited: items(edited, 12),
		read: items(read, 12),
		commands: items(commands, 10),
		searches: items(searches, 6),
		failures: items(failures, 6)
	};
}
function renderItems(list, language) {
	const separator = language === "zh" ? "、" : ", ";
	return list.map((item) => {
		if (item.count <= 1) return item.text;
		return language === "zh" ? `${item.text}（${item.count} 次）` : `${item.text} (${item.count}x)`;
	}).join(separator);
}
/** Render the activity digest as prompt lines; empty when nothing happened. */
function renderActivity(activity, language) {
	const zh = language === "zh";
	const lines = [];
	const add = (label, list) => {
		if (list.length > 0) lines.push(`- ${label}${zh ? "：" : ": "}${renderItems(list, language)}`);
	};
	if (zh) {
		add("修改过", activity.edited);
		add("读过", activity.read);
		add("执行过", activity.commands);
		add("检索过", activity.searches);
		add("失败过", activity.failures);
	} else {
		add("Edited", activity.edited);
		add("Read", activity.read);
		add("Ran", activity.commands);
		add("Searched", activity.searches);
		add("Failed", activity.failures);
	}
	return lines.join("\n");
}
/**
* The user's own messages, in order.
*
* Injected context (skills, workspace notes, plugin notices) also rides in
* user-role messages, but it is not the human's language and must not decide
* the document language or the title. Falls back to every user-role message
* when a session has none of its own.
*/
function humanMessages(messages) {
	const own = messages.filter((message) => message.role === "user" && message.source.kind === "user");
	return own.length > 0 ? own : messages.filter((message) => message.role === "user");
}
/** First non-empty user line — a cheap title anchor, never a substitute for the task section. */
function firstUserLine(messages, maxChars = 60) {
	for (const message of humanMessages(messages)) {
		const text = contentText(message.content, false).replace(/\s+/gu, " ").trim();
		if (text !== "") return text.length > maxChars ? `${text.slice(0, maxChars)}…` : text;
	}
	return "";
}
/** Heuristic for `language: auto`: CJK characters in the user's own words. */
function dominantLanguage(messages) {
	let cjk = 0;
	let latin = 0;
	for (const message of humanMessages(messages)) {
		const text = contentText(message.content, false);
		for (const char of text) if (/\p{Script=Han}/u.test(char)) cjk++;
		else if (/[A-Za-z]/u.test(char)) latin++;
	}
	return cjk >= latin / 3 && cjk > 0 ? "zh" : "en";
}
// src/generate.ts
/** Generator identity recorded in every document. */
const GENERATOR = `dsh-handoff@0.4.0`;
/** Cap on the previous document fed back to the writer: continuity, not a transcript. */
const MAX_PREVIOUS_CHARS = 8e3;
/** How many continuation calls a truncated document gets before it is marked incomplete. */
const MAX_CONTINUATIONS = 2;
/** Ask the writer to resume at the cut point instead of starting over. */
function continuationPrompt(language) {
	return language === "en" ? "Your handoff document was cut off by the output limit. Continue from the exact cut point: output only the remaining markdown, do not repeat what is already written, and do not explain." : "你写的交接文档因为输出上限被截断了。请从断点处继续写：只输出剩下的 markdown，不要重复已经写过的内容，也不要解释。";
}
/** Visible marker so a cut-off document is never mistaken for a finished one. */
function truncationNotice(maxTokens, language) {
	return language === "en" ? `> ⚠️ Incomplete document: the writer hit the output limit (maxOutputTokens=${maxTokens}).` : `> ⚠️ 本文档未写完：模型输出达到上限（maxOutputTokens=${maxTokens}），末尾被截断。`;
}
/**
* Read the document this one supersedes.
*
* A long v1 must not crowd out the conversation itself, so the cap keeps the
* head (summary, task, decisions) and the tail (recent state), which is where
* continuity lives. A missing file simply means this is a fresh start.
*/
async function previousDocument(dir, name) {
	try {
		const raw = await readDocument(dir, name);
		return {
			name,
			content: (raw.length <= MAX_PREVIOUS_CHARS ? raw : `${raw.slice(0, 6500)}\n…（旧文档过长，中间部分省略）…\n${raw.slice(-1500)}`).trimEnd()
		};
	} catch {
		return;
	}
}
/** Next version number and the document it supersedes, from the output directory. */
async function nextVersion(dir) {
	const docs = await listDocuments(dir);
	const previous = docs[0];
	if (previous === void 0) return { version: 1 };
	let version = docs.length + 1;
	try {
		const parsed = parseDocumentVersion(await readDocument(dir, previous.name));
		if (parsed !== void 0) version = parsed + 1;
	} catch {}
	return {
		version,
		previous: previous.name
	};
}
/** When the session last did anything; falls back to the generation instant. */
function sessionActivity(session, fallback) {
	try {
		const events = session.snapshotEvents();
		const time = events[events.length - 1]?.time;
		if (typeof time === "number" && Number.isFinite(time)) return new Date(time);
	} catch {}
	return fallback;
}
/**
* Pick the route for the auxiliary call.
*
* An explicit `provider`/`model` pair wins. Otherwise the newest assistant
* message's own source names the route the conversation is actually using, so
* the handoff is written by the same model the user has been talking to.
*/
function resolveRoute(messages, config) {
	const provider = config.provider.trim();
	const model = config.model.trim();
	if (provider !== "" && model !== "") return {
		provider,
		model
	};
	if (provider !== "" || model !== "") throw new HandoffError("BAD_ROUTE_CONFIG", "provider 与 model 必须同时配置，或都留空以沿用会话模型。");
	for (let index = messages.length - 1; index >= 0; index--) {
		const message = messages[index];
		if (message?.role !== "assistant") continue;
		const source = message.source;
		if (source.provider !== "" && source.model !== "") return {
			provider: source.provider,
			model: source.model
		};
	}
	throw new HandoffError("NO_ROUTE", "这个会话还没有模型回复，无法推断模型；请先在插件配置里填写 provider/model。");
}
/** Collect assistant text from one stream, rejecting every non-success terminal state. */
async function streamText(stream) {
	let text = "";
	let usage;
	let finish;
	for await (const chunk of stream) switch (chunk.type) {
		case "text-delta":
			text += chunk.text;
			break;
		case "usage":
			usage = chunk.usage;
			break;
		case "finish": finish = chunk.reason;
	}
	if (finish === void 0) throw new HandoffError("NO_FINISH", "模型流没有返回结束原因。");
	switch (finish.kind) {
		case "error": throw new HandoffError(finish.failure.code, finish.failure.message);
		case "aborted": throw new HandoffError("ABORTED", "生成被取消。");
		case "tool-calls": throw new HandoffError("TOOL_CALLS", "模型选择了调用工具而不是写文档，请重试。");
	}
	return usage === void 0 ? {
		text,
		finish
	} : {
		text,
		usage,
		finish
	};
}
/**
* Generate one handoff document and write it to disk.
*
* The transcript never leaves the Host except as the summarizer request; the
* conversation itself is untouched (this is an auxiliary call, not a turn).
*/
async function generateHandoff(input) {
	const { ctx, session, config } = input;
	const focus = (input.focus ?? "").trim();
	const messages = session.deriveMessages();
	if (messages.length === 0) throw new HandoffError("EMPTY_SESSION", "当前会话还没有任何消息。");
	const route = resolveRoute(messages, config);
	const language = config.language === "auto" ? dominantLanguage(messages) : config.language;
	const transcript = buildTranscript(messages, {
		maxChars: config.maxInputChars,
		includeToolResults: config.includeToolResults,
		includeInjectedContext: config.includeInjectedContext,
		includeReasoning: config.includeReasoning
	});
	const now = /* @__PURE__ */ new Date();
	const createdAt = localTimestamp(now);
	const cwd = session.header.cwd ?? process.cwd();
	const title = firstUserLine(messages) || (language === "zh" ? "未命名会话" : "Untitled session");
	const dir = resolveOutputDir(cwd, config.outputDir);
	const chain = await nextVersion(dir);
	const previous = chain.previous === void 0 ? void 0 : await previousDocument(dir, chain.previous);
	const prompt = buildPrompt({
		language,
		cwd,
		sessionId: String(session.id),
		createdAt,
		model: `${route.provider}/${route.model}`,
		messageCount: messages.length,
		focus,
		extraInstructions: config.extraInstructions,
		transcript: transcript.text,
		truncated: transcript.stats.truncated,
		activity: renderActivity(summarizeActivity(messages), language),
		...previous === void 0 ? {} : { previous }
	});
	const options = {
		provider: route.provider,
		model: route.model,
		system: prompt.system,
		messages: [{
			role: "user",
			content: [{
				type: "text",
				text: prompt.user
			}]
		}],
		maxTokens: config.maxOutputTokens,
		...input.signal === void 0 ? {} : { signal: input.signal }
	};
	let body = "";
	let usage;
	let finish;
	for (let attempt = 0; attempt < 2; attempt += 1) {
		const streamed = await streamText(ctx.llm.stream(options));
		body = normalizeBody(streamed.text);
		usage = streamed.usage;
		finish = streamed.finish;
		if (body !== "") break;
	}
	if (body === "") throw new HandoffError("EMPTY_DOCUMENT", "模型返回了空文档（已重试 1 次）。");
	for (let round = 0; finish?.kind === "max-tokens" && round < MAX_CONTINUATIONS; round += 1) {
		const continued = await streamText(ctx.llm.stream({
			...options,
			messages: [{
				role: "user",
				content: [{
					type: "text",
					text: `${continuationPrompt(language)}\n\n${body}`
				}]
			}]
		}));
		const extra = normalizeBody(continued.text);
		finish = continued.finish;
		if (extra === "") break;
		body = `${body}\n${extra}`;
		usage = continued.usage ?? usage;
	}
	const cutOff = finish?.kind === "max-tokens";
	const missing = cutOff ? [] : missingSections(body, language);
	if (missing.length > 0) {
		const retryUser = buildRepairPrompt(prompt.user, missing, language);
		const second = await streamText(ctx.llm.stream({
			...options,
			messages: [{
				role: "user",
				content: [{
					type: "text",
					text: retryUser
				}]
			}]
		}));
		const candidate = normalizeBody(second.text);
		if (candidate !== "" && missingSections(candidate, language).length < missing.length) {
			body = candidate;
			usage = second.usage;
		}
	}
	const activity = sessionActivity(session, now);
	const finalBody = cutOff ? `${body}\n\n${truncationNotice(config.maxOutputTokens, language)}` : body;
	const markdown = renderDocument({
		title,
		sessionId: String(session.id),
		cwd,
		createdAt,
		updatedAt: createdAt,
		version: chain.version,
		...chain.previous === void 0 ? {} : { previous: chain.previous },
		sessionActivityAt: localTimestamp(activity),
		provider: route.provider,
		model: route.model,
		messages: messages.length,
		...focus === "" ? {} : { focus },
		generator: GENERATOR
	}, finalBody);
	const fileName = documentFileName(config.filenamePrefix, now, slugify(focus === "" ? title : focus));
	const path = await writeDocument(dir, fileName, markdown);
	if (config.writeLatest) await writeDocument(dir, "latest.md", renderLatestPointer({
		name: fileName,
		version: chain.version,
		updatedAt: createdAt
	}));
	return {
		path,
		relativePath: relative(cwd, path).split("\\").join("/"),
		markdown,
		route,
		version: chain.version,
		stats: transcript.stats,
		cutOff,
		...usage === void 0 ? {} : { usage }
	};
}
// src/auto.ts
/** Decide whether this boundary should produce a document. */
function autoDecision(input) {
	if (!input.enabled) return {
		generate: false,
		reason: "disabled"
	};
	if (input.inflight) return {
		generate: false,
		reason: "inflight"
	};
	const minGap = Math.max(0, input.minMinutes) * 6e4;
	if (input.lastWriteAt > 0 && input.now - input.lastWriteAt < minGap) return {
		generate: false,
		reason: "too-soon"
	};
	if (input.eventType === "compaction/start") return {
		generate: true,
		reason: "compaction"
	};
	if (input.eventType === "turn/end") {
		const every = Math.max(1, Math.floor(input.everyTurns));
		if (input.turns - input.lastTurnAt >= every) return {
			generate: true,
			reason: "turn-interval"
		};
		return {
			generate: false,
			reason: "below-turn-interval"
		};
	}
	return {
		generate: false,
		reason: "irrelevant-event"
	};
}
/** Directory that holds the automatic log beside the documents. */
function autoLogPath(cwd, config) {
	return join(resolveOutputDir(cwd, config.outputDir), "auto.log");
}
/** Append one diagnostic line; logging must never break the hook. */
function appendAutoLog(cwd, config, line) {
	try {
		appendFileSync(autoLogPath(cwd, config), `[${(/* @__PURE__ */ new Date()).toISOString()}] ${line}\n`, "utf8");
	} catch {}
}
/** Read the current turn number out of a `turn/end` payload. */
function turnNumberOf(event) {
	if (event?.type !== "turn/end") return void 0;
	const data = event.data;
	const turn = Number(data?.turn);
	return Number.isFinite(turn) ? turn : void 0;
}
/**
* Wire the automatic hook. Called from `apply()`; does nothing when
* `autoGenerate` is off, so a profile can keep the plugin manual-only.
*/
function attachAutoHandoff(ctx, config) {
	if (!config.autoGenerate) return;
	const states = /* @__PURE__ */ new Map();
	const stateOf = (id) => {
		let state = states.get(id);
		if (state === void 0) {
			state = {
				turns: 0,
				lastTurnAt: 0,
				lastWriteAt: 0,
				inflight: false,
				failures: 0
			};
			states.set(id, state);
		}
		return state;
	};
	ctx.effect(() => ctx.on("session/event", (session, event) => {
		const header = session.header;
		if (header.origin === "subagent") return;
		const id = String(session.id);
		const state = stateOf(id);
		const turn = turnNumberOf(event);
		if (turn !== void 0) state.turns = Math.max(state.turns, turn);
		const now = Date.now();
		const decision = autoDecision({
			enabled: config.autoGenerate,
			inflight: state.inflight,
			eventType: event.type,
			turns: state.turns,
			lastTurnAt: state.lastTurnAt,
			lastWriteAt: state.lastWriteAt,
			now,
			everyTurns: config.autoEveryTurns,
			minMinutes: config.autoMinMinutes
		});
		if (!decision.generate) return;
		const cwd = header.cwd ?? process.cwd();
		state.inflight = true;
		(async () => {
			try {
				const result = await generateHandoff({
					ctx,
					session,
					config
				});
				state.lastWriteAt = Date.now();
				state.lastTurnAt = state.turns;
				appendAutoLog(cwd, config, `generated ${result.relativePath} v${result.version} (${result.stats.messages} msgs, ${result.stats.chars} chars) via ${event.type}/${decision.reason}`);
			} catch (error) {
				state.failures += 1;
				appendAutoLog(cwd, config, `failed via ${event.type}/${decision.reason}: ${describeError(error)}`);
			} finally {
				state.inflight = false;
			}
		})();
	}), "dsh-handoff: automatic handoff hook");
}
// src/config.ts
/**
* Plain configuration. These are ordinary profile-entry values: a change is
* saved to the profile patch and takes effect on the next mount, which is the
* right granularity for a batch job like this one. (`volatile()` is for config
* references and would turn every value into a reference object.)
*/
const Config = Schema.object({
	outputDir: Schema.string().default(".dsh/handoff").description("生成目录，相对于会话工作目录。"),
	filenamePrefix: Schema.string().default("handoff").description("文件名前缀，例如 handoff-20261025-2140-xxx.md。"),
	writeLatest: Schema.boolean().default(true).description("同时写一份 latest.md，方便下一个会话直接读取。"),
	provider: Schema.string().default("").description("模型 provider；与 model 同时填写才生效，否则沿用会话当前模型。"),
	model: Schema.string().default("").description("模型 id；与 provider 同时填写才生效。"),
	maxInputChars: Schema.number().default(48e3).min(4e3).description("会话记录的字符预算，超出时省略中间部分。"),
	maxOutputTokens: Schema.number().default(4096).min(512).description("生成交接文档的输出 token 上限。"),
	includeToolResults: Schema.boolean().default(true).description("把工具结果写入会话记录（整段截断）。"),
	includeInjectedContext: Schema.boolean().default(false).description("把宿主注入的上下文（技能目录、工作区说明等）也写进记录；默认排除，避免挤占预算。"),
	includeReasoning: Schema.boolean().default(false).description("把助手的思考过程写入会话记录。"),
	language: Schema.union([
		"auto",
		"zh",
		"en"
	]).default("auto").description("文档语言：auto 跟随对话，或固定中文 / 英文。"),
	extraInstructions: Schema.string().default("").description("追加到总结提示词的额外要求。"),
	autoGenerate: Schema.boolean().default(true).description("自动生成交接文档：上下文压缩前、以及每 N 个回合各写一份；关掉就只剩手动 /handoff。"),
	autoEveryTurns: Schema.number().default(5).min(1).description("每完成多少个回合写一份自动交接文档。"),
	autoMinMinutes: Schema.number().default(30).min(0).description("同一会话两份自动文档之间的最小间隔（分钟）。")
});
// src/resume.ts
/** Injected context is bounded: a handoff is a brief, not a transcript. */
const MAX_INJECTED_CHARS = 3e4;
/**
* Load the document a new session should continue from.
*
* `latest.md` wins because it is the file the generator maintains for exactly
* this purpose; a directory that only has timestamped files falls back to the
* newest one. An explicit name is used verbatim (and must be a bare file name).
*/
async function loadHandoffForResume(session, config, requested) {
	const dir = resolveOutputDir(session.header.cwd ?? process.cwd(), config.outputDir);
	const name = await pickDocument(dir, requested);
	const raw = await readDocument(dir, name);
	const truncated = raw.length > MAX_INJECTED_CHARS;
	const content = truncated ? `${raw.slice(0, MAX_INJECTED_CHARS)}\n\n…（文档超过 ${MAX_INJECTED_CHARS} 字符，以上为前半部分）…` : raw;
	const { meta } = splitFrontMatter(raw);
	return {
		name,
		content,
		truncated,
		...session.header.cwd === void 0 ? {} : { cwd: session.header.cwd },
		...meta.created === void 0 ? {} : { createdAt: meta.created }
	};
}
async function pickDocument(dir, requested) {
	if (requested !== "" && requested !== "latest.md") return requested;
	const latest = await latestTarget(dir);
	if (latest !== void 0) return latest;
	const newest = (await listDocuments(dir))[0];
	if (newest === void 0) throw new HandoffError("NO_DOCUMENT", `还没有交接文档（目录 ${dir}）。先运行 /handoff 生成一份。`);
	return newest.name;
}
/**
* Resolve `latest.md` to the document it names.
*
* Current builds write a pointer; older builds wrote a full copy. The copy is
* still a valid document, so it is returned as-is (`latest.md` itself), and a
* pointer that names a missing file reports the break instead of injecting the
* pointer text as if it were a handoff.
*/
async function latestTarget(dir) {
	let content;
	try {
		content = await readDocument(dir, "latest.md");
	} catch {
		return;
	}
	const target = parseLatestPointer(content);
	if (target === void 0) return "latest.md";
	try {
		await readDocument(dir, target);
	} catch {
		throw new HandoffError("BROKEN_POINTER", `latest.md 指向的 ${target} 不存在，改用 /handoff resume <文件名>。`);
	}
	return target;
}
/** Frame the document as model-facing context rather than a bare dump. */
function frameForInjection(result) {
	const where = [result.createdAt === void 0 ? "" : `生成于 ${result.createdAt}`, result.cwd === void 0 ? "" : `工作目录 ${result.cwd}`].filter((part) => part !== "").join(" · ");
	const tail = result.truncated ? "\n\n（文档已截断，需要时可以读取原文件补全。）" : "";
	return [
		`以下是上一个会话留下的交接文档：${result.name}${where === "" ? "" : `（${where}）`}。`,
		"把它当作当前任务的既有上下文，而不是一条新的用户请求。动手前先按它对齐状态：",
		"- 从「接手摘要」「当前状态」「下一步」读起，那就是默认的继续点；",
		"- 已经确认的决定不要重新讨论，也不要顺手扩大范围；",
		"- 文档与工作区不一致时，以工作区为准，并把差异说出来；",
		"- 需要用户拍板的问题直接问，不要替用户猜。",
		"",
		"<handoff>",
		result.content.trimEnd(),
		"</handoff>",
		tail
	].join("\n");
}
// src/routes.ts
/**
* URL prefix of this plugin's small HTTP surface.
*
* Exact routes live under the Host's `/api` channel: the Connection registry
* validates every path against it and refuses anything outside.
*/
const PREFIX = "/api/dsh-handoff";
/** JSON envelope every route answers with, matching the Host's own style. */
function ok(value) {
	return Response.json({
		ok: true,
		value
	}, { headers: { "cache-control": "no-store" } });
}
function fail(code, message) {
	return Response.json({
		ok: false,
		error: {
			code,
			message
		}
	}, { headers: { "cache-control": "no-store" } });
}
/** Read one required string field from a JSON body. */
async function bodyOf(request) {
	try {
		const value = await request.json();
		if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error("not an object");
		return value;
	} catch {
		throw new HandoffError("BAD_REQUEST", "请求体不是 JSON 对象。");
	}
}
/** Read the live-agent registry, tolerating a host that does not provide it. */
function agentsOf(ctx) {
	try {
		return ctx.get("agents") ?? void 0;
	} catch {
		return;
	}
}
/** Translate a missing document into the stable route code instead of `ENOENT`. */
async function loadForAttach(session, config, name) {
	if (name === "") throw new HandoffError("BAD_NAME", "缺少文件名。");
	try {
		return await loadHandoffForResume(session, config, name);
	} catch (error) {
		if (error.code === "ENOENT") throw new HandoffError("NO_DOCUMENT", `目标会话的目录下没有 ${name}，换一个会话或重新生成一份。`);
		throw error;
	}
}
/**
* Mount the panel's HTTP surface.
*
* Every route is an exact Host route: the request carries the browser's
* authenticated cookie, so nothing here is readable from another origin.
*/
function mountRoutes(ctx, config) {
	ctx.inject(["connection", "sessions"], (scoped) => {
		const connection = scoped.get("connection");
		if (connection === void 0) return;
		const current = connection.registerFetchRoute;
		const legacy = connection.fetch?.register;
		const sessions = scoped.sessions;
		const sessionOf = (id) => {
			if (id === "") throw new HandoffError("BAD_REQUEST", "缺少 sessionId。");
			const session = sessions.get(id);
			if (session === void 0) throw new HandoffError("NO_SESSION", `找不到会话 ${id}（只列出当前进程里活着的会话）。`);
			return session;
		};
		const outputDirOf = (session) => resolveOutputDir(session.header.cwd ?? process.cwd(), config.outputDir);
		const route = (path, methods, handler, label) => {
			const exact = {
				path: `${PREFIX}${path}`,
				methods,
				requestBody: "buffered",
				fetch: handler
			};
			if (typeof current === "function") {
				current.call(connection, scoped, exact);
				return;
			}
			if (typeof legacy === "function") scoped.effect(() => legacy.call(connection.fetch, exact), label);
		};
		route("/config", ["GET"], async () => {
			return ok({ config });
		}, "dsh-handoff: config route");
		route("/sessions", ["GET"], async () => {
			return ok({ sessions: sessions.list().map((session) => {
				try {
					const messages = session.deriveMessages();
					return {
						id: String(session.id),
						cwd: session.header.cwd ?? "",
						title: firstUserLine(messages) || String(session.id),
						messages: messages.length
					};
				} catch {
					return {
						id: String(session.id),
						cwd: session.header.cwd ?? "",
						title: String(session.id),
						messages: 0
					};
				}
			}) });
		}, "dsh-handoff: sessions route");
		route("/docs", ["GET"], async (request) => {
			try {
				const url = new URL(request.url);
				const session = sessionOf(url.searchParams.get("sessionId") ?? "");
				const dir = outputDirOf(session);
				return ok({
					dir,
					docs: await listDocumentSummaries(dir)
				});
			} catch (error) {
				return errorResponse(error);
			}
		}, "dsh-handoff: docs route");
		route("/doc", ["GET"], async (request) => {
			try {
				const url = new URL(request.url);
				const session = sessionOf(url.searchParams.get("sessionId") ?? "");
				const name = url.searchParams.get("name") ?? "";
				return ok({
					name,
					content: await readDocument(outputDirOf(session), name)
				});
			} catch (error) {
				return errorResponse(error);
			}
		}, "dsh-handoff: doc route");
		route("/generate", ["POST"], async (request) => {
			try {
				const body = await bodyOf(request);
				const sessionId = typeof body.sessionId === "string" ? body.sessionId : "";
				const focus = typeof body.focus === "string" ? body.focus.trim() : "";
				const result = await generateHandoff({
					ctx: scoped,
					session: sessionOf(sessionId),
					config,
					focus
				});
				return ok({
					path: result.relativePath,
					version: result.version,
					messages: result.stats.messages,
					chars: result.stats.chars,
					model: `${result.route.provider}/${result.route.model}`,
					truncated: result.stats.truncated
				});
			} catch (error) {
				return errorResponse(error);
			}
		}, "dsh-handoff: generate route");
		route("/attach", ["POST"], async (request) => {
			try {
				const body = await bodyOf(request);
				const sessionId = typeof body.sessionId === "string" ? body.sessionId : "";
				const name = typeof body.name === "string" ? body.name : "";
				const resumed = await loadForAttach(sessionOf(sessionId), config, name);
				const agent = agentsOf(scoped)?.get?.(sessionId);
				if (agent === void 0 || typeof agent.inject !== "function") throw new HandoffError("NO_AGENT", "这个会话当前没有活动实例，请先给它发一条消息激活。");
				await agent.inject({
					content: [{
						type: "text",
						text: frameForInjection(resumed)
					}],
					source: { kind: "dsh-handoff" }
				});
				return ok({
					name: resumed.name,
					chars: resumed.content.length,
					truncated: resumed.truncated
				});
			} catch (error) {
				return errorResponse(error);
			}
		}, "dsh-handoff: attach route");
	});
}
/** Map a thrown value onto the shared JSON envelope. */
function errorResponse(error) {
	if (error instanceof HandoffError) return fail(error.code, error.message);
	if (error instanceof Error) return fail("INTERNAL", error.message);
	return fail("INTERNAL", String(error));
}
// src/index.ts
const name = "dsh-handoff";
/**
* The tool and the command both need the model service; commands are optional.
*
* `agents` backs the panel's "接续到会话" button: it is the live-agent registry
* (`get(sessionId)`, `create`, `resume`) that /attach injects through. Hosts on
* the 0.2.1 line always provide it; the route itself still treats a missing
* service as `NO_AGENT` instead of assuming the registry is there.
*/
const inject = [
	"tools",
	"llm",
	"agents"
];
const TOOL_DESCRIPTION = [
	"把当前会话整理成一份交接文档（markdown），写给「下一个接手这个任务的会话」：任务是什么、已完成什么、",
	"当前进展、下一步、未完成项与风险、踩过的坑、关键文件与命令，以及一段可直接粘贴的开场白。",
	"文档写入会话工作目录下的 .dsh/handoff/（可在插件设置中改）。",
	"适用场景：用户要求交接/总结现状/收尾；或上下文即将耗尽而任务未完成，需要新会话继续。",
	"不要用它代替普通回答，也不要在用户没有要求、任务也还不需要交接时调用。"
].join("");
/** Trim a markdown body to a short tool-result preview. */
function previewOf(markdown, limit = 240) {
	const text = markdown.replace(/^---\n[\s\S]*?\n---\n/u, "").replace(/^# [^\n]*\n+/u, "").trim().replace(/\s+/gu, " ");
	return text.length > limit ? `${text.slice(0, limit)}…` : text;
}
/** Build the summarizer tool bound to this plugin instance's configuration. */
function createTool(ctx, config) {
	return defineTool({
		name: "handoff",
		description: TOOL_DESCRIPTION,
		parameters: { focus: {
			type: "string",
			description: "这次交接要特别强调的点，例如「重点写测试与未修完的 bug」；可省略。"
		} },
		output: {
			schema: {
				type: "object",
				additionalProperties: false,
				properties: {
					path: {
						type: "string",
						required: true
					},
					version: {
						type: "integer",
						required: true
					},
					messages: {
						type: "integer",
						required: true
					},
					chars: {
						type: "integer",
						required: true
					},
					model: {
						type: "string",
						required: true
					},
					truncated: {
						type: "boolean",
						required: true
					},
					preview: {
						type: "string",
						required: true
					}
				}
			},
			render(_args, value) {
				const truncated = value.truncated ? "，记录中段已省略" : "";
				return [{
					type: "text",
					text: `交接文档已写入 ${value.path}（v${value.version}，${value.messages} 条消息，${value.chars} 字符记录${truncated}，模型 ${value.model}）。\n\n预览：${value.preview}`
				}];
			}
		},
		async execute(args, exec) {
			const agent = exec.agent;
			if (agent === void 0) throw new HandoffError("NO_AGENT", "这个工具必须在一个会话里运行。");
			const result = await generateHandoff({
				ctx,
				session: agent.session,
				config,
				focus: args.focus?.trim() ?? "",
				signal: exec.signal
			});
			return {
				path: result.relativePath,
				version: result.version,
				messages: result.stats.messages,
				chars: result.stats.chars,
				model: `${result.route.provider}/${result.route.model}`,
				truncated: result.stats.truncated,
				preview: previewOf(result.markdown)
			};
		}
	});
}
/** Inject the chosen handoff document into the session as model-facing context. */
async function resumeIntoSession(invocation, requested, config) {
	try {
		const resumed = await loadHandoffForResume(invocation.agent.session, config, requested);
		const agent = invocation.agent;
		if (typeof agent.inject !== "function") return {
			kind: "error",
			text: "当前宿主不支持向会话注入上下文，无法接续。"
		};
		await agent.inject({
			content: [{
				type: "text",
				text: frameForInjection(resumed)
			}],
			source: { kind: "dsh-handoff" }
		});
		const size = resumed.content.length;
		return {
			kind: "success",
			text: `已把 ${resumed.name} 注入当前会话（${size} 字符${resumed.truncated ? "，已截断" : ""}）。模型在下一步就会读到它。`
		};
	} catch (error) {
		return {
			kind: "error",
			text: `接续失败：${describeError(error)}`
		};
	}
}
/**
* Register the handoff tool, and the `/handoff` command when the composition
* provides a command surface (the Web client does; headless runs do not).
*/
function apply(ctx, config) {
	ctx.effect(() => ctx.tools.register(createTool(ctx, config)), "dsh-handoff: handoff tool");
	mountRoutes(ctx, config);
	attachAutoHandoff(ctx, config);
	ctx.inject(["commands"], (commandCtx) => {
		commandCtx.effect(() => commandCtx.commands.register({
			name: "handoff",
			description: "生成或接续交接文档：/handoff [关注点] 生成，/handoff resume [文件名] 注入当前会话",
			input: { hint: "[关注点] 或 resume [文件名]" },
			async handler(invocation) {
				const raw = invocation.rawInput.trim();
				if (raw === "resume" || raw.startsWith("resume ")) return resumeIntoSession(invocation, raw.slice(6).trim(), config);
				try {
					const result = await generateHandoff({
						ctx,
						session: invocation.agent.session,
						config,
						focus: raw,
						signal: invocation.signal
					});
					const parts = [`交接文档已生成：${result.relativePath}`, `（v${result.version}，${result.stats.messages} 条消息，${result.stats.chars} 字符记录，模型 ${result.route.provider}/${result.route.model}）`];
					if (result.stats.truncated) parts.push("，会话中段因超出预算已省略");
					return {
						kind: "success",
						text: parts.join("")
					};
				} catch (error) {
					return {
						kind: "error",
						text: `交接文档生成失败：${describeError(error)}`
					};
				}
			}
		}), "dsh-handoff: /handoff command");
	});
}
export { Config, apply, inject, name };
