/**
 * ============================================================================
 * 【学習ガイド】embedder.ts — テキストを 768 次元の「意味ベクトル」に変換する
 * ============================================================================
 *
 * ■ このファイルの役割とデータの流れ
 *   [日本語テキスト（チャンク本文 or ユーザーの質問文）]
 *        │
 *        ▼ 1. Gemini Embedding API (`gemini-embedding-001`) へリクエスト
 *             - outputDimensionality: 768（Vectorize の上限回避）
 *             - taskType:
 *                 登録時 → "RETRIEVAL_DOCUMENT"
 *                 検索時 → "RETRIEVAL_QUERY"
 *        │
 *        ▼ 2. 返ってきた 768 次元の数値配列に対して L2 正規化を実行
 *             （ベクトルの長さを 1.0 に揃える）
 *        │
 *        ▼
 *   [L2 正規化済みの 768 次元ベクトル（number[]）]
 *
 * ■ なぜ L2 正規化が必要なのか？
 *   `gemini-embedding-001` の標準出力は 3072 次元（正規化済み）ですが、
 *   Matryoshka 表現学習によって 768 次元に短縮して取得した場合、
 *   出力ベクトルは長さが 1 になっていません。
 *   そのままコサイン類似度や内積で比較すると精度が落ちるため、
 *   必ず L2 ノルム（√Σx_i^2）で割って単位ベクトルに正規化します。
 *
 * ■ ローカル検証フォールバック
 *   Cloudflare や Gemini API キーの設定前でもローカルで検索パイプラインを
 *   動かせるように、決定論的ハッシュベースの 768 次元フォールバック Embedder
 *   (`createLocalHashEmbedder`) も用意しています。
 * ============================================================================
 */

export const EMBEDDING_MODEL = "gemini-embedding-001";
export const EMBEDDING_DIMENSIONS = 768;

/**
 * Gemini Embedding API の taskType。
 * - RETRIEVAL_DOCUMENT: ナレッジを Vectorize / インデックスに登録するときに指定
 * - RETRIEVAL_QUERY:    ユーザーからの質問文を検索ベクトルにするときに指定
 */
export type EmbeddingTaskType = "RETRIEVAL_DOCUMENT" | "RETRIEVAL_QUERY";

export interface Embedder {
  embed(text: string, taskType: EmbeddingTaskType): Promise<number[]>;
}

export interface GeminiEmbedderOptions {
  readonly apiKey: string;
  readonly fetchImpl?: typeof fetch;
  readonly baseUrl?: string;
}

interface GeminiEmbedResponse {
  readonly embedding?: {
    readonly values?: unknown;
  };
  readonly error?: {
    readonly message?: string;
  };
}

const DEFAULT_GEMINI_BASE_URL = "https://generativelanguage.googleapis.com/v1beta";

/**
 * ベクトルに対して L2 正規化（長さ = 1.0 へのスケーリング）を行う。
 * 全要素が 0 の場合は NaN を防ぐためゼロベクトルをそのまま返す。
 */
export function normalizeL2(values: readonly number[]): number[] {
  let sumOfSquares = 0;
  for (const value of values) {
    sumOfSquares += value * value;
  }

  const norm = Math.sqrt(sumOfSquares);
  if (norm === 0 || !Number.isFinite(norm)) {
    return values.map(() => 0);
  }

  return values.map((value) => value / norm);
}

/**
 * 2つのベクトルのコサイン類似度（-1.0 〜 1.0）を計算する。
 * L2 正規化済みベクトル同士であれば内積と同じ値になる。
 */
export function cosineSimilarity(
  a: readonly number[],
  b: readonly number[],
): number {
  if (a.length !== b.length) {
    throw new Error(
      `ベクトルの次元数が一致しません: ${String(a.length)} vs ${String(b.length)}`,
    );
  }
  if (a.length === 0) {
    return 0;
  }

  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < a.length; i += 1) {
    const va = a[i] ?? 0;
    const vb = b[i] ?? 0;
    dot += va * vb;
    normA += va * va;
    normB += vb * vb;
  }

  const denominator = Math.sqrt(normA) * Math.sqrt(normB);
  if (denominator === 0 || !Number.isFinite(denominator)) {
    return 0;
  }

  return dot / denominator;
}

function isNumberArray(value: unknown): value is number[] {
  return (
    Array.isArray(value) &&
    value.every((item) => typeof item === "number" && Number.isFinite(item))
  );
}

/**
 * Gemini API (`gemini-embedding-001`, 768次元・L2正規化) を使う Embedder を生成する。
 */
export function createGeminiEmbedder(options: GeminiEmbedderOptions): Embedder {
  const apiKey = options.apiKey.trim();
  if (apiKey.length === 0) {
    throw new Error("GEMINI_API_KEY が設定されていません。");
  }

  const fetchImpl = options.fetchImpl ?? fetch;
  const baseUrl = (options.baseUrl ?? DEFAULT_GEMINI_BASE_URL).replace(/\/+$/, "");

  return {
    async embed(text: string, taskType: EmbeddingTaskType): Promise<number[]> {
      const trimmed = text.trim();
      if (trimmed.length === 0) {
        throw new Error("Embedding 対象のテキストが空です。");
      }

      const url = `${baseUrl}/models/${EMBEDDING_MODEL}:embedContent`;
      const response = await fetchImpl(url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-goog-api-key": apiKey,
        },
        body: JSON.stringify({
          model: `models/${EMBEDDING_MODEL}`,
          content: {
            parts: [{ text: trimmed }],
          },
          taskType,
          outputDimensionality: EMBEDDING_DIMENSIONS,
        }),
      });

      const payload = (await response.json()) as GeminiEmbedResponse;

      if (!response.ok) {
        const detail = payload.error?.message ?? `HTTP ${String(response.status)}`;
        throw new Error(`Gemini Embedding API エラー: ${detail}`);
      }

      const rawValues = payload.embedding?.values;
      if (!isNumberArray(rawValues)) {
        throw new Error("Gemini Embedding API のレスポンス形式が不正です。");
      }

      if (rawValues.length !== EMBEDDING_DIMENSIONS) {
        throw new Error(
          `想定外の Embedding 次元数です: 期待=${String(EMBEDDING_DIMENSIONS)}, 実際=${String(rawValues.length)}`,
        );
      }

      // 3072 未満の次元（768次元）では出力が未正規化のため、必ず L2 正規化する
      return normalizeL2(rawValues);
    },
  };
}

/**
 * 文字列に対する 32-bit FNV-1a ハッシュ（ローカル検証用）。
 */
function fnv1aHash(input: string): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < input.length; i += 1) {
    hash ^= input.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}

/**
 * 日本語テキストから文字バイグラム・トリグラムと英数字トークンを抽出する。
 * オフライン検証時に API キーなしで「似た単語を含むチャンク」を検索できるようにする。
 */
function extractFeatures(text: string): string[] {
  const normalized = text
    .toLowerCase()
    .replace(/[\s\u3000、。・,.:;!?！？「」『』（）()\[\]#*`\-_/]+/g, " ")
    .trim();

  const features: string[] = [];
  const compact = normalized.replace(/\s+/g, "");

  // 2-gram / 3-gram（日本語の単語境界がなくても部分一致が効く）
  for (let i = 0; i < compact.length - 1; i += 1) {
    features.push(`bi:${compact.slice(i, i + 2)}`);
  }
  for (let i = 0; i < compact.length - 2; i += 1) {
    features.push(`tri:${compact.slice(i, i + 3)}`);
  }

  // スペース区切りの語句も特徴量に加える
  for (const token of normalized.split(" ")) {
    if (token.length >= 2) {
      features.push(`tok:${token}`);
    }
  }

  return features;
}

/**
 * オフライン・ローカル検証用の決定論的 768 次元 Embedder。
 * Gemini API キーが無い環境でもチャンク分割〜コサイン類似度検索の疎通確認ができる。
 * ※ 本番環境では必ず `createGeminiEmbedder` を使用すること。
 */
export function createLocalHashEmbedder(
  dimensions: number = EMBEDDING_DIMENSIONS,
): Embedder {
  return {
    async embed(text: string, _taskType: EmbeddingTaskType): Promise<number[]> {
      const vector = new Array<number>(dimensions).fill(0);
      const features = extractFeatures(text);

      for (const feature of features) {
        const h1 = fnv1aHash(feature);
        const h2 = fnv1aHash(`sign:${feature}`);
        const index = h1 % dimensions;
        const sign = (h2 & 1) === 0 ? 1 : -1;
        vector[index] = (vector[index] ?? 0) + sign;
      }

      return normalizeL2(vector);
    },
  };
}
