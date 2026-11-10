# pkkkkh 的 DSH 插件仓库

按「一个子目录 = 一个插件」组织。每个子目录都是独立、可单独安装的 DeepSeek Harness 插件。

> 本仓库是**自己在用的维护版**：三个插件都不只是跟随上游，功能按我们的需要持续加、bug 我们自己修。

| 目录 | 插件 | 版本 | 说明 |
|---|---|---|---|
| [`dsh-bilibili/`](dsh-bilibili/) | dsh-bilibili | 0.8.1 | B 站视频分析：文稿骨架、通道探针、交叉校验、商单折叠、定点抓帧 |
| [`dsh-handoff/`](dsh-handoff/) | dsh-handoff | 0.4.0 | 会话交接文档 + 侧边栏整页面板：历史/版本/预览/复制/下载、`/attach` 接续、工具活动清单 |
| [`dsh-restart/`](dsh-restart/) | dsh-restart | 0.1.0 | 让 agent 安全自重启 DSH：杀/起分离 + 回滚 + 存活复查，重启成功后自动发一句问候 |

## 本机自用的另外两个（不在本仓库）

这两个是本机跑着的兄弟插件，暂时留在工作区（`apps/` 下），没并进来：

| 插件 | 版本 | 说明 |
|---|---|---|
| `im-session-archive` | 0.2.0 | **IM 会话归档 + 跨会话长期上下文**：按通道只留最近 1 个会话（只归档不删除）；维护 `LONGTERM.md`（长期状态 + 最近 30 段时间线，每轮刷新）；每段会话落一份快照；系统提示里要求新会话开局先读它。`/new` 自动注入摘要默认**关闭**——`agent.inject` 会和 IM 桥的 append 抢锁，曾把新会话第 3、4 轮弄挂 |
| `im-full-access` | 0.1.0 | **给 IM 会话自动开全盘权限**：命中「标题以通道名前缀开头」或「cwd 在白名单」就设 `danger-full-access` + `approval: never`，让微信里发的任务能直接读写工作区外。系统层面没有兜底，全靠工作区 `AGENTS.md` 的约定约束 |

## dsh-restart 是什么

重启是桌面端的事（杀进程 + 拉起），但人在微信 / Web 里时，agent 没有「点那个按钮」的能力。这个插件把这件事做成**可验证、可撤销、可播报**的四件工具：

| 工具 | 作用 |
| --- | --- |
| `restart_dsh` | 排一次重启（可选维护半段 `start_script`、第三层 `watch_seconds` 看门狗） |
| `restart_status` | 查 `DSH-Restart-*` 任务状态 + 日志尾部 |
| `restart_cancel` | 撤销还没触发的重启 |
| `restart_announce_test` | 立刻发一次问候，不重启，用来验证 IM 投递通道 |

一次重启：

```
T+45s  Kill 任务（只 taskkill —— 火绒 HIPS 会连带杀掉执行 taskkill 的进程，所以「杀」和「起」必须拆开）
T+56s  Start 任务（没在跑就 explorer 拉起 + 20 秒存活复查，失败重试一次）
起来后 插件读到 marker → 通过 IM 主动投递发「我回来啦」
```

带维护的重启会先跑 `pnpm install`、验证 `@dsh-ops` 还在，再写 marker、再拉起；**DSH 还在跑时跳过 pnpm**（运行中的 pnpm 曾把 `@dsh-ops` 删掉）。

细节、配置项、日志位置见 [`dsh-restart/README.md`](dsh-restart/README.md)。

## 安装到 DSH

把对应子目录整个放到 DSH 的插件目录（`$DSH_HOME/profiles/desktop/node_modules/<插件名>`），
并在 `profiles/desktop/package.json` 的 `dependencies` 写 `link:`、在 `dsh.profile.bundles` 里加上名字，
然后重启 DSH。

本机的 `$DSH_HOME` 是 `D:\dsh-home`（2026-11-09 从 C 盘切换过来）。

**两个容易踩的坑**：

1. **link 安装的插件必须在 `package.json` 里声明 `peerDependencies`**（`@deepseek-ai/cordis`、`dsh-tools`、`schemastery` 等），
   否则拿不到宿主包，会以 `ERR_MODULE_NOT_FOUND` 被**静默跳过**；
2. 这类加载错误**只打到 stderr**，桌面端用 explorer 拉起时看不到 —— 诊断要用
   `dsh --profile <临时的配置拷贝 profile> --no-open` 才看得到。

`dsh-bilibili` 的 `lib/` 改动需要手动同步到运行时目录才生效，细节见 `dsh-bilibili/SYNC.md`。

## 来源与协议

- `dsh-bilibili` 派生自 [CZX2244/dsh-bilibili](https://github.com/CZX2244/dsh-bilibili)，本仓库是个人修改版，增加了文稿骨架压缩、通道探针、双字幕轨/第二路 ASR 交叉校验与商单识别折叠。
- `dsh-handoff` 来自 [zhenbang1216/dsh-handoff](https://github.com/zhenbang1216/dsh-handoff)（上游 0.3.0）。本仓库是自用维护版（0.4.0）：补了客户端面板（侧边栏整页 + `/api/dsh-handoff/*` 接口）、版本与续写、工具活动清单、`/attach` 接续等，并带 128 项测试。
- `dsh-restart` 是本仓库原创（0.1.0）：把工作区里那套踩过坑的重启脚本（先注册 Start 再注册 Kill、失败回滚、explorer 拉起 + 存活复查）包成模型可调的工具，并加上「重启后自动问候」。带 26 项单测。
- 三个项目均为 MIT 协议，各自的 `LICENSE` 与 `README.md` 位于子目录内。
