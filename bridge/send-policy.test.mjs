// bridge/send-policy.test.mjs — unit tests for bridge/send-policy.mjs.
// Run: node --test bridge/send-policy.test.mjs
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  checkOutboundPath,
  classifySendError,
  contentHash,
  dedupKeyForRequest,
  retryBackoffMs,
  seenTtlMs,
  stableClientId,
} from "./send-policy.mjs";

test("stableClientId is deterministic per (task, part) and distinct across parts/tasks", () => {
  const a = stableClientId("wx-abc-123", "text");
  assert.equal(a, stableClientId("wx-abc-123", "text"));
  assert.notEqual(a, stableClientId("wx-abc-123", "media"));
  assert.notEqual(a, stableClientId("wx-def-456", "text"));
  assert.ok(a.startsWith("openclaw-weixin:"));
});

test("contentHash is deterministic and sensitive to text", () => {
  const h1 = contentHash("u1", "你好", "");
  assert.equal(h1, contentHash("u1", "你好", ""));
  assert.notEqual(h1, contentHash("u1", "你好吗", ""));
  assert.notEqual(h1, contentHash("u2", "你好", ""));
});

test("dedupKeyForRequest prefers msg_id, falls back to content hash", () => {
  const withMsg = dedupKeyForRequest({
    conversationId: "u1",
    text: "你好",
    quote: { msg_id: "srv-001" },
  });
  assert.equal(withMsg.kind, "msg");
  assert.equal(withMsg.key, "m:srv-001");
  const noMsg = dedupKeyForRequest({ conversationId: "u1", text: "你好" });
  assert.equal(noMsg.kind, "hash");
  assert.equal(noMsg.key, `h:${contentHash("u1", "你好", "")}`);
  const empty = dedupKeyForRequest({});
  assert.equal(empty.kind, "hash");
});

test("seenTtlMs: msg keys live an hour, hash fallback only 30s", () => {
  assert.equal(seenTtlMs("msg"), 3600_000);
  assert.equal(seenTtlMs("hash"), 30_000);
});

test("classifySendError: network/unknown are retryable (server dedupes on stable client_id)", () => {
  assert.deepEqual(classifySendError(new Error("没有找到 context_token，需要在 start() 运行期间至少收到过一条消息")), {
    errorClass: "local",
    retryable: true,
    reason: "no-context-token",
  });
  assert.deepEqual(classifySendError(new Error("media upload failed: fetch failed")), {
    errorClass: "local",
    retryable: true,
    reason: "media-upload-failed",
  });
  const server = classifySendError(new Error("sendMessage 业务拒绝 errcode=-2 errmsg=prepare failed"));
  assert.equal(server.errorClass, "server");
  assert.equal(server.retryable, false);
  assert.equal(server.errcode, -2);
  // 2026-11-12 真机验证：同一 client_id 发两遍，服务端两次都给成功回执，
  // 手机上只收到一条。所以没收到回执的失败也可以用同一 client_id 重发，
  // 服务端去重，不会重复投递。
  const network = classifySendError(new Error("fetch failed"));
  assert.equal(network.errorClass, "network");
  assert.equal(network.retryable, true);
  const abort = classifySendError(Object.assign(new Error("aborted"), { name: "AbortError" }));
  assert.equal(abort.errorClass, "network");
  assert.equal(abort.retryable, true);
  const unknown = classifySendError(new Error("something entirely new"));
  assert.equal(unknown.errorClass, "unknown");
  assert.equal(unknown.retryable, true);
});

test("retryBackoffMs: 10s, 30s, then 60s", () => {
  assert.equal(retryBackoffMs(1), 10_000);
  assert.equal(retryBackoffMs(2), 30_000);
  assert.equal(retryBackoffMs(3), 60_000);
  assert.equal(retryBackoffMs(9), 60_000);
});

test("checkOutboundPath: only files inside the outbound root, symlinks resolved", () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "allowlist-"));
  try {
    const root = path.join(tmp, "outbound");
    const outside = path.join(tmp, "outside");
    fs.mkdirSync(root, { recursive: true });
    fs.mkdirSync(outside, { recursive: true });
    const okFile = path.join(root, "task1", "a.png");
    fs.mkdirSync(path.dirname(okFile), { recursive: true });
    fs.writeFileSync(okFile, "x");
    const outsideFile = path.join(outside, "secret.txt");
    fs.writeFileSync(outsideFile, "s3cr3t");
    const escapeLink = path.join(root, "escape.png");
    fs.symlinkSync(outsideFile, escapeLink);

    assert.equal(checkOutboundPath(okFile, root).allowed, true);
    assert.equal(checkOutboundPath(okFile, root).resolved, fs.realpathSync(okFile));
    assert.deepEqual(checkOutboundPath(outsideFile, root), {
      allowed: false,
      reason: "outside-allowed-root",
      resolved: fs.realpathSync(outsideFile),
    });
    assert.equal(checkOutboundPath(escapeLink, root).allowed, false);
    assert.equal(checkOutboundPath(escapeLink, root).reason, "outside-allowed-root");
    assert.deepEqual(checkOutboundPath(path.join(root, "nope.png"), root), {
      allowed: false,
      reason: "not-found",
    });
    assert.deepEqual(checkOutboundPath("", root), { allowed: false, reason: "empty-path" });
    assert.deepEqual(checkOutboundPath(root, root), {
      allowed: false,
      reason: "outside-allowed-root",
      resolved: fs.realpathSync(root),
    });
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});
