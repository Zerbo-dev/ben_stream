import type { CatalogItem, MediaKind, TelegramMessage } from "../types.js";
import { extractTitleFromMessage, hydrateCatalogItem, normalizeTitle } from "../catalog.js";
import {
  contentTypeEmoji,
  formatEpisodeCode,
  parseVodMetadata,
} from "../vod.js";

export function isMediaMessage(message: TelegramMessage): boolean {
  return Boolean(
    message.video ||
      message.document ||
      message.audio ||
      message.animation ||
      (message.photo && message.photo.length > 0)
  );
}

export function detectKind(message: TelegramMessage): MediaKind {
  if (message.video) return "video";
  if (message.animation) return "animation";
  if (message.audio) return "audio";
  if (message.document) return "document";
  if (message.photo?.length) return "photo";
  return "other";
}

export function messageToCatalogItem(message: TelegramMessage): CatalogItem | null {
  if (!isMediaMessage(message)) {
    return null;
  }

  const fileName =
    message.video?.file_name ||
    message.document?.file_name ||
    message.audio?.file_name ||
    message.animation?.file_name ||
    message.audio?.title;

  const title = extractTitleFromMessage({
    caption: message.caption,
    text: message.text,
    fileName,
  });

  const meta = parseVodMetadata(title, fileName);

  return {
    messageId: message.message_id,
    title,
    normalizedTitle: normalizeTitle(meta.displayTitle || title),
    kind: detectKind(message),
    fileName,
    fileSize:
      message.video?.file_size ||
      message.document?.file_size ||
      message.audio?.file_size ||
      message.animation?.file_size,
    duration: message.video?.duration || message.audio?.duration || message.animation?.duration,
    mediaGroupId: message.media_group_id,
    caption: message.caption,
    indexedAt: Date.now(),
    ...meta,
  };
}

export function kindLabel(kind: MediaKind): string {
  switch (kind) {
    case "video":
      return "🎬";
    case "document":
      return "📁";
    case "audio":
      return "🎧";
    case "photo":
      return "🖼️";
    case "animation":
      return "✨";
    default:
      return "📦";
  }
}

export function formatBytes(bytes?: number): string {
  if (!bytes || bytes <= 0) return "";
  const units = ["o", "Ko", "Mo", "Go"];
  let size = bytes;
  let unit = 0;
  while (size >= 1024 && unit < units.length - 1) {
    size /= 1024;
    unit += 1;
  }
  return `${size.toFixed(unit === 0 ? 0 : 1)} ${units[unit]}`;
}

export function formatDuration(seconds?: number): string {
  if (!seconds || seconds <= 0) return "";
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = seconds % 60;
  if (h > 0) return `${h}h${String(m).padStart(2, "0")}`;
  return `${m}:${String(s).padStart(2, "0")}`;
}

export function formatItemLine(item: CatalogItem, index?: number): string {
  const hydrated = hydrateCatalogItem(item);
  const prefix = typeof index === "number" ? `${index}. ` : "";
  const ep = formatEpisodeCode(hydrated.season, hydrated.episode);
  const meta = [
    contentTypeEmoji(hydrated.contentType),
    ep || (hydrated.year ? String(hydrated.year) : ""),
    hydrated.quality,
    hydrated.language,
    formatDuration(hydrated.duration),
    formatBytes(hydrated.fileSize),
  ]
    .filter(Boolean)
    .join(" · ");

  return `${prefix}<b>${escapeHtml(hydrated.displayTitle || hydrated.title)}</b>${
    meta ? `\n   ${meta}` : ""
  }`;
}

export function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}
