/**
 * ローカル JSON インデックス (`data/local-index.json`) に対して
 * コサイン類似度検索を実行し、RAG の検索精度を手元で確認するための CLI。
 *
 * 使い方:
 *   npm run ingest:local:mock
 *   npm run search:local -- "ダマスカス鋼は使っていい？"
 */

import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  EMBEDDING_DIMENSIONS,
  createGeminiEmbedder,
  createLocalHashEmbedder,
} from "../src/rag/embedder.js";
import {
  createInMemoryRetriever,
  type LocalVectorIndex,
} from "../src/rag/retriever.js";
import { loadDevVars } from "./load-env.js";

async function main(): Promise<void> {
  loadDevVars();

  const query = process.argv.slice(2).join(" ").trim();
  if (query.length === 0) {
    console.error('使い方: npm run search:local -- "質問文"');
    process.exit(1);
  }

  const indexPath = resolve(process.cwd(), "data/local-index.json");
  if (!existsSync(indexPath)) {
    console.error(
      "ローカルインデックスが見つかりません。先に `npm run ingest:local` または `npm run ingest:local:mock` を実行してください。",
    );
    process.exit(1);
  }

  const indexData = JSON.parse(
    readFileSync(indexPath, "utf8"),
  ) as LocalVectorIndex;

  const embedder =
    indexData.model === "local-hash-768"
      ? createLocalHashEmbedder(EMBEDDING_DIMENSIONS)
      : createGeminiEmbedder({
          apiKey: process.env["GEMINI_API_KEY"] ?? "",
        });

  const retriever = createInMemoryRetriever(indexData.entries, embedder);
  // ハッシュベースのモック検証時はコサイン類似度が小さめに出るため閾値を調整
  const minScore = indexData.model === "local-hash-768" ? 0.05 : 0.25;
  const results = await retriever.retrieve(query, { topK: 4, minScore });

  console.log(`🔎 クエリ: 「${query}」（インデックスモデル: ${indexData.model}）`);
  if (results.length === 0) {
    console.log("該当するチャンクが見つかりませんでした。");
    return;
  }

  results.forEach((item, idx) => {
    const preview =
      item.chunk.content.length > 90
        ? `${item.chunk.content.slice(0, 90)}…`
        : item.chunk.content;
    console.log(
      `\n#${String(idx + 1)} [score=${item.score.toFixed(4)}] ${item.chunk.sourceFile} > ${item.chunk.heading}`,
    );
    console.log(`   ${preview}`);
  });
}

main().catch((error: unknown) => {
  console.error("❌ 検索失敗:", error instanceof Error ? error.message : String(error));
  process.exit(1);
});
