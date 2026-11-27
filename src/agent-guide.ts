import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export function agentContract(name: string): string {
  return `## Fleet app

This directory is the app — Fleet registered it in place. Edit client/index.tsx, client/style.css, and server/index.ts. Fleet builds and updates the app automatically. Do not start Vite or a separate app server.

Use fleet list --json, fleet inspect ${name}, and fleet logs ${name} to inspect the running app. Exercise operations with fleet call ${name} KIND OP [JSON] — KIND is queries, mutations, or jobs — e.g. fleet call ${name} queries notes for reads. Quote JSON arguments for your shell.

The server exports queries, mutations, and jobs. See fleet.d.ts for FleetCtx and FleetDb. Store persistent JSON in ctx.db. The data is outside the checkout and survives rebuilds. Queries cannot write.

ctx.db.get returns null for a missing key. ctx.db.delete returns true if it deleted a key. ctx.db.list(prefix) returns up to 1,000 items. Keys are limited to 512 characters; stored values and operation results are limited to 2 MB.

Fleet runs each mutation or job in an implicit SQLite transaction. If the handler throws, Fleet rolls back all ctx.db writes from that call. Return a structured { ok: false, error } result to keep writes that record a failure.

To schedule a job, add {"name":"dailyCheck","everySeconds":86400} to the jobs array in fleet.json — everySeconds must be an integer of at least 5. Jobs run without a browser. Fleet can retry an interrupted job with the same ctx.runId. Use that ID as the idempotency key for external API requests. App code runs with this computer user's permissions.

Import useQuery, useMutation, and call from fleet/client. Fleet provides Preact. Do not install Preact in the app. useQuery returns { data, error } — data starts as undefined and error as null. Use call(kind, name, input) — kind is queries or mutations — to write without refetching all queries.

useQuery(name, input, { pollMs }) polls every 10 seconds while the page is visible by default. Set pollMs to false or 0 to stop interval polling. useMutation(name, { invalidate }) refreshes all active queries by default. Set invalidate to an array of query names or to false to skip the refresh. Pass { keepalive: true } as the fourth argument to call for a small write during page unload.

Put static files in public/. Set title, themeColor, icon, or manifest in fleet.json to change the HTML head — never change name or id. Use paths from the site root, such as /icon.svg, for icon and manifest.

Fleet Gate handles sign-in. Do not add a separate login system.

Store server secrets in .env.fleet.server and read them through ctx.env. Git ignores this file. Do not import it into the client.

fleet init, fleet register, fleet agent, fleet list, fleet inspect, fleet logs, fleet call, fleet backup, fleet doctor, --help, and --version are normal app work and need no extra authorization (mutations and jobs write real app data). Every other subcommand — including alias, setup, daemon, gate, phone, invite, profile, restore, unregister, update, and uninstall — and direct edits under the Fleet home directory require explicit owner authorization. If a command reports Fleet is not running, tell the user — do not run fleet setup or fleet daemon yourself.

You are done when fleet inspect ${name} reports a new revision with no error (rebuilds take a few seconds) and, if an operation changed, fleet call exercises it. Report the change and https://${name}.fleet — no extra audits or browser checks unless asked.
`;
}

export function agentGuide(): string {
  return `# Building Fleet apps — instructions for coding agents

A Fleet app is a directory anywhere on this computer — Fleet never copies apps into an internal folder. \`fleet init DIR\` creates and registers a new app directory at DIR. \`fleet init\` (with optional \`--name NAME\`) scaffolds into the current directory without overwriting existing source files. If a directory already contains \`fleet.json\`, \`fleet init DIR\` or \`fleet register DIR\` re-registers it in place.

The app name comes from the directory basename, sanitized (\`--name NAME\` overrides it for new apps; an existing \`fleet.json\` name wins). \`fleet init --json\` returns the authoritative name and URL.

When asked to create a Fleet "app", "file", "folder", or "project", scaffold a directory with \`fleet init\`. Do not hand-write starter files or create a bootstrap script that copies files elsewhere.

These commands are normal app work and need no extra authorization — the daemon picks up newly registered apps automatically:

- \`fleet agent\`, \`fleet --help\`, \`fleet --version\`, \`fleet doctor\`
- \`fleet init\`, \`fleet register\`, \`fleet list\`, \`fleet inspect\`, \`fleet logs\`
- \`fleet call\` and \`fleet backup --output FILE\` on the app you are working on (mutations and jobs write real app data)

Run app commands on the computer that holds the checkout — \`fleet init\`, \`fleet register\`, \`fleet logs\`, and \`fleet backup\` operate on local apps.

Do not run other \`fleet\` subcommands (\`alias\`, \`setup\`, \`daemon\`, \`gate\`, \`phone\`, \`invite\`, \`profile\`, \`restore\`, \`unregister\`, \`update\`, \`uninstall\`) or edit files under the Fleet home directory (\`~/.fleet/v2\`, or \`$FLEET_V2_HOME\`/\`$FLEET_HOME\`) unless explicitly asked. When explicitly asked to manage sign-ins, \`fleet gate sessions [--json]\` lists session IDs, hosts, devices, and timestamps, and \`fleet gate revoke ID\` revokes one session without affecting others. If a command reports that Fleet is not running, tell the user — do not start the daemon or run setup yourself.

When asked to link to an existing web service, run \`fleet alias NAME URL\` on the Fleet gateway. Open \`https://NAME.fleet\` to sign in and go to the configured URL. The browser needs access to that service. Use \`fleet unregister NAME\` to remove the alias.

## Workflow

1. Run \`fleet init DIR\` (for example \`fleet init notes\`) to create and register the app directory, or \`fleet init\` inside the directory that should be the app.
2. Note the current revision with \`fleet inspect NAME\`, then edit \`client/index.tsx\`, \`client/style.css\`, and \`server/index.ts\`. Fleet rebuilds on save and keeps serving the last good build if a rebuild fails.
3. Give the rebuild a few seconds, then check \`fleet inspect NAME\` reports a new revision with no error (\`fleet logs NAME\` shows build output). Exercise any changed operation with \`fleet call NAME KIND OP [JSON]\`.
4. Stop there and report \`https://NAME.fleet\`. Run extra audits, browser passes, or data recounts only if asked.

Each initialized app contains \`AGENTS.md\` and \`fleet.d.ts\` — read them before editing. \`AGENTS.md\` carries this contract:

${agentContract("NAME").trimEnd()}
`;
}

export function agentSkill(): string {
  return `---
name: fleet
description: Build, inspect, and update personal Fleet apps on this computer using the fleet CLI (fleet init, fleet inspect, fleet logs, fleet call). Use whenever creating or editing a Fleet app.
---

${agentGuide()}`;
}

const DETECTED_AGENT_DIRS = [".claude", ".codex", path.join(".config", "devin")];

export function installAgentSkill(homeDir = os.homedir(), output?: string): string[] {
  const skill = agentSkill();
  if (output) {
    const target = path.resolve(output);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, skill, "utf8");
    return [target];
  }
  const targets = new Set<string>([
    path.resolve(homeDir, ".agents", "skills", "fleet", "SKILL.md"),
  ]);
  for (const dir of DETECTED_AGENT_DIRS) {
    const root = path.join(homeDir, dir);
    if (fs.existsSync(root) && fs.statSync(root).isDirectory()) {
      targets.add(path.resolve(root, "skills", "fleet", "SKILL.md"));
    }
  }
  const installed: string[] = [];
  for (const target of targets) {
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, skill, "utf8");
    installed.push(target);
  }
  return installed;
}
