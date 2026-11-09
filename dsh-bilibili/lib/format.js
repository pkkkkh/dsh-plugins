/**
 * Model-facing formatting of one extraction value. Bounded: the model gets
 * a readable digest (transcript capped, top comments/danmaku only) plus
 * absolute paths for every captured frame so it can read_image on demand.
 *
 * @module dsh-bilibili/format
 */

import { formatTime } from "./keyframes.js";
import { buildDigest } from "./digest.js";
import { probeTranscript } from "./channel.js";
import { detectAdSegments, inAdRanges } from "./ads.js";

const DIGEST_ON = process.env.DSH_BILIBILI_DIGEST !== "0";
const CHANNEL_PROBE_ON = process.env.DSH_BILIBILI_CHANNEL !== "0";
const ADS_ON = process.env.DSH_BILIBILI_ADS !== "0";

const TRANSCRIPT_CAP = 8000;
const COMMENT_CAP = 10;
const DANMAKU_MESSAGE_CAP = 10;
const DANMAKU_SAMPLE_CAP = 30;

/** 环境体检状态的中文展示名（bilibili_doctor 面向用户渲染用）。 */
const STATUS_ZH = { ok: "通过", info: "提示", warn: "警告", missing: "缺失", unreachable: "不可达", error: "异常" };

/**
 * 环境体检报告 → 提取结果里的精简段落（只列需要行动的项目：warn/missing/unreachable/error）。
 * 全部通过时一行带过；info（不涉及/可选提示）不进提取摘要，避免噪音。
 */
export function formatEnvironment(env) {
  if (!env || !Array.isArray(env.checks)) return [];
  const actionable = env.checks.filter(
    (c) => c && (c.status === "warn" || c.status === "missing" || c.status === "unreachable" || c.status === "error"),
  );
  const lines = [
    "--- Environment check (" +
    (actionable.length === 0 ? "all pass" : actionable.length + " issue(s)") +
    ", checked " + (env.checked_at ?? "unknown") + ") ---",
  ];
  if (actionable.length === 0) {
    lines.push("本地依赖、配置与云端连通性检查全部通过。");
    return lines;
  }
  for (const c of actionable) {
    lines.push(
      "  [" + c.status + "] " + c.label + (c.detail ? ": " + c.detail : "") +
      (c.hint ? " — 处理建议: " + c.hint : ""),
    );
  }
  return lines;
}

/**
 * bilibili_doctor 工具的面向用户渲染：中文可读的完整体检报告。
 * 绝不输出原始凭证值（报告本身不含 SESSDATA，只有状态）。
 */
export function renderEnvReport(value) {
  const out = [];
  const summary = value?.summary ?? {};
  const issues = (value?.checks ?? []).filter((c) => c && c.status !== "ok");
  out.push("=== 环境体检（dsh-bilibili）===");
  out.push(
    "检查时间: " + (value?.checked_at ?? "未知") +
    " | 通过 " + (summary.ok ?? 0) + " 项，待处理 " + issues.length + " 项",
  );
  if (issues.length === 0) {
    out.push("全部检查通过：本地依赖、配置与云端服务均可正常使用。");
    return out.join("\n");
  }
  for (const c of issues) {
    out.push("- [" + (STATUS_ZH[c.status] ?? c.status) + "] " + c.label + (c.detail ? "：" + c.detail : ""));
    if (c.hint) out.push("  处理建议: " + c.hint);
  }
  out.push("");
  out.push("说明：体检在首次提取时自动执行并缓存约 1 小时；安装/更新依赖或改动配置后，可用 refresh=true 强制重检。");
  return out.join("\n");
}

function capText(text, cap) {
  if (text.length <= cap) return text;
  return text.slice(0, cap) + "\n[... truncated " + (text.length - cap) + " chars]";
}

const AD_MARK = "[…商单口播已折叠；DSH_BILIBILI_ADS=0 可看原文…]";

/**
 * 段落化 + 时间码：把 ASR 的碎句合并成 ~40 秒 / 160 字的块，前缀 [MM:SS]。
 * 短文稿也能跳看；落在商单区间里的块折叠成一行标记（信息不丢，可开关）。
 */
function stampSegments(segments, ads = [], blockSec = 45, maxChars = 160) {
  const list = Array.isArray(segments) ? segments : [];
  const out = [];
  let buf = "";
  let start = null;
  let t0 = 0;
  let inAdPrev = false;
  const flush = () => {
    if (!buf) return;
    if (inAdRanges(start ?? 0, ads)) {
      if (out[out.length - 1] !== AD_MARK) out.push(AD_MARK);
    } else {
      out.push("[" + formatTime(start ?? 0) + "] " + buf);
    }
    buf = "";
    start = null;
  };
  for (const seg of list) {
    const text = String(seg?.text ?? "").trim();
    if (!text) continue;
    const t = Number(seg?.start) || 0;
    const isAd = inAdRanges(t, ads);
    // 进出商单区必须断开，否则正文和广告会被合并进同一块
    if (start !== null && isAd !== inAdPrev) flush();
    inAdPrev = isAd;
    if (start === null) {
      start = t;
      t0 = t;
    }
    // ASR 行常无标点，直接拼接会糊成一堵墙；用空格当停顿，便于扫读
    buf += (buf && !/[\s，。！？、；：,.!?;:]$/.test(buf) ? " " : "") + text;
    if (buf.length >= maxChars || t - t0 >= blockSec) flush();
  }
  flush();
  return out.join("\n");
}

/**
 * 文稿截断保骨架：超出上限时保留前部完整正文 + 全文时间索引
 * （每 chunkSeconds 取该桶首句），让模型对长视频仍有全局认知，
 * 能指出「19:00 附近需要看画面」这类后部时刻。
 */
export function capTranscriptSmart(segments, text, cap = TRANSCRIPT_CAP, chunkSeconds = 300, ads = []) {
  const body = String(text ?? "");
  const hasSegs = Array.isArray(segments) && segments.length > 0;

  // 短文稿：不压缩，但按段合并成带 [MM:SS] 的块——否则模型没法定位时刻
  if (body.length <= cap) {
    if (hasSegs) {
      const stamped = stampSegments(segments, ads);
      if (stamped && stamped.length <= cap + 400) return stamped;
    }
    return body;
  }

  // 超长时优先走「抽取式骨架」：覆盖均匀 + 关键句保底（可用 DSH_BILIBILI_DIGEST=0 关掉）
  if (DIGEST_ON) {
    try {
      // 默认压到原文的 50%（下限 2000、上限 cap），可用 DSH_BILIBILI_DIGEST_RATIO 调整
      const ratio = Number(process.env.DSH_BILIBILI_DIGEST_RATIO) > 0
        ? Number(process.env.DSH_BILIBILI_DIGEST_RATIO) : 0.5;
      const target = Math.max(2000, Math.min(cap, Math.round(body.length * ratio)));
      // 商单段落不进骨架：否则广告里的「控油/套装」会抢走关键句名额
      const usable = ads.length > 0 && hasSegs
        ? segments.filter((s) => !inAdRanges(Number(s?.start) || 0, ads))
        : segments;
      const digest = buildDigest(usable, body, target, { windowSec: chunkSeconds });
      if (ads.length === 0) return digest;
      return digest +
        "\n[商单：" + ads.map((a) => formatTime(a.start) + "-" + formatTime(a.end)).join("、") +
        " 已折叠 " + ads.reduce((n, a) => n + Math.max(0, Math.round(a.end - a.start)), 0) + " 秒]";
    } catch {
      /* 骨架出错时退回旧逻辑，不能因为摘要让提取失败 */
    }
  }

  const segs = Array.isArray(segments) ? segments : [];
  const headLen = Math.floor(cap * 0.4);
  const head = body.slice(0, headLen);
  const lines = [];
  let bucket = -1;
  for (const seg of segs) {
    const b = Math.floor((Number(seg.start) || 0) / chunkSeconds);
    if (b <= bucket) continue;
    bucket = b;
    const snippet = String(seg.text ?? "").trim().slice(0, 60);
    if (snippet) lines.push("[" + formatTime(seg.start) + "] " + snippet);
    if (lines.length >= 60) break;
  }
  return head +
    "\n\n[... truncated " + (body.length - cap) + " chars]" +
    "\n[全文时间索引（每" + (chunkSeconds / 60) + "分钟首句，用于定位后部时刻）]\n" +
    lines.join("\n");
}

/**
 * 弹幕密度峰采样：按时间窗口统计密度，取最密集的 topWindows 个窗口
 * 内的弹幕（片头「来了/第一」不再霸榜），上限 cap 条，保持时间顺序。
 */
export function pickDanmakuPeaks(samples, windowSec = 60, topWindows = 4, cap = 30) {
  const list = Array.isArray(samples) ? samples : [];
  if (list.length === 0) return [];
  const windows = new Map();
  for (const s of list) {
    const idx = Math.floor((Number(s.time) || 0) / windowSec);
    const arr = windows.get(idx) ?? [];
    arr.push(s);
    windows.set(idx, arr);
  }
  // 只遍历真实存在的窗口（按时间排序）：弹幕里混进异常时间戳（如 1e9 秒）时，
  // 不会像 `for (i = 0; i <= maxIdx; i++)` 那样构造出百万级空循环。
  const idxs = [...windows.keys()].sort((a, b) => a - b);
  const top = new Set(
    [...windows.entries()]
      .sort((a, b) => b[1].length - a[1].length)
      .slice(0, topWindows)
      .map(([idx]) => idx),
  );
  const perWindow = Math.max(1, Math.floor(cap / topWindows));
  const out = [];
  // 第一遍：每个峰值窗口保底 perWindow 条（保证峰值窗口都有代表，片头不霸榜）
  for (const i of idxs) {
    if (!top.has(i)) continue;
    const arr = windows.get(i) ?? [];
    for (let k = 0; k < arr.length && k < perWindow && out.length < cap; k++) out.push(arr[k]);
  }
  // 第二遍：按时间顺序用最密集窗口补满剩余额度
  for (const i of idxs) {
    if (out.length >= cap) break;
    if (!top.has(i)) continue;
    const arr = windows.get(i) ?? [];
    for (let k = perWindow; k < arr.length && out.length < cap; k++) out.push(arr[k]);
  }
  return out;
}

export function formatExtraction(value) {
  if (!value || value.success !== true) {
    return "[bilibili_extract] extraction failed: " + String(value?.error ?? "unknown error");
  }

  const out = [];
  const meta = value.metadata ?? {};
  const stats = meta.stats ?? {};

  out.push("=== Bilibili video content extraction ===");
  out.push("Title: " + meta.title);
  out.push("Uploader: " + (meta.uploader?.name ?? "unknown"));
  out.push("Duration: " + formatTime(meta.duration) + " | Category: " + (meta.category || "unknown"));
  out.push("BV: " + value.bvid + " | Pages: " + (meta.pages ?? 1));
  out.push("Stats: views " + (stats.views ?? 0) + " | likes " + (stats.likes ?? 0) +
    " | coins " + (stats.coins ?? 0) + " | favorites " + (stats.favorites ?? 0) +
    " | comments " + (stats.comments ?? 0) + " | danmaku " + (stats.danmaku ?? 0));
  if (meta.description && meta.description !== "-") out.push("Description: " + capText(meta.description, 500));

  const envSection = formatEnvironment(value.environment);
  if (envSection.length > 0) {
    out.push("");
    out.push(...envSection);
  }

  const transcript = value.transcript ?? {};
  out.push("");
  out.push("--- Transcript ---");
  if (transcript.text) {
    out.push("source: " + transcript.source + " | language: " + (transcript.language ?? "unknown") +
      " | segments: " + (transcript.total_segments ?? 0));
    if (transcript.is_ai === true) out.push("subtitle: AI 自动生成轨（无人工 CC 轨），专有名词易有同音错字");
    const cc = transcript.cross_check;
    if (cc && cc.compared > 0) {
      out.push("cross-check: 与「" + cc.reference_language + "」轨逐句比对 " + cc.compared + " 句，存疑 " +
        cc.suspects.length + " 句" + (cc.suspects.length > 0 ? "（仅提示，未改写任何正文）" : ""));
      for (const s of cc.suspects.slice(0, 5)) {
        out.push("  存疑 " + formatTime(s.time) + " 主轨：" + capText(s.primary, 40) +
          " ｜ 参考：" + capText(s.reference, 40));
      }
      if (cc.suspects.length > 5) out.push("  …另有 " + (cc.suspects.length - 5) + " 句存疑未列出");
    }
    // B：第二路 ASR（必剪）交叉校验结果
    const acc = transcript.asr_cross_check;
    if (acc && acc.compared > 0) {
      out.push("asr-cross-check: 第二路 ASR（" + (acc.source || "bcut") + "）逐句比对 " + acc.compared + " 句，存疑 " +
        acc.suspects.length + " 句" + (acc.suspects.length > 0 ? "（仅提示，未改写任何正文）" : ""));
      for (const s of acc.suspects.slice(0, 5)) {
        out.push("  存疑 " + formatTime(s.time) + " 字幕：" + capText(s.primary, 40) +
          " ｜ ASR：" + capText(s.reference, 40));
      }
      if (acc.suspects.length > 5) out.push("  …另有 " + (acc.suspects.length - 5) + " 句存疑未列出");
    }
    if (transcript.asr_cross_check_note) out.push("asr-cross-check: " + transcript.asr_cross_check_note);
    const probe = CHANNEL_PROBE_ON
      ? probeTranscript({ segments: transcript.segments, text: transcript.text, durationSec: Number(meta.duration) || 0 })
      : { channel: "text", note: "", quality: null };
    if (probe.note) out.push("channel: " + probe.channel + " — " + probe.note);
    if (probe.quality?.suspects?.length) {
      out.push("quality: 字幕质量偏低（" + probe.quality.suspects.join("；") +
        "）——同音错字概率高，专有名词/数字别照抄，以画面和原片为准");
    }
    const ads = ADS_ON && Array.isArray(transcript.segments) && transcript.segments.length > 0
      ? detectAdSegments(transcript.segments)
      : [];
    if (ads.length > 0) {
      out.push("ads: 疑似商单 " + ads.map((a) => formatTime(a.start) + "-" + formatTime(a.end)).join("、") +
        "（共 " + ads.reduce((n, a) => n + Math.max(0, Math.round(a.end - a.start)), 0) +
        " 秒，已折叠；不是 UP 的观点，DSH_BILIBILI_ADS=0 可看原文）");
    }
    if (probe.channel === "noise" || probe.channel === "lyric") {
      // 文字通道是噪声/歌词：不要把这些字灌给模型，只提示改看画面
      out.push("");
      out.push("[transcript suppressed: " + probe.channel + "] 文字通道不可用，请改用 extract_frames + timestamps 看画面（建议 2–3 帧）。");
      out.push("原文 " + transcript.text.length + " 字已省略；若确需原始文稿，用 DSH_BILIBILI_CHANNEL=0 重跑。");
    } else {
      out.push("");
      out.push(capTranscriptSmart(transcript.segments, transcript.text, TRANSCRIPT_CAP, 300, ads));
    }
  } else {
    out.push("No transcript available. " + (transcript.note ?? ""));
  }

  const danmaku = value.danmaku ?? {};
  if ((danmaku.total ?? 0) > 0) {
    out.push("");
    out.push("--- Danmaku (total " + danmaku.total + ") ---");
    const top = (danmaku.top_messages ?? []).slice(0, DANMAKU_MESSAGE_CAP);
    if (top.length > 0) {
      out.push("Top repeated messages:");
      for (const item of top) out.push("  [" + item.text + "] x" + item.count);
    }
    const samples = pickDanmakuPeaks(danmaku.samples ?? [], 60, 4, DANMAKU_SAMPLE_CAP);
    if (samples.length > 0) {
      out.push("Timeline samples:");
      for (const sample of samples) out.push("  " + formatTime(sample.time) + " " + sample.text);
    }
  }

  const comments = value.comments ?? {};
  if ((comments.fetched ?? 0) > 0) {
    out.push("");
    out.push("--- Hot comments (total " + (comments.total ?? 0) + ", showing " + comments.fetched + ") ---");
    for (const comment of (comments.comments ?? []).slice(0, COMMENT_CAP)) {
      out.push("  [" + comment.user + "] " + comment.content + " (likes " + comment.likes + ")");
      for (const reply of (comment.replies ?? []).slice(0, 2)) {
        out.push("    - [" + reply.user + "] " + reply.content + " (likes " + reply.likes + ")");
      }
    }
  }

  const frames = value.frames ?? {};
  if (frames.enabled) {
    out.push("");
    out.push("--- Keyframes (" + (frames.strategy ?? "") + ") ---");
    if (frames.mode) out.push("capture mode: " + frames.mode + (frames.note ? " — " + frames.note : ""));
    const list = frames.frames ?? [];
    if (list.length === 0) {
      out.push("No frames captured." + (frames.error ? " Error: " + frames.error : "") + (frames.note ? " — " + frames.note : ""));
    } else {
      for (const frame of list) {
        let line = "  frame " + formatTime(frame.time) + " | reason: " + frame.reason;
        if (frame.subtitle_text) line += " | subtitle: " + capText(frame.subtitle_text, 60);
        if (frame.has_image) line += " | image: " + frame.path;
        else line += " | no image" + (frame.error ? " (" + frame.error + ")" : "");
        if (frame.requested_time !== null && frame.requested_time !== undefined &&
          Math.abs(frame.time - frame.requested_time) >= 0.5) {
          line += " | 原始请求 " + formatTime(frame.requested_time);
        }
        if (frame.description) line += "\n    vision: " + capText(frame.description, 300);
        else if (frame.vision_error) line += "\n    vision error: " + frame.vision_error;
        if (frame.citation_hint) line += " | 配图建议: " + (frame.citation_hint === "suitable" ? "适合" : "不适合");
        out.push(line);
      }
      out.push("In your report, cite only frames marked 配图建议=适合 (clear and informative); skip pure talking-head or blurry frames, at most 1-2 images per section. Use the read_image tool with a frame path if your model supports image input; otherwise rely on the vision descriptions.");
    }
  }

  out.push("");
  out.push("Extraction took " + (value.elapsed_seconds ?? 0) + "s. Summarize the video from the transcript above; consult frames for visual details.");
  return out.join("\n");
}

