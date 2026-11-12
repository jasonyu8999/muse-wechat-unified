// bridge/send-policy.mjs — pure policy helpers for the outbox sender.
//
// No side effects except an optional realpath check for the allowlist.
// Covered by bridge/send-policy.test.mjs (`node --test bridge/send-policy.test.mjs`).
//
// Why this file exists (v0.2 batch 1, 2026-11-12):
// - A failed send used to be recorded as `unknown` and retried with a fresh
//   client_id, so a lost response could deliver the same message twice.
// - Dedup used a content hash (conversationId + text + mediaKind), so two
//   identical greetings within the window were swallowed as one.
// - processOutbox() accepted any absolute mediaPath from a task JSON, so a
//   compromised worker could exfiltrate an arbitrary local file to WeChat.
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

/**
 * Deterministic idempotency key for one logical (task, part) send.
 * The same taskId + part always yields the same client_id, so a retry of
 * the same logical message is deduplicated server-side instead of
 * delivering a second copy. The hash keeps the key opaque and fixed-length.
 */
export function stableClientId(taskId, part) {
  const h = crypto
    .createHash("sha256")
    .update(`outbox:${taskId}:${part}`)
    .digest("hex")
    .slice(0, 16);
  return `openclaw-weixin:${h}`;
}

/** Content hash used only as a fallback dedup signal (see dedupKeyForRequest). */
export function contentHash(conversationId, text, mediaKind) {
  return crypto
    .createHash("sha256")
    .update(`${conversationId}|${text}|${mediaKind || ""}`)
    .digest("hex")
    .slice(0, 32);
}

/**
 * Dedup key for an inbound ChatRequest.
 * Primary: the server-assigned msg_id of the item that produced the text
 * (request.quote is that item — see the SDK's findQuotableItem). A msg_id
 * never recurs for a different message, so it is a true identity key.
 * Fallback: content hash, only when no msg_id is present. It is an
 * auxiliary signal, never a substitute for identity.
 */
export function dedupKeyForRequest(request) {
  const msgId = request?.quote?.msg_id;
  if (typeof msgId === "string" && msgId) {
    return { key: `m:${msgId}`, kind: "msg" };
  }
  const conversationId = request?.conversationId || "";
  const text = request?.text || "";
  const mediaKind = request?.media?.type || "";
  return { key: `h:${contentHash(conversationId, text, mediaKind)}`, kind: "hash" };
}

/**
 * How long a seen key stays in the dedup store.
 * Server redelivery of the same message happens within seconds, so the
 * content-hash fallback only needs a 30s window — long enough to catch a
 * long-poll replay, short enough that a genuine repeated greeting ("你好"
 * twice in a minute) is never swallowed. msg_id keys are unique per
 * message and can never recur legitimately, so they may live an hour.
 */
export function seenTtlMs(kind) {
  return kind === "msg" ? 3600_000 : 30_000;
}

/**
 * Classify a send failure by what it proves about delivery.
 * - local: the failure happened before any message bytes were sent
 *   (missing context_token, media upload failed, empty item). The message
 *   definitely did NOT go out, so retrying with the same client_id is safe.
 * - server: the server explicitly rejected the request (errcode in the
 *   response). Definitely not delivered; retrying the same request is
 *   pointless until the cause is fixed.
 * - network / unknown: no response was received, so delivery is UNKNOWN.
 *   Must never auto-retry — a retry may deliver a second copy.
 */
export function classifySendError(err) {
  // Match against name + message: undici AbortError carries the signal in
  // err.name ("AbortError") while the message is just "This operation was aborted".
  const msg = String(err?.message ?? err ?? "");
  const hay = `${err?.name || ""} ${msg}`;
  if (/context_token|contextToken is required|没有找到 context_token/.test(hay)) {
    return { errorClass: "local", retryable: true, reason: "no-context-token" };
  }
  if (/media upload failed/.test(hay)) {
    return { errorClass: "local", retryable: true, reason: "media-upload-failed" };
  }
  if (/empty outbox item|消息必须包含 text 或 media/.test(hay)) {
    return { errorClass: "local", retryable: true, reason: "empty-item" };
  }
  const m = hay.match(/errcode[=:\s]+(-?\d+)/);
  if (/业务拒绝/.test(hay) || m) {
    return {
      errorClass: "server",
      retryable: false,
      errcode: m ? Number(m[1]) : undefined,
      reason: "server-rejected",
    };
  }
  if (/fetch failed|ECONNREFUSED|ETIMEDOUT|EAI_AGAIN|AbortError|network|timed? ?out/i.test(hay)) {
    return { errorClass: "network", retryable: false, reason: "response-unknown" };
  }
  return { errorClass: "unknown", retryable: false, reason: "unclassified" };
}

/**
 * Allowlist for outbound media paths. Only files inside the outbound
 * media root may be sent to WeChat. Symlinks are resolved first, so a
 * symlink inside the root pointing outside is still rejected. A missing
 * file is rejected too (fail fast with a clear reason instead of passing
 * a dangling path to the uploader).
 */
export function checkOutboundPath(mediaPath, allowedRoot) {
  if (typeof mediaPath !== "string" || !mediaPath) {
    return { allowed: false, reason: "empty-path" };
  }
  let resolved;
  try {
    resolved = fs.realpathSync(mediaPath);
  } catch {
    return { allowed: false, reason: "not-found" };
  }
  let root;
  try {
    root = fs.realpathSync(allowedRoot);
  } catch {
    root = path.resolve(allowedRoot);
  }
  const rel = path.relative(root, resolved);
  if (rel === "" || rel.startsWith("..") || path.isAbsolute(rel)) {
    return { allowed: false, reason: "outside-allowed-root", resolved };
  }
  return { allowed: true, resolved };
}
