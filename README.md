# gbf-beginner-bot

グランブルーファンタジー（グラブル）初心者向けの **RAG（検索拡張生成）搭載 Discord Bot** です。
Cloudflare Workers + TypeScript (`strict: true`) + Hono + Cloudflare Vectorize + Cloudflare D1 + Gemini API で構築しています。

> グラブル本体や外部攻略サイトへの自動アクセス・スクレイピングは一切行わず、Discord 内からの入力と `knowledge/*.md`（16 本の自前ナレッジ）のみで完結する安全設計です。
>
> 関連リポジトリ: [ai-travel-planner（ポートフォリオ & SDD）](https://github.com/Ono-L/ai-travel-planner) / [epaper-dashboard](https://github.com/Ono-L/epaper-dashboard) / [GitHub プロフィール (@Ono-L)](https://github.com/Ono-L)

---

## 設計のこだわり・技術的見どころ

1. **Vectorize 次元上限と検索精度を両立する Embedding 設計**
   - `gemini-embedding-001` を `outputDimensionality: 768` で呼び出し、3072 次元未満出力に必須の **L2 正規化（`normalizeL2`）** を適用。
   - インデックス登録時（`RETRIEVAL_DOCUMENT`）と質問検索時（`RETRIEVAL_QUERY`）で `taskType` を明確に使い分け、ベクトル検索（Cloudflare Vectorize）と本文チャンク取得（Cloudflare D1）を責務分離しています。
2. **Discord の 3 秒応答制約へのエッジ非同期対応**
   - `/ask` 受信時は即座に Deferred（`type: 5`）を返却し、Cloudflare Workers の `waitUntil()` 内で RAG 検索・Gemini 生成を実行して Discord Webhook `PATCH` で回答を更新します。
   - デフォルトは本人のみ閲覧可能な **Ephemeral 応答**とし、チャンネルを汚さず質問できる UX（共有時のみ `public` オプション指定）を実現しています。
3. **モデル自動フォールバック & 3 重のハルシネーション抑制**
   - Gemini API が `404 / 429 / 5xx` やタイムアウト（15 秒）を返した場合、フォールバックモデル候補へ自動切替し、`thought` パートを除外して回答を安定生成します（API キーは `x-goog-api-key` ヘッダー送信）。
   - ①低スコアチャンク除外、②根拠チャンク 0 件時は LLM を呼ばず定型返答、③LLM 根拠不足時の `[[NO_EVIDENCE]]` マーカー検知＋出典見出し自動付与により、推測回答を防ぎます。
4. **セキュリティ & テスト（Vitest 5 スイート / 27 テスト）**
   - Discord Interactions の **Ed25519 署名検証**（Web Crypto API）および `ALLOWED_GUILD_IDS` による許可サーバー制限。
   - ユーザー質問を `<user_question>` タグで隔離・サニタイズする OWASP LLM01（プロンプトインジェクション）対策。
   - TypeScript `strict: true`（テストコード含め `any` 全面禁止）、Cloudflare 未ログインでも動作するローカル検索検証モードを完備。

---

## アーキテクチャ

```text
[knowledge/*.md (16本)]
   │  scripts/ingest.ts (chunker → Gemini gemini-embedding-001, 768次元, L2正規化, RETRIEVAL_DOCUMENT)
   ├─► Cloudflare Vectorize (768次元 / cosine)
   ├─► Cloudflare D1 (knowledge_chunks テーブルに本文保存)
   └─► ローカル検証用 data/local-index.json (Cloudflare 未ログインでも検証可能)

[Discord] ── POST /interactions ──► [Cloudflare Workers + Hono]
                                       ├─ Ed25519 署名検証（不正なら 401）
                                       ├─ PING → PONG
                                       ├─ /guide, /word → 自前ナレッジから即時応答 (type: 4 / Ephemeral)
                                       └─ /ask → 即座に Deferred (type: 5 / Ephemeral) を返却
                                                 └─ waitUntil() で RAG 実行 (RETRIEVAL_QUERY)
                                                    → Vectorize + D1 → Gemini 回答生成（自動フォールバック＋出典付与）
                                                    → Discord Webhook PATCH で元メッセージ更新
```

---

## ローカル検証（Cloudflare ログイン不要）

```bash
# 1. 依存関係のインストール
npm install

# 2. 型チェック・自動テスト実行（5 テストスイート / 27 テスト）
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

---

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
