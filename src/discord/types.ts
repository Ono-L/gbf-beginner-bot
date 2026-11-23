/**
 * Discord Interactions API の最小限かつ厳密な型定義（any 禁止）。
 * 仕様: https://discord.com/developers/docs/interactions/receiving-and-responding
 */

export const INTERACTION_TYPE = {
  PING: 1,
  APPLICATION_COMMAND: 2,
} as const;

export const INTERACTION_RESPONSE_TYPE = {
  /** PING への応答 */
  PONG: 1,
  /** メッセージを即時返答（/guide, /word 用） */
  CHANNEL_MESSAGE_WITH_SOURCE: 4,
  /** 「考え中…」表示を即座に返し、後から Webhook で更新（/ask 用） */
  DEFERRED_CHANNEL_MESSAGE_WITH_SOURCE: 5,
} as const;

export const INTERACTION_RESPONSE_FLAGS = {
  /** コマンドを実行した本人にのみ表示する一時メッセージ（Ephemeral） */
  EPHEMERAL: 1 << 6,
} as const;

export const APPLICATION_COMMAND_OPTION_TYPE = {
  STRING: 3,
  BOOLEAN: 5,
} as const;

export interface DiscordCommandOption {
  readonly name: string;
  readonly type: number;
  readonly value?: string | number | boolean;
}

export interface DiscordApplicationCommandData {
  readonly id?: string;
  readonly name: string;
  readonly options?: readonly DiscordCommandOption[];
}

export interface DiscordInteraction {
  readonly id?: string;
  readonly application_id?: string;
  readonly guild_id?: string;
  readonly type: number;
  readonly token?: string;
  readonly data?: DiscordApplicationCommandData;
}

/**
 * 未知の JSON オブジェクトが DiscordInteraction として扱えるかを検証する型ガード。
 */
export function isDiscordInteraction(value: unknown): value is DiscordInteraction {
  if (typeof value !== "object" || value === null) {
    return false;
  }
  const record = value as Record<string, unknown>;
  return typeof record["type"] === "number";
}

/**
 * スラッシュコマンドの文字列オプションを安全に取り出すヘルパー。
 */
export function getStringOption(
  interaction: DiscordInteraction,
  optionName: string,
): string | undefined {
  const options = interaction.data?.options;
  if (!Array.isArray(options)) {
    return undefined;
  }
  const found = options.find((opt) => opt.name === optionName);
  return typeof found?.value === "string" ? found.value : undefined;
}

/**
 * スラッシュコマンドの真偽値オプションを安全に取り出すヘルパー。
 */
export function getBooleanOption(
  interaction: DiscordInteraction,
  optionName: string,
): boolean | undefined {
  const options = interaction.data?.options;
  if (!Array.isArray(options)) {
    return undefined;
  }
  const found = options.find((opt) => opt.name === optionName);
  return typeof found?.value === "boolean" ? found.value : undefined;
}
