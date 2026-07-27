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

const WELCOME_TEXT = `🎬 <b>BenStream</b>
Envoie un titre, ou choisis ci-dessous.`;

const ADMIN_HELP = `🛠 <b>Admin</b>
/purge — supprimer
/reparse — recalculer le catalogue
/stats — détails`;

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
    // Succès silencieux — pas de spam admin à chaque post
  } catch (error) {
    const detail = error instanceof Error ? error.message : "erreur inconnue";
    console.error("channel index error", detail);
    await notifyAdmins(
      telegram,
      config.adminIds,
      `❌ Indexation : <b>${escapeHtml(item.title)}</b>\n<code>${escapeHtml(detail)}</code>`
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
    await telegram.sendMessage(chatId, "Envoie un titre.");
    return;
  }

  const command = text.split(/\s+/)[0].replace(/@\w+$/, "").toLowerCase();
  const admin = isAdmin(userId, config.adminIds);

  if (command === "/start" || command === "/menu") {
    await sendMainMenu(telegram, catalog, chatId, admin);
    return;
  }

  if (command === "/help") {
    await telegram.sendMessage(
      chatId,
      admin ? `${WELCOME_TEXT}\n\n${ADMIN_HELP}` : WELCOME_TEXT,
      { parse_mode: "HTML", reply_markup: mainMenuKeyboard() }
    );
    return;
  }

  if (command === "/stats") {
    const stats = await catalog.stats();
    await telegram.sendMessage(chatId, formatStatsText(stats, admin), {
      parse_mode: "HTML",
      reply_markup: mainMenuKeyboard(),
    });
    return;
  }

  if (command === "/recent") {
    await sendBrowsePage(telegram, catalog, chatId, "recent", 0, false, admin);
    return;
  }

  if (command === "/films" || command === "/film") {
    await sendBrowsePage(telegram, catalog, chatId, "film", 0, false, admin);
    return;
  }

  if (command === "/series" || command === "/serie") {
    await sendBrowsePage(telegram, catalog, chatId, "serie", 0, false, admin);
    return;
  }

  if (command === "/animes" || command === "/anime") {
    await sendBrowsePage(telegram, catalog, chatId, "anime", 0, false, admin);
    return;
  }

  if (command === "/purge") {
    if (!admin) {
      await telegram.sendMessage(chatId, "Réservé aux admins.");
      return;
    }
    const query = text.replace(/^\/purge(@\w+)?\s*/i, "").trim();
    await sendPurgePicker(telegram, catalog, chatId, query);
    return;
  }

  if (command === "/reparse") {
    if (!admin) {
      await telegram.sendMessage(chatId, "Réservé aux admins.");
      return;
    }
    const locked = await catalog.tryLockReparse(180);
    if (!locked) {
      await telegram.sendMessage(chatId, "Reparse déjà en cours — patiente un peu.");
      return;
    }
    try {
      await telegram.sendMessage(chatId, "🧠 Reparse…");
      const result = await catalog.reparseAll();
      const stats = await catalog.stats();
      await telegram.sendMessage(
        chatId,
        `✅ Reparse terminé.\n` +
          `Fichiers : <b>${result.total}</b> · Mis à jour : <b>${result.updated}</b>\n` +
          `🎬 ${stats.films} · 📺 ${stats.series} · 🎌 ${stats.animes}`,
        { parse_mode: "HTML" }
      );
    } catch (error) {
      const detail = error instanceof Error ? error.message : "erreur inconnue";
      console.error("reparse error", detail);
      await telegram.sendMessage(
        chatId,
        `❌ Reparse échoué : <code>${escapeHtml(detail)}</code>`,
        { parse_mode: "HTML" }
      );
    } finally {
      await catalog.unlockReparse();
    }
    return;
  }

  if (command === "/search") {
    const query = text.replace(/^\/search(@\w+)?\s*/i, "").trim();
    if (!query) {
      await telegram.sendMessage(chatId, "Usage : /search <titre>");
      return;
    }
    await runSearch(telegram, catalog, chatId, query, admin);
    return;
  }

  if (text.startsWith("/")) {
    await telegram.sendMessage(chatId, "Commande inconnue.", {
      reply_markup: mainMenuKeyboard(),
    });
    return;
  }

  await runSearch(telegram, catalog, chatId, text, admin);
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
    `✅ Indexé ${contentTypeEmoji(item.contentType)} <b>${escapeHtml(item.displayTitle)}</b>`,
    {
      parse_mode: "HTML",
      reply_markup: {
        inline_keyboard: [
          [{ text: "🗑 Retirer du catalogue", callback_data: `del:${item.messageId}` }],
        ],
      },
    }
  );
}

async function sendMainMenu(
  telegram: TelegramClient,
  catalog: CatalogStore,
  chatId: number,
  admin = false,
  edit: { messageId: number } | false = false
): Promise<void> {
  const stats = await catalog.stats();
  const text = admin
    ? `${WELCOME_TEXT}\n${formatStatsSummary(stats)}\n\n${ADMIN_HELP}`
    : `${WELCOME_TEXT}\n${formatStatsSummary(stats)}`;
  if (edit) {
    await telegram.editMessageText(chatId, edit.messageId, text, {
      parse_mode: "HTML",
      reply_markup: mainMenuKeyboard(),
    });
    return;
  }
  await telegram.sendMessage(chatId, text, {
    parse_mode: "HTML",
    reply_markup: mainMenuKeyboard(),
  });
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
  query: string,
  admin = false
): Promise<void> {
  const items = await catalog.search(query, 50);
  if (!items.length) {
    await telegram.sendMessage(
      chatId,
      `Rien pour « ${escapeHtml(query)} ».`,
      { parse_mode: "HTML", reply_markup: mainMenuKeyboard() }
    );
    return;
  }

  const groups = groupByShow(items);
  if (groups.length === 1 && groups[0].episodes.length > 1 && groups[0].contentType !== "film") {
    await sendShowPage(telegram, chatId, groups[0], 0, false, admin);
    return;
  }

  await sendGroupedResults(
    telegram,
    chatId,
    groups,
    `🔎 « ${escapeHtml(query)} »`,
    admin
  );
}

async function sendPurgePicker(
  telegram: TelegramClient,
  catalog: CatalogStore,
  chatId: number,
  query: string
): Promise<void> {
  const items = query
    ? await catalog.search(query, 20)
    : await catalog.recent(15);

  if (!items.length) {
    await telegram.sendMessage(
      chatId,
      query
        ? `Rien à purger pour « ${escapeHtml(query)} ».`
        : "Catalogue vide — rien à purger.",
      { parse_mode: "HTML" }
    );
    return;
  }

  const lines = items.map((item, i) => `${i + 1}. ${escapeHtml(item.displayTitle)}`);
  const rows = items.map((item) => [
    {
      text: `🗑 ${truncateButton(item.displayTitle)}`,
      callback_data: `del:${item.messageId}`,
    },
  ]);
  rows.push([{ text: "🏠 Menu", callback_data: "menu" }]);

  await telegram.sendMessage(
    chatId,
    `🗑 <b>Purge</b>${query ? ` · ${escapeHtml(query)}` : ""}\n\n${lines.join("\n")}`,
    {
      parse_mode: "HTML",
      reply_markup: { inline_keyboard: rows },
    }
  );
}

async function sendGroupedResults(
  telegram: TelegramClient,
  chatId: number,
  groups: ShowGroup[],
  title: string,
  admin = false
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
      const item = group.episodes[0];
      const row = [
        {
          text: `${contentTypeEmoji(group.contentType)} ${truncateButton(label)}`,
          callback_data: `get:${item.messageId}`,
        },
      ];
      if (admin) {
        row.push({ text: "🗑", callback_data: `del:${item.messageId}` });
      }
      return row;
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
    `${title}\n\n${lines.join("\n")}`,
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
  edit: { messageId: number } | false,
  admin = false
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
    const empty = "Catalogue vide.";
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
      const row = [
        {
          text: `${contentTypeEmoji(group.contentType)} ${truncateButton(label)}`,
          callback_data: `get:${group.episodes[0].messageId}`,
        },
      ];
      if (admin) {
        row.push({ text: "🗑", callback_data: `del:${group.episodes[0].messageId}` });
      }
      return row;
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

  const text = `<b>${heading}</b>\n\n${lines.join("\n")}`;

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
  edit: { messageId: number } | false,
  admin = false
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

  for (const season of seasons) {
    const count = episodes.filter((ep) => (ep.season ?? 1) === season).length;
    const seasonRow = [
      {
        text: `📦 S${season} · tout (${count})`,
        callback_data: `sea:${group.key}:${season}`,
      },
    ];
    if (admin) {
      seasonRow.push({
        text: `🗑 S${season}`,
        callback_data: `dsea:${group.key}:${season}`,
      });
    }
    rows.push(seasonRow);
  }

  for (const item of slice) {
    const ep = formatEpisodeCode(item.season, item.episode) || item.displayTitle;
    const row = [
      {
        text: `▶️ ${truncateButton(ep)}`,
        callback_data: `get:${item.messageId}`,
      },
    ];
    if (admin) {
      row.push({ text: "🗑", callback_data: `del:${item.messageId}` });
    }
    rows.push(row);
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
    `${episodes.length} ép.\n\n` +
    `${lines.join("\n")}`;

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
  return `🎬 ${stats.films} · 📺 ${stats.series} · 🎌 ${stats.animes}`;
}

function formatStatsText(
  stats: Awaited<ReturnType<CatalogStore["stats"]>>,
  admin = false
): string {
  if (!admin) {
    return `🎬 ${stats.films} · 📺 ${stats.series} · 🎌 ${stats.animes}`;
  }
  return (
    `📊 <b>Catalogue</b>\n` +
    `🎬 ${stats.films} · 📺 ${stats.series} · 🎌 ${stats.animes}\n` +
    `${stats.seasons} saisons · ${stats.episodes} ép. · ${stats.totalFiles} fichiers`
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

  const admin = isAdmin(cb.from?.id, config.adminIds);

  if (data === "noop") {
    await telegram.answerCallbackQuery(cb.id);
    return;
  }

  if (data === "menu") {
    await telegram.answerCallbackQuery(cb.id);
    await sendMainMenu(
      telegram,
      catalog,
      chatId,
      admin,
      messageId ? { messageId } : false
    );
    return;
  }

  if (data === "stats") {
    await telegram.answerCallbackQuery(cb.id);
    const stats = await catalog.stats();
    const text = formatStatsText(stats, admin);
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
      messageId ? { messageId } : false,
      admin
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
      messageId ? { messageId } : false,
      admin
    );
    return;
  }

  if (data.startsWith("del:")) {
    if (!admin) {
      await telegram.answerCallbackQuery(cb.id, "Réservé aux admins", true);
      return;
    }
    const delId = Number(data.slice(4));
    if (!Number.isFinite(delId)) {
      await telegram.answerCallbackQuery(cb.id, "Entrée invalide", true);
      return;
    }
    const existing = await catalog.get(delId);
    await catalog.remove(delId);
    await telegram.answerCallbackQuery(
      cb.id,
      existing ? `🗑 ${truncateButton(existing.displayTitle)}` : "Déjà absent"
    );
    return;
  }

  if (data.startsWith("dsea:")) {
    if (!admin) {
      await telegram.answerCallbackQuery(cb.id, "Réservé aux admins", true);
      return;
    }
    const [, key, seasonRaw] = data.split(":");
    const season = Number(seasonRaw);
    const group = await catalog.findShowByKey(key);
    if (!group || !Number.isFinite(season)) {
      await telegram.answerCallbackQuery(cb.id, "Saison introuvable", true);
      return;
    }
    const seasonEps = group.episodes.filter((ep) => (ep.season ?? 1) === season);
    for (const item of seasonEps) {
      await catalog.remove(item.messageId);
    }
    await telegram.answerCallbackQuery(cb.id, `Saison ${season} retirée`);
    const refreshed = await catalog.findShowByKey(key);
    if (refreshed && messageId) {
      await sendShowPage(telegram, chatId, refreshed, 0, { messageId }, admin);
    } else if (messageId) {
      await telegram.editMessageText(
        chatId,
        messageId,
        `🗑 <b>${escapeHtml(group.showName)}</b> — saison ${season} retirée du catalogue` +
          (!refreshed ? " (plus aucun épisode)." : "."),
        { parse_mode: "HTML", reply_markup: mainMenuKeyboard() }
      );
    } else {
      await telegram.sendMessage(
        chatId,
        `🗑 <b>${escapeHtml(group.showName)}</b> — saison ${season} : ${seasonEps.length} épisode(s) retiré(s).`,
        { parse_mode: "HTML" }
      );
    }
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
      `Saison ${season} · ${seasonEps.length} ép.`
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

    if (failed || purged) {
      await telegram.sendMessage(
        chatId,
        `Saison ${season} : ${sent} ok` +
          (failed ? ` · ${failed} échec` : "") +
          (purged ? ` · ${purged} retiré` : "")
      );
    }
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

  await telegram.answerCallbackQuery(cb.id);

  try {
    await telegram.copyMessage(chatId, config.channelId, item.messageId);
  } catch (error) {
    const detail = error instanceof Error ? error.message : "erreur inconnue";
    let purgedNote = "";
    if (isMissingMediaError(error)) {
      await catalog.remove(item.messageId);
      purgedNote = " (retiré du catalogue)";
    }
    await telegram.sendMessage(
      chatId,
      `❌ Envoi impossible${purgedNote}.`,
      { parse_mode: "HTML" }
    );
    console.error("send error", detail);
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
