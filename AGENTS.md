# AGENTS.md

このリポジトリ（`gbf-beginner-bot`）で開発・保守を行う AI エージェントおよび開発者向けのルールです。

## プロジェクト概要
- グランブルーファンタジー（グラブル）の初心者向け Discord Bot。
- Cloudflare Workers + TypeScript + Hono 上で動作し、Gemini API + Cloudflare Vectorize + Cloudflare D1 を用いた RAG（検索拡張生成）基盤を中心に構築する。

## 厳守事項
1. **スクレイピング・自動アクセス禁止**
   - グラブル本体・公式サイト・外部攻略サイトへの自動アクセスやスクレイピングは一切実装・実行しないこと。
   - 回答の根拠は Discord 内からの入力と本リポジトリの自前ナレッジ（`knowledge/*.md`）のみに限定すること。
2. **シークレット保護**
   - `GEMINI_API_KEY`, `DISCORD_PUBLIC_KEY`, `DISCORD_BOT_TOKEN`, `DISCORD_APPLICATION_ID` などの秘密情報をソースコード、`wrangler.jsonc`、テスト、Git コミットに絶対に含めないこと。
   - ローカル開発では `.dev.vars`（Git 管理外）を使用し、本番環境では `wrangler secret put` を使用すること。
3. **TypeScript 厳格モード**
   - `tsconfig.json` で `"strict": true` を維持すること。
   - `any` 型の使用を禁止する（テストコード含む）。不明な外部入力は `unknown` として受け取り、型ガードで検証すること。
4. **Embedding 仕様（Gemini + Vectorize 互換）**
   - Embedding モデルには `gemini-embedding-001` を使用し、必ず `outputDimensionality: 768` を指定すること（Cloudflare Vectorize の次元上限回避のため）。
   - 3072 次元未満を指定する場合は出力ベクトルに対して必ず L2 正規化（`normalizeL2`）を行うこと。
   - 登録時は `taskType: "RETRIEVAL_DOCUMENT"`、検索時は `taskType: "RETRIEVAL_QUERY"` を必ず使い分けること。
5. **ハルシネーション防止**
   - RAG 検索で十分な根拠チャンクが得られない場合は推測で回答せず、「手元ナレッジにないためゲーム内・最新攻略で確認推奨」という旨を返すこと。
   - 回答の末尾には必ず参照したナレッジの見出しを出典として添付すること。
6. **日本語・学習しやすさ**
   - コード内コメント、ドキュメント、ユーザーへの回答、Git コミットメッセージはすべて日本語で記述すること。
   - コミットメッセージは Conventional Commits 形式（例: `feat: ...`, `fix: ...`, `docs: ...`, `test: ...`）に従うこと。
   - 主要モジュール（`chunker`, `embedder`, `retriever`, `answer`, `interactions`）の冒頭には、データの流れが理解できる初心者向けの日本語解説コメントを維持すること。

## 検証コマンド
変更後は必ず以下を実行し、エラー 0 であることを確認する。
- `npm run typecheck`
- `npm test`
