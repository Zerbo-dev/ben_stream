import type { AppConfig } from "../config.js";
import { isAdmin } from "../config.js";
import type { CatalogStore } from "../catalog.js";
import type { TelegramClient } from "../telegram.js";
import type {
  CatalogItem,
  InlineKeyboardMarkup,
  TelegramMessage,
  TelegramUpdate,
} from "../types.js";
import {
  escapeHtml,
  formatItemLine,
  kindLabel,
  messageToCatalogItem,
} from "./media.js";

const HELP_TEXT = `🎬 <b>BenStream Bot</b>

Je te sers des films et séries à la demande depuis le catalogue.

<b>Commandes</b>
/start — accueil
/help — aide
/search &lt;titre&gt; — rechercher
/recent — derniers ajouts
/stats — taille du catalogue

Tu peux aussi m'envoyer directement un titre.

<i>Astuce admin :</i> transfère un média du canal ici pour l'indexer manuellement.`;

export async function handleUpdate(
  update: TelegramUpdate,
  deps: {
    telegram: TelegramClient;
    catalog: CatalogStore;
    config: AppConfig;
  }
): Promise<void> {
  const { telegram, catalog, config } = deps;

  if (update.channel_post || update.edited_channel_post) {
    const post = update.channel_post || update.edited_channel_post!;
    await handleChannelPost(post, { telegram, catalog, config });
    return;
  }

  if (update.callback_query) {
    await handleCallback(update, deps);
    return;
  }

  const message = update.message || update.edited_message;
  if (!message) return;

  // Ignore les messages hors chat privé (sauf commandes admin éventuelles)
  if (message.chat.type !== "private") return;

  await handlePrivateMessage(message, deps);
}

async function handleChannelPost(
  post: TelegramMessage,
  deps: {
    telegram: TelegramClient;
    catalog: CatalogStore;
    config: AppConfig;
  }
): Promise<void> {
  const { telegram, catalog, config } = deps;

  if (String(post.chat.id) !== String(config.channelId)) {
    return;
  }

  const item = messageToCatalogItem(post);
  if (!item) return;

  try {
    // Pour les albums, on indexe chaque message (épisodes/fichiers séparés)
    await catalog.upsert(item);
  } catch (error) {
    const detail = error instanceof Error ? error.message : "erreur inconnue";
    console.error("channel index error", detail);
    await notifyAdmins(
      telegram,
      config.adminIds,
      `❌ Indexation canal échouée pour <b>${escapeHtml(item.title)}</b>\n<code>${escapeHtml(detail)}</code>\n\nVérifie que le token Upstash est bien <b>read-write</b> (pas read-only).`
    );
  }
}

async function handlePrivateMessage(
  message: TelegramMessage,
  deps: {
    telegram: TelegramClient;
    catalog: CatalogStore;
    config: AppConfig;
  }
): Promise<void> {
  const { telegram, catalog, config } = deps;
  const chatId = message.chat.id;
  const userId = message.from?.id;
  const text = (message.text || "").trim();

  // Indexation manuelle : admin transfère un média du canal
  if (isForwardFromChannel(message, config.channelId)) {
    if (!isAdmin(userId, config.adminIds)) {
      await telegram.sendMessage(
        chatId,
        "Seul un admin peut indexer du contenu manuellement."
      );
      return;
    }

    const sourceMessageId =
      message.forward_from_message_id ||
      message.forward_origin?.message_id;

    if (!sourceMessageId) {
      await telegram.sendMessage(
        chatId,
        "Impossible de retrouver le message_id d'origine. Republie le média dans le canal (le bot l'indexera automatiquement)."
      );
      return;
    }

    const item = messageToCatalogItem({
      ...message,
      message_id: sourceMessageId,
    });

    if (!item) {
      await telegram.sendMessage(chatId, "Ce message ne contient pas de média indexable.");
      return;
    }

    try {
      await catalog.upsert(item);
    } catch (error) {
      const detail = error instanceof Error ? error.message : "erreur inconnue";
      await telegram.sendMessage(
        chatId,
        `❌ Impossible d'écrire dans Redis (Upstash).\n<code>${escapeHtml(detail)}</code>\n\nLe token doit être <b>read-write</b>, pas read-only.`,
        { parse_mode: "HTML" }
      );
      return;
    }

    await telegram.sendMessage(
      chatId,
      `✅ Indexé : <b>${escapeHtml(item.title)}</b>\nID: <code>${item.messageId}</code>`,
      { parse_mode: "HTML" }
    );
    return;
  }

  if (!text) {
    await telegram.sendMessage(
      chatId,
      "Envoie un titre à rechercher, ou /help pour l'aide."
    );
    return;
  }

  if (text === "/start") {
    await telegram.sendMessage(chatId, HELP_TEXT, { parse_mode: "HTML" });
    return;
  }

  if (text === "/help") {
    await telegram.sendMessage(chatId, HELP_TEXT, { parse_mode: "HTML" });
    return;
  }

  if (text === "/stats") {
    const count = await catalog.count();
    await telegram.sendMessage(
      chatId,
      `📊 Catalogue : <b>${count}</b> titre(s) indexé(s).`,
      { parse_mode: "HTML" }
    );
    return;
  }

  if (text === "/recent") {
    const items = await catalog.recent(10);
    if (!items.length) {
      await telegram.sendMessage(
        chatId,
        "Catalogue vide. Publie des médias dans le canal (bot admin) pour les indexer."
      );
      return;
    }
    await sendSearchResults(telegram, chatId, items, "🕐 Derniers ajouts");
    return;
  }

  if (text.startsWith("/search")) {
    const query = text.replace(/^\/search(@\w+)?\s*/i, "").trim();
    if (!query) {
      await telegram.sendMessage(chatId, "Usage : /search <titre>");
      return;
    }
    await runSearch(telegram, catalog, chatId, query);
    return;
  }

  // Texte libre = recherche
  if (text.startsWith("/")) {
    await telegram.sendMessage(chatId, "Commande inconnue. Voir /help");
    return;
  }

  await runSearch(telegram, catalog, chatId, text);
}

async function runSearch(
  telegram: TelegramClient,
  catalog: CatalogStore,
  chatId: number,
  query: string
): Promise<void> {
  const items = await catalog.search(query, 15);
  if (!items.length) {
    await telegram.sendMessage(
      chatId,
      `Aucun résultat pour « ${escapeHtml(query)} ».`,
      { parse_mode: "HTML" }
    );
    return;
  }
  await sendSearchResults(
    telegram,
    chatId,
    items,
    `🔎 Résultats pour « ${escapeHtml(query)} »`
  );
}

async function sendSearchResults(
  telegram: TelegramClient,
  chatId: number,
  items: CatalogItem[],
  title: string
): Promise<void> {
  const lines = items.map((item, i) => formatItemLine(item, i + 1));
  const keyboard = buildResultsKeyboard(items);

  await telegram.sendMessage(
    chatId,
    `${title}\n\n${lines.join("\n\n")}\n\nAppuie sur un bouton pour recevoir le fichier.`,
    {
      parse_mode: "HTML",
      reply_markup: keyboard,
    }
  );
}

function buildResultsKeyboard(items: CatalogItem[]): InlineKeyboardMarkup {
  const rows = items.map((item) => [
    {
      text: `${kindLabel(item.kind)} ${truncateButton(item.title)}`,
      callback_data: `get:${item.messageId}`,
    },
  ]);
  return { inline_keyboard: rows };
}

function truncateButton(title: string): string {
  return title.length > 54 ? `${title.slice(0, 53)}…` : title;
}

async function handleCallback(
  update: TelegramUpdate,
  deps: {
    telegram: TelegramClient;
    catalog: CatalogStore;
    config: AppConfig;
  }
): Promise<void> {
  const { telegram, catalog, config } = deps;
  const cb = update.callback_query!;
  const data = cb.data || "";
  const chatId = cb.message?.chat.id;

  if (!chatId) {
    await telegram.answerCallbackQuery(cb.id, "Session expirée");
    return;
  }

  if (!data.startsWith("get:")) {
    await telegram.answerCallbackQuery(cb.id, "Action inconnue");
    return;
  }

  const messageId = Number(data.slice(4));
  if (!Number.isFinite(messageId)) {
    await telegram.answerCallbackQuery(cb.id, "ID invalide", true);
    return;
  }

  const item = await catalog.get(messageId);
  if (!item) {
    await telegram.answerCallbackQuery(cb.id, "Introuvable dans le catalogue", true);
    return;
  }

  await telegram.answerCallbackQuery(cb.id, "Envoi en cours…");

  try {
    await telegram.copyMessage(chatId, config.channelId, item.messageId);
    await telegram.sendMessage(
      chatId,
      `✅ Envoyé : <b>${escapeHtml(item.title)}</b>`,
      { parse_mode: "HTML" }
    );
  } catch (error) {
    const detail = error instanceof Error ? error.message : "erreur inconnue";
    await telegram.sendMessage(
      chatId,
      `❌ Impossible d'envoyer ce média.\n<code>${escapeHtml(detail)}</code>\n\nVérifie que le bot est bien admin du canal et que le message existe encore.`,
      { parse_mode: "HTML" }
    );
  }
}

function isForwardFromChannel(
  message: TelegramMessage,
  channelId: string
): boolean {
  const originChatId =
    message.forward_from_chat?.id ?? message.forward_origin?.chat?.id;
  if (originChatId == null) return false;
  return String(originChatId) === String(channelId);
}

async function notifyAdmins(
  telegram: TelegramClient,
  adminIds: number[],
  text: string
): Promise<void> {
  await Promise.allSettled(
    adminIds.map((adminId) =>
      telegram.sendMessage(adminId, text, { parse_mode: "HTML" })
    )
  );
}
