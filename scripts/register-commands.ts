/**
 * Discord スラッシュコマンド（/ask, /guide, /word）を Discord API に一括登録するスクリプト。
 *
 * 必須環境変数（.dev.vars またはシェル環境変数に設定）:
 *   - DISCORD_APPLICATION_ID
 *   - DISCORD_BOT_TOKEN
 * 任意環境変数:
 *   - DISCORD_GUILD_ID（指定するとそのサーバーへ即時反映。未指定ならグローバル登録）
 *
 * 使い方:
 *   - 登録内容の確認のみ（API 呼び出しなし）:
 *       npx tsx scripts/register-commands.ts --dry-run
 *   - Discord へ実際に登録:
 *       npm run register-commands
 */

import { DISCORD_COMMANDS } from "../src/discord/commands.js";
import { loadDevVars } from "./load-env.js";

const DISCORD_API_BASE = "https://discord.com/api/v10";

async function main(): Promise<void> {
  loadDevVars();

  const dryRun = process.argv.includes("--dry-run");
  if (dryRun) {
    console.log("🧪 --dry-run: 以下のコマンド定義が登録対象です:");
    console.log(JSON.stringify(DISCORD_COMMANDS, null, 2));
    return;
  }

  const applicationId = process.env["DISCORD_APPLICATION_ID"]?.trim() ?? "";
  const botToken = process.env["DISCORD_BOT_TOKEN"]?.trim() ?? "";
  const guildId = process.env["DISCORD_GUILD_ID"]?.trim() ?? "";

  if (applicationId.length === 0 || botToken.length === 0) {
    throw new Error(
      "DISCORD_APPLICATION_ID と DISCORD_BOT_TOKEN を .dev.vars または環境変数に設定してください。",
    );
  }

  const endpoint =
    guildId.length > 0
      ? `${DISCORD_API_BASE}/applications/${encodeURIComponent(applicationId)}/guilds/${encodeURIComponent(guildId)}/commands`
      : `${DISCORD_API_BASE}/applications/${encodeURIComponent(applicationId)}/commands`;

  const scopeLabel =
    guildId.length > 0 ? `ギルド限定 (guild_id=${guildId})` : "グローバル";

  console.log(`📡 Discord スラッシュコマンドを登録します（対象: ${scopeLabel}）...`);

  const response = await fetch(endpoint, {
    method: "PUT",
    headers: {
      Authorization: `Bot ${botToken}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(DISCORD_COMMANDS),
  });

  if (!response.ok) {
    const body = await response.text();
    throw new Error(
      `Discord コマンド登録エラー (HTTP ${String(response.status)}): ${body}`,
    );
  }

  const registered = (await response.json()) as ReadonlyArray<{
    readonly id: string;
    readonly name: string;
  }>;

  console.log(`✅ ${String(registered.length)} 件のコマンドを登録しました:`);
  for (const cmd of registered) {
    console.log(`  - /${cmd.name} (id: ${cmd.id})`);
  }
}

main().catch((error: unknown) => {
  console.error("❌ コマンド登録失敗:", error instanceof Error ? error.message : String(error));
  process.exit(1);
});
