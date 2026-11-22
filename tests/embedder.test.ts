import { describe, expect, it, vi } from "vitest";
import {
  EMBEDDING_DIMENSIONS,
  EMBEDDING_MODEL,
  cosineSimilarity,
  createGeminiEmbedder,
  createLocalHashEmbedder,
  normalizeL2,
} from "../src/rag/embedder.js";

describe("normalizeL2 / cosineSimilarity", () => {
  it("L2 正規化後のベクトル長（ノルム）が 1.0 になる", () => {
    const normalized = normalizeL2([3, 4, 0]);
    expect(normalized[0]).toBeCloseTo(0.6, 6);
    expect(normalized[1]).toBeCloseTo(0.8, 6);
    expect(normalized[2]).toBeCloseTo(0, 6);

    const norm = Math.sqrt(
      normalized.reduce((acc, value) => acc + value * value, 0),
    );
    expect(norm).toBeCloseTo(1.0, 6);
  });

  it("ゼロベクトルを正規化しても NaN にならずゼロベクトルを返す", () => {
    expect(normalizeL2([0, 0, 0])).toEqual([0, 0, 0]);
  });

  it("コサイン類似度を正しく計算する", () => {
    expect(cosineSimilarity([1, 0], [1, 0])).toBeCloseTo(1.0, 6);
    expect(cosineSimilarity([1, 0], [0, 1])).toBeCloseTo(0.0, 6);
    expect(cosineSimilarity([1, 0], [-1, 0])).toBeCloseTo(-1.0, 6);
  });

  it("次元数が異なるベクトル同士の比較ではエラーを投げる", () => {
    expect(() => cosineSimilarity([1, 0], [1, 0, 0])).toThrow();
  });
});

describe("createGeminiEmbedder", () => {
  it("gemini-embedding-001 へ outputDimensionality: 768 と taskType を送信し、返却ベクトルを L2 正規化する", async () => {
    // 非正規化の 768 次元ベクトル（全要素 2.0）を返すモック
    const rawValues = new Array<number>(EMBEDDING_DIMENSIONS).fill(2.0);
    const mockFetch = vi.fn<typeof fetch>(async () => {
      return new Response(
        JSON.stringify({
          embedding: { values: rawValues },
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    });

    const embedder = createGeminiEmbedder({
      apiKey: "test-dummy-key",
      fetchImpl: mockFetch,
    });

    const docVector = await embedder.embed("ダマスカス鋼は温存しよう", "RETRIEVAL_DOCUMENT");
    const queryVector = await embedder.embed("ダマスカス鋼は使っていい？", "RETRIEVAL_QUERY");

    expect(mockFetch).toHaveBeenCalledTimes(2);

    const firstCall = mockFetch.mock.calls[0];
    expect(firstCall?.[0]).toContain(`/models/${EMBEDDING_MODEL}:embedContent`);
    const firstBody = JSON.parse(String(firstCall?.[1]?.body)) as {
      outputDimensionality: number;
      taskType: string;
    };
    expect(firstBody.outputDimensionality).toBe(768);
    expect(firstBody.taskType).toBe("RETRIEVAL_DOCUMENT");

    const secondCall = mockFetch.mock.calls[1];
    const secondBody = JSON.parse(String(secondCall?.[1]?.body)) as {
      outputDimensionality: number;
      taskType: string;
    };
    expect(secondBody.outputDimensionality).toBe(768);
    expect(secondBody.taskType).toBe("RETRIEVAL_QUERY");

    expect(docVector).toHaveLength(768);
    const norm = Math.sqrt(docVector.reduce((sum, v) => sum + v * v, 0));
    expect(norm).toBeCloseTo(1.0, 6);
    expect(queryVector).toHaveLength(768);
  });
});

describe("createLocalHashEmbedder", () => {
  it("768 次元の L2 正規化済みベクトルを決定論的に生成する", async () => {
    const embedder = createLocalHashEmbedder();
    const v1 = await embedder.embed("シェロカルテの特別訓練", "RETRIEVAL_DOCUMENT");
    const v2 = await embedder.embed("シェロカルテの特別訓練", "RETRIEVAL_QUERY");

    expect(v1).toHaveLength(768);
    expect(v1).toEqual(v2);

    const norm = Math.sqrt(v1.reduce((sum, v) => sum + v * v, 0));
    expect(norm).toBeCloseTo(1.0, 6);
  });
});
