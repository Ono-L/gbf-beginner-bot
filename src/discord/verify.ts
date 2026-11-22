/**
 * Discord Interactions の Ed25519 署名検証モジュール。
 *
 * Discord はすべての Webhook リクエストに以下のヘッダを付与します:
 *   - X-Signature-Ed25519: 16進数文字列（64バイト = 128文字）の署名
 *   - X-Signature-Timestamp: タイムスタンプ文字列
 *
 * 署名対象は `timestamp + rawBody`（UTF-8 バイト列）です。
 * Cloudflare Workers および Node.js 20+ の Web Crypto API は
 * ネイティブで Ed25519 をサポートしているため、外部依存なしで安全に検証できます。
 */

export interface VerifyDiscordRequestParams {
  readonly publicKeyHex: string;
  readonly signatureHex: string | null;
  readonly timestamp: string | null;
  readonly rawBody: string;
}

/**
 * 16進数文字列を Uint8Array に変換する。
 * 不正な文字や奇数長・想定バイト数不一致の場合は null を返す。
 */
export function hexToBytes(
  hex: string,
  expectedByteLength?: number,
): Uint8Array | null {
  const trimmed = hex.trim();
  if (trimmed.length === 0 || trimmed.length % 2 !== 0) {
    return null;
  }
  if (!/^[0-9a-fA-F]+$/.test(trimmed)) {
    return null;
  }

  const byteLength = trimmed.length / 2;
  if (expectedByteLength !== undefined && byteLength !== expectedByteLength) {
    return null;
  }

  const bytes = new Uint8Array(byteLength);
  for (let i = 0; i < byteLength; i += 1) {
    const pair = trimmed.slice(i * 2, i * 2 + 2);
    bytes[i] = Number.parseInt(pair, 16);
  }
  return bytes;
}

/**
 * Ed25519 公開鍵を使って Discord からのリクエスト署名を検証する。
 * 検証失敗・ヘッダ欠落・フォーマット不正はすべて false を返す。
 */
export async function verifyDiscordSignature(
  params: VerifyDiscordRequestParams,
): Promise<boolean> {
  const { publicKeyHex, signatureHex, timestamp, rawBody } = params;

  if (signatureHex === null || timestamp === null || timestamp.length === 0) {
    return false;
  }

  const publicKeyBytes = hexToBytes(publicKeyHex, 32);
  const signatureBytes = hexToBytes(signatureHex, 64);
  if (publicKeyBytes === null || signatureBytes === null) {
    return false;
  }

  try {
    const cryptoKey = await crypto.subtle.importKey(
      "raw",
      publicKeyBytes,
      { name: "Ed25519" },
      false,
      ["verify"],
    );

    const messageBytes = new TextEncoder().encode(`${timestamp}${rawBody}`);
    return await crypto.subtle.verify(
      "Ed25519",
      cryptoKey,
      signatureBytes,
      messageBytes,
    );
  } catch {
    return false;
  }
}
