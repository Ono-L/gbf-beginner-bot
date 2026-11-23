import type { ExecutionContext as HonoExecutionContext } from "hono";
import { describe, expect, it, vi } from "vitest";
import { createApp } from "../src/index.js";
import {
  MAX_ASK_QUESTION_LENGTH,
  MAX_WORD_TERM_LENGTH,
} from "../src/discord/commands.js";
import {
  INTERACTION_RESPONSE_FLAGS,
  INTERACTION_RESPONSE_TYPE,
  INTERACTION_TYPE,
} from "../src/discord/types.js";
import { DEFAULT_MAX_TIMESTAMP_AGE_SECONDS } from "../src/discord/verify.js";
import type { AppEnv } from "../src/types/env.js";

/** テスト全体で共有する固定基準時刻（Unix 秒: 1700000000） */
const FIXED_NOW_SEC = 1_700_000_000;
const FIXED_NOW_MS = FIXED_NOW_SEC * 1000;

function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

/**
 * テスト用の本物の Ed25519 鍵ペアを生成し、署名付きリクエストを作るヘルパー。
 */
async function createTestKeyPair(): Promise<{
  publicKeyHex: string;
  sign: (timestamp: string, rawBody: string) => Promise<string>;
}> {
  const keyPair = (await crypto.subtle.generateKey(
    { name: "Ed25519" },
    true,
    ["sign", "verify"],
  )) as CryptoKeyPair;

  const exportedKey = await crypto.subtle.exportKey("raw", keyPair.publicKey);
  if (!(exportedKey instanceof ArrayBuffer)) {
    throw new Error("Ed25519 公開鍵の raw エクスポートに失敗しました");
  }
  const rawPublicKey = new Uint8Array(exportedKey);

  return {
    publicKeyHex: bytesToHex(rawPublicKey),
    async sign(timestamp: string, rawBody: string): Promise<string> {
      const payload = new TextEncoder().encode(`${timestamp}${rawBody}`);
      const sigBuffer = await crypto.subtle.sign(
        "Ed25519",
        keyPair.privateKey,
        payload,
      );
      return bytesToHex(new Uint8Array(sigBuffer));
    },
  };
}

function createMockExecutionContext(): {
  ctx: HonoExecutionContext;
  waitForAll: () => Promise<void>;
} {
  const pending: Promise<unknown>[] = [];
  const ctx: HonoExecutionContext = {
    waitUntil(promise: Promise<unknown>) {
      pending.push(promise);
    },
    passThroughOnException() {
      // テスト用ダミー
    },
    props: {},
  };

  return {
    ctx,
    async waitForAll() {
      await Promise.all(pending);
    },
  };
}

describe("POST /interactions", () => {
  it("署名ヘッダ欠落や不正署名の場合は 401 を返す", async () => {
    const { publicKeyHex } = await createTestKeyPair();
    const app = createApp({ now: () => FIXED_NOW_MS });
    const env: AppEnv = { DISCORD_PUBLIC_KEY: publicKeyHex };
    const { ctx } = createMockExecutionContext();

    // 1. ヘッダ欠落
    const resMissing = await app.fetch(
      new Request("http://localhost/interactions", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ type: INTERACTION_TYPE.PING }),
      }),
      env,
      ctx,
    );
    expect(resMissing.status).toBe(401);

    // 2. 不正な署名（64バイト分のダミー hex）
    const resInvalid = await app.fetch(
      new Request("http://localhost/interactions", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Signature-Ed25519": "00".repeat(64),
          "X-Signature-Timestamp": String(FIXED_NOW_SEC),
        },
        body: JSON.stringify({ type: INTERACTION_TYPE.PING }),
      }),
      env,
      ctx,
    );
    expect(resInvalid.status).toBe(401);
  });

  it("署名が正しくてもタイムスタンプが古すぎる・未来すぎる・非数値の場合は 401 を返す", async () => {
    const { publicKeyHex, sign } = await createTestKeyPair();
    const app = createApp({ now: () => FIXED_NOW_MS });
    const env: AppEnv = { DISCORD_PUBLIC_KEY: publicKeyHex };
    const { ctx } = createMockExecutionContext();
    const body = JSON.stringify({ type: INTERACTION_TYPE.PING });

    const invalidTimestamps = [
      String(FIXED_NOW_SEC - DEFAULT_MAX_TIMESTAMP_AGE_SECONDS - 1),
      String(FIXED_NOW_SEC + DEFAULT_MAX_TIMESTAMP_AGE_SECONDS + 1),
      "not-a-number",
    ];

    for (const timestamp of invalidTimestamps) {
      const signature = await sign(timestamp, body);
      const res = await app.fetch(
        new Request("http://localhost/interactions", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "X-Signature-Ed25519": signature,
            "X-Signature-Timestamp": timestamp,
          },
          body,
        }),
        env,
        ctx,
      );
      expect(res.status).toBe(401);
    }
  });

  it("正常な署名の PING に対して PONG ({ type: 1 }) を返す", async () => {
    const { publicKeyHex, sign } = await createTestKeyPair();
    const app = createApp({ now: () => FIXED_NOW_MS });
    const env: AppEnv = {
      DISCORD_PUBLIC_KEY: publicKeyHex,
      // PING には guild_id がないため、ALLOWED_GUILD_IDS 設定時でも PONG が返ること
      ALLOWED_GUILD_IDS: "guild-allowed-1",
    };
    const { ctx } = createMockExecutionContext();

    const body = JSON.stringify({ type: INTERACTION_TYPE.PING });
    const timestamp = String(FIXED_NOW_SEC + 1);
    const signature = await sign(timestamp, body);

    const res = await app.fetch(
      new Request("http://localhost/interactions", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Signature-Ed25519": signature,
          "X-Signature-Timestamp": timestamp,
        },
        body,
      }),
      env,
      ctx,
    );

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ type: INTERACTION_RESPONSE_TYPE.PONG });
  });

  it("/guide と /word はナレッジから即時応答 (type: 4, デフォルト非公開・メンション無効) を返す", async () => {
    const { publicKeyHex, sign } = await createTestKeyPair();
    const app = createApp({ now: () => FIXED_NOW_MS });
    const env: AppEnv = { DISCORD_PUBLIC_KEY: publicKeyHex };
    const { ctx } = createMockExecutionContext();

    // /guide (topic=shero)
    const guideBody = JSON.stringify({
      type: INTERACTION_TYPE.APPLICATION_COMMAND,
      data: {
        name: "guide",
        options: [{ name: "topic", type: 3, value: "shero" }],
      },
    });
    const guideTs = String(FIXED_NOW_SEC + 2);
    const guideRes = await app.fetch(
      new Request("http://localhost/interactions", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Signature-Ed25519": await sign(guideTs, guideBody),
          "X-Signature-Timestamp": guideTs,
        },
        body: guideBody,
      }),
      env,
      ctx,
    );
    expect(guideRes.status).toBe(200);
    const guideJson = (await guideRes.json()) as {
      type: number;
      data: { content: string; flags?: number; allowed_mentions: { parse: string[] } };
    };
    expect(guideJson.type).toBe(INTERACTION_RESPONSE_TYPE.CHANNEL_MESSAGE_WITH_SOURCE);
    expect(guideJson.data.content).toContain("シェロカルテの特別訓練");
    expect(guideJson.data.flags).toBe(INTERACTION_RESPONSE_FLAGS.EPHEMERAL);
    expect(guideJson.data.allowed_mentions).toEqual({ parse: [] });

    // /word (term=古戦場)
    const wordBody = JSON.stringify({
      type: INTERACTION_TYPE.APPLICATION_COMMAND,
      data: {
        name: "word",
        options: [{ name: "term", type: 3, value: "古戦場" }],
      },
    });
    const wordTs = String(FIXED_NOW_SEC + 3);
    const wordRes = await app.fetch(
      new Request("http://localhost/interactions", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Signature-Ed25519": await sign(wordTs, wordBody),
          "X-Signature-Timestamp": wordTs,
        },
        body: wordBody,
      }),
      env,
      ctx,
    );
    expect(wordRes.status).toBe(200);
    const wordJson = (await wordRes.json()) as {
      type: number;
      data: { content: string; flags?: number; allowed_mentions: { parse: string[] } };
    };
    expect(wordJson.type).toBe(INTERACTION_RESPONSE_TYPE.CHANNEL_MESSAGE_WITH_SOURCE);
    expect(wordJson.data.content).toContain("決戦！星の古戦場");
    expect(wordJson.data.flags).toBe(INTERACTION_RESPONSE_FLAGS.EPHEMERAL);
    expect(wordJson.data.allowed_mentions).toEqual({ parse: [] });
  });

  it("/ask は即座にデフォルト非公開の Deferred (type: 5) を返し、waitUntil で RAG 回答をメンション無効の Webhook PATCH で更新する", async () => {
    const { publicKeyHex, sign } = await createTestKeyPair();
    const webhookFetch = vi.fn<typeof fetch>(async () => {
      return new Response(JSON.stringify({ id: "msg-1" }), { status: 200 });
    });

    const app = createApp({
      now: () => FIXED_NOW_MS,
      createRetriever: () => ({
        retrieve: vi.fn(async () => [
          {
            score: 0.92,
            chunk: {
              id: "02_items_and_gacha__s03_c01",
              sourceFile: "02_items_and_gacha.md",
              heading: "ガチャと天井（300連）の基本ルール",
              chunkIndex: 0,
              content: "300連（宝晶石90,000個）で好きな対象と交換できます。",
              charCount: 30,
            },
          },
        ]),
      }),
      createGenerator: () => ({
        generate: vi.fn(
          async () => "ガチャの天井は同一期間内に300連（宝晶石90,000個相当）です。",
        ),
      }),
      fetchImpl: webhookFetch,
    });

    const env: AppEnv = {
      DISCORD_PUBLIC_KEY: publicKeyHex,
      ALLOWED_GUILD_IDS: "guild-allowed-1, guild-allowed-2",
    };
    const { ctx, waitForAll } = createMockExecutionContext();

    const askBody = JSON.stringify({
      type: INTERACTION_TYPE.APPLICATION_COMMAND,
      application_id: "app-12345",
      guild_id: "guild-allowed-2",
      token: "interaction-token-xyz",
      data: {
        name: "ask",
        options: [{ name: "question", type: 3, value: "天井って何連ですか？" }],
      },
    });
    const ts = String(FIXED_NOW_SEC + 4);
    const res = await app.fetch(
      new Request("http://localhost/interactions", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Signature-Ed25519": await sign(ts, askBody),
          "X-Signature-Timestamp": ts,
        },
        body: askBody,
      }),
      env,
      ctx,
    );

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      type: INTERACTION_RESPONSE_TYPE.DEFERRED_CHANNEL_MESSAGE_WITH_SOURCE,
      data: {
        flags: INTERACTION_RESPONSE_FLAGS.EPHEMERAL,
      },
    });

    // waitUntil に登録された非同期処理の完了を待機
    await waitForAll();

    expect(webhookFetch).toHaveBeenCalledTimes(1);
    const [calledUrl, calledInit] = webhookFetch.mock.calls[0] ?? [];
    expect(calledUrl).toBe(
      "https://discord.com/api/v10/webhooks/app-12345/interaction-token-xyz/messages/@original",
    );
    expect(calledInit?.method).toBe("PATCH");
    const sentPayload = JSON.parse(String(calledInit?.body)) as {
      content: string;
      allowed_mentions: { parse: string[] };
    };
    expect(sentPayload.content).toContain("300連");
    expect(sentPayload.content).toContain("ガチャと天井（300連）の基本ルール");
    expect(sentPayload.allowed_mentions).toEqual({ parse: [] });
  });

  it("public: true を指定したときは /ask・/guide・/word いずれもチャンネル公開応答（flags なし）になる", async () => {
    const { publicKeyHex, sign } = await createTestKeyPair();
    const webhookFetch = vi.fn<typeof fetch>(async () => {
      return new Response(JSON.stringify({ id: "msg-pub" }), { status: 200 });
    });
    const app = createApp({
      now: () => FIXED_NOW_MS,
      createRetriever: () => ({ retrieve: vi.fn(async () => []) }),
      createGenerator: () => ({ generate: vi.fn(async () => "dummy") }),
      fetchImpl: webhookFetch,
    });
    const env: AppEnv = { DISCORD_PUBLIC_KEY: publicKeyHex };
    const { ctx, waitForAll } = createMockExecutionContext();

    // /guide (public=true)
    const guideBody = JSON.stringify({
      type: INTERACTION_TYPE.APPLICATION_COMMAND,
      data: {
        name: "guide",
        options: [
          { name: "topic", type: 3, value: "shero" },
          { name: "public", type: 5, value: true },
        ],
      },
    });
    const guideTs = String(FIXED_NOW_SEC + 10);
    const guideRes = await app.fetch(
      new Request("http://localhost/interactions", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Signature-Ed25519": await sign(guideTs, guideBody),
          "X-Signature-Timestamp": guideTs,
        },
        body: guideBody,
      }),
      env,
      ctx,
    );
    const guideJson = (await guideRes.json()) as {
      type: number;
      data: { content: string; flags?: number };
    };
    expect(guideJson.data.flags).toBeUndefined();

    // /word (public=true)
    const wordBody = JSON.stringify({
      type: INTERACTION_TYPE.APPLICATION_COMMAND,
      data: {
        name: "word",
        options: [
          { name: "term", type: 3, value: "古戦場" },
          { name: "public", type: 5, value: true },
        ],
      },
    });
    const wordTs = String(FIXED_NOW_SEC + 11);
    const wordRes = await app.fetch(
      new Request("http://localhost/interactions", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Signature-Ed25519": await sign(wordTs, wordBody),
          "X-Signature-Timestamp": wordTs,
        },
        body: wordBody,
      }),
      env,
      ctx,
    );
    const wordJson = (await wordRes.json()) as {
      type: number;
      data: { content: string; flags?: number };
    };
    expect(wordJson.data.flags).toBeUndefined();

    // /ask (public=true)
    const askBody = JSON.stringify({
      type: INTERACTION_TYPE.APPLICATION_COMMAND,
      application_id: "app-12345",
      token: "tok-pub",
      data: {
        name: "ask",
        options: [
          { name: "question", type: 3, value: "天井は何連？" },
          { name: "public", type: 5, value: true },
        ],
      },
    });
    const askTs = String(FIXED_NOW_SEC + 12);
    const askRes = await app.fetch(
      new Request("http://localhost/interactions", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Signature-Ed25519": await sign(askTs, askBody),
          "X-Signature-Timestamp": askTs,
        },
        body: askBody,
      }),
      env,
      ctx,
    );
    expect(await askRes.json()).toEqual({
      type: INTERACTION_RESPONSE_TYPE.DEFERRED_CHANNEL_MESSAGE_WITH_SOURCE,
    });

    await waitForAll();
  });

  it("ALLOWED_GUILD_IDS が設定されている場合、未許可サーバーや DM からの実行は RAG を呼ばずに拒否する", async () => {
    const { publicKeyHex, sign } = await createTestKeyPair();
    const retrieveMock = vi.fn(async () => []);
    const generateMock = vi.fn(async () => "dummy");
    const app = createApp({
      now: () => FIXED_NOW_MS,
      createRetriever: () => ({ retrieve: retrieveMock }),
      createGenerator: () => ({ generate: generateMock }),
    });
    const env: AppEnv = {
      DISCORD_PUBLIC_KEY: publicKeyHex,
      ALLOWED_GUILD_IDS: "guild-allowed-1",
    };
    const { ctx, waitForAll } = createMockExecutionContext();

    const rejectedPayloads = [
      // 未許可サーバー
      JSON.stringify({
        type: INTERACTION_TYPE.APPLICATION_COMMAND,
        guild_id: "guild-unknown-999",
        data: {
          name: "ask",
          options: [{ name: "question", type: 3, value: "天井は何連？" }],
        },
      }),
      // DM（guild_id なし）
      JSON.stringify({
        type: INTERACTION_TYPE.APPLICATION_COMMAND,
        data: {
          name: "guide",
        },
      }),
    ];

    for (const body of rejectedPayloads) {
      const ts = String(FIXED_NOW_SEC + 5);
      const res = await app.fetch(
        new Request("http://localhost/interactions", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "X-Signature-Ed25519": await sign(ts, body),
            "X-Signature-Timestamp": ts,
          },
          body,
        }),
        env,
        ctx,
      );

      expect(res.status).toBe(200);
      const json = (await res.json()) as {
        type: number;
        data: {
          content: string;
          flags: number;
          allowed_mentions: { parse: string[] };
        };
      };
      expect(json.type).toBe(INTERACTION_RESPONSE_TYPE.CHANNEL_MESSAGE_WITH_SOURCE);
      expect(json.data.flags).toBe(INTERACTION_RESPONSE_FLAGS.EPHEMERAL);
      expect(json.data.content).toContain("許可されたサーバー");
      expect(json.data.allowed_mentions).toEqual({ parse: [] });
    }

    await waitForAll();
    expect(retrieveMock).not.toHaveBeenCalled();
    expect(generateMock).not.toHaveBeenCalled();
  });

  it("/ask と /word で文字数上限を超えた入力はバックグラウンド処理せず即時エラーを返す", async () => {
    const { publicKeyHex, sign } = await createTestKeyPair();
    const retrieveMock = vi.fn(async () => []);
    const generateMock = vi.fn(async () => "dummy");
    const app = createApp({
      now: () => FIXED_NOW_MS,
      createRetriever: () => ({ retrieve: retrieveMock }),
      createGenerator: () => ({ generate: generateMock }),
    });
    const env: AppEnv = { DISCORD_PUBLIC_KEY: publicKeyHex };
    const { ctx, waitForAll } = createMockExecutionContext();

    // /ask: 上限 + 1 文字
    const longAskBody = JSON.stringify({
      type: INTERACTION_TYPE.APPLICATION_COMMAND,
      application_id: "app-12345",
      token: "tok",
      data: {
        name: "ask",
        options: [
          {
            name: "question",
            type: 3,
            value: "あ".repeat(MAX_ASK_QUESTION_LENGTH + 1),
          },
        ],
      },
    });
    const askTs = String(FIXED_NOW_SEC + 6);
    const askRes = await app.fetch(
      new Request("http://localhost/interactions", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Signature-Ed25519": await sign(askTs, longAskBody),
          "X-Signature-Timestamp": askTs,
        },
        body: longAskBody,
      }),
      env,
      ctx,
    );
    expect(askRes.status).toBe(200);
    const askJson = (await askRes.json()) as {
      type: number;
      data: {
        content: string;
        flags: number;
        allowed_mentions: { parse: string[] };
      };
    };
    expect(askJson.type).toBe(INTERACTION_RESPONSE_TYPE.CHANNEL_MESSAGE_WITH_SOURCE);
    expect(askJson.data.flags).toBe(INTERACTION_RESPONSE_FLAGS.EPHEMERAL);
    expect(askJson.data.content).toContain(`${String(MAX_ASK_QUESTION_LENGTH)} 文字以内`);
    expect(askJson.data.allowed_mentions).toEqual({ parse: [] });

    // /word: 上限 + 1 文字
    const longWordBody = JSON.stringify({
      type: INTERACTION_TYPE.APPLICATION_COMMAND,
      data: {
        name: "word",
        options: [
          {
            name: "term",
            type: 3,
            value: "い".repeat(MAX_WORD_TERM_LENGTH + 1),
          },
        ],
      },
    });
    const wordTs = String(FIXED_NOW_SEC + 7);
    const wordRes = await app.fetch(
      new Request("http://localhost/interactions", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Signature-Ed25519": await sign(wordTs, longWordBody),
          "X-Signature-Timestamp": wordTs,
        },
        body: longWordBody,
      }),
      env,
      ctx,
    );
    expect(wordRes.status).toBe(200);
    const wordJson = (await wordRes.json()) as {
      type: number;
      data: {
        content: string;
        flags: number;
        allowed_mentions: { parse: string[] };
      };
    };
    expect(wordJson.type).toBe(INTERACTION_RESPONSE_TYPE.CHANNEL_MESSAGE_WITH_SOURCE);
    expect(wordJson.data.flags).toBe(INTERACTION_RESPONSE_FLAGS.EPHEMERAL);
    expect(wordJson.data.content).toContain(`${String(MAX_WORD_TERM_LENGTH)} 文字以内`);
    expect(wordJson.data.allowed_mentions).toEqual({ parse: [] });

    await waitForAll();
    expect(retrieveMock).not.toHaveBeenCalled();
    expect(generateMock).not.toHaveBeenCalled();
  });
});
