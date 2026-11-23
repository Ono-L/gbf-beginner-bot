# AGENTS.md - Google Antigravity / AI エージェント共通開発ルール

このリポジトリ（`gbf-beginner-bot`）で開発・保守を行う Google Antigravity・Claude Code・Gemini を含むすべての AI エージェントは、以下のルールおよびワークスペース共通の `../AGENTS.md` を厳守してください。

## 1. プロジェクト概要・仕様駆動開発（SDD）原則
- グランブルーファンタジー（グラブル）の初心者向け Discord Bot。
- Cloudflare Workers + TypeScript + Hono 上で動作し、Gemini API + Cloudflare Vectorize + Cloudflare D1 を用いた RAG（検索拡張生成）基盤を中心に構築する。
- **仕様・既存設計の遵守**: 実装・変更前に `README.md`・`wrangler.jsonc`・`knowledge/*.md` 等の既存設計を唯一の正本（Single Source of Truth）として確認すること。
- **勝手なライブラリ導入の禁止**: `package.json` に定義されていない外部ライブラリ（axios, Express 等）や不要な依存を合意なく勝手に追加しないこと。
- **未確定事項（TBD）の独断実装禁止**: 未合意の外部サービス連携や課金機能・権限拡張を独断で実装しないこと。

## 2. 厳守事項（セキュリティ・品質・RAG 設計）
1. **スクレイピング・自動アクセス禁止**
   - グラブル本体・公式サイト・外部攻略サイトへの自動アクセスやスクレイピングは一切実装・実行しないこと。
   - 回答の根拠は Discord 内からの入力と本リポジトリの自前ナレッジ（`knowledge/*.md`）のみに限定すること。
2. **シークレット保護**
   - `GEMINI_API_KEY`, `DISCORD_PUBLIC_KEY`, `DISCORD_BOT_TOKEN`, `DISCORD_APPLICATION_ID` などの秘密情報をソースコード、`wrangler.jsonc`、テスト、ログ、Git コミットに絶対に含めないこと。
   - ローカル開発では `.dev.vars`（Git 管理外）を使用し、本番環境では `wrangler secret put` を使用すること。
3. **TypeScript 厳格モード & モジュール分割**
   - `tsconfig.json` で `"strict": true` を維持すること。
   - `any` 型の使用を全面禁止する（テストコード含む）。不明な外部入力は `unknown` として受け取り、型ガードで検証すること。
   - 1 ファイル 200 行以内を目安とし、ルーティング・Discord 署名検証・RAG（chunker / embedder / retriever / answer）・設定を明確に分離すること。
4. **エッジランタイム・DB 安全規約**
   - Workers ランタイム側（`src/`）には Node.js 固有モジュール（`fs`, `path`, `child_process`, Node `crypto` 等）を持ち込まず、暗号・署名検証は標準 Web Crypto API（`crypto.subtle`）を使用すること。
   - Cloudflare D1 操作は必ず Prepared Statement（`env.DB.prepare(...).bind(...)`）を使用し、生の SQL 文字列結合を行わないこと。
5. **Embedding 仕様（Gemini + Vectorize 互換）**
   - Embedding モデルには `gemini-embedding-001` を使用し、必ず `outputDimensionality: 768` を指定すること（Cloudflare Vectorize の次元上限回避のため）。
   - 3072 次元未満を指定する場合は出力ベクトルに対して必ず L2 正規化（`normalizeL2`）を行うこと。
   - 登録時は `taskType: "RETRIEVAL_DOCUMENT"`、検索時は `taskType: "RETRIEVAL_QUERY"` を必ず使い分けること。
6. **ハルシネーション防止・プロンプト安全性**
   - RAG 検索で十分な根拠チャンクが得られない場合は推測で回答せず、「手元ナレッジにないためゲーム内・最新攻略で確認推奨」という旨を返すこと。
   - 回答の末尾には必ず参照したナレッジの見出しを出典として添付すること。
   - ユーザー質問やナレッジ本文を LLM へ渡す際はプロンプトインジェクション対策（構造的隔離・指示の分離）を維持すること。
7. **日本語・学習しやすさ・コミット規約**
   - 応答、設計計画、コード内コメント、ドキュメント、Git コミットメッセージはすべて **日本語** で記述すること。
   - コミットメッセージは Conventional Commits 形式＋日本語本文（例: `feat: ...`, `fix: ...`, `docs: ...`, `test: ...`）に従うこと。
   - 主要モジュール（`chunker`, `embedder`, `retriever`, `answer`, `interactions`）の冒頭には、データの流れが理解できる初心者向けの日本語解説コメントを維持すること。

## 3. 検証・コミット前チェック
変更後は必ず以下を実行しエラー 0 であることを確認したうえで、`git status` で `.dev.vars` や不要な一時ファイルがステージに含まれていないことを確認する。
- `npm run typecheck`
- `npm test`
