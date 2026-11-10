# dsh-restart

让 agent 能从 IM / Web 会话里**安全地把整个 DSH 重启**，并在重启成功后自动说一句「我回来啦」。

## 为什么做成插件

重启是桌面端的事（杀进程 + 拉起），但人在微信 / Web 里时，agent 没有「点那个按钮」的能力。
本插件给模型四个工具，把这件事变得可验证、可撤销、可播报。

## 四个工具

| 工具 | 参数 | 作用 |
| --- | --- | --- |
| `restart_dsh` | `confirm`(必填 true)、`delay_seconds`、`start_script`、`watch_seconds`、`reason` | 排一次重启：先杀后起，可选维护半段和看门狗 |
| `restart_status` | 无 | 查 `DSH-Restart-*` 任务状态 + 日志尾部 |
| `restart_cancel` | 无 | 撤销还没触发的重启任务 |
| `restart_announce_test` | 无 | 立刻发一次问候，**不重启**，用来验证 IM 投递是否通 |

工具返回值统一是对象 `{ ok, text }`（宿主会按 `output.schema` 校验，返回字符串会报
`"value" must be an object`）。

## 一次重启会发生什么

```
T+0      restart_dsh 被调用
         → 校验脚本 / 日志目录 / start_script
         → 写 marker（问候语 + 时间戳，30 分钟有效）
T+45     计划任务 Kill 触发：restart-dsh-kill.cmd（只做 taskkill）
T+56     计划任务 Start 触发：restart-dsh-fallback.cmd
         没在跑就 restart-dsh-start.ps1（explorer 启动 + 20 秒复查，失败重试一次）
T+56+   DSH 起来 → 插件 apply() → 3 秒后读 marker
         轮询等 IM 服务（最多 25 秒）、遍历所有机器人找投递目标（最多 20 秒）
         → dshIm.send(botId, targetId, "咕噜～本鱼回来啦…")
```

**先删 marker 再发**：崩溃循环不会刷屏；marker 过期（默认 30 分钟）自动丢弃；非计划启动没有 marker，不会打扰。

## 维护重启（先跑 pnpm 再拉起）

```
restart_dsh({
  confirm: true,
  delay_seconds: 120,
  start_script: "C:\\Users\\kh006\\.dsh\\im\\scripts\\restart-dsh-maint-start.cmd",
  watch_seconds: 600,
  reason: "装了新插件"
})
```

`restart-dsh-maint-start.cmd` 做四件事：
`pnpm install` → 验 `@dsh-ops` 还在（不在就从 C 旧 profile robocopy）→ 写问候 marker → 拉起 DSH。

> 安全阀：如果 DSH 还在跑，**跳过 pnpm**——运行中的 pnpm 曾把 `@dsh-ops` 删掉（2026-11-09 14:08）。

## 它不重新实现调度

杀/起仍然走工作区里那套踩过坑的脚本：

| 脚本 | 作用 |
| --- | --- |
| `restart-dsh-arm.ps1` | 先注册 Start、再注册 Kill，失败自动回滚（默认路径） |
| `restart-dsh-arm2.ps1` | 严格超集：多 `-StartScript` / `-WatchAfterSeconds`，回滚逻辑相同 |
| `restart-dsh-kill.cmd` | 只 taskkill（火绒会在 kill 后连带杀掉本进程，所以「杀」和「起」必须拆开） |
| `restart-dsh-fallback.cmd` | 没在跑就拉起，失败重试一次 |
| `restart-dsh-start.ps1` | explorer 启动 + 20 秒存活确认 |
| `restart-dsh-watchdog.cmd` | 第三任务：还在 down 就补拉，然后清任务 |
| `dsh-restart-tasks.ps1` | status / cancel 的实现 |
| `write-announce-marker.ps1` | 供脚本侧写 marker（问候文本在 `logs/announce-text.txt`） |

## 配置（`cordis.patch.yml`）

| 键 | 默认 | 说明 |
| --- | --- | --- |
| `armScript` | `scripts/restart-dsh-arm.ps1` | 默认排程脚本 |
| `maintArmScript` | `scripts/restart-dsh-arm2.ps1` | 带 `start_script`/`watch_seconds` 时用 |
| `tasksScript` | `scripts/dsh-restart-tasks.ps1` | status / cancel 实现 |
| `logFile` | `logs/restart-dsh.log` | 插件与脚本共用的日志 |
| `powershell` | `powershell.exe` | 调用器 |
| `defaultKillSeconds` | 45 | 默认延迟，夹在 20–600 |
| `announce` | true | 是否播报 |
| `announceText` | 咕噜～本鱼回来啦… | 问候语（脚本侧读 `announce-text.txt`） |
| `announceMaxAgeMinutes` | 30 | marker 有效期 |
| `announceFile` | `logs/restart-announce.json` | marker 路径 |
| `announceBotId` / `announceTargetId` | 空 | 留空 = 自动挑第一个有目标的机器人 |

## 日志

| 文件 | 内容 |
| --- | --- |
| `logs/restart-dsh.log` | 插件 `[boot]` / `[announce]` + 脚本的排程/杀/起记录 |
| `logs/restart-maint.log` | 维护半段（pnpm / robocopy / 启动） |
| `logs/restart-import.log` | 模块被 import 一次写一行，排查「插件到底加载没加载」 |
| `logs/announce-text.txt` | 问候语文本（UTF-8，改完不用动代码） |

## 安全边界

- **只在 Windows 有效**（Task Scheduler + `powershell.exe`）。
- 必须 `confirm: true`；工具描述写死「除非用户明确要求，否则不要调用」。
- `delay_seconds` 下限 20 秒，留出返回结果的窗口。
- 不会删用户数据；排程失败会回滚已注册的任务。
- 问候只走 IM 主动投递；**Web GUI 没有推送通道**，没人说话时不会自己冒出一句。

## 测试

```powershell
cd apps/dsh-restart
node --test test/args.test.mjs test/announce.test.mjs test/timings.test.mjs
```

覆盖：默认值/边界夹紧、arm 参数拼装、任务状态解析、marker 读写与过期、投递目标解析（多机器人扫描、失败跳过）。

真实宿主模块下的冒烟（用 app.asar 里的 `defineTool`）：

```powershell
ELECTRON_RUN_AS_NODE=1 "D:/DSH/DeepSeek Harness.exe" --expose-internals run.mjs
```

## 安装（需要停 DSH 再 pnpm）

```
dependencies 加 "dsh-restart": "link:C:/Users/kh006/.dsh/im/apps/dsh-restart"
dsh.profile.bundles 加 "dsh-restart"
```

**`peerDependencies` 必须声明** `@deepseek-ai/cordis`、`dsh-tools`、`schemastery`，否则 link 安装的插件
拿不到宿主包，会以 `ERR_MODULE_NOT_FOUND` 被静默跳过（桌面端看不到这个错误，只有 `dsh --profile <临时> --no-open` 才看得到）。

## 已知限制

- 播报需要 IM 投递目标（设置 → IM机器人 → 新建目标），服务没有「自动建目标」的 API。
- 只能按「从现在起 N 秒」排程；按绝对时间排要用 `scripts/arm-maint-at.ps1`。
