// Runs Bun's native linter (`bun lint`). On Bun 1.4.5 (before `bun lint`
// landed in 1.4.6), delegates to `bunx bun@canary lint` without recursing
// into package.json's "lint" script.
const help = Bun.spawnSync([process.execPath, "--help"], {
  stdout: "pipe",
  stderr: "pipe",
});
const hasBuiltinLint = /^\s+lint\s+/m.test(help.stdout.toString());
const args = process.argv.slice(2);
const cmd = hasBuiltinLint
  ? [process.execPath, "lint", "--no-script", ...args]
  : [process.execPath, "x", "bun@canary", "lint", "--no-script", ...args];

const result = Bun.spawnSync(cmd, {
  stdio: ["inherit", "inherit", "inherit"],
});
process.exit(result.exitCode ?? 1);
