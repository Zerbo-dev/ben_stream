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
  channelJoinUrl,
  RequiredChannelStore,
  type RequiredChannel,
} from "../required-channels.js";
import {
  formatUserLabel,
  UserStore,
} from "../users.js";
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
/channels — canaux obligatoires
/channel_add @canal — ajouter
/users — utilisateurs
/broadcast &lt;texte&gt; — message à tous
/purge — supprimer
/reparse — recalculer le catalogue
/stats — détails`;

type BotDeps = {
  telegram: TelegramClient;
  catalog: CatalogStore;
  users: UserStore;
  channels: RequiredChannelStore;
  config: AppConfig;
};

export async function handleUpdate(
  update: TelegramUpdate,
  deps: BotDeps
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
  deps: BotDeps
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
  deps: BotDeps
): Promise<void> {
  const { telegram, catalog, users, channels, config } = deps;
  const chatId = message.chat.id;
  const userId = message.from?.id;
  const text = (message.text || "").trim();

  await users.touch(message.from, chatId);

  if (isForwardFromChannel(message, config.channelId)) {
    await handleAdminForward(message, deps);
    return;
  }

  const admin = isAdmin(userId, config.adminIds);

  // Admin : forward d'un autre canal → proposition d'ajout obligatoire
  if (admin && isForwardFromAnyChannel(message)) {
    await offerRequiredChannelFromForward(message, deps);
    return;
  }

  if (!text) {
    if (!admin && userId) {
      const missing = await findMissingChannels(telegram, channels, userId);
      if (missing.length) {
        await sendJoinGate(telegram, chatId, missing);
        return;
      }
    }
    await telegram.sendMessage(chatId, "Envoie un titre.");
    return;
  }

  const command = text.split(/\s+/)[0].replace(/@\w+$/, "").toLowerCase();

  if (command === "/channels" || command === "/channel") {
    if (!admin) {
      await telegram.sendMessage(chatId, "Réservé aux admins.");
      return;
    }
    await sendChannelsAdmin(telegram, channels, chatId);
    return;
  }

  if (command === "/channel_add" || command === "/addchannel") {
    if (!admin) {
      await telegram.sendMessage(chatId, "Réservé aux admins.");
      return;
    }
    const ref = text.replace(/^\/(?:channel_add|addchannel)(@\w+)?\s*/i, "").trim();
    if (!ref) {
      await telegram.sendMessage(
        chatId,
        "Usage :\n<code>/channel_add @moncanal</code>\nou forward un message du canal ici.",
        { parse_mode: "HTML" }
      );
      return;
    }
    await addRequiredChannelByRef(telegram, channels, chatId, ref);
    return;
  }

  if (command === "/channel_del" || command === "/delchannel") {
    if (!admin) {
      await telegram.sendMessage(chatId, "Réservé aux admins.");
      return;
    }
    const ref = text.replace(/^\/(?:channel_del|delchannel)(@\w+)?\s*/i, "").trim();
    if (!ref) {
      await sendChannelsAdmin(telegram, channels, chatId);
      return;
    }
    await removeRequiredChannelByRef(telegram, channels, chatId, ref);
    return;
  }

  // Gate d'accès : sauf admins
  if (!admin && userId) {
    const missing = await findMissingChannels(telegram, channels, userId);
    if (missing.length) {
      await sendJoinGate(telegram, chatId, missing);
      return;
    }
  }

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
    const userCount = admin ? await users.count() : 0;
    await telegram.sendMessage(chatId, formatStatsText(stats, admin, userCount), {
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

  if (command === "/users") {
    if (!admin) {
      await telegram.sendMessage(chatId, "Réservé aux admins.");
      return;
    }
    await sendUsersList(telegram, users, chatId);
    return;
  }

  if (command === "/broadcast") {
    if (!admin) {
      await telegram.sendMessage(chatId, "Réservé aux admins.");
      return;
    }
    const payload = text.replace(/^\/broadcast(@\w+)?\s*/i, "").trim();
    if (!payload) {
      await telegram.sendMessage(chatId, "Usage : /broadcast <message>");
      return;
    }
    await runBroadcast(telegram, users, chatId, payload);
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
  deps: BotDeps
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
  admin = false,
  userCount = 0
): string {
  if (!admin) {
    return `🎬 ${stats.films} · 📺 ${stats.series} · 🎌 ${stats.animes}`;
  }
  return (
    `📊 <b>Catalogue</b>\n` +
    `🎬 ${stats.films} · 📺 ${stats.series} · 🎌 ${stats.animes}\n` +
    `${stats.seasons} saisons · ${stats.episodes} ép. · ${stats.totalFiles} fichiers\n` +
    `👤 ${userCount} utilisateur(s)`
  );
}

function truncateButton(title: string): string {
  return title.length > 54 ? `${title.slice(0, 53)}…` : title;
}

function formatRelativeTime(ts: number): string {
  const diff = Math.max(0, Date.now() - ts);
  const mins = Math.floor(diff / 60_000);
  if (mins < 1) return "à l'instant";
  if (mins < 60) return `il y a ${mins} min`;
  const hours = Math.floor(mins / 60);
  if (hours < 48) return `il y a ${hours} h`;
  const days = Math.floor(hours / 24);
  return `il y a ${days} j`;
}

async function sendUsersList(
  telegram: TelegramClient,
  users: UserStore,
  chatId: number
): Promise<void> {
  const total = await users.count();
  const list = await users.list(40);
  if (!list.length) {
    await telegram.sendMessage(
      chatId,
      "Aucun utilisateur enregistré pour l’instant.\nIls apparaissent dès qu’ils écrivent au bot."
    );
    return;
  }

  const lines = list.map((user, i) => {
    const label = escapeHtml(formatUserLabel(user));
    return `${i + 1}. ${label}\n<code>${user.id}</code> · ${formatRelativeTime(user.lastSeenAt)}`;
  });

  await telegram.sendMessage(
    chatId,
    `👤 <b>${total}</b> utilisateur(s)\n\n${lines.join("\n\n")}` +
      (total > list.length ? `\n\n… et ${total - list.length} de plus` : ""),
    { parse_mode: "HTML" }
  );
}

async function runBroadcast(
  telegram: TelegramClient,
  users: UserStore,
  adminChatId: number,
  text: string
): Promise<void> {
  const all = await users.all();
  if (!all.length) {
    await telegram.sendMessage(adminChatId, "Aucun utilisateur à contacter.");
    return;
  }

  await telegram.sendMessage(
    adminChatId,
    `📣 Envoi à ${all.length} utilisateur(s)…`
  );

  let ok = 0;
  let fail = 0;
  let blocked = 0;

  for (const user of all) {
    try {
      await telegram.sendMessage(user.chatId, text, {
        disable_web_page_preview: true,
      });
      ok += 1;
    } catch (error) {
      fail += 1;
      if (isBlockedUserError(error)) {
        blocked += 1;
        await users.markBlocked(user.id);
      } else {
        console.error("broadcast error", user.id, error);
      }
    }
    await sleep(45);
  }

  await telegram.sendMessage(
    adminChatId,
    `📣 Terminé : <b>${ok}</b> ok` +
      (fail ? ` · ${fail} échec` : "") +
      (blocked ? ` · ${blocked} bloqué` : ""),
    { parse_mode: "HTML" }
  );
}

function isBlockedUserError(error: unknown): boolean {
  const detail = error instanceof Error ? error.message.toLowerCase() : "";
  return (
    detail.includes("bot was blocked by the user") ||
    detail.includes("user is deactivated") ||
    detail.includes("chat not found") ||
    detail.includes("forbidden: bot can't initiate conversation")
  );
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function handleCallback(
  update: TelegramUpdate,
  deps: BotDeps
): Promise<void> {
  const { telegram, catalog, users, channels, config } = deps;
  const cb = update.callback_query!;
  const data = cb.data || "";
  const chatId = cb.message?.chat.id;
  const messageId = cb.message?.message_id;

  if (!chatId) {
    await telegram.answerCallbackQuery(cb.id, "Session expirée");
    return;
  }

  await users.touch(cb.from, chatId);

  const admin = isAdmin(cb.from?.id, config.adminIds);

  if (data === "noop") {
    await telegram.answerCallbackQuery(cb.id);
    return;
  }

  if (data === "check_join") {
    const missing = await findMissingChannels(telegram, channels, cb.from.id);
    if (missing.length) {
      await telegram.answerCallbackQuery(cb.id, "Pas encore membre partout", true);
      await sendJoinGate(telegram, chatId, missing, messageId);
      return;
    }
    await telegram.answerCallbackQuery(cb.id, "Accès OK ✅");
    await sendMainMenu(
      telegram,
      catalog,
      chatId,
      admin,
      messageId ? { messageId } : false
    );
    return;
  }

  if (data.startsWith("chdel:")) {
    if (!admin) {
      await telegram.answerCallbackQuery(cb.id, "Réservé aux admins", true);
      return;
    }
    const targetId = data.slice(6);
    const removed = await channels.remove(targetId);
    await telegram.answerCallbackQuery(
      cb.id,
      removed ? `Retiré : ${removed.title}` : "Déjà absent"
    );
    await sendChannelsAdmin(telegram, channels, chatId, messageId);
    return;
  }

  if (data.startsWith("chadd:")) {
    if (!admin) {
      await telegram.answerCallbackQuery(cb.id, "Réservé aux admins", true);
      return;
    }
    const targetId = data.slice(6);
    await telegram.answerCallbackQuery(cb.id);
    await addRequiredChannelByRef(telegram, channels, chatId, targetId);
    return;
  }

  // Gate pour les users normaux (admins bypass)
  if (!admin) {
    const missing = await findMissingChannels(telegram, channels, cb.from.id);
    if (missing.length) {
      await telegram.answerCallbackQuery(cb.id, "Rejoins les canaux d'abord", true);
      await sendJoinGate(telegram, chatId, missing, messageId);
      return;
    }
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
    const userCount = admin ? await users.count() : 0;
    const text = formatStatsText(stats, admin, userCount);
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

function isForwardFromAnyChannel(message: TelegramMessage): boolean {
  const origin = message.forward_from_chat ?? message.forward_origin?.chat;
  if (!origin) return false;
  return origin.type === "channel" || origin.type === "supergroup";
}

function isMemberStatus(status: string): boolean {
  return (
    status === "creator" ||
    status === "administrator" ||
    status === "member" ||
    status === "restricted"
  );
}

async function findMissingChannels(
  telegram: TelegramClient,
  store: RequiredChannelStore,
  userId: number
): Promise<RequiredChannel[]> {
  const required = await store.list();
  if (!required.length) return [];

  const missing: RequiredChannel[] = [];
  for (const channel of required) {
    try {
      const member = await telegram.getChatMember(channel.chatId, userId);
      if (!isMemberStatus(member.status)) missing.push(channel);
    } catch (error) {
      console.error("getChatMember error", channel.chatId, error);
      // En cas d'erreur API (bot pas admin, etc.), on bloque pour forcer la config correcte
      missing.push(channel);
    }
  }
  return missing;
}

async function sendJoinGate(
  telegram: TelegramClient,
  chatId: number,
  missing: RequiredChannel[],
  editMessageId?: number
): Promise<void> {
  const lines = missing.map(
    (c, i) => `${i + 1}. <b>${escapeHtml(c.title)}</b>`
  );
  const rows: { text: string; url?: string; callback_data?: string }[][] =
    missing.map((c) => {
      const url = channelJoinUrl(c);
      if (url) {
        return [{ text: `➕ ${c.title}`.slice(0, 64), url }];
      }
      return [{ text: c.title.slice(0, 64), callback_data: "noop" }];
    });
  rows.push([{ text: "✅ J'ai rejoint", callback_data: "check_join" }]);

  const text =
    `🔒 <b>Accès réservé</b>\n` +
    `Rejoins ${missing.length > 1 ? "ces canaux" : "ce canal"} pour utiliser le bot :\n\n` +
    lines.join("\n");

  const markup = { inline_keyboard: rows };
  if (editMessageId) {
    try {
      await telegram.editMessageText(chatId, editMessageId, text, {
        parse_mode: "HTML",
        reply_markup: markup,
      });
      return;
    } catch {
      // fallback send
    }
  }
  await telegram.sendMessage(chatId, text, {
    parse_mode: "HTML",
    reply_markup: markup,
  });
}

async function sendChannelsAdmin(
  telegram: TelegramClient,
  store: RequiredChannelStore,
  chatId: number,
  editMessageId?: number
): Promise<void> {
  const list = await store.list();
  const text =
    list.length === 0
      ? `🔐 <b>Canaux obligatoires</b>\nAucun pour l’instant.\n\nAjoute avec <code>/channel_add @canal</code>\nou forward un message du canal.`
      : `🔐 <b>Canaux obligatoires</b> (${list.length})\nLes users doivent tous les rejoindre.\n\n` +
        list
          .map((c) => {
            const handle = c.username ? ` @${c.username}` : "";
            return `• <b>${escapeHtml(c.title)}</b>${handle}\n<code>${c.chatId}</code>`;
          })
          .join("\n\n");

  const rows = list.map((c) => [
    {
      text: `🗑 ${c.title}`.slice(0, 64),
      callback_data: `chdel:${c.chatId}`,
    },
  ]);
  rows.push([{ text: "🏠 Menu", callback_data: "menu" }]);
  const markup = { inline_keyboard: rows };

  if (editMessageId) {
    try {
      await telegram.editMessageText(chatId, editMessageId, text, {
        parse_mode: "HTML",
        reply_markup: markup,
      });
      return;
    } catch {
      // fallback
    }
  }
  await telegram.sendMessage(chatId, text, {
    parse_mode: "HTML",
    reply_markup: markup,
  });
}

async function resolveChannelRef(
  telegram: TelegramClient,
  ref: string
): Promise<RequiredChannel> {
  const cleaned = ref.trim().replace(/^https?:\/\/t\.me\//i, "@");
  const chat = await telegram.getChat(cleaned);
  if (chat.type !== "channel" && chat.type !== "supergroup") {
    throw new Error("Ce chat n’est pas un canal/groupe.");
  }

  let url: string | undefined;
  if (chat.username) {
    url = `https://t.me/${chat.username}`;
  } else if (chat.invite_link) {
    url = chat.invite_link;
  } else {
    try {
      const invite = await telegram.createChatInviteLink(chat.id, {
        name: "BenStream",
      });
      url = invite.invite_link;
    } catch {
      // Pas grave : le bouton join sera sans URL
    }
  }

  // Vérifie que le bot peut lire les membres
  const me = await telegram.getMe();
  const self = await telegram.getChatMember(chat.id, me.id);
  if (self.status !== "administrator" && self.status !== "creator") {
    throw new Error(
      "Ajoute le bot comme admin du canal (droit de voir les membres)."
    );
  }

  return {
    chatId: String(chat.id),
    title: chat.title || cleaned,
    username: chat.username,
    url,
    addedAt: Date.now(),
  };
}

async function addRequiredChannelByRef(
  telegram: TelegramClient,
  store: RequiredChannelStore,
  chatId: number,
  ref: string
): Promise<void> {
  try {
    const channel = await resolveChannelRef(telegram, ref);
    await store.add(channel);
    await telegram.sendMessage(
      chatId,
      `✅ Canal obligatoire : <b>${escapeHtml(channel.title)}</b>\n<code>${channel.chatId}</code>`,
      { parse_mode: "HTML" }
    );
    await sendChannelsAdmin(telegram, store, chatId);
  } catch (error) {
    const detail = error instanceof Error ? error.message : "erreur inconnue";
    await telegram.sendMessage(
      chatId,
      `❌ Impossible d’ajouter ce canal.\n<code>${escapeHtml(detail)}</code>`,
      { parse_mode: "HTML" }
    );
  }
}

async function removeRequiredChannelByRef(
  telegram: TelegramClient,
  store: RequiredChannelStore,
  chatId: number,
  ref: string
): Promise<void> {
  const list = await store.list();
  const needle = ref.replace(/^@/, "").toLowerCase();
  const match = list.find(
    (c) =>
      c.chatId === ref ||
      c.username?.toLowerCase() === needle ||
      c.title.toLowerCase() === needle
  );
  if (!match) {
    await telegram.sendMessage(chatId, "Canal introuvable dans la liste.");
    await sendChannelsAdmin(telegram, store, chatId);
    return;
  }
  await store.remove(match.chatId);
  await telegram.sendMessage(
    chatId,
    `🗑 Retiré : <b>${escapeHtml(match.title)}</b>`,
    { parse_mode: "HTML" }
  );
  await sendChannelsAdmin(telegram, store, chatId);
}

async function offerRequiredChannelFromForward(
  message: TelegramMessage,
  deps: BotDeps
): Promise<void> {
  const { telegram, channels } = deps;
  const chatId = message.chat.id;
  const origin = message.forward_from_chat ?? message.forward_origin?.chat;
  if (!origin) {
    await telegram.sendMessage(chatId, "Impossible de lire le canal d’origine.");
    return;
  }

  const title = origin.title || String(origin.id);
  await telegram.sendMessage(
    chatId,
    `Canal détecté : <b>${escapeHtml(title)}</b>\n<code>${origin.id}</code>\nL’ajouter comme canal obligatoire ?`,
    {
      parse_mode: "HTML",
      reply_markup: {
        inline_keyboard: [
          [
            {
              text: "✅ Oui, l’exiger",
              callback_data: `chadd:${origin.id}`,
            },
          ],
          [{ text: "Non", callback_data: "noop" }],
        ],
      },
    }
  );
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
