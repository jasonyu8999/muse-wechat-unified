#!/usr/bin/env node
/**
 * Muse x WeChat unified bridge — iLink transport + file queue + outbox.
 *
 * Usage:
 *   node bridge.mjs login    # 生成登录二维码（需用户扫码；二维码约 5 分钟有效）
 *   node bridge.mjs run      # 启动守护进程：长轮询收消息 -> 队列 -> Hook 唤醒 worker -> 发回微信
 *   node bridge.mjs status   # 登录态、队列积压、进程状态
 *   node bridge.mjs logout   # 清除登录态与绑定
 *
 * 设计要点（详见 docs/ARCHITECTURE_DECISIONS.md）：
 * - 传输层复用 MIT 的 weixin-agent-sdk（transport/dist），桥接逻辑独立实现。
 * - 入站：先落盘再由 Hook 认领；出站：outbox + 发送账本（intent -> sent），结果三分法。
 * - 仅 Owner 的消息进入队列；其他人只记 id/次数，不回消息、不下载媒体。
 * - 日志不记 token、不记消息正文；对话记在 data/chatlog.md（本地 0600）。
 */
import crypto from "node:crypto";
import { execFile } from "node:child_process";
import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const BRIDGE_DIR = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_DIR = path.resolve(BRIDGE_DIR, "..");
const TRANSPORT_DIST = path.resolve(PROJECT_DIR, "transport", "dist");

// 登录态放在项目内（0600/0700），不进 git、不进记忆、不进 hook 脚本。
process.env.OPENCLAW_STATE_DIR = path.join(BRIDGE_DIR, "state");

const { start, isLoggedIn, logout } = await import(
  path.join(TRANSPORT_DIST, "bot.js")
);
const {
  startWeixinLoginWithQr,
  waitForWeixinLogin,
  DEFAULT_ILINK_BOT_TYPE,
} = await import(path.join(TRANSPORT_DIST, "auth", "login-qr.js"));
const {
  saveWeixinAccount,
  registerWeixinAccountId,
  normalizeAccountId,
  loadWeixinAccount,
  listWeixinAccountIds,
  DEFAULT_BASE_URL,
} = await import(path.join(TRANSPORT_DIST, "auth", "accounts.js"));

// ---------------------------------------------------------------------------
// Paths & config
// ---------------------------------------------------------------------------
const DIRS = {
  queuePending: path.join(BRIDGE_DIR, "queue", "pending"),
  queueProcessing: path.join(BRIDGE_DIR, "queue", "processing"),
  queueDone: path.join(BRIDGE_DIR, "queue", "done"),
  queueFailed: path.join(BRIDGE_DIR, "queue", "failed"),
  queueQuarantine: path.join(BRIDGE_DIR, "queue", "quarantine"),
  outbox: path.join(BRIDGE_DIR, "outbox"),
  outboxSent: path.join(BRIDGE_DIR, "outbox", "sent"),
  outboxFailed: path.join(BRIDGE_DIR, "outbox", "failed"),
  mediaInbound: path.join(BRIDGE_DIR, "media", "inbound"),
  mediaOutbound: path.join(BRIDGE_DIR, "media", "outbound"),
  state: path.join(BRIDGE_DIR, "state"),
  logs: path.join(BRIDGE_DIR, "logs"),
  data: path.join(BRIDGE_DIR, "data"),
};
const CONFIG_PATH = path.join(BRIDGE_DIR, "config.json");
const PID_PATH = path.join(BRIDGE_DIR, "bridge.pid");
const LOG_PATH = path.join(DIRS.logs, "bridge.log");
const CHATLOG_PATH = path.join(DIRS.data, "chatlog.md");
const SEEN_PATH = path.join(DIRS.data, "seen.json");
const LEDGER_PATH = path.join(DIRS.data, "send-ledger.json");
const UNKNOWN_PATH = path.join(DIRS.data, "unknown-senders.json");
const HEARTBEAT_PATH = path.join(DIRS.data, "heartbeat");

const DEFAULT_CONFIG = {
  ackText: "收到，正在处理…",
  outboxIntervalMs: 5000,
  processingTimeoutMs: 600000, // 10 分钟租约
  maxSendAttempts: 3,
  ownerId: null, // 绑定时写入：首个扫码人
  bindWindowMs: 600000,
};

function loadConfig() {
  try {
    return { ...DEFAULT_CONFIG, ...JSON.parse(fs.readFileSync(CONFIG_PATH, "utf-8")) };
  } catch {
    return { ...DEFAULT_CONFIG };
  }
}
function saveConfig(cfg) {
  writeFileAtomic(CONFIG_PATH, JSON.stringify(cfg, null, 2) + "\n", 0o600);
}
function ensureDirs() {
  for (const d of Object.values(DIRS)) fs.mkdirSync(d, { recursive: true, mode: 0o700 });
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
function log(level, msg, extra = {}) {
  const line = JSON.stringify({
    ts: new Date().toISOString(),
    level,
    msg,
    ...extra,
  });
  try {
    fs.appendFileSync(LOG_PATH, line + "\n");
  } catch {}
  if (level === "error" || level === "warn") console.error(line);
  else console.log(line);
}

function writeFileAtomic(filePath, content, mode = 0o600) {
  const tmp = `${filePath}.tmp-${process.pid}-${crypto.randomBytes(4).toString("hex")}`;
  fs.writeFileSync(tmp, content, { mode });
  fs.renameSync(tmp, filePath);
}

function readJson(filePath, fallback) {
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf-8"));
  } catch {
    return fallback;
  }
}

function taskId() {
  return `wx-${Date.now().toString(36)}-${crypto.randomBytes(3).toString("hex")}`;
}

function hashTask(conversationId, text, mediaKind) {
  return crypto
    .createHash("sha256")
    .update(`${conversationId}|${text}|${mediaKind || ""}`)
    .digest("hex")
    .slice(0, 32);
}

function loadSeen() {
  const seen = readJson(SEEN_PATH, []);
  const now = Date.now();
  // 去重窗口 5 分钟：长轮询的重投发生在数秒内，5 分钟绰绰有余；
  // 之前是 1 小时，用户一小时内重发相同问候会被误判为重投而丢弃（2026-11-12 实测）。
  return Array.isArray(seen) ? seen.filter((e) => now - e.at < 300_000) : [];
}
function markSeen(hash) {
  const seen = loadSeen();
  seen.push({ hash, at: Date.now() });
  while (seen.length > 500) seen.shift();
  writeFileAtomic(SEEN_PATH, JSON.stringify(seen), 0o600);
}

function appendChatlog(role, text) {
  const ts = new Date().toISOString().replace("T", " ").slice(0, 19);
  const safe = String(text ?? "").replace(/\n/g, " ");
  try {
    fs.appendFileSync(CHATLOG_PATH, `[${ts}] ${role}：${safe}\n`, { mode: 0o600 });
  } catch {}
}

function loadLedger() {
  return readJson(LEDGER_PATH, {});
}
function saveLedgerEntry(taskId, entry) {
  const ledger = loadLedger();
  ledger[taskId] = { ...entry, at: new Date().toISOString() };
  writeFileAtomic(LEDGER_PATH, JSON.stringify(ledger, null, 2), 0o600);
}

function loadOwnerId() {
  const cfg = loadConfig();
  if (cfg.ownerId) return cfg.ownerId;
  const ids = listWeixinAccountIds();
  if (ids.length === 0) return null;
  const acct = loadWeixinAccount(ids[0]);
  return acct?.userId || null;
}

// ---------------------------------------------------------------------------
// 语音转录：调用项目 venv 里的 media/transcribe.py（faster-whisper tiny）。
// 返回 { text, language, duration }；超时 120 秒；失败抛错由调用方接住。
// ---------------------------------------------------------------------------
const TRANSCRIBE_PY = path.join(PROJECT_DIR, "media", "transcribe.py");
const TRANSCRIBE_VENV_PY = path.join(PROJECT_DIR, ".venv", "bin", "python");
function runTranscribe(audioPath) {
  return new Promise((resolve, reject) => {
    execFile(
      TRANSCRIBE_VENV_PY,
      [TRANSCRIBE_PY, audioPath, "--model", "tiny", "--language", "zh"],
      { timeout: 120_000, maxBuffer: 1024 * 1024 },
      (err, stdout, stderr) => {
        if (err) return reject(new Error(stderr.trim().slice(-300) || String(err)));
        try {
          resolve(JSON.parse(stdout));
        } catch {
          reject(new Error(`bad transcribe output: ${stdout.slice(0, 200)}`));
        }
      },
    );
  });
}

// 引用回复：只保留回传原消息所需的最小字段，丢弃媒体密文等敏感内容。
function sanitizeQuote(item) {
  if (!item || typeof item !== "object") return null;
  const q = {};
  if (typeof item.type === "number") q.type = item.type;
  if (typeof item.msg_id === "string") q.msg_id = item.msg_id;
  if (typeof item.create_time_ms === "number") q.create_time_ms = item.create_time_ms;
  if (item.text_item?.text != null) q.text_item = { text: String(item.text_item.text) };
  if (item.voice_item?.text) q.voice_item = { text: String(item.voice_item.text) };
  return Object.keys(q).length ? q : null;
}

// 被引原消息的纯文本（用于文字引用兜底）。
function quoteTextOf(quote) {
  if (!quote || typeof quote !== "object") return "";
  return String(quote.text_item?.text ?? quote.voice_item?.text ?? "").trim();
}

// ---------------------------------------------------------------------------
// Agent: inbound message -> task queue (called by the SDK monitor)
// ---------------------------------------------------------------------------
function makeAgent(cfg) {
  return {
    async chat(request) {
      const ownerId = loadOwnerId();
      const from = request.conversationId || "";
      if (!ownerId || from !== ownerId) {
        // 非 Owner：不入队、不回消息、不下载媒体；只记 id/次数。
        const unknown = readJson(UNKNOWN_PATH, {});
        const rec = unknown[from] || { count: 0, firstSeen: new Date().toISOString() };
        rec.count += 1;
        rec.lastSeen = new Date().toISOString();
        unknown[from] = rec;
        writeFileAtomic(UNKNOWN_PATH, JSON.stringify(unknown, null, 2), 0o600);
        log("warn", "non-owner message ignored", { from: from.slice(0, 8) + "…" });
        return {};
      }

      const mediaKind = request.media?.type || "";
      const h = hashTask(from, request.text || "", mediaKind);
      if (loadSeen().some((e) => e.hash === h)) {
        log("info", "duplicate message ignored", { hash: h });
        return {};
      }

      const id = taskId();
      let media = null;
      if (request.media?.filePath) {
        try {
          const src = request.media.filePath;
          const ext = path.extname(request.media.fileName || src) || "";
          const dir = path.join(DIRS.mediaInbound, id);
          fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
          const dest = path.join(dir, `inbound${ext}`);
          await fsp.copyFile(src, dest);
          media = {
            type: request.media.type,
            filePath: dest,
            mimeType: request.media.mimeType,
            fileName: request.media.fileName,
          };
        } catch (err) {
          log("error", "inbound media copy failed", { id, err: String(err) });
          media = { type: request.media.type, error: "MEDIA_COPY_FAILED" };
        }
      }

      // 语音转文字：SDK 已把微信服务端转写放进 request.text（有就直接用）；
      // 否则用本地 faster-whisper 转录（media/transcribe.py，tiny 模型，超时 120 秒）。
      // 转录失败也不拦任务：任务照常入队，worker 看到 transcriptError 后按原音频处理。
      let transcript = null;
      let transcriptSource = null;
      let transcriptError = null;
      if (mediaKind === "audio" && media?.filePath) {
        if ((request.text || "").trim()) {
          transcript = request.text.trim();
          transcriptSource = "wechat-server";
        } else {
          try {
            const out = await runTranscribe(media.filePath);
            if (out.text) {
              transcript = out.text;
              transcriptSource = "local-whisper-tiny";
            } else {
              transcriptError = "EMPTY_TRANSCRIPT";
            }
          } catch (err) {
            transcriptError = String(err).slice(0, 200);
            log("warn", "voice transcription failed", { id, err: transcriptError });
          }
        }
      }

      const task = {
        id,
        conversationId: from,
        text: transcript ? `[语音] ${transcript}` : request.text || "",
        media: media
          ? { ...media, transcript, transcriptSource, transcriptError }
          : null,
        // 引用回复用：只保留可安全回传的字段（原消息的 msg_id 等），不含媒体密文。
        quote: sanitizeQuote(request.quote),
        receivedAt: new Date().toISOString(),
        source: "wechat",
        attempts: 0,
      };
      writeFileAtomic(path.join(DIRS.queuePending, `${id}.json`), JSON.stringify(task, null, 2), 0o600);
      markSeen(h);
      appendChatlog("用户", task.text || `[${mediaKind || "媒体"}消息]`);
      log("info", "task queued", { id, textLen: task.text.length, media: mediaKind || null });
      return { text: cfg.ackText, quote: sanitizeQuote(request.quote) };
    },
  };
}

// ---------------------------------------------------------------------------
// Outbox sender + stale-claim requeue (runs inside the daemon)
// ---------------------------------------------------------------------------
async function processOutbox(bot, cfg) {
  let files = [];
  try {
    files = fs
      .readdirSync(DIRS.outbox)
      .filter((f) => f.endsWith(".json"))
      .map((f) => ({ name: f, mtime: fs.statSync(path.join(DIRS.outbox, f)).mtimeMs }))
      .sort((a, b) => a.mtime - b.mtime);
  } catch {
    return;
  }
  for (const { name } of files) {
    const filePath = path.join(DIRS.outbox, name);
    const item = readJson(filePath, null);
    if (!item || !item.taskId) {
      try {
        fs.renameSync(filePath, path.join(DIRS.outboxFailed, name));
      } catch {}
      continue;
    }
    // 幂等：账本已记 sent 的不再重发。
    const ledger = loadLedger();
    if (ledger[item.taskId]?.status === "sent") {
      try {
        fs.renameSync(filePath, path.join(DIRS.outboxSent, name));
      } catch {}
      continue;
    }
    if ((item.attempts || 0) >= cfg.maxSendAttempts) {
      saveLedgerEntry(item.taskId, { status: "failed", error: "MAX_ATTEMPTS" });
      try {
        fs.renameSync(filePath, path.join(DIRS.outboxFailed, name));
      } catch {}
      log("warn", "outbox item failed after max attempts", { taskId: item.taskId });
      continue;
    }
    try {
      const response = {};
      if (item.text) response.text = item.text;
      if (item.quote) response.quote = item.quote;
      // 文字引用兜底（2026-11-12 真机验证：服务端接受 ref_msg 但微信客户端
      // 不渲染机器人消息的引用气泡，见 docs/KNOWN_LIMITATIONS.md）。
      // ref_msg 照常发（无害，服务端接受）；同时在正文前加一行“回「…」：”，
      // 让用户在微信里能看到这条回复是在回哪句。进度消息无 quote，不受影响。
      const qt = quoteTextOf(item.quote);
      if (qt && response.text && !response.text.includes(qt.slice(0, 20))) {
        const short = qt.length > 40 ? qt.slice(0, 40) + "…" : qt;
        response.text = `回「${short}」：${response.text}`;
      }
      if (item.mediaPath) {
        response.media = {
          type: item.mediaType || "image",
          url: item.mediaPath,
          fileName: item.mediaFileName,
        };
      }
      if (!response.text && !response.media) throw new Error("empty outbox item");
      try {
        await bot.sendMessage(response);
      } catch (err) {
        if (!response.quote) throw err;
        // 引用发送被服务端拒绝时降级为普通回复，保证回复不丢失。
        log("warn", "quoted send failed, retrying without quote", {
          taskId: item.taskId,
          err: String(err).slice(0, 200),
        });
        const plain = { ...response };
        delete plain.quote;
        await bot.sendMessage(plain);
      }
      saveLedgerEntry(item.taskId, { status: "sent" });
      try {
        fs.renameSync(filePath, path.join(DIRS.outboxSent, name));
      } catch {}
      appendChatlog("我", item.text || `[${response.media?.type || "媒体"}]`);
      log("info", "outbox sent", { taskId: item.taskId, media: Boolean(response.media) });
    } catch (err) {
      item.attempts = (item.attempts || 0) + 1;
      item.lastError = String(err).slice(0, 300);
      writeFileAtomic(filePath, JSON.stringify(item, null, 2), 0o600);
      saveLedgerEntry(item.taskId, { status: "unknown", error: item.lastError });
      log("warn", "outbox send failed (will retry)", {
        taskId: item.taskId,
        attempts: item.attempts,
        err: item.lastError,
      });
    }
  }
}

function requeueStaleProcessing(cfg) {
  let files = [];
  try {
    files = fs.readdirSync(DIRS.queueProcessing).filter((f) => f.endsWith(".json"));
  } catch {
    return;
  }
  const now = Date.now();
  for (const name of files) {
    const filePath = path.join(DIRS.queueProcessing, name);
    try {
      // ctime = 认领时间（mv 更新 ctime，不更新 mtime），防 mtime 乒乓。
      const { ctimeMs } = fs.statSync(filePath);
      if (now - ctimeMs > cfg.processingTimeoutMs) {
        fs.renameSync(filePath, path.join(DIRS.queuePending, name));
        log("warn", "stale processing task requeued", { file: name });
      }
    } catch {}
  }
}

// ---------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------
async function cmdLogin() {
  ensureDirs();
  const apiBaseUrl = DEFAULT_BASE_URL;
  log("info", "starting QR login");
  const started = await startWeixinLoginWithQr({
    apiBaseUrl,
    botType: DEFAULT_ILINK_BOT_TYPE,
  });
  if (!started.qrcodeUrl) {
    console.error(`获取二维码失败：${started.message}`);
    process.exit(1);
  }

  // 保存二维码图片（供聊天中出示）与会话信息。
  // 注意：qrcodeUrl 是 liteapp 页面地址（JS 渲染），直接 fetch 得到的是 HTML，
  // 不是二维码图片。正确做法是把 URL 本地编码成二维码图片（与 SDK 的
  // qrcode-terminal 做法一致），绝不把登录 URL 发给第三方制码服务。
  const qrPngPath = path.join(DIRS.state, "qr.png");
  const qrJsonPath = path.join(DIRS.state, "qr.json");
  try {
    if (started.qrcodeUrl.startsWith("data:")) {
      const b64 = started.qrcodeUrl.split(",")[1] || "";
      fs.writeFileSync(qrPngPath, Buffer.from(b64, "base64"), { mode: 0o600 });
    } else {
      const { execFileSync } = await import("node:child_process");
      const venvPython = path.join(PROJECT_DIR, ".venv", "bin", "python");
      execFileSync(
        venvPython,
        [
          "-c",
          `import qrcode; qrcode.make(${JSON.stringify(started.qrcodeUrl)}, box_size=10, border=2).save(${JSON.stringify(qrPngPath)})`,
        ],
        { timeout: 30000 },
      );
      fs.chmodSync(qrPngPath, 0o600);
    }
  } catch (err) {
    console.error(`二维码图片生成失败（可用链接扫码）：${String(err)}`);
  }
  writeFileAtomic(
    qrJsonPath,
    JSON.stringify(
      { qrcodeUrl: started.qrcodeUrl, sessionKey: started.sessionKey, createdAt: new Date().toISOString() },
      null,
      2,
    ),
    0o600,
  );
  console.log(`QR_IMAGE:${qrPngPath}`);
  console.log(`QR_URL:${started.qrcodeUrl}`);
  console.log("请用微信扫描二维码完成绑定（约 5 分钟有效，过期请重新运行 login）。");

  const waited = await waitForWeixinLogin({
    sessionKey: started.sessionKey,
    apiBaseUrl,
    timeoutMs: 480_000,
    botType: DEFAULT_ILINK_BOT_TYPE,
  });
  if (!waited.connected || !waited.botToken || !waited.accountId) {
    console.error(`登录失败：${waited.message}`);
    process.exit(1);
  }
  const normalizedId = normalizeAccountId(waited.accountId);
  saveWeixinAccount(normalizedId, {
    token: waited.botToken,
    baseUrl: waited.baseUrl,
    userId: waited.userId,
  });
  registerWeixinAccountId(normalizedId);

  // 绑定：首个扫码人即 Owner。
  const cfg = loadConfig();
  cfg.ownerId = waited.userId || cfg.ownerId;
  saveConfig(cfg);
  try {
    fs.rmSync(qrPngPath, { force: true });
    fs.rmSync(qrJsonPath, { force: true });
  } catch {}
  console.log("LOGIN_OK");
  console.log(`accountId=${normalizedId}`);
  console.log(`ownerId=${cfg.ownerId || "(unknown)"}`);
  log("info", "login ok", { accountId: normalizedId });
}

async function cmdRun() {
  ensureDirs();
  if (!isLoggedIn()) {
    console.error("未登录：请先运行 `node bridge.mjs login` 扫码绑定。");
    process.exit(1);
  }
  // 单实例。
  try {
    const pid = Number(fs.readFileSync(PID_PATH, "utf-8").trim());
    if (pid && process.kill(pid, 0)) {
      console.error(`桥接已在运行（pid ${pid}），拒绝重复启动。`);
      process.exit(1);
    }
  } catch {}
  fs.writeFileSync(PID_PATH, String(process.pid));

  const cfg = loadConfig();
  const ownerId = loadOwnerId();
  if (!ownerId) {
    console.error("未找到绑定的 Owner，请重新运行 login。");
    process.exit(1);
  }
  if (!cfg.ownerId) {
    cfg.ownerId = ownerId;
    saveConfig(cfg);
  }

  const abort = new AbortController();
  const agent = makeAgent(cfg);
  const bot = start(agent, { abortSignal: abort.signal, log: (m) => log("info", m) });
  log("info", "bridge started", { pid: process.pid, owner: ownerId.slice(0, 8) + "…" });

  // 防重入：processOutbox 是异步的，一轮没跑完时下一拍不得重入，否则同一
  // 文件会被两轮并发发出（2026-11-12 实测：进度消息各发了两遍，相隔仅约 100ms）。
  let outboxRunning = false;
  const timer = setInterval(() => {
    fs.writeFileSync(HEARTBEAT_PATH, String(Date.now()));
    requeueStaleProcessing(cfg);
    if (outboxRunning) return;
    outboxRunning = true;
    processOutbox(bot, cfg)
      .catch((err) => log("error", "outbox loop error", { err: String(err) }))
      .finally(() => {
        outboxRunning = false;
      });
  }, cfg.outboxIntervalMs);
  timer.unref?.();

  const shutdown = () => {
    clearInterval(timer);
    abort.abort();
    try {
      fs.rmSync(PID_PATH, { force: true });
    } catch {}
    log("info", "bridge stopped");
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);

  await bot.wait();
  shutdown();
}

function cmdStatus() {
  ensureDirs();
  const cfg = loadConfig();
  const ids = listWeixinAccountIds();
  const count = (dir) => {
    try {
      return fs.readdirSync(dir).filter((f) => f.endsWith(".json")).length;
    } catch {
      return 0;
    }
  };
  let pidAlive = false;
  try {
    const pid = Number(fs.readFileSync(PID_PATH, "utf-8").trim());
    pidAlive = Boolean(pid) && process.kill(pid, 0);
  } catch {}
  let heartbeat = null;
  try {
    heartbeat = Number(fs.readFileSync(HEARTBEAT_PATH, "utf-8").trim()) || null;
  } catch {}
  console.log(
    JSON.stringify(
      {
        loggedIn: isLoggedIn(),
        accounts: ids,
        ownerId: cfg.ownerId || loadOwnerId() || null,
        running: pidAlive,
        heartbeatAgeSec: heartbeat ? Math.round((Date.now() - heartbeat) / 1000) : null,
        pending: count(DIRS.queuePending),
        processing: count(DIRS.queueProcessing),
        outbox: count(DIRS.outbox),
        outboxFailed: count(DIRS.outboxFailed),
      },
      null,
      2,
    ),
  );
}

function cmdLogout() {
  logout({ log: (m) => console.log(m) });
  const cfg = loadConfig();
  cfg.ownerId = null;
  saveConfig(cfg);
  console.log("已退出登录并清除绑定。");
}

// ---------------------------------------------------------------------------
const [cmd] = process.argv.slice(2);
if (cmd === "login") await cmdLogin();
else if (cmd === "run") await cmdRun();
else if (cmd === "status") cmdStatus();
else if (cmd === "logout") cmdLogout();
else {
  console.log("用法: node bridge.mjs <login|run|status|logout>");
  process.exit(1);
}
