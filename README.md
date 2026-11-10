# pkkkkh 的 DSH 插件仓库

按「一个目录 = 一个插件」组织；同用途的插件可以归到一个分类目录里（例如 `im/`）。每个目录都是独立、可单独安装的 DeepSeek Harness 插件。

> 本仓库是**自己在用的维护版**：五个插件都不只是跟随上游，功能按我们的需要持续加、bug 我们自己修。

| 目录 | 插件 | 版本 | 说明 |
|---|---|---|---|
| [`dsh-bilibili/`](dsh-bilibili/) | dsh-bilibili | 0.8.1 | B 站视频分析：文稿骨架、通道探针、交叉校验、商单折叠、定点抓帧 |
| [`dsh-handoff/`](dsh-handoff/) | dsh-handoff | 0.4.0 | 会话交接文档 + 侧边栏整页面板：历史/版本/预览/复制/下载、`/attach` 接续、工具活动清单 |
| [`dsh-restart/`](dsh-restart/) | dsh-restart | 0.1.0 | 让 agent 安全自重启 DSH：杀/起分离 + 回滚 + 存活复查，重启成功后自动发一句问候 |
| [`im/im-session-archive/`](im/im-session-archive/) | im-session-archive | 0.2.0 | IM 会话归档 + 跨会话长期上下文：按通道留最近 1 个、每轮刷新 `LONGTERM.md`、新会话开局读它 |
| [`im/im-full-access/`](im/im-full-access/) | im-full-access | 0.1.0 | 给 IM 会话自动开全盘权限（`danger-full-access` + 免审批），让微信里发的任务能直接读写工作区外 |

## im/ 分类：两个只服务 IM 通道的插件

### im-session-archive —— 记忆

| 功能 | 说明 |
| --- | --- |
| 自动归档 | 只处理 IM 通道（微信/QQ/飞书/企微/钉钉/TG）的会话；每通道保留最近 1 个，其余归档（**只归档、不删除**） |
| 长期记忆 | 维护 `LONGTERM.md`：「长期状态」由模型/人维护，「会话时间线」自动生成，每轮 turn/end 刷新，最多 30 段 |
| 单段快照 | 每段会话落一份 `memory/auto/<时间>-<sid>.md`，审计/回看用 |
| 开局读记忆 | 往系统提示里加一条规则：新会话处理第一条消息前先读 `LONGTERM.md` |
| 新会话注入摘要 | **默认关闭**：`agent.inject` 与 IM 桥的 append 抢锁，曾把新会话第 3、4 轮弄挂（`injectOnNewSession: false`） |

### im-full-access —— 权限

命中规则就给会话开 `danger-full-access` + `approval: never`，让微信里发起的任务无需逐次审批：

- **通道规则**：会话标题以「通道名 + 分隔符」开头（`微信 · xxx`、`QQ · xxx`…）
- **工作区规则**：会话 cwd 命中白名单（目前只有 IM 工作区）—— 实测这条在新会话里不触发，**通道规则本身每次都成功**，所以留着无害但别依赖

> 系统层面没有兜底，安全边界完全靠工作区的 `AGENTS.md` 约定（删改前报告、先备份等）。

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
