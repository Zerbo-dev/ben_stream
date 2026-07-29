/**
 * Usage: BOT_TOKEN=... WEBHOOK_SECRET=... PUBLIC_URL=https://... npx tsx scripts/setup-webhook.ts
 */
import { TelegramClient } from "../src/telegram.js";

const token = process.env.BOT_TOKEN;
const publicUrl = process.env.PUBLIC_URL?.replace(/\/$/, "");
const secret = process.env.WEBHOOK_SECRET || "";

if (!token || !publicUrl) {
  console.error("BOT_TOKEN et PUBLIC_URL sont requis");
  process.exit(1);
}

const telegram = new TelegramClient(token);
const webhookUrl = `${publicUrl}/api/webhook`;

const ok = await telegram.setWebhook(webhookUrl, secret || undefined);
const info = await telegram.getWebhookInfo();
console.log({ ok, webhookUrl, info });
