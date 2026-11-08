/**
 * dsh-bilibili — DeepSeek Harness tool plugin.
 *
 * Registers the model-facing `bilibili_extract` tool on ctx.tools:
 * extract a Bilibili video's text information first (metadata, transcript,
 * comments, danmaku), then capture keyframes at subtitle-driven timestamps,
 * and hand everything to the model for the final summary. Frame images are
 * saved as files and referenced by absolute path so the model can read_image
 * the ones it needs.
 *
 * Cordis plugin module: exports name / inject / Config / apply.
 *
 * @module dsh-bilibili
 */

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import z from "@deepseek-ai/schemastery";
import { defineTool } from "@deepseek-ai/dsh-tools";
import { extractAll } from "./extractor.js";
import { formatExtraction, renderEnvReport } from "./format.js";
import { getEnvReport } from "./envcheck.js";
import {
  startQrLogin,
  pollQrLogin,
  loadStoredSessdata,
  saveManualSessdata,
  clearCredentials,
  credentialStatus,
} from "./login.js";

/** Cordis plugin name used by loader diagnostics. */
const name = "bilibili";

/** Services required by the tool plugin. */
const inject = ["tools", "systemPrompt"];

const DEFAULT_CONFIG = {
  sessdata: "",
  commentLimit: 20,
  maxFrames: 6,
  extractFrames: true,
  downloadVideo: true,
  keepVideo: false,
  maxVideoMinutes: 30,
  maxDownloadMb: 800,
  quality: 32,
  detectScenes: true,
  sceneThreshold: 0.4,
  sharpFrames: true,
  asrProvider: "bcut",
  crossCheckAsr: false,
  // 只有 AI 中文轨时多探几次人工 CC 轨（多约 2.4 秒，换来更稳的双轨交叉校验）
  probeManualTrack: true,
  whisperBin: "whisper-cli",
  whisperModel: "medium",
  whisperModelDir: "",
  whisperLanguage: "zh",
  whisperThreads: 0,
  sherpaBin: "",
  sherpaModel: "",
  sherpaModelType: "sense-voice",
  sherpaTokens: "",
  sherpaThreads: 0,
  visionProvider: "none",
  visionBaseUrl: "",
  visionModel: "medium",
  visionApiKey: "",
  visionPrompt: "",
  visionPromptByModel: {},
  visionMaxFrames: 6,
  framesDir: "",
  summaryTemplate: "",
  timeoutMs: 300000,
};

/** Deployment-tunable config, filled by the loader from the patch row. */
const Config = z.object({
  sessdata: z.string().default(""),
  commentLimit: z.number().default(20),
  maxFrames: z.number().default(6),
  extractFrames: z.boolean().default(true),
  downloadVideo: z.boolean().default(true),
  keepVideo: z.boolean().default(false),
  maxVideoMinutes: z.number().default(30),
  maxDownloadMb: z.number().default(800),
  quality: z.number().default(32),
  detectScenes: z.boolean().default(true),
  sceneThreshold: z.number().default(0.4),
  sharpFrames: z.boolean().default(true),
  asrProvider: z.string().default("bcut"),
  crossCheckAsr: z.boolean().default(false),
  probeManualTrack: z.boolean().default(true),
  whisperBin: z.string().default("whisper-cli"),
  whisperModel: z.string().default("medium"),
  whisperModelDir: z.string().default(""),
  whisperLanguage: z.string().default("zh"),
  whisperThreads: z.number().default(0),
  sherpaBin: z.string().default(""),
  sherpaModel: z.string().default(""),
  sherpaModelType: z.string().default("sense-voice"),
  sherpaTokens: z.string().default(""),
  sherpaThreads: z.number().default(0),
  visionProvider: z.string().default("none"),
  visionBaseUrl: z.string().default(""),
  visionModel: z.string().default("medium"),
  visionApiKey: z.string().default(""),
  visionPrompt: z.string().default(""),
  visionPromptByModel: z.dict(z.string()).default({}),
  visionMaxFrames: z.number().default(6),
  framesDir: z.string().default(""),
  summaryTemplate: z.string().default(""),
  timeoutMs: z.number().default(300000),
});

/** Render the bilibili_login tool result as chat text (QR shown as a Unicode-block code block). */
function renderLoginResult(value) {
  const v = value ?? {};
  if (v.status === "waiting_scan") {
    return [
      "B站扫码登录：请用手机 B 站 App 扫下面的二维码，并在 App 内点「确认登录」。",
      "",
      "```",
      String(v.qr_text ?? "").trimEnd(),
      "```",
      "",
      "本地二维码图片（若上面的字符二维码扫不出，可直接打开）： " + (v.qr_image_path || "未保存"),
      "qrcode_key: " + (v.qrcode_key ?? ""),
      "",
      "扫码确认后，让我调用 bilibili_login(action=\"poll\", qrcode_key=\"…\") 等待登录结果。",
    ].join("\n");
  }
  if (v.status === "success") {
    return "登录成功 ✅ B站账号 uid " + (v.dedeuserid || "未知") +
      "。SESSDATA 已保存到本地，后续提取自动生效；重新调用 bilibili_extract 即可拿到需要登录的字幕文稿。";
  }
  if (v.status === "timeout") return "扫码等待超时：限定时间内未完成登录。可重新 action=start 生成新二维码再试。";
  if (v.status === "expired") return "二维码已过期：" + (v.message ?? "") + " 请重新 action=start 生成新二维码。";
  if (v.status === "waiting" || v.status === "scanned") return "登录等待中：" + (v.message ?? v.status);
  if (v.status === "error") return "登录操作失败：" + (v.message ?? "未知错误");
  return JSON.stringify(v, null, 2);
}

/** Bundled default summary template — the replaceable output-format part. */
const BUNDLED_TEMPLATE_URL = new URL("../templates/summary.md", import.meta.url);

const FALLBACK_TEMPLATE_TEXT = "Summarize the video for the user: one-sentence takeaway, key points with timestamps, and shareable closing lines. Do not fabricate anything without evidence.";

/**
 * Load the summary template: the bundled default, or a user-supplied file.
 * A missing/unreadable custom file falls back to the bundled template so the
 * tool keeps working no matter what the user points at.
 */
function loadSummaryTemplate(pathOrEmpty) {
  if (pathOrEmpty) {
    try {
      return readFileSync(resolve(pathOrEmpty), "utf8");
    } catch {
      // fall through to the bundled template
    }
  }
  try {
    return readFileSync(BUNDLED_TEMPLATE_URL, "utf8");
  } catch {
    return FALLBACK_TEMPLATE_TEXT;
  }
}

function clampInteger(value, fallback, min, max) {
  const n = Number(value);
  if (!Number.isInteger(n)) return fallback;
  return Math.min(Math.max(n, min), max);
}

function apply(ctx, config) {
  const resolved = { ...DEFAULT_CONFIG, ...(config ?? {}) };
  // defineTool rejects a non-positive timeout, which would fail the whole plugin load
  const timeoutMs = Number.isFinite(resolved.timeoutMs) && resolved.timeoutMs > 0
    ? resolved.timeoutMs
    : DEFAULT_CONFIG.timeoutMs;

  // 首用排查：后台预热环境体检缓存（不阻塞插件加载；失败静默，结果 1 小时有效）
  void getEnvReport(resolved).catch(() => {});

  const template = loadSummaryTemplate(resolved.summaryTemplate);
  ctx.systemPrompt.section({
    name: "tool:bilibili_extract",
    order: 160,
    // DSH interpolates {{variables}} strictly and fails the request on unknown ones;
    // the summary template is user-supplied, so keep this section literal
    interpolate: false,
    text: "Use the bilibili_extract tool to analyze Bilibili videos. 主路径是**提示词驱动的两段式**：先读文稿，再由你判断哪几处必须看画面。\n\n" +
      "【一·读文稿】bilibili_extract(url, extract_frames: false) 只拿文字（秒级、零下载）。逐段找「离开画面就不完整」的位置：指代悬空（这个/如图/就是它）、只给评价没给数据、操作没说清选项、数秒无声演示、对比没展开。记下该句附近的时间点；纯口播不用看画面。\n\n" +
      "【二·定向抓帧】回复末尾用固定格式列出时刻：[建议抓帧] mm:ss 理由，随即调 bilibili_extract(url, timestamps: [...])。只引用「配图建议=适合」且画面清晰的帧，每段至多 1–2 张；没有需要就不配图。模型支持图像时可用 read_image 看帧。\n\n" +
      "【登录】字幕需要登录时用 bilibili_login：action=start 出二维码（字符码放代码块 + 本地图片路径，别交给第三方二维码服务）→ 用户扫码后 action=poll。成功后 SESSDATA 自动保存。\n" +
      "【环境】每次提取附带体检（约缓存 1 小时）；出现 warn/missing/unreachable/error 时把「处理建议」转达用户；改依赖或配置后用 bilibili_doctor(refresh=true)。\n\n" +
      "按下面的模板输出（可用 summaryTemplate 配置替换）：\n\n" + template +
      "\n\n更深的输出形态（学习笔记/时间轴/问答卡）改用 bilibili-video-analyzer skill。",
  });

  ctx.tools.register(defineTool({
    name: "bilibili_extract",
    description:
      "Analyze a Bilibili video: metadata, transcript, hot comments, danmaku, keyframes. " +
      "Use when given a bilibili.com/video/BV… URL, b23.tv link, or BV id. Returns a text digest plus " +
      "absolute paths of captured frames (open them with read_image). Auto frames are scene-change based; " +
      "pass `timestamps` for precise moments. Preferred flow: extract_frames: false to read the transcript, " +
      "then a second call with timestamps for the moments that need visual confirmation.",
    parameters: {
      url: {
        type: "string",
        required: true,
        description: "Bilibili video URL (bilibili.com/video/BV..., b23.tv) or a bare BV id",
      },
      comment_limit: {
        type: "integer",
        description: "Maximum comments to fetch (1-50; defaults to the configured 20)",
      },
      max_frames: {
        type: "integer",
        description: "Maximum keyframes to capture (1-20; defaults to the configured 6)",
      },
      extract_frames: {
        type: "boolean",
        description: "Whether to capture keyframes (default true; set false for text-only extraction)",
      },
      timestamps: {
        type: "array",
        items: { type: "number" },
        description: "Optional explicit capture timestamps in seconds — skips auto-selection; use it to zoom into specific moments after a first pass",
      },
      cross_check: {
        type: "boolean",
        description: "Run a second ASR pass (bcut) and flag transcript sentences that disagree. Adds ~1 min.",
      },
    },
    output: {
      schema: { type: "json" },
      render: (_args, value) => [{ type: "text", text: formatExtraction(value) }],
    },
    timeoutMs,
    async execute(args, exec) {
      let envReport = null;
      try {
        envReport = await getEnvReport(resolved);
      } catch {
        // 体检失败不阻塞提取：门禁关闭，行为与旧版一致
      }
      const value = await extractAll({
        url: args.url,
        commentLimit: clampInteger(args.comment_limit, resolved.commentLimit, 1, 50),
        maxFrames: clampInteger(args.max_frames, resolved.maxFrames, 1, 20),
        extractFrames: args.extract_frames ?? resolved.extractFrames,
        downloadVideo: resolved.downloadVideo,
        keepVideo: resolved.keepVideo,
        maxVideoMinutes: resolved.maxVideoMinutes,
        maxDownloadMb: resolved.maxDownloadMb,
        quality: resolved.quality,
        timestamps: args.timestamps,
        detectScenes: resolved.detectScenes,
        sceneThreshold: resolved.sceneThreshold,
        sharpFrames: resolved.sharpFrames,
        asrProvider: resolved.asrProvider,
        crossCheckAsr: args.cross_check ?? resolved.crossCheckAsr,
        probeManualTrack: resolved.probeManualTrack,
        whisperBin: resolved.whisperBin,
        whisperModel: resolved.whisperModel,
        whisperModelDir: resolved.whisperModelDir,
        whisperLanguage: resolved.whisperLanguage,
        whisperThreads: resolved.whisperThreads,
        sherpaBin: resolved.sherpaBin,
        sherpaModel: resolved.sherpaModel,
        sherpaModelType: resolved.sherpaModelType,
        sherpaTokens: resolved.sherpaTokens,
        sherpaThreads: resolved.sherpaThreads,
        visionProvider: resolved.visionProvider,
        visionBaseUrl: resolved.visionBaseUrl,
        visionModel: resolved.visionModel,
        visionApiKey: resolved.visionApiKey,
        visionPrompt: resolved.visionPrompt,
        visionPromptByModel: resolved.visionPromptByModel,
        visionMaxFrames: resolved.visionMaxFrames,
        framesDir: resolved.framesDir,
        sessdata: resolved.sessdata || ((await loadStoredSessdata())?.sessdata ?? ""),
        envReport,
        signal: exec.signal,
      });
      if (envReport) value.environment = envReport;
      return value;
    },
    presentCall: (args) => ({ card: "generic", title: args.url, kind: "fetch", rawInput: args.url }),
  }));

  ctx.tools.register(defineTool({
    name: "bilibili_login",
    description:
      "Bilibili login for bilibili_extract: start (QR code), poll (wait for scan), status, logout, save (manual SESSDATA). " +
      "A stored SESSDATA unlocks login-required subtitles. Never return the raw SESSDATA to the user.",
    parameters: {
      action: {
        type: "string",
        required: true,
        description: "start (generate a new QR code) | poll (wait for the scan result; needs qrcode_key) | status (is a credential stored?) | logout (delete the stored credential) | save (store a manually provided SESSDATA)",
      },
      qrcode_key: {
        type: "string",
        description: "QR session key returned by action=start; required for action=poll",
      },
      sessdata: {
        type: "string",
        description: "Manual SESSDATA cookie value (from the browser); only for action=save",
      },
      wait_seconds: {
        type: "integer",
        description: "Maximum wait for action=poll in seconds (5-180; default 90). The QR stays valid ~3 minutes.",
      },
    },
    output: {
      schema: { type: "json" },
      render: (_args, value) => [{ type: "text", text: renderLoginResult(value) }],
    },
    timeoutMs,
    async execute(args, exec) {
      const action = String(args.action ?? "status");
      if (action === "start") {
        try {
          const qr = await startQrLogin();
          return {
            status: "waiting_scan",
            qrcode_key: qr.qrcode_key,
            login_url: qr.login_url,
            qr_text: qr.qr_text,
            qr_image_path: qr.qr_image_path,
            message: "请用手机 B 站 App 扫码并确认登录，然后调用 action=poll 等待结果",
          };
        } catch (error) {
          return { status: "error", message: String(error?.message ?? error) };
        }
      }
      if (action === "poll") {
        if (!args.qrcode_key) return { status: "error", message: "poll 需要 qrcode_key（先调用 action=start）" };
        const waitMs = clampInteger(args.wait_seconds, 90, 5, 180) * 1000;
        const deadline = Date.now() + waitMs;
        for (;;) {
          if (exec.signal?.aborted) return { status: "error", message: "登录等待被取消" };
          let result;
          try {
            result = await pollQrLogin(args.qrcode_key);
          } catch (error) {
            result = { status: "retry", message: String(error?.message ?? error) };
          }
          if (result.status === "success") {
            return {
              ...result,
              message: "登录成功，SESSDATA 已保存到本地；重新调用 bilibili_extract 即可获取需要登录的字幕文稿",
            };
          }
          if (result.status === "expired" || result.status === "error") {
            return { ...result, message: (result.message ?? "") + "（可重新 action=start 生成新二维码）" };
          }
          if (Date.now() >= deadline) {
            return { status: "timeout", message: "等待超时，用户未完成登录；可重新 action=start / action=poll" };
          }
          await new Promise((res) => setTimeout(res, 2000));
        }
      }
      if (action === "status") {
        const st = await credentialStatus();
        return { status: "ok", ...st };
      }
      if (action === "logout") {
        const cleared = await clearCredentials();
        return { status: "ok", cleared, message: cleared ? "本地登录凭证已删除" : "没有可删除的本地凭证" };
      }
      if (action === "save") {
        if (!args.sessdata) return { status: "error", message: "action=save 需要 sessdata 参数" };
        try {
          await saveManualSessdata(args.sessdata);
          return { status: "ok", saved: true, message: "已保存手动提供的 SESSDATA；后续提取自动生效（请确保凭证来源可信）" };
        } catch (error) {
          return { status: "error", message: String(error?.message ?? error) };
        }
      }
      return { status: "error", message: "未知 action：" + action };
    },
  }));

  ctx.tools.register(defineTool({
    name: "bilibili_doctor",
    description:
      "Run the dsh-bilibili environment check: binaries (ffmpeg/whisper/sherpa-onnx), models, vision endpoint, output dir, " +
      "config, stored SESSDATA, API reachability. Auto-runs on first extraction (cached ~1h); call to re-check after " +
      "installing or changing dependencies. Never exposes credentials.",
    parameters: {
      refresh: {
        type: "boolean",
        description: "Force a fresh probe instead of returning the cached report (default false)",
      },
    },
    output: {
      schema: { type: "json" },
      render: (_args, value) => [{ type: "text", text: renderEnvReport(value) }],
    },
    timeoutMs,
    async execute(args) {
      const report = await getEnvReport(resolved, { force: args?.refresh === true });
      return report;
    },
    presentCall: (args) => ({
      card: "generic",
      title: "环境体检",
      kind: "execute",
      rawInput: String(args?.refresh === true ? "强制重检" : "读取缓存报告"),
    }),
  }));
}

export { Config, apply, inject, name };
export { extractAll, normalizeRequestedTimestamps } from "./extractor.js";
export { formatExtraction, formatEnvironment, renderEnvReport } from "./format.js";
export { selectKeyframeTimestamps, formatTime } from "./keyframes.js";
export { getEnvReport, probeEnvironment, summarizeChecks, ASR_PROVIDERS } from "./envcheck.js";

