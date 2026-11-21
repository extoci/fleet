import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { install, installedService } from "./platform.ts";
import { type RunningInfo, configuration, read } from "./state.ts";

const runtime = fileURLToPath(new URL("../", import.meta.url));
const marker = ".fleet-release";

async function download(url: string): Promise<Response> {
  const response = await fetch(url, {
    headers: { "User-Agent": "Fleet" },
    signal: AbortSignal.timeout(60_000),
  });
  if (!response.ok) {
    throw new Error(`GitHub returned HTTP ${response.status} for ${new URL(url).pathname}.`);
  }
  return response;
}

function runningPid(home: string): number | undefined {
  const info = read<RunningInfo | null>(path.join(home, "running.json"), null);
  if (!info) return;
  try {
    process.kill(info.pid, 0);
    return info.pid;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
  }
}

async function refreshService(
  service: NonNullable<ReturnType<typeof installedService>>,
): Promise<void> {
  const previousPid = service.active ? runningPid(service.home) : undefined;
  // Load the platform code from the release that is now installed.
  execFileSync(
    process.execPath,
    [path.join(runtime, "src", "update.ts"), service.home, service.active ? "restart" : "refresh"],
    { stdio: "inherit" },
  );
  if (!service.active) return;
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    const pid = runningPid(service.home);
    if (pid && pid !== previousPid) return;
    await Bun.sleep(200);
  }
  throw new Error("The Fleet daemon did not start.");
}

export async function updateFleet(home: string) {
  const destination = path.resolve(runtime);
  const markerFile = path.join(destination, marker);
  if (!fs.existsSync(markerFile)) {
    throw new Error("Install Fleet from https://fleet.extoci.lol/install to use fleet update.");
  }
  const transaction = `${destination}.update`;
  try {
    fs.mkdirSync(transaction, { mode: 0o700 });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    throw new Error(`A Fleet update is in progress or was interrupted. Check ${transaction}.`, {
      cause: error,
    });
  }

  const staged = path.join(transaction, "next");
  const backup = path.join(transaction, "previous");
  let keepTransaction = false;
  try {
    const repository = fs.readFileSync(markerFile, "utf8").trim();
    if (!/^[\w-]+\/[\w.-]+$/.test(repository) || /\/(?:\.|\.\.)$/.test(repository)) {
      throw new Error("Fleet's installed release source is invalid.");
    }
    const previous = read<{ version: string }>(path.join(destination, "package.json"), {
      version: "",
    }).version;
    const release = await download(`https://api.github.com/repos/${repository}/releases/latest`);
    const { tag_name: tag } = (await release.json()) as { tag_name?: string };
    if (typeof tag !== "string" || !/^v\d+\.\d+\.\d+$/.test(tag)) {
      throw new Error("GitHub did not return a stable Fleet version.");
    }
    const version = tag.slice(1);
    if (Bun.semver.order(version, previous) <= 0) {
      return { updated: false, previous, version: previous };
    }

    process.stderr.write(`Downloading Fleet ${version}...\n`);
    const origin = `https://github.com/${repository}/releases/download/${tag}`;
    const [archiveResponse, checksumResponse] = await Promise.all([
      download(`${origin}/fleet.tar.gz`),
      download(`${origin}/fleet.tar.gz.sha256`),
    ]);
    const [archive, checksum] = await Promise.all([
      archiveResponse.bytes(),
      checksumResponse.text(),
    ]);
    const expected = checksum.trim().split(/\s+/, 1)[0].toLowerCase();
    if (createHash("sha256").update(archive).digest("hex") !== expected) {
      throw new Error("Fleet release checksum did not match.");
    }

    const archiveFile = path.join(transaction, "fleet.tar.gz");
    fs.writeFileSync(archiveFile, archive);
    fs.mkdirSync(staged);
    execFileSync("tar", ["-xzf", archiveFile, "-C", staged]);
    const stagedCli = path.join(staged, "src", "cli.ts");
    const reported = execFileSync(process.execPath, [stagedCli, "--version"], {
      encoding: "utf8",
      timeout: 20_000,
    }).trim();
    if (reported !== `Fleet ${version}`) {
      throw new Error("Fleet release version did not match the download.");
    }
    fs.writeFileSync(path.join(staged, marker), `${repository}\n`);

    const service = installedService();
    for (const state of new Set([home, service?.home || home])) {
      const actualState = fs.existsSync(state) ? fs.realpathSync(state) : state;
      const relative = path.relative(fs.realpathSync(destination), actualState);
      if (
        !relative ||
        (relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative))
      ) {
        throw new Error("Fleet's state directory must be outside the runtime directory to update.");
      }
    }
    if ((!service || !service.active) && runningPid(home)) {
      throw new Error("Stop the foreground Fleet daemon before updating.");
    }

    fs.renameSync(destination, backup);
    let switched = false;
    try {
      fs.renameSync(staged, destination);
      switched = true;
      if (service) await refreshService(service);
    } catch (error) {
      try {
        if (switched) fs.renameSync(destination, staged);
        fs.renameSync(backup, destination);
      } catch (recoveryError) {
        keepTransaction = true;
        throw new Error(
          `Fleet could not restore its runtime. Recovery files are in ${transaction}. ${recoveryError}`,
          {
            cause: recoveryError,
          },
        );
      }
      if (switched && service) {
        try {
          await refreshService(service);
        } catch (recoveryError) {
          throw new Error(
            `Fleet ${previous} was restored. Restart it to finish recovery. ${recoveryError}`,
            {
              cause: recoveryError,
            },
          );
        }
      }
      throw new Error(`Fleet ${previous} was restored after the update failed. ${error}`, {
        cause: error,
      });
    }
    return { updated: true, previous, version };
  } finally {
    if (!keepTransaction) fs.rmSync(transaction, { recursive: true, force: true });
  }
}

if (import.meta.main) {
  const [, , home, action] = process.argv;
  const config = home && configuration(home);
  if (!config) throw new Error("Fleet service configuration is missing.");
  await install(home, config, { active: action === "restart" });
}
