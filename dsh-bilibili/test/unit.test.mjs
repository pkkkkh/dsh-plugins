// dsh-bilibili 单元测试（零依赖，不联网）：纯函数覆盖
// 运行：node --test test/   （或 npm test）
// 网络相关（真实提取/ASR/ffmpeg）不在此套件内，保留为手动验证。

import { test } from "node:test";
import assert from "node:assert/strict";
import { selectKeyframeTimestamps, formatTime } from "../lib/keyframes.js";
import { parseSubtitleBody, nearestSubtitleText, guessStreamExt, parseWhisperTime, parseWhisperJson, resolveWhisperModel, parseSherpaText, parseSherpaResults, buildWhisperArgs, buildSherpaArgs, resolveVisionModel, buildVisionRequest, parseChatCompletion, DEFAULT_VISION_PROMPT, resolveVisionBaseUrl, resolveVisionPrompt, parseCitationHint, VISION_PROMPT_SHORT, pickNearestPeak, parseBlurMetadata, normalizeRequestedTimestamps, isEmptySubtitleList, retryWhileEmpty, EMPTY_SUBTITLE_RETRY_DELAYS, mergeSubtitleLists, lacksManualChineseTrack } from "../lib/extractor.js";
import { formatExtraction, capTranscriptSmart, pickDanmakuPeaks, formatEnvironment, renderEnvReport } from "../lib/format.js";
import { summarizeChecks, ASR_PROVIDERS, spawnCheck } from "../lib/envcheck.js";
import { buildDigest } from "../lib/digest.js";
import { __test__ as extractorInternals, pickSubtitleTracks, crossCheckTranscripts, lcsRatio, isAiSubtitleTrack, readTranscriptCache, writeTranscriptCache, maxSubtitleEnd, subtitleDurationMismatch, applySubtitleDurationGuard } from "../lib/extractor.js";
import { detectAdSegments } from "../lib/ads.js";
import { probeTranscript } from "../lib/channel.js";
import { readFileSync, existsSync } from "node:fs";
import { mkdir, mkdtemp, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const SUBTITLE_SEGS = [
  { start: 0, end: 5, text: "大家好今天聊聊" },
  { start: 30, end: 35, text: "如图所示的界面" },
];

const SCENE_PEAKS = [
  { time: 12, reason: "scene change", text: "" },
  { time: 33, reason: "scene change", text: "" },
  { time: 60, reason: "scene change", text: "" },
];

test("自动选帧：场景峰保留 + 排序 + 封顶", () => {
  const plan = selectKeyframeTimestamps(SUBTITLE_SEGS, 120, 5, SCENE_PEAKS);
  assert.equal(plan.length, 5, "capped at maxFrames");
  assert.ok(plan.some((p) => p.reason === "scene change"), "scene peaks kept");
  for (let i = 1; i < plan.length; i++) {
    assert.ok(plan[i].time > plan[i - 1].time, "sorted ascending");
  }
});

test("自动选帧：补齐（有场景峰时按空档补）", () => {
  const plan = selectKeyframeTimestamps(SUBTITLE_SEGS, 120, 5, SCENE_PEAKS);
  assert.ok(plan.some((p) => p.reason === "gap backfill"), "backfill present");
});

test("自动选帧：不做关键词猜测（语义判断交给主 Agent）", () => {
  const plan = selectKeyframeTimestamps(
    [{ start: 0, end: 5, text: "如图所示的界面展示对比数据，看这里，就是它" }],
    60, 3, [],
  );
  assert.ok(!plan.some((p) => p.reason.includes("subtitle")), "no keyword-based picks");
  assert.ok(plan.every((p) => p.reason === "even interval"), "only even backfill without scene signal");
});

test("无字幕：场景峰优先 + 均匀补齐", () => {
  const plan = selectKeyframeTimestamps([], 100, 3, SCENE_PEAKS);
  assert.equal(plan.length, 3, "capped");
  assert.ok(plan.some((p) => p.reason === "scene change"), "peaks kept");
});

test("全空输入不崩溃", () => {
  assert.deepEqual(selectKeyframeTimestamps([], 0, 6), []);
  assert.deepEqual(selectKeyframeTimestamps(undefined, 10, 3), []);
});

test("formatTime", () => {
  assert.equal(formatTime(75), "01:15");
  assert.equal(formatTime(0), "00:00");
  assert.equal(formatTime(3661), "61:01");
  assert.equal(formatTime(5), "00:05", "秒也补零，与文稿骨架时间码一致");
});

test("parseSubtitleBody：跳空段 + 拼文", () => {
  const parsed = parseSubtitleBody({
    body: [
      { from: 0, to: 4, content: "第一句" },
      { from: 5, to: 9, content: "   " },
      { from: 10, to: 14, content: "第二句" },
    ],
  });
  assert.equal(parsed.segments.length, 2, "blank skipped");
  assert.equal(parsed.text, "第一句\n第二句");
  assert.deepEqual(parsed.segments[1], { start: 10, end: 14, text: "第二句" });
});

test("nearestSubtitleText：±2s 窗口", () => {
  assert.equal(nearestSubtitleText(32, SUBTITLE_SEGS), "如图所示的界面");
  assert.equal(nearestSubtitleText(70, SUBTITLE_SEGS), "", "far away -> empty");
  assert.equal(nearestSubtitleText(32, undefined), "", "no segments -> empty");
});

test("guessStreamExt", () => {
  assert.equal(guessStreamExt("https://x.com/a.m3u8?token=1"), ".m3u8");
  assert.equal(guessStreamExt("https://x.com/a.mp4"), ".mp4");
  assert.equal(guessStreamExt("https://x.com/a.m4s"), ".mp4");
  assert.equal(guessStreamExt("https://x.com/a.flv"), ".flv");
  assert.equal(guessStreamExt("https://x.com/unknown"), ".flv", "default flv");
});

test("formatExtraction：失败分支", () => {
  const text = formatExtraction({ success: false, error: "cannot parse" });
  assert.ok(text.includes("cannot parse"));
});

test("formatExtraction：成功摘要关键元素", () => {
  const value = {
    success: true, bvid: "BVTEST", elapsed_seconds: 1.2,
    metadata: { title: "测试视频", uploader: { name: "up" }, duration: 60, category: "科技", pages: 1, description: "-", stats: {} },
    transcript: { source: "subtitle", language: "zh", text: "你好", segments: [], total_segments: 1, note: "" },
    comments: { total: 0, fetched: 0, comments: [], note: "" },
    danmaku: { total: 0, top_messages: [], samples: [], note: "" },
    frames: { enabled: true, strategy: "requested timestamps", mode: "local", note: "cache", frames: [{ time: 12, reason: "requested timestamp", subtitle_text: "如图", has_image: true, path: "C:/t.jpg", error: null }], error: null },
  };
  const text = formatExtraction(value);
  assert.ok(text.includes("测试视频"), "title");
  assert.ok(text.includes("BVTEST"), "bvid");
  assert.ok(text.includes("read_image"), "read_image hint");
  assert.ok(text.includes("capture mode: local"), "mode line");
  assert.ok(text.includes("C:/t.jpg"), "frame path");
});

test("parseWhisperTime：MM:SS,mmm 与 HH:MM:SS,mmm", () => {
  assert.equal(parseWhisperTime("00:01:15,500"), 75.5);
  assert.equal(parseWhisperTime("01:15,500"), 75.5);
  assert.equal(parseWhisperTime("00:00:00,000"), 0);
  assert.equal(parseWhisperTime("bad"), undefined);
});

test("parseWhisperJson：offsets(毫秒) → 秒 + 跳空段", () => {
  const segs = parseWhisperJson({
    transcription: [
      { text: " 第一句 ", offsets: { from: 0, to: 520 } },
      { text: "第二句", offsets: { from: 1000, to: 2500 } },
      { text: "   ", offsets: { from: 2500, to: 2600 } },
    ],
  });
  assert.equal(segs.length, 2, "blank skipped");
  assert.deepEqual(segs[0], { start: 0, end: 0.52, text: "第一句" });
  assert.deepEqual(segs[1], { start: 1, end: 2.5, text: "第二句" });
});

test("parseWhisperJson：无 offsets 时回退解析 timestamps", () => {
  const segs = parseWhisperJson({
    transcription: [{ text: "你好", timestamps: { from: "00:00:03,000", to: "00:00:05,000" } }],
  });
  assert.deepEqual(segs, [{ start: 3, end: 5, text: "你好" }]);
});

test("resolveWhisperModel：低中高三档映射", () => {
  assert.ok(resolveWhisperModel("low", "", "").endsWith("ggml-small.bin"), "low → small");
  assert.ok(resolveWhisperModel("medium", "", "").endsWith("ggml-medium.bin"), "medium → medium");
  assert.ok(resolveWhisperModel("high", "", "").endsWith("ggml-large-v3.bin"), "high → large-v3");
  assert.ok(resolveWhisperModel("large-v3", "", "").endsWith("ggml-large-v3.bin"), "large-v3 literal");
});

test("resolveWhisperModel：目录拼接与字面路径", () => {
  assert.equal(resolveWhisperModel("medium", "D:/models", "").replace(/\\/g, "/"), "D:/models/ggml-medium.bin");
  assert.equal(resolveWhisperModel("C:/x/my.bin", "", ""), "C:/x/my.bin", "literal path kept");
  assert.equal(resolveWhisperModel("small", "", "D:/whisper/whisper-cli.exe").replace(/\\/g, "/"), "D:/whisper/models/ggml-small.bin");
  assert.equal(resolveWhisperModel("", "", ""), undefined, "empty → undefined");
});

test("parseSherpaText：带时间戳行（--> / - / 方括号）", () => {
  const segs = parseSherpaText([
    "00:00:00.000 --> 00:00:02.400: 第一句",
    "00:00:02.400 - 00:00:05.000  第二句",
    "[00:00:05.000 --> 00:00:07.000] 第三句",
  ].join("\n"));
  assert.equal(segs.length, 3);
  assert.deepEqual(segs[0], { start: 0, end: 2.4, text: "第一句" });
  assert.deepEqual(segs[1], { start: 2.4, end: 5, text: "第二句" });
  assert.deepEqual(segs[2], { start: 5, end: 7, text: "第三句" });
});

test("parseSherpaText：无时间戳回退为单段", () => {
  assert.deepEqual(parseSherpaText("你好 世界"), [{ start: 0, end: 0, text: "你好 世界" }]);
  assert.deepEqual(parseSherpaText(""), []);
});

test("resolveVisionModel：低中高三档映射与显式名透传", () => {
  assert.equal(resolveVisionModel("low"), "qwen3-vl:2b");
  assert.equal(resolveVisionModel("medium"), "qwen3-vl:4b");
  assert.equal(resolveVisionModel("high"), "qwen3-vl:8b");
  assert.equal(resolveVisionModel("large"), "qwen3-vl:8b", "large alias -> 8b");
  assert.equal(resolveVisionModel("qwen3-vl:4b"), "qwen3-vl:4b", "explicit 4b tag kept");
  assert.equal(resolveVisionModel("minicpm-v"), "minicpm-v", "explicit name kept");
  assert.equal(resolveVisionModel("gpt-4o-mini"), "gpt-4o-mini", "cloud id kept");
  assert.equal(resolveVisionModel(""), undefined, "empty -> undefined");
});

test("buildVisionRequest：base64 data URL + model/prompt + apiKey header", () => {
  const bytes = Buffer.from("fakejpeg");
  const req = buildVisionRequest(bytes, { model: "medium", prompt: "", apiKey: "" });
  assert.equal(req.body.model, "qwen3-vl:4b", "tier resolved (medium -> 4b)");
  assert.ok(req.body.messages[0].content[1].image_url.url.startsWith("data:image/jpeg;base64,"), "data url");
  assert.equal(req.body.messages[0].content[1].image_url.url, "data:image/jpeg;base64," + bytes.toString("base64"), "base64 correct");
  assert.equal(req.body.messages[0].content[0].text, DEFAULT_VISION_PROMPT, "default prompt used");
  assert.equal(req.headers.Authorization, undefined, "no key -> no auth header");

  const withKey = buildVisionRequest(bytes, { model: "gpt-4o-mini", prompt: "看图", apiKey: "sk-test" });
  assert.equal(withKey.body.model, "gpt-4o-mini", "explicit model kept");
  assert.equal(withKey.body.messages[0].content[0].text, "看图", "custom prompt used");
  assert.equal(withKey.headers.Authorization, "Bearer sk-test", "auth header present");
});

test("parseChatCompletion：OpenAI 格式解析与容错", () => {
  assert.equal(parseChatCompletion({ choices: [{ message: { content: " 画面描述 " } }] }), "画面描述");
  assert.equal(parseChatCompletion({ choices: [] }), "", "no choices -> empty");
  assert.equal(parseChatCompletion({}), "", "empty json -> empty");
  assert.equal(parseChatCompletion(null), "", "null -> empty");
});

test("resolveVisionBaseUrl：provider 默认地址与显式地址", () => {
  assert.equal(resolveVisionBaseUrl("ollama", ""), "http://localhost:11434/v1", "ollama default");
  assert.equal(resolveVisionBaseUrl("llama-cpp", ""), "http://localhost:8080/v1", "llama-cpp default");
  assert.equal(resolveVisionBaseUrl("openai-compatible", ""), "", "cloud needs explicit url");
  assert.equal(resolveVisionBaseUrl("ollama", "http://10.0.0.5:9999/v1/"), "http://10.0.0.5:9999/v1", "explicit url kept, trailing slash trimmed");
});

test("pickNearestPeak：取距离中心最近的场景峰", () => {
  const peaks = [{ time: 10 }, { time: 13.2 }, { time: 16 }];
  assert.equal(pickNearestPeak(peaks, 14).time, 13.2, "nearest peak picked");
  assert.equal(pickNearestPeak([], 14), null, "empty -> null");
  assert.equal(pickNearestPeak(peaks, NaN), null, "bad center -> null");
});

test("normalizeRequestedTimestamps：输出带 requested_time 原值", () => {
  const segs = [{ start: 0, end: 5, text: "第一句" }];
  const plan = normalizeRequestedTimestamps([3.2, 40], 120, 6, segs);
  assert.equal(plan.length, 2);
  assert.equal(plan[0].time, 3.2);
  assert.equal(plan[0].requested_time, 3.2, "requested_time keeps the original value");
  assert.equal(plan[0].reason, "requested timestamp");
  assert.equal(plan[0].text, "第一句", "subtitle caption still works");
  assert.equal(normalizeRequestedTimestamps([], 120, 6, segs), null);
  assert.equal(normalizeRequestedTimestamps([999], 120, 6, segs), null, "out of range -> null");
});

test("normalizeRequestedTimestamps：5 秒去重", () => {
  const plan = normalizeRequestedTimestamps([10.0, 10.2, 10.4, 40], 120, 6, []);
  assert.equal(plan.length, 2, "near duplicates dropped");
  assert.deepEqual(plan.map((p) => p.time), [10, 40], "keeps first of each cluster, sorted ascending");
  assert.deepEqual(plan.map((p) => p.requested_time), [10, 40], "requested_time survives dedupe");
});

test("parseBlurMetadata：解析模糊分并选出最清晰帧", () => {
  const text = [
    "frame:0 pts:0 pts_time:0",
    "lavfi.blur=40.5",
    "frame:1 pts:33 pts_time:0.0333125",
    "lavfi.blur=8.2",
    "frame:2 pts:66 pts_time:0.0666875",
    "lavfi.blur=12.1",
  ].join("\n");
  const entries = parseBlurMetadata(text, 100);
  assert.equal(entries.length, 3, "3 frames parsed");
  assert.deepEqual(entries[0], { time: 100, blur: 40.5 }, "time offset applied");
  const sharpest = [...entries].sort((a, b) => a.blur - b.blur)[0];
  assert.equal(sharpest.blur, 8.2, "min blur = sharpest");
  assert.equal(parseBlurMetadata("", 0).length, 0, "empty input");
});

test("capTranscriptSmart：长文稿保骨架（覆盖全片 + 时间码）", () => {
  const segs = [];
  let text = "";
  for (let i = 0; i < 100; i++) {
    segs.push({ start: i * 60, end: i * 60 + 10, text: "第" + i + "段内容" });
    text += ("第" + i + "段内容").repeat(20);
  }
  const out = capTranscriptSmart(segs, text, 8000);
  assert.ok(out.length < text.length, "compressed");
  assert.ok(out.includes("文稿骨架"), "digest header");
  assert.ok(/\[\d\d:\d\d\]/.test(out), "index entries with MM:SS timestamps");
  assert.ok(/\[9\d:\d\d\]/.test(out), "late-section bucket head discoverable in index");
});

test("buildDigest：超上限按整句回退，不切半句（回归）", () => {
  const segs = [];
  let text = "";
  for (let i = 0; i < 300; i++) {
    const s = "这是第" + i + "个要点，内容写长一点用来撑满字数。";
    segs.push({ start: i * 4, end: i * 4 + 4, text: s });
    text += s;
  }
  const cap = 900;
  const out = buildDigest(segs, text, cap);
  const lines = out.split("\n");
  assert.ok(lines.length > 2, "has header + entries");
  const entries = lines.slice(1);
  assert.ok(entries.every((l) => /^\[\d\d:\d\d\] /.test(l)), "每条都带 MM:SS 时间码");
  assert.ok(entries.every((l) => l.endsWith("。")), "最后一条也是完整句子（旧实现 slice 会切半句）");
  assert.ok(out.length <= cap + 200, "不超上限");
});

test("pickDanmakuPeaks：密度峰采样（片头弹幕不霸榜）", () => {
  const samples = [];
  for (let i = 0; i < 40; i++) samples.push({ time: i, text: "来了" + i });
  for (let i = 0; i < 10; i++) samples.push({ time: 300 + i, text: "高能" + i });
  const picked = pickDanmakuPeaks(samples, 60, 4, 30);
  assert.ok(picked.length <= 30, "capped");
  assert.ok(picked.some((s) => s.text.startsWith("高能")), "peak window included");
});

test("pickDanmakuPeaks：异常时间戳不构造空循环（回归）", () => {
  const samples = [
    { time: 0, text: "开头" },
    { time: 1e9, text: "脏数据" },
    { time: 30, text: "正常" },
  ];
  const t0 = Date.now();
  const picked = pickDanmakuPeaks(samples, 60, 4, 30);
  assert.ok(Date.now() - t0 < 2000, "returns fast (旧实现会 for 到 1e9/60 轮)");
  assert.ok(picked.length <= 30, "capped");
  assert.equal(picked.length, 3, "all three samples kept");
});
test("resolveVisionPrompt：优先级链与分模型选择", () => {
  assert.equal(resolveVisionPrompt("qwen3-vl:8b", "", {}), DEFAULT_VISION_PROMPT, "default family");
  assert.equal(resolveVisionPrompt("low", "", {}), VISION_PROMPT_SHORT, "low tier -> short");
  assert.equal(resolveVisionPrompt("qwen3-vl:2b", "", {}), VISION_PROMPT_SHORT, "2b model -> short");
  const mp = resolveVisionPrompt("minicpm-v:8b-2.6-q6_K", "", {});
  assert.ok(mp.includes("结论"), "minicpm family prompt used");
  const en = resolveVisionPrompt("moondream2", "", {});
  assert.ok(/citation: suitable/i.test(en), "moondream2 gets english prompt");
  // 用户覆盖优先级：显式模型名 > 档位 > 全局
  assert.equal(resolveVisionPrompt("qwen3-vl:4b", "全局覆盖", {}), "全局覆盖");
  assert.equal(resolveVisionPrompt("qwen3-vl:4b", "全局覆盖", { medium: "档位覆盖" }), "档位覆盖");
  assert.equal(resolveVisionPrompt("qwen3-vl:8b", "全局覆盖", { "qwen3-vl:8b": "精确覆盖" }), "精确覆盖");
  // 数字边界回归：32b 不得被 "2b" 子串误判为低档（不应拿到短提示词）
  assert.equal(resolveVisionPrompt("qwen3-vl:32b", "", {}), DEFAULT_VISION_PROMPT, "32b -> detailed prompt, not short");
  assert.equal(resolveVisionPrompt("medium", "", {}), DEFAULT_VISION_PROMPT, "4b medium -> detailed prompt");
});

test("resolveVisionPrompt：内容理解而非逐字转录（无 OCR 指令）", () => {
  const p8 = resolveVisionPrompt("qwen3-vl:8b", "", {});
  assert.ok(p8.includes("不要逐字转录"), "default prompt forbids transcription");
  const mp = resolveVisionPrompt("minicpm-v:8b-2.6-q6_K", "", {});
  assert.ok(mp.includes("不要逐字转录"), "minicpm prompt forbids transcription");
  const sh = resolveVisionPrompt("low", "", {});
  assert.ok(!/转录|转写/.test(sh), "short prompt has no transcription demand at all");
  const en = resolveVisionPrompt("moondream2", "", {});
  assert.ok(/do not transcribe/i.test(en), "english prompt forbids transcription");
});

test("parseCitationHint：中英标记解析与容错", () => {
  assert.equal(parseCitationHint("描述内容...\n配图建议：适合"), "suitable");
  assert.equal(parseCitationHint("描述...\n配图建议: 不适合"), "unsuitable");
  assert.equal(parseCitationHint("desc...\ncitation: suitable"), "suitable");
  assert.equal(parseCitationHint("desc...\ncitation: UNSUITABLE"), "unsuitable");
  assert.equal(parseCitationHint("没有标记"), "");
  assert.equal(parseCitationHint(""), "");
});

test("buildVisionRequest：分模型提示词进入请求体", () => {
  const bytes = Buffer.from("fakejpeg");
  const req = buildVisionRequest(bytes, { model: "moondream2", prompt: resolveVisionPrompt("moondream2", "", {}) });
  assert.ok(/citation: suitable/i.test(req.body.messages[0].content[0].text), "resolved prompt in body");
});

// —— 环境体检（envcheck / formatEnvironment / renderEnvReport）——

test("summarizeChecks：各状态计数，未知状态忽略", () => {
  const summary = summarizeChecks([
    { status: "ok" }, { status: "ok" }, { status: "warn" }, { status: "missing" },
    { status: "unreachable" }, { status: "info" }, { status: "error" }, { status: "bogus" },
  ]);
  assert.deepEqual(summary, { ok: 2, info: 1, warn: 1, missing: 1, unreachable: 1, error: 1 });
  assert.deepEqual(summarizeChecks(null), { ok: 0, info: 0, warn: 0, missing: 0, unreachable: 0, error: 0 });
});

test("formatEnvironment：只列需要行动的项目，全部通过时一行带过", () => {
  const env = {
    checked_at: "2026-01-01T00:00:00.000Z",
    summary: { ok: 1, warn: 1, missing: 1 },
    checks: [
      { id: "ffmpeg", label: "FFmpeg", status: "missing", detail: "未找到", hint: "安装指引" },
      { id: "bcut", label: "必剪 ASR", status: "warn", detail: "受限", hint: "" },
      { id: "bili-api", label: "B站主 API", status: "ok", detail: "可达", hint: "" },
      { id: "credentials", label: "登录凭证", status: "info", detail: "未登录", hint: "可扫码" },
    ],
  };
  const lines = formatEnvironment(env);
  assert.ok(lines[0].includes("2 issue(s)"), "header counts actionable issues only");
  assert.ok(lines.some((l) => l.includes("FFmpeg")), "missing listed");
  assert.ok(lines.some((l) => l.includes("必剪 ASR")), "warn listed");
  assert.ok(!lines.some((l) => l.includes("B站主 API")), "ok not listed");
  assert.ok(!lines.some((l) => l.includes("登录凭证")), "info not listed in extraction digest");

  const allOk = formatEnvironment({ checked_at: "x", checks: [{ id: "a", status: "ok" }] });
  assert.ok(allOk[0].includes("all pass"), "all-pass header");
  assert.ok(allOk[1].includes("全部通过"), "all-pass line");
  assert.deepEqual(formatEnvironment(null), [], "no env -> empty section");
});

test("renderEnvReport：doctor 面向用户输出，含处理建议与状态中文名", () => {
  const text = renderEnvReport({
    checked_at: "2026-01-01T00:00:00.000Z",
    summary: { ok: 1, missing: 1, info: 1 },
    checks: [
      { id: "ffmpeg", label: "FFmpeg", status: "missing", detail: "未找到", hint: "winget install Gyan.FFmpeg" },
      { id: "credentials", label: "登录凭证", status: "info", detail: "未登录", hint: "可扫码登录" },
      { id: "bili-api", label: "B站主 API", status: "ok", detail: "可达", hint: "" },
    ],
  });
  assert.ok(text.includes("缺失"), "status rendered in Chinese");
  assert.ok(text.includes("winget install Gyan.FFmpeg"), "hint shown");
  assert.ok(text.includes("通过 1 项"), "summary line");
  const allOk = renderEnvReport({ checked_at: "x", summary: { ok: 3 }, checks: [{ status: "ok" }] });
  assert.ok(allOk.includes("全部检查通过"), "all-ok message");
});

test("ASR_PROVIDERS：与 extractor 行为一致的枚举", () => {
  assert.deepEqual(ASR_PROVIDERS, ["bcut", "sherpa-onnx", "whisper-local", "auto", "none"]);
});


test("自动选帧：场景峰多于上限时分散到全片，而不是挤在片头", () => {
  const peaks = Array.from({ length: 40 }, (_, i) => ({ time: 3 + i * 7, reason: "scene change", text: "" }));
  const plan = selectKeyframeTimestamps([], 1200, 6, peaks);
  assert.equal(plan.length, 6);
  assert.ok(plan.filter((p) => p.time < 60).length <= 1, "at most one frame in the first minute");
  assert.ok(plan[plan.length - 1].time > 900, "last frame reaches the end of the video");
});

test("自动选帧：有场景峰时按最大空档补齐", () => {
  const plan = selectKeyframeTimestamps([], 600, 4, [{ time: 20, reason: "scene change", text: "" }]);
  assert.equal(plan.length, 4);
  assert.ok(plan.some((p) => p.reason === "gap backfill"));
  assert.ok(plan[plan.length - 1].time > 400, "backfill covers the tail");
});

test("buildWhisperArgs：-oj 搭配 -of，JSON 写到文件而不是 stdout", () => {
  const args = buildWhisperArgs({ modelPath: "m.bin", language: "zh", wavPath: "a.wav", outBase: "/tmp/x/whisper", threads: 4 });
  assert.deepEqual(args, ["-m", "m.bin", "-l", "zh", "-oj", "-of", "/tmp/x/whisper", "-np", "-f", "a.wav", "-t", "4"]);
  assert.ok(!buildWhisperArgs({ modelPath: "m", language: "zh", wavPath: "a", outBase: "o" }).includes("-t"));
});

test("buildSherpaArgs：按模型类型选 flag，wav 作为位置参数", () => {
  assert.deepEqual(
    buildSherpaArgs({ modelType: "sense-voice", model: "model.onnx", tokens: "tokens.txt", threads: 2, wavPaths: ["c0.wav", "c1.wav"] }),
    ["--sense-voice-model=model.onnx", "--tokens=tokens.txt", "--num-threads=2", "c0.wav", "c1.wav"],
  );
  assert.equal(buildSherpaArgs({ modelType: "paraformer", model: "p.onnx", tokens: "t", wavPaths: ["a.wav"] })[0], "--paraformer=p.onnx");
  assert.equal(buildSherpaArgs({ modelType: "zipformer2-ctc", model: "z.onnx", tokens: "t", wavPaths: ["a.wav"] })[0], "--zipformer-ctc-model=z.onnx");
  assert.throws(() => buildSherpaArgs({ modelType: "bogus", model: "m", tokens: "t", wavPaths: [] }), /unsupported sherpaModelType/);
});

test("parseSherpaResults：逐块 JSON 结果 → 带偏移的句段", () => {
  const stdout = [
    JSON.stringify({ lang: "<|zh|>", text: "大家好。今天", timestamps: [0.1, 0.3, 0.5, 0.6, 2.0, 2.2], tokens: ["大", "家", "好", "。", "今", "天"] }),
    JSON.stringify({ text: "第二块", timestamps: [1.0, 1.2, 1.4], tokens: ["第", "二", "块"] }),
    JSON.stringify({ text: "没有时间戳", timestamps: [], tokens: [] }),
  ].join("\n");
  const segs = parseSherpaResults(stdout, 30);
  assert.deepEqual(segs.map((s) => s.text), ["大家好。", "今天", "第二块", "没有时间戳"]);
  assert.equal(segs[0].start, 0.1);
  assert.equal(segs[2].start, 31, "second chunk offset by 30s");
  assert.equal(segs[3].start, 60, "untimed chunk falls back to its chunk window");
  assert.deepEqual(parseSherpaResults("Done!\nnot json"), []);
});

test("parseSherpaResults：BPE 词首符号转空格、特殊标签去掉", () => {
  const stdout = JSON.stringify({ text: "hello world", timestamps: [0, 0.2, 0.4], tokens: ["<|en|>", "\u2581hello", "\u2581world"] });
  assert.deepEqual(parseSherpaResults(stdout).map((s) => s.text), ["hello world"]);
});

test("DSH 兼容：engines.dsh 覆盖 0.2.x，系统提示段落关闭插值", () => {
  const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
  assert.equal(typeof pkg.engines?.dsh, "string");
  assert.ok(pkg.engines.dsh.includes("<0.3.0-0"));
  const index = readFileSync(new URL("../lib/index.js", import.meta.url), "utf8");
  assert.ok(index.includes("interpolate: false"), "user template must not go through strict {{}} interpolation");
});

test("mapLimit：保持顺序 + 真的有界并发", async () => {
  let active = 0;
  let peak = 0;
  const out = await extractorInternals.mapLimit([1, 2, 3, 4, 5, 6], 3, async (x) => {
    active++;
    peak = Math.max(peak, active);
    await new Promise((r) => setTimeout(r, 20));
    active--;
    return x * 2;
  });
  assert.deepEqual(out, [2, 4, 6, 8, 10, 12], "顺序与输入一致");
  assert.ok(peak >= 2, "确实并发（peak=" + peak + "）");
  assert.ok(peak <= 3, "不超过上限（peak=" + peak + "）");
});

test("pruneOutputDirs：只清过期的 BV 目录（跳过当前 bvid 与非 BV 目录）", async () => {
  const base = await mkdtemp(join(tmpdir(), "dsh-bili-test-"));
  const mk = async (name) => {
    const p = join(base, name);
    await mkdir(p, { recursive: true });
    await writeFile(join(p, "x.bin"), Buffer.alloc(1024));
    return p;
  };
  const oldBv = await mk("BV1aaaaaaaaa");
  const keepBv = await mk("BV1bbbbbbbbb"); // 当前正在用
  const freshBv = await mk("BV1ccccccccc"); // 新目录
  const other = await mk("not-a-bv");
  const old = new Date(Date.now() - 10 * 3600 * 1000);
  await utimes(oldBv, old, old);
  await utimes(keepBv, old, old);

  const savedTtl = process.env.DSH_BILIBILI_CACHE_TTL_HOURS;
  const savedMax = process.env.DSH_BILIBILI_CACHE_MAX_MB;
  process.env.DSH_BILIBILI_CACHE_TTL_HOURS = "1";
  process.env.DSH_BILIBILI_CACHE_MAX_MB = "0";
  try {
    const r = await extractorInternals.pruneOutputDirs(base, "BV1bbbbbbbbb");
    assert.equal(r.removed, 1, "只删了一个");
    assert.ok(r.freedBytes > 0, "统计了释放字节");
    assert.ok(!existsSync(oldBv), "过期目录被删");
    assert.ok(existsSync(keepBv), "当前 bvid 保留");
    assert.ok(existsSync(freshBv), "新目录保留");
    assert.ok(existsSync(other), "非 BV 目录一律不碰");
  } finally {
    if (savedTtl === undefined) delete process.env.DSH_BILIBILI_CACHE_TTL_HOURS;
    else process.env.DSH_BILIBILI_CACHE_TTL_HOURS = savedTtl;
    if (savedMax === undefined) delete process.env.DSH_BILIBILI_CACHE_MAX_MB;
    else process.env.DSH_BILIBILI_CACHE_MAX_MB = savedMax;
    await rm(base, { recursive: true, force: true });
  }
});

// ---------- 商单识别 / 短文稿时间码 / AI 字幕质量告警 ----------

test("detectAdSegments：识别口播商单区间，正文段落不误判", () => {
  const segs = [];
  let t = 0;
  for (let i = 0; i < 20; i++) {
    segs.push({ start: t, end: t + 3, text: "这里是正文内容" + i });
    t += 3;
  }
  // 60 秒的带货口播
  const adTexts = [
    "这套洁面套装非常划算",
    "现在下单还有优惠券可以领",
    "评论区链接点进去就能购买",
    "品牌方说回购率连续三年第一",
    "点击下方链接领取专属优惠",
  ];
  for (const text of adTexts) {
    segs.push({ start: t, end: t + 5, text });
    t += 5;
  }
  for (let i = 0; i < 20; i++) {
    segs.push({ start: t, end: t + 3, text: "商单结束后的正文" + i });
    t += 3;
  }
  const ads = detectAdSegments(segs);
  assert.equal(ads.length, 1, "识别出一段商单");
  assert.ok(ads[0].start >= 60 && ads[0].start <= 70, "起点落在商单开头附近，实得 " + ads[0].start);
  assert.ok(ads[0].end - ads[0].start >= 15, "区间长度合理");
});

test("detectAdSegments：纯正文不产生商单", () => {
  const segs = [];
  for (let i = 0; i < 40; i++) segs.push({ start: i * 3, end: i * 3 + 3, text: "今天我们讲讲美国中期选举的结构与影响" });
  assert.equal(detectAdSegments(segs).length, 0, "正文不误判");
});

test("capTranscriptSmart：短文稿也带 [MM:SS]，商单折叠成标记", () => {
  const segs = [];
  let t = 0;
  for (let i = 0; i < 10; i++) {
    segs.push({ start: t, end: t + 2, text: "正常内容第" + i + "句，讲的是选举" });
    t += 2;
  }
  for (let i = 0; i < 8; i++) {
    segs.push({ start: t, end: t + 2, text: "下单优惠券评论区链接点击购买" });
    t += 2;
  }
  const text = segs.map((s) => s.text).join("");
  const ads = detectAdSegments(segs);
  const out = capTranscriptSmart(segs, text, 8000, 300, ads);
  assert.ok(/^\[\d\d:\d\d\] /m.test(out), "有 [MM:SS] 前缀");
  assert.ok(out.startsWith("[00:00] 正常内容第0句"), "第一条就是 00:00 的正文");
  assert.ok(ads.length > 0, "样例里确实有商单");
  assert.ok(out.includes("商单口播已折叠"), "商单被折叠成标记");
  assert.ok(!out.includes("下单优惠券评论区链接点击购买"), "商单原文不再出现在正文里");
});

test("probeTranscript：AI 直转字幕（无标点/乱码行）给出质量告警", () => {
  const lines = [];
  for (let i = 0; i < 80; i++) lines.push("这是没有标点的一行字幕内容第" + i + "句");
  lines.unshift("By the other with you tonian american president mr anta");
  const text = lines.join("\n");
  const segments = lines.map((t, i) => ({ start: i * 3, end: i * 3 + 2, text: t }));
  const r = probeTranscript({ text, segments, durationSec: 300 });
  assert.equal(r.channel, "text", "唯一率正常，通道仍判 text");
  assert.equal(r.quality.warn, true, "但要给质量告警");
  assert.ok(r.quality.suspects.some((s) => s.includes("无标点")), "命中无标点信号");
  assert.ok(r.quality.suspects.some((s) => s.includes("外文乱码")), "命中乱码行信号");
});

test("probeTranscript：正常带标点字幕不误报", () => {
  const lines = [];
  for (let i = 0; i < 60; i++) lines.push("今天我们来聊一聊中期选举的结果，以及它带来的影响。" + i);
  const text = lines.join("\n");
  const segments = lines.map((t, i) => ({ start: i * 3, end: i * 3 + 2, text: t }));
  const r = probeTranscript({ text, segments, durationSec: 300 });
  assert.equal(r.quality.warn, false, "不该告警");
});

// ---------- 双字幕轨：选轨优先级 + 交叉校验 ----------

test("pickSubtitleTracks：人工 CC 轨优先于 AI 轨（不再按列表顺序抓）", () => {
  const list = [
    { lan: "ai-zh", lan_name: "中文（自动生成）", subtitle_url: "//a.json" },
    { lan: "zh-Hans", lan_name: "中文（简体）", subtitle_url: "//b.json" },
    { lan: "en-US", lan_name: "English", subtitle_url: "//c.json" },
  ];
  const t = pickSubtitleTracks(list);
  assert.equal(t.primary.lan, "zh-Hans", "主轨选人工简体");
  assert.equal(t.secondary.lan, "ai-zh", "参考轨是 AI 轨");
});

test("pickSubtitleTracks：只有 AI 轨时照常使用，且没有参考轨", () => {
  const list = [{ lan: "ai-zh", lan_name: "中文（自动生成）", subtitle_url: "//a.json" }];
  const t = pickSubtitleTracks(list);
  assert.equal(t.primary.lan, "ai-zh");
  assert.equal(t.secondary, null);
  assert.equal(isAiSubtitleTrack(t.primary), true);
});

test("crossCheckTranscripts：逐句比对，只标存疑不改写", () => {
  const primary = [
    { start: 0, end: 4, text: "今天我们来聊聊中期选举的结果" },
    { start: 4, end: 8, text: "明朗拿到众议院过半就可以弹劾总统" },
    { start: 8, end: 12, text: "共和党在德州输掉了关键选区" },
  ];
  const reference = [
    { start: 0, end: 4, text: "今天我们来聊聊中期选举的结果" },
    { start: 4, end: 8, text: "民主党拿到众议院过半就可以弹劾总统" },
    { start: 8, end: 12, text: "共和党在德州输掉了关键选区" },
  ];
  const r = crossCheckTranscripts(primary, reference);
  assert.equal(r.compared, 3, "三句都参与比对");
  assert.equal(r.suspects.length, 1, "只有一句存疑");
  assert.equal(r.suspects[0].time, 4);
  assert.ok(r.suspects[0].primary.includes("明朗"));
  assert.ok(r.suspects[0].reference.includes("民主党"));
  assert.ok(r.suspects[0].similarity < 0.95);
});

test("crossCheckTranscripts：两轨完全一致时零存疑", () => {
  const segs = [
    { start: 0, end: 5, text: "同样的字幕内容在这里出现" },
    { start: 5, end: 10, text: "第二句话也完全一样没有差别" },
  ];
  const r = crossCheckTranscripts(segs, segs.map((s) => ({ ...s })));
  assert.equal(r.compared, 2);
  assert.equal(r.suspects.length, 0);
});

test("lcsRatio：完全一致为 1，无关为 0 附近", () => {
  assert.equal(lcsRatio("abcdef", "abcdef"), 1);
  assert.ok(lcsRatio("完全不同的两句话", "另外一些字") < 0.3);
});

test("formatExtraction：渲染第二路 ASR 交叉校验（B）", () => {
  const value = {
    success: true, bvid: "BVTEST", elapsed_seconds: 1,
    metadata: { title: "t", uploader: { name: "u" }, duration: 60, category: "", pages: 1, description: "-", stats: {} },
    transcript: {
      source: "subtitle", language: "中文（简体）", text: "一句话", total_segments: 1, note: "",
      segments: [{ start: 0, end: 2, text: "一句话" }],
      asr_cross_check: {
        source: "bcut-asr", compared: 10,
        suspects: [{ time: 4, primary: "明朗拿到众议院", reference: "民主党拿到众议院", similarity: 0.5 }],
      },
    },
    comments: { total: 0, fetched: 0, comments: [], note: "" },
    danmaku: { total: 0, top_messages: [], samples: [], note: "" },
    frames: { enabled: false },
  };
  const text = formatExtraction(value);
  assert.ok(text.includes("asr-cross-check"), "有 asr-cross-check 段");
  assert.ok(text.includes("bcut-asr"), "标注了第二路来源");
  assert.ok(text.includes("民主党拿到众议院"), "列出了 ASR 版本");
});

test("isEmptySubtitleList：只有「成功但空」算空，登录受限和报错都不算", () => {
  assert.equal(isEmptySubtitleList({ code: 0, data: { subtitle: { subtitles: [] } } }), true);
  assert.equal(isEmptySubtitleList({ code: 0, data: {} }), true);
  assert.equal(
    isEmptySubtitleList({ code: 0, data: { need_login_subtitle: true, subtitle: { subtitles: [] } } }),
    false,
    "需要登录时不该重试，应直接提示登录",
  );
  assert.equal(
    isEmptySubtitleList({ code: 0, data: { subtitle: { subtitles: [{ lan: "ai-zh" }] } } }),
    false,
  );
  assert.equal(isEmptySubtitleList({ code: -404 }), false, "接口报错交给 apiGet 自己重试");
});

test("retryWhileEmpty：限流空数组会重试，拿到轨立刻停", async () => {
  const empty = { code: 0, data: { subtitle: { subtitles: [] } } };
  const hit = { code: 0, data: { subtitle: { subtitles: [{ lan: "ai-zh", subtitle_url: "//x" }] } } };
  const waits = [];
  let calls = 0;
  const out = await retryWhileEmpty(async () => (++calls < 3 ? empty : hit), {
    sleep: async (ms) => waits.push(ms),
  });
  assert.equal(calls, 3);
  assert.deepEqual(waits, [EMPTY_SUBTITLE_RETRY_DELAYS[0], EMPTY_SUBTITLE_RETRY_DELAYS[1]]);
  assert.equal(out.data.subtitle.subtitles[0].lan, "ai-zh");
});

test("retryWhileEmpty：一直空就放弃，不会无限重试", async () => {
  const empty = { code: 0, data: { subtitle: { subtitles: [] } } };
  let calls = 0;
  const out = await retryWhileEmpty(
    async () => {
      calls += 1;
      return empty;
    },
    { sleep: async () => {} },
  );
  assert.equal(calls, 1 + EMPTY_SUBTITLE_RETRY_DELAYS.length);
  assert.equal(isEmptySubtitleList(out), true);
  assert.ok(EMPTY_SUBTITLE_RETRY_DELAYS.reduce((a, b) => a + b, 0) < 60000, "总等待要远小于 ASR 兜底");
});

test("retryWhileEmpty：需要登录的空列表不重试", async () => {
  let calls = 0;
  await retryWhileEmpty(
    async () => {
      calls += 1;
      return { code: 0, data: { need_login_subtitle: true, subtitle: { subtitles: [] } } };
    },
    { sleep: async () => {} },
  );
  assert.equal(calls, 1);
});

test("retryWhileEmpty：被取消后不再发请求", async () => {
  let calls = 0;
  let aborted = true;
  await retryWhileEmpty(
    async () => {
      calls += 1;
      return { code: 0, data: { subtitle: { subtitles: [] } } };
    },
    { sleep: async () => {}, isAborted: () => aborted },
  );
  assert.equal(calls, 1);
});

test("mergeSubtitleLists：同一条轨的不同签名 url 只保留一份", () => {
  // wbi 与 player/v2 对同一条 AI 轨给的是不同 url，按 url 去重会变成两条，
  // 交叉校验就成了「自己比自己」，所以必须按语言去重。
  const wbi = { code: 0, data: { subtitle: { subtitles: [{ lan: "ai-zh", lan_doc: "中文", subtitle_url: "//wbi-ai" }] } } };
  const plain = {
    code: 0,
    data: {
      subtitle: {
        subtitles: [
          { lan: "zh-CN", lan_doc: "中文（中国）", subtitle_url: "//cc" },
          { lan: "ai-zh", lan_doc: "中文", subtitle_url: "//plain-ai" },
        ],
      },
    },
  };
  const merged = mergeSubtitleLists(wbi, plain);
  assert.equal(merged.length, 2, "同语言同 lang_doc 的 AI 轨只留一份");
  assert.deepEqual(merged.map((s) => s.lan), ["ai-zh", "zh-CN"]);
  assert.equal(merged[0].subtitle_url, "//wbi-ai", "重复时保留 wbi 的 url");
});

test("mergeSubtitleLists：端点报错时只用另一边", () => {
  const ok = { code: 0, data: { subtitle: { subtitles: [{ lan: "zh-CN", subtitle_url: "//cc" }] } } };
  assert.equal(mergeSubtitleLists({ code: -1 }, ok).length, 1);
  assert.equal(mergeSubtitleLists(ok, { code: -1 }).length, 1);
  assert.equal(mergeSubtitleLists({ code: -1 }, { code: -1 }).length, 0);
});

test("lacksManualChineseTrack：只有 AI 中文轨时才值得再探人工轨", () => {
  const aiOnly = { code: 0, data: { subtitle: { subtitles: [{ lan: "ai-zh", ai_status: 2 }] } } };
  assert.equal(lacksManualChineseTrack(aiOnly), true, "只有 AI 中文轨 -> 再探");
  const mixed = {
    code: 0,
    data: { subtitle: { subtitles: [{ lan: "zh-Hans" }, { lan: "ai-zh", ai_status: 2 }] } },
  };
  assert.equal(lacksManualChineseTrack(mixed), false, "已有人工轨 -> 不用再探");
  const empty = { code: 0, data: { subtitle: { subtitles: [] } } };
  assert.equal(lacksManualChineseTrack(empty), false, "空列表归 isEmptySubtitleList 管");
  const enOnly = { code: 0, data: { subtitle: { subtitles: [{ lan: "ai-en", ai_status: 2 }] } } };
  assert.equal(lacksManualChineseTrack(enOnly), false, "没有中文轨就不探");
  assert.equal(lacksManualChineseTrack({ code: -1 }), false);
});

test("pickSubtitleTracks：参考轨排除繁体轨（简繁差异不是错字）", () => {
  const list = [
    { lan: "zh-Hans", lan_name: "中文（简体）", subtitle_url: "//hans" },
    { lan: "zh-Hant", lan_name: "中文（繁體）", subtitle_url: "//hant" },
  ];
  const picked = pickSubtitleTracks(list);
  assert.equal(picked.primary.lan, "zh-Hans");
  assert.equal(picked.secondary, null, "繁体轨不能当参考轨");
});

test("文稿缓存：换 ASR 引擎后不能复用旧文稿", async () => {
  const dir = await mkdtemp(join(tmpdir(), "dsh-bili-cache-"));
  try {
    const transcript = {
      text: "导出的文稿",
      segments: [{ start: 0, end: 1, text: "导出的文稿" }],
    };
    await writeTranscriptCache(dir, transcript, "bcut|medium|zh|sense-voice|");
    const hit = await readTranscriptCache(dir, "bcut|medium|zh|sense-voice|");
    assert.equal(hit.text, "导出的文稿");
    assert.equal("cache_key" in hit, false, "cache_key 不应泄漏到结果里");
    const miss = await readTranscriptCache(dir, "sherpa-onnx|medium|zh|sense-voice|");
    assert.equal(miss, null, "引擎不同必须未命中");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("formatExtraction：抓帧失败要显式告诉模型（不再静默省略 Keyframes 段）", () => {
  const text = formatExtraction({
    success: true,
    metadata: { title: "t", bvid: "BV1xx411c7mD", duration: 60 },
    transcript: { source: "subtitle", text: "hello", segments: [] },
    comments: { fetched: 0, total: 0, comments: [] },
    frames: {
      enabled: true,
      strategy: "failed",
      mode: "none",
      frames: [],
      error: "ffmpeg exited with code 1",
      note: "稍后重试",
    },
  });
  assert.match(text, /Keyframes/);
  assert.match(text, /ffmpeg exited with code 1/);
  assert.match(text, /稍后重试/);
});

test("spawnCheck：卡住的二进制会被超时 kill 掉", async () => {
  const started = Date.now();
  const state = await spawnCheck(process.execPath, ["-e", "setTimeout(() => {}, 60000)"], 300);
  assert.equal(state, "error");
  assert.ok(Date.now() - started < 5000, "应在超时后立刻返回，而不是等进程自己退出");
});

test("spawnCheck：不存在的二进制是 missing", async () => {
  assert.equal(await spawnCheck("definitely-not-a-real-binary-xyz", ["--help"], 1000), "missing");
});

test("maxSubtitleEnd：取最大结束时间，忽略非法分段", () => {
  assert.equal(maxSubtitleEnd([{ start: 1, end: 3 }, { start: 5, end: 7 }]), 7);
  assert.equal(maxSubtitleEnd([{ start: 9 }]), 9);
  assert.equal(maxSubtitleEnd([]), 0);
  assert.equal(maxSubtitleEnd(null), 0);
});

test("subtitleDurationMismatch：18 秒视频配 8 分半字幕判错配", () => {
  assert.equal(subtitleDurationMismatch([{ start: 0, end: 500 }], 18), true);
  assert.equal(subtitleDurationMismatch([{ start: 0, end: 20 }], 18), false, "20s 字幕配 18s 视频不算错配");
  assert.equal(subtitleDurationMismatch([], 18), false, "空字幕不算错配");
  assert.equal(subtitleDurationMismatch([{ start: 0, end: 10 }], 0), false, "视频时长未知时不判");
});

test("applySubtitleDurationGuard：命中就丢弃字幕并带告警", () => {
  const subtitle = {
    source: "subtitle",
    text: "股市文稿",
    segments: [{ start: 0, end: 500 }],
    total_segments: 1,
    note: "",
  };
  const out = applySubtitleDurationGuard(subtitle, 18);
  assert.equal(out.subtitle.source, "none", "丢弃后应改走 ASR 兜底");
  assert.equal(out.subtitle.text, "");
  assert.equal(out.subtitle.segments.length, 0);
  assert.match(out.warning, /已丢弃错配字幕/);
  assert.match(out.subtitle.note, /08:20/, "告警里应带字幕末段时间");
});

test("applySubtitleDurationGuard：正常字幕原样返回", () => {
  const subtitle = { source: "subtitle", text: "hi", segments: [{ start: 0, end: 10 }], note: "" };
  const out = applySubtitleDurationGuard(subtitle, 18);
  assert.equal(out.warning, "");
  assert.equal(out.subtitle, subtitle);
});
