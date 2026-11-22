/**
 * ============================================================================
 * 【学習ガイド】interactions.ts — Discord からのリクエストを受け取り応答を返す
 * ============================================================================
 *
 * ■ このファイルの役割とデータの流れ
 *   [Discord サーバー]
 *        │  POST /interactions
 *        │  Headers: X-Signature-Ed25519, X-Signature-Timestamp
 *        │  Body: Interaction JSON（生テキストで受け取る必要あり）
 *        ▼
 *   1. Ed25519 署名検証＋タイムスタンプ鮮度検証（`verifyDiscordSignature`）
 *        ├─ 不正・ヘッダ欠落・古いタイムスタンプ → 即座に HTTP 401 Unauthorized を返す
 *        └─ 正常 → JSON をパースして type で分岐
 *        │
 *        ├── type: 1 (PING)
 *        │     └─► 即座に `{ type: 1 }` (PONG) を返す（Discord の生存確認）
 *        │
 *        └── type: 2 (APPLICATION_COMMAND)
 *              ├─ 許可サーバー検証（`ALLOWED_GUILD_IDS` 設定時は許可外サーバー／DM を拒否）
 *              ├─ /guide [topic] ─► ナレッジから即時検索 → `{ type: 4, data: { content } }`
 *              ├─ /word <term>   ─► 文字数チェック → 用語集から即時検索 → `{ type: 4 }`
 *              └─ /ask <question>
 *                    ├─► 空文字／文字数上限超過なら即座にエラー返答（API は呼ばない）
 *                    ├─► 即座に `{ type: 5 }` (Deferred Response: 「考え中…」表示) を返す
 *                    └─► `c.executionCtx.waitUntil(...)` で非同期に RAG を実行:
 *                          (a) 質問を RETRIEVAL_QUERY でベクトル化
 *                          (b) Vectorize + D1 から上位 3〜5 チャンクを取得
 *                          (c) Gemini で回答生成＋出典見出しを付与
 *                          (d) Discord Webhook PATCH（`allowed_mentions: { parse: [] }`）で元メッセージ更新
 *
 * ■ なぜ `/ask` だけ Deferred Response (`type: 5`) を使うのか？
 *   Discord は「3 秒以内に最初の HTTP レスポンスを返すこと」を必須としています。
 *   Embedding + Vectorize + D1 + Gemini 生成は数秒かかる場合があるため、
 *   先に「考え中… (`type: 5`)」を返して 3 秒ルールを満たしつつ、
 *   Cloudflare Workers の `c.executionCtx.waitUntil(...)` を使って
 *   レスポンス返却後もバックグラウンド処理を安全に完了させます。
 * ============================================================================
 */

import { Hono } from "hono";
import type { AppEnv } from "../types/env.js";
import {
  MAX_ASK_QUESTION_LENGTH,
  MAX_WORD_TERM_LENGTH,
} from "../discord/commands.js";
import {
  INTERACTION_RESPONSE_FLAGS,
  INTERACTION_RESPONSE_TYPE,
  INTERACTION_TYPE,
  getStringOption,
  isDiscordInteraction,
  type DiscordInteraction,
} from "../discord/types.js";
import { verifyDiscordSignature } from "../discord/verify.js";
import { buildGuideReply, buildWordReply } from "../knowledge/catalog.js";
import {
  DEFAULT_GEMINI_MODEL,
  createGeminiTextGenerator,
  generateRagAnswer,
  type TextGenerator,
} from "../rag/answer.js";
import { createGeminiEmbedder } from "../rag/embedder.js";
import {
  DEFAULT_MIN_SCORE,
  DEFAULT_TOP_K,
  createCloudflareRetriever,
  type ChunkRetriever,
} from "../rag/retriever.js";

const DISCORD_API_BASE = "https://discord.com/api/v10";

/** `@everyone` / `@here` やユーザーメンションの誤爆を完全に防ぐ設定 */
const NO_MENTIONS = {
  parse: [] as readonly string[],
} as const;

export interface InteractionsDependencies {
  /** テスト時に Retriever を差し替えるためのファクトリ（未指定なら Cloudflare 本番構成を使用） */
  readonly createRetriever?: (env: AppEnv) => ChunkRetriever | null;
  /** テスト時に LLM 生成器を差し替えるためのファクトリ */
  readonly createGenerator?: (env: AppEnv) => TextGenerator | null;
  /** Discord Webhook PATCH 用の fetch 実装（テスト時にモック可能） */
  readonly fetchImpl?: typeof fetch;
  /** 署名タイムスタンプ鮮度検証に使う現在時刻取得関数（テスト時に差し替え可能） */
  readonly now?: () => number;
}

/**
 * カンマ区切りの `ALLOWED_GUILD_IDS` 環境変数をパースして Set に変換する。
 * 未設定・空文字の場合は null（サーバー制限無効）を返す。
 */
export function parseAllowedGuildIds(
  raw: string | undefined,
): ReadonlySet<string> | null {
  if (raw === undefined) {
    return null;
  }
  const ids = raw
    .split(",")
    .map((id) => id.trim())
    .filter((id) => id.length > 0);
  return ids.length > 0 ? new Set(ids) : null;
}

/**
 * Discord の Deferred 応答（`@original`）を最終回答テキストで上書き更新する。
 */
async function editOriginalInteractionResponse(params: {
  readonly applicationId: string;
  readonly interactionToken: string;
  readonly content: string;
  readonly fetchImpl: typeof fetch;
}): Promise<void> {
  const { applicationId, interactionToken, content, fetchImpl } = params;
  const url = `${DISCORD_API_BASE}/webhooks/${encodeURIComponent(applicationId)}/${encodeURIComponent(interactionToken)}/messages/@original`;

  const response = await fetchImpl(url, {
    method: "PATCH",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      content,
      allowed_mentions: NO_MENTIONS,
    }),
  });

  if (!response.ok) {
    const errorText = await response.text().catch(() => "");
    console.error(
      JSON.stringify({
        message: "Discord original response update failed",
        status: response.status,
        detail: errorText.slice(0, 300),
      }),
    );
  }
}

/**
 * 本番環境用の Retriever（Vectorize + D1 + Gemini Embedding）を組み立てる。
 */
function buildDefaultRetriever(env: AppEnv): ChunkRetriever | null {
  if (
    env.VECTORIZE === undefined ||
    env.DB === undefined ||
    env.GEMINI_API_KEY === undefined ||
    env.GEMINI_API_KEY.trim().length === 0
  ) {
    return null;
  }

  const embedder = createGeminiEmbedder({
    apiKey: env.GEMINI_API_KEY,
  });

  return createCloudflareRetriever({
    vectorize: env.VECTORIZE,
    db: env.DB,
    embedder,
  });
}

/**
 * 本番環境用の TextGenerator（Gemini）を組み立てる。
 */
function buildDefaultGenerator(env: AppEnv): TextGenerator | null {
  if (
    env.GEMINI_API_KEY === undefined ||
    env.GEMINI_API_KEY.trim().length === 0
  ) {
    return null;
  }

  return createGeminiTextGenerator({
    apiKey: env.GEMINI_API_KEY,
    model: env.GEMINI_MODEL ?? DEFAULT_GEMINI_MODEL,
  });
}

/**
 * `/ask` のバックグラウンド処理: RAG 検索 → Gemini 回答生成 → Discord 元メッセージ更新。
 */
async function processAskInBackground(params: {
  readonly interaction: DiscordInteraction;
  readonly question: string;
  readonly env: AppEnv;
  readonly deps: InteractionsDependencies;
}): Promise<void> {
  const { interaction, question, env, deps } = params;
  const fetchImpl = deps.fetchImpl ?? fetch;
  const applicationId =
    interaction.application_id ?? env.DISCORD_APPLICATION_ID ?? "";
  const interactionToken = interaction.token ?? "";

  if (applicationId.length === 0 || interactionToken.length === 0) {
    console.error(
      JSON.stringify({
        message: "Missing application_id or interaction token for deferred reply",
      }),
    );
    return;
  }

  try {
    const retriever = deps.createRetriever
      ? deps.createRetriever(env)
      : buildDefaultRetriever(env);
    const generator = deps.createGenerator
      ? deps.createGenerator(env)
      : buildDefaultGenerator(env);

    if (retriever === null || generator === null) {
      await editOriginalInteractionResponse({
        applicationId,
        interactionToken,
        content:
          "RAG 検索の環境設定（GEMINI_API_KEY / Vectorize / D1）が未完了のため回答できませんでした。管理者にお問い合わせください。",
        fetchImpl,
      });
      return;
    }

    const retrievedChunks = await retriever.retrieve(question, {
      topK: DEFAULT_TOP_K,
      minScore: DEFAULT_MIN_SCORE,
    });

    const result = await generateRagAnswer({
      question,
      retrievedChunks,
      generator,
    });

    await editOriginalInteractionResponse({
      applicationId,
      interactionToken,
      content: result.answer,
      fetchImpl,
    });
  } catch (error) {
    console.error(
      JSON.stringify({
        message: "Failed to process /ask interaction",
        error: error instanceof Error ? error.message : String(error),
      }),
    );

    await editOriginalInteractionResponse({
      applicationId,
      interactionToken,
      content:
        "回答の生成中にエラーが発生しました。少し時間をおいてからもう一度お試しください。",
      fetchImpl,
    });
  }
}

/**
 * Discord Interactions 用 Hono サブルーターを生成する。
 */
export function createInteractionsRoute(
  deps: InteractionsDependencies = {},
): Hono<{ Bindings: AppEnv }> {
  const route = new Hono<{ Bindings: AppEnv }>();

  route.post("/", async (c) => {
    const publicKey = c.env.DISCORD_PUBLIC_KEY;
    if (publicKey === undefined || publicKey.trim().length === 0) {
      console.error(
        JSON.stringify({ message: "DISCORD_PUBLIC_KEY is not configured" }),
      );
      return c.text("Discord public key is not configured", 500);
    }

    // 署名検証には JSON パース前の生ボディ文字列が必須
    const rawBody = await c.req.text();
    const signatureHex = c.req.header("X-Signature-Ed25519") ?? null;
    const timestamp = c.req.header("X-Signature-Timestamp") ?? null;

    const isValid = await verifyDiscordSignature({
      publicKeyHex: publicKey,
      signatureHex,
      timestamp,
      rawBody,
      nowMs: deps.now ? deps.now() : Date.now(),
    });

    if (!isValid) {
      return c.text("Invalid request signature", 401);
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(rawBody);
    } catch {
      return c.text("Invalid JSON payload", 400);
    }

    if (!isDiscordInteraction(parsed)) {
      return c.text("Invalid Discord interaction payload", 400);
    }

    // 1. PING → PONG（Discord Developer Portal でのエンドポイント登録検証）
    if (parsed.type === INTERACTION_TYPE.PING) {
      return c.json({ type: INTERACTION_RESPONSE_TYPE.PONG });
    }

    // 2. スラッシュコマンド（APPLICATION_COMMAND）
    if (parsed.type === INTERACTION_TYPE.APPLICATION_COMMAND) {
      // 許可サーバー制限（ALLOWED_GUILD_IDS が設定されている場合のみ適用）
      const allowedGuildIds = parseAllowedGuildIds(c.env.ALLOWED_GUILD_IDS);
      if (
        allowedGuildIds !== null &&
        (parsed.guild_id === undefined || !allowedGuildIds.has(parsed.guild_id))
      ) {
        return c.json({
          type: INTERACTION_RESPONSE_TYPE.CHANNEL_MESSAGE_WITH_SOURCE,
          data: {
            content: "この Bot は許可されたサーバー内でのみ利用できます。",
            flags: INTERACTION_RESPONSE_FLAGS.EPHEMERAL,
            allowed_mentions: NO_MENTIONS,
          },
        });
      }

      const commandName = parsed.data?.name;

      if (commandName === "ask") {
        const question = getStringOption(parsed, "question")?.trim() ?? "";
        if (question.length === 0) {
          return c.json({
            type: INTERACTION_RESPONSE_TYPE.CHANNEL_MESSAGE_WITH_SOURCE,
            data: {
              content:
                "質問内容を入力してください（例: `/ask question:ダマスカス鋼は使っていい？`）。",
              flags: INTERACTION_RESPONSE_FLAGS.EPHEMERAL,
              allowed_mentions: NO_MENTIONS,
            },
          });
        }

        if (question.length > MAX_ASK_QUESTION_LENGTH) {
          return c.json({
            type: INTERACTION_RESPONSE_TYPE.CHANNEL_MESSAGE_WITH_SOURCE,
            data: {
              content: `質問は ${String(MAX_ASK_QUESTION_LENGTH)} 文字以内で入力してください（現在 ${String(question.length)} 文字）。`,
              flags: INTERACTION_RESPONSE_FLAGS.EPHEMERAL,
              allowed_mentions: NO_MENTIONS,
            },
          });
        }

        // 先に Deferred Response (type: 5) を返し、バックグラウンドで RAG を実行する
        c.executionCtx.waitUntil(
          processAskInBackground({
            interaction: parsed,
            question,
            env: c.env,
            deps,
          }),
        );

        return c.json({
          type: INTERACTION_RESPONSE_TYPE.DEFERRED_CHANNEL_MESSAGE_WITH_SOURCE,
        });
      }

      if (commandName === "guide") {
        const topic = getStringOption(parsed, "topic");
        return c.json({
          type: INTERACTION_RESPONSE_TYPE.CHANNEL_MESSAGE_WITH_SOURCE,
          data: {
            content: buildGuideReply(topic),
            allowed_mentions: NO_MENTIONS,
          },
        });
      }

      if (commandName === "word") {
        const term = (getStringOption(parsed, "term") ?? "").trim();
        if (term.length > MAX_WORD_TERM_LENGTH) {
          return c.json({
            type: INTERACTION_RESPONSE_TYPE.CHANNEL_MESSAGE_WITH_SOURCE,
            data: {
              content: `用語は ${String(MAX_WORD_TERM_LENGTH)} 文字以内で入力してください（現在 ${String(term.length)} 文字）。`,
              flags: INTERACTION_RESPONSE_FLAGS.EPHEMERAL,
              allowed_mentions: NO_MENTIONS,
            },
          });
        }
        return c.json({
          type: INTERACTION_RESPONSE_TYPE.CHANNEL_MESSAGE_WITH_SOURCE,
          data: {
            content: buildWordReply(term),
            allowed_mentions: NO_MENTIONS,
          },
        });
      }

      return c.json({
        type: INTERACTION_RESPONSE_TYPE.CHANNEL_MESSAGE_WITH_SOURCE,
        data: {
          content: `未対応のコマンドです: \`/${commandName ?? "unknown"}\``,
          flags: INTERACTION_RESPONSE_FLAGS.EPHEMERAL,
          allowed_mentions: NO_MENTIONS,
        },
      });
    }

    return c.text("Unsupported interaction type", 400);
  });

  return route;
}
