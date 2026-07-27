import { Redis } from "@upstash/redis";
import type { CatalogItem, ContentType, ShowGroup } from "./types.js";
import { parseVodMetadata, showKey } from "./vod.js";

const ITEM_PREFIX = "vod:item:";
const INDEX_KEY = "vod:index";

export function hydrateCatalogItem(item: CatalogItem): CatalogItem {
  // Toujours re-parser caption/titre pour appliquer le nettoyage à jour
  const meta = parseVodMetadata(item.caption || item.title, item.fileName);
  return {
    ...item,
    ...meta,
    normalizedTitle: normalizeTitle(meta.displayTitle),
  };
}

export class CatalogStore {
  constructor(private readonly redis: Redis) {}

  static fromEnv(url: string, token: string): CatalogStore {
    return new CatalogStore(new Redis({ url, token }));
  }

  private itemKey(messageId: number): string {
    return `${ITEM_PREFIX}${messageId}`;
  }

  async upsert(item: CatalogItem): Promise<void> {
    const key = this.itemKey(item.messageId);
    await this.redis.set(key, item);
    await this.redis.sadd(INDEX_KEY, String(item.messageId));
  }

  async remove(messageId: number): Promise<void> {
    await this.redis.del(this.itemKey(messageId));
    await this.redis.srem(INDEX_KEY, String(messageId));
  }

  async get(messageId: number): Promise<CatalogItem | null> {
    const item = await this.redis.get<CatalogItem>(this.itemKey(messageId));
    return item ? hydrateCatalogItem(item) : null;
  }

  async getAll(): Promise<CatalogItem[]> {
    const ids = await this.redis.smembers(INDEX_KEY);
    if (!ids.length) return [];

    const keys = ids.map((id) => this.itemKey(Number(id)));
    const values: Array<CatalogItem | null> = [];

    const chunkSize = 100;
    for (let i = 0; i < keys.length; i += chunkSize) {
      const chunk = keys.slice(i, i + chunkSize);
      const part = await this.redis.mget<CatalogItem[]>(...chunk);
      values.push(...(part || []));
    }

    return values
      .filter((item): item is CatalogItem => item != null)
      .map(hydrateCatalogItem)
      .sort((a, b) => b.indexedAt - a.indexedAt);
  }

  async search(query: string, limit = 40): Promise<CatalogItem[]> {
    const normalized = normalizeTitle(query);
    if (!normalized) return [];

    const tokens = normalized.split(" ").filter((t) => t.length > 1);
    const items = await this.getAll();

    const scored = items
      .map((item) => {
        const hay = `${item.normalizedTitle} ${item.normalizedShowName}`;
        let score = 0;
        if (item.normalizedShowName === normalized) score += 120;
        if (item.normalizedTitle === normalized) score += 100;
        if (item.normalizedShowName.includes(normalized)) score += 70;
        if (hay.includes(normalized)) score += 50;
        for (const token of tokens) {
          if (hay.includes(token)) score += 10;
        }
        return { item, score };
      })
      .filter((entry) => entry.score > 0)
      .sort((a, b) => b.score - a.score || b.item.indexedAt - a.item.indexedAt);

    return scored.slice(0, limit).map((entry) => entry.item);
  }

  async byContentType(type: ContentType): Promise<CatalogItem[]> {
    const items = await this.getAll();
    return items.filter((item) => item.contentType === type);
  }

  async stats(): Promise<{
    totalFiles: number;
    films: number;
    series: number;
    animes: number;
    seasons: number;
    episodes: number;
  }> {
    const items = await this.getAll();
    const groups = groupByShow(items);

    const filmGroups = groups.filter((g) => g.contentType === "film");
    const serieGroups = groups.filter((g) => g.contentType === "serie");
    const animeGroups = groups.filter((g) => g.contentType === "anime");

    const seasonKeys = new Set<string>();
    let episodes = 0;
    for (const group of [...serieGroups, ...animeGroups]) {
      for (const ep of group.episodes) {
        episodes += 1;
        seasonKeys.add(`${group.key}:${ep.season ?? 1}`);
      }
    }

    return {
      totalFiles: items.length,
      films: filmGroups.length,
      series: serieGroups.length,
      animes: animeGroups.length,
      seasons: seasonKeys.size,
      episodes,
    };
  }

  async count(): Promise<number> {
    return await this.redis.scard(INDEX_KEY);
  }

  async recent(limit = 10): Promise<CatalogItem[]> {
    const items = await this.getAll();
    return items.slice(0, limit);
  }

  async findShowByKey(key: string): Promise<ShowGroup | null> {
    const items = await this.getAll();
    const groups = groupByShow(items);
    return groups.find((group) => group.key === key) || null;
  }

  async getAllRaw(): Promise<CatalogItem[]> {
    const ids = await this.redis.smembers(INDEX_KEY);
    if (!ids.length) return [];

    const keys = ids.map((id) => this.itemKey(Number(id)));
    const values: Array<CatalogItem | null> = [];

    const chunkSize = 100;
    for (let i = 0; i < keys.length; i += chunkSize) {
      const chunk = keys.slice(i, i + chunkSize);
      const part = await this.redis.mget<CatalogItem[]>(...chunk);
      values.push(...(part || []));
    }

    return values.filter((item): item is CatalogItem => item != null);
  }

  /** Ré-applique le parseur intelligent et persiste en Redis. */
  async reparseAll(): Promise<{ total: number; updated: number }> {
    const items = await this.getAllRaw();
    let updated = 0;
    for (const item of items) {
      const fresh = hydrateCatalogItem(item);
      await this.upsert(fresh);
      updated += 1;
    }
    return { total: items.length, updated };
  }
}

export function groupByShow(items: CatalogItem[]): ShowGroup[] {
  const map = new Map<string, ShowGroup>();

  for (const item of items) {
    const hydrated = hydrateCatalogItem(item);
    const key = showKey(hydrated.normalizedShowName || normalizeTitle(hydrated.title));
    const existing = map.get(key);
    if (!existing) {
      map.set(key, {
        key,
        showName: hydrated.showName || hydrated.title,
        normalizedShowName: hydrated.normalizedShowName,
        contentType: hydrated.contentType,
        year: hydrated.year,
        episodes: [hydrated],
      });
    } else {
      existing.episodes.push(hydrated);
      if (!existing.year && hydrated.year) existing.year = hydrated.year;
    }
  }

  for (const group of map.values()) {
    group.episodes.sort((a, b) => {
      const seasonDiff = (a.season ?? 1) - (b.season ?? 1);
      if (seasonDiff !== 0) return seasonDiff;
      const epDiff = (a.episode ?? 0) - (b.episode ?? 0);
      if (epDiff !== 0) return epDiff;
      return a.messageId - b.messageId;
    });
  }

  return [...map.values()].sort((a, b) =>
    a.showName.localeCompare(b.showName, "fr", { sensitivity: "base" })
  );
}

export function normalizeTitle(input: string): string {
  return input
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim()
    .replace(/\s+/g, " ");
}

export function extractTitleFromMessage(parts: {
  caption?: string;
  text?: string;
  fileName?: string;
}): string {
  const caption = parts.caption?.trim();
  if (caption) {
    const firstLine = caption.split("\n").map((l) => l.trim()).find(Boolean);
    if (firstLine) return truncate(firstLine, 160);
  }

  const text = parts.text?.trim();
  if (text) {
    const firstLine = text.split("\n").map((l) => l.trim()).find(Boolean);
    if (firstLine) return truncate(firstLine, 160);
  }

  if (parts.fileName) {
    return truncate(stripExtension(parts.fileName), 160);
  }

  return "Sans titre";
}

function stripExtension(fileName: string): string {
  return fileName.replace(/\.[a-z0-9]{1,5}$/i, "");
}

function truncate(value: string, max: number): string {
  if (value.length <= max) return value;
  return `${value.slice(0, max - 1)}…`;
}
