import { spawnSync } from "node:child_process";

const packed = spawnSync("npm", ["pack", "--dry-run", "--json"], {
  encoding: "utf8",
  env: { ...process.env, npm_config_loglevel: "silent" },
});
if (packed.status !== 0) {
  process.stderr.write(packed.stderr);
  process.exit(packed.status ?? 1);
}
const result = JSON.parse(packed.stdout)[0];
const files = result.files.map(file => file.path);
for (const native of ["npm/bin/fleet", "npm/bin/fleet.exe"]) {
  if (files.includes(native)) throw new Error(`native build artifact leaked into package: ${native}`);
}
if (!files.includes("npm/bin/fleet.mjs")) throw new Error("npm launcher is missing from package");
console.log(`npm package contents verified (${files.length} files)`);
