/**
 * ローカル開発用 `.dev.vars` ローダー（スクリプト共通ユーティリティ）。
 * 既に設定済みの `process.env` を上書きしない安全な読み込みを行います。
 */

import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

export function loadDevVars(cwd: string = process.cwd()): void {
  const devVarsPath = resolve(cwd, ".dev.vars");
  if (!existsSync(devVarsPath)) {
    return;
  }

  const content = readFileSync(devVarsPath, "utf8");
  for (const rawLine of content.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (line.length === 0 || line.startsWith("#")) {
      continue;
    }

    const eqIndex = line.indexOf("=");
    if (eqIndex <= 0) {
      continue;
    }

    const key = line.slice(0, eqIndex).trim();
    let value = line.slice(eqIndex + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }

    if (process.env[key] === undefined) {
      process.env[key] = value;
    }
  }
}
