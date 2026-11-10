/**
 * im-full-access — 让「IM 通道」或「白名单工作区」的会话自动获得完全文件权限。
 *
 * 为什么需要它：DSH 的默认权限是部署级开关（环境变量 DSH_PERMISSION_MODE），
 * 一开就是所有会话全权限，桌面会话也跟着放开。而权限模式其实是**每个会话独立**
 * 的投影，行为由三条事件决定：`permission/preset` → `sandbox/mode` → `approval/policy`。
 * 这个插件就只在「该给的会话」上追加这三条，别的会话完全不动。
 *
 * 判断依据（任一命中即开）：
 *   1. 会话标题前缀 = 某个 IM 通道名（「微信 · 对话4」这种，跟工作区无关）
 *      —— 必须带分隔符（空格 / · / : / - / ｜），避免「微信小程序开发」这种
 *         桌面会话标题被误判成微信通道。
 *   2. 会话的 cwd 落在白名单目录里（跟来源无关）
 *
 * 触发时机：会话标题是 `session/title` 事件，可能在创建之后才写入，所以插件监听
 * 会话事件流而不是「创建瞬间」。工作区规则不需要标题，另在首条用户消息时补一次。
 */

const PRESET_EVENT = "permission/preset";
const MODE_EVENT = "sandbox/mode";
const APPROVAL_EVENT = "approval/policy";

const DEFAULT_MODE = "danger-full-access";
const DEFAULT_APPROVAL = "never";

/** 通道名后面必须跟这些分隔符之一，否则不算命中（防「微信小程序」误伤）。 */
const SEPARATORS = [" ", "\t", "·", "・", "•", ":", "：", "-", "－", "—", "|", "｜", "/", "\\", "_"];

/** 会话级去重：同一会话只追加一次，避免每轮都写。 */
const granted = new WeakSet();

function normalizeDir(value) {
  if (typeof value !== "string" || value.trim() === "") return "";
  return value
    .trim()
    .replace(/\//g, "\\")
    .replace(/\\{2,}/g, "\\")
    .replace(/\\+$/, "")
    .toLowerCase();
}

function isUnder(cwd, root, recursive) {
  const target = normalizeDir(cwd);
  if (!target || !root) return false;
  if (target === root) return true;
  return recursive === true && target.startsWith(root + "\\");
}

/** 标题是否以「通道名 + 分隔符」开头。 */
function matchChannelHead(text, channel) {
  if (!text.startsWith(channel)) return false;
  const rest = text.slice(channel.length);
  if (rest === "") return false;
  const first = rest[0];
  if (SEPARATORS.includes(first)) return true;
  return /^\s/.test(first);
}

export const name = "im-full-access";

export function apply(ctx, config = {}) {
  const mode = typeof config.mode === "string" && config.mode ? config.mode : DEFAULT_MODE;
  const preset = typeof config.preset === "string" && config.preset ? config.preset : mode;
  // approval: 'never' | 'ask'；传 null / '' 表示不动审批策略
  const approval =
    config.approval === null || config.approval === "" ? null : (config.approval ?? DEFAULT_APPROVAL);
  const channels = (Array.isArray(config.channels) ? config.channels : [])
    .map((item) => String(item ?? "").trim())
    .filter(Boolean);
  const workspaces = (Array.isArray(config.workspaces) ? config.workspaces : [])
    .map(normalizeDir)
    .filter(Boolean);
  const recursive = config.recursive !== false;

  if (channels.length === 0 && workspaces.length === 0) {
    ctx.logger?.info?.("[im-full-access] 没有配置 channels / workspaces，插件空转");
    return;
  }

  /** 命中返回原因，未命中返回 null。 */
  const match = (session, title) => {
    const cwd = session?.header?.cwd;
    for (const root of workspaces) {
      if (isUnder(cwd, root, recursive)) return "workspace";
    }
    const text = typeof title === "string" ? title.trim() : "";
    if (text) {
      for (const channel of channels) {
        if (matchChannelHead(text, channel)) return "channel";
      }
    }
    return null;
  };

  const grant = (session, reason, detail) => {
    if (!session || granted.has(session)) return;
    granted.add(session);
    // 不能在 session/event 的回调里直接 append：发布会重入并被拒绝。
    setTimeout(() => {
      try {
        // 顺序与界面手动切权限一致：preset → sandbox → approval
        session.append(PRESET_EVENT, { preset });
        session.append(MODE_EVENT, { mode });
        if (approval) session.append(APPROVAL_EVENT, { policy: approval });
        ctx.logger?.info?.(
          `[im-full-access] ${preset} / ${mode}${approval ? " / approval=" + approval : ""} → ${session.id}` +
            `（${reason}${detail ? ":" + detail : ""}）`,
        );
      } catch (error) {
        granted.delete(session);
        ctx.logger?.warn?.(
          `[im-full-access] 追加权限事件失败（${session.id}）：${error?.message ?? error}`,
        );
      }
    }, 0);
  };

  ctx.on("session/event", (session, event) => {
    if (!event || typeof event.type !== "string") return;

    if (event.type === "session/title") {
      const title = event.data?.title;
      const reason = match(session, title);
      if (reason) grant(session, reason, typeof title === "string" ? title.slice(0, 24) : "");
      return;
    }

    // 工作区规则不依赖标题：首条用户消息时兜底判一次
    if (event.type === "user/message") {
      if (match(session, undefined) === "workspace") {
        grant(session, "workspace", session?.header?.cwd);
      }
    }
  });
}
