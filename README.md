# gbf-beginner-bot

グランブルーファンタジー（グラブル）初心者向けの **RAG（検索拡張生成）搭載 Discord Bot** です。
Cloudflare Workers + TypeScript (`strict: true`) + Hono + Cloudflare Vectorize + Cloudflare D1 + Gemini API で構築しています。

> グラブル本体や外部攻略サイトへの自動アクセス・スクレイピングは一切行わず、Discord 内からの入力と `knowledge/*.md` の自前ナレッジのみで完結する安全設計です。

## アーキテクチャ

```text
[knowledge/*.md]
   │  scripts/ingest.ts (chunker → Gemini gemini-embedding-001, 768次元, L2正規化, RETRIEVAL_DOCUMENT)
   ├─► Cloudflare Vectorize (768次元 / cosine)
   ├─► Cloudflare D1 (knowledge_chunks テーブルに本文保存)
   └─► ローカル検証用 data/local-index.json (Cloudflare 未ログインでも検証可能)

[Discord] ── POST /interactions ──► [Cloudflare Workers + Hono]
                                       ├─ Ed25519 署名検証（不正なら 401）
                                       ├─ PING → PONG
                                       ├─ /guide, /word → 自前ナレッジから即時応答 (type: 4)
                                       └─ /ask → 即座に Deferred (type: 5) を返却
                                                 └─ waitUntil() で RAG 実行 (RETRIEVAL_QUERY)
                                                    → Vectorize + D1 → Gemini 回答生成＋出典付与
                                                    → Discord Webhook PATCH で元メッセージ更新
```

## ローカル検証（Cloudflare ログイン不要）

```bash
# 1. 依存関係のインストール
npm install

# 2. 型チェック・テスト実行
npm run typecheck
npm test

# 3. API キー不要のモック Embedding でローカルインデックス作成＆検索検証
npm run ingest:local:mock
npm run search:local -- "ダマスカス鋼は使っていい？"
npm run search:local -- "天井は何連必要？"
```

`.dev.vars.example` を `.dev.vars` にコピーして `GEMINI_API_KEY` を設定すると、実 Gemini Embedding (`gemini-embedding-001`, 768次元・L2正規化) でローカルインデックスを作成できます。

```bash
cp .dev.vars.example .dev.vars
npm run ingest:local
npm run search:local -- "シェロ訓練の進め方を教えて"
```

## Cloudflare デプロイ手順（準備ができたら）

1. **D1 データベース作成とマイグレーション**
   ```bash
   npx wrangler d1 create gbf-beginner-bot-db
   # 出力された database_id を wrangler.jsonc に設定
   npx wrangler d1 migrations apply gbf-beginner-bot-db --remote
   ```
2. **Vectorize インデックス作成（768次元・コサイン類似度）**
   ```bash
   npx wrangler vectorize create gbf-beginner-bot-index --dimensions=768 --metric=cosine
   ```
3. **シークレット登録**
   ```bash
   npx wrangler secret put GEMINI_API_KEY
   npx wrangler secret put DISCORD_PUBLIC_KEY
   npx wrangler secret put DISCORD_BOT_TOKEN
   npx wrangler secret put DISCORD_APPLICATION_ID
   # 任意（本番推奨）: 許可する Discord サーバー ID をカンマ区切りで指定
   npx wrangler secret put ALLOWED_GUILD_IDS
   ```
4. **ナレッジ登録・デプロイ・スラッシュコマンド登録**
   ```bash
   npx tsx scripts/ingest.ts --mode cloudflare --apply
   npm run deploy
   npm run register-commands
   ```
5. Discord Developer Portal の **Interactions Endpoint URL** に `https://<your-worker>.workers.dev/interactions` を設定すれば完了です。
   - 外部サーバーからの意図しない招待を防ぐため、Discord Developer Portal で **Public Bot を OFF** にしておくことを推奨します。
