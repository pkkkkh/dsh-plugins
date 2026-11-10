/**
 * dsh-restart — model-facing tools that schedule a safe self-restart.
 *
 * Why a plugin: the restart itself is a desktop-side operation (kill this
 * process and bring it back), but from IM or the Web GUI the agent cannot
 * "press the button". This plugin lets the agent arm the restart on the
 * user's behalf — with an explicit confirm, preflight checks, and a log
 * readback so the caller can see the tasks were really registered.
 *
 * The kill/start work deliberately stays in the vetted scripts:
 *   scripts/restart-dsh-arm.ps1      start-first ordering + rollback (default)
 *   scripts/restart-dsh-arm2.ps1     same, plus -StartScript / -WatchAfterSeconds
 *   scripts/restart-dsh-fallback.cmd one retry if the app dies at startup
 *   scripts/restart-dsh-start.ps1    explorer launch + 20s "did it stay up" check
 *   scripts/dsh-restart-tasks.ps1    status / cancel of the armed tasks
 * This module only wraps them; it does not re-implement Task Scheduler logic.
 *
 * 2026-11-10: tool results are plain strings on purpose. `output.schema` is an
 * author-facing spec and a malformed one throws at defineTool() compile time,
 * which kills the whole plugin (the first load attempt failed exactly that way).
 *
 * @module dsh-restart
 */
import { spawn } from "node:child_process";
import { appendFileSync, existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { dirname } from "node:path";
import z from "@deepseek-ai/schemastery";
import { defineTool } from "@deepseek-ai/dsh-tools";
import { describeTimings, resolveTimings, DEFAULT_KILL_SECONDS } from "./timings.js";
import { buildArmArgs, needsExtendedScript, normalizeWatchSeconds, parseTaskStatus } from "./args.js";

// Import-time breadcrumb: proves the loader reached this module at all.
// Without it we cannot tell "never imported" from "apply() failed".
try {
  appendFileSync(
    "C:/Users/kh006/.dsh/im/logs/restart-import.log",
    "[" + new Date().toISOString() + "] module imported\n",
    "utf8",
  );
} catch { /* never break the import */ }
import {
  DEFAULT_ANNOUNCE_TEXT,
  DEFAULT_MAX_AGE_MINUTES,
  clearMarker,
  isFresh,
  readMarker,
  resolveDelivery,
  writeMarker,
} from "./announce.js";

export const name = "dsh-restart";
export const inject = ["tools"];

const SCRIPT_ROOT = "C:/Users/kh006/.dsh/im/scripts";
const DEFAULT_ARM_SCRIPT = SCRIPT_ROOT + "/restart-dsh-arm.ps1";
const DEFAULT_MAINT_ARM_SCRIPT = SCRIPT_ROOT + "/restart-dsh-arm2.ps1";
const DEFAULT_TASKS_SCRIPT = SCRIPT_ROOT + "/dsh-restart-tasks.ps1";
const DEFAULT_LOG_FILE = "C:/Users/kh006/.dsh/im/logs/restart-dsh.log";
const DEFAULT_ANNOUNCE_FILE = "C:/Users/kh006/.dsh/im/logs/restart-announce.json";

export const Config = z.object({
  armScript: z.string().default(DEFAULT_ARM_SCRIPT),
  maintArmScript: z.string().default(DEFAULT_MAINT_ARM_SCRIPT),
  tasksScript: z.string().default(DEFAULT_TASKS_SCRIPT),
  logFile: z.string().default(DEFAULT_LOG_FILE),
  powershell: z.string().default("powershell.exe"),
  defaultKillSeconds: z.number().default(DEFAULT_KILL_SECONDS),
  announce: z.boolean().default(true),
  announceText: z.string().default(DEFAULT_ANNOUNCE_TEXT),
  announceMaxAgeMinutes: z.number().default(DEFAULT_MAX_AGE_MINUTES),
  announceFile: z.string().default(DEFAULT_ANNOUNCE_FILE),
  announceBotId: z.string().default(""),
  announceTargetId: z.string().default(""),
  announceAutoTarget: z.boolean().default(true),
});

/** Run one process with pipes; resolves (never rejects) with {code, output}. */
function runProcess(file, args, timeoutMs) {
  return new Promise((resolve) => {
    let child;
    const chunks = [];
    try {
      child = spawn(file, args, { windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
    } catch (error) {
      resolve({ code: -1, output: String(error?.message ?? error) });
      return;
    }
    const timer = setTimeout(() => {
      try { child.kill("SIGKILL"); } catch { /* ignore */ }
      resolve({ code: -1, output: chunks.join("") + "\ntimed out after " + timeoutMs + "ms" });
    }, timeoutMs);
    child.stdout?.on("data", (data) => chunks.push(String(data)));
    child.stderr?.on("data", (data) => chunks.push(String(data)));
    child.on("error", (error) => {
      clearTimeout(timer);
      resolve({ code: -1, output: String(error?.message ?? error) });
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ code: code ?? -1, output: chunks.join("") });
    });
  });
}

function tailLines(text, count) {
  return String(text ?? "").trimEnd().split(/\r?\n/).slice(-count).join("\n");
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Wait for the dshIm service. At boot the IM plugin registers its service
 * asynchronously — at +3s it was still missing (2026-11-10 18:18), so poll.
 */
async function waitForIm(ctx, timeoutMs = 25000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const im = typeof ctx.get === "function" ? ctx.get("dshIm") : null;
    if (im && typeof im.send === "function") return im;
    if (Date.now() >= deadline) return null;
    await sleep(1500);
  }
}

/**
 * Wait until a delivery route is resolvable. The bot list fills in after the
 * channels connect, so an early "no-bot" is retried instead of giving up.
 */
async function waitForRoute(im, opts, timeoutMs = 20000) {
  const deadline = Date.now() + timeoutMs;
  let route = { error: "no-bot" };
  for (;;) {
    route = await resolveDelivery(im, { botId: opts.botId, targetId: opts.targetId });
    if (route.targetId) return route;
    if (route.error === "no-target" || String(route.error).startsWith("list-targets-failed")) return route;
    if (Date.now() >= deadline) return route;
    await sleep(1500);
  }
}

/** Post-restart greeting. Marker is cleared BEFORE sending (no crash-loop spam). */
async function announceIfPending(ctx, opts) {
  const marker = readMarker(opts.file);
  if (!marker) return;
  if (!isFresh(marker, new Date(), opts.maxAgeMinutes)) {
    clearMarker(opts.file);
    opts.log("[announce] marker too old, dropped");
    return;
  }
  clearMarker(opts.file);
  try {
    const im = await waitForIm(ctx, opts.waitServiceMs ?? 25000);
    if (!im) {
      opts.log("[announce] IM service still unavailable after wait, greeting not delivered: " + marker.text);
      return;
    }
    const route = await waitForRoute(im, opts, opts.waitRouteMs ?? 20000);
    if (!route.targetId) {
      opts.log("[announce] " + route.error + " — configured target needed: 设置 → IM机器人 → 新建目标");
      return;
    }
    await im.send(route.botId, route.targetId, marker.text);
    opts.log("[announce] sent after restart via " + route.botId + "/" + route.targetId + ": " + marker.text);
  } catch (error) {
    opts.log("[announce] failed: " + String(error?.message ?? error));
  }
}

/**
 * defineTool requires output.render (verified against the real host module:
 * omitting output throws "Cannot read properties of undefined (reading 'render')").
 * Our execute() returns plain strings, so render is a passthrough.
 */
function toolOutput() {
  return {
    schema: { type: "object", additionalProperties: true, properties: {} },
    render: (_args, value) => [{ type: "text", text: String(value?.text ?? "") }],
  };
}

export function apply(ctx, config) {
  const armScript = String(config?.armScript ?? DEFAULT_ARM_SCRIPT).trim();
  const maintArmScript = String(config?.maintArmScript ?? DEFAULT_MAINT_ARM_SCRIPT).trim();
  const tasksScript = String(config?.tasksScript ?? DEFAULT_TASKS_SCRIPT).trim();
  const logFile = String(config?.logFile ?? DEFAULT_LOG_FILE).trim();
  const powershell = String(config?.powershell ?? "powershell.exe").trim();
  const defaultKillSeconds = Number(config?.defaultKillSeconds ?? DEFAULT_KILL_SECONDS);
  const announce = config?.announce !== false;
  const announceText = String(config?.announceText ?? DEFAULT_ANNOUNCE_TEXT).trim() || DEFAULT_ANNOUNCE_TEXT;
  const announceFile = String(config?.announceFile ?? DEFAULT_ANNOUNCE_FILE).trim();
  const announceMaxAgeMinutes = Number(config?.announceMaxAgeMinutes ?? DEFAULT_MAX_AGE_MINUTES);

  const log = (msg) => {
    try {
      appendFileSync(logFile, "[" + new Date().toISOString() + "] " + msg + "\n", "utf8");
    } catch { /* logging must never break the plugin */ }
  };

  log("[boot] dsh-restart loaded (announce=" + announce + ", marker=" + (existsSync(announceFile) ? "pending" : "none") + ")");

  // ---------- restart_dsh ----------
  try {
    ctx.tools.register(defineTool({
      name: "restart_dsh",
      description:
        "Restart DeepSeek Harness safely. Arms a scheduled kill + start pair: DSH is killed after " +
        "delay_seconds (20-600, default 45) and started again ~11s later if it is still down. The whole " +
        "app — including this conversation — goes down and comes back in 60-90 seconds; the next session " +
        "can continue. Optional start_script replaces the start half (e.g. run pnpm install before the " +
        "app comes back); optional watch_seconds adds a third watchdog task. " +
        "Requires confirm:true. Never call this unless the user explicitly asked to restart DSH.",
      parameters: {
        confirm: { type: "boolean", required: true, description: "Must be true. A restart kills the whole app." },
        delay_seconds: { type: "integer", description: "Seconds until DSH is killed (20-600, default 45)." },
        start_script: {
          type: "string",
          description:
            "Optional absolute path of a .cmd/.ps1 used as the start half. It runs after the kill in its " +
            "own scheduled task and must bring DSH back (call restart-dsh-start.ps1 at the end).",
        },
        watch_seconds: {
          type: "integer",
          description: "Optional watchdog delay (0/omitted = off). Starts DSH if it is still down then.",
        },
        reason: { type: "string", description: "Optional one-line reason, echoed in the result." },
      },
      output: toolOutput(),
      async execute(args) {
        // The host validates tool results against output.schema: a bare string
        // is rejected as `"value" must be an object`. Always return { ok, text }.
        if (args?.confirm !== true) {
          return { ok: false, text: "重启没有排上 ❌\n原因：缺少 confirm:true\n提示：重启会杀掉整个 DSH 并打断本对话；先向用户确认，再带 confirm:true 调用。" };
        }
        const timings = resolveTimings(args?.delay_seconds, { defaultKillSeconds });
        const startScript = String(args?.start_script ?? "").trim();
        const extended = needsExtendedScript({ startScript, watchSeconds: args?.watch_seconds });
        const watchSeconds = extended
          ? normalizeWatchSeconds(args?.watch_seconds, { startSeconds: timings.startSeconds })
          : 0;
        const script = extended ? maintArmScript : armScript;

        if (!existsSync(script)) {
          return { ok: false, text: "重启没有排上 ❌\n原因：找不到重启脚本 " + script + "\n提示：检查 armScript / maintArmScript 配置。" };
        }
        if (startScript && !existsSync(startScript)) {
          return { ok: false, text: "重启没有排上 ❌\n原因：找不到启动半段脚本 " + startScript };
        }
        if (!existsSync(dirname(logFile))) {
          return { ok: false, text: "重启没有排上 ❌\n原因：找不到日志目录 " + dirname(logFile) };
        }

        const result = await runProcess(powershell,
          buildArmArgs({ script, killSeconds: timings.killSeconds, startSeconds: timings.startSeconds, startScript, watchSeconds }),
          20000);

        if (result.code !== 0) {
          return { ok: false, text: "重启没有排上 ❌\n原因：arm 脚本失败（exit " + result.code + "）\n输出：\n" + tailLines(result.output, 8) };
        }

        if (announce) {
          const marked = writeMarker(announceFile, announceText);
          if (!marked.ok) log("[announce] marker write failed: " + marked.error);
        }

        let logTail = "";
        try { logTail = tailLines(await readFile(logFile, "utf8"), 6); } catch { /* best effort */ }

        return {
          ok: true,
          text: [
            "重启已排程 ✅",
            "计划：" + describeTimings(timings),
            startScript ? "启动半段：" + startScript : "",
            watchSeconds > 0 ? "看门狗：+" + watchSeconds + "s 后补拉" : "",
            "原因：" + (String(args?.reason ?? "").trim() || "（未填）"),
            announce ? "回来后会发一句：「" + announceText + "」" : "",
            logTail ? "日志：" + logTail : "",
            "本对话会中断，重启后新会话可继续。",
          ].filter(Boolean).join("\n"),
        };
      },
    }));
  } catch (error) {
    log("[boot] register restart_dsh failed: " + String(error?.message ?? error));
  }

  // ---------- restart_status ----------
  try {
    ctx.tools.register(defineTool({
      name: "restart_status",
      description:
        "Show the restart-related scheduled tasks (DSH-Restart-*) and the tail of the restart log. " +
        "Use it to check whether a restart was really armed or why the last one failed.",
      parameters: {},
      output: toolOutput(),
      async execute() {
        if (!existsSync(tasksScript)) return { ok: false, text: "查询失败 ❌\n原因：找不到任务查询脚本 " + tasksScript };
        const result = await runProcess(powershell, ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", tasksScript, "-Action", "status"], 15000);
        if (result.code !== 0) return { ok: false, text: "查询失败 ❌\n原因：查询脚本失败（exit " + result.code + "）\n" + tailLines(result.output, 6) };
        let logTail = "";
        try { logTail = tailLines(await readFile(logFile, "utf8"), 12); } catch { /* best effort */ }
        const rows = parseTaskStatus(result.output).map(
          (t) => "- " + t.name + "：" + (t.state || "未注册") + (t.next ? "（下次 " + t.next + "）" : ""),
        );
        return { ok: true, text: ["重启任务：", ...(rows.length ? rows : ["- （无）"]), "", "日志尾部：", logTail || "（空）"].join("\n") };
      },
    }));
  } catch (error) {
    log("[boot] register restart_status failed: " + String(error?.message ?? error));
  }

  // ---------- restart_announce_test ----------
  try {
    ctx.tools.register(defineTool({
      name: "restart_announce_test",
      description:
        "Send the post-restart greeting right now, without restarting. Verifies that IM proactive " +
        "delivery actually works and reports which bot/target was used, or the exact reason it failed.",
      parameters: {},
      output: toolOutput(),
      async execute() {
        const im = await waitForIm(ctx, 8000);
        if (!im) return { ok: false, text: "发送失败 ❌\n原因：IM 服务不可用（等了 8 秒）" };
        const route = await waitForRoute(im, { botId: config?.announceBotId, targetId: config?.announceTargetId }, 6000);
        if (!route.targetId) {
          return {
            ok: false,
            text: "发送失败 ❌\n原因：" + route.error +
              "\n修法：设置 → IM机器人 → 对应机器人卡片 → 新建目标 → 「从已聊会话选择」→ 测试 → 保存。",
          };
        }
        try {
          await im.send(route.botId, route.targetId, announceText);
          log("[announce] test sent via " + route.botId + "/" + route.targetId);
          return { ok: true, text: "已发送 ✅\n机器人：" + route.botId + "\n目标：" + route.targetId + "\n内容：" + announceText };
        } catch (error) {
          return { ok: false, text: "发送失败 ❌\n原因：" + String(error?.message ?? error) };
        }
      },
    }));
  } catch (error) {
    log("[boot] register restart_announce_test failed: " + String(error?.message ?? error));
  }

  // ---------- restart_cancel ----------
  try {
    ctx.tools.register(defineTool({
      name: "restart_cancel",
      description:
        "Cancel an armed restart: unregister every DSH-Restart-* scheduled task. Only useful before the " +
        "kill task fires.",
      parameters: {},
      output: toolOutput(),
      async execute() {
        if (!existsSync(tasksScript)) return { ok: false, text: "取消失败 ❌\n原因：找不到任务查询脚本 " + tasksScript };
        const result = await runProcess(powershell, ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", tasksScript, "-Action", "cancel"], 15000);
        if (result.code !== 0) return { ok: false, text: "取消失败 ❌\n原因：取消脚本失败（exit " + result.code + "）\n" + tailLines(result.output, 6) };
        return { ok: true, text: "已取消重启任务：\n" + (tailLines(result.output, 10) || "（没有可取消的任务）") };
      },
    }));
  } catch (error) {
    log("[boot] register restart_cancel failed: " + String(error?.message ?? error));
  }

  // ---------- boot hook: "我回来啦" ----------
  if (announce) {
    const timer = setTimeout(() => {
      void announceIfPending(ctx, {
        file: announceFile,
        maxAgeMinutes: announceMaxAgeMinutes,
        botId: config?.announceBotId,
        targetId: config?.announceTargetId,
        autoTarget: config?.announceAutoTarget !== false,
        log,
      }).catch((error) => log("[announce] unexpected failure: " + String(error?.message ?? error)));
    }, 3000);
    if (typeof timer.unref === "function") timer.unref();
  }
}
