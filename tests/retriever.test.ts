import { describe, expect, it, vi } from "vitest";
import { getBuiltinKnowledgeChunks } from "../src/knowledge/catalog.js";
import { buildEmbeddingText, type KnowledgeChunk } from "../src/rag/chunker.js";
import {
  createLocalHashEmbedder,
  normalizeL2,
  type Embedder,
  type EmbeddingTaskType,
} from "../src/rag/embedder.js";
import {
  createCloudflareRetriever,
  createInMemoryRetriever,
  type D1QueryBinding,
  type D1StatementLike,
  type IndexedChunk,
  type VectorizeQueryBinding,
} from "../src/rag/retriever.js";

function makeChunk(id: string, heading: string, content: string): KnowledgeChunk {
  return {
    id,
    sourceFile: "test.md",
    heading,
    chunkIndex: 0,
    content,
    charCount: content.length,
  };
}

describe("createInMemoryRetriever", () => {
  it("モック Embedder でコサイン類似度が高い順に上位チャンクを返し、RETRIEVAL_QUERY を使う", async () => {
    const embedSpy = vi.fn<Embedder["embed"]>(
      async (_text: string, _taskType: EmbeddingTaskType) => normalizeL2([1, 0, 0]),
    );

    const entries: IndexedChunk[] = [
      {
        chunk: makeChunk("c1", "低関連", "無関係なテキスト"),
        vector: normalizeL2([0, 1, 0]),
      },
      {
        chunk: makeChunk("c2", "最関連", "ダマスカス鋼の温存理由"),
        vector: normalizeL2([0.98, 0.2, 0]),
      },
      {
        chunk: makeChunk("c3", "中関連", "ヒヒイロカネの温存理由"),
        vector: normalizeL2([0.7, 0.7, 0]),
      },
    ];

    const retriever = createInMemoryRetriever(entries, { embed: embedSpy });
    const results = await retriever.retrieve("ダマスカス鋼について教えて", {
      topK: 3,
      minScore: 0.25,
    });

    expect(embedSpy).toHaveBeenCalledWith(
      "ダマスカス鋼について教えて",
      "RETRIEVAL_QUERY",
    );
    expect(results).toHaveLength(2);
    expect(results[0]?.chunk.id).toBe("c2");
    expect(results[1]?.chunk.id).toBe("c3");
    expect((results[0]?.score ?? 0) > (results[1]?.score ?? 0)).toBe(true);
  });

  it("実ナレッジチャンクに対してローカルハッシュ検索で関連見出しを上位に取得できる", async () => {
    const embedder = createLocalHashEmbedder();
    const chunks = getBuiltinKnowledgeChunks();
    const entries: IndexedChunk[] = [];
    for (const chunk of chunks) {
      const vector = await embedder.embed(
        buildEmbeddingText(chunk),
        "RETRIEVAL_DOCUMENT",
      );
      entries.push({ chunk, vector });
    }

    const retriever = createInMemoryRetriever(entries, embedder);
    const results = await retriever.retrieve("ダマスカス鋼とヒヒイロカネを温存する理由は？", {
      topK: 3,
      minScore: 0.05,
    });

    expect(results.length).toBeGreaterThan(0);
    expect(results[0]?.chunk.heading).toContain("ダマスカス鋼");
  });
});

describe("createCloudflareRetriever", () => {
  it("Vectorize の検索結果 ID で D1 から本文を取得し、スコア順で返す", async () => {
    const embedder: Embedder = {
      embed: vi.fn(async () => [0.5, 0.5]),
    };

    const vectorize: VectorizeQueryBinding = {
      query: vi.fn(async () => ({
        matches: [
          { id: "doc__s02_c01", score: 0.91 },
          { id: "doc__s01_c01", score: 0.74 },
          { id: "doc__s03_c01", score: 0.1 }, // minScore 未満で除外
        ],
      })),
    };

    const mockRows = [
      {
        id: "doc__s01_c01",
        source_file: "01_beginner_roadmap.md",
        heading: "シェロカルテの特別訓練の進め方",
        chunk_index: 0,
        content: "シェロ訓練を最優先で進めよう。",
        char_count: 15,
      },
      {
        id: "doc__s02_c01",
        source_file: "02_items_and_gacha.md",
        heading: "金剛晶を温存すべき理由と主な使い道",
        chunk_index: 0,
        content: "金剛晶はSSR召喚石に使う貴重品です。",
        char_count: 18,
      },
    ];

    const statement: D1StatementLike = {
      bind: (..._values: unknown[]): D1StatementLike => statement,
      all: async <T = Record<string, unknown>>(): Promise<{ results: T[] }> => ({
        results: mockRows as T[],
      }),
    };

    const db: D1QueryBinding = {
      prepare: vi.fn(() => statement),
    };

    const retriever = createCloudflareRetriever({ vectorize, db, embedder });
    const results = await retriever.retrieve("金剛晶は温存した方がいい？", {
      topK: 4,
      minScore: 0.25,
    });

    expect(results).toHaveLength(2);
    expect(results[0]?.chunk.id).toBe("doc__s02_c01");
    expect(results[0]?.score).toBeCloseTo(0.91, 4);
    expect(results[1]?.chunk.id).toBe("doc__s01_c01");
  });
});
