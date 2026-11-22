/**
 * Cloudflare Workers + Hono エントリポイント。
 *
 * - `GET /`             : ヘルスチェック（稼働確認用 JSON）
 * - `POST /interactions`: Discord Interactions エンドポイント
 */

import { Hono } from "hono";
import type { AppEnv } from "./types/env.js";
import {
  createInteractionsRoute,
  type InteractionsDependencies,
} from "./routes/interactions.js";

export function createApp(
  deps: InteractionsDependencies = {},
): Hono<{ Bindings: AppEnv }> {
  const app = new Hono<{ Bindings: AppEnv }>();

  app.get("/", (c) => {
    return c.json({
      service: "gbf-beginner-bot",
      status: "ok",
      endpoints: {
        interactions: "/interactions",
      },
    });
  });

  app.route("/interactions", createInteractionsRoute(deps));

  app.onError((error, c) => {
    console.error(
      JSON.stringify({
        message: "Unhandled Worker error",
        path: c.req.path,
        error: error.message,
      }),
    );
    return c.json({ error: "Internal Server Error" }, 500);
  });

  return app;
}

const app = createApp();

export default app;
