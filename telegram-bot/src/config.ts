function required(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) {
    throw new Error(`Variable d'environnement manquante: ${name}`);
  }
  return value;
}

export function getConfig() {
  return {
    botToken: required("BOT_TOKEN"),
    channelId: required("CHANNEL_ID"),
    webhookSecret: process.env.WEBHOOK_SECRET?.trim() || "",
    adminIds: (process.env.ADMIN_IDS || "")
      .split(",")
      .map((id) => id.trim())
      .filter(Boolean)
      .map((id) => Number(id))
      .filter((id) => Number.isFinite(id)),
    publicUrl: process.env.PUBLIC_URL?.replace(/\/$/, "") || "",
    upstashUrl: required("UPSTASH_REDIS_REST_URL"),
    upstashToken: required("UPSTASH_REDIS_REST_TOKEN"),
  };
}

export type AppConfig = ReturnType<typeof getConfig>;

export function isAdmin(userId: number | undefined, adminIds: number[]): boolean {
  if (!userId) return false;
  return adminIds.includes(userId);
}
