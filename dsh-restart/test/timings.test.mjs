import { test } from "node:test";
import assert from "node:assert/strict";
import { resolveTimings, describeTimings, DEFAULT_KILL_SECONDS, MAX_KILL_SECONDS, MIN_KILL_SECONDS } from "../lib/timings.js";

test("默认值：45 秒后杀，11 秒后拉", () => {
  assert.deepEqual(resolveTimings(), { killSeconds: 45, startSeconds: 56 });
});

test("显式延迟原样保留（取整）", () => {
  assert.deepEqual(resolveTimings(120), { killSeconds: 120, startSeconds: 131 });
  assert.deepEqual(resolveTimings(30.6), { killSeconds: 31, startSeconds: 42 });
});

test("越界被夹紧", () => {
  assert.equal(resolveTimings(5).killSeconds, MIN_KILL_SECONDS);
  assert.equal(resolveTimings(9999).killSeconds, MAX_KILL_SECONDS);
});

test("非法输入回退默认值", () => {
  assert.equal(resolveTimings(undefined).killSeconds, DEFAULT_KILL_SECONDS);
  assert.equal(resolveTimings(NaN).killSeconds, DEFAULT_KILL_SECONDS);
  assert.equal(resolveTimings("abc").killSeconds, DEFAULT_KILL_SECONDS);
  assert.equal(resolveTimings(-5).killSeconds, DEFAULT_KILL_SECONDS);
});

test("自定义默认值与间隔", () => {
  assert.deepEqual(resolveTimings(undefined, { defaultKillSeconds: 90 }), { killSeconds: 90, startSeconds: 101 });
  assert.deepEqual(resolveTimings(60, { startGapSeconds: 20 }), { killSeconds: 60, startSeconds: 80 });
});

test("start 永远晚于 kill 至少 1 秒", () => {
  const t = resolveTimings(45, { startGapSeconds: 0 });
  assert.ok(t.startSeconds > t.killSeconds);
});

test("describeTimings 输出稳定", () => {
  assert.equal(describeTimings({ killSeconds: 45, startSeconds: 56 }), "kill at +45s, start at +56s");
});
