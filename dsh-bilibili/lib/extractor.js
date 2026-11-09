/**
 * Bilibili video extraction: metadata, transcript, comments, danmaku,
 * and subtitle-driven keyframes. One module failure never fails the rest
 * (each channel returns an empty result with a note). HTTP goes through
 * the global fetch with 412 backoff; frames go through the ffmpeg binary.
 *
 * @module dsh-bilibili/extractor
 */

import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, open, readdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { formatTime, selectKeyframeTimestamps } from "./keyframes.js";

const API_BASE = "https://api.bilibili.com";
const REFERER = "https://www.bilibili.com/";
const USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 " +
  "(KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";
const REQUEST_TIMEOUT_MS = 15000;
const FRAME_TIMEOUT_MS = 20000;
const SCENE_TIMEOUT_MS = 180000;
const SCENE_DETECT_MAX_SECONDS = 1200; // beyond 20 minutes: switch to sampled scene detection
const SCENE_ALIGN_THRESHOLD = 0.15; // window alignment uses a sensitive threshold (catches fades; low risk within +-4s)
const SHARP_HALF_WINDOW = 1.5; // sharp-frame refinement looks within +-1.5s around the target time
const SCENE_SAMPLED_STEP_FRAMES = 60; // sampled pass decodes 1 frame per 60 (~2s @ 30fps)
const SCENE_PEAK_MIN_GAP = 5;
const VIDEO_CACHE_TTL_MS = 24 * 3600 * 1000;
const TRANSCRIPT_CACHE_TTL_MS = 7 * 24 * 3600 * 1000; // 文稿小且不变，缓存 7 天
// 字幕错配守卫：字幕末段 > 视频时长 * 1.5 + 60s 视为「挂错视频的字幕」
const SUBTITLE_DURATION_FACTOR = 1.5;
const SUBTITLE_DURATION_SLACK_SECONDS = 60;
const MAX_RETRIES = 2;
const AUDIO_CAP_BYTES = 200 * 1048576; // whisper-local 音频下载上限（DASH 纯音频远小于视频）
const AUDIO_CONVERT_TIMEOUT_MS = 180000; // 整段音频转 16kHz WAV（长视频需要数十秒）
const FRAME_CONCURRENCY = clampEnv("DSH_BILIBILI_FRAME_CONCURRENCY", 3, 1, 8); // 抓帧并发：每帧一个 ffmpeg 进程
const VISION_CONCURRENCY = clampEnv("DSH_BILIBILI_VISION_CONCURRENCY", 2, 1, 4); // 视觉描述并发（本地 Ollama 并行收益有限）

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** Combine the caller's abort signal with a per-request timeout. */
function requestSignal(signal, ms) {
  if (signal === undefined || signal === null) return AbortSignal.timeout(ms);
  return AbortSignal.any([signal, AbortSignal.timeout(ms)]);
}

/** Minimal XML entity decode for danmaku text. */
function decodeXml(text) {
  return String(text)
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '\"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, "&")
    .replace(/&#(\d+);/g, (_m, code) => {
      try { return String.fromCodePoint(Number(code)); } catch { return ""; }
    });
}

/** Extract a BV id from a URL or a bare BV id. */
export function parseBvid(url) {
  const text = String(url ?? "").trim();
  const bare = /^(BV[0-9A-Za-z]{10})$/.exec(text);
  if (bare) return bare[1];
  const match = /bilibili\.com\/video\/(BV[0-9A-Za-z]{10})/.exec(text);
  return match ? match[1] : undefined;
}

async function apiGet(session, endpoint, params) {
  const target = new URL(API_BASE + endpoint);
  if (params) {
    for (const [key, value] of Object.entries(params)) {
      if (value !== undefined && value !== null) target.searchParams.set(key, String(value));
    }
  }
  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    let resp;
    try {
      resp = await fetch(target, {
        headers: session.headers,
        signal: requestSignal(session.signal, REQUEST_TIMEOUT_MS),
      });
    } catch (error) {
      if (session.signal?.aborted) throw error; // caller cancelled
      if (attempt < MAX_RETRIES) { await sleep(2 ** (attempt + 1) * 1000); continue; }
      return { code: -1, message: "request failed: " + (error?.message ?? error) };
    }
    if (resp.status === 412 && attempt < MAX_RETRIES) {
      await sleep(2 ** (attempt + 1) * 1000);
      continue;
    }
    if (!resp.ok) return { code: -1, message: "HTTP " + resp.status };
    try { return await resp.json(); } catch {
      return { code: -1, message: "invalid json response" };
    }
  }
  return { code: -1, message: "max retries exceeded" };
}

async function resolveShortLink(session, url) {
  try {
    const resp = await fetch(url, {
      headers: session.headers,
      redirect: "follow",
      signal: requestSignal(session.signal, REQUEST_TIMEOUT_MS),
    });
    const match = /(BV[0-9A-Za-z]{10})/.exec(resp.url);
    return match ? match[1] : undefined;
  } catch {
    return undefined;
  }
}

async function getVideoInfo(session, bvid) {
  const data = await apiGet(session, "/x/web-interface/view", { bvid });
  if (data.code !== 0) throw new Error("video info failed: " + (data.message ?? "unknown"));
  const d = data.data ?? {};
  const stat = d.stat ?? {};
  return {
    title: d.title ?? "",
    description: d.desc ?? "",
    uploader: {
      name: d.owner?.name ?? "",
      mid: d.owner?.mid ?? 0,
      face: d.owner?.face ?? "",
    },
    duration: d.duration ?? 0,
    pubdate: d.pubdate ?? 0,
    cover: d.pic ?? "",
    category: d.tname ?? "",
    pages: Array.isArray(d.pages) ? d.pages.length : 1,
    cid: d.cid ?? 0,
    aid: d.aid ?? 0,
    stats: {
      views: stat.view ?? 0,
      likes: stat.like ?? 0,
      coins: stat.coin ?? 0,
      favorites: stat.favorite ?? 0,
      shares: stat.share ?? 0,
      comments: stat.reply ?? 0,
      danmaku: stat.danmaku ?? 0,
    },
  };
}

const emptySubtitle = (note) => ({ source: "none", text: "", segments: [], total_segments: 0, note });

/** Parse a downloaded Bilibili subtitle JSON body into segments + joined text. */
export function parseSubtitleBody(body) {
  const segments = [];
  const parts = [];
  for (const item of body?.body ?? []) {
    const text = String(item.content ?? "").trim();
    if (!text) continue;
    segments.push({ start: item.from ?? 0, end: item.to ?? 0, text });
    parts.push(text);
  }
  return { segments, text: parts.join("\n") };
}

/** whisper.cpp 三档模型：档位别名 → ggml 模型名（低/中/高 适配不同配置）。 */
const WHISPER_TIERS = {
  low: "small",
  small: "small",
  medium: "medium",
  high: "large-v3",
  large: "large-v3",
  "large-v3": "large-v3",
};

/** Parse whisper.cpp "HH:MM:SS,mmm" / "MM:SS,mmm" into seconds. */
export function parseWhisperTime(text) {
  const s = String(text ?? "").trim();
  const m = /(?:(\d+):)?(\d{1,2}):(\d{1,2})(?:[.,](\d{1,3}))?/.exec(s);
  if (!m) return undefined;
  const hours = m[1] ? Number(m[1]) : 0;
  const total = hours * 3600 + Number(m[2]) * 60 + Number(m[3]) + (m[4] ? Number(m[4]) / 1000 : 0);
  return Number.isFinite(total) ? total : undefined;
}

/** Parse whisper.cpp -oj JSON into {start,end,text} segments (seconds). */
export function parseWhisperJson(json) {
  const transcription = json?.transcription ?? (Array.isArray(json) ? json : []);
  const segments = [];
  for (const item of transcription) {
    const text = String(item?.text ?? item?.timestamps?.text ?? "").trim();
    if (!text) continue;
    let start;
    let end;
    const offFrom = Number(item?.offsets?.from);
    const offTo = Number(item?.offsets?.to);
    if (Number.isFinite(offFrom) && Number.isFinite(offTo)) {
      start = offFrom / 1000;
      end = offTo / 1000;
    } else {
      start = parseWhisperTime(item?.timestamps?.from);
      end = parseWhisperTime(item?.timestamps?.to);
    }
    if (!Number.isFinite(start) || !Number.isFinite(end)) continue;
    segments.push({ start, end, text });
  }
  return segments;
}

/**
 * Resolve the whisper.cpp GGML model path. A tier keyword (small/medium/large-v3,
 * or the low/medium/high aliases) resolves to ggml-<tier>.bin in the model dir;
 * a path (contains a separator) or a *.bin filename is used verbatim.
 */
export function resolveWhisperModel(whisperModel, whisperModelDir, whisperBin) {
  const model = String(whisperModel ?? "").trim();
  if (!model) return undefined;
  if (model.includes("/") || model.includes("\\") || /\.bin$/i.test(model)) return model;
  const tier = WHISPER_TIERS[model.toLowerCase()] ?? model.toLowerCase();
  let dir = String(whisperModelDir ?? "").trim();
  if (!dir) {
    if (whisperBin && (String(whisperBin).includes("/") || String(whisperBin).includes("\\"))) {
      dir = join(dirname(String(whisperBin)), "models");
    } else {
      dir = "models";
    }
  }
  return join(dir, "ggml-" + tier + ".bin");
}

const SHERPA_TS_RE = /^(?:\[)?(\d{1,2}:\d{2}:\d{2}(?:[.,]\d{1,3})?)\s*(?:-->|->|→|-)\s*(\d{1,2}:\d{2}:\d{2}(?:[.,]\d{1,3})?)(?:\])?\s*:?\s*(.*)$/;

/** Parse sherpa-onnx-offline stdout into {start,end,text} segments (seconds). */
export function parseSherpaText(text) {
  const lines = String(text ?? "").split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  const segments = [];
  for (const line of lines) {
    const m = SHERPA_TS_RE.exec(line);
    if (!m) continue;
    const start = parseWhisperTime(m[1]);
    const end = parseWhisperTime(m[2]);
    const segText = (m[3] ?? "").trim();
    if (!Number.isFinite(start) || !Number.isFinite(end) || !segText) continue;
    segments.push({ start, end, text: segText });
  }
  if (segments.length === 0) {
    const joined = lines.join(" ").trim();
    if (joined) segments.push({ start: 0, end: 0, text: joined });
  }
  return segments;
}

/** whisper-cli arguments: -oj with -of makes it write <outBase>.json (stdout is console text only). */
export function buildWhisperArgs({ modelPath, language, wavPath, outBase, threads = 0 }) {
  const args = ["-m", modelPath, "-l", language, "-oj", "-of", outBase, "-np", "-f", wavPath];
  if (Number(threads) > 0) args.push("-t", String(threads));
  return args;
}

/** sherpaModelType → sherpa-onnx-offline model flag (names per sherpa-onnx csrc/*-model-config.cc). */
const SHERPA_MODEL_FLAGS = {
  "sense-voice": "--sense-voice-model",
  paraformer: "--paraformer",
  "zipformer-ctc": "--zipformer-ctc-model",
  "zipformer2-ctc": "--zipformer-ctc-model",
};

/** sherpa-onnx-offline chunk length (seconds) for non-streaming models. */
const SHERPA_CHUNK_SECONDS = 30;

/** sherpa-onnx-offline arguments: model flag by type, tokens, threads, then wav files as positional args. */
export function buildSherpaArgs({ modelType, model, tokens, threads = 0, wavPaths }) {
  const flag = SHERPA_MODEL_FLAGS[String(modelType ?? "").trim()];
  if (!flag) throw new Error("unsupported sherpaModelType: " + modelType + " (sense-voice | paraformer | zipformer2-ctc)");
  const args = [flag + "=" + model, "--tokens=" + tokens];
  if (Number(threads) > 0) args.push("--num-threads=" + threads);
  return [...args, ...wavPaths];
}

const SHERPA_BREAK_RE = /[。！？!?；;，,.]$/;
const SHERPA_GAP_SECONDS = 0.8;
const SHERPA_MAX_SEGMENT_CHARS = 40;

/**
 * Parse sherpa-onnx-offline stdout: one JSON result per input wav, in order
 * ({text, tokens[], timestamps[]} with token start times in seconds). The i-th
 * result is offset by i * chunkSeconds; tokens are grouped into sentence-like
 * segments at punctuation, pauses or a length cap.
 */
export function parseSherpaResults(stdout, chunkSeconds = SHERPA_CHUNK_SECONDS) {
  const segments = [];
  let index = -1;
  for (const line of String(stdout ?? "").split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed.startsWith("{")) continue;
    let result;
    try { result = JSON.parse(trimmed); } catch { continue; }
    index++;
    const offset = index * chunkSeconds;
    const tokens = Array.isArray(result?.tokens) ? result.tokens : [];
    const times = Array.isArray(result?.timestamps) ? result.timestamps : [];
    if (tokens.length === 0 || tokens.length !== times.length) {
      const text = String(result?.text ?? "").trim();
      if (text) segments.push({ start: offset, end: offset + chunkSeconds, text });
      continue;
    }
    let current = null;
    const flush = (end) => {
      if (current && current.text.trim()) {
        segments.push({ start: current.start, end: Math.max(end, current.start), text: current.text.trim() });
      }
      current = null;
    };
    for (let i = 0; i < tokens.length; i++) {
      const t = offset + Number(times[i]);
      const piece = String(tokens[i]).replace(/<\|[^|]*\|>/g, "").replace(/\u2581/g, " ");
      if (!Number.isFinite(t) || piece.length === 0) continue;
      if (current && t - current.last > SHERPA_GAP_SECONDS) flush(current.last);
      if (!current) current = { start: Math.round(t * 100) / 100, last: t, text: "" };
      current.text += piece;
      current.last = t;
      if (SHERPA_BREAK_RE.test(piece.trim()) || current.text.trim().length >= SHERPA_MAX_SEGMENT_CHARS) {
        const next = i + 1 < times.length ? offset + Number(times[i + 1]) : t;
        flush(Math.round(Math.min(next, t + SHERPA_GAP_SECONDS) * 100) / 100);
      }
    }
    if (current) flush(Math.round((current.last + 0.3) * 100) / 100);
  }
  return segments;
}

/** 视觉模型三档（全小体积）：档位关键词 → 模型名（Ollama tag / llama-server alias；低/中/高 适配不同配置）。 */
const VISION_TIERS = {
  low: "qwen3-vl:2b",
  small: "qwen3-vl:2b",
  medium: "qwen3-vl:4b",
  high: "qwen3-vl:8b",
  large: "qwen3-vl:8b",
};

/** Resolve the vision model name: tier keyword → recommended model name; explicit names pass through. */
export function resolveVisionModel(visionModel) {
  const model = String(visionModel ?? "").trim();
  if (!model) return undefined;
  return VISION_TIERS[model.toLowerCase()] ?? model;
}

/** Bundled default prompt: understand the frame's CONTENT (not OCR transcription), for gap-filling. */
export const DEFAULT_VISION_PROMPT =
  "你是视频画面分析助手。用中文客观描述这张视频截图所展示的内容，重点提供语音文稿中缺失的视觉信息：" +
  "① 画面主体（人物/场景/产品/界面）；② 正在进行的操作、演示或对比；③ 与视频主题相关的关键细节。" +
  "画面中的文字只需转述与理解内容相关的要点（如标题、关键数字、图表结论），不要逐字转录。" +
  "要求 2-3 句话，只描述事实，不评价、不推测画面之外的内容。" +
  "若画面只是主持人口播、无信息量，回复「纯口播画面，无补充信息」。" +
  "最后单独一行输出「配图建议：适合」或「配图建议：不适合」（适合=画面清晰、信息明确、能帮助读者理解视频内容；不适合=纯口播、模糊、无信息量）。";

/** MiniCPM-V family prompt: same content-understanding task, denser detail on charts/demos. */
const VISION_PROMPT_MINICPMV =
  "你是视频画面分析助手。请理解并描述这张视频截图的内容：画面里发生了什么、展示了什么，" +
  "与视频主题相关的关键细节要提到；若画面中有图表或演示，说明它传达的结论。" +
  "画面中的文字只需转述要点（标题、关键数字），不要逐字转录。" +
  "用中文、2-3 句话、只描述事实。" +
  "若画面只是主持人口播、无信息量，回复「纯口播画面，无补充信息」。" +
  "最后单独一行输出「配图建议：适合」或「配图建议：不适合」（适合=画面清晰、信息明确、能帮助读者理解视频内容；不适合=纯口播、模糊、无信息量）。";

/** moondream2 is weak at Chinese: an English prompt keeps instruction-following reliable. */
const VISION_PROMPT_MOONDREAM2 =
  "Describe the content of this video frame: what is happening, what is being shown or demonstrated, " +
  "and any key details relevant to the topic. Mention visible text only as brief key points " +
  "(e.g., a headline or a key number); do not transcribe everything. " +
  "Answer in 2-3 sentences, facts only. " +
  "If the frame is just a person talking with no visual information, reply 'talking head, no visual info'. " +
  "End with a separate line: 'citation: suitable' or 'citation: unsuitable' " +
  "(suitable = the frame is clear and helps readers understand the video; unsuitable = talking head, blurry, or uninformative).";

/** Short prompt for small/low-tier models, tuned against Qwen3-VL-2B (2026-08): content understanding, anti-hallucination, citation tail. */
export const VISION_PROMPT_SHORT =
  "看这张视频截图，用中文描述画面内容：画面里有什么、在发生什么。" +
  "只描述事实，不超过 2 句话，不确定的细节不要写。" +
  "若画面只是主持人口播，回复「纯口播画面」。" +
  "最后单独一行输出「配图建议：适合」或「配图建议：不适合」" +
  "（适合=画面清晰、有信息量、能帮读者理解视频内容；不适合=纯口播、模糊、无信息量）。";

/** Pick the vision prompt for a model: user overrides (exact model → tier → global), then bundled family/tier prompts. */
export function resolveVisionPrompt(model, userPrompt, userPromptByModel) {
  const m = String(model ?? "").trim();
  const byModel = userPromptByModel && typeof userPromptByModel === "object" ? userPromptByModel : {};
  const globalPrompt = String(userPrompt ?? "").trim();
  if (m) {
    const exact = byModel[m] ?? byModel[m.toLowerCase()];
    if (exact && String(exact).trim()) return String(exact).trim();
  }
  const lower = m.toLowerCase();
  const tier = lower === "low" || lower === "small"
    ? "low"
    : lower === "high" || lower === "large"
      ? "high"
      : /(?<!\d)(?:0\.5|1|1\.5|2|3)b|small|tiny/i.test(lower)
        ? "low"
        : /(?<!\d)8b|32b|72b|235b/i.test(lower)
          ? "high"
          : "medium";
  const tierOverride = byModel[tier];
  if (tierOverride && String(tierOverride).trim()) return String(tierOverride).trim();
  if (globalPrompt) return globalPrompt;
  if (lower.startsWith("moondream")) return VISION_PROMPT_MOONDREAM2;
  if (lower.startsWith("minicpm")) return VISION_PROMPT_MINICPMV;
  if (tier === "low") return VISION_PROMPT_SHORT;
  return DEFAULT_VISION_PROMPT;
}

/** Extract the per-frame citation hint ("suitable"/"unsuitable"/"") from a vision description. */
export function parseCitationHint(text) {
  const s = String(text ?? "");
  const zh = /配图建议\s*[:：]?\s*(适合|不适合)/.exec(s);
  if (zh) return zh[1] === "适合" ? "suitable" : "unsuitable";
  const en = /citation\s*[:：]?\s*(suitable|unsuitable)/i.exec(s);
  if (en) return en[1].toLowerCase();
  return "";
}

/** Build an OpenAI-compatible chat/completions vision request (image as base64 data URL). */
export function buildVisionRequest(imageBytes, opts) {
  const prompt = String(opts?.prompt ?? "").trim() || DEFAULT_VISION_PROMPT;
  const model = resolveVisionModel(opts?.model) ?? "qwen3-vl:8b";
  const headers = { "Content-Type": "application/json" };
  if (opts?.apiKey) headers.Authorization = "Bearer " + opts.apiKey;
  const body = {
    model,
    messages: [
      {
        role: "user",
        content: [
          { type: "text", text: prompt },
          {
            type: "image_url",
            image_url: { url: "data:image/jpeg;base64," + Buffer.from(imageBytes).toString("base64") },
          },
        ],
      },
    ],
    max_tokens: 300,
  };
  return { headers, body };
}

/** Parse an OpenAI-compatible chat/completions response into plain text. */
export function parseChatCompletion(json) {
  const content = json?.choices?.[0]?.message?.content;
  return typeof content === "string" ? content.trim() : "";
}

/* ---------- WBI signing (Bilibili web API) ---------- */

const WBI_MIXIN_KEY_ENC_TAB = [
  46, 47, 18, 2, 53, 8, 23, 32, 15, 50, 10, 31, 58, 3, 45, 35, 27, 43, 5, 49,
  33, 9, 42, 19, 29, 28, 14, 39, 12, 38, 41, 13, 37, 48, 7, 16, 24, 55, 40,
  61, 26, 17, 0, 1, 60, 51, 30, 4, 22, 25, 54, 21, 56, 59, 6, 63, 57, 62, 11,
  36, 20, 34, 44, 52,
];

function wbiMixinKey(orig) {
  return WBI_MIXIN_KEY_ENC_TAB.map((n) => orig[n]).join("").slice(0, 32);
}

function wbiMd5(text) {
  return createHash("md5").update(text).digest("hex");
}

/** Fetch the per-account WBI key pair (cached per session). */
async function getWbiKeys(session) {
  if (session._wbiKeys) return session._wbiKeys;
  try {
    const nav = await apiGet(session, "/x/web-interface/nav");
    const img = nav.data?.wbi_img?.img_url ?? "";
    const sub = nav.data?.wbi_img?.sub_url ?? "";
    const imgKey = img.slice(img.lastIndexOf("/") + 1).split(".")[0];
    const subKey = sub.slice(sub.lastIndexOf("/") + 1).split(".")[0];
    if (!imgKey || !subKey) return undefined;
    session._wbiKeys = { imgKey, subKey };
    return session._wbiKeys;
  } catch {
    return undefined;
  }
}

/** Sign plain params with WBI (wts + w_rid) for wbi endpoints. */
async function getWbiSignedParams(session, params) {
  const keys = await getWbiKeys(session);
  if (!keys) return undefined;
  const mixin = wbiMixinKey(keys.imgKey + keys.subKey);
  const withTs = { ...params, wts: Math.round(Date.now() / 1000) };
  const query = Object.keys(withTs)
    .sort()
    .map(
      (k) =>
        encodeURIComponent(k) +
        "=" +
        encodeURIComponent(String(withTs[k]).replace(/[!'()*]/g, "")),
    )
    .join("&");
  return { ...withTs, w_rid: wbiMd5(query + mixin) };
}

/** 字幕轨是否为 B 站 AI 自动生成（lan=ai-zh / 名称含「自动生成」）。 */
export function isAiSubtitleTrack(track) {
  const lan = String(track?.lan ?? "");
  const name = String(track?.lan_name ?? "");
  return /^ai-/i.test(lan) || /自动生成|AI\s*字幕|机器翻[译译]/i.test(name);
}

/** 该轨是否中文（lan 含 zh 或名称含中文）；AI 轨的 lan 是 ai-zh，也算中文。 */
function isChineseSubtitleTrack(track) {
  const lan = String(track?.lan ?? "").toLowerCase();
  const name = String(track?.lan_name ?? "");
  return lan.includes("zh") || /中文|汉语|國語|国语/.test(name);
}

/** 该轨是否繁体中文（参考轨要排除：简繁用字差异会被逐字差分判成错字）。 */
function isTraditionalChineseTrack(track) {
  const lan = String(track?.lan ?? "").toLowerCase();
  const name = String(track?.lan_name ?? "");
  return /^(zh-hant|zh-tw|zh-hk)/.test(lan) || /繁體|繁体|台灣|台湾/.test(name);
}

/** 选轨打分：人工 > AI，简体中文 > 繁体中文 > 其它语种。 */
function rankSubtitleTrack(track) {
  let score = 0;
  if (isChineseSubtitleTrack(track)) score += 6;
  if (isTraditionalChineseTrack(track)) score -= 1;
  if (!isAiSubtitleTrack(track)) score += 10;
  return score;
}

/**
 * 从字幕列表里选主轨 + 一条参考轨。
 * 主轨优先「人工/CC」轨，AI 轨只做兜底（旧实现按列表顺序抓第一条中文轨，
 * 有 CC 轨的视频也可能抓成 ai-zh）。
 * 参考轨仅当语言也是中文时返回，用于交叉校验。
 */
export function pickSubtitleTracks(subtitles) {
  const usable = (Array.isArray(subtitles) ? subtitles : []).filter((s) => s && s.subtitle_url);
  if (usable.length === 0) return null;
  const sorted = [...usable].sort((a, b) => rankSubtitleTrack(b) - rankSubtitleTrack(a));
  const primary = sorted[0];
  const secondary =
    sorted
      .slice(1)
      .find(
        (s) =>
          isChineseSubtitleTrack(s) &&
          !isTraditionalChineseTrack(s) &&
          s.subtitle_url !== primary.subtitle_url,
      ) ?? null;
  return { primary, secondary };
}

/** 字幕分段的最大结束时间（秒）；没有合法分段时返回 0。 */
export function maxSubtitleEnd(segments) {
  let end = 0;
  for (const segment of Array.isArray(segments) ? segments : []) {
    const value = Number(segment?.end ?? segment?.start ?? 0);
    if (Number.isFinite(value) && value > end) end = value;
  }
  return end;
}

/** 字幕时间戳是否与视频时长严重不符。
 *  B站实测会把别的视频的 AI 字幕挂到当前 BV 上（18s 视频返回 8.5 分钟股市文稿），
 *  字幕末段远超视频时长时视为错配：丢弃字幕、改走 ASR 兜底。 */
export function subtitleDurationMismatch(segments, duration) {
  const videoSeconds = Number(duration);
  if (!Number.isFinite(videoSeconds) || videoSeconds <= 0) return false;
  return maxSubtitleEnd(segments) > videoSeconds * SUBTITLE_DURATION_FACTOR + SUBTITLE_DURATION_SLACK_SECONDS;
}

/** 应用字幕错配守卫：命中时丢弃字幕（改走 ASR 兜底）并返回告警。
 *  纯函数，便于单测；extractAll 只负责调用与合并 note。 */
export function applySubtitleDurationGuard(subtitle, duration) {
  if (!subtitle || subtitle.source !== "subtitle") return { subtitle, warning: "" };
  if (!subtitleDurationMismatch(subtitle.segments, duration)) return { subtitle, warning: "" };
  const warning = "字幕与视频时长严重不符（字幕到 " + formatTime(maxSubtitleEnd(subtitle.segments)) +
    "，视频 " + formatTime(duration) + "），已丢弃错配字幕";
  return {
    subtitle: {
      ...subtitle,
      source: "none",
      text: "",
      segments: [],
      total_segments: 0,
      note: warning,
    },
    warning,
  };
}

/** 最长公共子序列比例（0–1），用于两条字幕轨的逐句相似度。 */
export function lcsRatio(a, b) {
  const s1 = String(a ?? "");
  const s2 = String(b ?? "");
  if (!s1 || !s2) return 0;
  const n = s1.length;
  const m = s2.length;
  let prev = new Uint16Array(m + 1);
  let cur = new Uint16Array(m + 1);
  for (let i = 1; i <= n; i++) {
    const c1 = s1[i - 1];
    for (let j = 1; j <= m; j++) {
      cur[j] = c1 === s2[j - 1] ? prev[j - 1] + 1 : prev[j] >= cur[j - 1] ? prev[j] : cur[j - 1];
    }
    const t = prev;
    prev = cur;
    cur = t;
    cur.fill(0);
  }
  return (2 * prev[m]) / (n + m);
}

const NORM_RE = /[\s\p{P}\p{S}]/gu;
const NORM_CHAR_RE = /^[\s\p{P}\p{S}]$/u;

/** 把分段文稿摊平成「归一化字符流 + 每字时间戳」，用于逐字比对。 */
function flattenTranscript(segments) {
  let chars = "";
  const times = [];
  for (const seg of Array.isArray(segments) ? segments : []) {
    const raw = String(seg?.text ?? "");
    if (!raw) continue;
    const start = Number(seg?.start) || 0;
    const end = Number(seg?.end) || start + Math.max(1, raw.length / 4);
    const span = Math.max(0.1, end - start);
    let k = 0;
    for (const ch of raw) {
      if (NORM_CHAR_RE.test(ch)) continue;
      chars += ch;
      times.push(start + (span * k) / Math.max(1, raw.length));
      k++;
    }
  }
  return { chars, times };
}

/**
 * 逐字差分：两条文稿是同一段语音的两次转写，绝大多数字符应当一致。
 * 走双指针 + 有限前瞻重同步，不匹配的小片段就是「两家听出了不同的字」。
 *
 * 比「按时间重叠取整句再算相似度」稳得多——分段粒度不同（B 站字幕 2–3 秒一句，
 * 必剪 5–10 秒一句）会让整句相似度全部崩掉，产生大量假存疑。
 */
function charDiff(a, b, timesA, opts = {}) {
  const lookahead = Number(opts.lookahead) || 40;
  const n = a.length;
  const m = b.length;
  const changes = [];
  let i = Number(opts.startI) || 0;
  let j = Number(opts.startJ) || 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) {
      i++;
      j++;
      continue;
    }
    // 在有限窗口内找重同步点：以「3 个连续字符相同」为准，
    // 单字对齐会在「明朗 → 民主党」这种等长替换上失效（两边的字互不出现在对侧）。
    let si = -1;
    let sj = -1;
    outer: for (let d = 1; d <= lookahead; d++) {
      for (let di = 0; di <= d; di++) {
        const dj = d - di;
        if (i + di + 3 <= n && j + dj + 3 <= m && a.slice(i + di, i + di + 3) === b.slice(j + dj, j + dj + 3)) {
          si = i + di;
          sj = j + dj;
          break outer;
        }
      }
    }
    if (si < 0) {
      changes.push({ i, j, a: a.slice(i), b: b.slice(j), t: timesA[i] ?? timesA[n - 1] ?? 0 });
      break;
    }
    changes.push({ i, j, a: a.slice(i, si), b: b.slice(j, sj), t: timesA[i] ?? 0 });
    i = si;
    j = sj;
  }
  return changes;
}

/**
 * 跳过两边的开头差异（例如一路 ASR 开头的串词），找第一段 4 字公共锚点。
 * 没有锚点就从头比——第一处差异会一路扩散成整段，随后被 maxSpan 过滤掉。
 */
function findAnchor(a, b, window = 260, k = 4) {
  const lim = Math.min(window, a.length, b.length);
  for (let d = 0; d <= lim; d++) {
    for (let di = 0; di <= d && di + k <= a.length; di++) {
      const dj = d - di;
      if (dj + k > b.length) continue;
      if (a.slice(di, di + k) === b.slice(dj, dj + k)) return { di, dj };
    }
  }
  return null;
}

/**
 * 两条文稿交叉校验：逐字比对，把「同一时刻两边文字不一致」的小片段列为存疑。
 * 只输出存疑清单，绝不改写正文——两边都有可能错，改写等于赌博。
 * @returns {{compared:number, suspects:Array<{time:number,primary:string,reference:string,similarity:number}>, aligned:boolean}}
 */
export function crossCheckTranscripts(primarySegments, referenceSegments, opts = {}) {
  const threshold = Number(opts.threshold) > 0 ? Number(opts.threshold) : 0.55;
  const maxSpan = Number(opts.maxSpan) > 0 ? Number(opts.maxSpan) : 16;
  const cap = Number(opts.cap) > 0 ? Number(opts.cap) : 50;

  const primary = (Array.isArray(primarySegments) ? primarySegments : []).filter((s) =>
    String(s?.text ?? "").trim(),
  );
  const reference = (Array.isArray(referenceSegments) ? referenceSegments : []).filter((s) =>
    String(s?.text ?? "").trim(),
  );
  if (primary.length === 0 || reference.length === 0) {
    return { compared: 0, suspects: [], aligned: false };
  }

  const A = flattenTranscript(primary);
  const B = flattenTranscript(reference);
  if (A.chars.length === 0 || B.chars.length === 0) {
    return { compared: primary.length, suspects: [], aligned: false };
  }

  // 长度差过大（>30%）说明第二路结果根本对不上，别硬比
  const lenRatio = Math.min(A.chars.length, B.chars.length) / Math.max(A.chars.length, B.chars.length);
  if (lenRatio < 0.7) {
    return { compared: primary.length, suspects: [], aligned: false };
  }

  const anchor = findAnchor(A.chars, B.chars);
  const changes = charDiff(A.chars, B.chars, A.times, {
    ...opts,
    startI: anchor?.di ?? 0,
    startJ: anchor?.dj ?? 0,
  });
  const suspects = [];
  for (const c of changes) {
    if (suspects.length >= cap) break;
    const a = c.a;
    const b = c.b;
    if (!a || !b) continue; // 纯增删多为语气词/断句差异，不算错字
    if (Math.max(a.length, b.length) > maxSpan) continue; // 整段错位，不是同音错字
    const sim = lcsRatio(a, b);
    if (sim >= threshold) continue; // 只是写法差异，不算存疑
    // 带上下文展示：单字差异（赢/迎）单看没意义，前后几个字才看得出是哪句话
    const ctx = 7;
    const ia = c.i ?? 0;
    const jb = c.j ?? 0;
    const aCtx = (A.chars.slice(Math.max(0, ia - ctx), ia) + "【" + a + "】" + A.chars.slice(ia + a.length, ia + a.length + ctx)).trim();
    const bCtx = (B.chars.slice(Math.max(0, jb - ctx), jb) + "【" + b + "】" + B.chars.slice(jb + b.length, jb + b.length + ctx)).trim();
    suspects.push({
      time: Math.round((c.t ?? 0) * 10) / 10,
      primary: aCtx,
      reference: bCtx,
      similarity: Number(sim.toFixed(2)),
    });
  }
  return { compared: primary.length, suspects, aligned: true };
}

async function fetchSubtitleTrack(session, track) {
  let url = String(track.subtitle_url);
  if (url.startsWith("//")) url = "https:" + url;
  const resp = await fetch(url, {
    headers: session.headers,
    signal: requestSignal(session.signal, REQUEST_TIMEOUT_MS),
  });
  if (!resp.ok) throw new Error("subtitle download HTTP " + resp.status);
  return parseSubtitleBody(await resp.json());
}

/**
 * 空字幕列表判定：接口成功、但没有字幕轨、也不是「需要登录」。
 * B 站限流时会返回 code=0 + 空数组（不是 412、不是报错），若当成「无字幕」，
 * 就会白白掉进 60 秒的 ASR 兜底，最后输出「No transcript」。
 */
export function isEmptySubtitleList(data) {
  if (data?.code !== 0) return false;
  if (data?.data?.need_login_subtitle === true) return false;
  const subtitles = data?.data?.subtitle?.subtitles;
  return !Array.isArray(subtitles) || subtitles.length === 0;
}

/** 空列表时的重试间隔（毫秒）；总等待约 9.5 秒，远小于 ASR 兜底的 60 秒。 */
export const EMPTY_SUBTITLE_RETRY_DELAYS = [1500, 3000, 5000];

/**
 * 拉字幕列表；遇到「成功但空」的重试几次，避免把限流误判成无字幕。
 * fetchOnce/sleep/isAborted 可注入，便于单测。
 */
export async function retryWhileEmpty(fetchOnce, options = {}) {
  const delays = options.delays ?? EMPTY_SUBTITLE_RETRY_DELAYS;
  const sleepFn = options.sleep ?? sleep;
  const isAborted = options.isAborted ?? (() => false);
  let data = await fetchOnce();
  if (!isEmptySubtitleList(data)) return data;
  for (const ms of delays) {
    if (isAborted()) return data;
    await sleepFn(ms);
    if (isAborted()) return data;
    const again = await fetchOnce();
    if (!isEmptySubtitleList(again)) return again;
    data = again;
  }
  return data;
}

/**
 * 合并两个端点的字幕列表：同一视频 wbi 与 player/v2 返回的轨**并不一致**
 * （实测 BV1sKxQ6nEiL：player/v2 有 zh-CN 人工轨 + ai-zh，wbi 只有 ai-zh）。
 * 以 subtitle_url 去重，wbi 的条目优先（url 更稳）。
 */
export function mergeSubtitleLists(primaryData, extraData) {
  const pick = (data) =>
    data?.code === 0 && Array.isArray(data?.data?.subtitle?.subtitles)
      ? data.data.subtitle.subtitles
      : [];
  const merged = [];
  const seen = new Set();
  for (const track of [...pick(primaryData), ...pick(extraData)]) {
    if (!track) continue;
    // 按语言去重，不能按 url：同一条轨在两个端点会拿到不同的签名 url，
    // 按 url 去重会把「同一条 AI 轨」变成两条，交叉校验就成了自己比自己。
    const key = `${String(track.lan ?? "")}|${String(track.lan_doc ?? "")}`;
    if (seen.has(key)) continue;
    seen.add(key);
    merged.push(track);
  }
  return merged;
}

/** 已有一条非 AI 的中文轨就够用，不必再多打一次接口。 */
function hasManualChineseTrack(subtitles) {
  return subtitles.some((s) => isChineseSubtitleTrack(s) && !isAiSubtitleTrack(s));
}

/** 取字幕列表：WBI 签名接口优先，空列表或失败都退回 player/v2，并合并两边的轨。 */
async function fetchSubtitleList(session, bvid, cid) {
  // WBI-signed endpoint first: returns stable subtitle_url (incl. ai-zh tracks).
  // The plain player/v2 response is flaky for logged-in sessions — but the
  // reverse happens too, and the two endpoints can disagree on which tracks
  // exist, so an empty (or AI-only) wbi answer is not final.
  const signed = await getWbiSignedParams(session, { bvid, cid });
  const wbi = signed ? await apiGet(session, "/x/player/wbi/v2", signed) : { code: -1 };
  const wbiTracks = mergeSubtitleLists(wbi, null);
  if (hasManualChineseTrack(wbiTracks)) return wbi;

  const plain = await apiGet(session, "/x/player/v2", { bvid, cid });
  const merged = mergeSubtitleLists(wbi, plain);
  if (merged.length > 0) {
    return { code: 0, data: { ...(wbi.code === 0 ? wbi.data : plain.data), subtitle: { subtitles: merged } } };
  }
  // 两边都空：优先返回 wbi（code 0），让上层按「可能被限流」重试
  return wbi.code === 0 ? wbi : plain;
}

/** 有中文轨、但全是 AI 轨（没有人工 CC）。B 站不同节点返回的字幕元数据不一致，
 *  这时值得再探几次：实测同一 cid 连续请求会分别给出「2 条（含 zh-Hans）」和
 *  「1 条（只有 ai-zh）」两种结果。 */
export function lacksManualChineseTrack(data) {
  if (data?.code !== 0) return false;
  const subs = data?.data?.subtitle?.subtitles;
  if (!Array.isArray(subs) || subs.length === 0) return false;
  const zh = subs.filter(isChineseSubtitleTrack);
  return zh.length > 0 && zh.every((s) => isAiSubtitleTrack(s));
}

/** 探测人工轨时的额外等待（毫秒），只在中英文轨齐全与否可疑时使用。 */
export const MANUAL_TRACK_PROBE_DELAYS = [800, 1600];

async function getSubtitle(session, bvid, cid, opts = {}) {
  const isAborted = () => session.signal?.aborted === true;
  let data = await retryWhileEmpty(() => fetchSubtitleList(session, bvid, cid), {
    sleep: (ms) => abortableSleep(ms, session.signal),
    isAborted,
  });
  // 只有 AI 中文轨时，再探几次人工 CC 轨（默认关，显式开启才付这点延迟）
  if (opts.probeManualTrack === true && lacksManualChineseTrack(data)) {
    for (const ms of MANUAL_TRACK_PROBE_DELAYS) {
      if (isAborted()) break;
      await abortableSleep(ms, session.signal);
      const again = await fetchSubtitleList(session, bvid, cid);
      if (isEmptySubtitleList(again)) continue;
      data = again;
      if (!lacksManualChineseTrack(again)) break;
    }
  }
  if (data.code !== 0) return emptySubtitle("subtitle list failed: " + (data.message ?? ""));
  const subtitles = data.data?.subtitle?.subtitles ?? [];
  if (!Array.isArray(subtitles) || subtitles.length === 0) {
    const note = data.data?.need_login_subtitle === true
      ? "video has subtitles but they require login — use the bilibili_login tool to scan-login, or set SESSDATA in the plugin config"
      : "video has no subtitle track (transcript unavailable)";
    return emptySubtitle(note);
  }
  const tracks = pickSubtitleTracks(subtitles);
  if (!tracks) return emptySubtitle("subtitle list present but url empty");
  const chosen = tracks.primary;

  let parsed;
  try {
    parsed = await fetchSubtitleTrack(session, chosen);
  } catch (error) {
    if (session.signal?.aborted) throw error;
    return emptySubtitle("subtitle download failed: " + String(error?.message ?? error));
  }

  // 双轨交叉校验：只在同一视频还有第二条中文轨时做，失败不影响主文稿
  let crossCheck = null;
  if (tracks.secondary) {
    try {
      const refParsed = await fetchSubtitleTrack(session, tracks.secondary);
      const result = crossCheckTranscripts(parsed.segments, refParsed.segments);
      if (result.compared > 0) {
        crossCheck = {
          reference_language: tracks.secondary.lan_name ?? tracks.secondary.lan ?? "unknown",
          reference_is_ai: isAiSubtitleTrack(tracks.secondary),
          compared: result.compared,
          suspects: result.suspects,
        };
      }
    } catch {
      /* 参考轨拿不到就算了，主文稿照常返回 */
    }
  }

  return {
    source: "subtitle",
    language: chosen.lan_name ?? chosen.lan ?? "unknown",
    is_ai: isAiSubtitleTrack(chosen),
    text: parsed.text,
    segments: parsed.segments,
    total_segments: parsed.segments.length,
    cross_check: crossCheck,
    note: "",
  };
}

const BCUT_API_BASE = "https://member.bilibili.com/x/bcut/rubick-interface";
const BCUT_POLL_MS = 5000;
const BCUT_MAX_POLLS = 24;

/** DASH 纯音频流地址（供 ASR 使用），来自 playurl 接口。 */
async function getAudioUrl(session, bvid, cid, quality = 32) {
  const data = await apiGet(session, "/x/player/playurl", {
    bvid, cid, qn: quality, fnval: 16,
  });
  if (data.code !== 0) return undefined;
  const dashAudio = data.data?.dash?.audio;
  if (!Array.isArray(dashAudio) || dashAudio.length === 0) return undefined;
  // 必剪是第三方服务按 URL 拉流：PCDN 节点（*.mcdn.bilivideo.cn、*.edge.mountaintoys.cn
  // 等）对它们经常拉不到，任务会一直排队到超时。实测同一条音轨的备用地址里通常还有
  // upos-sz-mirror*.bilivideo.com 这种普通 CDN，优先用它。
  const urls = [];
  for (const track of dashAudio) {
    const base = track?.baseUrl ?? track?.base_url;
    if (base) urls.push(base);
    for (const backup of track?.backupUrl ?? track?.backup_url ?? []) {
      if (backup) urls.push(backup);
    }
  }
  if (urls.length === 0) return undefined;
  const isPcdn = (u) => /mcdn\.bilivideo\.cn|edge\.mountaintoys\.cn|\/\/[a-z]+\d+x\d+/i.test(u);
  const upos = urls.find((u) => /upos-[^/]*\.bilivideo\.com/i.test(u));
  if (upos) return upos;
  return urls.find((u) => !isPcdn(u)) ?? urls[0];
}

async function abortableSleep(ms, signal) {
  await sleep(ms);
  if (signal?.aborted) throw new Error("aborted");
}

/**
 * B站播放器「实时 AI 字幕」同款能力：必剪（Bcut）ASR，URL 直传、匿名可用。
 * 无字幕轨的视频借此获得带时间戳的文稿。best-effort：失败时由调用方降级。
 */
async function transcribeAudio(session, audioUrl, signal, opts = {}) {
  // 交叉校验用更短的等待上限：宁可 1 分钟放弃，别让一次分析卡 2 分钟
  const maxPolls = Number(opts.maxPolls) > 0 ? Number(opts.maxPolls) : BCUT_MAX_POLLS;
  const createResp = await fetch(BCUT_API_BASE + "/task", {
    method: "POST",
    headers: {
      "User-Agent": USER_AGENT,
      "Content-Type": "application/json",
      "Cache-Control": "no-cache",
    },
    body: JSON.stringify({ resource: audioUrl, model_id: "8" }),
    signal: requestSignal(signal, 30000),
  });
  if (!createResp.ok) throw new Error("bcut task create HTTP " + createResp.status);
  const create = await createResp.json();
  if (create.code !== 0) throw new Error("bcut task create failed: " + (create.message ?? create.code));
  const taskId = create.data?.task_id;
  if (!taskId) throw new Error("bcut task create returned no task id");
  // 必剪是异步任务：刚建完立刻查会返回 state=3（空 remark）的假失败。
  // 所以每次查询前都等一个轮询间隔，并把头两次 state=3 当作瞬时错误继续等。
  let errorStreak = 0;
  let garbageStreak = 0; // 非 JSON / HTTP 错误 / 拦截页：连续出现就快速放弃，别白等 120 秒
  for (let attempt = 0; attempt < maxPolls; attempt++) {
    await abortableSleep(BCUT_POLL_MS, signal);
    let res;
    try {
      const resResp = await fetch(
        BCUT_API_BASE + "/task/result?model_id=8&task_id=" + taskId,
        { headers: { "User-Agent": USER_AGENT, "Cache-Control": "no-cache" }, signal: requestSignal(signal, 30000) },
      );
      if (!resResp.ok) {
        if (++garbageStreak >= 3) throw new Error("bcut asr blocked: HTTP " + resResp.status);
        continue;
      }
      const body = await resResp.text();
      try {
        res = JSON.parse(body);
      } catch {
        // 实测被限流时这里返回的是 B 站错误页 HTML 而不是 JSON
        if (++garbageStreak >= 3) throw new Error("bcut asr blocked: non-JSON response");
        continue;
      }
    } catch (error) {
      if (String(error?.message ?? "").startsWith("bcut asr blocked")) throw error;
      if (++garbageStreak >= 3) throw new Error("bcut asr unreachable: " + String(error?.message ?? error).slice(0, 80));
      continue;
    }
    garbageStreak = 0;
    const state = res.data?.state;
    if (state === 3) {
      if (++errorStreak < 3) continue; // 瞬时失败：再等一轮
      const detail = res.data?.remark || res.data?.message || JSON.stringify(res.data ?? {}).slice(0, 160);
      throw new Error("bcut asr error: " + detail);
    }
    errorStreak = 0;
    if (state === 4) {
      const parsed = JSON.parse(res.data?.result ?? "{}");
      const segments = (parsed.utterances ?? [])
        .map((u) => ({
          start: Math.round(u.start_time) / 1000,
          end: Math.round(u.end_time) / 1000,
          text: String(u.transcript ?? "").trim(),
        }))
        .filter((s) => s.text.length > 0);
      return {
        source: "bcut-asr",
        language: "zh",
        text: segments.map((s) => s.text).join("\n"),
        segments,
        total_segments: segments.length,
        note: "transcribed on demand via Bilibili Bijian ASR (video has no subtitle track; text may contain recognition errors)",
      };
    }
  }
  throw new Error("bcut asr timed out");
}

const emptyComments = (note) => ({ total: 0, fetched: 0, comments: [], note });

async function getComments(session, aid, pageSize) {
  const data = await apiGet(session, "/x/v2/reply", {
    type: 1, oid: aid, pn: 1, ps: pageSize, sort: 1,
  });
  if (data.code !== 0) return emptyComments("comments failed: " + (data.message ?? ""));
  const page = data.data?.page ?? {};
  const replies = data.data?.replies ?? [];
  const comments = [];
  for (const reply of replies) {
    const subReplies = (reply.replies ?? []).map((sub) => ({
      user: sub.member?.uname ?? "",
      content: sub.content?.message ?? "",
      likes: sub.like ?? 0,
    }));
    comments.push({
      user: reply.member?.uname ?? "",
      content: reply.content?.message ?? "",
      likes: reply.like ?? 0,
      ctime: reply.ctime ?? 0,
      replies: subReplies.slice(0, 5),
    });
  }
  return { total: page.count ?? 0, fetched: comments.length, comments, note: "" };
}

const emptyDanmaku = (note) => ({ total: 0, top_messages: [], samples: [], note });

async function getDanmaku(session, cid) {
  let xml;
  try {
    const resp = await fetch("https://comment.bilibili.com/" + cid + ".xml", {
      headers: session.headers,
      signal: requestSignal(session.signal, REQUEST_TIMEOUT_MS),
    });
    if (!resp.ok) return emptyDanmaku("danmaku HTTP " + resp.status);
    xml = await resp.text();
  } catch (error) {
    if (session.signal?.aborted) throw error;
    return emptyDanmaku("danmaku failed: " + (error?.message ?? error));
  }
  const entries = [];
  const pattern = /<d p="([^"]*)">([\s\S]*?)<\/d>/g;
  let match;
  while ((match = pattern.exec(xml)) !== null) {
    const parts = match[1].split(",");
    const time = Number.parseFloat(parts[0]);
    if (!Number.isFinite(time)) continue;
    const text = decodeXml(match[2]).trim();
    if (!text) continue;
    entries.push({ time: Math.round(time * 10) / 10, text });
  }
  entries.sort((a, b) => a.time - b.time);
  const counter = new Map();
  for (const entry of entries) counter.set(entry.text, (counter.get(entry.text) ?? 0) + 1);
  const topMessages = [...counter.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 30)
    .map(([text, count]) => ({ text, count }));
  return {
    total: entries.length,
    top_messages: topMessages,
    samples: entries.slice(0, 200),
    note: "",
  };
}

async function getStreamUrl(session, bvid, cid, quality = 32) {
  const data = await apiGet(session, "/x/player/playurl", {
    bvid, cid, qn: quality, fnval: 16,
  });
  if (data.code !== 0) return undefined;
  const durl = data.data?.durl;
  if (Array.isArray(durl) && durl.length > 0 && durl[0].url) return durl[0].url;
  const dashVideo = data.data?.dash?.video;
  if (Array.isArray(dashVideo) && dashVideo.length > 0) {
    return dashVideo[0].baseUrl ?? dashVideo[0].base_url;
  }
  return undefined;
}

/** Run ffmpeg with no stdio pipes: exit code and output-file presence are the only signals.
 *  (Pipe-free spawn also works inside confined sandboxes that forbid capturing child output.) */
async function runFfmpeg(args, signal) {
  return new Promise((resolve, reject) => {
    const child = spawn("ffmpeg", args, { stdio: "ignore", windowsHide: true, signal });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) resolve();
      else reject(new Error(signal?.aborted ? "aborted" : "ffmpeg exited with code " + code));
    });
  });
}

async function fileExists(path) {
  try { await stat(path); return true; } catch { return false; }
}

/** Guess a file extension for a playurl direct link (progressive flv/mp4, hls, fmp4). */
export function guessStreamExt(streamUrl) {
  const text = String(streamUrl);
  if (/\.m3u8(\?|$)/.test(text)) return ".m3u8";
  if (/\.mp4(\?|$)/.test(text)) return ".mp4";
  if (/\.m4s(\?|$)/.test(text)) return ".mp4"; // fmp4: init + media concatenated
  return ".flv";
}

/**
 * Download the direct video stream to a local file with plain HTTP (GET).
 * Bounds: content-length pre-check plus an in-flight byte cap; a caller
 * abort cancels the read and removes the partial file.
 */
async function downloadStream(session, streamUrl, destPath, maxBytes) {
  let resp;
  try {
    resp = await fetch(streamUrl, {
      headers: session.headers,
      signal: requestSignal(session.signal, 600000),
    });
  } catch (error) {
    if (session.signal?.aborted) throw error;
    throw new Error("download request failed: " + (error?.message ?? error));
  }
  if (!resp.ok || !resp.body) throw new Error("download HTTP " + resp.status);
  const declared = Number(resp.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > maxBytes) {
    throw new Error(
      "video too large (" + Math.round(declared / 1048576) + " MB > " +
      Math.round(maxBytes / 1048576) + " MB cap)",
    );
  }
  // 写入 .part，完整写完再做原子 rename：中断/并发不会留下能被复用的半截文件
  const partPath = destPath + ".part";
  const handle = await open(partPath, "w");
  let total = 0;
  try {
    const reader = resp.body.getReader();
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) throw new Error("video exceeded " + Math.round(maxBytes / 1048576) + " MB cap");
      await handle.write(Buffer.from(value));
    }
  } catch (error) {
    await handle.close().catch(() => {});
    await rm(partPath, { force: true }).catch(() => {});
    if (session.signal?.aborted) throw error;
    throw new Error("download interrupted: " + (error?.message ?? error));
  }
  await handle.close();
  if (total <= 0) {
    await rm(partPath, { force: true }).catch(() => {});
    throw new Error("download produced an empty file");
  }
  await rename(partPath, destPath);
  return total;
}

/** Run ffmpeg with stderr redirected to a FILE (no pipes): parse-friendly everywhere. */
async function runFfmpegStderrToFile(args, stderrFd, signal) {
  return new Promise((resolve, reject) => {
    const child = spawn("ffmpeg", args, {
      stdio: ["ignore", "ignore", stderrFd],
      windowsHide: true,
      signal,
    });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) resolve();
      else reject(new Error(signal?.aborted ? "aborted" : "ffmpeg exited with code " + code));
    });
  });
}

/** Run a CLI (whisper-cli / sherpa-onnx-offline) with stdout/stderr redirected to files (no pipes): sandbox-friendly. */
async function runCliToFile(bin, label, args, stdoutFd, stderrFd, signal) {
  return new Promise((resolve, reject) => {
    let child;
    try {
      child = spawn(bin, args, {
        stdio: ["ignore", stdoutFd, stderrFd],
        windowsHide: true,
        signal,
      });
    } catch (error) {
      reject(error);
      return;
    }
    child.on("error", (error) => {
      if (error?.code === "ENOENT") reject(new Error(label + " binary not found: " + bin));
      else reject(error);
    });
    child.on("close", (code) => {
      if (code === 0) resolve();
      else reject(new Error(signal?.aborted ? "aborted" : label + " exited with code " + code));
    });
  });
}

/**
 * Local ASR via whisper.cpp: download the DASH audio, convert to 16kHz mono WAV
 * with ffmpeg, run whisper-cli (-oj), and parse the JSON into timestamped
 * segments. The model file must be downloaded by the user — this only wires the
 * interface. Best-effort: failures are caught by the caller and degrade cleanly.
 */
async function transcribeWhisperLocal(session, bvid, cid, quality, outDir, opts, signal) {
  const whisperBin = opts.whisperBin || "whisper-cli";
  const whisperModel = opts.whisperModel || "medium";
  const whisperLanguage = opts.whisperLanguage || "zh";
  const whisperThreads = Number(opts.whisperThreads) || 0;
  const modelPath = resolveWhisperModel(whisperModel, opts.whisperModelDir, whisperBin);
  if (!modelPath) throw new Error("whisper model not configured");

  const audioUrl = await getAudioUrl(session, bvid, cid, quality);
  if (!audioUrl) throw new Error("no dash audio stream");
  await mkdir(outDir, { recursive: true });

  const audioPath = join(outDir, "audio.m4s");
  const wavPath = join(outDir, "audio.wav");
  // whisper-cli -oj writes <-of>.json itself; stdout only carries console text
  const outBase = join(outDir, "whisper");
  const jsonPath = outBase + ".json";
  const outPath = join(outDir, "whisper.out.log");
  const errPath = join(outDir, "whisper.err.log");
  try {
    await downloadStream(session, audioUrl, audioPath, AUDIO_CAP_BYTES);
    await runFfmpeg(
      ["-y", "-i", audioPath, "-ac", "1", "-ar", "16000", "-c:a", "pcm_s16le", wavPath],
      requestSignal(signal, AUDIO_CONVERT_TIMEOUT_MS),
    );
    await rm(jsonPath, { force: true }).catch(() => {});
    const stdoutFd = await open(outPath, "w");
    const stderrFd = await open(errPath, "w");
    const args = buildWhisperArgs({ modelPath, language: whisperLanguage, wavPath, outBase, threads: whisperThreads });
    try {
      await runCliToFile(whisperBin, "whisper-cli", args, stdoutFd, stderrFd, signal);
    } finally {
      await stdoutFd.close().catch(() => {});
      await stderrFd.close().catch(() => {});
    }
    let jsonText = "";
    try { jsonText = await readFile(jsonPath, "utf8"); } catch { /* handled below */ }
    let parsed;
    try {
      parsed = JSON.parse(jsonText);
    } catch {
      let tail = "";
      try { tail = (await readFile(errPath, "utf8")).trim().split("\n").slice(-4).join(" | "); } catch { /* ignore */ }
      throw new Error("whisper-cli produced no valid JSON" + (tail ? ": " + tail : ""));
    }
    const segments = parseWhisperJson(parsed);
    if (segments.length === 0) throw new Error("whisper-cli returned no transcription segments");
    return {
      source: "whisper-local",
      language: whisperLanguage,
      text: segments.map((s) => s.text).join("\n"),
      segments,
      total_segments: segments.length,
      note: "transcribed locally via whisper.cpp (" + whisperModel + "); the model file must be downloaded by the user",
    };
  } finally {
    await rm(audioPath, { force: true }).catch(() => {});
    await rm(wavPath, { force: true }).catch(() => {});
    await rm(jsonPath, { force: true }).catch(() => {});
    await rm(outPath, { force: true }).catch(() => {});
    await rm(errPath, { force: true }).catch(() => {});
  }
}

/**
 * Local ASR via sherpa-onnx (SenseVoice/Paraformer, Chinese-optimized): download
 * the DASH audio, convert to 16kHz mono WAV, run sherpa-onnx-offline, and parse
 * the stdout transcript. Model + tokens must be downloaded by the user — this
 * only wires the interface. Best-effort; failures degrade cleanly.
 */
async function transcribeSherpaOnnx(session, bvid, cid, quality, outDir, opts, signal) {
  const sherpaBin = String(opts.sherpaBin ?? "").trim();
  const sherpaModel = String(opts.sherpaModel ?? "").trim();
  const sherpaTokens = String(opts.sherpaTokens ?? "").trim();
  const sherpaModelType = String(opts.sherpaModelType ?? "sense-voice").trim();
  const sherpaThreads = Number(opts.sherpaThreads) || 0;
  if (!sherpaBin) throw new Error("sherpa-onnx binary not configured (sherpaBin)");
  if (!sherpaModel) throw new Error("sherpa-onnx model not configured (sherpaModel)");
  if (!sherpaTokens) throw new Error("sherpa-onnx tokens not configured (sherpaTokens)");

  const audioUrl = await getAudioUrl(session, bvid, cid, quality);
  if (!audioUrl) throw new Error("no dash audio stream");
  await mkdir(outDir, { recursive: true });

  const audioPath = join(outDir, "audio.m4s");
  const chunkDir = join(outDir, "sherpa-chunks");
  const outPath = join(outDir, "sherpa.out.txt");
  const errPath = join(outDir, "sherpa.err.log");
  try {
    await downloadStream(session, audioUrl, audioPath, AUDIO_CAP_BYTES);
    // 非流式模型（SenseVoice/Paraformer）不适合一次吃下整段长音频：切成固定时长的 16kHz WAV 块，
    // 一次进程按顺序解码，第 i 块的时间戳偏移 i * SHERPA_CHUNK_SECONDS
    await rm(chunkDir, { recursive: true, force: true }).catch(() => {});
    await mkdir(chunkDir, { recursive: true });
    await runFfmpeg(
      [
        "-y", "-i", audioPath, "-ac", "1", "-ar", "16000", "-c:a", "pcm_s16le",
        "-f", "segment", "-segment_time", String(SHERPA_CHUNK_SECONDS),
        join(chunkDir, "chunk_%04d.wav"),
      ],
      requestSignal(signal, AUDIO_CONVERT_TIMEOUT_MS),
    );
    const chunks = (await readdir(chunkDir)).filter((n) => n.endsWith(".wav")).sort().map((n) => join(chunkDir, n));
    if (chunks.length === 0) throw new Error("audio conversion produced no wav chunks");
    const stdoutFd = await open(outPath, "w");
    const stderrFd = await open(errPath, "w");
    const args = buildSherpaArgs({ modelType: sherpaModelType, model: sherpaModel, tokens: sherpaTokens, threads: sherpaThreads, wavPaths: chunks });
    try {
      await runCliToFile(sherpaBin, "sherpa-onnx", args, stdoutFd, stderrFd, signal);
    } finally {
      await stdoutFd.close().catch(() => {});
      await stderrFd.close().catch(() => {});
    }
    let outText = "";
    try { outText = await readFile(outPath, "utf8"); } catch { /* handled below */ }
    let segments = parseSherpaResults(outText, SHERPA_CHUNK_SECONDS);
    if (segments.length === 0) segments = parseSherpaText(outText); // older builds printing plain text
    if (segments.length === 0) {
      let tail = "";
      try { tail = (await readFile(errPath, "utf8")).trim().split("\n").slice(-4).join(" | "); } catch { /* ignore */ }
      throw new Error("sherpa-onnx produced no transcript" + (tail ? ": " + tail : ""));
    }
    const hasTimestamps = segments.some((s) => s.end > 0);
    return {
      source: "sherpa-onnx",
      language: "zh",
      text: segments.map((s) => s.text).join("\n"),
      segments,
      total_segments: segments.length,
      note: "transcribed locally via sherpa-onnx (" + sherpaModelType + "); model + tokens must be downloaded by the user" + (hasTimestamps ? "" : " — no per-segment timestamps in output"),
    };
  } finally {
    await rm(audioPath, { force: true }).catch(() => {});
    await rm(chunkDir, { recursive: true, force: true }).catch(() => {});
    await rm(outPath, { force: true }).catch(() => {});
    await rm(errPath, { force: true }).catch(() => {});
  }
}

const VISION_TIMEOUT_MS = 60000;

/** Resolve the vision endpoint URL for the given provider. */
export function resolveVisionBaseUrl(provider, baseUrl) {
  const url = String(baseUrl ?? "").trim().replace(/\/+$/, "");
  if (url) return url;
  if (provider === "ollama") return "http://localhost:11434/v1";
  if (provider === "llama-cpp") return "http://localhost:8080/v1";
  return "";
}

/**
 * Describe captured frames with a configured vision model (local Ollama or any
 * OpenAI-compatible endpoint). One request per frame, sequential, bounded by
 * visionMaxFrames; a per-frame failure is recorded and the loop continues.
 * Best-effort: the caller degrades gracefully when this throws.
 */
/** 环境变量 → 有界正整数（非法值回落默认值） */
function clampEnv(name, fallback, min, max) {
  const n = Number(process.env[name]);
  if (!Number.isFinite(n) || n <= 0) return fallback;
  return Math.max(min, Math.min(max, Math.floor(n)));
}

/** 有界并发 map：返回顺序与输入一致；任一项抛错则整体 reject（调用方按需 catch） */
async function mapLimit(items, limit, fn) {
  const list = Array.isArray(items) ? items : [];
  const out = new Array(list.length);
  if (list.length === 0) return out;
  let next = 0;
  const width = Math.max(1, Math.min(Math.floor(limit) || 1, list.length));
  await Promise.all(
    Array.from({ length: width }, async () => {
      for (;;) {
        const i = next++;
        if (i >= list.length) return;
        out[i] = await fn(list[i], i);
      }
    }),
  );
  return out;
}

/** 递归统计目录字节数（best-effort，出错按 0 计） */
async function dirSize(dir) {
  let total = 0;
  const entries = await readdir(dir, { withFileTypes: true }).catch(() => []);
  for (const entry of entries) {
    const p = join(dir, entry.name);
    if (entry.isDirectory()) total += await dirSize(p);
    else total += await stat(p).then((s) => s.size).catch(() => 0);
  }
  return total;
}

/**
 * 清理输出目录里的历史记录：视频缓存只保 24h、帧文件却永不删除，
 * 分析得越多 %TEMP%\dsh-bilibili\BV* 越大。这里按「保留时长 + 总容量」兜底。
 *
 * 安全边界：只处理 baseDir 下**形如 BV+10 位**的子目录（插件自己建的），
 * 跳过当前正在用的 bvid；调用方只在默认临时目录时启用（用户指定的 framesDir 一律不碰）。
 * DSH_BILIBILI_CACHE_TTL_HOURS / DSH_BILIBILI_CACHE_MAX_MB 置 0 可关闭对应策略。
 */
async function pruneOutputDirs(baseDir, keepName = "") {
  const ttlHours = Number(process.env.DSH_BILIBILI_CACHE_TTL_HOURS);
  const maxMb = Number(process.env.DSH_BILIBILI_CACHE_MAX_MB);
  const ttlMs = (Number.isFinite(ttlHours) && ttlHours >= 0 ? ttlHours : 72) * 3600 * 1000;
  const maxBytes = (Number.isFinite(maxMb) && maxMb >= 0 ? maxMb : 2048) * 1048576;
  if (ttlMs <= 0 && maxBytes <= 0) return { removed: 0, freedBytes: 0 };

  const entries = await readdir(baseDir, { withFileTypes: true }).catch(() => null);
  if (!entries) return { removed: 0, freedBytes: 0 };

  const now = Date.now();
  const alive = [];
  let removed = 0;
  let freedBytes = 0;
  for (const entry of entries) {
    if (!entry.isDirectory() || entry.name === keepName) continue;
    if (!/^BV[0-9A-Za-z]{10}$/.test(entry.name)) continue;
    const dir = join(baseDir, entry.name);
    const info = await stat(dir).catch(() => null);
    if (!info) continue;
    const size = await dirSize(dir);
    if (ttlMs > 0 && now - info.mtimeMs > ttlMs) {
      await rm(dir, { recursive: true, force: true }).catch(() => {});
      removed++;
      freedBytes += size;
    } else {
      alive.push({ dir, mtimeMs: info.mtimeMs, size });
    }
  }
  if (maxBytes > 0) {
    let total = alive.reduce((sum, d) => sum + d.size, 0);
    alive.sort((a, b) => a.mtimeMs - b.mtimeMs);
    for (const d of alive) {
      if (total <= maxBytes) break;
      await rm(d.dir, { recursive: true, force: true }).catch(() => {});
      total -= d.size;
      removed++;
      freedBytes += d.size;
    }
  }
  return { removed, freedBytes };
}

async function describeFramesWithVision(frames, opts, signal) {
  const baseUrl = resolveVisionBaseUrl(opts.provider, opts.baseUrl);
  if (!baseUrl) throw new Error("vision endpoint not configured (visionBaseUrl)");
  const cap = Math.min(Math.max(Number(opts.maxFrames) || 4, 1), 20);
  const target = (frames ?? []).filter((f) => f.has_image && f.path).slice(0, cap);
  const prompt = resolveVisionPrompt(opts.model, opts.prompt, opts.promptByModel);
  // 有界并发（默认 2）：本地模型并行收益有限，远端 endpoint 能明显缩短等待
  return mapLimit(target, VISION_CONCURRENCY, async (frame) => {
    let imageBytes;
    try {
      imageBytes = await readFile(frame.path);
    } catch (error) {
      return { time: frame.time, description: "", vision_error: "frame file unreadable: " + String(error?.message ?? error), citation_hint: "" };
    }
    const { headers, body } = buildVisionRequest(imageBytes, { ...opts, prompt });
    try {
      const resp = await fetch(baseUrl + "/chat/completions", {
        method: "POST",
        headers,
        body: JSON.stringify(body),
        signal: requestSignal(signal, VISION_TIMEOUT_MS),
      });
      if (!resp.ok) throw new Error("vision HTTP " + resp.status);
      const json = await resp.json();
      const description = parseChatCompletion(json);
      return {
        time: frame.time,
        description,
        vision_error: description ? null : "empty vision response",
        citation_hint: parseCitationHint(description),
      };
    } catch (error) {
      if (signal?.aborted) throw error; // caller cancelled
      return { time: frame.time, description: "", vision_error: String(error?.message ?? error).slice(-160), citation_hint: "" };
    }
  });
}

/**
 * Picture-driven candidate timestamps: decode the local video once with
 * ffmpeg's scene-change filter and collect frame times via showinfo.
 * Best-effort — failures yield no peaks (the caller falls back gracefully).
 */
async function detectScenePeaks(videoPath, outDir, threshold, signal, sampled = false) {
  const logPath = join(outDir, "scene-detect.log");
  const logFd = await open(logPath, "w");
  const vf = sampled
    ? "select='not(mod(n," + SCENE_SAMPLED_STEP_FRAMES + "))',select='gt(scene," + threshold + ")',showinfo"
    : "select='gt(scene," + threshold + ")',showinfo";
  try {
    await runFfmpegStderrToFile([
      "-hide_banner",
      "-i", videoPath,
      "-vf", vf,
      "-an",
      "-f", "null", "-",
    ], logFd, requestSignal(signal, SCENE_TIMEOUT_MS));
  } finally {
    await logFd.close().catch(() => {});
  }
  let log = "";
  try { log = await readFile(logPath, "utf8"); } catch { /* keep empty */ }
  await rm(logPath, { force: true }).catch(() => {});
  const peaks = [];
  for (const line of log.split("\n")) {
    const match = /pts_time:([\d.]+)/.exec(line);
    if (!match) continue;
    const time = Number.parseFloat(match[1]);
    if (!Number.isFinite(time)) continue;
    if (peaks.length === 0 || time - peaks[peaks.length - 1].time > SCENE_PEAK_MIN_GAP) {
      peaks.push({ time, reason: "scene change", text: "" });
    }
  }
  return peaks;
}

/** Parse blurdetect metadata lines into {time,blur} entries (time offset by the seek start). */
export function parseBlurMetadata(text, startOffset = 0) {
  const offset = Number(startOffset) || 0;
  const entries = [];
  let curTime = null;
  for (const line of String(text ?? "").split("\n")) {
    const t = /pts_time:([\d.]+)/.exec(line);
    if (t) { curTime = Number.parseFloat(t[1]); continue; }
    const b = /lavfi\.blur=([\d.]+)/.exec(line);
    if (b && curTime !== null) {
      entries.push({ time: offset + curTime, blur: Number.parseFloat(b[1]) });
      curTime = null;
    }
  }
  return entries;
}

/** Pick the peak nearest to a center time; null when no peaks. */
export function pickNearestPeak(peaks, centerTime) {
  const center = Number(centerTime);
  if (!Number.isFinite(center) || !Array.isArray(peaks) || peaks.length === 0) return null;
  let best = null;
  let bestDist = Infinity;
  for (const peak of peaks) {
    const dist = Math.abs(Number(peak?.time) - center);
    if (Number.isFinite(dist) && dist < bestDist) {
      bestDist = dist;
      best = peak;
    }
  }
  return best;
}

/**
 * Scene-change peaks inside a small time window around a requested moment
 * (cheap: only decodes halfWindow*2 seconds). Used to align agent-requested
 * timestamps onto the most informative frame nearby (picture-driven refinement
 * of semantic targeting). Best-effort: returns null on failure or no peak.
 */
async function detectScenePeaksInWindow(videoPath, centerTime, halfWindow, outDir, signal) {
  const start = Math.max(0, Number(centerTime) - Number(halfWindow));
  const duration = Number(halfWindow) * 2;
  const logPath = join(outDir, "scene-window.log");
  const logFd = await open(logPath, "w");
  try {
    await runFfmpegStderrToFile([
      "-hide_banner",
      "-ss", String(start),
      "-t", String(duration),
      "-i", videoPath,
      "-vf", "select='gt(scene," + SCENE_ALIGN_THRESHOLD + ")',showinfo",
      "-an",
      "-f", "null", "-",
    ], logFd, requestSignal(signal, SCENE_TIMEOUT_MS));
  } finally {
    await logFd.close().catch(() => {});
  }
  let log = "";
  try { log = await readFile(logPath, "utf8"); } catch { /* keep empty */ }
  await rm(logPath, { force: true }).catch(() => {});
  const peaks = [];
  for (const line of log.split("\n")) {
    const match = /pts_time:([\d.]+)/.exec(line);
    if (!match) continue;
    const time = start + Number.parseFloat(match[1]); // -ss 后输出时间轴从 0 重新计时
    if (Number.isFinite(time)) peaks.push({ time, reason: "scene change", text: "" });
  }
  return pickNearestPeak(peaks, Number(centerTime));
}

/**
 * Find the sharpest frame time inside a small window around the target moment:
 * runs blurdetect per frame (lower lavfi.blur = sharper) and returns the time of
 * the minimum. Avoids catching motion-blurred animation entrances. Best-effort.
 */
async function findSharpestTime(videoPath, centerTime, halfWindow, outDir, signal) {
  const start = Math.max(0, Number(centerTime) - Number(halfWindow));
  const logPath = join(outDir, "sharpness.log");
  const logFd = await open(logPath, "w");
  try {
    await runFfmpegStderrToFile([
      "-hide_banner",
      "-ss", String(start),
      "-t", String(Number(halfWindow) * 2),
      "-i", videoPath,
      "-vf", "blurdetect,metadata=print:key=lavfi.blur",
      "-an",
      "-f", "null", "-",
    ], logFd, requestSignal(signal, SCENE_TIMEOUT_MS));
  } finally {
    await logFd.close().catch(() => {});
  }
  let log = "";
  try { log = await readFile(logPath, "utf8"); } catch { /* keep empty */ }
  await rm(logPath, { force: true }).catch(() => {});
  const entries = parseBlurMetadata(log, start);
  if (entries.length === 0) return null;
  entries.sort((a, b) => a.blur - b.blur);
  return entries[0].time;
}

/** Nearest subtitle line around a time (within +-2s window), for captioning requested frames. */
export function nearestSubtitleText(time, segments) {
  if (!Array.isArray(segments)) return "";
  for (const seg of segments) {
    if (time >= seg.start - 2 && time <= seg.end + 2 && seg.text) return seg.text;
  }
  return "";
}

/** 请求时间点的 5 秒去重窗口（与选帧去重语义一致；就地定义，避免跨文件引用）。 */
const REQUESTED_DEDUPE_SECONDS = 5;

/** Normalize the tool's optional explicit `timestamps` argument, or null.
 *  Each requested moment is captioned with its nearest subtitle line and keeps
 *  the original time as `requested_time` — scene alignment and sharp-frame
 *  refinement later rewrite only `time`, so the drift stays visible. */
export function normalizeRequestedTimestamps(timestamps, duration, maxFrames, segments) {
  if (!Array.isArray(timestamps) || timestamps.length === 0) return null;
  const valid = timestamps
    .map((t) => Number(t))
    .filter((t) => Number.isFinite(t) && t >= 0 && t < Math.max(duration, 1));
  const sorted = valid.slice().sort((a, b) => a - b);
  const deduped = [];
  for (const t of sorted) {
    if (!deduped.some((u) => Math.abs(u - t) <= REQUESTED_DEDUPE_SECONDS)) deduped.push(t);
  }
  const list = deduped.slice(0, Math.max(1, Math.min(maxFrames, 20)));
  if (list.length === 0) return null;
  return list.map((t) => ({
    time: t,
    requested_time: t,
    reason: "requested timestamp",
    text: nearestSubtitleText(t, segments),
  }));
}

/** Transcript cache: avoid re-running ASR across the two-pass workflow (7-day TTL).
 *  条目带 config key（provider + 模型 + 语言）：换引擎后不能静默复用上一份文稿。 */
export async function readTranscriptCache(outDir, cacheKey = "") {
  try {
    const info = await stat(join(outDir, "transcript.json"));
    if (Date.now() - info.mtimeMs >= TRANSCRIPT_CACHE_TTL_MS) return null;
    const parsed = JSON.parse(await readFile(join(outDir, "transcript.json"), "utf8"));
    if (!parsed || typeof parsed.text !== "string" || !Array.isArray(parsed.segments)) return null;
    if (parsed.cache_key !== cacheKey) return null; // 引擎/模型/语言不同 → 视为未命中
    const { cache_key: _ignored, ...rest } = parsed;
    return rest;
  } catch {
    return null;
  }
}

export async function writeTranscriptCache(outDir, transcript, cacheKey = "") {
  try {
    await mkdir(outDir, { recursive: true });
    await writeFile(
      join(outDir, "transcript.json"),
      JSON.stringify({ ...transcript, cache_key: cacheKey }),
      "utf8",
    );
  } catch { /* best-effort */ }
}

/** Reuse a fresh cached copy of the downloaded video (same BV, same outDir).
 *  只返回「完整写入」的文件（.part → rename 产物）：零字节文件、残留 .part
 *  永远不会被当成有效缓存，否则后续 24h 的抽帧都会指向一个坏视频。 */
async function findCachedVideo(outDir) {
  let entries = [];
  try { entries = await readdir(outDir); } catch { return null; }
  for (const name of entries) {
    if (!name.startsWith("video")) continue;
    const path = join(outDir, name);
    try {
      const info = await stat(path);
      const fresh = Date.now() - info.mtimeMs < VIDEO_CACHE_TTL_MS;
      if (name.endsWith(".part")) {
        if (!fresh) await rm(path, { force: true }); // 残留的未完成下载
        continue;
      }
      if (fresh && info.size > 0) return path;
      if (!fresh) await rm(path, { force: true }); // stale cleanup
    } catch { /* ignore */ }
  }
  return null;
}

/** 同一视频的并发请求串行化：避免两个下载互相覆盖 .part / 抢 rename。 */
const videoLocks = new Map();
function withVideoLock(key, fn) {
  const prev = videoLocks.get(key) ?? Promise.resolve();
  const run = prev.then(fn, fn);
  const tail = run.catch(() => {});
  videoLocks.set(key, tail);
  tail.finally(() => {
    if (videoLocks.get(key) === tail) videoLocks.delete(key);
  });
  return run;
}

/** Download the video into outDir unless a fresh cached copy already exists. */
async function ensureVideo(session, streamUrl, outDir, maxBytes) {
  const videoPath = join(outDir, "video" + guessStreamExt(streamUrl));
  return withVideoLock(videoPath, async () => {
    const cached = await findCachedVideo(outDir);
    if (cached) return { path: cached, bytes: 0, reused: true };
    const bytes = await downloadStream(session, streamUrl, videoPath, maxBytes);
    return { path: videoPath, bytes, reused: false };
  });
}

/** Extract frames from a LOCAL video file: fast, accurate, repeatable. */
async function extractFramesFromFile(videoPath, timestamps, outDir, signal) {
  // 并发抓帧：每帧一次独立 ffmpeg（文件已在本机，seek 很快），默认 3 路
  return mapLimit(timestamps, FRAME_CONCURRENCY, async (ts, i) => {
    const outPath = join(outDir, "frame_" + String(i + 1).padStart(3, "0") + ".jpg");
    const args = [
      "-y",
      "-ss", String(ts.time),
      "-i", videoPath,
      "-frames:v", "1",
      "-q:v", "2",
      "-an",
      outPath,
    ];
    try {
      await runFfmpeg(args, requestSignal(signal, FRAME_TIMEOUT_MS));
      const ok = await fileExists(outPath);
      return { ...ts, path: ok ? outPath : null, error: ok ? null : "output file missing" };
    } catch (error) {
      if (signal?.aborted) throw error; // caller cancelled
      return { ...ts, path: null, error: "ffmpeg: " + String(error?.message ?? error).slice(-200) };
    }
  });
}

async function captureFrames(streamUrl, timestamps, outDir, signal) {
  if (!streamUrl || timestamps.length === 0) {
    return timestamps.map((ts) => ({ ...ts, path: null, error: "no stream url" }));
  }
  const ffmpegHeaders =
    "Referer: " + REFERER + "\r\n" + "User-Agent: " + USER_AGENT + "\r\n";
  return mapLimit(timestamps, FRAME_CONCURRENCY, async (ts, i) => {
    const outPath = join(outDir, "frame_" + String(i + 1).padStart(3, "0") + ".jpg");
    const args = [
      "-y",
      "-headers", ffmpegHeaders,
      "-ss", String(ts.time),
      "-i", streamUrl,
      "-frames:v", "1",
      "-q:v", "2",
      "-an",
      outPath,
    ];
    try {
      await runFfmpeg(args, requestSignal(signal, FRAME_TIMEOUT_MS));
      const ok = await fileExists(outPath);
      return { ...ts, path: ok ? outPath : null, error: ok ? null : "output file missing" };
    } catch (error) {
      if (signal?.aborted) throw error; // caller cancelled
      return { ...ts, path: null, error: "ffmpeg: " + String(error?.message ?? error).slice(-200) };
    }
  });
}

async function guarded(task, fallback) {
  try { return await task(); } catch (error) {
    return fallback(String(error?.message ?? error));
  }
}

/**
 * Extract everything for one Bilibili video. Each channel is isolated:
 * a failing channel yields an empty result with a note instead of failing
 * the whole extraction. Returns a lossless-JSON-friendly plain object.
 *
 * @param {{url:string, commentLimit?:number, extractFrames?:boolean,
 *          maxFrames?:number, framesDir?:string, sessdata?:string,
 *          downloadVideo?:boolean, keepVideo?:boolean,
 *          maxVideoMinutes?:number, maxDownloadMb?:number,
 *          quality?:number, timestamps?:number[],
 *          detectScenes?:boolean, sceneThreshold?:number, sharpFrames?:boolean,
 *          asrProvider?:string, whisperBin?:string, whisperModel?:string,
 *          whisperModelDir?:string, whisperLanguage?:string, whisperThreads?:number,
 *          sherpaBin?:string, sherpaModel?:string, sherpaModelType?:string,
 *          sherpaTokens?:string, sherpaThreads?:number,
 *          visionProvider?:string, visionBaseUrl?:string, visionModel?:string,
 *          visionApiKey?:string, visionPrompt?:string, visionPromptByModel?:Record<string,string>,
 *          visionMaxFrames?:number, envReport?:object, signal?:AbortSignal}} options
 */
export async function extractAll(options) {
  const started = Date.now();
  const {
    url,
    commentLimit = 20,
    extractFrames = true,
    maxFrames = 6,
    framesDir = "",
    envReport = null,
    sessdata = "",
    downloadVideo = true,
    keepVideo = false,
    maxVideoMinutes = 30,
    maxDownloadMb = 800,
    quality = 32,
    timestamps,
    detectScenes = true,
    sceneThreshold = 0.4,
    sharpFrames = true,
    asrProvider,
    asrFallback = true, // 旧字段别名：false 等价于 asrProvider: "none"
    crossCheckAsr = false, // B：字幕轨存在时，用第二路 ASR 再转一遍做交叉校验（慢，默认关）
    probeManualTrack = false, // 只有 AI 中文轨时多探几次人工 CC 轨（多约 2.4 秒，默认关）
    whisperBin = "whisper-cli",
    whisperModel = "medium",
    whisperModelDir = "",
    whisperLanguage = "zh",
    whisperThreads = 0,
    sherpaBin = "",
    sherpaModel = "",
    sherpaModelType = "sense-voice",
    sherpaTokens = "",
    sherpaThreads = 0,
    visionProvider = "none",
    visionBaseUrl = "",
    visionModel = "medium",
    visionApiKey = "",
    visionPrompt = "",
    visionPromptByModel = {},
    visionMaxFrames = 6,
    signal,
  } = options ?? {};

  const headers = {
    "User-Agent": USER_AGENT,
    Referer: REFERER,
    Accept: "application/json, text/plain, */*",
  };
  if (sessdata) headers.Cookie = "SESSDATA=" + sessdata;
  const session = { headers, signal };

  // 环境体检报告（首用排查）：id → 检查项；报告缺失时所有门禁关闭，行为与旧版一致
  const envChecks = new Map((envReport?.checks ?? []).map((c) => [c.id, c]));

  let bvid = parseBvid(url);
  if (!bvid && /b23\.tv/.test(String(url))) bvid = await resolveShortLink(session, url);
  if (!bvid) return { success: false, error: "cannot parse a Bilibili video id from the url" };

  let info;
  try {
    info = await getVideoInfo(session, bvid);
  } catch (error) {
    if (session.signal?.aborted) throw error;
    return { success: false, error: String(error?.message ?? error), bvid };
  }

  const baseDir = framesDir || join(tmpdir(), "dsh-bilibili");
  const outDir = join(baseDir, bvid);

  // 输出目录卫生：只清理默认临时目录下的历史 BV 目录（用户指定的 framesDir 不碰），后台执行不挡主流程
  if (!framesDir) pruneOutputDirs(baseDir, bvid).catch(() => {});

  let subtitle;
  let comments;
  let danmaku;
  [subtitle, comments, danmaku] = await Promise.all([
    guarded(() => getSubtitle(session, bvid, info.cid, { probeManualTrack }), emptySubtitle),
    guarded(() => getComments(session, info.aid, commentLimit), emptyComments),
    guarded(() => getDanmaku(session, info.cid), emptyDanmaku),
  ]);

  // 字幕时长守卫：B站偶发把别的视频的 AI 字幕挂到当前 BV 上（实测 18 秒视频先后返回过
  // 8 分半股市文稿和 4 分半钢化膜文稿）。命中后丢弃字幕、改走 ASR，避免模型把错文稿当正文。
  const guardedSubtitle = applySubtitleDurationGuard(subtitle, info.duration);
  subtitle = guardedSubtitle.subtitle;
  const subtitleWarning = guardedSubtitle.warning;

  // 环境体检：本地凭证已失效时，提前告知模型重新登录可拿到需要登录的字幕
  if (envChecks.get("credential-validity")?.status === "warn" && /require login/i.test(subtitle.note ?? "")) {
    subtitle = { ...subtitle, note: subtitle.note + " | 环境体检：本地 SESSDATA 已失效，重新扫码登录后可获取该字幕" };
  }

  // B：第二路 ASR 交叉校验（可选）。字幕轨存在时用必剪再转一遍，逐句比对，只标存疑、不改写。
  // 成本：bcut 直接按 URL 拉音频（不落本地），15 分钟视频约 30–60 秒；超过 60 分钟跳过。
  if (crossCheckAsr && subtitle.source === "subtitle" && (subtitle.segments?.length ?? 0) > 0 && info.duration <= 3600) {
    try {
      const audioUrl = await getAudioUrl(session, bvid, info.cid, quality);
      if (audioUrl) {
        const asr = await transcribeAudio(session, audioUrl, signal, { maxPolls: 12 });
        const cc = crossCheckTranscripts(subtitle.segments, asr.segments ?? [], { threshold: 0.55 });
        if (cc.compared > 0) {
          subtitle = {
            ...subtitle,
            asr_cross_check: { source: asr.source, compared: cc.compared, suspects: cc.suspects },
          };
        }
      }
    } catch (error) {
      if (session.signal?.aborted) throw error;
      subtitle = {
        ...subtitle,
        asr_cross_check_note: "asr cross-check skipped: " + String(error?.message ?? error).slice(-160),
      };
    }
  }

  // 无字幕轨 → ASR 兜底：默认必剪（bcut），可切 sherpa-onnx（中文推荐）/whisper-local；auto 依次降级 必剪→sherpa→whisper；文稿 7 天缓存
  const provider = asrProvider ?? (asrFallback === false ? "none" : "bcut");
  if (provider !== "none" && subtitle.text.length === 0 && subtitle.source === "none") {
    const transcriptCacheKey = [provider, whisperModel, whisperLanguage, sherpaModelType, sherpaModel].join("|");
    const cachedTranscript = await readTranscriptCache(outDir, transcriptCacheKey);
    if (cachedTranscript) {
      subtitle = cachedTranscript;
    } else {
      const whisperOpts = { whisperBin, whisperModel, whisperModelDir, whisperLanguage, whisperThreads };
      const sherpaOpts = { sherpaBin, sherpaModel, sherpaModelType, sherpaTokens, sherpaThreads };
      // 环境体检门禁：本地引擎未就绪时在下载音频之前跳过，避免白付下载/转码成本
      const envSkipReason = (ids) =>
        ids
          .map((id) => envChecks.get(id))
          .filter((c) => c && c.status !== "ok")
          .map((c) => c.label)
          .join("、");
      const skipWhisper = envReport !== null && ["whisper-bin", "whisper-model"].some((id) => {
        const c = envChecks.get(id);
        return c && c.status !== "ok";
      });
      const skipSherpa = envReport !== null && ["sherpa-bin", "sherpa-model", "sherpa-tokens"].some((id) => {
        const c = envChecks.get(id);
        return c && c.status !== "ok";
      });
      const asr = await guarded(async () => {
        if (provider === "whisper-local") {
          if (skipWhisper) {
            throw new Error("whisper-local 未就绪（环境体检：缺少 " +
              envSkipReason(["whisper-bin", "whisper-model"]) + "），未尝试下载音频");
          }
          return await transcribeWhisperLocal(session, bvid, info.cid, quality, outDir, whisperOpts, signal);
        }
        if (provider === "sherpa-onnx") {
          if (skipSherpa) {
            throw new Error("sherpa-onnx 未就绪（环境体检：缺少 " +
              envSkipReason(["sherpa-bin", "sherpa-model", "sherpa-tokens"]) + "），未尝试下载音频");
          }
          return await transcribeSherpaOnnx(session, bvid, info.cid, quality, outDir, sherpaOpts, signal);
        }
        try {
          const audioUrl = await getAudioUrl(session, bvid, info.cid, quality);
          if (!audioUrl) throw new Error("no dash audio stream");
          return await transcribeAudio(session, audioUrl, signal);
        } catch (error) {
          if (provider === "auto") {
            // 中文内容优先 sherpa-onnx，其次 whisper-local；逐级降级并累积失败原因
            const reasons = ["bcut: " + (error?.message ?? error)];
            if (skipSherpa) {
              reasons.push("sherpa-onnx: 环境体检未就绪（缺少 " +
                envSkipReason(["sherpa-bin", "sherpa-model", "sherpa-tokens"]) + "），跳过");
            } else {
              try {
                return await transcribeSherpaOnnx(session, bvid, info.cid, quality, outDir, sherpaOpts, signal);
              } catch (e2) {
                reasons.push("sherpa-onnx: " + (e2?.message ?? e2));
              }
            }
            if (skipWhisper) {
              reasons.push("whisper-local: 环境体检未就绪（缺少 " +
                envSkipReason(["whisper-bin", "whisper-model"]) + "），跳过");
            } else {
              try {
                return await transcribeWhisperLocal(session, bvid, info.cid, quality, outDir, whisperOpts, signal);
              } catch (e3) {
                reasons.push("whisper-local: " + (e3?.message ?? e3));
              }
            }
            throw new Error("auto ASR fallback failed → " + reasons.join(" → "));
          }
          throw error;
        }
      }, emptySubtitle);
      if (asr.text) {
        subtitle = asr;
        await writeTranscriptCache(outDir, asr, transcriptCacheKey);
      } else if (subtitle.note) {
        subtitle = { ...subtitle, note: subtitle.note + " | ASR fallback failed: " + (asr.note ?? "") };
      }
    }
  }

  // ASR 兜底可能整个替换了 subtitle（note 随之丢失），把错配警告合并回来
  if (subtitleWarning && !String(subtitle.note ?? "").includes(subtitleWarning)) {
    subtitle = {
      ...subtitle,
      note: subtitle.note ? subtitle.note + " | " + subtitleWarning : subtitleWarning,
    };
  }

  const frames = { enabled: false, strategy: "", mode: "none", frames: [], error: null, note: "" };
  const ffmpegCheck = envChecks.get("ffmpeg");
  const ffmpegBlocked = extractFrames && ffmpegCheck && (ffmpegCheck.status === "missing" || ffmpegCheck.status === "error");
  if (ffmpegBlocked) {
    // 环境体检门禁：ffmpeg 缺失时跳过视频下载与抓帧，避免白付流量（下载发生在任何 ffmpeg 调用之前）
    frames.enabled = true;
    frames.mode = "none";
    frames.strategy = "skipped: ffmpeg unavailable";
    frames.error = "ffmpeg 不可用（环境体检：" + (ffmpegCheck.detail ?? ffmpegCheck.status) + "）";
    frames.note = ffmpegCheck.hint ?? "安装 FFmpeg 后重试；本次已跳过视频下载与抓帧";
  } else if (extractFrames) {
    try {
      const requestedPlan = normalizeRequestedTimestamps(timestamps, info.duration, maxFrames, subtitle.segments);
      const streamUrl = await getStreamUrl(session, bvid, info.cid, quality);
      await mkdir(outDir, { recursive: true });
      const withinDurationCap = info.duration <= maxVideoMinutes * 60;
      let plan;
      let scenePeaks = [];
      let captured;
      if (downloadVideo && withinDurationCap && streamUrl) {
        // 先下载整段视频到本地（缓存复用），再从本地文件抓帧：快、准、可重复
        const { path: videoPath, bytes, reused } = await ensureVideo(session, streamUrl, outDir, maxDownloadMb * 1048576);
        // 自动兜底计划（纯画面信号：场景峰值优先，均匀间隔补齐）；定向抓帧不跑全片场景检测
        const autoPlan = requestedPlan ?? selectKeyframeTimestamps(subtitle.segments, info.duration, maxFrames, []);
        const needScenePass = requestedPlan === null && detectScenes;
        if (needScenePass) {
          try {
            scenePeaks = await detectScenePeaks(
              videoPath, outDir, sceneThreshold, signal,
              info.duration > SCENE_DETECT_MAX_SECONDS, // 超 20 分钟：抽样式（每 60 帧解 1 帧）
            );
          } catch { /* best-effort */ }
        }
        plan = requestedPlan ?? (scenePeaks.length > 0
          ? selectKeyframeTimestamps(subtitle.segments, info.duration, maxFrames, scenePeaks)
          : autoPlan);
        // Agent 定向的时间点：用 ffmpeg 场景检测在附近 ±4s 对齐到画面变化最明显的帧（语义定位 + 画面精修）
        if (requestedPlan !== null) {
          const aligned = [];
          for (const item of requestedPlan) {
            const peak = detectScenes
              ? await detectScenePeaksInWindow(videoPath, item.time, 4, outDir, signal).catch(() => null)
              : null;
            if (peak && Math.abs(peak.time - item.time) <= 4) {
              aligned.push({ ...item, time: Math.round(peak.time * 10) / 10, reason: item.reason + " (scene-aligned)" });
            } else {
              aligned.push(item);
            }
          }
          plan = aligned;
        }
        // 清晰帧优选：在目标时间点 ±1.5s 内用 blurdetect 选最清晰的帧（避开动画入场/运动模糊）
        if (sharpFrames) {
          const sharpPlan = [];
          for (const item of plan) {
            const sharpTime = await findSharpestTime(videoPath, item.time, SHARP_HALF_WINDOW, outDir, signal).catch(() => null);
            if (sharpTime !== null && Math.abs(sharpTime - item.time) <= SHARP_HALF_WINDOW) {
              const moved = Math.abs(sharpTime - item.time) >= 0.1;
              sharpPlan.push({
                ...item,
                time: Math.round(sharpTime * 10) / 10,
                reason: moved ? item.reason + " (sharpest)" : item.reason,
              });
            } else {
              sharpPlan.push(item);
            }
          }
          plan = sharpPlan;
        }
        captured = await extractFramesFromFile(videoPath, plan, outDir, signal);
        frames.mode = "local";
        frames.note = reused
          ? "reused cached video, frames extracted from the local file"
          : "downloaded " + Math.round(bytes / 1048576) + " MB video, frames extracted from the local file";
        // 定向抓帧说明模型在迭代分析，保留缓存供后续调用复用（keepVideo=true 则永久保留）
        if (!keepVideo && requestedPlan === null) await rm(videoPath, { force: true });
      } else {
        plan = requestedPlan ?? selectKeyframeTimestamps(subtitle.segments, info.duration, maxFrames, []);
        captured = await captureFrames(streamUrl, plan, outDir, signal);
        frames.mode = "remote";
        if (!streamUrl) frames.note = "no playable stream url";
        else if (!withinDurationCap) frames.note = "video longer than maxVideoMinutes (" + maxVideoMinutes +
          " min) — per-frame remote extraction";
        else frames.note = "video download disabled by config";
      }
      if (plan.length > 0) {
        frames.enabled = true;
        frames.strategy = requestedPlan !== null
          ? "requested timestamps"
          : scenePeaks.length > 0
            ? "scene-change peaks + even backfill"
            : "even-interval backfill";
        frames.frames = captured.map((f) => ({
          time: f.time,
          requested_time: f.requested_time ?? null,
          reason: f.reason,
          subtitle_text: f.text,
          has_image: Boolean(f.path),
          path: f.path ?? null,
          error: f.error ?? null,
          description: "",
          vision_error: null,
          citation_hint: "",
        }));
      } else {
        frames.enabled = true;
        frames.mode = "none";
        frames.strategy = "no timestamps selected";
      }
    } catch (error) {
      // 保留 enabled=true 并附上原因：否则 formatExtraction 不渲染 Keyframes 段，
      // 模型会误以为「这视频没有画面」，而真实原因是下载/ffmpeg 失败。
      frames.enabled = true;
      frames.frames = [];
      frames.strategy = frames.strategy || "failed";
      frames.error = String(error?.message ?? error);
      frames.note = "抓帧失败；可用 timestamps 指定时刻重试，或稍后重试（下载/ffmpeg 可能超时）";
    }
  }

  // 可选视觉描述：把帧图交给视觉模型（本地 Ollama / OpenAI 兼容云端），画面内容转文字，供无视觉能力的主模型使用
  if (visionProvider !== "none" && frames.enabled && frames.frames.length > 0) {
    const visionOpts = {
      provider: visionProvider,
      baseUrl: visionBaseUrl,
      model: visionModel,
      apiKey: visionApiKey,
      prompt: visionPrompt,
      promptByModel: visionPromptByModel,
      maxFrames: visionMaxFrames,
    };
    try {
      const described = await describeFramesWithVision(frames.frames, visionOpts, signal);
      let index = 0;
      let okCount = 0;
      for (const frame of frames.frames) {
        if (frame.has_image && frame.path && index < described.length) {
          const d = described[index++];
          frame.description = d.description;
          frame.vision_error = d.vision_error;
          frame.citation_hint = d.citation_hint ?? "";
          if (d.description) okCount++;
        }
      }
      frames.note = (frames.note ? frames.note + " | " : "") +
        "vision: described " + okCount + "/" + described.length + " frames via " +
        visionProvider + "/" + (resolveVisionModel(visionModel) ?? visionModel);
    } catch (error) {
      if (signal?.aborted) throw error;
      frames.note = (frames.note ? frames.note + " | " : "") +
        "vision: failed — " + String(error?.message ?? error).slice(-140);
    }
  }

  const elapsed = Math.round((Date.now() - started) / 10) / 100;
  return {
    success: true,
    bvid,
    elapsed_seconds: elapsed,
    metadata: {
      title: info.title,
      description: info.description,
      uploader: info.uploader,
      duration: info.duration,
      pubdate: info.pubdate,
      cover: info.cover,
      category: info.category,
      pages: info.pages,
      stats: info.stats,
    },
    transcript: subtitle,
    comments,
    danmaku,
    frames,
  };
}


/** 仅供单元测试使用的内部入口（不对外承诺稳定性）。 */
export const __test__ = { mapLimit, pruneOutputDirs, dirSize, FRAME_CONCURRENCY, VISION_CONCURRENCY, flattenTranscript, charDiff, getAudioUrl, transcribeAudio };
