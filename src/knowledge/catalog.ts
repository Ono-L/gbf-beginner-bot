/**
 * `/guide [topic]` と `/word <term>` 用の即時参照ナレッジカタログ。
 *
 * LLM や外部 API を呼ばずに手元ナレッジからミリ秒単位で応答できるため、
 * Discord Interactions の 3 秒応答ルールに対して確実に即時返答できます。
 */

import { chunkMarkdown, type KnowledgeChunk } from "../rag/chunker.js";
import { NO_EVIDENCE_REPLY } from "../rag/answer.js";
import { BUILTIN_KNOWLEDGE_DOCS } from "./builtin.js";

interface GuideTopicSpec {
  readonly key: string;
  readonly label: string;
  readonly keywords: readonly string[];
}

const GUIDE_TOPICS: readonly GuideTopicSpec[] = [
  {
    key: "shero",
    label: "シェロカルテの特別訓練",
    keywords: ["シェロ", "特別訓練", "訓練"],
  },
  {
    key: "magna",
    label: "マグナ編成の基本",
    keywords: ["マグナ編成の基本", "方陣", "マグナ"],
  },
  {
    key: "side",
    label: "サイドストーリー優先度",
    keywords: ["サイドストーリー", "サイド", "ギアス", "どうして空は蒼いのか"],
  },
  {
    key: "daily",
    label: "序盤のクラスと日課",
    keywords: ["クラス", "ジョブ", "日課", "ダークフェンサー", "レリックバスター"],
  },
  {
    key: "dama_hihi",
    label: "ダマスカス鋼・ヒヒイロカネの温存",
    keywords: ["ダマスカス", "ヒヒイロカネ", "ダマ", "ヒヒ"],
  },
  {
    key: "kongo",
    label: "金剛晶の温存",
    keywords: ["金剛晶", "こんごう", "金剛"],
  },
  {
    key: "gacha",
    label: "ガチャと天井（300連）",
    keywords: ["天井", "300連", "ガチャ", "御印"],
  },
  {
    key: "fes",
    label: "フェス待ち（レジェフェス・グラフェス）",
    keywords: ["フェス", "レジェンドフェス", "グランデフェス", "レジェフェス", "グラフェス"],
  },
  {
    key: "gw_flow",
    label: "古戦場の全体スケジュールと基本の流れ",
    keywords: ["全体スケジュール", "古戦場の全体", "予選", "インターバル"],
  },
  {
    key: "dancho_prep",
    label: "古戦場開催前の団長・副団長の準備",
    keywords: ["開催前に団長", "団長・副団長", "騎空艇", "団サポ"],
  },
  {
    key: "dancho_battle",
    label: "本戦での団アビ管理と撤退・勝負の判断",
    keywords: ["団アビ管理", "撤退", "勝負の判断", "時速"],
  },
];

let cachedAllChunks: readonly KnowledgeChunk[] | null = null;

/**
 * 組み込みナレッジ全ファイルをチャンク化してキャッシュ取得する。
 */
export function getBuiltinKnowledgeChunks(): readonly KnowledgeChunk[] {
  if (cachedAllChunks === null) {
    cachedAllChunks = BUILTIN_KNOWLEDGE_DOCS.flatMap((doc) =>
      chunkMarkdown(doc.markdown, doc.sourceFile),
    );
  }
  return cachedAllChunks;
}

function normalizeQuery(text: string): string {
  return text.trim().toLowerCase().replace(/\s+/g, "");
}

function formatChunkResponse(chunk: KnowledgeChunk): string {
  return [
    `**${chunk.heading}**`,
    "",
    chunk.content,
    "",
    `📚 **参照ナレッジ**: ${chunk.heading}（${chunk.sourceFile}）`,
  ].join("\n");
}

/**
 * `/guide [topic]` 用の応答テキストを生成する。
 * `topic` が省略された場合はトピック一覧を返す。
 */
export function buildGuideReply(topic?: string): string {
  const chunks = getBuiltinKnowledgeChunks();
  const guideChunks = chunks.filter(
    (chunk) =>
      chunk.sourceFile === "01_beginner_roadmap.md" ||
      chunk.sourceFile === "02_items_and_gacha.md" ||
      chunk.sourceFile === "04_guild_war_and_dancho.md",
  );

  if (topic === undefined || topic.trim().length === 0) {
    const listLines = GUIDE_TOPICS.map(
      (item) => `- \`${item.key}\` : ${item.label}`,
    );
    return [
      "📘 **グラブル初心者ガイド一覧**",
      "気になるトピックを指定して `/guide topic:<名前>` を実行してください。",
      "",
      ...listLines,
      "",
      "自由に質問したい場合は `/ask question:<質問内容>` も使えます！",
    ].join("\n");
  }

  const normalized = normalizeQuery(topic);

  // 1. 定義済みトピックキー完全一致
  const spec = GUIDE_TOPICS.find(
    (item) =>
      item.key === normalized ||
      item.keywords.some((kw) => normalizeQuery(kw) === normalized),
  );

  if (spec !== undefined) {
    const matched = guideChunks.find((chunk) =>
      spec.keywords.some((kw) =>
        normalizeQuery(chunk.heading).includes(normalizeQuery(kw)),
      ),
    );
    if (matched !== undefined) {
      return formatChunkResponse(matched);
    }
  }

  // 2. 見出し・本文への部分一致フォールバック
  const partialMatched = guideChunks.find(
    (chunk) =>
      normalizeQuery(chunk.heading).includes(normalized) ||
      normalizeQuery(chunk.content).includes(normalized),
  );
  if (partialMatched !== undefined) {
    return formatChunkResponse(partialMatched);
  }

  return [
    `指定されたトピック「${topic.trim()}」は手元のガイドに見つかりませんでした。`,
    NO_EVIDENCE_REPLY,
    "",
    "ヒント: `/guide` を引数なしで実行すると、閲覧可能なトピック一覧を確認できます。",
  ].join("\n");
}

/**
 * `/word <term>` 用の応答テキストを生成する。
 * 用語集（03_glossary.md）を優先しつつ、全ナレッジから検索する。
 */
export function buildWordReply(term: string): string {
  const trimmed = term.trim();
  if (trimmed.length === 0) {
    return "調べたい用語を入力してください（例: `/word term:マグナ`、`/word term:古戦場`）。";
  }

  const normalized = normalizeQuery(trimmed);
  const chunks = getBuiltinKnowledgeChunks();
  const glossaryChunks = chunks.filter(
    (chunk) => chunk.sourceFile === "03_glossary.md",
  );
  const otherChunks = chunks.filter(
    (chunk) => chunk.sourceFile !== "03_glossary.md",
  );

  // 優先順位: (1) 用語集の見出し一致 → (2) 用語集の本文一致 → (3) 他ナレッジの見出し/本文一致
  const matched =
    glossaryChunks.find((c) => normalizeQuery(c.heading).includes(normalized)) ??
    glossaryChunks.find((c) => normalizeQuery(c.content).includes(normalized)) ??
    otherChunks.find((c) => normalizeQuery(c.heading).includes(normalized)) ??
    otherChunks.find((c) => normalizeQuery(c.content).includes(normalized));

  if (matched !== undefined) {
    return formatChunkResponse(matched);
  }

  const availableTerms = glossaryChunks.map((c) => `・${c.heading}`).join("\n");
  return [
    `用語「${trimmed}」は手元のナレッジベースに見つかりませんでした。`,
    NO_EVIDENCE_REPLY,
    "",
    "📖 **現在収録している主な用語見出し**",
    availableTerms,
  ].join("\n");
}
