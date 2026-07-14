import { readFile } from "node:fs/promises";

const pkg = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8"));
const cargo = await readFile(new URL("../Cargo.toml", import.meta.url), "utf8");
const cargoVersion = cargo.match(/^version\s*=\s*"([^"]+)"/m)?.[1];
if (!cargoVersion) throw new Error("Cargo package version was not found");
if (cargoVersion !== pkg.version) {
  throw new Error(`version mismatch: Cargo ${cargoVersion}, npm ${pkg.version}`);
}
if (process.env.GITHUB_REF_TYPE === "tag") {
  const tagVersion = process.env.GITHUB_REF_NAME?.replace(/^v/, "");
  if (tagVersion !== pkg.version) {
    throw new Error(`tag ${process.env.GITHUB_REF_NAME} does not match package version ${pkg.version}`);
  }
}
console.log(`version metadata verified (${pkg.version})`);
