import type { VercelRequest, VercelResponse } from "@vercel/node";
import { getConfig, isAdmin } from "../src/config.js";
import { TelegramClient } from "../src/telegram.js";

/**
 * GET /api/setup?admin_id=123
 * Enregistre le webhook Telegram vers https://.../api/webhook
 *
 * Sécurité : WEBHOOK_SECRET ou ADMIN_IDS requis via query.
 */
export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== "GET" && req.method !== "POST") {
    res.status(405).json({ ok: false, error: "Method Not Allowed" });
    return;
  }

  try {
    const config = getConfig();
    const telegram = new TelegramClient(config.botToken);

    const secret = String(req.query.secret || req.headers["x-setup-secret"] || "");
    const adminId = Number(req.query.admin_id || 0);

    const authorized =
      (config.webhookSecret && secret === config.webhookSecret) ||
      (adminId && isAdmin(adminId, config.adminIds));

    if (!authorized) {
      res.status(401).json({
        ok: false,
        error: "Non autorisé. Passe ?secret=WEBHOOK_SECRET ou ?admin_id=TON_ID",
      });
      return;
    }

    if (!config.publicUrl) {
      res.status(400).json({
        ok: false,
        error: "PUBLIC_URL manquant dans les variables d'environnement",
      });
      return;
    }

    const webhookUrl = `${config.publicUrl}/api/webhook`;
    await telegram.setWebhook(webhookUrl, config.webhookSecret || undefined);
    const me = await telegram.getMe();
    const info = await telegram.getWebhookInfo();

    res.status(200).json({
      ok: true,
      bot: me.username,
      webhookUrl,
      info,
    });
  } catch (error) {
    console.error("setup error", error);
    res.status(500).json({
      ok: false,
      error: error instanceof Error ? error.message : "unknown error",
    });
  }
}
