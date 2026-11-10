#!/usr/bin/env node
/**
 * 把插件源码同步到 profile 的 node_modules 副本。
 *
 * 为什么需要这一步：desktop profile 用的是 pnpm `nodeLinker: hoisted`，
 * `file:` 依赖会被**复制**进 node_modules，不是软链 —— 改完源码不重启不生效，
 * 只重启也不同步；必须先跑本脚本再重启。
 *
 * 用法：
 *   node scripts/sync-to-profile.mjs                 # 默认 desktop profile
 *   node scripts/sync-to-profile.mjs --profile web
 *   node scripts/sync-to-profile.mjs --dry
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const argv = process.argv.slice(2);
const arg = (k, d) => {
  const i = argv.indexOf(`--${k}`);
  return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith("--") ? argv[i + 1] : d;
};
const profile = arg("profile", "desktop");
const dry = argv.includes("--dry");
const home = process.env.DSH_HOME || path.join(os.homedir(), ".dsh");
const dst = path.join(home, "profiles", profile, "node_modules", "im-session-archive");

if (!fs.existsSync(dst)) {
  console.error(`找不到目标副本：${dst}\n先确认 profile 里装过 im-session-archive（pnpm add file:...）。`);
  process.exit(1);
}

// 运行时需要的全部文件（不含依赖、不含备份）
const FILES = ["package.json", "cordis.patch.yml", "lib/index.js"];
const want = [...FILES];
for (const f of want) {
  if (!fs.existsSync(path.join(here, f))) {
    console.error(`源码缺文件：${f}`);
    process.exit(1);
  }
}

console.log(`src = ${here}`);
console.log(`dst = ${dst}`);

for (const f of want) {
  const from = path.join(here, f);
  const to = path.join(dst, f);
  const size = fs.statSync(from).size;
  if (dry) {
    console.log(`would copy ${f} (${size} bytes)`);
    continue;
  }
  fs.mkdirSync(path.dirname(to), { recursive: true });
  fs.copyFileSync(from, to);
  console.log(`copied ${f} (${size} bytes)`);
}

if (!dry) {
  console.log("done — 现在需要重启 DSH，新代码才会被加载。");
}
