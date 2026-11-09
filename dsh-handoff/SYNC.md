# 改完记得构建并同步（重要）

这个插件是 **TypeScript 源码 + 编译产物** 的结构，运行时加载的不是 `src/`。

```
原始源码：C:\Users\kh006\.dsh\im\apps\dsh-bilibili\dsh-handoff\src
编译产物：C:\Users\kh006\.dsh\im\apps\dsh-bilibili\dsh-handoff\lib
运行时：  $DSH_HOME\profiles\desktop\node_modules\dsh-handoff
```

> **2026-11-09 起 DSH 的 home 切到了 `D:\dsh-home`**，所以本机运行时是
> `D:\dsh-home\profiles\desktop\node_modules\dsh-handoff`。
> 同一时间 profile 改用 **`link:`** 安装：运行时是**指向本目录的 junction**，
> 所以 `pnpm build` 之后**直接重启即可，不用再手动 copy**（下面的「同步到运行时」只在非 link 安装时才需要）。
> 命令统一用 `$home` 自动解析，别写死 C 盘（C 上那份是旧副本）。

## 改代码的标准流程

pnpm 不在系统 PATH 里，用 DSH 自带的这个（11.28.5）。先解析 `$home`：

```powershell
$home = if ($env:DSH_HOME) { $env:DSH_HOME } else { Join-Path $env:USERPROFILE ".dsh" }
$node = Join-Path $home "dsh-runtimes\dsh-primary-runtime\dependencies\node\bin\node.exe"
$pnpm = Join-Path $home "dsh-runtimes\dsh-primary-runtime\dependencies\pnpm\bin\pnpm.mjs"
$env:Path = (Split-Path $node) + ";" + $env:Path   # pnpm 脚本里会直接调 node
cd C:\Users\kh006\.dsh\im\apps\dsh-bilibili\dsh-handoff

& $node $pnpm install      # 首次，或 package.json 变了
& $node $pnpm build        # tsdown：src/*.ts → lib/index.js + lib/client.js
& $node $pnpm test         # vitest，13 个测试文件
& $node $pnpm typecheck    # 可选，改类型时跑
```

## 同步到运行时（只在 profile 不是 link 安装时才需要）

> 2026-11-09 起 profile 用 `link:` 安装，运行时就是本目录的 junction —— **build 完重启即可，跳过这一节**。
> 下面这段是给「哪天又变回 `file:` 复制安装」准备的兜底。

```powershell
$home = if ($env:DSH_HOME) { $env:DSH_HOME } else { Join-Path $env:USERPROFILE ".dsh" }
$src  = "C:\Users\kh006\.dsh\im\apps\dsh-bilibili\dsh-handoff"
$dst  = Join-Path $home "profiles\desktop\node_modules\dsh-handoff"
Copy-Item "$src\lib\*" "$dst\lib" -Force
Copy-Item "$src\package.json","$src\cordis.patch.yml" $dst -Force
```

同步后**重启 DSH** 才会重新加载。

## 两个产物，别只同步一个

| 产物 | 内容 | 说明 |
|---|---|---|
| `lib/index.js` | Host 半边（Cordis 插件） | 服务端逻辑：生成文档、写文件、路由 |
| `lib/client.js` | Client 半边（浏览器） | 打包成 `window.__ModuleLoader__.load(...)` 形式，由 Web 端加载 |

只同步 `index.js` 而忘了 `client.js`，界面那半边会仍是旧版本。

## 快速自检

在上一节的 PowerShell 会话里（`$node` / `$pnpm` / `$env:Path` 已就绪）：

```powershell
& $node $pnpm check:install desktop   # 检查装机目录是否完整
& $node $pnpm integration             # 端到端集成测试
```

## 说明

- 本目录是**自用维护版**（0.4.0）：派生自 [zhenbang1216/dsh-handoff](https://github.com/zhenbang1216/dsh-handoff)（上游 main 还是 0.3.0），加了客户端整页面板、`/api/dsh-handoff/*` 接口、版本/续写、工具活动清单、`/attach` 接续等；MIT 协议。
- `../vendor/dsh-handoff` 是旧安装方式的副本，**已不再被 profile 使用**（2026-11-09 改为 `link:` 到本目录），仅留作备份；内容与本目录一致（只差本 SYNC.md）。
- 与 `../dsh-bilibili` 不同：那个是纯 JS、改 `lib/*.js` 直接生效；这个必须走 `pnpm build`。
