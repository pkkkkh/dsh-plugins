# patches/ —— 我们对上游的改动（补丁集）

> 本目录让「升级上游」变成**一条命令**，不用再手工搬代码。

## 补丁清单

| 文件 | 内容 | 生效位置 |
|---|---|---|
| `0001-bili-digest.patch` | **纯新增**：`bili_digest` 工具（JS 注册 + Python 实现） | `index.js`、`vendor/bilibili-mcp/mcp_server.py` |

- 基线：上游版本 **1.0.1**（npm `dsh-bili-subagent@1.0.1`）
- 删除行：**0**（只加不改）
- 验证：`git apply --check -p1` 通过；应用后 `grep -c bili_digest` 应为 `index.js=2`、`mcp_server.py=1`

## 升级上游的流程（一条命令）

```bash
bash C:/Users/kh006/.dsh/im/scripts/sync-subagent-upstream.sh 1.0.2
```

脚本会：下载 npm 包 → 解包 → 覆盖插件目录（**保留** `UPSTREAM.md`、`tools/`、`patches/`）→ 应用本目录所有补丁 → 跑语法检查并打印 diff 状态。
**升级后必须重启 DSH**，然后验：`bili_scan` 派活、`bili_digest`、设置页能不能打开。

## 冲突怎么办

上游若改到了同样的位置，`git apply` 会失败（不会静默）。这时：

1. 看 `git apply --reject` 生成的 `.rej` 文件
2. 手工把 `bili_digest` 的 JS 注册段（照 `bili_comments` 之后的位置）和 Python 实现段（`# ========== Tool 3.5` 注释块）重新插入
3. 重新生成补丁：`git diff` 对比**纯上游解包目录**与本目录，替换 `0001-bili-digest.patch`
