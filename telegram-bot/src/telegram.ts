import type {
  InlineKeyboardMarkup,
  TelegramUpdate,
} from "./types.js";

type TelegramApiResponse<T> = {
  ok: boolean;
  result?: T;
  description?: string;
  error_code?: number;
};

export class TelegramClient {
  constructor(private readonly token: string) {}

  private async call<T>(
    method: string,
    body?: Record<string, unknown>
  ): Promise<T> {
    const response = await fetch(
      `https://api.telegram.org/bot${this.token}/${method}`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: body ? JSON.stringify(body) : undefined,
      }
    );

    const data = (await response.json()) as TelegramApiResponse<T>;
    if (!data.ok) {
      throw new Error(
        `Telegram API ${method} failed: ${data.description || response.statusText}`
      );
    }
    return data.result as T;
  }

  sendMessage(
    chatId: number | string,
    text: string,
    options: {
      parse_mode?: "HTML" | "Markdown" | "MarkdownV2";
      reply_markup?: InlineKeyboardMarkup;
      disable_web_page_preview?: boolean;
    } = {}
  ) {
    return this.call<{ message_id: number }>("sendMessage", {
      chat_id: chatId,
      text,
      ...options,
    });
  }

  editMessageText(
    chatId: number | string,
    messageId: number,
    text: string,
    options: {
      parse_mode?: "HTML" | "Markdown" | "MarkdownV2";
      reply_markup?: InlineKeyboardMarkup;
      disable_web_page_preview?: boolean;
    } = {}
  ) {
    return this.call<boolean | { message_id: number }>("editMessageText", {
      chat_id: chatId,
      message_id: messageId,
      text,
      ...options,
    });
  }

  answerCallbackQuery(callbackQueryId: string, text?: string, showAlert = false) {
    return this.call<boolean>("answerCallbackQuery", {
      callback_query_id: callbackQueryId,
      text,
      show_alert: showAlert,
    });
  }

  /**
   * Copie un message du canal privé vers l'utilisateur.
   * L'utilisateur reçoit le média sans rejoindre le canal.
   */
  copyMessage(
    toChatId: number | string,
    fromChatId: number | string,
    messageId: number,
    options: { caption?: string } = {}
  ) {
    return this.call<{ message_id: number }>("copyMessage", {
      chat_id: toChatId,
      from_chat_id: fromChatId,
      message_id: messageId,
      ...options,
    });
  }

  setWebhook(url: string, secretToken?: string) {
    return this.call<boolean>("setWebhook", {
      url,
      secret_token: secretToken || undefined,
      allowed_updates: [
        "message",
        "edited_message",
        "channel_post",
        "edited_channel_post",
        "callback_query",
      ],
      drop_pending_updates: false,
    });
  }

  deleteWebhook() {
    return this.call<boolean>("deleteWebhook", {
      drop_pending_updates: false,
    });
  }

  getWebhookInfo() {
    return this.call<Record<string, unknown>>("getWebhookInfo");
  }

  getMe() {
    return this.call<{ id: number; username?: string; first_name: string }>(
      "getMe"
    );
  }
}

export function parseUpdate(body: unknown): TelegramUpdate {
  if (!body || typeof body !== "object") {
    throw new Error("Update Telegram invalide");
  }
  return body as TelegramUpdate;
}
