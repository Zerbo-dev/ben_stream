import { Redis } from "@upstash/redis";
import type { TelegramUser } from "./types.js";

const USER_PREFIX = "vod:user:";
const USERS_KEY = "vod:users";

export interface BotUser {
  id: number;
  chatId: number;
  firstName?: string;
  username?: string;
  firstSeenAt: number;
  lastSeenAt: number;
  blocked?: boolean;
}

export class UserStore {
  constructor(private readonly redis: Redis) {}

  static fromEnv(url: string, token: string): UserStore {
    return new UserStore(new Redis({ url, token }));
  }

  private key(userId: number): string {
    return `${USER_PREFIX}${userId}`;
  }

  async touch(
    from: TelegramUser | undefined,
    chatId: number
  ): Promise<void> {
    if (!from?.id || from.is_bot) return;

    const now = Date.now();
    const existing = await this.redis.get<BotUser>(this.key(from.id));
    const user: BotUser = {
      id: from.id,
      chatId,
      firstName: from.first_name || existing?.firstName,
      username: from.username || existing?.username,
      firstSeenAt: existing?.firstSeenAt ?? now,
      lastSeenAt: now,
      blocked: false,
    };

    await this.redis.set(this.key(from.id), user);
    await this.redis.sadd(USERS_KEY, String(from.id));
  }

  async markBlocked(userId: number): Promise<void> {
    const existing = await this.redis.get<BotUser>(this.key(userId));
    if (!existing) return;
    await this.redis.set(this.key(userId), { ...existing, blocked: true });
  }

  async count(): Promise<number> {
    return await this.redis.scard(USERS_KEY);
  }

  async list(limit = 50): Promise<BotUser[]> {
    const ids = await this.redis.smembers(USERS_KEY);
    if (!ids.length) return [];

    const users: BotUser[] = [];
    const chunkSize = 100;
    for (let i = 0; i < ids.length; i += chunkSize) {
      const chunk = ids.slice(i, i + chunkSize);
      const keys = chunk.map((id) => this.key(Number(id)));
      const part = await this.redis.mget<BotUser[]>(...keys);
      for (const user of part || []) {
        if (user) users.push(user);
      }
    }

    return users
      .sort((a, b) => b.lastSeenAt - a.lastSeenAt)
      .slice(0, limit);
  }

  async all(): Promise<BotUser[]> {
    return this.list(10_000);
  }
}

export function formatUserLabel(user: BotUser): string {
  const name = user.firstName || "Sans nom";
  const handle = user.username ? ` @${user.username}` : "";
  const blocked = user.blocked ? " 🚫" : "";
  return `${name}${handle}${blocked}`;
}
