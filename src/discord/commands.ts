/**
 * Discord スラッシュコマンドの定義一覧。
 * `scripts/register-commands.ts`（Discord API への登録）と
 * `src/routes/interactions.ts`（実行時のハンドリング）の両方で共有します。
 */

import { APPLICATION_COMMAND_OPTION_TYPE } from "./types.js";

/** `/ask` の質問文の最大文字数（API 課金・長文スパム対策） */
export const MAX_ASK_QUESTION_LENGTH = 300;

/** `/word` の検索用語の最大文字数 */
export const MAX_WORD_TERM_LENGTH = 100;

export interface DiscordCommandChoice {
  readonly name: string;
  readonly value: string;
}

export interface DiscordCommandOptionDefinition {
  readonly name: string;
  readonly description: string;
  readonly type: number;
  readonly required: boolean;
  readonly max_length?: number;
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
  { name: "古戦場の全体スケジュールと流れ", value: "gw_flow" },
  { name: "古戦場前の団長・副団長の準備", value: "dancho_prep" },
  { name: "本戦の団アビ管理と撤退判断", value: "dancho_battle" },
  { name: "編成（構成）の基本的な組み方", value: "grid_build" },
  { name: "ダメージ計算の基本（乗算と減衰）", value: "damage_calc" },
  { name: "予測ダメージの見方（主人公のみ基準）", value: "pred_damage" },
  { name: "高難度マルチ共通の基本（V2・予兆）", value: "v2_basics" },
  { name: "十天衆（10天）の加入とおすすめ", value: "eternals" },
  { name: "十賢者の加入とおすすめ", value: "evokers" },
  { name: "各種イベントの進め方（ストイベ等）", value: "events" },
  { name: "おすすめジョブ取得ロードマップ", value: "jobs" },
  { name: "重要武器シリーズ（終末・オメガ等）", value: "weapons" },
  { name: "ランク帯別の目標とやることリスト", value: "rank_guide" },
  { name: "快適設定・倉庫整理・団活の基本", value: "tips" },
];

const PUBLIC_OPTION: DiscordCommandOptionDefinition = {
  name: "public",
  description: "True にするとチャンネルのみんなにも見える形で表示するぜ（省略時は自分だけ表示）",
  type: APPLICATION_COMMAND_OPTION_TYPE.BOOLEAN,
  required: false,
};

export const DISCORD_COMMANDS: readonly DiscordCommandDefinition[] = [
  {
    name: "ask",
    description: "グラブルの疑問をビィナビがナレッジをもとに答えるぜ！",
    options: [
      {
        name: "question",
        description: "知りたいこと（300文字以内。例: ダマスカス鋼は使っていい？、シエテHLの注意点は？）",
        type: APPLICATION_COMMAND_OPTION_TYPE.STRING,
        required: true,
        max_length: MAX_ASK_QUESTION_LENGTH,
      },
      PUBLIC_OPTION,
    ],
  },
  {
    name: "guide",
    description: "初心者ロードマップや古戦場・編成・高難度ガイドをすぐ見せるぜ！",
    options: [
      {
        name: "topic",
        description: "見たいトピック（省略するとトピック一覧を出すぞ！）",
        type: APPLICATION_COMMAND_OPTION_TYPE.STRING,
        required: false,
        choices: GUIDE_TOPIC_CHOICES,
      },
      PUBLIC_OPTION,
    ],
  },
  {
    name: "word",
    description: "グラブルの用語や高難度クエストをメモからすぐ調べるぜ！",
    options: [
      {
        name: "term",
        description: "調べたい用語やクエスト名（100文字以内。例: マグナ、古戦場、シエテHL）",
        type: APPLICATION_COMMAND_OPTION_TYPE.STRING,
        required: true,
        max_length: MAX_WORD_TERM_LENGTH,
      },
      PUBLIC_OPTION,
    ],
  },
];
