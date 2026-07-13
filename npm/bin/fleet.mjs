#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const binary = join(dirname(fileURLToPath(import.meta.url)), `fleet${process.platform === "win32" ? ".exe" : ""}`);
const result = spawnSync(binary, process.argv.slice(2), { stdio: "inherit" });
if (result.error) {
  console.error(`fleet: ${result.error.message}. Try reinstalling fleet-cli.`);
  process.exit(1);
}
process.exit(result.status ?? 1);
