import { describe, expect, it, vi } from "vitest";
import {
  NO_EVIDENCE_REPLY,
  buildSystemInstruction,
  generateRagAnswer,
  type TextGenerator,
} from "../src/rag/answer.js";
import type { RetrievedChunk } from "../src/rag/retriever.js";

describe("generateRagAnswer", () => {
  it("根拠チャンクがある場合は回答を生成し、参照見出しを出典として末尾に付与する", async () => {
    const generator: TextGenerator = {
      generate: vi.fn(
        async () =>
          "ダマスカス鋼は入手数が非常に限られているため、序盤のマグナ武器には使わず温存するのがおすすめです。",
      ),
    };

    const retrievedChunks: RetrievedChunk[] = [
      {
        score: 0.88,
        chunk: {
          id: "02_items_and_gacha__s01_c01",
          sourceFile: "02_items_and_gacha.md",
          heading: "ダマスカス鋼とヒヒイロカネを温存すべき理由",
          chunkIndex: 0,
          content: "ダマスカス鋼とヒヒイロカネは超貴重アイテムです。",
          charCount: 25,
        },
      },
    ];

    const result = await generateRagAnswer({
      question: "ダマスカス鋼は今使っていい？",
      retrievedChunks,
      generator,
    });

    expect(result.hasEvidence).toBe(true);
    expect(result.sources).toEqual([
      {
        sourceFile: "02_items_and_gacha.md",
        heading: "ダマスカス鋼とヒヒイロカネを温存すべき理由",
      },
    ]);
    expect(result.answer).toContain("温存するのがおすすめです");
    expect(result.answer).toContain("📚 **参照ナレッジ**");
    expect(result.answer).toContain(
      "- ダマスカス鋼とヒヒイロカネを温存すべき理由（02_items_and_gacha.md）",
    );
  });

  it("根拠チャンクが 0 件のときは LLM を呼ばずにフォールバック文を返す", async () => {
    const generateSpy = vi.fn<TextGenerator["generate"]>(async () => "推測回答");
    const result = await generateRagAnswer({
      question: "最新の天元たる六色の理の編成を教えて",
      retrievedChunks: [],
      generator: { generate: generateSpy },
    });

    expect(generateSpy).not.toHaveBeenCalled();
    expect(result.hasEvidence).toBe(false);
    expect(result.sources).toEqual([]);
    expect(result.answer).toBe(NO_EVIDENCE_REPLY);
  });

  it("LLM が根拠不足マーカーを返したときも推測せずフォールバック文を返す", async () => {
    const generator: TextGenerator = {
      generate: vi.fn(async () => "[[NO_EVIDENCE]]"),
    };

    const result = await generateRagAnswer({
      question: "特定キャラの最新バランス調整内容は？",
      retrievedChunks: [
        {
          score: 0.35,
          chunk: {
            id: "dummy",
            sourceFile: "03_glossary.md",
            heading: "古戦場（決戦！星の古戦場）とは",
            chunkIndex: 0,
            content: "古戦場は騎空団対抗のイベントです。",
            charCount: 17,
          },
        },
      ],
      generator,
    });

    expect(result.hasEvidence).toBe(false);
    expect(result.answer).toBe(NO_EVIDENCE_REPLY);
  });

  it("システムプロンプトと根拠不足メッセージにビィナビ口調が反映されている", () => {
    const instruction = buildSystemInstruction();
    expect(instruction).toContain("ビィナビ");
    expect(instruction).toContain("オイラ");
    expect(NO_EVIDENCE_REPLY).toContain("オイラ");
    expect(NO_EVIDENCE_REPLY).toContain("ゲーム内のお知らせ");
  });
});
