import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { BUILTIN_KNOWLEDGE_DOCS } from "../src/knowledge/builtin.js";
import { buildEmbeddingText, chunkMarkdown } from "../src/rag/chunker.js";

describe("chunkMarkdown", () => {
  it("見出し（##）ごとにチャンク分割し、ファイル名・見出し・本文を保持する", () => {
    const md = [
      "# タイトル",
      "",
      "## 見出しA",
      "本文Aの内容です。",
      "",
      "## 見出しB",
      "本文Bの内容です。",
    ].join("\n");

    const chunks = chunkMarkdown(md, "sample.md");

    expect(chunks).toHaveLength(2);
    expect(chunks[0]).toMatchObject({
      sourceFile: "sample.md",
      heading: "見出しA",
      chunkIndex: 0,
      content: "本文Aの内容です。",
    });
    expect(chunks[1]).toMatchObject({
      sourceFile: "sample.md",
      heading: "見出しB",
      chunkIndex: 0,
      content: "本文Bの内容です。",
    });
  });

  it("文字数上限（450文字）を超えるセクションを自然な位置で複数チャンクに分割する", () => {
    const sentence = "グラブル初心者はまずシェロカルテの特別訓練を進めるのがおすすめです。";
    const longBody = sentence.repeat(18); // 33文字 * 18 = 594文字
    const md = `# ガイド\n\n## 長いセクション\n\n${longBody}`;

    const chunks = chunkMarkdown(md, "long_doc.md", { maxChars: 450 });

    expect(chunks.length).toBeGreaterThanOrEqual(2);
    for (const chunk of chunks) {
      expect(chunk.heading).toBe("長いセクション");
      expect(chunk.sourceFile).toBe("long_doc.md");
      expect(chunk.content.length).toBeLessThanOrEqual(450);
      expect(chunk.charCount).toBe(chunk.content.length);
    }
    expect(chunks[0]?.chunkIndex).toBe(0);
    expect(chunks[1]?.chunkIndex).toBe(1);
  });

  it("すべての実ナレッジファイル（knowledge/*.md）が 300〜450 文字程度で分割され、ID が 64 バイト以内に収まる", () => {
    const knowledgeDir = resolve(process.cwd(), "knowledge");
    const files = [
      "01_beginner_roadmap.md",
      "02_items_and_gacha.md",
      "03_glossary.md",
      "04_guild_war_and_dancho.md",
      "05_grid_and_damage.md",
    ] as const;

    for (const file of files) {
      const markdown = readFileSync(resolve(knowledgeDir, file), "utf8");
      const chunks = chunkMarkdown(markdown, file, { maxChars: 450 });

      expect(chunks.length).toBeGreaterThanOrEqual(3);
      for (const chunk of chunks) {
        expect(chunk.charCount).toBeGreaterThanOrEqual(280);
        expect(chunk.charCount).toBeLessThanOrEqual(450);
        expect(new TextEncoder().encode(chunk.id).byteLength).toBeLessThanOrEqual(64);
      }

      // Workers 組み込みナレッジとの内容一致も検証
      const builtin = BUILTIN_KNOWLEDGE_DOCS.find((doc) => doc.sourceFile === file);
      expect(builtin).toBeDefined();
      expect(builtin?.markdown.trim()).toBe(markdown.trim());
    }
  });

  it("buildEmbeddingText は見出しと本文を含む検索用テキストを返す", () => {
    const text = buildEmbeddingText({
      heading: "金剛晶を温存すべき理由",
      content: "金剛晶はSSR召喚石の上限解放に使う貴重品です。",
    });
    expect(text).toContain("見出し: 金剛晶を温存すべき理由");
    expect(text).toContain("金剛晶はSSR召喚石の上限解放に使う貴重品です。");
  });
});
