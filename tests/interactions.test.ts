import type { ExecutionContext as HonoExecutionContext } from "hono";
import { describe, expect, it, vi } from "vitest";
import { createApp } from "../src/index.js";
import {
  INTERACTION_RESPONSE_TYPE,
  INTERACTION_TYPE,
} from "../src/discord/types.js";
import type { AppEnv } from "../src/types/env.js";

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
    const app = createApp();
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
          "X-Signature-Timestamp": "1700000000",
        },
        body: JSON.stringify({ type: INTERACTION_TYPE.PING }),
      }),
      env,
      ctx,
    );
    expect(resInvalid.status).toBe(401);
  });

  it("正常な署名の PING に対して PONG ({ type: 1 }) を返す", async () => {
    const { publicKeyHex, sign } = await createTestKeyPair();
    const app = createApp();
    const env: AppEnv = { DISCORD_PUBLIC_KEY: publicKeyHex };
    const { ctx } = createMockExecutionContext();

    const body = JSON.stringify({ type: INTERACTION_TYPE.PING });
    const timestamp = "1700000001";
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

  it("/guide と /word はナレッジから即時応答 (type: 4) を返す", async () => {
    const { publicKeyHex, sign } = await createTestKeyPair();
    const app = createApp();
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
    const guideTs = "1700000002";
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
      data: { content: string };
    };
    expect(guideJson.type).toBe(INTERACTION_RESPONSE_TYPE.CHANNEL_MESSAGE_WITH_SOURCE);
    expect(guideJson.data.content).toContain("シェロカルテの特別訓練");

    // /word (term=古戦場)
    const wordBody = JSON.stringify({
      type: INTERACTION_TYPE.APPLICATION_COMMAND,
      data: {
        name: "word",
        options: [{ name: "term", type: 3, value: "古戦場" }],
      },
    });
    const wordTs = "1700000003";
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
      data: { content: string };
    };
    expect(wordJson.type).toBe(INTERACTION_RESPONSE_TYPE.CHANNEL_MESSAGE_WITH_SOURCE);
    expect(wordJson.data.content).toContain("決戦！星の古戦場");
  });

  it("/ask は即座に Deferred (type: 5) を返し、waitUntil で RAG 回答を Webhook PATCH で更新する", async () => {
    const { publicKeyHex, sign } = await createTestKeyPair();
    const webhookFetch = vi.fn<typeof fetch>(async () => {
      return new Response(JSON.stringify({ id: "msg-1" }), { status: 200 });
    });

    const app = createApp({
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

    const env: AppEnv = { DISCORD_PUBLIC_KEY: publicKeyHex };
    const { ctx, waitForAll } = createMockExecutionContext();

    const askBody = JSON.stringify({
      type: INTERACTION_TYPE.APPLICATION_COMMAND,
      application_id: "app-12345",
      token: "interaction-token-xyz",
      data: {
        name: "ask",
        options: [{ name: "question", type: 3, value: "天井って何連ですか？" }],
      },
    });
    const ts = "1700000004";
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
    });

    // waitUntil に登録された非同期処理の完了を待機
    await waitForAll();

    expect(webhookFetch).toHaveBeenCalledTimes(1);
    const [calledUrl, calledInit] = webhookFetch.mock.calls[0] ?? [];
    expect(calledUrl).toBe(
      "https://discord.com/api/v10/webhooks/app-12345/interaction-token-xyz/messages/@original",
    );
    expect(calledInit?.method).toBe("PATCH");
    const sentPayload = JSON.parse(String(calledInit?.body)) as { content: string };
    expect(sentPayload.content).toContain("300連");
    expect(sentPayload.content).toContain("ガチャと天井（300連）の基本ルール");
  });
});
