/**
 * ============================================================================
 * 【学習ガイド】retriever.ts — 質問に近いナレッジチャンクを検索して取り出す
 * ============================================================================
 *
 * ■ このファイルの役割とデータの流れ
 *   [ユーザーの質問文（例: "ダマスカス鋼は使っていい？"）]
 *        │
 *        ▼ 1. embedder.embed(question, "RETRIEVAL_QUERY")
 *             質問文を 768 次元の L2 正規化ベクトルに変換
 *        │
 *        ▼ 2. 類似ベクトル検索（環境に応じて 2 系統を切り替え）
 *             ├─ 本番（CloudflareRetriever）:
 *             │    Vectorize.query() で上位チャンク ID + スコアを取得
 *             │      → D1 (knowledge_chunks) から本文を一括取得
 *             └─ ローカル検証（InMemoryRetriever）:
 *                  JSON / メモリ上の全ベクトルとコサイン類似度を計算
 *        │
 *        ▼ 3. スコア降順ソート & 閾値（minScore）で無関係な結果を除外
 *   [上位 3〜5 件の RetrievedChunk[]（chunk + score）]
 *
 * ■ なぜ Vectorize と D1 を分けているのか？
 *   Vectorize は高速なベクトル検索に特化しており、メタデータサイズに制約があります。
 *   そのため、Vectorize には「ベクトル＋最小限のメタデータ」、
 *   D1 には「チャンク本文の完全なデータ」を保存し、ID で結合する構成が定番です。
 * ============================================================================
 */

import type { KnowledgeChunk } from "./chunker.js";
import { cosineSimilarity, type Embedder } from "./embedder.js";

export const DEFAULT_TOP_K = 4;
export const MIN_TOP_K = 3;
export const MAX_TOP_K = 5;
export const DEFAULT_MIN_SCORE = 0.25;

export interface RetrievedChunk {
  readonly chunk: KnowledgeChunk;
  readonly score: number;
}

export interface RetrieveOptions {
  /** 取得件数（3〜5 に収まるように自動クランプされる） */
  readonly topK?: number;
  /** この類似度未満のチャンクは「根拠不足」として除外する */
  readonly minScore?: number;
}

export interface ChunkRetriever {
  retrieve(question: string, options?: RetrieveOptions): Promise<RetrievedChunk[]>;
}

/** ローカル JSON インデックスの 1 レコード形式 */
export interface IndexedChunk {
  readonly chunk: KnowledgeChunk;
  readonly vector: readonly number[];
}

/** `scripts/ingest.ts --mode local` が出力する JSON ファイルの全体形式 */
export interface LocalVectorIndex {
  readonly model: string;
  readonly dimensions: number;
  readonly normalizedL2: boolean;
  readonly createdAt: string;
  readonly entries: readonly IndexedChunk[];
}

/**
 * Vectorize バインディングの最小インターフェース（テストでモックしやすい設計）。
 */
export interface VectorizeQueryBinding {
  query(
    vector: number[],
    options?: {
      topK?: number;
      returnMetadata?: "none" | "indexed" | "all";
    },
  ): Promise<{
    matches: ReadonlyArray<{
      id: string;
      score: number;
    }>;
  }>;
}

/**
 * D1 バインディングの最小インターフェース（実 D1Database と互換）。
 */
export interface D1StatementLike {
  bind(...values: unknown[]): D1StatementLike;
  all<T = Record<string, unknown>>(): Promise<{ results: T[] }>;
}

export interface D1QueryBinding {
  prepare(query: string): D1StatementLike;
}

interface ChunkRow {
  readonly id: string;
  readonly source_file: string;
  readonly heading: string;
  readonly chunk_index: number;
  readonly content: string;
  readonly char_count: number;
}

function clampTopK(topK: number | undefined): number {
  const value = topK ?? DEFAULT_TOP_K;
  return Math.max(MIN_TOP_K, Math.min(MAX_TOP_K, Math.trunc(value)));
}

/**
 * インメモリ／ローカル JSON インデックス上でコサイン類似度検索を行う Retriever。
 * Cloudflare ログイン前でもローカル CLI やユニットテストで RAG 検索を検証できる。
 */
export function createInMemoryRetriever(
  entries: readonly IndexedChunk[],
  embedder: Embedder,
): ChunkRetriever {
  return {
    async retrieve(
      question: string,
      options: RetrieveOptions = {},
    ): Promise<RetrievedChunk[]> {
      const trimmed = question.trim();
      if (trimmed.length === 0 || entries.length === 0) {
        return [];
      }

      const topK = clampTopK(options.topK);
      const minScore = options.minScore ?? DEFAULT_MIN_SCORE;

      // 検索時は必ず RETRIEVAL_QUERY を指定してベクトル化する
      const queryVector = await embedder.embed(trimmed, "RETRIEVAL_QUERY");

      const scored: RetrievedChunk[] = entries
        .map((entry) => ({
          chunk: entry.chunk,
          score: cosineSimilarity(queryVector, entry.vector),
        }))
        .filter((item) => item.score >= minScore)
        .sort((a, b) => b.score - a.score)
        .slice(0, topK);

      return scored;
    },
  };
}

/**
 * Cloudflare Vectorize（ベクトル検索）+ Cloudflare D1（本文取得）で検索する Retriever。
 */
export function createCloudflareRetriever(options: {
  readonly vectorize: VectorizeQueryBinding;
  readonly db: D1QueryBinding;
  readonly embedder: Embedder;
}): ChunkRetriever {
  const { vectorize, db, embedder } = options;

  return {
    async retrieve(
      question: string,
      retrieveOptions: RetrieveOptions = {},
    ): Promise<RetrievedChunk[]> {
      const trimmed = question.trim();
      if (trimmed.length === 0) {
        return [];
      }

      const topK = clampTopK(retrieveOptions.topK);
      const minScore = retrieveOptions.minScore ?? DEFAULT_MIN_SCORE;

      // 1. 質問文を RETRIEVAL_QUERY で 768 次元・L2 正規化ベクトルに変換
      const queryVector = await embedder.embed(trimmed, "RETRIEVAL_QUERY");

      // 2. Vectorize で上位チャンク ID とコサイン類似度スコアを検索
      const vectorResult = await vectorize.query(queryVector, {
        topK,
        returnMetadata: "all",
      });

      const qualifyingMatches = vectorResult.matches.filter(
        (match) => match.score >= minScore,
      );
      if (qualifyingMatches.length === 0) {
        return [];
      }

      // 3. 取得した ID 群を使って D1 からチャンク本文を一括取得
      const ids = qualifyingMatches.map((match) => match.id);
      const placeholders = ids.map(() => "?").join(", ");
      const sql = `SELECT id, source_file, heading, chunk_index, content, char_count FROM knowledge_chunks WHERE id IN (${placeholders})`;

      const { results } = await db
        .prepare(sql)
        .bind(...ids)
        .all<ChunkRow>();

      const rowById = new Map<string, KnowledgeChunk>();
      for (const row of results) {
        rowById.set(row.id, {
          id: row.id,
          sourceFile: row.source_file,
          heading: row.heading,
          chunkIndex: row.chunk_index,
          content: row.content,
          charCount: row.char_count,
        });
      }

      // 4. Vectorize のスコア順を維持して RetrievedChunk[] を組み立てる
      const retrieved: RetrievedChunk[] = [];
      for (const match of qualifyingMatches) {
        const chunk = rowById.get(match.id);
        if (chunk !== undefined) {
          retrieved.push({ chunk, score: match.score });
        }
      }

      return retrieved.sort((a, b) => b.score - a.score);
    },
  };
}
