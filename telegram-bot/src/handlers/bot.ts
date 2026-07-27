import type { AppConfig } from "../config.js";
import { isAdmin } from "../config.js";
import {
  CatalogStore,
  groupByShow,
} from "../catalog.js";
import type { TelegramClient } from "../telegram.js";
import type {
  ContentType,
  InlineKeyboardMarkup,
  ShowGroup,
  TelegramMessage,
  TelegramUpdate,
} from "../types.js";
import {
  escapeHtml,
  messageToCatalogItem,
} from "./media.js";
import {
  contentTypeEmoji,
  contentTypeLabel,
  formatEpisodeCode,
  formatShowLabel,
} from "../vod.js";

const PAGE_SIZE = 8;

const HELP_TEXT = `🎬 <b>BenStream</b> — films, séries & animés à la demande

Envoie un <b>titre</b> pour chercher, ou utilise le menu.

<b>Commandes</b>
/start — menu
/films — parcourir les films
/series — parcourir les séries
/animes — parcourir les animés
/recent — derniers ajouts
/search &lt;titre&gt; — recherche
/stats — catalogue

<b>Astuce pubs canal (admin)</b>
<code>Inception (2010) 1080p VF</code>
<code>Breaking Bad S01E01 1080p VOSTFR</code>
<code>Attack on Titan S01E03 #anime</code>

<code>S01E01</code> / <code>1x02</code> → série auto. <code>#anime</code> seulement pour les animés.

<i>Admin :</i> <code>/purge &lt;message_id&gt;</code> retire une entrée du catalogue.`;

export async function handleUpdate(
  update: TelegramUpdate,
  deps: {
    telegram: TelegramClient;
    catalog: CatalogStore;
    config: AppConfig;
  }
): Promise<void> {
  if (update.channel_post || update.edited_channel_post) {
    const post = update.channel_post || update.edited_channel_post!;
    await handleChannelPost(post, deps);
    return;
  }

  if (update.callback_query) {
    await handleCallback(update, deps);
    return;
  }

  const message = update.message || update.edited_message;
  if (!message) return;
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

  if (String(post.chat.id) !== String(config.channelId)) return;

  const item = messageToCatalogItem(post);
  if (!item) return;

  try {
    await catalog.upsert(item);
    await notifyAdmins(
      telegram,
      config.adminIds,
      `✅ Indexé ${contentTypeEmoji(item.contentType)} <b>${escapeHtml(item.displayTitle)}</b>`
    );
  } catch (error) {
    const detail = error instanceof Error ? error.message : "erreur inconnue";
    console.error("channel index error", detail);
    await notifyAdmins(
      telegram,
      config.adminIds,
      `❌ Indexation échouée pour <b>${escapeHtml(item.title)}</b>\n<code>${escapeHtml(detail)}</code>\n\nVérifie le token Upstash <b>read-write</b>.`
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

  if (isForwardFromChannel(message, config.channelId)) {
    await handleAdminForward(message, deps);
    return;
  }

  if (!text) {
    await telegram.sendMessage(chatId, "Envoie un titre, ou /start pour le menu.");
    return;
  }

  const command = text.split(/\s+/)[0].replace(/@\w+$/, "").toLowerCase();

  if (command === "/start" || command === "/menu" || command === "/help") {
    await sendMainMenu(telegram, catalog, chatId);
    return;
  }

  if (command === "/stats") {
    const stats = await catalog.stats();
    await telegram.sendMessage(chatId, formatStatsText(stats), {
      parse_mode: "HTML",
      reply_markup: mainMenuKeyboard(),
    });
    return;
  }

  if (command === "/recent") {
    await sendBrowsePage(telegram, catalog, chatId, "recent", 0, false);
    return;
  }

  if (command === "/films" || command === "/film") {
    await sendBrowsePage(telegram, catalog, chatId, "film", 0, false);
    return;
  }

  if (command === "/series" || command === "/serie") {
    await sendBrowsePage(telegram, catalog, chatId, "serie", 0, false);
    return;
  }

  if (command === "/animes" || command === "/anime") {
    await sendBrowsePage(telegram, catalog, chatId, "anime", 0, false);
    return;
  }

  if (command === "/purge") {
    if (!isAdmin(userId, config.adminIds)) {
      await telegram.sendMessage(chatId, "Commande réservée aux admins.");
      return;
    }
    const rawId = text.replace(/^\/purge(@\w+)?\s*/i, "").trim();
    const messageId = Number(rawId);
    if (!rawId || !Number.isFinite(messageId)) {
      await telegram.sendMessage(
        chatId,
        "Usage : /purge <message_id>\nLe message_id est celui du post dans le canal (affiché à l'indexation)."
      );
      return;
    }
    const existing = await catalog.get(messageId);
    await catalog.remove(messageId);
    await telegram.sendMessage(
      chatId,
      existing
        ? `🗑 Retiré du catalogue : <b>${escapeHtml(existing.displayTitle)}</b> (<code>${messageId}</code>)`
        : `🗑 ID <code>${messageId}</code> retiré (ou déjà absent).`,
      { parse_mode: "HTML" }
    );
    return;
  }

  if (command === "/search") {
    const query = text.replace(/^\/search(@\w+)?\s*/i, "").trim();
    if (!query) {
      await telegram.sendMessage(chatId, "Usage : /search <titre>");
      return;
    }
    await runSearch(telegram, catalog, chatId, query);
    return;
  }

  if (text.startsWith("/")) {
    await telegram.sendMessage(chatId, "Commande inconnue. Voir /start", {
      reply_markup: mainMenuKeyboard(),
    });
    return;
  }

  // Ignore unused admin check warning
  void userId;
  await runSearch(telegram, catalog, chatId, text);
}

async function handleAdminForward(
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

  if (!isAdmin(userId, config.adminIds)) {
    await telegram.sendMessage(chatId, "Seul un admin peut indexer manuellement.");
    return;
  }

  const sourceMessageId =
    message.forward_from_message_id || message.forward_origin?.message_id;

  if (!sourceMessageId) {
    await telegram.sendMessage(
      chatId,
      "Impossible de retrouver le message d'origine. Republie le média dans le canal."
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
      `❌ Redis : <code>${escapeHtml(detail)}</code>`,
      { parse_mode: "HTML" }
    );
    return;
  }

  await telegram.sendMessage(
    chatId,
    `✅ Indexé ${contentTypeEmoji(item.contentType)} <b>${escapeHtml(item.displayTitle)}</b>\n` +
      `<code>${item.contentType}</code> · ID <code>${item.messageId}</code>`,
    { parse_mode: "HTML" }
  );
}

async function sendMainMenu(
  telegram: TelegramClient,
  catalog: CatalogStore,
  chatId: number
): Promise<void> {
  const stats = await catalog.stats();
  await telegram.sendMessage(
    chatId,
    `${HELP_TEXT}\n\n${formatStatsSummary(stats)}`,
    {
      parse_mode: "HTML",
      reply_markup: mainMenuKeyboard(),
    }
  );
}

function mainMenuKeyboard(): InlineKeyboardMarkup {
  return {
    inline_keyboard: [
      [
        { text: "🎬 Films", callback_data: "cat:film:0" },
        { text: "📺 Séries", callback_data: "cat:serie:0" },
      ],
      [
        { text: "🎌 Animés", callback_data: "cat:anime:0" },
        { text: "🕐 Récents", callback_data: "cat:recent:0" },
      ],
      [{ text: "📊 Stats", callback_data: "stats" }],
    ],
  };
}

async function runSearch(
  telegram: TelegramClient,
  catalog: CatalogStore,
  chatId: number,
  query: string
): Promise<void> {
  const items = await catalog.search(query, 50);
  if (!items.length) {
    await telegram.sendMessage(
      chatId,
      `Aucun résultat pour « ${escapeHtml(query)} ».\nEssaie un autre mot, ou /films /series /animes.`,
      { parse_mode: "HTML", reply_markup: mainMenuKeyboard() }
    );
    return;
  }

  const groups = groupByShow(items);
  // Une seule série/animé avec plusieurs épisodes → ouvrir directement la fiche
  if (groups.length === 1 && groups[0].episodes.length > 1 && groups[0].contentType !== "film") {
    await sendShowPage(telegram, chatId, groups[0], 0, false);
    return;
  }

  await sendGroupedResults(
    telegram,
    chatId,
    groups,
    `🔎 Résultats pour « ${escapeHtml(query)} »`
  );
}

async function sendGroupedResults(
  telegram: TelegramClient,
  chatId: number,
  groups: ShowGroup[],
  title: string
): Promise<void> {
  const preview = groups.slice(0, 12);
  const lines = preview.map((group, i) => {
    const emoji = contentTypeEmoji(group.contentType);
    const label = formatGroupLabel(group);
    if (group.contentType === "film" || group.episodes.length === 1) {
      return `${i + 1}. ${emoji} <b>${escapeHtml(label)}</b>`;
    }
    return `${i + 1}. ${emoji} <b>${escapeHtml(label)}</b> — ${describeGroup(group)}`;
  });

  const rows = preview.map((group) => {
    const label = formatGroupLabel(group);
    if (group.contentType === "film" || group.episodes.length === 1) {
      return [
        {
          text: `${contentTypeEmoji(group.contentType)} ${truncateButton(label)}`,
          callback_data: `get:${group.episodes[0].messageId}`,
        },
      ];
    }
    return [
      {
        text: `${contentTypeEmoji(group.contentType)} ${truncateButton(label)}`,
        callback_data: `show:${group.key}:0`,
      },
    ];
  });

  rows.push([{ text: "🏠 Menu", callback_data: "menu" }]);

  await telegram.sendMessage(
    chatId,
    `${title}\n\n${lines.join("\n")}\n\nChoisis un titre ou une série.`,
    {
      parse_mode: "HTML",
      reply_markup: { inline_keyboard: rows },
    }
  );
}

async function sendBrowsePage(
  telegram: TelegramClient,
  catalog: CatalogStore,
  chatId: number,
  category: ContentType | "recent",
  page: number,
  edit: { messageId: number } | false
): Promise<void> {
  let groups: ShowGroup[];
  let heading: string;

  if (category === "recent") {
    const items = await catalog.recent(40);
    groups = groupByShow(items);
    heading = "🕐 Derniers ajouts";
  } else {
    const items = await catalog.byContentType(category);
    groups = groupByShow(items);
    heading = contentTypeLabel(category);
  }

  if (!groups.length) {
    const empty =
      "Rien ici pour l’instant.\nPublie des médias dans le canal avec une caption claire (#film #serie #anime).";
    if (edit) {
      await telegram.editMessageText(chatId, edit.messageId, empty, {
        reply_markup: mainMenuKeyboard(),
      });
    } else {
      await telegram.sendMessage(chatId, empty, {
        reply_markup: mainMenuKeyboard(),
      });
    }
    return;
  }

  const totalPages = Math.max(1, Math.ceil(groups.length / PAGE_SIZE));
  const safePage = Math.min(Math.max(page, 0), totalPages - 1);
  const slice = groups.slice(safePage * PAGE_SIZE, safePage * PAGE_SIZE + PAGE_SIZE);

  const lines = slice.map((group, i) => {
    const n = safePage * PAGE_SIZE + i + 1;
    const emoji = contentTypeEmoji(group.contentType);
    const label = formatGroupLabel(group);
    if (group.contentType === "film" || group.episodes.length === 1) {
      return `${n}. ${emoji} <b>${escapeHtml(label)}</b>`;
    }
    return `${n}. ${emoji} <b>${escapeHtml(label)}</b> — ${describeGroup(group)}`;
  });

  const rows = slice.map((group) => {
    const label = formatGroupLabel(group);
    if (group.contentType === "film" || group.episodes.length === 1) {
      return [
        {
          text: `${contentTypeEmoji(group.contentType)} ${truncateButton(label)}`,
          callback_data: `get:${group.episodes[0].messageId}`,
        },
      ];
    }
    return [
      {
        text: `${contentTypeEmoji(group.contentType)} ${truncateButton(label)}`,
        callback_data: `show:${group.key}:0`,
      },
    ];
  });

  const nav: { text: string; callback_data: string }[] = [];
  if (safePage > 0) nav.push({ text: "⬅️", callback_data: `cat:${category}:${safePage - 1}` });
  nav.push({ text: `${safePage + 1}/${totalPages}`, callback_data: "noop" });
  if (safePage < totalPages - 1) {
    nav.push({ text: "➡️", callback_data: `cat:${category}:${safePage + 1}` });
  }
  rows.push(nav);
  rows.push([{ text: "🏠 Menu", callback_data: "menu" }]);

  const text =
    `<b>${heading}</b> — ${groups.length} titre(s)\n\n` +
    `${lines.join("\n")}\n\nAppuie pour regarder ou ouvrir les épisodes.`;

  if (edit) {
    await telegram.editMessageText(chatId, edit.messageId, text, {
      parse_mode: "HTML",
      reply_markup: { inline_keyboard: rows },
    });
  } else {
    await telegram.sendMessage(chatId, text, {
      parse_mode: "HTML",
      reply_markup: { inline_keyboard: rows },
    });
  }
}

async function sendShowPage(
  telegram: TelegramClient,
  chatId: number,
  group: ShowGroup,
  page: number,
  edit: { messageId: number } | false
): Promise<void> {
  const episodes = group.episodes;
  const seasons = listSeasons(group);
  const totalPages = Math.max(1, Math.ceil(episodes.length / PAGE_SIZE));
  const safePage = Math.min(Math.max(page, 0), totalPages - 1);
  const slice = episodes.slice(safePage * PAGE_SIZE, safePage * PAGE_SIZE + PAGE_SIZE);

  const lines = slice.map((item, i) => {
    const n = safePage * PAGE_SIZE + i + 1;
    const ep = formatEpisodeCode(item.season, item.episode) || `#${n}`;
    const meta = [item.quality, item.language].filter(Boolean).join(" · ");
    return `${n}. <b>${ep}</b>${meta ? ` — ${meta}` : ""}`;
  });

  const rows: { text: string; callback_data: string }[][] = [];

  // Boutons "toute la saison"
  for (const season of seasons) {
    const count = episodes.filter((ep) => (ep.season ?? 1) === season).length;
    rows.push([
      {
        text: `📦 Toute la saison ${season} (${count} ép.)`,
        callback_data: `sea:${group.key}:${season}`,
      },
    ]);
  }

  for (const item of slice) {
    const ep = formatEpisodeCode(item.season, item.episode) || item.displayTitle;
    rows.push([
      {
        text: `▶️ ${truncateButton(ep)}`,
        callback_data: `get:${item.messageId}`,
      },
    ]);
  }

  const nav: { text: string; callback_data: string }[] = [];
  if (safePage > 0) nav.push({ text: "⬅️", callback_data: `show:${group.key}:${safePage - 1}` });
  nav.push({ text: `${safePage + 1}/${totalPages}`, callback_data: "noop" });
  if (safePage < totalPages - 1) {
    nav.push({ text: "➡️", callback_data: `show:${group.key}:${safePage + 1}` });
  }
  rows.push(nav);
  rows.push([
    { text: `↩️ ${contentTypeLabel(group.contentType)}`, callback_data: `cat:${group.contentType}:0` },
    { text: "🏠 Menu", callback_data: "menu" },
  ]);

  const showLabel = formatGroupLabel(group);

  const text =
    `${contentTypeEmoji(group.contentType)} <b>${escapeHtml(showLabel)}</b>\n` +
    `${seasons.length} saison(s) · ${episodes.length} épisode(s)\n\n` +
    `${lines.join("\n")}\n\nPrends un épisode, ou toute une saison.`;

  if (edit) {
    await telegram.editMessageText(chatId, edit.messageId, text, {
      parse_mode: "HTML",
      reply_markup: { inline_keyboard: rows },
    });
  } else {
    await telegram.sendMessage(chatId, text, {
      parse_mode: "HTML",
      reply_markup: { inline_keyboard: rows },
    });
  }
}

function listSeasons(group: ShowGroup): number[] {
  const set = new Set(group.episodes.map((ep) => ep.season ?? 1));
  return [...set].sort((a, b) => a - b);
}

function formatGroupLabel(group: ShowGroup): string {
  return formatShowLabel(group.showName, {
    seasons: listSeasons(group),
    year: group.year,
    contentType: group.contentType,
  });
}

function describeGroup(group: ShowGroup): string {
  const seasons = listSeasons(group).length;
  const eps = group.episodes.length;
  if (seasons <= 1) return `${eps} ép.`;
  return `${seasons} saisons · ${eps} ép.`;
}

function formatStatsSummary(stats: Awaited<ReturnType<CatalogStore["stats"]>>): string {
  return (
    `📦 <b>${stats.totalFiles}</b> fichiers · ` +
    `🎬 ${stats.films} · 📺 ${stats.series} · 🎌 ${stats.animes}`
  );
}

function formatStatsText(stats: Awaited<ReturnType<CatalogStore["stats"]>>): string {
  return (
    `📊 <b>Catalogue BenStream</b>\n\n` +
    `🎬 Films : <b>${stats.films}</b>\n` +
    `📺 Séries : <b>${stats.series}</b> · ${stats.seasons} saison(s) · ${stats.episodes} ép.\n` +
    `🎌 Animés : <b>${stats.animes}</b>\n` +
    `——————\nTotal fichiers : <b>${stats.totalFiles}</b>`
  );
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
  const messageId = cb.message?.message_id;

  if (!chatId) {
    await telegram.answerCallbackQuery(cb.id, "Session expirée");
    return;
  }

  if (data === "noop") {
    await telegram.answerCallbackQuery(cb.id);
    return;
  }

  if (data === "menu") {
    await telegram.answerCallbackQuery(cb.id);
    const stats = await catalog.stats();
    if (messageId) {
      await telegram.editMessageText(
        chatId,
        messageId,
        `${HELP_TEXT}\n\n${formatStatsSummary(stats)}`,
        { parse_mode: "HTML", reply_markup: mainMenuKeyboard() }
      );
    } else {
      await sendMainMenu(telegram, catalog, chatId);
    }
    return;
  }

  if (data === "stats") {
    await telegram.answerCallbackQuery(cb.id);
    const stats = await catalog.stats();
    const text = formatStatsText(stats);
    if (messageId) {
      await telegram.editMessageText(chatId, messageId, text, {
        parse_mode: "HTML",
        reply_markup: mainMenuKeyboard(),
      });
    } else {
      await telegram.sendMessage(chatId, text, {
        parse_mode: "HTML",
        reply_markup: mainMenuKeyboard(),
      });
    }
    return;
  }

  if (data.startsWith("cat:")) {
    const [, category, pageRaw] = data.split(":");
    const page = Number(pageRaw || 0);
    if (!["film", "serie", "anime", "recent"].includes(category)) {
      await telegram.answerCallbackQuery(cb.id, "Catégorie inconnue", true);
      return;
    }
    await telegram.answerCallbackQuery(cb.id);
    await sendBrowsePage(
      telegram,
      catalog,
      chatId,
      category as ContentType | "recent",
      page,
      messageId ? { messageId } : false
    );
    return;
  }

  if (data.startsWith("show:")) {
    const [, key, pageRaw] = data.split(":");
    const page = Number(pageRaw || 0);
    const group = await catalog.findShowByKey(key);
    if (!group) {
      await telegram.answerCallbackQuery(cb.id, "Série introuvable", true);
      return;
    }
    await telegram.answerCallbackQuery(cb.id);
    await sendShowPage(
      telegram,
      chatId,
      group,
      page,
      messageId ? { messageId } : false
    );
    return;
  }

  if (data.startsWith("sea:")) {
    const [, key, seasonRaw] = data.split(":");
    const season = Number(seasonRaw);
    const group = await catalog.findShowByKey(key);
    if (!group || !Number.isFinite(season)) {
      await telegram.answerCallbackQuery(cb.id, "Saison introuvable", true);
      return;
    }

    const seasonEps = group.episodes
      .filter((ep) => (ep.season ?? 1) === season)
      .sort((a, b) => (a.episode ?? 0) - (b.episode ?? 0));

    if (!seasonEps.length) {
      await telegram.answerCallbackQuery(cb.id, "Aucun épisode", true);
      return;
    }

    await telegram.answerCallbackQuery(
      cb.id,
      `Envoi saison ${season} (${seasonEps.length} ép.)…`
    );

    await telegram.sendMessage(
      chatId,
      `📦 Envoi de <b>${escapeHtml(group.showName)}</b> — saison ${season} (${seasonEps.length} épisodes)…`,
      { parse_mode: "HTML" }
    );

    let sent = 0;
    let failed = 0;
    let purged = 0;
    for (const item of seasonEps) {
      try {
        await telegram.copyMessage(chatId, config.channelId, item.messageId);
        sent += 1;
      } catch (error) {
        failed += 1;
        console.error("season send error", item.messageId, error);
        if (isMissingMediaError(error)) {
          await catalog.remove(item.messageId);
          purged += 1;
        }
      }
    }

    await telegram.sendMessage(
      chatId,
      `✅ Saison ${season} : <b>${sent}</b> envoyé(s)` +
        (failed ? ` · ❌ ${failed} échec(s)` : "") +
        (purged ? ` · 🗑 ${purged} retiré(s) du catalogue` : "") +
        `\nBon visionnage 🍿`,
      { parse_mode: "HTML" }
    );
    return;
  }

  if (!data.startsWith("get:")) {
    await telegram.answerCallbackQuery(cb.id, "Action inconnue");
    return;
  }

  const getId = Number(data.slice(4));
  if (!Number.isFinite(getId)) {
    await telegram.answerCallbackQuery(cb.id, "ID invalide", true);
    return;
  }

  const item = await catalog.get(getId);
  if (!item) {
    await telegram.answerCallbackQuery(cb.id, "Introuvable dans le catalogue", true);
    return;
  }

  await telegram.answerCallbackQuery(cb.id, "Envoi en cours…");

  try {
    await telegram.copyMessage(chatId, config.channelId, item.messageId);
    await telegram.sendMessage(
      chatId,
      `✅ ${contentTypeEmoji(item.contentType)} <b>${escapeHtml(item.displayTitle)}</b>\nBon visionnage 🍿`,
      { parse_mode: "HTML" }
    );
  } catch (error) {
    const detail = error instanceof Error ? error.message : "erreur inconnue";
    let purgedNote = "";
    if (isMissingMediaError(error)) {
      await catalog.remove(item.messageId);
      purgedNote = "\n🗑 Entrée retirée du catalogue (média absent du canal).";
    }
    await telegram.sendMessage(
      chatId,
      `❌ Impossible d'envoyer ce média.\n<code>${escapeHtml(detail)}</code>${purgedNote}`,
      { parse_mode: "HTML" }
    );
  }
}

function isMissingMediaError(error: unknown): boolean {
  const detail = error instanceof Error ? error.message.toLowerCase() : "";
  return (
    detail.includes("message to copy not found") ||
    detail.includes("message not found") ||
    detail.includes("msg_id is invalid") ||
    detail.includes("MESSAGE_ID_INVALID".toLowerCase())
  );
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
