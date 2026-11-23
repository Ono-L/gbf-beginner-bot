/**
 * ============================================================================
 * 【学習ガイド】answer.ts — 検索したチャンクだけを根拠に初心者向け回答を生成する
 * ============================================================================
 *
 * ■ このファイルの役割とデータの流れ
 *   [ユーザーの質問] + [retriever.ts が見つけた上位 3〜5 チャンク]
 *        │
 *        ▼ 1. 根拠チェック（チャンクが 0 件なら即フォールバック返却）
 *             → 推測で答えず「手元ナレッジにないためゲーム内・最新攻略で確認推奨」を返す
 *        │
 *        ▼ 2. プロンプト組み立て
 *             - システム指示: 参照ナレッジ以外の知識で推測しない / 初心者向けに丁寧に説明
 *             - コンテキスト: 取得したチャンクのファイル名・見出し・本文を列挙
 *        │
 *        ▼ 3. Gemini API (`generateContent`) で回答文を生成
 *        │
 *        ▼ 4. 出典フッターを自動付与
 *             参照したファイル名と見出しを末尾に添えて返す
 *   [RagAnswerResult（最終メッセージ文字列 / 出典一覧 / 根拠の有無）]
 *
 * ■ ハルシネーション（もっともらしい嘘）を防ぐ工夫
 *   1. 検索スコアが低いチャンクは retriever 側で除外する
 *   2. チャンクが 0 件のときはそもそも LLM を呼ばず定型文を返す
 *   3. プロンプトで「根拠が不足する場合は専用トークンを返す」よう制約し、
 *      LLM が外部知識で勝手に補完するのを防ぐ
 * ============================================================================
 */

import type { RetrievedChunk } from "./retriever.js";

export const DEFAULT_GEMINI_MODEL = "gemini-2.5-flash";

export const NO_EVIDENCE_REPLY =
  "すまねえ、オイラの手元のナレッジにはその情報が載ってねえんだぜ！推測で適当なことは言えねえから、ゲーム内のお知らせや最新の攻略情報を確認してくれよな！";

/** LLM が根拠不足と判断したときに返させる内部マーカー */
const INSUFFICIENT_CONTEXT_MARKER = "[[NO_EVIDENCE]]";

export interface GenerationInput {
  readonly systemInstruction: string;
  readonly userPrompt: string;
}

export interface TextGenerator {
  generate(input: GenerationInput): Promise<string>;
}

export interface GeminiTextGeneratorOptions {
  readonly apiKey: string;
  readonly model?: string;
  readonly fetchImpl?: typeof fetch;
  readonly baseUrl?: string;
}

export interface CitationSource {
  readonly sourceFile: string;
  readonly heading: string;
}

export interface RagAnswerResult {
  /** Discord にそのまま投稿できる最終回答テキスト（出典込み） */
  readonly answer: string;
  /** 回答の根拠として参照した見出し一覧 */
  readonly sources: readonly CitationSource[];
  /** 根拠チャンクに基づいて回答できたかどうか */
  readonly hasEvidence: boolean;
}

interface GeminiGenerateResponse {
  readonly candidates?: ReadonlyArray<{
    readonly content?: {
      readonly parts?: ReadonlyArray<{
        readonly text?: unknown;
      }>;
    };
  }>;
  readonly error?: {
    readonly message?: string;
  };
}

const DEFAULT_GEMINI_BASE_URL = "https://generativelanguage.googleapis.com/v1beta";

/**
 * Gemini API (`generateContent`) を呼び出す TextGenerator を生成する。
 */
export function createGeminiTextGenerator(
  options: GeminiTextGeneratorOptions,
): TextGenerator {
  const apiKey = options.apiKey.trim();
  if (apiKey.length === 0) {
    throw new Error("GEMINI_API_KEY が設定されていません。");
  }

  const model = (options.model ?? DEFAULT_GEMINI_MODEL).trim() || DEFAULT_GEMINI_MODEL;
  const fetchImpl = options.fetchImpl ?? fetch;
  const baseUrl = (options.baseUrl ?? DEFAULT_GEMINI_BASE_URL).replace(/\/+$/, "");

  return {
    async generate(input: GenerationInput): Promise<string> {
      const url = `${baseUrl}/models/${encodeURIComponent(model)}:generateContent`;

      const response = await fetchImpl(url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-goog-api-key": apiKey,
        },
        body: JSON.stringify({
          systemInstruction: {
            parts: [{ text: input.systemInstruction }],
          },
          contents: [
            {
              role: "user",
              parts: [{ text: input.userPrompt }],
            },
          ],
          generationConfig: {
            temperature: 0.2,
            maxOutputTokens: 700,
          },
        }),
      });

      const payload = (await response.json()) as GeminiGenerateResponse;

      if (!response.ok) {
        const detail = payload.error?.message ?? `HTTP ${String(response.status)}`;
        throw new Error(`Gemini Generate API エラー: ${detail}`);
      }

      const parts = payload.candidates?.[0]?.content?.parts ?? [];
      const text = parts
        .map((part) => (typeof part.text === "string" ? part.text : ""))
        .join("")
        .trim();

      if (text.length === 0) {
        throw new Error("Gemini API から空の回答が返されました。");
      }

      return text;
    },
  };
}

/**
 * 参照チャンクから重複のない出典リストを抽出する。
 */
export function extractUniqueSources(
  chunks: readonly RetrievedChunk[],
): CitationSource[] {
  const seen = new Set<string>();
  const sources: CitationSource[] = [];

  for (const { chunk } of chunks) {
    const key = `${chunk.sourceFile}::${chunk.heading}`;
    if (!seen.has(key)) {
      seen.add(key);
      sources.push({
        sourceFile: chunk.sourceFile,
        heading: chunk.heading,
      });
    }
  }

  return sources;
}

/**
 * 回答末尾に付与する出典テキストを整形する。
 */
export function formatCitations(sources: readonly CitationSource[]): string {
  if (sources.length === 0) {
    return "";
  }
  const lines = sources.map(
    (source) => `- ${source.heading}（${source.sourceFile}）`,
  );
  return `\n\n📚 **参照ナレッジ**\n${lines.join("\n")}`;
}

/**
 * システムプロンプトを組み立てる（ビィナビ口調＋ハルシネーション防止ルール）。
 */
export function buildSystemInstruction(): string {
  return [
    "あなたはグランブルーファンタジー（グラブル）の初心者をサポートする案内役 Bot「ビィナビ」です。",
    "一人称は「オイラ」を使い、元気で親しみやすい相棒口調（「〜だぜ！」「〜だな！」「〜しようぜ！」「〜だぞ！」「〜してくれよな！」など）で日本語で回答してください。",
    "ただし、初心者がパッと読んで内容を理解しやすいことを最優先にし、くどくなりすぎず箇条書きも活用してわかりやすく説明してください。",
    "以下のルールを厳守してください。",
    "1. 与えられた【参照ナレッジ】に書かれている情報だけを根拠に回答すること。",
    "2. 参照ナレッジに書かれていない仕様・数値・最新アップデート情報・キャラ性能などを推測や事前知識で補完しないこと。",
    `3. 参照ナレッジだけでは質問に答えられない場合は、余計な説明をせず「${INSUFFICIENT_CONTEXT_MARKER}」とだけ出力すること。`,
    "4. 初心者にもわかるように専門用語をかみ砕き、Discord で読みやすいよう 300〜500 文字程度の簡潔な構成（箇条書き可）でまとめること。",
    "5. 出典一覧はシステム側で自動付与するため、回答本文の末尾に自分で出典欄を書かないこと。",
  ].join("\n");
}

/**
 * 検索チャンクと質問文からユーザープロンプトを組み立てる。
 */
function buildUserPrompt(
  question: string,
  chunks: readonly RetrievedChunk[],
): string {
  const contextBlocks = chunks.map(({ chunk, score }, index) => {
    return [
      `[ナレッジ ${String(index + 1)}]`,
      `ファイル: ${chunk.sourceFile}`,
      `見出し: ${chunk.heading}`,
      `類似度: ${score.toFixed(3)}`,
      `本文:\n${chunk.content}`,
    ].join("\n");
  });

  return [
    "【参照ナレッジ】",
    contextBlocks.join("\n\n---\n\n"),
    "",
    "【ユーザーからの質問】",
    question.trim(),
  ].join("\n");
}

/**
 * Discord の 1 メッセージ文字数上限（2000文字）に安全に収まるよう調整する。
 */
function ensureDiscordLimit(body: string, citationBlock: string): string {
  const maxTotal = 1950;
  const availableBodyLength = Math.max(100, maxTotal - citationBlock.length);
  const safeBody =
    body.length > availableBodyLength
      ? `${body.slice(0, availableBodyLength - 1)}…`
      : body;
  return `${safeBody}${citationBlock}`;
}

/**
 * 検索済みチャンクを根拠にして初心者向け回答を生成する。
 */
export async function generateRagAnswer(params: {
  readonly question: string;
  readonly retrievedChunks: readonly RetrievedChunk[];
  readonly generator: TextGenerator;
}): Promise<RagAnswerResult> {
  const { question, retrievedChunks, generator } = params;

  // 根拠チャンクが 0 件の場合は推測せず定型メッセージを返す
  if (retrievedChunks.length === 0) {
    return {
      answer: NO_EVIDENCE_REPLY,
      sources: [],
      hasEvidence: false,
    };
  }

  const rawAnswer = await generator.generate({
    systemInstruction: buildSystemInstruction(),
    userPrompt: buildUserPrompt(question, retrievedChunks),
  });

  if (
    rawAnswer.includes(INSUFFICIENT_CONTEXT_MARKER) ||
    rawAnswer.trim().length === 0
  ) {
    return {
      answer: NO_EVIDENCE_REPLY,
      sources: [],
      hasEvidence: false,
    };
  }

  const sources = extractUniqueSources(retrievedChunks);
  const citationBlock = formatCitations(sources);

  return {
    answer: ensureDiscordLimit(rawAnswer.trim(), citationBlock),
    sources,
    hasEvidence: true,
  };
}
