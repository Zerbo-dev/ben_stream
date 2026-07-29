import type { VercelRequest, VercelResponse } from "@vercel/node";
import { CatalogStore } from "../src/catalog.js";
import { getConfig } from "../src/config.js";
import { handleUpdate } from "../src/handlers/bot.js";
import { RequiredChannelStore } from "../src/required-channels.js";
import { parseUpdate, TelegramClient } from "../src/telegram.js";
import { UserStore } from "../src/users.js";

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method === "GET") {
    res.status(200).json({ ok: true, service: "benstream-telegram-bot" });
    return;
  }

  if (req.method !== "POST") {
    res.status(405).json({ ok: false, error: "Method Not Allowed" });
    return;
  }

  try {
    const config = getConfig();

    if (config.webhookSecret) {
      const header = req.headers["x-telegram-bot-api-secret-token"];
      const token = Array.isArray(header) ? header[0] : header;
      if (token !== config.webhookSecret) {
        res.status(401).json({ ok: false, error: "Unauthorized" });
        return;
      }
    }

    const update = parseUpdate(req.body);
    const telegram = new TelegramClient(config.botToken);
    const catalog = CatalogStore.fromEnv(
      config.upstashUrl,
      config.upstashToken
    );
    const users = UserStore.fromEnv(config.upstashUrl, config.upstashToken);
    const channels = RequiredChannelStore.fromEnv(
      config.upstashUrl,
      config.upstashToken
    );

    // Telegram retente ~1/min si le webhook timeoute : on ignore les doublons.
    const claimed = await catalog.claimUpdate(update.update_id);
    if (!claimed) {
      res.status(200).json({ ok: true, duplicate: true });
      return;
    }

    await handleUpdate(update, { telegram, catalog, users, channels, config });
    res.status(200).json({ ok: true });
  } catch (error) {
    console.error("webhook error", error);
    // Toujours 200 pour éviter les retries agressifs de Telegram sur erreurs métier
    res.status(200).json({
      ok: false,
      error: error instanceof Error ? error.message : "unknown error",
    });
  }
}
