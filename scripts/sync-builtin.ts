/**
 * `knowledge/*.md` の内容を `src/knowledge/builtin.ts` へ自動同期するスクリプト。
 *
 * Cloudflare Workers は実行時に `fs.readFileSync` が使えないため、
 * `/guide` や `/word` の即時応答用にこのスクリプトで TypeScript モジュールを生成します。
 *
 * 使い方:
 *   npm run sync-builtin
 */

import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

function main(): void {
  const knowledgeDir = resolve(process.cwd(), "knowledge");
  const targetPath = resolve(process.cwd(), "src/knowledge/builtin.ts");

  const files = readdirSync(knowledgeDir)
    .filter((file) => file.endsWith(".md"))
    .sort();

  if (files.length === 0) {
    throw new Error("knowledge/ ディレクトリに .md ファイルが見つかりません。");
  }

  const docs = files.map((sourceFile) => {
    const markdown = readFileSync(resolve(knowledgeDir, sourceFile), "utf8");
    return { sourceFile, markdown };
  });

  const entriesCode = docs
    .map(
      (doc) =>
        `  {\n    sourceFile: ${JSON.stringify(doc.sourceFile)},\n    markdown: ${JSON.stringify(doc.markdown)},\n  },`,
    )
    .join("\n");

  const output = `/**
 * Cloudflare Workers バンドル内で即時参照できる組み込みナレッジ。
 *
 * Cloudflare Workers 実行環境では \`fs.readFileSync\` が使えないため、
 * \`/guide\` や \`/word\` の即時応答（3秒以内のレスポンスが必須）を確実に返す目的で
 * \`knowledge/*.md\` と同一内容のテキストをバンドルしています。
 *
 * ※ \`knowledge/*.md\` を追加・編集した際は \`npm run sync-builtin\` を実行して同期してください。
 *    \`tests/chunker.test.ts\` で両者の内容が一致していることを自動検証します。
 */

export interface BuiltinKnowledgeDoc {
  readonly sourceFile: string;
  readonly markdown: string;
}

export const BUILTIN_KNOWLEDGE_DOCS: readonly BuiltinKnowledgeDoc[] = [
${entriesCode}
];
`;

  writeFileSync(targetPath, output, "utf8");
  console.log(
    `✅ ${String(docs.length)} 件のナレッジファイルを src/knowledge/builtin.ts へ同期しました。`,
  );
}

main();
