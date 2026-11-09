# pkkkkh 的 DSH 插件仓库

按「一个子目录 = 一个插件」组织。每个子目录都是独立、可单独安装的 DeepSeek Harness 插件。

> 本仓库是**自己在用的维护版**：两个插件都不只是跟随上游，功能按我们的需要持续加、bug 我们自己修。

| 目录 | 插件 | 版本 | 说明 |
|---|---|---|---|
| [`dsh-bilibili/`](dsh-bilibili/) | dsh-bilibili | 0.8.1 | B 站视频分析：文稿骨架、通道探针、交叉校验、商单折叠、定点抓帧 |
| [`dsh-handoff/`](dsh-handoff/) | dsh-handoff | 0.4.0 | 会话交接文档 + 侧边栏整页面板：历史/版本/预览/复制/下载、`/attach` 接续、工具活动清单 |

## 安装到 DSH

把对应子目录整个放到 DSH 的插件目录（`$DSH_HOME/profiles/desktop/node_modules/<插件名>`），然后重启 DSH。
本机的 `$DSH_HOME` 是 `D:\dsh-home`（2026-11-09 从 C 盘切换过来）。

`dsh-bilibili` 的 `lib/` 改动需要手动同步到运行时目录才生效，细节见 `dsh-bilibili/SYNC.md`。

## 来源与协议

- `dsh-bilibili` 派生自 [CZX2244/dsh-bilibili](https://github.com/CZX2244/dsh-bilibili)，本仓库是个人修改版，增加了文稿骨架压缩、通道探针、双字幕轨/第二路 ASR 交叉校验与商单识别折叠。
- `dsh-handoff` 来自 [zhenbang1216/dsh-handoff](https://github.com/zhenbang1216/dsh-handoff)（上游 0.3.0）。本仓库是自用维护版（0.4.0）：补了客户端面板（侧边栏整页 + `/api/dsh-handoff/*` 接口）、版本与续写、工具活动清单、`/attach` 接续等，并带 128 项测试。
- 两个项目均为 MIT 协议，各自的 `LICENSE` 与 `README.md` 位于子目录内。
