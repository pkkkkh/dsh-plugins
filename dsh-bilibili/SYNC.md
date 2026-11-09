# 改完记得同步（重要）

**2026-11-09 起本目录就是运行时本身**：profile 用 `link:` 安装，`node_modules/dsh-bilibili` 是指向这里的 junction。

```
运行时：$DSH_HOME\profiles\desktop\node_modules\dsh-bilibili  →  本目录
源码/产物：C:\Users\kh006\.dsh\im\apps\dsh-bilibili\dsh-bilibili
```

所以改完 `lib/*.js` **直接重启 DSH 即可，不用再复制**（校验脚本也看不出差异，因为两边是同一份）。
C 盘 `~/.dsh` 里的那份是旧副本，改了不生效，别去改它。

`$DSH_HOME` 本机 = `D:\dsh-home`（2026-11-09 从 C 盘切过来）。

## 同步（只在 profile 不是 link 安装时才需要）

> 现在是 junction，**跳过这一节**。下面是「哪天又变回 `file:` 复制安装」时的兜底。

```powershell
$home = if ($env:DSH_HOME) { $env:DSH_HOME } else { Join-Path $env:USERPROFILE ".dsh" }
$src  = "C:\Users\kh006\.dsh\im\apps\dsh-bilibili\dsh-bilibili\lib"
$dst  = Join-Path $home "profiles\desktop\node_modules\dsh-bilibili\lib"

# 全量同步（最稳，别只挑这几个文件）
Copy-Item "$src\*.js" $dst -Force
```

同步后需要重启 DSH 才会重新加载模块。

## 校验

```powershell
& "D:\DSH\resources\runtime\primary-runtime\dependencies\node\bin\node.exe" `
  "C:\Users\kh006\.dsh\im\scripts\check-bilibili.mjs"
```

脚本读 `DSH_HOME` 自动定位运行时（切 home 后不用改），会先**打印解析出的运行时目录**，
再比对两份文件是否逐字节一致、跑 digest/channel 的功能用例。退出码 0 = 通过。

## 单元测试（58 项）

工作区没有装依赖（`login.js` 依赖 `qrcode`），所以**测试只能在装机目录跑**：

```powershell
$home = if ($env:DSH_HOME) { $env:DSH_HOME } else { Join-Path $env:USERPROFILE ".dsh" }
$P = Join-Path $home "profiles\desktop\node_modules\dsh-bilibili"
Copy-Item "C:\Users\kh006\.dsh\im\apps\dsh-bilibili\dsh-bilibili\test" "$P\test" -Recurse -Force
Push-Location $P
& "D:\DSH\resources\runtime\primary-runtime\dependencies\node\bin\node.exe" --test --test-reporter=dot
Pop-Location
Remove-Item "$P\test" -Recurse -Force
```

## 可调环境变量

| 变量 | 默认 | 作用 |
|---|---|---|
| `DSH_BILIBILI_FRAME_CONCURRENCY` | 3 | 抓帧并发（1–8） |
| `DSH_BILIBILI_VISION_CONCURRENCY` | 2 | 视觉描述并发（1–4） |
| `DSH_BILIBILI_CACHE_TTL_HOURS` | 72 | `%TEMP%\dsh-bilibili\BV*` 保留时长，0=不按时间清 |
| `DSH_BILIBILI_CACHE_MAX_MB` | 2048 | 该目录总容量上限，0=不按容量清 |
| `DSH_BILIBILI_DIGEST` / `_RATIO` / `DSH_BILIBILI_CHANNEL` | — | 关闭骨架 / 调整压缩比 / 关闭通道探针 |
| `DSH_BILIBILI_ADS` | 开 | 置 0 关闭商单识别与折叠 |
| `cross_check`（工具参数）/ `crossCheckAsr`（配置） | 关 | 第二路 ASR（必剪）交叉校验，约多花 10–60 秒 |

## 运行时文件（junction 后就在本目录）

- `.sessdata.json` / `.qr-login.png`：登录凭证，**在本目录里**（`.gitignore` 已排除，别提交、别删）；
- `.envcheck.json`：环境体检缓存（同样不入库）；
- profile 里的旧副本留在 `node_modules\dsh-bilibili.old`，稳定几天后可以删。

## 回滚

2026-11-05 的 `lib.bak-20261105` 已经清理（C、D 两边的运行时里都没有了）。
要回滚只能重新从上游 [CZX2244/dsh-bilibili](https://github.com/CZX2244/dsh-bilibili) 拉对应版本，
再把本仓库的修改重新打上。
