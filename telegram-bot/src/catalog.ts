import { Redis } from "@upstash/redis";
import type { CatalogItem } from "./types.js";

const ITEM_PREFIX = "vod:item:";
const INDEX_KEY = "vod:index";

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
    return (await this.redis.get<CatalogItem>(this.itemKey(messageId))) ?? null;
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
      .sort((a, b) => b.indexedAt - a.indexedAt);
  }

  async search(query: string, limit = 20): Promise<CatalogItem[]> {
    const normalized = normalizeTitle(query);
    if (!normalized) return [];

    const tokens = normalized.split(" ").filter((t) => t.length > 1);
    const items = await this.getAll();

    const scored = items
      .map((item) => {
        const hay = item.normalizedTitle;
        let score = 0;
        if (hay === normalized) score += 100;
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

  async count(): Promise<number> {
    return await this.redis.scard(INDEX_KEY);
  }

  async recent(limit = 10): Promise<CatalogItem[]> {
    const items = await this.getAll();
    return items.slice(0, limit);
  }
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
    if (firstLine) return truncate(firstLine, 120);
  }

  const text = parts.text?.trim();
  if (text) {
    const firstLine = text.split("\n").map((l) => l.trim()).find(Boolean);
    if (firstLine) return truncate(firstLine, 120);
  }

  if (parts.fileName) {
    return truncate(stripExtension(parts.fileName), 120);
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
