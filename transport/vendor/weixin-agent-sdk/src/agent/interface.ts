/**
 * Agent interface — any AI backend that can handle a chat message.
 *
 * Implement this interface to connect WeChat to your own AI service.
 * The WeChat bridge calls `chat()` for each inbound message and sends
 * the returned response back to the user.
 */

import type { MessageItem } from "../api/types.js";

export interface Agent {
  /** Process a single message and return a reply. */
  chat(request: ChatRequest): Promise<ChatResponse>;
  /** Clear/reset the session for a given conversation. */
  clearSession?(conversationId: string): void;
}

export interface ChatRequest {
  /** Conversation / user identifier. Use this to maintain per-user context. */
  conversationId: string;
  /** Text content of the message. */
  text: string;
  /**
   * The inbound message item to quote when replying (WeChat 引用回复).
   * Set from the original item_list entry that produced `text`; pass it
   * back verbatim in `ChatResponse.quote` to quote the user's message.
   */
  quote?: MessageItem;
  /** Attached media file (image, audio, video, or generic file). */
  media?: {
    type: "image" | "audio" | "video" | "file";
    /** Local file path (already downloaded and decrypted). */
    filePath: string;
    /** MIME type, e.g. "image/jpeg", "audio/wav". */
    mimeType: string;
    /** Original filename (available for file attachments). */
    fileName?: string;
  };
}

export interface ChatResponse {
  /** Reply text (may contain markdown — will be converted to plain text before sending). */
  text?: string;
  /**
   * Quote the user's message in the reply (WeChat 引用回复).
   * The item is attached as `ref_msg` on the outgoing text item.
   * Text replies only in v1; ignored for media replies.
   */
  quote?: MessageItem;
  /** Reply media file. */
  media?: {
    type: "image" | "video" | "file";
    /** Local file path or HTTPS URL. */
    url: string;
    /** Filename hint (for file attachments). */
    fileName?: string;
  };
}
