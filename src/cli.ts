#!/usr/bin/env bun
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import QRCode from "qrcode";
import pkg from "../package.json" with { type: "json" };
import { authority, leaf, mobileProfile } from "./certificates.ts";
import {
  ensureDNS,
  install,
  openBrowser,
  tailnet,
  tailscale,
  tailscaleServe,
  turnOffPhoneRoute,
  uninstall,
} from "./platform.ts";
import {
  type AppManifest,
  configuration,
  type FleetConfig,
  type RegisteredApp,
  type RunningInfo,
  read,
  register,
  root,
  secret,
  validateName,
  withStateLock,
  write,
} from "./state.ts";

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    name: { type: "string" },
    json: { type: "boolean" },
    help: { type: "boolean", short: "h" },
    version: { type: "boolean", short: "v" },
    install: { type: "boolean" },
    foreground: { type: "boolean" },
    local: { type: "boolean" },
    forwarded: { type: "boolean" },
    "https-port": { type: "string" },
    "dns-port": { type: "string" },
    output: { type: "string" },
    noopen: { type: "boolean" },
    home: { type: "string" },
    join: { type: "string" },
  },
});

if (values.home) process.env.FLEET_V2_HOME = path.resolve(values.home);
const home = root();
const [command, ...args] = positionals;

const out = (data: unknown): void => {
  console.log(
    values.json
      ? JSON.stringify(data)
      : typeof data === "string"
        ? data
        : JSON.stringify(data, null, 2),
  );
};

async function rpc<T = unknown>(
  method: string,
  methodArgs?: Record<string, unknown>,
  config: FleetConfig | null = configuration(home),
): Promise<T> {
  const running = read<RunningInfo | null>(path.join(home, "running.json"), null);
  if (!config || !running) {
    throw new Error("Fleet is not running. Run fleet setup --install, or fleet daemon.");
  }
  const response = await fetch(`http://127.0.0.1:${running.adminPort}/rpc`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${config.adminToken}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ method, args: methodArgs }),
    signal: AbortSignal.timeout(35_000),
  });
  const result = (await response.json()) as { error?: string } & T;
  if (!response.ok) throw new Error(result.error || "Fleet daemon rejected the request.");
  return result;
}

function createApp(directory: string, name: string): AppManifest {
  validateName(name);
  const template = fileURLToPath(new URL("../templates/", import.meta.url));
  const copySource = (file: string) => {
    const target = path.join(directory, file);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, fs.readFileSync(path.join(template, file)), {
      flag: "wx",
    });
  };
  const addTypes = () => {
    try {
      copySource("fleet.d.ts");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    }
  };
  const configFile = path.join(directory, "fleet.json");
  if (fs.existsSync(configFile)) {
    const app = register(home, directory);
    addTypes();
    return app;
  }
  const files = ["client/index.tsx", "client/style.css", "server/index.ts"];
  for (const file of files) {
    if (fs.existsSync(path.join(directory, file))) {
      throw new Error(`${file} already exists. Fleet will not overwrite your source files.`);
    }
  }
  for (const file of files) copySource(file);
  fs.writeFileSync(
    configFile,
    JSON.stringify({ version: 2, id: randomUUID(), name, jobs: [] }, null, 2),
    { flag: "wx" },
  );
  addTypes();
  const instructions = `
## Fleet app

Edit client/index.tsx and server/index.ts. Fleet builds and updates the app automatically. Do not start Vite or a separate app server.

Use fleet list --json, fleet inspect ${name}, fleet logs ${name}, and fleet call ${name} queries notes to inspect the running app. Use fleet call APP mutations NAME '{"key":"value"}' for writes.

The server exports queries, mutations, and jobs. See fleet.d.ts for FleetCtx and FleetDb. Store persistent JSON in ctx.db. The data is outside the checkout and survives rebuilds. Queries cannot write.

ctx.db.get returns null for a missing key. ctx.db.delete returns true if it deleted a key. ctx.db.list(prefix) returns up to 1,000 items.

Fleet runs each mutation or job in an implicit SQLite transaction. If the handler throws, Fleet rolls back all ctx.db writes from that call. Return a structured { ok: false, error } result to keep writes that record a failure.

To schedule a job, add {"name":"dailyCheck","everySeconds":86400} to the jobs array in fleet.json. Jobs run without a browser. Fleet can retry an interrupted job with the same ctx.runId. Use that ID as the idempotency key for external API requests. App code runs with this computer user's permissions.

Import useQuery, useMutation, and call from fleet/client. Fleet provides Preact. Do not install Preact in the app. useQuery returns { data, error }. The error starts as null. Use call(kind, name, input) to write without refetching all queries.

useQuery(name, input, { pollMs }) polls every 10 seconds by default. Set pollMs to false or 0 to stop interval polling. useMutation(name, { invalidate }) refreshes all active queries by default. Set invalidate to an array of query names or to false to skip the refresh. Pass { keepalive: true } as the fourth argument to call for a small write during page unload.

Put static files in public/. Set title, themeColor, icon, or manifest in fleet.json to change the HTML head. Use paths from the site root, such as /icon.svg, for icon and manifest.

Fleet Gate handles sign-in. Do not add a separate login system.

Store server secrets in .env.fleet.server and read them through ctx.env. Git ignores this file. Do not import it into the client.
`;
  fs.appendFileSync(path.join(directory, "AGENTS.md"), instructions);
  if (!fs.existsSync(path.join(directory, ".env.fleet.server"))) {
    write(
      path.join(directory, ".env.fleet.server"),
      "# Server-only values. Read them through ctx.env.\n",
    );
  }
  const ignore = path.join(directory, ".gitignore");
  if (
    !fs.existsSync(ignore) ||
    !fs.readFileSync(ignore, "utf8").split(/\r?\n/).includes(".env.fleet.server")
  ) {
    fs.appendFileSync(ignore, "\n.env.fleet.server\n");
  }
  return register(home, directory);
}

async function phone(): Promise<void> {
  const config = configuration(home);
  if (!config?.dnsName) {
    throw new Error("Run fleet setup with Tailscale connected first.");
  }
  const setup = await rpc<{ path: string; expires: number }>("setup");
  const pairing = await rpc<{ code: string }>("pair");
  const before = JSON.parse(tailscale(["serve", "status", "--json"])) as {
    TCP?: Record<string, unknown>;
    Web?: Record<string, { Handlers?: Record<string, { Proxy?: string }> }>;
  };
  const proxy = `http://127.0.0.1:${config.adminPort}`;
  const previous = read<unknown>(path.join(home, "phone-serve.json"), null);
  const handlers = before.Web?.[`${config.dnsName}:8444`]?.Handlers;
  const owned =
    Boolean(previous) &&
    Boolean(handlers) &&
    Object.keys(handlers || {}).length === 1 &&
    handlers?.["/"]?.Proxy === proxy;
  if (!owned && (before.TCP?.["8444"] || handlers)) {
    throw new Error("Tailscale Serve port 8444 is already in use. Fleet will not replace it.");
  }
  if (!owned) {
    await tailscaleServe(["serve", "--bg", "--https=8444", proxy], {
      retryCommand: "fleet phone",
    });
  }
  const url = `https://${config.dnsName}:8444${setup.path}`;
  write(path.join(home, "phone-serve.json"), {
    port: 8444,
    host: config.dnsName,
    proxy,
    expires: setup.expires,
  });
  if (values.json) {
    out({ url, expires: setup.expires, deviceCode: pairing.code });
    return;
  }
  console.log("Scan this with your iPhone while Tailscale is connected.");
  console.log(await QRCode.toString(url, { type: "terminal", small: true }));
  console.log(url);
  console.log(`\nFleet Gate device code: ${pairing.code}`);
  console.log(
    "\nInstall the Fleet profile in Settings > General > VPN & Device Management, then enable Fleet private apps in General > About > Certificate Trust Settings.\nTap Open Fleet on the setup page to sign in at https://gate.fleet/phone — the temporary setup link closes automatically.",
  );
}

function checkRuntimeVersion(): void {
  if (typeof Bun === "undefined") {
    throw new Error("Fleet requires Bun 1.4.0 or later. Install Bun from https://bun.com.");
  }
  const [major, minor] = Bun.version.split(".").map(Number);
  if (major < 1 || (major === 1 && minor < 4)) {
    throw new Error("Upgrade to Bun 1.4.0 or later (`bun upgrade`) before running Fleet.");
  }
}

interface InviteFile {
  version?: number;
  address?: string;
  port?: number;
  ca?: string;
  token?: string;
  expires?: number;
}

async function main(): Promise<void> {
  checkRuntimeVersion();
  if (values.version) {
    console.log(`Fleet ${pkg.version}`);
    return;
  }
  if (values.help || !command) {
    console.log(
      `Fleet · personal apps on your own computers\n\n  fleet setup --install    Set up this computer and start Fleet at boot\n  fleet init [directory]   Create and register an app\n  fleet list --json        List apps and runtime state\n  fleet open [NAME]        Open an app, signed in through Gate\n  fleet inspect NAME       Inspect an app\n  fleet logs NAME          Read an app's build and runtime log\n  fleet call APP queries|mutations|jobs OP [JSON]  Run an operation as the owner\n  fleet backup NAME --output FILE   Snapshot an app's SQLite database\n  fleet restore NAME FILE  Restore an app's SQLite database while stopped\n  fleet gate               Create a device sign-in code\n  fleet gate reset         Disconnect all signed-in browsers\n  fleet invite --output FILE   Connect another computer with app checkouts\n  fleet phone              Connect an iPhone with a QR code\n  fleet phone off          Remove Fleet's temporary setup route\n  fleet doctor             Check DNS, HTTPS, Tailscale, and the daemon\n  fleet unregister NAME    Remove an app route, keep source and data\n  fleet profile --output FILE   Export the public iPhone profile\n  fleet daemon             Run in the foreground\n  fleet uninstall          Stop Fleet and remove computer trust\n\nRequires Bun 1.4+ and Tailscale. Use --json for agent output.`,
    );
    return;
  }
  if (
    ["gate", "phone", "open", "invite"].includes(command) &&
    configuration(home)?.mode === "node"
  ) {
    throw new Error("Run this command on your Fleet gateway. This computer hosts app checkouts.");
  }
  if (command === "setup") {
    const old = configuration(home);
    const net = values.local ? { addresses: ["127.0.0.1"], dnsName: "" } : tailnet();
    const config: FleetConfig = {
      version: 2,
      ...old,
      ...net,
      httpsPort: Number(values["https-port"] || old?.httpsPort || 443),
      dnsPort: Number(values["dns-port"] || old?.dnsPort || 53),
      adminPort: old?.adminPort || 42173,
      adminToken: old?.adminToken || secret(),
    };
    if (values.join) {
      const invite = read<InviteFile | null>(path.resolve(values.join), null);
      const { privateAddress } = await import("./peers.ts");
      if (
        !invite ||
        invite.version !== 2 ||
        !privateAddress(invite.address) ||
        !invite.expires ||
        invite.expires <= Date.now() ||
        typeof invite.ca !== "string" ||
        !invite.ca.startsWith("-----BEGIN CERTIFICATE-----") ||
        typeof invite.port !== "number" ||
        !Number.isInteger(invite.port) ||
        invite.port < 1 ||
        invite.port > 65535 ||
        typeof invite.token !== "string" ||
        invite.token.length < 32
      ) {
        throw new Error("Invalid or expired Fleet computer invitation.");
      }
      config.mode = "node";
      config.nodeId = old?.nodeId || randomUUID();
      config.nodeToken = old?.nodeToken || secret();
      config.gateway = {
        address: invite.address,
        port: invite.port,
        ca: invite.ca,
        joinToken: invite.token,
      };
    }
    for (const port of [config.httpsPort, config.dnsPort]) {
      if (!Number.isInteger(port) || port < 1 || port > 65535) {
        throw new Error("Ports must be between 1 and 65535.");
      }
    }
    authority(home);
    leaf(home, "gate.fleet");
    write(path.join(home, "config.json"), config);
    if (values.install) await install(home, config);
    const dns =
      !values.local && config.mode !== "node"
        ? await ensureDNS(net.addresses.find((a) => a.includes(".")))
        : { configured: false };
    if (values.json) {
      out({
        ready: true,
        installed: Boolean(values.install),
        addresses: config.addresses,
        dnsSuffix: "fleet",
        dnsConfigured: dns.configured,
      });
      return;
    }
    console.log("Fleet is configured.");
    if (!values.install) {
      console.log(
        "Run fleet setup --install for background startup, or fleet daemon for a foreground test.",
      );
    }
    if (!values.local && config.mode !== "node" && !dns.configured) {
      console.log(
        `\nOne-time Tailscale setup:\nOpen https://login.tailscale.com/admin/dns\nAdd a restricted nameserver: ${net.addresses.find((a) => a.includes("."))}\nRestrict it to: fleet\nIf you use an exit node, enable Use with exit node for this nameserver.\n\nThen run fleet gate to connect this browser, or fleet phone to connect your iPhone.`,
      );
    }
    return;
  }
  if (command === "init") {
    const directory = path.resolve(args[0] || ".");
    const name =
      values.name ||
      path
        .basename(directory)
        .toLowerCase()
        .replace(/[^a-z0-9-]+/g, "-")
        .replace(/^-|-$/g, "")
        .slice(0, 63);
    const app = createApp(directory, name);
    out(
      values.json
        ? { ...app, directory, url: `https://${app.name}.fleet` }
        : `Created ${app.name}.\n${directory}\nhttps://${app.name}.fleet\n\nYour agent can edit client/index.tsx and server/index.ts. Fleet updates the app automatically.`,
    );
    return;
  }
  if (command === "register") {
    const app = register(home, path.resolve(args[0] || "."));
    out({ ...app, url: `https://${app.name}.fleet` });
    return;
  }
  if (command === "daemon") {
    const { start } = await import("./server.ts");
    const daemon = await start(
      home,
      values.forwarded ? { hosts: ["127.0.0.1"], httpsPort: 8443, dnsPort: 1053 } : {},
    );
    console.log("Fleet is running. Open https://gate.fleet.");
    for (const signal of ["SIGINT", "SIGTERM"] as const) {
      process.once(signal, () => {
        void daemon.close().then(() => process.exit(0));
      });
    }
    return;
  }
  if (command === "invite") {
    if (!values.output) {
      throw new Error("Use --output to save a private computer invitation file.");
    }
    if (fs.existsSync(values.output)) {
      throw new Error("The output file already exists.");
    }
    write(path.resolve(values.output), await rpc("invite"));
    out(
      `Computer invitation saved to ${path.resolve(values.output)}. It expires in ten minutes. Transfer it privately to your other computer, then run fleet setup --join FILE --install there.`,
    );
    return;
  }
  if (command === "list") {
    out(await rpc("list"));
    return;
  }
  if (command === "open") {
    const result = await rpc<{ url: string }>("browser", { app: args[0] || "" });
    if (values.json) {
      out(result);
      return;
    }
    openBrowser(result.url);
    out(`Opening ${args[0] || "Fleet"}.`);
    return;
  }
  if (command === "inspect") {
    const apps = await rpc<Array<{ name: string }>>("list");
    const app = apps.find((a) => a.name === args[0]);
    if (!app) throw new Error("Unknown app.");
    out({
      ...app,
      jobsState: read(path.join(home, "jobs.json"), {}),
      url: `https://${app.name}.fleet`,
    });
    return;
  }
  if (command === "logs") {
    const app = read<RegisteredApp[]>(path.join(home, "apps.json"), []).find(
      (a) => a.name === args[0],
    );
    if (!app) throw new Error("Unknown app.");
    let text = "";
    try {
      text = fs.readFileSync(path.join(home, "logs", `${app.id}.log`), "utf8");
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
    }
    out(
      values.json
        ? { name: app.name, lines: text.trim().split("\n").slice(-100) }
        : text.split("\n").slice(-100).join("\n"),
    );
    return;
  }
  if (command === "call") {
    out(
      await rpc("call", {
        app: args[0],
        kind: args[1],
        name: args[2],
        input: JSON.parse(args[3] || "null"),
      }),
    );
    return;
  }
  if (command === "backup") {
    if (!values.output) throw new Error("Choose a backup file with --output.");
    const { exportData } = await import("./data.ts");
    await exportData(home, args[0], path.resolve(values.output));
    out("Data backup saved.");
    return;
  }
  if (command === "restore") {
    if (!args[1]) {
      throw new Error("Use fleet restore APP BACKUP.sqlite after stopping Fleet.");
    }
    const { restoreData } = await import("./data.ts");
    const previous = await restoreData(home, args[0], path.resolve(args[1]));
    out(`Data restored. The previous data is retained at ${previous}.`);
    return;
  }
  if (command === "gate") {
    if (args[0] === "reset") {
      out(await rpc("reset"));
      return;
    }
    const result = await rpc<{ code: string }>("pair");
    if (!values.json) {
      console.log(
        `Device code: ${result.code}\nValid for ten minutes. Open https://gate.fleet on your device.`,
      );
      if (!values.noopen) openBrowser("https://gate.fleet");
    } else {
      out(result);
    }
    return;
  }
  if (command === "phone") {
    if (args[0] === "off") {
      const result = await turnOffPhoneRoute(home);
      if (!result.removed) {
        out("There is no Fleet phone setup route to remove.");
        return;
      }
      out("Phone setup route removed.");
      return;
    }
    await phone();
    return;
  }
  if (command === "profile") {
    if (!values.output) throw new Error("Choose an output file with --output.");
    if (fs.existsSync(values.output)) throw new Error("Output file already exists.");
    write(path.resolve(values.output), mobileProfile(home));
    out(path.resolve(values.output));
    return;
  }
  if (command === "unregister") {
    withStateLock(home, () => {
      const file = path.join(home, "apps.json");
      const apps = read<RegisteredApp[]>(file, []);
      if (!apps.some((a) => a.name === args[0])) throw new Error("Unknown app.");
      write(
        file,
        apps.filter((a) => a.name !== args[0]),
      );
    });
    out("App route removed. Source and data are retained.");
    return;
  }
  if (command === "doctor") {
    let localOnly = false;
    let daemon: { ok: boolean; apps?: number; error?: string };
    try {
      const config = configuration(home);
      localOnly =
        !config?.dnsName && config?.addresses?.length === 1 && config.addresses[0] === "127.0.0.1";
      daemon = {
        ok: true,
        apps: (await rpc<unknown[]>("list", undefined, config)).length,
      };
    } catch (e) {
      daemon = { ok: false, error: e instanceof Error ? e.message : String(e) };
    }
    const skipped = {
      ok: null,
      skipped: true,
      reason: "Fleet is configured with --local.",
    };
    const checks: Array<Record<string, unknown>> = [];
    if (localOnly) {
      checks.push({ check: "tailscale", ...skipped });
    } else {
      try {
        checks.push({ check: "tailscale", ok: true, ...tailnet() });
      } catch (e) {
        checks.push({
          check: "tailscale",
          ok: false,
          error: e instanceof Error ? e.message : String(e),
        });
      }
    }
    checks.push({ check: "daemon", ...daemon });
    if (localOnly) {
      checks.push({ check: "system-dns", ...skipped });
    } else {
      const { lookup } = await import("node:dns/promises");
      try {
        checks.push({
          check: "system-dns",
          ok: true,
          addresses: await lookup("gate.fleet", { all: true }),
        });
      } catch {
        checks.push({
          check: "system-dns",
          ok: false,
          error:
            "gate.fleet does not resolve. Check the Tailscale restricted nameserver for fleet.",
        });
      }
    }
    out(checks);
    if (checks.some((c) => c.ok === false)) process.exitCode = 1;
    return;
  }
  if (command === "uninstall") {
    uninstall(home);
    out(
      "Fleet background startup and computer trust removed. App source and data are retained. Remove the fleet DNS rule in Tailscale and the profile on your phone if you are retiring this Fleet.",
    );
    return;
  }
  throw new Error(`Unknown command: ${command}. Run fleet --help.`);
}

main().catch((error: unknown) => {
  console.error(`Fleet: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
});
