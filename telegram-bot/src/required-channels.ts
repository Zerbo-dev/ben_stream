import { Redis } from "@upstash/redis";

const CHANNELS_KEY = "vod:required_channels";
const CHANNEL_PREFIX = "vod:reqchan:";

export interface RequiredChannel {
  /** Telegram chat id, e.g. "-100123..." */
  chatId: string;
  title: string;
  username?: string;
  /** Lien public ou invite si dispo */
  url?: string;
  addedAt: number;
}

export class RequiredChannelStore {
  constructor(private readonly redis: Redis) {}

  static fromEnv(url: string, token: string): RequiredChannelStore {
    return new RequiredChannelStore(new Redis({ url, token }));
  }

  private key(chatId: string): string {
    return `${CHANNEL_PREFIX}${chatId}`;
  }

  async list(): Promise<RequiredChannel[]> {
    const ids = await this.redis.smembers(CHANNELS_KEY);
    if (!ids.length) return [];

    const channels: RequiredChannel[] = [];
    const chunkSize = 50;
    for (let i = 0; i < ids.length; i += chunkSize) {
      const chunk = ids.slice(i, i + chunkSize);
      const keys = chunk.map((id) => this.key(String(id)));
      const part = await this.redis.mget<RequiredChannel[]>(...keys);
      for (const channel of part || []) {
        if (channel) channels.push(channel);
      }
    }

    return channels.sort((a, b) => a.title.localeCompare(b.title, "fr"));
  }

  async add(channel: RequiredChannel): Promise<void> {
    await this.redis.set(this.key(channel.chatId), channel);
    await this.redis.sadd(CHANNELS_KEY, channel.chatId);
  }

  async remove(chatId: string): Promise<RequiredChannel | null> {
    const existing = await this.redis.get<RequiredChannel>(this.key(chatId));
    await this.redis.del(this.key(chatId));
    await this.redis.srem(CHANNELS_KEY, chatId);
    return existing;
  }

  async count(): Promise<number> {
    return await this.redis.scard(CHANNELS_KEY);
  }
}

export function channelJoinUrl(channel: RequiredChannel): string | undefined {
  if (channel.url) return channel.url;
  if (channel.username) return `https://t.me/${channel.username}`;
  return undefined;
}
