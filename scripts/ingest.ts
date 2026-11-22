/**
 * ナレッジベース（knowledge/*.md）をチャンク分割＆ベクトル化し、
 * ローカル JSON インデックスまたは Cloudflare（Vectorize + D1）へ登録するスクリプト。
 *
 * 使い方:
 *   - ローカル検証（Gemini Embedding 使用）:
 *       npm run ingest:local
 *   - ローカル検証（API キー不要のモック Embedding 使用）:
 *       npm run ingest:local:mock
 *   - Cloudflare 登録用ファイル生成（NDJSON + D1 SQL）:
 *       npm run ingest:cloudflare
 *   - 生成したファイルをそのまま Wrangler でリモート反映:
 *       npx tsx scripts/ingest.ts --mode cloudflare --apply
 */

import { execFileSync } from "node:child_process";
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import {
  buildEmbeddingText,
  chunkMarkdown,
  type KnowledgeChunk,
} from "../src/rag/chunker.js";
import {
  EMBEDDING_DIMENSIONS,
  EMBEDDING_MODEL,
  createGeminiEmbedder,
  createLocalHashEmbedder,
  type Embedder,
} from "../src/rag/embedder.js";
import type { IndexedChunk, LocalVectorIndex } from "../src/rag/retriever.js";
import { loadDevVars } from "./load-env.js";

type IngestMode = "local" | "cloudflare";

interface CliOptions {
  readonly mode: IngestMode;
  readonly mockEmbed: boolean;
  readonly apply: boolean;
  readonly maxChars: number;
}

function parseArgs(argv: readonly string[]): CliOptions {
  let mode: IngestMode = "local";
  let mockEmbed = false;
  let apply = false;
  let maxChars = 450;

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--mode") {
      const next = argv[i + 1];
      if (next === "local" || next === "cloudflare") {
        mode = next;
        i += 1;
      } else {
        throw new Error(`--mode は local または cloudflare を指定してください: ${String(next)}`);
      }
    } else if (arg === "--mock-embed") {
      mockEmbed = true;
    } else if (arg === "--apply") {
      apply = true;
    } else if (arg === "--max-chars") {
      const parsed = Number.parseInt(argv[i + 1] ?? "", 10);
      if (Number.isNaN(parsed) || parsed <= 0) {
        throw new Error("--max-chars には正の整数を指定してください。");
      }
      maxChars = parsed;
      i += 1;
    }
  }

  return { mode, mockEmbed, apply, maxChars };
}

function loadKnowledgeChunks(knowledgeDir: string, maxChars: number): KnowledgeChunk[] {
  const files = readdirSync(knowledgeDir)
    .filter((file) => file.endsWith(".md"))
    .sort();

  const allChunks: KnowledgeChunk[] = [];
  for (const file of files) {
    const fullPath = join(knowledgeDir, file);
    const markdown = readFileSync(fullPath, "utf8");
    const chunks = chunkMarkdown(markdown, file, { maxChars });
    allChunks.push(...chunks);
  }
  return allChunks;
}

function escapeSqlString(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

function buildD1SeedSql(chunks: readonly KnowledgeChunk[]): string {
  const statements: string[] = [
    "-- scripts/ingest.ts により自動生成された D1 チャンク登録 SQL",
    "DELETE FROM knowledge_chunks;",
  ];

  for (const chunk of chunks) {
    statements.push(
      `INSERT OR REPLACE INTO knowledge_chunks (id, source_file, heading, chunk_index, content, char_count) VALUES (${escapeSqlString(chunk.id)}, ${escapeSqlString(chunk.sourceFile)}, ${escapeSqlString(chunk.heading)}, ${String(chunk.chunkIndex)}, ${escapeSqlString(chunk.content)}, ${String(chunk.charCount)});`,
    );
  }

  return `${statements.join("\n")}\n`;
}

function buildVectorizeNdjson(entries: readonly IndexedChunk[]): string {
  return (
    entries
      .map((entry) =>
        JSON.stringify({
          id: entry.chunk.id,
          values: entry.vector,
          metadata: {
            sourceFile: entry.chunk.sourceFile,
            heading: entry.chunk.heading,
            chunkIndex: entry.chunk.chunkIndex,
          },
        }),
      )
      .join("\n") + "\n"
  );
}

async function main(): Promise<void> {
  loadDevVars();
  const options = parseArgs(process.argv.slice(2));
  const cwd = process.cwd();
  const knowledgeDir = resolve(cwd, "knowledge");
  const dataDir = resolve(cwd, "data");
  mkdirSync(dataDir, { recursive: true });

  const chunks = loadKnowledgeChunks(knowledgeDir, options.maxChars);
  console.log(`📚 ナレッジ読み込み完了: ${String(chunks.length)} チャンク（上限 ${String(options.maxChars)} 文字）`);
  for (const chunk of chunks) {
    console.log(
      `  - [${chunk.id}] ${chunk.sourceFile} > ${chunk.heading} (${String(chunk.charCount)}文字)`,
    );
  }

  let embedder: Embedder;
  let modelLabel: string;

  if (options.mockEmbed) {
    if (options.mode === "cloudflare") {
      throw new Error("--mode cloudflare では --mock-embed は使用できません。GEMINI_API_KEY を設定してください。");
    }
    embedder = createLocalHashEmbedder(EMBEDDING_DIMENSIONS);
    modelLabel = "local-hash-768";
    console.log("🧪 ローカル検証モード: 決定論的ハッシュ Embedder (768次元・L2正規化) を使用します。");
  } else {
    const apiKey = process.env["GEMINI_API_KEY"] ?? "";
    if (apiKey.trim().length === 0) {
      throw new Error(
        "GEMINI_API_KEY が未設定です。.dev.vars に設定するか、API キー不要のローカル検証を行う場合は `npm run ingest:local:mock` を実行してください。",
      );
    }
    embedder = createGeminiEmbedder({ apiKey });
    modelLabel = EMBEDDING_MODEL;
    console.log(`✨ Gemini Embedding (${EMBEDDING_MODEL}, ${String(EMBEDDING_DIMENSIONS)}次元・L2正規化・RETRIEVAL_DOCUMENT) でベクトル化します...`);
  }

  const entries: IndexedChunk[] = [];
  for (const chunk of chunks) {
    const textForEmbedding = buildEmbeddingText(chunk);
    // 登録時は必ず RETRIEVAL_DOCUMENT を指定する
    const vector = await embedder.embed(textForEmbedding, "RETRIEVAL_DOCUMENT");
    entries.push({ chunk, vector });
  }

  if (options.mode === "local") {
    const indexPath = resolve(dataDir, "local-index.json");
    const indexPayload: LocalVectorIndex = {
      model: modelLabel,
      dimensions: EMBEDDING_DIMENSIONS,
      normalizedL2: true,
      createdAt: new Date().toISOString(),
      entries,
    };
    writeFileSync(indexPath, JSON.stringify(indexPayload, null, 2), "utf8");
    console.log(`✅ ローカルインデックスを保存しました: ${indexPath}`);
    console.log('🔎 検索確認コマンド例: npm run search:local -- "ダマスカス鋼は使っていい？"');
    return;
  }

  // Cloudflare Vectorize + D1 投入用ファイル生成
  const ndjsonPath = resolve(dataDir, "vectorize-upload.ndjson");
  const sqlPath = resolve(dataDir, "d1-seed.sql");

  writeFileSync(ndjsonPath, buildVectorizeNdjson(entries), "utf8");
  writeFileSync(sqlPath, buildD1SeedSql(chunks), "utf8");

  console.log(`✅ Vectorize 投入用 NDJSON を生成しました: ${ndjsonPath}`);
  console.log(`✅ D1 投入用 SQL を生成しました: ${sqlPath}`);

  if (options.apply) {
    console.log("🚀 Wrangler を使って Cloudflare D1 / Vectorize へ反映します...");
    execFileSync(
      "npx",
      ["wrangler", "d1", "execute", "gbf-beginner-bot-db", "--remote", "--file", sqlPath],
      { stdio: "inherit" },
    );
    execFileSync(
      "npx",
      ["wrangler", "vectorize", "upsert", "gbf-beginner-bot-index", "--file", ndjsonPath],
      { stdio: "inherit" },
    );
    console.log("🎉 Cloudflare D1 と Vectorize への登録が完了しました！");
  } else {
    console.log("\n次のコマンドで Cloudflare へ反映できます:");
    console.log(`  npx wrangler d1 execute gbf-beginner-bot-db --remote --file ${sqlPath}`);
    console.log(`  npx wrangler vectorize upsert gbf-beginner-bot-index --file ${ndjsonPath}`);
  }
}

main().catch((error: unknown) => {
  console.error("❌ ingest 失敗:", error instanceof Error ? error.message : String(error));
  process.exit(1);
});
