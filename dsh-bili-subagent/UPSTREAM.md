# 本目录 = dsh-bili-subagent 的自用维护版

- **上游**：`dsh-bili-subagent` 0.9.8 · MIT · <https://github.com/Yuuyuko-uu/dsh-bili-subagent>（npm 同名包）
- **拷贝来源**：`D:\dsh-home\profiles\desktop\node_modules\dsh-bili-subagent`（2026-11-11 22:40 拷入仓库，之后 profile 用 junction 指这里）
- **许可证**：MIT，保留原 `LICENSE`；本目录的改动同样以 MIT 发布

## 我们对上游做了什么

| 文件 | 改动 |
| --- | --- |
| `index.js` | +19 行：注册 `bili_digest` 工具（参数 bvid / comments≤10 / lines 5–120 / full） |
| `vendor/bilibili-mcp/mcp_server.py` | +91 行：实现 `bili_digest` MCP tool —— 一次返回「视频数据 + 压缩字幕（带时间戳、均匀抽样）+ 前几条热评」 |

**纯新增，未改动任何上游逻辑**（2026-11-11 与 npm 0.9.8 原版逐文件 diff：删除行 0 / 0）。

## 为什么要它

刷站报告要「数据 + 字幕 + 热评」三样；分开调要 3 次往返。`bili_digest` 一次拿全，实测 4 条视频共 5 次调用、约 ¥0.06。

## 上游升级流程

1. 确认上游新版本：`curl -s https://registry.npmjs.org/dsh-bili-subagent | jq -r '."dist-tags".latest'`，或看 GitHub tag。
2. 下载新 tarball 解开，和本目录做 `diff -r`：先确认**上游自己**改了什么。
3. 把我们那两段（`index.js` 的 tool 注册、`mcp_server.py` 的 `bili_digest`）重新插回去。
4. 跑 `node --test tests/*.test.mjs`（上游自带）与 `node selfcheck.mjs`。
5. 重启 DSH 生效（junction 安装，改完不用复制）。

## 每周六自动检查

有一条周排程会比对**上游版本 vs 本目录版本**，并列出：
- `dsh-bilibili` ← <https://github.com/CZX2244/dsh-bilibili>
- `dsh-handoff` ← <https://github.com/zhenbang1216/dsh-handoff>
- `dsh-bili-subagent` ← <https://github.com/Yuuyuko-uu/dsh-bili-subagent>
- `dsh-pet-vk`（`apps/vk1-plugin`，上游待确认）

有更新就跑 `diff -r` 出报告，不自动合并。

## 铺到 `$DSH_HOME/bili-duty/` 的时机

插件每次启动会 `ensureHomeFiles()`：把 `vendor/bilibili-mcp/mcp_server.py` 与 `lib/asr.py` 铺到 `$DSH_HOME/bili-duty/`，**内容不同就覆盖**（同内容跳过）。所以改完本目录的 `vendor/…/mcp_server.py`，**重启 DSH 就会自动同步**，不用手动拷；运行中的 Python MCP 读的是家里那份。

（`tools/swap-node-modules-link.cmd` 是把 profile `node_modules` 里那份换成指向本目录 junction 的一次性脚本，留档用。）
