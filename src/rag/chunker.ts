/**
 * ============================================================================
 * 【学習ガイド】chunker.ts — Markdown ナレッジを「検索しやすいチャンク」に分割する
 * ============================================================================
 *
 * ■ このファイルの役割とデータの流れ
 *   [knowledge/*.md の全文テキスト]
 *        │
 *        ▼ 1. 見出し（## ...）ごとにセクションへ分割
 *   [セクション配列（見出し + 本文）]
 *        │
 *        ▼ 2. 本文が上限文字数（約450文字）を超える場合は、
 *             段落（空行）→ 句点（。）の優先順で自然な切れ目に再分割
 *   [KnowledgeChunk[]（id / sourceFile / heading / chunkIndex / content）]
 *
 * ■ なぜチャンク分割が必要なのか？
 *   RAG（検索拡張生成）では、長いドキュメント丸ごとではなく
 *   「1つのトピックがまとまった300〜450文字程度の塊（チャンク）」単位で
 *   ベクトル化・検索することで、質問にピンポイントで関係する根拠だけを
 *   LLM（Gemini）に渡せるようになります。
 *
 * ■ ID 設計のポイント
 *   Cloudflare Vectorize のベクトル ID は最大 64 バイトの制限があります。
 *   日本語の見出しをそのまま ID にするとバイト数があふれるため、
 *   ファイル名（ASCII）＋セクション番号＋チャンク番号の決定的な ID を生成します。
 * ============================================================================
 */

export interface KnowledgeChunk {
  /** Cloudflare Vectorize / D1 の主キーとなる一意かつ決定的な ID（64バイト以内） */
  readonly id: string;
  /** 元の Markdown ファイル名（例: "01_beginner_roadmap.md"） */
  readonly sourceFile: string;
  /** 属している見出し（## の内容） */
  readonly heading: string;
  /** 同一見出し内での連番（0始まり） */
  readonly chunkIndex: number;
  /** チャンク本文（前後の余分な空白・改行は除去済み） */
  readonly content: string;
  /** 本文の文字数 */
  readonly charCount: number;
}

export interface ChunkOptions {
  /** 1チャンクあたりの最大文字数（デフォルト: 450） */
  readonly maxChars?: number;
}

interface MarkdownSection {
  readonly heading: string;
  readonly body: string;
}

const DEFAULT_MAX_CHARS = 450;

/**
 * ファイル名から Vectorize ID に安全な ASCII スラグを作成する。
 */
function sanitizeFileId(sourceFile: string): string {
  const baseName = sourceFile
    .replace(/^.*[\\/]/, "")
    .replace(/\.md$/i, "")
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, "-")
    .replace(/^-+|-+$/g, "");

  return (baseName || "doc").slice(0, 40);
}

/**
 * Markdown 文字列を `## ` 見出し単位のセクションに分解する。
 * `# `（ドキュメント全体タイトル）より前の行や空セクションは無視する。
 */
function splitIntoSections(markdown: string): MarkdownSection[] {
  const normalized = markdown.replace(/\r\n?/g, "\n");
  const lines = normalized.split("\n");

  const sections: MarkdownSection[] = [];
  let currentHeading: string | null = null;
  let buffer: string[] = [];

  const flush = (): void => {
    if (currentHeading === null) {
      return;
    }
    const body = buffer.join("\n").trim();
    if (body.length > 0) {
      sections.push({ heading: currentHeading, body });
    }
  };

  for (const line of lines) {
    const headingMatch = /^##\s+(.+?)\s*$/.exec(line);
    if (headingMatch !== null && headingMatch[1] !== undefined) {
      flush();
      currentHeading = headingMatch[1].trim();
      buffer = [];
      continue;
    }

    // まだ ## 見出しに入っていない場合（# タイトル行など）はスキップ
    if (currentHeading !== null) {
      buffer.push(line);
    }
  }

  flush();

  // ## 見出しが1つもない Markdown の場合は、ドキュメント全体を1セクションとして扱う
  if (sections.length === 0) {
    const trimmed = normalized.trim();
    if (trimmed.length > 0) {
      const h1Match = /^#\s+(.+?)\s*$/m.exec(trimmed);
      const fallbackHeading = h1Match?.[1]?.trim() ?? "概要";
      const fallbackBody = trimmed.replace(/^#\s+.+?\n+/, "").trim();
      if (fallbackBody.length > 0) {
        sections.push({ heading: fallbackHeading, body: fallbackBody });
      }
    }
  }

  return sections;
}

/**
 * 1つの長い段落を、句点（。！？）や改行を優先して maxChars 以下に分割する。
 */
function splitLongParagraph(paragraph: string, maxChars: number): string[] {
  if (paragraph.length <= maxChars) {
    return [paragraph];
  }

  // 句点・感嘆符・疑問符・改行の直後で文単位に分解
  const sentences = paragraph
    .split(/(?<=[。！？\n])/)
    .map((part) => part.trim())
    .filter((part) => part.length > 0);

  const chunks: string[] = [];
  let current = "";

  const pushCurrent = (): void => {
    if (current.length > 0) {
      chunks.push(current);
      current = "";
    }
  };

  for (const sentence of sentences) {
    // 1文自体が maxChars を超える場合は文字数で強制分割する
    if (sentence.length > maxChars) {
      pushCurrent();
      for (let offset = 0; offset < sentence.length; offset += maxChars) {
        chunks.push(sentence.slice(offset, offset + maxChars));
      }
      continue;
    }

    if (current.length === 0) {
      current = sentence;
    } else if (current.length + sentence.length <= maxChars) {
      current += sentence;
    } else {
      pushCurrent();
      current = sentence;
    }
  }

  pushCurrent();
  return chunks;
}

/**
 * セクション本文を maxChars 以内の複数ピースに分割する。
 */
function splitBodyByLimit(body: string, maxChars: number): string[] {
  if (body.length <= maxChars) {
    return [body];
  }

  const paragraphs = body
    .split(/\n{2,}/)
    .map((p) => p.trim())
    .filter((p) => p.length > 0);

  const pieces: string[] = [];
  let current = "";

  const flushCurrent = (): void => {
    if (current.length > 0) {
      pieces.push(current);
      current = "";
    }
  };

  for (const paragraph of paragraphs) {
    if (paragraph.length > maxChars) {
      flushCurrent();
      const subChunks = splitLongParagraph(paragraph, maxChars);
      pieces.push(...subChunks);
      continue;
    }

    if (current.length === 0) {
      current = paragraph;
    } else if (current.length + 2 + paragraph.length <= maxChars) {
      current = `${current}\n\n${paragraph}`;
    } else {
      flushCurrent();
      current = paragraph;
    }
  }

  flushCurrent();
  return pieces;
}

/**
 * Markdown テキストを見出し単位＋文字数上限でチャンク分割する。
 */
export function chunkMarkdown(
  markdown: string,
  sourceFile: string,
  options: ChunkOptions = {},
): KnowledgeChunk[] {
  const maxChars = options.maxChars ?? DEFAULT_MAX_CHARS;
  if (!Number.isInteger(maxChars) || maxChars <= 0) {
    throw new Error(`maxChars は正の整数を指定してください: ${String(maxChars)}`);
  }

  const fileSlug = sanitizeFileId(sourceFile);
  const sections = splitIntoSections(markdown);
  const results: KnowledgeChunk[] = [];

  sections.forEach((section, sectionIndex) => {
    const pieces = splitBodyByLimit(section.body, maxChars);
    pieces.forEach((content, chunkIndex) => {
      const id = `${fileSlug}__s${String(sectionIndex + 1).padStart(2, "0")}_c${String(chunkIndex + 1).padStart(2, "0")}`;
      results.push({
        id,
        sourceFile,
        heading: section.heading,
        chunkIndex,
        content,
        charCount: content.length,
      });
    });
  });

  return results;
}

/**
 * Embedding 用の入力テキストを整形する。
 * 見出しを先頭に含めることで、短い本文や代名詞を含むチャンクでも検索精度が向上する。
 */
export function buildEmbeddingText(
  chunk: Pick<KnowledgeChunk, "heading" | "content">,
): string {
  return `見出し: ${chunk.heading}\n\n${chunk.content}`;
}
