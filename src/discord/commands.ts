/**
 * Discord スラッシュコマンドの定義一覧。
 * `scripts/register-commands.ts`（Discord API への登録）と
 * `src/routes/interactions.ts`（実行時のハンドリング）の両方で共有します。
 */

import { APPLICATION_COMMAND_OPTION_TYPE } from "./types.js";

export interface DiscordCommandChoice {
  readonly name: string;
  readonly value: string;
}

export interface DiscordCommandOptionDefinition {
  readonly name: string;
  readonly description: string;
  readonly type: number;
  readonly required: boolean;
  readonly choices?: readonly DiscordCommandChoice[];
}

export interface DiscordCommandDefinition {
  readonly name: string;
  readonly description: string;
  readonly options?: readonly DiscordCommandOptionDefinition[];
}

export const GUIDE_TOPIC_CHOICES: readonly DiscordCommandChoice[] = [
  { name: "シェロカルテの特別訓練", value: "shero" },
  { name: "マグナ編成の基本", value: "magna" },
  { name: "サイドストーリー優先度", value: "side" },
  { name: "序盤のクラスと日課", value: "daily" },
  { name: "ダマスカス鋼・ヒヒイロカネの温存", value: "dama_hihi" },
  { name: "金剛晶の温存", value: "kongo" },
  { name: "ガチャと天井（300連）", value: "gacha" },
  { name: "フェス待ち（レジェフェス・グラフェス）", value: "fes" },
];

export const DISCORD_COMMANDS: readonly DiscordCommandDefinition[] = [
  {
    name: "ask",
    description: "グラブル初心者向けの質問を RAG ナレッジをもとに回答します",
    options: [
      {
        name: "question",
        description: "知りたいこと（例: ダマスカス鋼は使っていい？、マグナ編成とは？）",
        type: APPLICATION_COMMAND_OPTION_TYPE.STRING,
        required: true,
      },
    ],
  },
  {
    name: "guide",
    description: "初心者ロードマップや貴重アイテム管理のガイドを即時表示します",
    options: [
      {
        name: "topic",
        description: "表示したいトピック（省略するとトピック一覧を表示します）",
        type: APPLICATION_COMMAND_OPTION_TYPE.STRING,
        required: false,
        choices: GUIDE_TOPIC_CHOICES,
      },
    ],
  },
  {
    name: "word",
    description: "グラブルの初心者向け用語をナレッジから即時検索します",
    options: [
      {
        name: "term",
        description: "調べたい用語（例: マグナ、神石、片面、古戦場、ヒヒ掘り）",
        type: APPLICATION_COMMAND_OPTION_TYPE.STRING,
        required: true,
      },
    ],
  },
];
