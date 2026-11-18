import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync, spawn } from "node:child_process";
import { X509Certificate } from "node:crypto";
import { write, read } from "./state.mjs";
import { authority } from "./certificates.mjs";

const cli = fileURLToPath(new URL("./cli.mjs", import.meta.url));
const helper = fileURLToPath(new URL("./port-helper.mjs", import.meta.url));
const run = (exe, args, options = {}) =>
  execFileSync(exe, args, { timeout: 20_000, encoding: "utf8", ...options });
// sudo, macOS trust changes and Windows root store changes wait for a person
// to answer a prompt, so allow time for it.
const prompted = (exe, args, options = {}) =>
  run(exe, args, { stdio: "inherit", timeout: 600_000, ...options });
const sudo = (args, options = {}) => prompted("sudo", args, options);
const macHelper = "/Library/PrivilegedHelperTools/dev.fleet.v2";
const macRootName = "Fleet private apps";
export function nonSystemLibraries(otool) {
  return otool
    .split("\n")
    .slice(1)
    .map((line) => line.trim().split(" (")[0])
    .filter(
      (library) =>
        library &&
        !library.startsWith("/usr/lib/") &&
        !library.startsWith("/System/"),
    );
}
export function keychainHashes(output) {
  return [...output.matchAll(/^SHA-1 hash: ([0-9A-F]{40})$/gm)].map(
    (match) => match[1],
  );
}
const nodeHelp =
  "Install Node.js from https://nodejs.org (or a standalone build from nvm or fnm), then run fleet setup --install with that Node.js.";
function checkStandaloneNode() {
  if (process.platform !== "darwin") return;
  let libraries;
  try {
    libraries = nonSystemLibraries(run("otool", ["-L", process.execPath]));
  } catch {
    return;
  }
  if (libraries.length)
    throw new Error(
      `This Node.js (${process.execPath}) loads ${libraries.join(", ")}. Fleet's boot helper runs a private copy of Node.js and cannot use these libraries. Homebrew's Node.js is built this way. ${nodeHelp}`,
    );
}
function checkInstalledNode(executable) {
  let version;
  try {
    version = run(executable, ["--version"]).trim();
  } catch (error) {
    throw new Error(
      `Fleet's boot helper cannot start its copy of Node.js (${executable}): ${String(error.stderr || error.message).trim()} ${nodeHelp}`,
    );
  }
  if (version !== process.version)
    throw new Error(
      `Fleet's copy of Node.js reports ${version}, expected ${process.version}. ${nodeHelp}`,
    );
}
function macResolverActive() {
  try {
    return /^\s*domain\s*:\s*fleet\s*$/m.test(run("scutil", ["--dns"]));
  } catch {
    return false;
  }
}
async function refreshMacResolver() {
  if (macResolverActive()) return;
  // configd only notices /etc/resolver when the directory existed at its
  // start. launchd restarts it right away.
  try {
    sudo(["killall", "configd"], { stdio: "ignore" });
  } catch {}
  for (let i = 0; i < 25 && !macResolverActive(); i++)
    await new Promise((resolve) => setTimeout(resolve, 200));
}
const xml = (s) =>
  String(s).replace(
    /[<>&"']/g,
    (c) =>
      ({
        "<": "&lt;",
        ">": "&gt;",
        "&": "&amp;",
        '"': "&quot;",
        "'": "&apos;",
      })[c],
  );
const systemd = (s) =>
  `"${String(s).replace(/[%\\"\n\r]/g, (c) => ({ "%": "%%", "\\": "\\\\", '"': '\\"', "\n": "\\n", "\r": "\\r" })[c])}"`;
const ps = (s) => `'${String(s).replace(/'/g, "''")}'`;
function browserDatabases() {
  const databases = [
    path.join(os.homedir(), ".pki", "nssdb"),
    path.join(os.homedir(), ".local", "share", "pki", "nssdb"),
  ];
  const firefox = path.join(os.homedir(), ".mozilla", "firefox");
  if (fs.existsSync(firefox))
    for (const entry of fs.readdirSync(firefox, { withFileTypes: true }))
      if (
        entry.isDirectory() &&
        fs.existsSync(path.join(firefox, entry.name, "cert9.db"))
      )
        databases.push(path.join(firefox, entry.name));
  return databases;
}
function browserRoot(pki, remove = false) {
  const nickname = `Fleet v2 ${new X509Certificate(fs.readFileSync(pki.certFile)).fingerprint256.replace(/:/g, "").slice(0, 16)}`;
  for (const database of browserDatabases()) {
    if (!remove) {
      fs.mkdirSync(database, { recursive: true, mode: 0o700 });
      if (!fs.existsSync(path.join(database, "cert9.db")))
        run("certutil", ["-N", "-d", `sql:${database}`, "--empty-password"]);
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
      } catch {}
    }
  }
}
export function windowsInstaller(home, config) {
  const user = `${process.env.USERDOMAIN || os.hostname()}\\${os.userInfo().username}`;
  return `$ErrorActionPreference='Stop'\n$trigger=New-ScheduledTaskTrigger -AtStartup\n$principal=New-ScheduledTaskPrincipal -UserId ${ps(user)} -LogonType S4U -RunLevel Limited\n$settings=New-ScheduledTaskSettingsSet -RestartCount 5 -RestartInterval (New-TimeSpan -Minutes 1) -ExecutionTimeLimit ([TimeSpan]::Zero) -StartWhenAvailable -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries\n$env:FLEET_V2_HOME=${ps(home)}\n$action=New-ScheduledTaskAction -Execute ${ps(process.execPath)} -Argument ${ps(`"${cli}" daemon --home "${home}"`)}\nStop-ScheduledTask -TaskName FleetV2 -ErrorAction SilentlyContinue\nRegister-ScheduledTask -TaskName FleetV2 -Action $action -Trigger $trigger -Principal $principal -Settings $settings -Force | Out-Null\nGet-NetFirewallRule -DisplayName 'Fleet v2 HTTPS','Fleet v2 DNS UDP','Fleet v2 DNS TCP' -ErrorAction SilentlyContinue | Remove-NetFirewallRule\nNew-NetFirewallRule -DisplayName 'Fleet v2 HTTPS' -Direction Inbound -Action Allow -Protocol TCP -LocalPort ${config.mode === "node" ? 42174 : 443} -LocalAddress ${config.addresses.map(ps).join(",")} -RemoteAddress '100.64.0.0/10','fd7a:115c:a1e0::/48' -Program ${ps(process.execPath)} | Out-Null\nNew-NetFirewallRule -DisplayName 'Fleet v2 DNS TCP' -Direction Inbound -Action Allow -Protocol TCP -LocalPort 53 -LocalAddress ${config.addresses.map(ps).join(",")} -RemoteAddress '100.64.0.0/10','fd7a:115c:a1e0::/48' -Program ${ps(process.execPath)} | Out-Null\nNew-NetFirewallRule -DisplayName 'Fleet v2 DNS UDP' -Direction Inbound -Action Allow -Protocol UDP -LocalPort 53 -LocalAddress ${config.addresses.map(ps).join(",")} -RemoteAddress '100.64.0.0/10','fd7a:115c:a1e0::/48' -Program ${ps(process.execPath)} | Out-Null\nStart-ScheduledTask -TaskName FleetV2\n`;
}
export function tailscale(args) {
  const candidates =
    process.platform === "win32"
      ? [
          path.join(
            process.env.ProgramFiles || "C:\\Program Files",
            "Tailscale",
            "tailscale.exe",
          ),
          "tailscale.exe",
        ]
      : process.platform === "darwin"
        ? [
            "/Applications/Tailscale.app/Contents/MacOS/Tailscale",
            "/usr/local/bin/tailscale",
            "/opt/homebrew/bin/tailscale",
            "tailscale",
          ]
        : ["tailscale", "/usr/bin/tailscale"];
  let last;
  for (const exe of candidates) {
    try {
      return run(exe, args, {
        env: { ...process.env, TAILSCALE_BE_CLI: "1" },
        maxBuffer: 2_000_000,
      });
    } catch (e) {
      last = e;
      if (e.code !== "ENOENT") break;
    }
  }
  if (last?.code === "ENOENT")
    throw new Error(
      "Tailscale is not installed. Install it from https://tailscale.com/download, sign in, then retry.",
    );
  throw new Error(
    `Tailscale is unavailable. Connect Tailscale, then retry. ${String(last?.stderr || last?.message || "").trim()}`,
  );
}
export function tailnet() {
  const state = JSON.parse(tailscale(["status", "--json"]));
  if (state.BackendState !== "Running" || !state.Self?.TailscaleIPs?.length)
    throw new Error("Connect Tailscale before setting up Fleet.");
  return {
    addresses: state.Self.TailscaleIPs,
    dnsName: state.Self.DNSName?.replace(/\.$/, "") || "",
    userId: state.Self.UserID,
  };
}
export async function ensureDNS(
  address,
  token = process.env.FLEET_TAILSCALE_TOKEN,
) {
  if (!token) return { configured: false };
  const url = "https://api.tailscale.com/api/v2/tailnet/-/dns/split-dns";
  const headers = {
    Authorization: `Bearer ${token}`,
    "Content-Type": "application/json",
  };
  const response = await fetch(url, {
    headers,
    signal: AbortSignal.timeout(10000),
  });
  if (!response.ok)
    throw new Error(
      `Tailscale DNS authorization failed (${response.status}). Use a credential with the dns scope or add the fleet rule in the admin console.`,
    );
  const map = await response.json();
  if (map.fleet?.length && !map.fleet.includes(address))
    throw new Error(
      "The tailnet already has a fleet DNS rule for another computer. Fleet did not change it. Join that Fleet or remove the old rule first.",
    );
  if (!map.fleet?.includes(address)) {
    const changed = await fetch(url, {
      method: "PATCH",
      headers,
      body: JSON.stringify({ fleet: [address] }),
      signal: AbortSignal.timeout(10000),
    });
    if (!changed.ok)
      throw new Error(
        `Tailscale did not accept the fleet DNS rule (${changed.status}).`,
      );
  }
  const check = await fetch(url, {
    headers,
    signal: AbortSignal.timeout(10000),
  });
  if (!check.ok || !(await check.json()).fleet?.includes(address))
    throw new Error(
      "Tailscale DNS read-back failed. Check the fleet rule in the admin console.",
    );
  return { configured: true };
}
export function openBrowser(url) {
  const child =
    process.platform === "darwin"
      ? spawn("open", [url], { stdio: "ignore", detached: true })
      : process.platform === "win32"
        ? spawn("rundll32.exe", ["url.dll,FileProtocolHandler", url], {
            stdio: "ignore",
            detached: true,
          })
        : spawn("xdg-open", [url], { stdio: "ignore", detached: true });
  child.on("error", () => {});
  child.unref();
}
export function serviceFiles(home, config, platform = process.platform) {
  const destination =
    platform === "darwin" ? macHelper : "/usr/local/lib/fleet-v2";
  const helperConfig = {
    uid: process.getuid?.(),
    gid: process.getgid?.(),
    home,
    userHome: os.homedir(),
    node: process.execPath,
    cli,
    addresses: config.addresses,
    mode: config.mode,
  };
  const executable = path.join(destination, "node");
  const helperPath = path.join(destination, "ports.mjs");
  const configPath = path.join(destination, "owner.json");
  if (platform === "darwin")
    return {
      destination,
      helperConfig,
      file: "/Library/LaunchDaemons/dev.fleet.v2.plist",
      content: `<?xml version="1.0" encoding="UTF-8"?><!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd"><plist version="1.0"><dict><key>Label</key><string>dev.fleet.v2</string><key>ProgramArguments</key><array>${[executable, helperPath, configPath].map((a) => `<string>${xml(a)}</string>`).join("")}</array><key>RunAtLoad</key><true/><key>KeepAlive</key><true/><key>StandardOutPath</key><string>${xml(path.join(destination, "daemon.log"))}</string><key>StandardErrorPath</key><string>${xml(path.join(destination, "daemon.log"))}</string></dict></plist>`,
    };
  return {
    destination,
    helperConfig,
    file: "/etc/systemd/system/fleet-v2.service",
    content: `[Unit]\nDescription=Fleet private apps\nAfter=network-online.target tailscaled.service\nWants=network-online.target\n[Service]\nExecStart=${[executable, helperPath, configPath].map(systemd).join(" ")}\nRestart=on-failure\nRestartSec=3\nUMask=0077\n[Install]\nWantedBy=multi-user.target\n`,
  };
}
export async function install(home, config) {
  const pki = authority(home);
  if (config.mode === "node") {
    pki.certFile = path.join(home, "pki", "gateway-root.pem");
    write(pki.certFile, config.gateway.ca);
  }
  if (process.platform === "win32") {
    process.stderr.write(
      "Approve the Windows security warning to trust Fleet's certificate.\n",
    );
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
  if (process.getuid() === 0)
    throw new Error(
      "Run Fleet setup as your normal user. It uses sudo only to install the port helper.",
    );
  checkStandaloneNode();
  const staging = fs.mkdtempSync(path.join(os.tmpdir(), "fleet-install-"));
  fs.chmodSync(staging, 0o700);
  try {
    write(path.join(staging, "owner.json"), files.helperConfig);
    write(path.join(staging, "service"), files.content);
    // Elevated code is copied to root-owned storage. The privileged listener
    // must not execute a Node binary or helper writable by the app owner.
    sudo(["install", "-d", "-m", "755", files.destination]);
    for (const [source, destination, mode] of [
      [process.execPath, "node", "755"],
      [helper, "ports.mjs", "644"],
      [path.join(staging, "owner.json"), "owner.json", "600"],
    ])
      sudo([
        "install",
        "-m",
        mode,
        source,
        path.join(files.destination, destination),
      ]);
    checkInstalledNode(path.join(files.destination, "node"));
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
      } catch {}
      sudo(["launchctl", "bootstrap", "system", files.file]);
      // macOS uses this suffix-specific file and keeps existing VPN/default DNS.
      const resolver = path.join(staging, "resolver");
      write(
        resolver,
        `# Fleet v2\nnameserver ${config.mode === "node" ? config.gateway.address : "127.0.0.1"}\n`,
      );
      if (
        fs.existsSync("/etc/resolver/fleet") &&
        !fs
          .readFileSync("/etc/resolver/fleet", "utf8")
          .startsWith("# Fleet v2\n")
      )
        throw new Error("/etc/resolver/fleet already belongs to another tool.");
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
        if (error.code === "ENOENT")
          sudo(["apt-get", "install", "--yes", "libnss3-tools"]);
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
export function uninstall(home) {
  if (process.platform === "win32") {
    try {
      run("schtasks.exe", ["/End", "/TN", "FleetV2"]);
    } catch {}
    try {
      run("schtasks.exe", ["/Delete", "/F", "/TN", "FleetV2"]);
    } catch {}
    const ca = authority(home);
    const installedConfig = read(path.join(home, "config.json"), {});
    if (installedConfig.mode === "node") ca.pem = installedConfig.gateway.ca;
    // certutil accepts the exact SHA-1 certificate thumbprint for removal.
    const pem = ca.pem.replace(/-----[^-]+-----|\s/g, "");
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
    return import("node:crypto").then(({ createHash }) =>
      prompted(
        "certutil.exe",
        [
          "-user",
          "-delstore",
          "Root",
          createHash("sha1").update(Buffer.from(pem, "base64")).digest("hex"),
        ],
        { stdio: ["inherit", "ignore", "inherit"] },
      ),
    );
  }
  const installedConfig = read(path.join(home, "config.json"), {});
  const installedRoot =
    installedConfig.mode === "node"
      ? path.join(home, "pki", "gateway-root.pem")
      : authority(home).certFile;
  const files = serviceFiles(home, installedConfig);
  if (process.platform === "darwin") {
    try {
      sudo(["launchctl", "bootout", "system/dev.fleet.v2"]);
    } catch {}
    if (
      fs.existsSync("/etc/resolver/fleet") &&
      fs.readFileSync("/etc/resolver/fleet", "utf8").startsWith("# Fleet v2\n")
    )
      sudo(["rm", "/etc/resolver/fleet"]);
    if (fs.existsSync(installedRoot))
      try {
        sudo(["security", "remove-trusted-cert", "-d", installedRoot]);
      } catch {}
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
    } catch {}
    for (const hash of new Set(keychainHashes(found)))
      sudo([
        "security",
        "delete-certificate",
        "-Z",
        hash,
        "/Library/Keychains/System.keychain",
      ]);
  } else {
    try {
      sudo(["systemctl", "disable", "--now", "fleet-v2.service"]);
    } catch {}
    sudo(["rm", "-f", "/usr/local/share/ca-certificates/fleet-v2.crt"]);
    sudo(["update-ca-certificates"]);
    browserRoot({ certFile: installedRoot }, true);
  }
  sudo(["rm", "-f", files.file]);
  sudo(["rm", "-rf", files.destination]);
}
