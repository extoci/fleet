#!/usr/bin/env bun
import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs, promisify } from "node:util";
import pkg from "../package.json" with { type: "json" };
import { agentContract, agentGuide, installAgentSkill } from "./agent-guide.ts";
import {
  type AppListItem,
  type DoctorCheck,
  type EventsStatusItem,
  formatAppList,
  formatDaemonReady,
  formatDoctor,
  formatError,
  formatEvents,
  formatGateCode,
  formatGateSessions,
  type GateSessionItem,
  formatHelp,
  formatInit,
  formatInspect,
  formatNotice,
  formatPeerList,
  formatPhoneSetup,
  type PeerComputerItem,
  formatSetup,
  shortenHome,
} from "./cli-ui.ts";
import {
  type AppManifest,
  configuration,
  type FleetConfig,
  type RegisteredApp,
  type RunningInfo,
  read,
  register,
  registerAlias,
  root,
  secret,
  unregister,
  validateName,
  write,
} from "./state.ts";

const execFileAsync = promisify(execFile);

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    name: { type: "string" },
    json: { type: "boolean" },
    help: { type: "boolean", short: "h" },
    version: { type: "boolean", short: "v" },
    install: { type: "boolean" },
    foreground: { type: "boolean" },
    wait: { type: "boolean" },
    follow: { type: "boolean", short: "f" },
    daemon: { type: "boolean" },
    lines: { type: "string", short: "n" },
    service: { type: "boolean" },
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

function createApp(
  directory: string,
  name: string,
  { service = false }: { service?: boolean } = {},
): AppManifest {
  validateName(name);
  const template = fileURLToPath(new URL("../templates/", import.meta.url));
  const copySource = (file: string, source = path.join(template, file)) => {
    const target = path.join(directory, file);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, fs.readFileSync(source), {
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
  const addAgentGuide = (appName: string) => {
    const file = path.join(directory, "AGENTS.md");
    const contract = agentContract(appName);
    if (!fs.existsSync(file)) {
      fs.writeFileSync(file, contract);
    } else if (!fs.readFileSync(file, "utf8").includes("## Fleet app")) {
      fs.appendFileSync(file, `\n${contract}`);
    }
  };
  const configFile = path.join(directory, "fleet.json");
  if (fs.existsSync(configFile)) {
    const app = register(home, directory);
    addTypes();
    addAgentGuide(app.name);
    return app;
  }
  if (service) {
    if (fs.existsSync(path.join(directory, "server/index.ts"))) {
      throw new Error(
        "server/index.ts already exists. Fleet will not overwrite your source files.",
      );
    }
    copySource("server/index.ts", path.join(template, "service/server/index.ts"));
  } else {
    const files = [
      "client/index.tsx",
      "client/style.css",
      "server/index.ts",
      "public/fleet/fonts.css",
      "public/fleet/wordmark.svg",
    ];
    const fonts = ["Geist-Variable.woff2", "GeistPixel-Square.woff2", "geist-font-OFL.txt"];
    for (const dir of ["public", "public/fleet"]) {
      const existing = fs.lstatSync(path.join(directory, dir), { throwIfNoEntry: false });
      if (existing && !existing.isDirectory()) {
        throw new Error(`${dir} must be a directory to store the Fleet starter assets.`);
      }
    }
    for (const file of [...files, ...fonts.map((font) => `public/fleet/${font}`)]) {
      if (fs.existsSync(path.join(directory, file))) {
        throw new Error(`${file} already exists. Fleet will not overwrite your source files.`);
      }
    }
    for (const file of files) copySource(file);
    for (const font of fonts) {
      copySource(
        `public/fleet/${font}`,
        fileURLToPath(new URL(`./assets/${font}`, import.meta.url)),
      );
    }
  }
  fs.writeFileSync(
    configFile,
    JSON.stringify({ version: 2, id: randomUUID(), name, jobs: [] }, null, 2),
    { flag: "wx" },
  );
  addTypes();
  addAgentGuide(name);
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

function sourceFiles(directory: string): string[] {
  const files: string[] = [];
  const walk = (dir: string): void => {
    if (!fs.existsSync(dir)) return;
    for (const item of fs.readdirSync(dir, { withFileTypes: true })) {
      if (item.name.startsWith(".") || ["node_modules", "dist", "target"].includes(item.name)) {
        continue;
      }
      const file = path.join(dir, item.name);
      if (item.isDirectory()) walk(file);
      else if (/\.(?:[cm]?ts|tsx)$/.test(item.name)) files.push(file);
    }
  };
  walk(directory);
  return files.sort();
}

interface CheckResult {
  name: string;
  directory: string;
  ok: boolean;
  errors: string[];
  output: string;
}

async function checkAppTypes(app: RegisteredApp): Promise<CheckResult> {
  const declarations = path.join(app.directory, "fleet.d.ts");
  if (!fs.existsSync(declarations)) {
    throw new Error(`${app.name} is missing fleet.d.ts. Run fleet init in the app directory.`);
  }
  const packageRoot = fileURLToPath(new URL("..", import.meta.url));
  const modules = path.join(packageRoot, "node_modules");
  const preact = path.join(modules, "preact");
  if (!fs.existsSync(preact)) {
    throw new Error("Fleet's Preact dependency is missing. Reinstall Fleet.");
  }
  const files = [
    declarations,
    ...sourceFiles(path.join(app.directory, "server")),
    ...sourceFiles(path.join(app.directory, "client")),
  ];
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "fleet-check-"));
  try {
    const assets = path.join(temp, "assets.d.ts");
    fs.writeFileSync(
      assets,
      ["*.css", "*.png", "*.jpg", "*.jpeg", "*.gif", "*.svg", "*.webp", "*.woff", "*.woff2"]
        .map((pattern) => `declare module "${pattern}";`)
        .join("\n"),
    );
    const config = path.join(temp, "tsconfig.json");
    fs.writeFileSync(
      config,
      JSON.stringify({
        compilerOptions: {
          strict: false,
          noEmit: true,
          target: "ES2022",
          module: "ESNext",
          moduleResolution: "Bundler",
          jsx: "react-jsx",
          jsxImportSource: "preact",
          lib: ["ES2022", "DOM", "DOM.Iterable"],
          types: ["node", "bun"],
          typeRoots: [path.join(modules, "@types")],
          paths: {
            preact: [preact],
            "preact/*": [path.join(preact, "*")],
            react: [path.join(preact, "compat")],
            "react-dom": [path.join(preact, "compat")],
            "react-dom/client": [path.join(preact, "compat", "client")],
            "react/jsx-runtime": [path.join(preact, "jsx-runtime")],
            "react/jsx-dev-runtime": [path.join(preact, "jsx-dev-runtime")],
          },
        },
        files: [...files, assets],
      }),
    );
    let output = "";
    let code = 0;
    try {
      const result = await execFileAsync(
        process.execPath,
        ["check", "--no-script", "-p", config, "--pretty=false"],
        { cwd: app.directory, timeout: 30_000, maxBuffer: 4 * 1024 * 1024 },
      );
      output = `${result.stdout}${result.stderr}`.trim();
    } catch (error) {
      const failure = error as {
        code?: number;
        stdout?: string;
        stderr?: string;
        message?: string;
      };
      code = typeof failure.code === "number" ? failure.code : 1;
      output = `${failure.stdout || ""}${failure.stderr || ""}`.trim() || failure.message || "";
    }
    const errors = output.split(/\r?\n/).filter((line) => /error TS\d+:/.test(line));
    return {
      name: app.name,
      directory: app.directory,
      ok: code === 0 && errors.length === 0,
      errors,
      output,
    };
  } finally {
    fs.rmSync(temp, { recursive: true, force: true });
  }
}

async function phone(): Promise<void> {
  const config = configuration(home);
  if (!config?.dnsName) {
    throw new Error("Run fleet setup with Tailscale connected first.");
  }
  const setup = await rpc<{ path: string; expires: number }>("setup");
  const pairing = await rpc<{ code: string }>("pair");
  const { tailscale, tailscaleServe } = await import("./platform.ts");
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
  const { default: QRCode } = await import("qrcode");
  const qr = await QRCode.toString(url, { type: "terminal", small: true });
  console.log(formatPhoneSetup({ qr, url, code: pairing.code }));
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
    console.log(formatHelp(pkg.version));
    return;
  }
  if (
    ["gate", "phone", "open", "invite", "alias", "peers"].includes(command) &&
    configuration(home)?.mode === "node"
  ) {
    throw new Error("Run this command on your Fleet gateway. This computer hosts app checkouts.");
  }
  if (command === "update") {
    const { updateFleet } = await import("./update.ts");
    const result = await updateFleet(home);
    const hint = result.updated
      ? "Run fleet agent --install to refresh any installed agent skill."
      : undefined;
    out(
      values.json
        ? hint
          ? { ...result, hint }
          : result
        : formatNotice(
            "ok",
            result.updated
              ? `Updated Fleet from ${result.previous} to ${result.version}.`
              : `Fleet ${result.version} is up to date.`,
            hint,
          ),
    );
    return;
  }
  if (command === "setup") {
    const { ensureDNS, install, tailnet } = await import("./platform.ts");
    const { authority, leaf } = await import("./certificates.ts");
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
    console.log(
      formatSetup({
        installed: Boolean(values.install),
        ipv4: net.addresses.find((a) => a.includes(".")),
        needsDns: !values.local && config.mode !== "node" && !dns.configured,
      }),
    );
    return;
  }
  if (command === "agent") {
    if (values.install) {
      const installed = installAgentSkill(undefined, values.output);
      out(
        values.json
          ? { installed }
          : formatNotice(
              "ok",
              `Installed Fleet agent skill (${installed.length} ${installed.length === 1 ? "location" : "locations"}).`,
              installed.map((file) => shortenHome(file)).join("\n   "),
            ),
      );
      return;
    }
    const guide = agentGuide();
    out(values.json ? { guide } : guide);
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
    const service = values.service === true;
    const app = createApp(directory, name, { service });
    out(
      values.json
        ? { ...app, directory, url: `https://${app.name}.fleet`, service }
        : formatInit(app.name, directory, { service }),
    );
    return;
  }
  if (command === "register") {
    const app = register(home, path.resolve(args[0] || "."));
    out(
      values.json
        ? { ...app, url: `https://${app.name}.fleet` }
        : formatNotice("ok", `Registered ${app.name}.`, `https://${app.name}.fleet`),
    );
    return;
  }
  if (command === "alias") {
    if (args.length !== 2) throw new Error("Usage: fleet alias NAME URL");
    const alias = registerAlias(home, args[0], args[1]);
    const url = `https://${alias.name}.fleet`;
    out(
      values.json
        ? { ...alias, url }
        : formatNotice("ok", `Saved alias ${url}`, `Redirects to ${alias.target}`),
    );
    return;
  }
  if (command === "daemon") {
    const { start } = await import("./server.ts");
    const daemon = await start(
      home,
      values.forwarded ? { hosts: ["127.0.0.1"], httpsPort: 8443, dnsPort: 1053 } : {},
    );
    console.log(formatDaemonReady());
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
    const target = path.resolve(values.output);
    write(target, await rpc("invite"));
    out(
      values.json
        ? `Computer invitation saved to ${target}. It expires in ten minutes. Transfer it privately to your other computer, then run fleet setup --join FILE --install there.`
        : formatNotice(
            "ok",
            `Computer invitation saved to ${shortenHome(target)}`,
            "Expires in 10 minutes. Transfer it privately and run fleet setup --join FILE --install.",
          ),
    );
    return;
  }
  if (command === "list") {
    const apps = await rpc<AppListItem[]>("list");
    out(values.json ? apps : formatAppList(apps));
    return;
  }
  if (command === "peers") {
    if (args[0] === "remove") {
      if (!args[1]) throw new Error("Usage: fleet peers remove ID");
      const result = await rpc<{ removed: boolean; id: string }>("peerRemove", { id: args[1] });
      out(
        values.json
          ? result
          : formatNotice(
              "ok",
              `Removed Fleet computer ${result.id}.`,
              "Its app routes are now unavailable.",
            ),
      );
      return;
    }
    if (args.length) throw new Error("Usage: fleet peers [--json] or fleet peers remove ID");
    const computers = await rpc<PeerComputerItem[]>("peers");
    out(values.json ? computers : formatPeerList(computers));
    return;
  }
  if (command === "open") {
    const result = await rpc<{ url: string }>("browser", { app: args[0] || "" });
    if (values.json) {
      out(result);
      return;
    }
    (await import("./platform.ts")).openBrowser(result.url);
    out(formatNotice("info", `Opening ${args[0] || "Fleet"}…`));
    return;
  }
  if (command === "inspect") {
    if (!args[0]) throw new Error("Usage: fleet inspect NAME [--wait]");
    const full = await rpc<AppListItem>("inspect", { app: args[0], wait: values.wait === true });
    out(values.json ? full : formatInspect(full));
    return;
  }
  if (command === "logs") {
    const lineCount = values.lines === undefined ? 100 : Number(values.lines);
    if (!Number.isInteger(lineCount) || lineCount < 1) {
      throw new Error("Usage: fleet logs NAME [-n LINES] [-f] or fleet logs --daemon");
    }
    let name = args[0] || "";
    let file = "";
    if (values.daemon) {
      if (args.length) throw new Error("fleet logs --daemon does not take an app name.");
      name = "daemon";
      const serviceLog = path.join(home, "daemon.log");
      file = fs.existsSync(serviceLog) ? serviceLog : path.join(home, "logs", "daemon.log");
    } else {
      const app = read<RegisteredApp[]>(path.join(home, "apps.json"), []).find(
        (a) => a.name === name,
      );
      if (!app) throw new Error("Unknown app.");
      file = path.join(home, "logs", `${app.id}.log`);
    }
    const readLog = () => {
      try {
        return fs.readFileSync(file, "utf8");
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
        return "";
      }
    };
    const text = readLog();
    const lines = text
      ? text
          .replace(/\r?\n$/, "")
          .split("\n")
          .slice(-lineCount)
      : [];
    if (!values.follow) {
      out(values.json ? { name, lines } : lines.join("\n"));
      return;
    }
    process.stdout.write(lines.join("\n"));
    if (lines.length && !lines[lines.length - 1].endsWith("\n")) process.stdout.write("\n");
    let size = Buffer.byteLength(text);
    let writing = false;
    const timer = setInterval(() => {
      if (writing) return;
      let stat: fs.Stats;
      try {
        stat = fs.statSync(file);
      } catch {
        return;
      }
      if (stat.size < size) size = 0;
      if (stat.size === size) return;
      writing = true;
      const stream = fs.createReadStream(file, { start: size, encoding: "utf8" });
      stream.on("data", (chunk) => process.stdout.write(String(chunk)));
      stream.on("end", () => {
        size = stat.size;
        writing = false;
      });
      stream.on("error", () => {
        writing = false;
      });
    }, 250);
    await new Promise<void>((resolve) => {
      process.once("SIGINT", () => {
        clearInterval(timer);
        resolve();
      });
    });
    return;
  }
  if (command === "check") {
    const app = read<RegisteredApp[]>(path.join(home, "apps.json"), []).find(
      (a) => a.name === args[0],
    );
    if (!app) throw new Error("Unknown app.");
    const result = await checkAppTypes(app);
    if (values.json) {
      out(result);
    } else if (result.ok) {
      out(formatNotice("ok", `Typecheck passed for ${app.name}.`));
    } else {
      out(`Typecheck failed for ${app.name}.\n${result.output}`);
    }
    if (!result.ok) process.exitCode = 1;
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
  if (command === "emit") {
    if (!args[0]) throw new Error("Usage: fleet emit TOPIC [JSON]");
    let payload: unknown = null;
    if (args[1] !== undefined) {
      try {
        payload = JSON.parse(args[1]);
      } catch {
        throw new Error("Event payload must be valid JSON.");
      }
    }
    const result = await rpc<{
      eventId: string;
      topic: string;
      matched: number;
      dropped?: boolean;
      targets: Array<{ app: string; handler: string }>;
    }>("emit", { topic: args[0], payload });
    out(
      values.json
        ? result
        : formatNotice(
            "ok",
            `Emitted ${result.topic}`,
            result.matched
              ? `Matched ${result.matched} ${result.matched === 1 ? "handler" : "handlers"}: ${result.targets.map((t) => `${t.app} (${t.handler})`).join(", ")}`
              : "No subscribed apps matched this topic.",
          ),
    );
    return;
  }
  if (command === "events") {
    if (args.length) throw new Error("Usage: fleet events [--json]");
    const status = await rpc<EventsStatusItem>("events");
    out(values.json ? status : formatEvents(status));
    return;
  }
  if (command === "backup") {
    if (!values.output) throw new Error("Choose a backup file with --output.");
    const { exportData } = await import("./data.ts");
    const target = path.resolve(values.output);
    await exportData(home, args[0], target);
    out(
      values.json
        ? "Data backup saved."
        : formatNotice("ok", "Data backup saved.", shortenHome(target)),
    );
    return;
  }
  if (command === "restore") {
    if (!args[1]) {
      throw new Error("Use fleet restore APP BACKUP.sqlite after stopping Fleet.");
    }
    const { restoreData } = await import("./data.ts");
    const previous = await restoreData(home, args[0], path.resolve(args[1]));
    out(
      values.json
        ? `Data restored. The previous data is retained at ${previous}.`
        : formatNotice(
            "ok",
            "Data restored.",
            `Previous data retained at ${shortenHome(previous)}`,
          ),
    );
    return;
  }
  if (command === "gate") {
    if (args[0] === "sessions") {
      const sessions = await rpc<GateSessionItem[]>("gateSessions");
      out(values.json ? sessions : formatGateSessions(sessions));
      return;
    }
    if (args[0] === "revoke") {
      if (!args[1]) throw new Error("Usage: fleet gate revoke ID");
      const result = await rpc<{ revoked: boolean; id: string }>("gateRevoke", { id: args[1] });
      out(
        values.json
          ? result
          : formatNotice(
              "ok",
              `Revoked Gate session ${result.id}.`,
              "Other sessions remain signed in.",
            ),
      );
      return;
    }
    if (args[0] === "reset") {
      const result = await rpc("reset");
      out(values.json ? result : formatNotice("ok", "Disconnected all signed-in browsers."));
      return;
    }
    const result = await rpc<{ code: string }>("pair");
    if (!values.json) {
      console.log(formatGateCode(result.code));
      if (!values.noopen) (await import("./platform.ts")).openBrowser("https://gate.fleet");
    } else {
      out(result);
    }
    return;
  }
  if (command === "phone") {
    if (args[0] === "off") {
      const result = await (await import("./platform.ts")).turnOffPhoneRoute(home);
      if (!result.removed) {
        out(
          values.json
            ? "There is no Fleet phone setup route to remove."
            : formatNotice("info", "There is no Fleet phone setup route to remove."),
        );
        return;
      }
      out(
        values.json
          ? "Phone setup route removed."
          : formatNotice("ok", "Phone setup route removed."),
      );
      return;
    }
    await phone();
    return;
  }
  if (command === "profile") {
    if (!values.output) throw new Error("Choose an output file with --output.");
    if (fs.existsSync(values.output)) throw new Error("Output file already exists.");
    const { mobileProfile } = await import("./certificates.ts");
    const target = path.resolve(values.output);
    write(target, mobileProfile(home));
    out(values.json ? target : formatNotice("ok", "Exported iPhone profile.", shortenHome(target)));
    return;
  }
  if (command === "unregister") {
    if (unregister(home, args[0]) === "alias") {
      out(values.json ? "Alias removed." : formatNotice("ok", `Removed alias ${args[0]}.`));
      return;
    }
    out(
      values.json
        ? "App route removed. Source and data are retained."
        : formatNotice("ok", `Unregistered ${args[0]}.`, "Source files and data are retained."),
    );
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
    const checks: DoctorCheck[] = [];
    if (localOnly) {
      checks.push({ check: "tailscale", ...skipped });
    } else {
      try {
        const { tailnet } = await import("./platform.ts");
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
    out(values.json ? checks : formatDoctor(checks));
    if (checks.some((c) => c.ok === false)) process.exitCode = 1;
    return;
  }
  if (command === "uninstall") {
    (await import("./platform.ts")).uninstall(home);
    out(
      values.json
        ? "Fleet background startup and computer trust removed. App source and data are retained. Remove the fleet DNS rule in Tailscale and the profile on your phone if you are retiring this Fleet."
        : formatNotice(
            "ok",
            "Fleet background startup and computer trust removed.",
            "App source and data are retained. Remove the fleet DNS rule in Tailscale and the iPhone profile if retiring Fleet.",
          ),
    );
    return;
  }
  throw new Error(`Unknown command: ${command}. Run fleet --help.`);
}

main().catch((error: unknown) => {
  console.error(formatError(error instanceof Error ? error.message : String(error)));
  process.exitCode = 1;
});
