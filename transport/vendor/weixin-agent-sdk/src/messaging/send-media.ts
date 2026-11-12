import path from "node:path";
import type { WeixinApiOptions } from "../api/api.js";
import { logger } from "../util/logger.js";
import { getMimeFromFilename } from "../media/mime.js";
import { sendFileMessageWeixin, sendImageMessageWeixin, sendVideoMessageWeixin } from "./send.js";
import { uploadFileAttachmentToWeixin, uploadFileToWeixin, uploadVideoToWeixin } from "../cdn/upload.js";

/**
 * Upload a local file and send it as a weixin message, routing by MIME type:
 *   video/*  → uploadVideoToWeixin        + sendVideoMessageWeixin
 *   image/*  → uploadFileToWeixin         + sendImageMessageWeixin
 *   else     → uploadFileAttachmentToWeixin + sendFileMessageWeixin
 *
 * Used by both the auto-reply deliver path (monitor.ts) and the outbound
 * sendMedia path (channel.ts) so they stay in sync.
 */
export async function sendWeixinMediaFile(params: {
  filePath: string;
  to: string;
  text: string;
  opts: WeixinApiOptions & { contextToken?: string };
  cdnBaseUrl: string;
  clientIds?: { text?: string; media?: string };
}): Promise<{ messageId: string; parts: Array<{ kind: string; messageId: string }> }> {
  const { filePath, to, text, opts, cdnBaseUrl } = params;
  const mime = getMimeFromFilename(filePath);
  const uploadOpts: WeixinApiOptions = { baseUrl: opts.baseUrl, token: opts.token };

  // Upload failures happen before any message bytes are sent, so they are
  // provably safe to retry. Mark them explicitly so callers can tell an
  // upload failure (nothing delivered) from a send failure (unknown).
  const upload = async <T>(fn: () => Promise<T>): Promise<T> => {
    try {
      return await fn();
    } catch (err) {
      throw new Error(`media upload failed: ${String(err)}`);
    }
  };

  if (mime.startsWith("video/")) {
    logger.info(`[weixin] sendWeixinMediaFile: uploading video filePath=${filePath} to=${to}`);
    const uploaded = await upload(() =>
      uploadVideoToWeixin({
        filePath,
        toUserId: to,
        opts: uploadOpts,
        cdnBaseUrl,
      }),
    );
    logger.info(
      `[weixin] sendWeixinMediaFile: video upload done filekey=${uploaded.filekey} size=${uploaded.fileSize}`,
    );
    return sendVideoMessageWeixin({ to, text, uploaded, opts, clientIds: params.clientIds });
  }

  if (mime.startsWith("image/")) {
    logger.info(`[weixin] sendWeixinMediaFile: uploading image filePath=${filePath} to=${to}`);
    const uploaded = await upload(() =>
      uploadFileToWeixin({
        filePath,
        toUserId: to,
        opts: uploadOpts,
        cdnBaseUrl,
      }),
    );
    logger.info(
      `[weixin] sendWeixinMediaFile: image upload done filekey=${uploaded.filekey} size=${uploaded.fileSize}`,
    );
    return sendImageMessageWeixin({ to, text, uploaded, opts, clientIds: params.clientIds });
  }

  // File attachment: pdf, doc, zip, etc.
  const fileName = path.basename(filePath);
  logger.info(
    `[weixin] sendWeixinMediaFile: uploading file attachment filePath=${filePath} name=${fileName} to=${to}`,
  );
  const uploaded = await upload(() =>
    uploadFileAttachmentToWeixin({
      filePath,
      fileName,
      toUserId: to,
      opts: uploadOpts,
      cdnBaseUrl,
    }),
  );
  logger.info(
    `[weixin] sendWeixinMediaFile: file upload done filekey=${uploaded.filekey} size=${uploaded.fileSize}`,
  );
  return sendFileMessageWeixin({ to, text, fileName, uploaded, opts, clientIds: params.clientIds });
}
