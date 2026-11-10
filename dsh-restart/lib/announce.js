/**
 * "我回来啦" announcement support for dsh-restart.
 *
 * Flow:
 *   1. `restart_dsh` arms a restart      → writeMarker() drops a JSON marker
 *   2. DSH goes down, the start task brings it back
 *   3. the plugin loads again            → announceIfPending() sees the fresh
 *                                          marker and pushes the greeting once
 *
 * The marker is what makes this safe: a normal (unplanned) app start finds no
 * marker and stays silent, and the marker is deleted before the push so a
 * crash-loop cannot spam the chat.
 *
 * Kept free of @deepseek-ai imports so `node --test` can run standalone.
 */
import { existsSync, readFileSync, writeFileSync, unlinkSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";

export const DEFAULT_ANNOUNCE_TEXT = "咕噜～本鱼回来啦，尾巴甩甩，满血复活！";
export const DEFAULT_MAX_AGE_MINUTES = 30;

/**
 * Persist the pending-announce marker. Never throws.
 *
 * @param {string} file absolute path
 * @param {string} text greeting to send after the restart
 * @param {Date} [now]
 * @returns {{ ok: boolean, error?: string }}
 */
export function writeMarker(file, text, now = new Date()) {
  try {
    mkdirSync(dirname(file), { recursive: true });
    const payload = {
      version: 1,
      at: now.toISOString(),
      text: String(text ?? "").trim() || DEFAULT_ANNOUNCE_TEXT,
    };
    writeFileSync(file, JSON.stringify(payload, null, 2) + "\n", "utf8");
    return { ok: true };
  } catch (error) {
    return { ok: false, error: String(error?.message ?? error) };
  }
}

/**
 * Read the marker, returning null when missing or unparseable.
 * @param {string} file
 */
export function readMarker(file) {
  try {
    if (!existsSync(file)) return null;
    const parsed = JSON.parse(readFileSync(file, "utf8"));
    if (!parsed || typeof parsed.text !== "string" || !parsed.text.trim()) return null;
    const at = Date.parse(parsed.at);
    if (!Number.isFinite(at)) return null;
    return { at, text: parsed.text.trim() };
  } catch {
    return null;
  }
}

/**
 * Is this marker still from the restart we just did?
 *
 * @param {{ at: number } | null} marker epoch ms
 * @param {Date} [now]
 * @param {number} [maxAgeMinutes]
 */
export function isFresh(marker, now = new Date(), maxAgeMinutes = DEFAULT_MAX_AGE_MINUTES) {
  if (!marker) return false;
  const ttl = Math.max(1, Number(maxAgeMinutes) || DEFAULT_MAX_AGE_MINUTES) * 60 * 1000;
  const age = now.getTime() - marker.at;
  return age >= 0 && age <= ttl;
}

/** Delete the marker. Never throws; returns true when something was removed. */
export function clearMarker(file) {
  try {
    if (!existsSync(file)) return false;
    unlinkSync(file);
    return true;
  } catch {
    return false;
  }
}

/**
 * Work out where the greeting should go, using the REAL dshIm service surface.
 *
 * The service (contractVersion 1) exposes only:
 *   listBots(): [{ botId, channel }]
 *   listTargets(botId): [{ targetId, ... }]   (an ARRAY, not { targets })
 *   send(botId, targetId, text, opts)
 * There is no listSuggestions / createTarget, so a target must already exist —
 * it is created by the user in 设置 → IM机器人 → 新建目标.
 *
 * @param {{ listBots?: Function, listTargets?: Function }} im
 * @param {{ botId?: string, targetId?: string }} [configured]
 * @returns {Promise<{ botId: string, targetId: string } | { error: string, botId?: string }>}
 */
export async function resolveDelivery(im, configured = {}) {
  const forcedBot = String(configured?.botId ?? "").trim();
  const forced = String(configured?.targetId ?? "").trim();
  if (forcedBot && forced) return { botId: forcedBot, targetId: forced };

  let bots = [];
  try {
    if (typeof im?.listBots === "function") bots = await im.listBots();
  } catch { bots = []; }
  const botIds = forcedBot
    ? [forcedBot]
    : (Array.isArray(bots) ? bots.map((b) => String(b?.botId ?? "")).filter(Boolean) : []);
  if (botIds.length === 0) return { error: "no-bot" };

  if (forced) return { botId: botIds[0], targetId: forced };
  if (typeof im?.listTargets !== "function") return { error: "no-target", botId: botIds[0] };

  // Scan every connected bot: the target may be saved under a different
  // channel than the one that happens to be listed first.
  let lastError = "";
  for (const botId of botIds) {
    let targets;
    try {
      targets = await im.listTargets(botId);
    } catch (error) {
      lastError = "list-targets-failed: " + String(error?.message ?? error);
      continue;
    }
    if (targets && !Array.isArray(targets) && Array.isArray(targets.targets)) targets = targets.targets;
    const first = Array.isArray(targets) ? String(targets[0]?.targetId ?? "") : "";
    if (first) return { botId, targetId: first };
  }
  return lastError ? { error: lastError, botId: botIds[0] } : { error: "no-target", botId: botIds[0] };
}
