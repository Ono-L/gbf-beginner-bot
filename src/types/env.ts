/**
 * Cloudflare Workers バインディングと環境変数（シークレット含む）の型定義。
 *
 * `wrangler types` 実行後は `worker-configuration.d.ts` が生成されます。
 * シークレット（GEMINI_API_KEY 等）は `.dev.vars` や `wrangler secret put` で
 * 注入されるため、ここでは未設定の可能性も考慮してオプショナル型にしています。
 */
export interface AppEnv {
  /** 本文チャンク保存用の Cloudflare D1 バインディング */
  readonly DB?: D1Database;
  /** 768次元ベクトル検索用の Cloudflare Vectorize バインディング */
  readonly VECTORIZE?: VectorizeIndex;
  /** 回答生成に使う Gemini モデル名（wrangler.jsonc の vars で設定） */
  readonly GEMINI_MODEL?: string;
  /** Gemini API キー（シークレット: wrangler secret put GEMINI_API_KEY） */
  readonly GEMINI_API_KEY?: string;
  /** Discord アプリケーションの Ed25519 公開鍵（シークレット） */
  readonly DISCORD_PUBLIC_KEY?: string;
  /** Discord Bot トークン（コマンド登録等で使用） */
  readonly DISCORD_BOT_TOKEN?: string;
  /** Discord Application ID */
  readonly DISCORD_APPLICATION_ID?: string;
}
