import os from "node:os";

export interface UiOptions {
  color?: boolean;
  columns?: number;
}

export interface AppListItem {
  id: string;
  name: string;
  directory: string;
  running: boolean;
  building: boolean;
  revision: string | null;
  error: string | null;
  operations?: {
    queries?: string[];
    mutations?: string[];
    jobs?: string[];
    events?: string[];
  };
  jobs?: Array<{ name: string; everySeconds?: number }>;
  head?: Record<string, unknown>;
  hasPublic?: boolean;
  hasClient?: boolean;
  peer?: string;
  online?: boolean;
  url?: string;
  jobsState?: Record<string, unknown>;
}

export interface EventsStatusItem {
  subscriptions: Array<{ pattern: string; app: string; peer?: string }>;
  pending: Array<{
    id: string;
    eventId: string;
    topic: string;
    source: string;
    targetApp: string;
    handler: string;
    failures: number;
    due: string;
    error?: string;
  }>;
  recent: Array<{
    eventId: string;
    topic: string;
    source: string;
    targetApp: string;
    handler: string;
    status: "delivered" | "failed" | "dropped";
    at: string;
    finishedAt: string;
    attempts: number;
    error?: string;
  }>;
}

export interface PeerComputerItem {
  id: string;
  address: string;
  port: number;
  online: boolean;
  seen: number;
  apps: Array<{
    id: string;
    name: string;
    revision: string | null;
    running: boolean;
    error: string | null;
  }>;
}

export interface GateSessionItem {
  id: string;
  host: string;
  createdAt: string;
  lastSeen: string;
  userAgent: string;
}

export interface DoctorCheck {
  check: string;
  ok: boolean | null;
  skipped?: boolean;
  reason?: string;
  error?: string;
  apps?: number;
  dnsName?: string;
  addresses?: Array<string | { address: string }>;
}

type Rgb = readonly [number, number, number];

// Fleet's violet palette (shared with web/components/dither.tsx & web/style.css).
export const PALETTE = {
  obsidian: [27, 11, 51] as Rgb,
  shadow: [51, 23, 92] as Rgb,
  deep: [109, 63, 209] as Rgb,
  violet: [168, 115, 250] as Rgb,
  highlight: [230, 209, 255] as Rgb,
  white: [240, 240, 240] as Rgb,
  muted: [152, 152, 162] as Rgb,
  dim: [104, 104, 116] as Rgb,
  ok: [74, 222, 128] as Rgb,
  warn: [251, 191, 36] as Rgb,
  err: [248, 113, 113] as Rgb,
} as const;

const PLUMBOB_STOPS: readonly Rgb[] = [
  PALETTE.obsidian,
  PALETTE.shadow,
  PALETTE.deep,
  PALETTE.violet,
  PALETTE.highlight,
];

// 10x7 virtual-pixel Bayer-dithered hexagonal bipyramid (Sims Plumbob).
// Each digit maps to PLUMBOB_STOPS (0=obsidian .. 4=highlight); '.' is transparent.
const PLUMBOB_PIXELS = [
  "...4...",
  "..443..",
  ".43432.",
  ".34423.",
  "3434321",
  "2323210",
  ".23212.",
  ".12121.",
  "..121..",
  "...1...",
] as const;

const PLUMBOB_PLAIN = ["   ░   ", "  ░▓▒  ", " ░▓▓▒░ ", "  ▒▓░  ", "   ▒   "] as const;

// 8-virtual-row tight-tracked geometric lowercase "fleet" wordmark (4 terminal lines via half-blocks).
const WORDMARK_PIXELS = [
  ".111..1................1...",
  "1.....1................1...",
  "111...1..111....111...1111.",
  "1.....1.1...1..1...1...1...",
  "1.....1.11111..11111...1...",
  "1.....1.1......1.......1...",
  "1.....1.1...1..1...1...1...",
  "1.....1..111....111.....11.",
] as const;

const RESET = "\x1b[0m";
const BOLD = "\x1b[1m";

const fg = ([r, g, b]: Rgb): string => `\x1b[38;2;${r};${g};${b}m`;
const bg = ([r, g, b]: Rgb): string => `\x1b[48;2;${r};${g};${b}m`;

export function supportsColor(stream: { isTTY?: boolean } = process.stdout): boolean {
  if (process.env.NO_COLOR !== undefined && process.env.NO_COLOR !== "") return false;
  if (process.env.FORCE_COLOR !== undefined) return process.env.FORCE_COLOR !== "0";
  if (process.env.TERM === "dumb") return false;
  return Boolean(stream.isTTY);
}

function makeStyle(color: boolean) {
  const paint = (rgb: Rgb, text: string, bold = false): string =>
    color ? `${bold ? BOLD : ""}${fg(rgb)}${text}${RESET}` : text;
  return {
    bold: (text: string) => (color ? `${BOLD}${fg(PALETTE.white)}${text}${RESET}` : text),
    text: (text: string) => paint(PALETTE.white, text),
    muted: (text: string) => paint(PALETTE.muted, text),
    dim: (text: string) => paint(PALETTE.dim, text),
    violet: (text: string, bold = false) => paint(PALETTE.violet, text, bold),
    deep: (text: string) => paint(PALETTE.deep, text),
    highlight: (text: string, bold = false) => paint(PALETTE.highlight, text, bold),
    ok: (text: string, bold = false) => paint(PALETTE.ok, text, bold),
    warn: (text: string, bold = false) => paint(PALETTE.warn, text, bold),
    err: (text: string, bold = false) => paint(PALETTE.err, text, bold),
    pill: (text: string) =>
      color ? `${bg(PALETTE.shadow)}${fg(PALETTE.highlight)} ${text} ${RESET}` : `[${text}]`,
  };
}

function renderPixelPair(top: Rgb | null, bottom: Rgb | null): string {
  if (!top && !bottom) return " ";
  if (top && !bottom) return `${fg(top)}▀${RESET}`;
  if (!top && bottom) return `${fg(bottom)}▄${RESET}`;
  if (top![0] === bottom![0] && top![1] === bottom![1] && top![2] === bottom![2]) {
    return `${fg(top!)}█${RESET}`;
  }
  return `${fg(top!)}${bg(bottom!)}▀${RESET}`;
}

export function renderPlumbobLines(color = supportsColor()): string[] {
  if (!color) return [...PLUMBOB_PLAIN];
  const lines: string[] = [];
  for (let row = 0; row < PLUMBOB_PIXELS.length; row += 2) {
    const topRow = PLUMBOB_PIXELS[row] ?? "";
    const botRow = PLUMBOB_PIXELS[row + 1] ?? "";
    let line = "";
    for (let col = 0; col < topRow.length; col++) {
      const tCh = topRow[col];
      const bCh = botRow[col];
      const top = tCh && tCh !== "." ? (PLUMBOB_STOPS[Number(tCh)] ?? null) : null;
      const bot = bCh && bCh !== "." ? (PLUMBOB_STOPS[Number(bCh)] ?? null) : null;
      line += renderPixelPair(top, bot);
    }
    lines.push(line);
  }
  return lines;
}

function renderWordmarkLines(color: boolean): string[] {
  const lines: string[] = [];
  for (let row = 0; row < WORDMARK_PIXELS.length; row += 2) {
    const topRow = WORDMARK_PIXELS[row] ?? "";
    const botRow = WORDMARK_PIXELS[row + 1] ?? "";
    let line = "";
    for (let col = 0; col < topRow.length; col++) {
      const hasTop = topRow[col] === "1";
      const hasBot = botRow[col] === "1";
      if (!hasTop && !hasBot) {
        line += " ";
      } else if (!color) {
        line += hasTop && hasBot ? "█" : hasTop ? "▀" : "▄";
      } else {
        const topRgb = hasTop ? PALETTE.white : null;
        const botRgb = hasBot ? PALETTE.white : null;
        line += renderPixelPair(topRgb, botRgb);
      }
    }
    lines.push(line);
  }
  return lines;
}

export function renderWordmarkBanner(version: string, opts: UiOptions = {}): string {
  const color = opts.color ?? supportsColor();
  const s = makeStyle(color);
  const icon = renderPlumbobLines(color);
  const word = renderWordmarkLines(color);
  const subtitle = `${s.pill(`v${version}`)} ${s.muted("personal apps on your own computers")}`;

  const rows = [
    `  ${icon[0]}   ${word[0]}`,
    `  ${icon[1]}   ${word[1]}`,
    `  ${icon[2]}   ${word[2]}`,
    `  ${icon[3]}   ${word[3]}`,
    `  ${icon[4]}   ${subtitle}`,
  ];
  return rows.join("\n");
}

export function brandHeader(section?: string, opts: UiOptions = {}): string {
  const color = opts.color ?? supportsColor();
  const s = makeStyle(color);
  const mark = color
    ? `${fg(PALETTE.shadow)}░${fg(PALETTE.deep)}▒${fg(PALETTE.violet)}◆${RESET}`
    : "◆";
  const right = section ? `  ${s.dim("·")}  ${s.muted(section)}` : "";
  return `${mark} ${s.bold("fleet")}${right}`;
}

export function shortenHome(dir: string): string {
  if (!dir || dir.startsWith("(")) return dir;
  const homeDir = os.homedir();
  if (
    homeDir &&
    (dir === homeDir || dir.startsWith(homeDir + "/") || dir.startsWith(homeDir + "\\"))
  ) {
    return `~${dir.slice(homeDir.length)}`;
  }
  return dir;
}

function visibleLength(text: string): number {
  let length = 0;
  for (let i = 0; i < text.length; i++) {
    if (text.charCodeAt(i) === 27 && text[i + 1] === "[") {
      const end = text.indexOf("m", i + 2);
      if (end !== -1) {
        i = end;
        continue;
      }
    }
    length++;
  }
  return length;
}

function padRight(text: string, width: number): string {
  const pad = Math.max(0, width - visibleLength(text));
  return text + " ".repeat(pad);
}

interface HelpGroup {
  title: string;
  items: Array<[cmd: string, desc: string]>;
}

const HELP_GROUPS: HelpGroup[] = [
  {
    title: "Apps",
    items: [
      ["fleet init [directory] [--service]", "Create and register an app or headless service"],
      ["fleet agent [--install]", "Print or install coding agent instructions"],
      ["fleet list [--json]", "List apps and runtime state"],
      ["fleet open [NAME]", "Open an app or alias through Gate"],
      ["fleet inspect NAME [--wait]", "Inspect operations, jobs, events, and build state"],
      ["fleet logs NAME [-n LINES] [-f]", "Read or follow an app log"],
      ["fleet logs --daemon", "Read the Fleet daemon log"],
      ["fleet check NAME", "Typecheck an app against fleet.d.ts"],
      ["fleet call APP queries|mutations|jobs OP [JSON]", "Run an operation as the owner"],
      ["fleet emit TOPIC [JSON]", "Publish an event to subscribed apps and services"],
      ["fleet events [--json]", "List event subscriptions, retries, and history"],
      ["fleet alias NAME URL", "Redirect a .fleet name to a URL"],
      ["fleet unregister NAME", "Remove an app route or alias"],
    ],
  },
  {
    title: "Data",
    items: [
      ["fleet backup NAME --output FILE", "Snapshot an app's SQLite database"],
      ["fleet restore NAME FILE", "Restore an app's SQLite database while stopped"],
    ],
  },
  {
    title: "Devices & Access",
    items: [
      ["fleet setup --install", "Set up this computer and start Fleet at boot"],
      ["fleet gate", "Create a device sign-in code"],
      ["fleet gate sessions", "List signed-in browser sessions"],
      ["fleet gate revoke ID", "Revoke one signed-in browser session"],
      ["fleet gate reset", "Disconnect all signed-in browsers"],
      ["fleet phone", "Connect an iPhone with a QR code"],
      ["fleet phone off", "Remove Fleet's temporary setup route"],
      ["fleet invite --output FILE", "Connect another computer with app checkouts"],
      ["fleet peers", "List enrolled computers and their apps"],
      ["fleet peers remove ID", "Remove a retired computer"],
      ["fleet profile --output FILE", "Export the public iPhone profile"],
    ],
  },
  {
    title: "System",
    items: [
      ["fleet update", "Install the latest Fleet release"],
      ["fleet doctor", "Check DNS, HTTPS, Tailscale, and the daemon"],
      ["fleet daemon", "Run the Fleet daemon in the foreground"],
      ["fleet uninstall", "Stop Fleet and remove computer trust"],
    ],
  },
];

function styleCommand(raw: string, s: ReturnType<typeof makeStyle>): string {
  const parts = raw.split(" ");
  const [bin, sub, ...rest] = parts;
  const head = sub ? `${s.violet(bin ?? "")} ${s.bold(sub)}` : s.violet(bin ?? "");
  if (!rest.length) return head;
  return `${head} ${s.dim(rest.join(" "))}`;
}

export function formatHelp(version: string, opts: UiOptions = {}): string {
  const color = opts.color ?? supportsColor();
  const s = makeStyle(color);
  const lines: string[] = ["", renderWordmarkBanner(version, { color }), ""];

  for (const group of HELP_GROUPS) {
    lines.push(`  ${s.highlight(group.title.toUpperCase(), true)}`);
    for (const [cmd, desc] of group.items) {
      const styled = styleCommand(cmd, s);
      if (cmd.length > 34) {
        lines.push(`    ${styled}`);
        lines.push(`    ${" ".repeat(36)}${s.muted(desc)}`);
      } else {
        lines.push(`    ${padRight(styled, 36)}${s.muted(desc)}`);
      }
    }
    lines.push("");
  }

  lines.push(
    `  ${s.dim("Requires Bun 1.4+ and Tailscale  ·  Agents:")} ${s.violet("fleet agent")}  ${s.dim("·  Pass")} ${s.violet("--json")} ${s.dim("for machine output.")}`,
  );
  return lines.join("\n");
}

function appStatusBadge(app: AppListItem, s: ReturnType<typeof makeStyle>): string {
  if (app.error) return s.err("✕ error", true);
  if (app.building) return s.violet("◐ building");
  if (app.peer && app.online === false) return s.warn("◇ offline");
  if (app.running) return s.ok("● running");
  return s.dim("○ idle");
}

export function formatAppList(apps: AppListItem[], opts: UiOptions = {}): string {
  const color = opts.color ?? supportsColor();
  const s = makeStyle(color);
  const runningCount = apps.filter((a) => a.running).length;
  const summary =
    apps.length === 0
      ? "0 apps"
      : `${apps.length} ${apps.length === 1 ? "app" : "apps"} · ${runningCount} running`;

  const lines: string[] = [brandHeader(summary, { color }), ""];

  if (apps.length === 0) {
    lines.push(`  ${s.muted("No apps registered yet.")}`);
    lines.push(`  ${s.dim("Create one with")} ${s.violet("fleet init notes")}${s.dim(".")}`);
    return lines.join("\n");
  }

  const rows = apps.map((app) => ({
    name: s.bold(app.name),
    state: appStatusBadge(app, s),
    url: s.violet(`https://${app.name}.fleet`),
    rev: app.revision ? s.dim(app.revision.slice(0, 8)) : s.dim("—"),
    dir: app.peer ? s.muted(`peer · ${app.peer.slice(0, 8)}`) : s.muted(shortenHome(app.directory)),
    error: app.error,
  }));

  const nameW = Math.max(8, ...rows.map((r) => visibleLength(r.name))) + 2;
  const stateW = Math.max(10, ...rows.map((r) => visibleLength(r.state))) + 2;
  const urlW = Math.max(12, ...rows.map((r) => visibleLength(r.url))) + 2;
  const revW = 10;

  lines.push(
    `  ${padRight(s.dim("APP"), nameW)}${padRight(s.dim("STATE"), stateW)}${padRight(s.dim("URL"), urlW)}${padRight(s.dim("REV"), revW)}${s.dim("LOCATION")}`,
  );
  lines.push(`  ${s.dim("─".repeat(Math.min(76, nameW + stateW + urlW + revW + 18)))}`);

  for (const row of rows) {
    lines.push(
      `  ${padRight(row.name, nameW)}${padRight(row.state, stateW)}${padRight(row.url, urlW)}${padRight(row.rev, revW)}${row.dir}`,
    );
    if (row.error) {
      lines.push(`    ${s.err(`↳ ${row.error.split("\n")[0]}`)}`);
    }
  }

  return lines.join("\n");
}

function formatEvery(seconds?: number): string {
  if (!seconds) return "";
  if (seconds % 86400 === 0) return `every ${seconds / 86400}d`;
  if (seconds % 3600 === 0) return `every ${seconds / 3600}h`;
  if (seconds % 60 === 0) return `every ${seconds / 60}m`;
  return `every ${seconds}s`;
}

export function formatInspect(app: AppListItem, opts: UiOptions = {}): string {
  const color = opts.color ?? supportsColor();
  const s = makeStyle(color);
  const lines: string[] = [brandHeader(`inspect · ${app.name}`, { color }), ""];

  const kv = (label: string, value: string) => `  ${padRight(s.dim(label), 13)}${value}`;
  lines.push(kv("State", appStatusBadge(app, s)));
  lines.push(kv("URL", s.violet(app.url || `https://${app.name}.fleet`)));
  lines.push(kv("Directory", s.text(shortenHome(app.directory))));
  lines.push(kv("Revision", app.revision ? s.muted(app.revision) : s.dim("not built yet")));
  if (app.peer) lines.push(kv("Peer", s.muted(app.peer)));
  if (app.hasClient === false) lines.push(kv("Mode", s.muted("headless service")));
  if (app.hasPublic) lines.push(kv("Static", s.muted("public/")));

  if (app.error) {
    lines.push("");
    lines.push(`  ${s.err("Build error", true)}`);
    for (const errLine of app.error.trim().split("\n").slice(0, 6)) {
      lines.push(`    ${s.err(errLine)}`);
    }
  }

  const queries = app.operations?.queries ?? [];
  const mutations = app.operations?.mutations ?? [];
  const jobNames = app.operations?.jobs ?? [];
  const eventNames = app.operations?.events ?? [];
  if (
    queries.length ||
    mutations.length ||
    jobNames.length ||
    eventNames.length ||
    (app.jobs?.length ?? 0) > 0
  ) {
    lines.push("");
    lines.push(`  ${s.highlight("OPERATIONS", true)}`);
    lines.push(
      kv(
        "Queries",
        queries.length ? queries.map((q) => s.text(q)).join(s.dim(", ")) : s.dim("none"),
      ),
    );
    lines.push(
      kv(
        "Mutations",
        mutations.length ? mutations.map((m) => s.text(m)).join(s.dim(", ")) : s.dim("none"),
      ),
    );
    if (app.jobs?.length) {
      const formattedJobs = app.jobs.map((job) => {
        const cadence = formatEvery(job.everySeconds);
        return cadence ? `${s.text(job.name)} ${s.dim(`(${cadence})`)}` : s.text(job.name);
      });
      lines.push(kv("Jobs", formattedJobs.join(s.dim(", "))));
    } else {
      lines.push(
        kv(
          "Jobs",
          jobNames.length ? jobNames.map((j) => s.text(j)).join(s.dim(", ")) : s.dim("none"),
        ),
      );
    }
    if (eventNames.length) {
      lines.push(kv("Events", eventNames.map((e) => s.violet(e)).join(s.dim(", "))));
    }
  }

  return lines.join("\n");
}

function summarizeDoctorCheck(item: DoctorCheck, s: ReturnType<typeof makeStyle>): string {
  if (item.skipped) return s.dim(item.reason || "skipped");
  if (item.ok === false) return s.err(item.error || "failed");
  if (item.check === "tailscale") {
    const addrs = (item.addresses ?? [])
      .map((a) => (typeof a === "string" ? a : a.address))
      .join(", ");
    const host = item.dnsName ? `${s.text(item.dnsName)} ` : "";
    return `${host}${addrs ? s.dim(`(${addrs})`) : s.ok("connected")}`.trim();
  }
  if (item.check === "daemon") {
    const count = item.apps ?? 0;
    return `${s.text("running")} ${s.dim(`· ${count} ${count === 1 ? "app" : "apps"}`)}`;
  }
  if (item.check === "system-dns") {
    const addrs = (item.addresses ?? [])
      .map((a) => (typeof a === "string" ? a : a.address))
      .join(", ");
    return `${s.text("gate.fleet")} ${s.dim("→")} ${s.violet(addrs || "resolved")}`;
  }
  return s.ok("ok");
}

export function formatDoctor(checks: DoctorCheck[], opts: UiOptions = {}): string {
  const color = opts.color ?? supportsColor();
  const s = makeStyle(color);
  const lines: string[] = [brandHeader("doctor", { color }), ""];

  for (const item of checks) {
    const icon =
      item.ok === true ? s.ok("✓", true) : item.ok === false ? s.err("✕", true) : s.dim("–");
    const label = padRight(s.bold(item.check), 14);
    lines.push(`  ${icon}  ${label} ${summarizeDoctorCheck(item, s)}`);
  }

  const failed = checks.filter((c) => c.ok === false).length;
  lines.push("");
  if (failed === 0) {
    lines.push(`  ${s.ok("All checks passed.", true)}`);
  } else {
    lines.push(`  ${s.err(`${failed} ${failed === 1 ? "check" : "checks"} failed.`, true)}`);
  }
  return lines.join("\n");
}

export function formatInit(
  name: string,
  directory: string,
  opts: UiOptions & { service?: boolean } = {},
): string {
  const color = opts.color ?? supportsColor();
  const s = makeStyle(color);
  const label = opts.service
    ? `Created headless service ${s.bold(name)}`
    : `Created ${s.bold(name)}`;
  const editHint = opts.service
    ? `${s.muted("Edit")} ${s.text("server/index.ts")}${s.muted(" — Fleet rebuilds on save.")}`
    : `${s.muted("Edit")} ${s.text("client/index.tsx")} ${s.muted("and")} ${s.text("server/index.ts")}${s.muted(" — Fleet rebuilds on save.")}`;
  const nextHint = opts.service
    ? `${s.dim("Run")} ${s.violet(`fleet inspect ${name} --wait`)} ${s.dim("then")} ${s.violet("fleet emit service.ping")} ${s.dim("to test it.")}`
    : `${s.dim("Run")} ${s.violet(`fleet open ${name}`)} ${s.dim("to open it in your browser.")}`;
  return [
    brandHeader("init", { color }),
    "",
    `  ${s.ok("✓", true)}  ${label}`,
    `     ${padRight(s.dim("URL"), 11)}${s.violet(`https://${name}.fleet`)}`,
    `     ${padRight(s.dim("Directory"), 11)}${s.text(shortenHome(directory))}`,
    "",
    `  ${editHint}`,
    `  ${nextHint}`,
  ].join("\n");
}

export function formatEvents(status: EventsStatusItem, opts: UiOptions = {}): string {
  const color = opts.color ?? supportsColor();
  const s = makeStyle(color);
  const subCount = status.subscriptions.length;
  const summary = `${subCount} ${subCount === 1 ? "subscription" : "subscriptions"} · ${status.pending.length} pending`;
  const lines = [brandHeader(summary, { color }), ""];

  if (!status.subscriptions.length) {
    lines.push(`  ${s.muted("No apps are subscribed to events yet.")}`);
    lines.push(
      `  ${s.dim("Export an")} ${s.text("events")} ${s.dim("object in")} ${s.text("server/index.ts")}${s.dim(" to subscribe.")}`,
    );
  } else {
    lines.push(`  ${s.highlight("SUBSCRIPTIONS", true)}`);
    const patternW = Math.max(10, ...status.subscriptions.map((sub) => sub.pattern.length)) + 2;
    for (const sub of status.subscriptions) {
      const origin = sub.peer ? ` ${s.dim(`(peer · ${sub.peer.slice(0, 8)})`)}` : "";
      lines.push(`    ${padRight(s.violet(sub.pattern), patternW)}${s.text(sub.app)}${origin}`);
    }
  }

  if (status.pending.length) {
    lines.push("");
    lines.push(`  ${s.highlight("PENDING RETRIES", true)}`);
    for (const item of status.pending) {
      const detail = item.error ? ` ${s.err(item.error.split("\n")[0])}` : "";
      lines.push(
        `    ${s.warn("◐")} ${s.text(item.topic)} ${s.dim("→")} ${s.text(item.targetApp)} ${s.dim(`(attempt ${item.failures + 1})`)}${detail}`,
      );
    }
  }

  if (status.recent.length) {
    lines.push("");
    lines.push(`  ${s.highlight("RECENT", true)}`);
    for (const item of status.recent.slice(0, 10)) {
      const icon =
        item.status === "delivered"
          ? s.ok("✓")
          : item.status === "dropped"
            ? s.warn("!")
            : s.err("✕");
      const target = item.targetApp === "*" ? s.dim("dropped") : s.text(item.targetApp);
      const err = item.error ? ` ${s.err(item.error.split("\n")[0])}` : "";
      lines.push(
        `    ${icon} ${s.violet(item.topic)} ${s.dim(`from ${item.source} →`)} ${target}${err}`,
      );
    }
  }

  return lines.join("\n");
}

export function formatSetup(
  params: { installed: boolean; ipv4?: string; needsDns: boolean },
  opts: UiOptions = {},
): string {
  const color = opts.color ?? supportsColor();
  const s = makeStyle(color);
  const lines: string[] = [
    brandHeader("setup", { color }),
    "",
    `  ${s.ok("✓", true)}  ${s.bold("Fleet is configured.")}`,
  ];
  if (!params.installed) {
    lines.push(
      `     ${s.muted("Run")} ${s.violet("fleet setup --install")} ${s.muted("for background startup, or")} ${s.violet("fleet daemon")} ${s.muted("to run in the foreground.")}`,
    );
  }
  if (params.needsDns) {
    lines.push("");
    lines.push(`  ${s.highlight("ONE-TIME TAILSCALE DNS", true)}`);
    lines.push(`    ${s.dim("1.")} Open ${s.violet("https://login.tailscale.com/admin/dns")}`);
    lines.push(
      `    ${s.dim("2.")} Add a restricted nameserver: ${s.bold(params.ipv4 || "<tailscale-ip>")} ${s.dim("restricted to")} ${s.violet("fleet")}`,
    );
    lines.push(
      `    ${s.dim("3.")} If you use an exit node, enable ${s.text("Use with exit node")} for this nameserver.`,
    );
    lines.push("");
    lines.push(
      `  ${s.muted("Then run")} ${s.violet("fleet gate")} ${s.muted("to sign in this browser, or")} ${s.violet("fleet phone")} ${s.muted("for your iPhone.")}`,
    );
  }
  return lines.join("\n");
}

export function formatGateCode(code: string, opts: UiOptions = {}): string {
  const color = opts.color ?? supportsColor();
  const s = makeStyle(color);
  return [
    brandHeader("gate", { color }),
    "",
    `  ${s.dim("Device code")}   ${s.pill(code)}`,
    `  ${s.dim("Sign in at")}    ${s.violet("https://gate.fleet")}`,
    `  ${s.dim("Expires in")}    ${s.muted("10 minutes")}`,
  ].join("\n");
}

export function formatPeerList(peers: PeerComputerItem[], opts: UiOptions = {}): string {
  const color = opts.color ?? supportsColor();
  const s = makeStyle(color);
  const online = peers.filter((peer) => peer.online).length;
  const lines = [
    brandHeader(
      `${peers.length} ${peers.length === 1 ? "computer" : "computers"} · ${online} online`,
      { color },
    ),
    "",
  ];
  if (!peers.length) {
    lines.push(`  ${s.muted("No other computers enrolled.")}`);
    lines.push(
      `  ${s.dim("Connect one with")} ${s.violet("fleet invite --output FILE")}${s.dim(".")}`,
    );
    return lines.join("\n");
  }
  for (const peer of peers) {
    const state = peer.online ? s.ok("online") : s.dim("offline");
    lines.push(`  ${s.text(peer.id)}  ${state}  ${s.dim(`${peer.address}:${peer.port}`)}`);
    if (!peer.apps.length) {
      lines.push(`    ${s.dim("no apps")}`);
      continue;
    }
    for (const app of peer.apps) {
      const appState = app.error ? s.err("error") : app.running ? s.ok("running") : s.dim("idle");
      const revision = app.revision ? s.dim(app.revision.slice(0, 8)) : s.dim("not built");
      lines.push(`    ${s.text(app.name)}  ${appState}  ${revision}`);
    }
  }
  return lines.join("\n");
}

export function formatGateSessions(sessions: GateSessionItem[], opts: UiOptions = {}): string {
  const color = opts.color ?? supportsColor();
  const s = makeStyle(color);
  const lines = [
    brandHeader(sessions.length === 1 ? "1 gate session" : `${sessions.length} gate sessions`, {
      color,
    }),
    "",
  ];
  if (!sessions.length) {
    lines.push(`  ${s.muted("No signed-in browsers.")}`);
    return lines.join("\n");
  }
  const rows = sessions.map((session) => ({
    id: s.text(session.id),
    host: s.violet(session.host),
    device: s.text(session.userAgent),
    seen: s.dim(session.lastSeen.slice(0, 16).replace("T", " ")),
  }));
  const idW = Math.max(4, ...rows.map((row) => visibleLength(row.id))) + 2;
  const hostW = Math.max(8, ...rows.map((row) => visibleLength(row.host))) + 2;
  const deviceW = Math.max(10, ...rows.map((row) => visibleLength(row.device))) + 2;
  lines.push(
    `  ${padRight(s.dim("ID"), idW)}${padRight(s.dim("HOST"), hostW)}${padRight(s.dim("DEVICE"), deviceW)}${s.dim("LAST SEEN")}`,
  );
  lines.push(`  ${s.dim("─".repeat(Math.min(76, idW + hostW + deviceW + 16)))}`);
  for (const row of rows) {
    lines.push(
      `  ${padRight(row.id, idW)}${padRight(row.host, hostW)}${padRight(row.device, deviceW)}${row.seen}`,
    );
  }
  return lines.join("\n");
}

export function formatPhoneSetup(
  params: { qr: string; url: string; code: string },
  opts: UiOptions = {},
): string {
  const color = opts.color ?? supportsColor();
  const s = makeStyle(color);
  const indentedQr = params.qr
    .trimEnd()
    .split("\n")
    .map((line) => `  ${line}`)
    .join("\n");
  return [
    brandHeader("phone", { color }),
    "",
    `  ${s.muted("Scan with your iPhone while Tailscale is connected:")}`,
    "",
    indentedQr,
    "",
    `  ${s.dim("Setup URL")}     ${s.violet(params.url)}`,
    `  ${s.dim("Device code")}   ${s.pill(params.code)}`,
    "",
    `  ${s.dim("1.")} Install the Fleet profile in ${s.text("Settings › General › VPN & Device Management")}`,
    `  ${s.dim("2.")} Trust Fleet in ${s.text("General › About › Certificate Trust Settings")}`,
    `  ${s.dim("3.")} Tap ${s.text("Open Fleet")} to sign in at ${s.violet("https://gate.fleet/phone")} ${s.dim("(setup link closes automatically)")}`,
  ].join("\n");
}

export function formatDaemonReady(opts: UiOptions = {}): string {
  const color = opts.color ?? supportsColor();
  const s = makeStyle(color);
  return [
    brandHeader("daemon", { color }),
    "",
    `  ${s.ok("●", true)}  ${s.bold("Fleet is running.")}  ${s.violet("https://gate.fleet")}`,
    `     ${s.dim("Press Ctrl+C to stop.")}`,
  ].join("\n");
}

export function formatNotice(
  kind: "ok" | "info" | "warn",
  message: string,
  detail?: string,
  opts: UiOptions = {},
): string {
  const color = opts.color ?? supportsColor();
  const s = makeStyle(color);
  const glyph =
    kind === "ok" ? s.ok("✓", true) : kind === "warn" ? s.warn("!", true) : s.violet("◆");
  const base = `${glyph}  ${s.text(message)}`;
  return detail ? `${base}\n   ${s.muted(detail)}` : base;
}

export function formatError(message: string, opts: UiOptions = {}): string {
  const color = opts.color ?? supportsColor(process.stderr);
  const s = makeStyle(color);
  return `${s.err("✕ fleet", true)}  ${s.text(message)}`;
}
