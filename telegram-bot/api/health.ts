import type { VercelRequest, VercelResponse } from "@vercel/node";
import { CatalogStore } from "../src/catalog.js";
import { getConfig } from "../src/config.js";

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== "GET") {
    res.status(405).json({ ok: false, error: "Method Not Allowed" });
    return;
  }

  try {
    const config = getConfig();
    const catalog = CatalogStore.fromEnv(config.upstashUrl, config.upstashToken);
    const count = await catalog.count();
    res.status(200).json({
      ok: true,
      service: "benstream-telegram-bot",
      catalogSize: count,
    });
  } catch (error) {
    res.status(500).json({
      ok: false,
      error: error instanceof Error ? error.message : "unknown error",
    });
  }
}
