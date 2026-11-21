import { execFileSync, type ExecFileSyncOptions, spawn } from "node:child_process";
import { createHash, X509Certificate } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { authority } from "./certificates.ts";
import { type FleetConfig, read, write } from "./state.ts";

const cli = fileURLToPath(new URL("./cli.ts", import.meta.url));
const helper = fileURLToPath(new URL("./port-helper.ts", import.meta.url));

const run = (exe: string, args: string[], options: ExecFileSyncOptions = {}): string =>
  execFileSync(exe, args, {
    timeout: 20_000,
    encoding: "utf8",
    ...options,
  }) as string;

// sudo, macOS trust changes and Windows root store changes wait for a person
// to answer a prompt, so allow time for it.
const prompted = (exe: string, args: string[], options: ExecFileSyncOptions = {}): string =>
  run(exe, args, { stdio: "inherit", timeout: 600_000, ...options });

const sudo = (args: string[], options: ExecFileSyncOptions = {}): string =>
  prompted("sudo", args, options);

const macHelper = "/Library/PrivilegedHelperTools/dev.fleet.v2";
const macRootName = "Fleet private apps";

// otool -L prints one unindented header per architecture, each followed by
// that slice's indented libraries.
export function nonSystemLibraries(otool: string): string[] {
  const libraries = otool
    .split("\n")
    .filter((line) => /^\s/.test(line))
    .map((line) => line.trim().split(" (")[0])
    .filter(
      (library) => library && !library.startsWith("/usr/lib/") && !library.startsWith("/System/"),
    );
  return [...new Set(libraries)];
}

export function keychainHashes(output: string): string[] {
  return [...output.matchAll(/^SHA-1 hash: ([0-9A-F]{40})$/gm)].map((match) => match[1]);
}

const runtimeHelp = "Reinstall Bun, then run fleet setup --install with that Bun installation.";

export function libraryRpaths(output: string): string[] {
  return [
    ...new Set(
      [...output.matchAll(/\bcmd LC_RPATH\s+cmdsize \d+\s+path (.+) \(offset \d+\)/g)].map(
        (match) => match[1],
      ),
    ),
  ];
}

export function libraryCandidates(
  reference: string,
  image: string,
  executable: string,
  rpaths: string[] = [],
): string[] {
  const expand = (value: string): string => {
    if (value === "@loader_path") return path.posix.dirname(image);
    if (value.startsWith("@loader_path/")) {
      return path.posix.resolve(path.posix.dirname(image), value.slice(13));
    }
    if (value === "@executable_path") return path.posix.dirname(executable);
    if (value.startsWith("@executable_path/")) {
      return path.posix.resolve(path.posix.dirname(executable), value.slice(17));
    }
    if (path.posix.isAbsolute(value)) return value;
    throw new Error(`Unsupported library path: ${value}`);
  };
  return reference.startsWith("@rpath/")
    ? rpaths.map((rpath) => path.posix.join(expand(rpath), reference.slice(7)))
    : [expand(reference)];
}

function libraryIds(output: string): string[] {
  return [...output.matchAll(/\bcmd LC_ID_DYLIB\s+cmdsize \d+\s+name (.+) \(offset \d+\)/g)].map(
    (match) => match[1],
  );
}

export function stageMacRuntime(directory: string, source = process.execPath): void {
  const executable = fs.realpathSync(source);
  const images = new Map<string, Map<string, string>>();
  const visit = (file: string) => {
    if (images.has(file)) return;
    const references = new Map<string, string>();
    images.set(file, references);
    const commands = run("otool", ["-l", file]);
    const rpaths = libraryRpaths(commands);
    const ids = libraryIds(commands);
    for (const reference of nonSystemLibraries(run("otool", ["-L", file]))) {
      if (ids.includes(reference)) continue;
      const candidate = libraryCandidates(reference, file, executable, rpaths).find((item) =>
        fs.existsSync(item),
      );
      if (!candidate) throw new Error(`Cannot resolve ${reference} from ${file}`);
      const dependency = fs.realpathSync(candidate);
      references.set(reference, dependency);
      visit(dependency);
    }
  };
  visit(executable);
  const destination = path.join(directory, "bun");
  fs.copyFileSync(executable, destination);
  fs.chmodSync(destination, 0o755);
  if (images.size === 1 && !(images.get(executable)?.size ?? 0)) return;
  const names = new Set<string>();
  for (const file of images.keys()) {
    if (file === executable) continue;
    const name = path.basename(file);
    if (names.has(name)) throw new Error(`Conflicting library basename: ${name}`);
    names.add(name);
  }
  fs.mkdirSync(path.join(directory, "lib"), { mode: 0o700 });
  for (const [file, references] of images) {
    const target =
      file === executable ? destination : path.join(directory, "lib", path.basename(file));
    if (file !== executable) fs.copyFileSync(file, target);
    fs.chmodSync(target, 0o755);
    const architectures = run("lipo", ["-archs", file]).trim().split(/\s+/);
    const slices: string[] = [];
    for (const arch of architectures) {
      const slice = `${target}.${arch}`;
      if (architectures.length > 1) run("lipo", [target, "-thin", arch, "-output", slice]);
      else fs.copyFileSync(target, slice);
      fs.chmodSync(slice, 0o755);
      const args: string[] = [];
      const commands = run("otool", ["-l", slice]);
      const ids = libraryIds(commands);
      for (const reference of nonSystemLibraries(run("otool", ["-L", slice]))) {
        if (ids.includes(reference)) continue;
        const dependency = references.get(reference);
        if (!dependency) continue;
        args.push(
          "-change",
          reference,
          `@rpath/${dependency === executable ? "../bun" : path.basename(dependency)}`,
        );
      }
      for (const rpath of libraryRpaths(commands)) args.push("-delete_rpath", rpath);
      args.push("-add_rpath", file === executable ? "@loader_path/lib" : "@loader_path");
      if (file !== executable) args.push("-id", `@rpath/${path.basename(file)}`);
      run("install_name_tool", [...args, slice]);
      slices.push(slice);
    }
    if (slices.length > 1) run("lipo", ["-create", ...slices, "-output", target]);
    else fs.copyFileSync(slices[0], target);
    for (const slice of slices) fs.unlinkSync(slice);
    run("codesign", ["--force", "--sign", "-", target]);
  }
  checkMacLibraries(directory);
}

function checkMacLibraries(directory: string): void {
  const libraries = path.join(directory, "lib");
  const files = [
    path.join(directory, "bun"),
    ...(fs.existsSync(libraries)
      ? fs.readdirSync(libraries).map((name) => path.join(libraries, name))
      : []),
  ];
  const rootDir = fs.realpathSync(directory) + path.sep;
  for (const file of files) {
    const references = nonSystemLibraries(run("otool", ["-L", file]));
    if (!references.length) continue;
    const expected = file === files[0] ? "@loader_path/lib" : "@loader_path";
    const rpaths = libraryRpaths(run("otool", ["-l", file]));
    if (rpaths.some((rpath) => rpath !== expected)) {
      throw new Error(`Unsafe library search path in ${file}`);
    }
    for (const reference of references) {
      if (!reference.startsWith("@rpath/") && !reference.startsWith("@loader_path/")) {
        throw new Error(`Unsafe library reference: ${reference}`);
      }
      const candidates = libraryCandidates(reference, file, files[0], rpaths);
      if (
        !candidates.length ||
        candidates.some((candidate) => !fs.realpathSync(candidate).startsWith(rootDir))
      ) {
        throw new Error(`Library escapes boot helper: ${reference}`);
      }
    }
  }
}

function checkInstalledRuntime(executable: string): void {
  if (process.platform === "darwin") checkMacLibraries(path.dirname(executable));
  let version: string;
  try {
    version = run(executable, ["--version"]).trim();
  } catch (error) {
    const err = error as { stderr?: string; message?: string };
    throw new Error(
      `Fleet's boot helper cannot start its copy of Bun (${executable}): ${String(err.stderr || err.message).trim()} ${runtimeHelp}`,
      { cause: error },
    );
  }
  const expected = typeof Bun !== "undefined" ? Bun.version : process.version;
  if (version !== expected) {
    throw new Error(`Fleet's copy of Bun reports ${version}, expected ${expected}. ${runtimeHelp}`);
  }
}

function macResolverActive(): boolean {
  try {
    return /^\s*domain\s*:\s*fleet\s*$/m.test(run("scutil", ["--dns"]));
  } catch {
    return false;
  }
}

async function refreshMacResolver(): Promise<void> {
  if (macResolverActive()) return;
  // configd only notices /etc/resolver when the directory existed at its
  // start. launchd restarts it right away.
  try {
    sudo(["killall", "configd"], { stdio: "ignore" });
  } catch {
    // Best-effort restart if configd is already restarting.
  }
  for (let i = 0; i < 25 && !macResolverActive(); i++) {
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
}

const xml = (s: unknown): string =>
  String(s).replace(
    /[<>&"']/g,
    (c) =>
      ({
        "<": "&lt;",
        ">": "&gt;",
        "&": "&amp;",
        '"': "&quot;",
        "'": "&apos;",
      })[c] ?? c,
  );

const systemd = (s: unknown): string =>
  `"${String(s).replace(
    /[%\\"\n\r]/g,
    (c) => ({ "%": "%%", "\\": "\\\\", '"': '\\"', "\n": "\\n", "\r": "\\r" })[c] ?? c,
  )}"`;

const ps = (s: unknown): string => `'${String(s).replace(/'/g, "''")}'`;

function browserDatabases(): string[] {
  const databases = [
    path.join(os.homedir(), ".pki", "nssdb"),
    path.join(os.homedir(), ".local", "share", "pki", "nssdb"),
  ];
  const firefox = path.join(os.homedir(), ".mozilla", "firefox");
  if (fs.existsSync(firefox)) {
    for (const entry of fs.readdirSync(firefox, { withFileTypes: true })) {
      if (entry.isDirectory() && fs.existsSync(path.join(firefox, entry.name, "cert9.db"))) {
        databases.push(path.join(firefox, entry.name));
      }
    }
  }
  return databases;
}

function browserRoot(pki: { certFile: string }, remove = false): void {
  const nickname = `Fleet v2 ${new X509Certificate(fs.readFileSync(pki.certFile)).fingerprint256.replace(/:/g, "").slice(0, 16)}`;
  for (const database of browserDatabases()) {
    if (!remove) {
      fs.mkdirSync(database, { recursive: true, mode: 0o700 });
      if (!fs.existsSync(path.join(database, "cert9.db"))) {
        run("certutil", ["-N", "-d", `sql:${database}`, "--empty-password"]);
      }
      run("certutil", [
        "-A",
        "-d",
        `sql:${database}`,
        "-n",
        nickname,
        "-t",
        "C,,",
        "-i",
        pki.certFile,
      ]);
    } else if (fs.existsSync(path.join(database, "cert9.db"))) {
      try {
        run("certutil", ["-D", "-d", `sql:${database}`, "-n", nickname]);
      } catch {
        // Ignore entries already removed from this browser profile.
      }
    }
  }
}

export function windowsInstaller(
  home: string,
  config: Pick<FleetConfig, "addresses" | "mode">,
): string {
  const user = `${process.env.USERDOMAIN || os.hostname()}\\${os.userInfo().username}`;
  return `$ErrorActionPreference='Stop'\n$trigger=New-ScheduledTaskTrigger -AtStartup\n$principal=New-ScheduledTaskPrincipal -UserId ${ps(user)} -LogonType S4U -RunLevel Limited\n$settings=New-ScheduledTaskSettingsSet -RestartCount 5 -RestartInterval (New-TimeSpan -Minutes 1) -ExecutionTimeLimit ([TimeSpan]::Zero) -StartWhenAvailable -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries\n$env:FLEET_V2_HOME=${ps(home)}\n$action=New-ScheduledTaskAction -Execute ${ps(process.execPath)} -Argument ${ps(`"${cli}" daemon --home "${home}"`)}\nStop-ScheduledTask -TaskName FleetV2 -ErrorAction SilentlyContinue\nRegister-ScheduledTask -TaskName FleetV2 -Action $action -Trigger $trigger -Principal $principal -Settings $settings -Force | Out-Null\nGet-NetFirewallRule -DisplayName 'Fleet v2 HTTPS','Fleet v2 DNS UDP','Fleet v2 DNS TCP' -ErrorAction SilentlyContinue | Remove-NetFirewallRule\nNew-NetFirewallRule -DisplayName 'Fleet v2 HTTPS' -Direction Inbound -Action Allow -Protocol TCP -LocalPort ${config.mode === "node" ? 42174 : 443} -LocalAddress ${config.addresses.map(ps).join(",")} -RemoteAddress '100.64.0.0/10','fd7a:115c:a1e0::/48' -Program ${ps(process.execPath)} | Out-Null\nNew-NetFirewallRule -DisplayName 'Fleet v2 DNS TCP' -Direction Inbound -Action Allow -Protocol TCP -LocalPort 53 -LocalAddress ${config.addresses.map(ps).join(",")} -RemoteAddress '100.64.0.0/10','fd7a:115c:a1e0::/48' -Program ${ps(process.execPath)} | Out-Null\nNew-NetFirewallRule -DisplayName 'Fleet v2 DNS UDP' -Direction Inbound -Action Allow -Protocol UDP -LocalPort 53 -LocalAddress ${config.addresses.map(ps).join(",")} -RemoteAddress '100.64.0.0/10','fd7a:115c:a1e0::/48' -Program ${ps(process.execPath)} | Out-Null\nStart-ScheduledTask -TaskName FleetV2\n`;
}

function tailscaleCandidates(platform = process.platform): string[] {
  return platform === "win32"
    ? [
        path.join(process.env.ProgramFiles || "C:\\Program Files", "Tailscale", "tailscale.exe"),
        "tailscale.exe",
      ]
    : platform === "darwin"
      ? [
          "/Applications/Tailscale.app/Contents/MacOS/Tailscale",
          "/usr/local/bin/tailscale",
          "/opt/homebrew/bin/tailscale",
          "tailscale",
        ]
      : ["tailscale", "/usr/bin/tailscale"];
}

export function tailscaleApprovalUrl(output: string): string | null {
  const match = String(output || "").match(/https:\/\/login\.tailscale\.com\/[^\s"'<>]+/i);
  return match ? match[0].replace(/[.,;)]+$/, "") : null;
}

export function tailscaleFailureMessage(
  output: string,
  {
    retryCommand = "fleet phone",
    timedOut = false,
    approvalUrl = tailscaleApprovalUrl(output),
    user = os.userInfo().username,
  }: {
    retryCommand?: string;
    timedOut?: boolean;
    approvalUrl?: string | null;
    user?: string;
  } = {},
): string {
  const detail = String(output || "").trim();
  if (/serve config denied|access denied|--operator=/i.test(detail)) {
    return `Tailscale does not allow this user to manage Serve routes yet.\nRun once:\n  sudo tailscale set --operator=${user}\nThen run ${retryCommand} again.`;
  }
  if (timedOut) {
    if (approvalUrl) {
      return `Timed out waiting for Tailscale Serve approval.\nOpen this link to enable it:\n  ${approvalUrl}\nThen run ${retryCommand} again.`;
    }
    return `Timed out waiting for Tailscale. Check that Tailscale is connected and Serve is enabled on your tailnet, then run ${retryCommand} again.`;
  }
  if (approvalUrl) {
    return `Tailscale Serve needs to be enabled once on your tailnet.\nOpen this link in your browser and click Enable:\n  ${approvalUrl}\nThen run ${retryCommand} again.`;
  }
  if (/https.*not enabled|enable https/i.test(detail)) {
    return `Enable HTTPS certificates in https://login.tailscale.com/admin/dns, then run ${retryCommand} again.`;
  }
  return `Tailscale is unavailable. Connect Tailscale, then retry.${detail ? ` ${detail}` : ""}`;
}

export function tailscale(
  args: string[],
  options: { executable?: string; retryCommand?: string } = {},
): string {
  const candidates = options.executable ? [options.executable] : tailscaleCandidates();
  let last: (NodeJS.ErrnoException & { stdout?: string; stderr?: string }) | undefined;
  for (const exe of candidates) {
    try {
      return run(exe, args, {
        env: { ...process.env, TAILSCALE_BE_CLI: "1" },
        maxBuffer: 2_000_000,
        stdio: ["ignore", "pipe", "pipe"],
      });
    } catch (e) {
      last = e as NodeJS.ErrnoException & { stdout?: string; stderr?: string };
      if (last.code !== "ENOENT") break;
    }
  }
  if (last?.code === "ENOENT") {
    throw new Error(
      "Tailscale is not installed. Install it from https://tailscale.com/download, sign in, then retry.",
    );
  }
  const output = String(last?.stderr || last?.stdout || last?.message || "");
  throw new Error(
    tailscaleFailureMessage(output, {
      retryCommand: options.retryCommand,
      timedOut: last?.code === "ETIMEDOUT",
    }),
  );
}

export async function tailscaleServe(
  args: string[],
  options: {
    executable?: string;
    timeout?: number;
    retryCommand?: string;
    onNotice?: (message: string) => void;
  } = {},
): Promise<string> {
  const candidates = options.executable ? [options.executable] : tailscaleCandidates();
  const timeout = options.timeout ?? 300_000;
  const onNotice = options.onNotice || ((message: string) => process.stderr.write(`${message}\n`));
  let lastError: NodeJS.ErrnoException | undefined;
  for (const exe of candidates) {
    try {
      return await new Promise<string>((resolve, reject) => {
        const child = spawn(exe, args, {
          env: { ...process.env, TAILSCALE_BE_CLI: "1" },
          stdio: ["ignore", "pipe", "pipe"],
        });
        let output = "";
        let approvalUrl: string | null = null;
        let timedOut = false;
        const timer = setTimeout(() => {
          timedOut = true;
          child.kill("SIGTERM");
        }, timeout);
        const onData = (chunk: Buffer) => {
          output += chunk.toString("utf8");
          if (!approvalUrl) {
            const url = tailscaleApprovalUrl(output);
            if (url) {
              approvalUrl = url;
              onNotice(
                `Tailscale Serve needs to be enabled once on your tailnet.\nOpen this link in your browser and click Enable:\n  ${url}\nWaiting for approval... (press Ctrl+C to cancel)`,
              );
            }
          }
        };
        child.stdout.on("data", onData);
        child.stderr.on("data", onData);
        child.on("error", (error) => {
          clearTimeout(timer);
          reject(error);
        });
        child.on("close", (code) => {
          clearTimeout(timer);
          if (code === 0 && !timedOut) {
            resolve(output);
            return;
          }
          reject(
            new Error(
              tailscaleFailureMessage(output, {
                retryCommand: options.retryCommand,
                timedOut,
                approvalUrl,
              }),
            ),
          );
        });
      });
    } catch (error) {
      lastError = error as NodeJS.ErrnoException;
      if (lastError.code !== "ENOENT") break;
    }
  }
  if (lastError?.code === "ENOENT") {
    throw new Error(
      "Tailscale is not installed. Install it from https://tailscale.com/download, sign in, then retry.",
    );
  }
  throw lastError;
}

interface PhoneServeRecord {
  port: number;
  host: string;
  proxy: string;
  expires?: number;
}

export async function turnOffPhoneRoute(
  home: string,
  options: {
    runTailscale?: (args: string[]) => Promise<string>;
    retryCommand?: string;
    timeout?: number;
  } = {},
): Promise<{ removed: boolean; reason?: string }> {
  const file = path.join(home, "phone-serve.json");
  const own = read<PhoneServeRecord | null>(file, null);
  if (!own) return { removed: false, reason: "missing" };
  const runTailscale =
    options.runTailscale ||
    ((args: string[]) =>
      tailscaleServe(args, {
        retryCommand: options.retryCommand || "fleet phone off",
        timeout: options.timeout ?? 20_000,
        onNotice: () => {
          // Non-interactive cleanup does not prompt for approval.
        },
      }));
  const current = JSON.parse(await runTailscale(["serve", "status", "--json"])) as {
    Web?: Record<string, { Handlers?: Record<string, { Proxy?: string }> }>;
  };
  const handlers = current.Web?.[`${own.host}:8444`]?.Handlers;
  if (!handlers || Object.keys(handlers).length !== 1 || handlers["/"]?.Proxy !== own.proxy) {
    throw new Error("The setup route has changed. Fleet did not remove it.");
  }
  await runTailscale(["serve", "--https=8444", "off"]);
  fs.rmSync(file, { force: true });
  return { removed: true };
}

export function tailnet(): { addresses: string[]; dnsName: string; userId?: number } {
  const state = JSON.parse(tailscale(["status", "--json"])) as {
    BackendState?: string;
    Self?: { TailscaleIPs?: string[]; DNSName?: string; UserID?: number };
  };
  if (state.BackendState !== "Running" || !state.Self?.TailscaleIPs?.length) {
    throw new Error("Connect Tailscale before setting up Fleet.");
  }
  return {
    addresses: state.Self.TailscaleIPs,
    dnsName: state.Self.DNSName?.replace(/\.$/, "") || "",
    userId: state.Self.UserID,
  };
}

export async function ensureDNS(
  address: string | undefined,
  token = process.env.FLEET_TAILSCALE_TOKEN,
): Promise<{ configured: boolean }> {
  if (!token || !address) return { configured: false };
  const url = "https://api.tailscale.com/api/v2/tailnet/-/dns/split-dns";
  const headers = {
    Authorization: `Bearer ${token}`,
    "Content-Type": "application/json",
  };
  const response = await fetch(url, {
    headers,
    signal: AbortSignal.timeout(10000),
  });
  if (!response.ok) {
    throw new Error(
      `Tailscale DNS authorization failed (${response.status}). Use a credential with the dns scope or add the fleet rule in the admin console.`,
    );
  }
  const map = (await response.json()) as Record<string, string[] | undefined>;
  if (map.fleet?.length && !map.fleet.includes(address)) {
    throw new Error(
      "The tailnet already has a fleet DNS rule for another computer. Fleet did not change it. Join that Fleet or remove the old rule first.",
    );
  }
  if (!map.fleet?.includes(address)) {
    const changed = await fetch(url, {
      method: "PATCH",
      headers,
      body: JSON.stringify({ fleet: [address] }),
      signal: AbortSignal.timeout(10000),
    });
    if (!changed.ok) {
      throw new Error(`Tailscale did not accept the fleet DNS rule (${changed.status}).`);
    }
  }
  const check = await fetch(url, {
    headers,
    signal: AbortSignal.timeout(10000),
  });
  const verified = check.ok ? ((await check.json()) as Record<string, string[] | undefined>) : null;
  if (!verified?.fleet?.includes(address)) {
    throw new Error("Tailscale DNS read-back failed. Check the fleet rule in the admin console.");
  }
  return { configured: true };
}

export function openBrowser(url: string): void {
  const child =
    process.platform === "darwin"
      ? spawn("open", [url], { stdio: "ignore", detached: true })
      : process.platform === "win32"
        ? spawn("rundll32.exe", ["url.dll,FileProtocolHandler", url], {
            stdio: "ignore",
            detached: true,
          })
        : spawn("xdg-open", [url], { stdio: "ignore", detached: true });
  child.on("error", () => {
    // Ignore browser launch failures on headless machines.
  });
  child.unref();
}

export function serviceFiles(
  home: string,
  config: Pick<FleetConfig, "addresses" | "mode">,
  platform = process.platform,
) {
  const destination = platform === "darwin" ? macHelper : "/usr/local/lib/fleet-v2";
  const helperConfig = {
    uid: process.getuid?.(),
    gid: process.getgid?.(),
    home,
    userHome: os.homedir(),
    runtime: process.execPath,
    cli,
    addresses: config.addresses,
    mode: config.mode,
  };
  const servicePath = platform === "darwin" ? path.posix : path;
  const executable = servicePath.join(destination, "bun");
  const helperPath = servicePath.join(destination, "ports.ts");
  const configPath = servicePath.join(destination, "owner.json");
  const macArguments = [executable, helperPath, configPath];
  if (platform === "darwin") {
    return {
      destination,
      helperConfig,
      file: "/Library/LaunchDaemons/dev.fleet.v2.plist",
      content: `<?xml version="1.0" encoding="UTF-8"?><!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd"><plist version="1.0"><dict><key>Label</key><string>dev.fleet.v2</string><key>ProgramArguments</key><array>${macArguments.map((a) => `<string>${xml(a)}</string>`).join("")}</array><key>RunAtLoad</key><true/><key>KeepAlive</key><true/><key>StandardOutPath</key><string>${xml(servicePath.join(destination, "daemon.log"))}</string><key>StandardErrorPath</key><string>${xml(servicePath.join(destination, "daemon.log"))}</string></dict></plist>`,
    };
  }
  return {
    destination,
    helperConfig,
    file: "/etc/systemd/system/fleet-v2.service",
    content: `[Unit]\nDescription=Fleet private apps\nAfter=network-online.target tailscaled.service\nWants=network-online.target\n[Service]\nExecStart=${[executable, helperPath, configPath].map(systemd).join(" ")}\nRestart=on-failure\nRestartSec=3\nUMask=0077\n[Install]\nWantedBy=multi-user.target\n`,
  };
}

export async function install(home: string, config: FleetConfig): Promise<void> {
  const pki = authority(home);
  if (config.mode === "node" && config.gateway) {
    pki.certFile = path.join(home, "pki", "gateway-root.pem");
    write(pki.certFile, config.gateway.ca);
  }
  if (process.platform === "win32") {
    process.stderr.write("Approve the Windows security warning to trust Fleet's certificate.\n");
    prompted("certutil.exe", ["-user", "-addstore", "Root", pki.certFile], {
      stdio: ["inherit", "ignore", "inherit"],
    });
    const file = path.join(home, "install-windows.ps1");
    write(file, windowsInstaller(home, config));
    run(
      "powershell.exe",
      [
        "-NoProfile",
        "-Command",
        `$p=Start-Process powershell.exe -Verb RunAs -Wait -PassThru -ArgumentList ${ps(`-NoProfile -ExecutionPolicy Bypass -File "${file}"`)}; exit $p.ExitCode`,
      ],
      { stdio: "inherit", timeout: 120_000 },
    );
    return;
  }
  const files = serviceFiles(home, config);
  if (process.getuid?.() === 0) {
    throw new Error(
      "Run Fleet setup as your normal user. It uses sudo only to install the port helper.",
    );
  }
  const staging = fs.mkdtempSync(path.join(os.tmpdir(), "fleet-install-"));
  fs.chmodSync(staging, 0o700);
  try {
    write(path.join(staging, "owner.json"), files.helperConfig);
    write(path.join(staging, "service"), files.content);
    if (process.platform === "darwin") {
      stageMacRuntime(staging);
    }
    // Elevated code is copied to root-owned storage. The privileged listener
    // must not execute a runtime binary or helper writable by the app owner.
    sudo(["install", "-d", "-m", "755", files.destination]);
    if (process.platform === "darwin") {
      sudo(["rm", "-rf", path.join(files.destination, "lib")]);
      if (fs.existsSync(path.join(staging, "lib"))) {
        sudo(["install", "-d", "-m", "755", path.join(files.destination, "lib")]);
        for (const name of fs.readdirSync(path.join(staging, "lib"))) {
          sudo([
            "install",
            "-m",
            "755",
            path.join(staging, "lib", name),
            path.join(files.destination, "lib", name),
          ]);
        }
      }
    }
    for (const [source, destination, mode] of [
      [process.platform === "darwin" ? path.join(staging, "bun") : process.execPath, "bun", "755"],
      [helper, "ports.ts", "644"],
      [path.join(staging, "owner.json"), "owner.json", "600"],
    ]) {
      sudo(["install", "-m", mode, source, path.join(files.destination, destination)]);
    }
    checkInstalledRuntime(path.join(files.destination, "bun"));
    sudo(["install", "-m", "644", path.join(staging, "service"), files.file]);
    if (process.platform === "darwin") {
      sudo([
        "security",
        "add-trusted-cert",
        "-d",
        "-r",
        "trustRoot",
        "-k",
        "/Library/Keychains/System.keychain",
        pki.certFile,
      ]);
      try {
        sudo(["launchctl", "bootout", "system/dev.fleet.v2"], {
          stdio: "ignore",
        });
      } catch {
        // Service may not be loaded on first install.
      }
      sudo(["launchctl", "bootstrap", "system", files.file]);
      // macOS uses this suffix-specific file and keeps existing VPN/default DNS.
      const resolver = path.join(staging, "resolver");
      write(
        resolver,
        `# Fleet v2\nnameserver ${config.mode === "node" && config.gateway ? config.gateway.address : "127.0.0.1"}\n`,
      );
      if (
        fs.existsSync("/etc/resolver/fleet") &&
        !fs.readFileSync("/etc/resolver/fleet", "utf8").startsWith("# Fleet v2\n")
      ) {
        throw new Error("/etc/resolver/fleet already belongs to another tool.");
      }
      sudo(["mkdir", "-p", "/etc/resolver"]);
      sudo(["install", "-m", "644", resolver, "/etc/resolver/fleet"]);
      await refreshMacResolver();
    } else {
      const rootCopy = "/usr/local/share/ca-certificates/fleet-v2.crt";
      sudo(["install", "-m", "644", pki.certFile, rootCopy]);
      sudo(["update-ca-certificates"]);
      try {
        run("certutil", ["-H"], { stdio: "ignore" });
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") {
          sudo(["apt-get", "install", "--yes", "libnss3-tools"]);
        }
      }
      browserRoot(pki);
      sudo(["systemctl", "daemon-reload"]);
      sudo(["systemctl", "enable", "fleet-v2.service"]);
      sudo(["systemctl", "restart", "fleet-v2.service"]);
      // Tailscale's tailnet split DNS supplies the suffix on Linux and Windows.
      // Do not replace resolv.conf or add a second manager for tailscale0.
    }
  } finally {
    fs.rmSync(staging, { recursive: true, force: true });
  }
}

export function uninstall(home: string): void {
  if (process.platform === "win32") {
    try {
      run("schtasks.exe", ["/End", "/TN", "FleetV2"]);
    } catch {
      // Task may already be stopped.
    }
    try {
      run("schtasks.exe", ["/Delete", "/F", "/TN", "FleetV2"]);
    } catch {
      // Task may already be removed.
    }
    const ca = authority(home);
    const installedConfig = read<Partial<FleetConfig>>(path.join(home, "config.json"), {});
    const pemSource =
      installedConfig.mode === "node" && installedConfig.gateway
        ? installedConfig.gateway.ca
        : ca.pem;
    // certutil accepts the exact SHA-1 certificate thumbprint for removal.
    const pem = pemSource.replace(/-----[^-]+-----|\s/g, "");
    const cleanup = path.join(home, "uninstall-windows.ps1");
    write(
      cleanup,
      "$ErrorActionPreference='Stop'\nStop-ScheduledTask -TaskName FleetV2 -ErrorAction SilentlyContinue\nUnregister-ScheduledTask -TaskName FleetV2 -Confirm:$false -ErrorAction SilentlyContinue\nGet-NetFirewallRule -DisplayName 'Fleet v2 HTTPS','Fleet v2 DNS UDP','Fleet v2 DNS TCP' -ErrorAction SilentlyContinue | Remove-NetFirewallRule\n",
    );
    run(
      "powershell.exe",
      [
        "-NoProfile",
        "-Command",
        `$p=Start-Process powershell.exe -Verb RunAs -Wait -PassThru -ArgumentList ${ps(`-NoProfile -ExecutionPolicy Bypass -File "${cleanup}"`)}; exit $p.ExitCode`,
      ],
      { stdio: "inherit", timeout: 120_000 },
    );
    prompted(
      "certutil.exe",
      [
        "-user",
        "-delstore",
        "Root",
        createHash("sha1").update(Buffer.from(pem, "base64")).digest("hex"),
      ],
      { stdio: ["inherit", "ignore", "inherit"] },
    );
    return;
  }
  const installedConfig = read<Partial<FleetConfig>>(path.join(home, "config.json"), {});
  const installedRoot =
    installedConfig.mode === "node"
      ? path.join(home, "pki", "gateway-root.pem")
      : authority(home).certFile;
  const files = serviceFiles(home, {
    addresses: installedConfig.addresses ?? [],
    mode: installedConfig.mode,
  });
  if (process.platform === "darwin") {
    try {
      sudo(["launchctl", "bootout", "system/dev.fleet.v2"]);
    } catch {
      // Service may not be loaded.
    }
    if (
      fs.existsSync("/etc/resolver/fleet") &&
      fs.readFileSync("/etc/resolver/fleet", "utf8").startsWith("# Fleet v2\n")
    ) {
      sudo(["rm", "/etc/resolver/fleet"]);
    }
    if (fs.existsSync(installedRoot)) {
      try {
        sudo(["security", "remove-trusted-cert", "-d", installedRoot]);
      } catch {
        // Certificate may already be untrusted.
      }
    }
    // Each setup adds a copy of the root; remove every copy Fleet created.
    let found = "";
    try {
      found = run("security", [
        "find-certificate",
        "-a",
        "-c",
        macRootName,
        "-Z",
        "/Library/Keychains/System.keychain",
      ]);
    } catch {
      // Keychain may have no matching certificates.
    }
    for (const hash of new Set(keychainHashes(found))) {
      sudo(["security", "delete-certificate", "-Z", hash, "/Library/Keychains/System.keychain"]);
    }
  } else {
    try {
      sudo(["systemctl", "disable", "--now", "fleet-v2.service"]);
    } catch {
      // Service may not exist.
    }
    sudo(["rm", "-f", "/usr/local/share/ca-certificates/fleet-v2.crt"]);
    sudo(["update-ca-certificates"]);
    browserRoot({ certFile: installedRoot }, true);
  }
  sudo(["rm", "-f", files.file]);
  sudo(["rm", "-rf", files.destination]);
}
