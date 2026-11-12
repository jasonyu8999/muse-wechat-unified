import { sendMessage as sendMessageApi } from "../api/api.js";
import type { WeixinApiOptions } from "../api/api.js";
import { logger } from "../util/logger.js";
import { generateId } from "../util/random.js";
import type { MessageItem, SendMessageReq } from "../api/types.js";
import { MessageItemType, MessageState, MessageType } from "../api/types.js";
import type { UploadedFileInfo } from "../cdn/upload.js";

export function generateClientId(): string {
  return generateId("openclaw-weixin");
}

/**
 * Convert markdown-formatted model reply to plain text for Weixin delivery.
 * Preserves newlines; strips markdown syntax.
 */
export function markdownToPlainText(text: string): string {
  let result = text;
  // Code blocks: strip fences, keep code content
  result = result.replace(/```[^\n]*\n?([\s\S]*?)```/g, (_, code: string) => code.trim());
  // Images: remove entirely
  result = result.replace(/!\[[^\]]*\]\([^)]*\)/g, "");
  // Links: keep display text only
  result = result.replace(/\[([^\]]+)\]\([^)]*\)/g, "$1");
  // Tables: remove separator rows, then strip leading/trailing pipes and convert inner pipes to spaces
  result = result.replace(/^\|[\s:|-]+\|$/gm, "");
  result = result.replace(/^\|(.+)\|$/gm, (_, inner: string) =>
    inner.split("|").map((cell) => cell.trim()).join("  "),
  );
  // Strip inline markdown formatting
  result = result
    .replace(/\*\*(.+?)\*\*/g, "$1")
    .replace(/\*(.+?)\*/g, "$1")
    .replace(/__(.+?)__/g, "$1")
    .replace(/_(.+?)_/g, "$1")
    .replace(/~~(.+?)~~/g, "$1")
    .replace(/`(.+?)`/g, "$1");
  return result;
}


/** Build a SendMessageReq containing a single text message. */
function buildTextMessageReq(params: {
  to: string;
  text: string;
  contextToken?: string;
  clientId: string;
  quote?: MessageItem;
}): SendMessageReq {
  const { to, text, contextToken, clientId, quote } = params;
  const textItem: MessageItem = { type: MessageItemType.TEXT, text_item: { text } };
  if (quote) {
    // WeChat 引用回复：把原消息作为 ref_msg 挂在外发文本条目上。
    const quotedText =
      quote.text_item?.text ?? quote.voice_item?.text ?? "";
    textItem.ref_msg = {
      message_item: quote,
      title: quotedText ? String(quotedText).slice(0, 60) : undefined,
    };
  }
  const item_list: MessageItem[] = text ? [textItem] : [];
  return {
    msg: {
      from_user_id: "",
      to_user_id: to,
      client_id: clientId,
      message_type: MessageType.BOT,
      message_state: MessageState.FINISH,
      item_list: item_list.length ? item_list : undefined,
      context_token: contextToken ?? undefined,
    },
  };
}

/** Build a SendMessageReq from a text payload. */
function buildSendMessageReq(params: {
  to: string;
  contextToken?: string;
  text: string;
  clientId: string;
  quote?: MessageItem;
}): SendMessageReq {
  const { to, contextToken, text, clientId, quote } = params;
  return buildTextMessageReq({ to, text, contextToken, clientId, quote });
}

/**
 * Send a plain text message downstream.
 * contextToken is required for all reply sends; missing it breaks conversation association.
 * Pass clientId to reuse a stable idempotency key across retries of the same
 * logical message; otherwise a fresh one is generated (previous behaviour).
 */
export async function sendMessageWeixin(params: {
  to: string;
  text: string;
  opts: WeixinApiOptions & { contextToken?: string };
  quote?: MessageItem;
  clientId?: string;
}): Promise<{ messageId: string }> {
  const { to, text, opts, quote } = params;
  if (!opts.contextToken) {
    logger.error(`sendMessageWeixin: contextToken missing, refusing to send to=${to}`);
    throw new Error("sendMessageWeixin: contextToken is required");
  }
  const clientId = params.clientId ?? generateClientId();
  const req = buildSendMessageReq({
    to,
    contextToken: opts.contextToken,
    text,
    clientId,
    quote,
  });
  try {
    await sendMessageApi({
      baseUrl: opts.baseUrl,
      token: opts.token,
      timeoutMs: opts.timeoutMs,
      body: req,
    });
  } catch (err) {
    logger.error(`sendMessageWeixin: failed to=${to} clientId=${clientId} err=${String(err)}`);
    throw err;
  }
  return { messageId: clientId };
}

/**
 * Send one or more MessageItems (optionally preceded by a text caption) downstream.
 * Each item is sent as its own request so that item_list always has exactly one entry.
 * Pass clientIds to reuse stable idempotency keys per part across retries.
 * Returns the clientId used for every part. If a later part fails, the thrown
 * error carries a `parts` array with the parts that already went out, so the
 * caller can record per-part delivery status instead of retrying the whole
 * message (which would duplicate the parts that succeeded).
 */
async function sendMediaItems(params: {
  to: string;
  text: string;
  mediaItem: MessageItem;
  opts: WeixinApiOptions & { contextToken?: string };
  label: string;
  clientIds?: { text?: string; media?: string };
}): Promise<{ messageId: string; parts: Array<{ kind: string; messageId: string }> }> {
  const { to, text, mediaItem, opts, label } = params;

  const items: MessageItem[] = [];
  if (text) {
    items.push({ type: MessageItemType.TEXT, text_item: { text } });
  }
  items.push(mediaItem);

  let lastClientId = "";
  const parts: Array<{ kind: string; messageId: string }> = [];
  for (const item of items) {
    const kind = item.type === MessageItemType.TEXT ? "text" : "media";
    lastClientId = params.clientIds?.[kind] ?? generateClientId();
    const req: SendMessageReq = {
      msg: {
        from_user_id: "",
        to_user_id: to,
        client_id: lastClientId,
        message_type: MessageType.BOT,
        message_state: MessageState.FINISH,
        item_list: [item],
        context_token: opts.contextToken ?? undefined,
      },
    };
    try {
      await sendMessageApi({
        baseUrl: opts.baseUrl,
        token: opts.token,
        timeoutMs: opts.timeoutMs,
        body: req,
      });
      parts.push({ kind, messageId: lastClientId });
    } catch (err) {
      logger.error(
        `${label}: failed to=${to} clientId=${lastClientId} err=${String(err)}`,
      );
      const wrapped = err instanceof Error ? err : new Error(String(err));
      (wrapped as unknown as { parts: Array<{ kind: string; messageId: string }> }).parts = parts;
      throw wrapped;
    }
  }

  logger.debug(`${label}: success to=${to} clientId=${lastClientId}`);
  return { messageId: lastClientId, parts };
}

/**
 * Send an image message downstream using a previously uploaded file.
 * Optionally include a text caption as a separate TEXT item before the image.
 *
 * ImageItem fields:
 *   - media.encrypt_query_param: CDN download param
 *   - media.aes_key: AES key, base64-encoded
 *   - mid_size: original ciphertext file size
 */
export async function sendImageMessageWeixin(params: {
  to: string;
  text: string;
  uploaded: UploadedFileInfo;
  opts: WeixinApiOptions & { contextToken?: string };
  clientIds?: { text?: string; media?: string };
}): Promise<{ messageId: string; parts: Array<{ kind: string; messageId: string }> }> {
  const { to, text, uploaded, opts } = params;
  if (!opts.contextToken) {
    logger.error(`sendImageMessageWeixin: contextToken missing, refusing to send to=${to}`);
    throw new Error("sendImageMessageWeixin: contextToken is required");
  }
  logger.debug(
    `sendImageMessageWeixin: to=${to} filekey=${uploaded.filekey} fileSize=${uploaded.fileSize} aeskey=present`,
  );

  const imageItem: MessageItem = {
    type: MessageItemType.IMAGE,
    image_item: {
      media: {
        encrypt_query_param: uploaded.downloadEncryptedQueryParam,
        aes_key: Buffer.from(uploaded.aeskey).toString("base64"),
        encrypt_type: 1,
      },
      mid_size: uploaded.fileSizeCiphertext,
    },
  };

  return sendMediaItems({ to, text, mediaItem: imageItem, opts, label: "sendImageMessageWeixin", clientIds: params.clientIds });
}

/**
 * Send a video message downstream using a previously uploaded file.
 * VideoItem: media (CDN ref), video_size (ciphertext bytes).
 * Includes an optional text caption sent as a separate TEXT item first.
 */
export async function sendVideoMessageWeixin(params: {
  to: string;
  text: string;
  uploaded: UploadedFileInfo;
  opts: WeixinApiOptions & { contextToken?: string };
  clientIds?: { text?: string; media?: string };
}): Promise<{ messageId: string; parts: Array<{ kind: string; messageId: string }> }> {
  const { to, text, uploaded, opts } = params;
  if (!opts.contextToken) {
    logger.error(`sendVideoMessageWeixin: contextToken missing, refusing to send to=${to}`);
    throw new Error("sendVideoMessageWeixin: contextToken is required");
  }

  const videoItem: MessageItem = {
    type: MessageItemType.VIDEO,
    video_item: {
      media: {
        encrypt_query_param: uploaded.downloadEncryptedQueryParam,
        aes_key: Buffer.from(uploaded.aeskey).toString("base64"),
        encrypt_type: 1,
      },
      video_size: uploaded.fileSizeCiphertext,
    },
  };

  return sendMediaItems({ to, text, mediaItem: videoItem, opts, label: "sendVideoMessageWeixin", clientIds: params.clientIds });
}

/**
 * Send a file attachment downstream using a previously uploaded file.
 * FileItem: media (CDN ref), file_name, len (plaintext bytes as string).
 * Includes an optional text caption sent as a separate TEXT item first.
 */
export async function sendFileMessageWeixin(params: {
  to: string;
  text: string;
  fileName: string;
  uploaded: UploadedFileInfo;
  opts: WeixinApiOptions & { contextToken?: string };
  clientIds?: { text?: string; media?: string };
}): Promise<{ messageId: string; parts: Array<{ kind: string; messageId: string }> }> {
  const { to, text, fileName, uploaded, opts } = params;
  if (!opts.contextToken) {
    logger.error(`sendFileMessageWeixin: contextToken missing, refusing to send to=${to}`);
    throw new Error("sendFileMessageWeixin: contextToken is required");
  }
  const fileItem: MessageItem = {
    type: MessageItemType.FILE,
    file_item: {
      media: {
        encrypt_query_param: uploaded.downloadEncryptedQueryParam,
        aes_key: Buffer.from(uploaded.aeskey).toString("base64"),
        encrypt_type: 1,
      },
      file_name: fileName,
      len: String(uploaded.fileSize),
    },
  };

  return sendMediaItems({ to, text, mediaItem: fileItem, opts, label: "sendFileMessageWeixin", clientIds: params.clientIds });
}
