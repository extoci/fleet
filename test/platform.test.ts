import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, test } from "bun:test";
import {
  keychainHashes,
  libraryCandidates,
  libraryRpaths,
  nonSystemLibraries,
  serviceFiles,
  tailscaleApprovalUrl,
  tailscaleFailureMessage,
  tailscaleServe,
  turnOffPhoneRoute,
} from "../src/platform.ts";

const cleanups: Array<() => void | Promise<void>> = [];
afterEach(async () => {
  for (const fn of cleanups.splice(0).reverse()) await fn();
});

test("macOS rpaths include all universal slices without duplicates", () => {
  const command = (value: string) =>
    `Load command 1\n          cmd LC_RPATH\n      cmdsize 48\n         path ${value} (offset 12)\n`;
  assert.deepEqual(
    libraryRpaths(
      command("@loader_path") + command("@loader_path/../lib") + command("@loader_path"),
    ),
    ["@loader_path", "@loader_path/../lib"],
  );
  assert.deepEqual(libraryRpaths(""), []);
  assert.deepEqual(libraryRpaths("cmd LC_LOAD_DYLIB\n cmdsize 48\n name /lib/foo (offset 12)"), []);
});

test("macOS library references resolve relative to the referencing image", () => {
  const resolve = (reference: string, rpaths: string[] = []) =>
    libraryCandidates(reference, "/brew/lib/a.dylib", "/brew/bin/bun", rpaths);
  assert.deepEqual(
    resolve("@rpath/b.dylib", ["@loader_path", "@executable_path/../lib", "/other/lib"]),
    ["/brew/lib/b.dylib", "/brew/lib/b.dylib", "/other/lib/b.dylib"],
  );
  assert.deepEqual(resolve("@loader_path/../b.dylib"), ["/brew/b.dylib"]);
  assert.deepEqual(resolve("@executable_path/b.dylib"), ["/brew/bin/b.dylib"]);
  assert.deepEqual(resolve("/usr/lib/b.dylib"), ["/usr/lib/b.dylib"]);
  assert.deepEqual(resolve("@rpath/b.dylib"), []);
  assert.throws(() => resolve("relative.dylib"), /Unsupported library path/);
  assert.throws(() => resolve("@rpath/b.dylib", ["@unknown"]), /Unsupported library path/);
});

test("macOS and Linux service files launch the root-owned Bun port helper", () => {
  const mac = serviceFiles("/home/fleet", { addresses: [], mode: "node" }, "darwin");
  assert.ok(mac.content.includes(`<string>${mac.destination}/bun</string>`));
  assert.ok(mac.content.includes(`<string>${mac.destination}/ports.ts</string>`));
  const linux = serviceFiles("/home/fleet", { addresses: [] }, "linux");
  assert.ok(linux.content.includes(`"${linux.destination}/bun"`));
  assert.ok(linux.content.includes(`"${linux.destination}/ports.ts"`));
});

test("macOS setup finds libraries outside the system", () => {
  const homebrew = `/opt/homebrew/Cellar/bun/1.4.5/bin/bun:
\t@rpath/libbun.dylib (compatibility version 0.0.0, current version 0.0.0)
\t/opt/homebrew/opt/libuv/lib/libuv.1.dylib (compatibility version 2.0.0, current version 2.0.0)
\t/usr/lib/libc++.1.dylib (compatibility version 1.0.0, current version 1900.180.0)
\t/System/Library/Frameworks/CoreFoundation.framework/Versions/A/CoreFoundation (compatibility version 150.0.0, current version 3502.1.401)
`;
  assert.deepEqual(nonSystemLibraries(homebrew), [
    "@rpath/libbun.dylib",
    "/opt/homebrew/opt/libuv/lib/libuv.1.dylib",
  ]);
  const official = `/usr/local/bin/bun:
\t/usr/lib/libSystem.B.dylib (compatibility version 1.0.0, current version 1351.0.0)
\t/System/Library/Frameworks/Security.framework/Versions/A/Security (compatibility version 1.0.0, current version 61439.1.2)
`;
  assert.deepEqual(nonSystemLibraries(official), []);
  const universal = `/usr/local/bin/bun (architecture x86_64):
\t/System/Library/Frameworks/CoreFoundation.framework/Versions/A/CoreFoundation (compatibility version 150.0.0, current version 1971.0.0)
\t/usr/lib/libSystem.B.dylib (compatibility version 1.0.0, current version 1311.100.3)
/usr/local/bin/bun (architecture arm64):
\t/System/Library/Frameworks/CoreFoundation.framework/Versions/A/CoreFoundation (compatibility version 150.0.0, current version 1971.0.0)
\t/usr/lib/libSystem.B.dylib (compatibility version 1.0.0, current version 1311.100.3)
`;
  assert.deepEqual(nonSystemLibraries(universal), []);
  assert.deepEqual(
    nonSystemLibraries(
      universal.replaceAll(
        "\t/usr/lib/libSystem",
        "\t@rpath/libbun.dylib (compatibility version 0.0.0, current version 0.0.0)\n\t/usr/lib/libSystem",
      ),
    ),
    ["@rpath/libbun.dylib"],
  );
});

test("macOS uninstall reads every keychain copy of the Fleet root", () => {
  const a = "A".repeat(40);
  const b = "0123456789ABCDEF0123456789ABCDEF01234567";
  const output = `SHA-256 hash: ${"C".repeat(64)}\nSHA-1 hash: ${a}\nkeychain: "/Library/Keychains/System.keychain"\nSHA-1 hash: ${b}\n`;
  assert.deepEqual(keychainHashes(output), [a, b]);
  assert.deepEqual(keychainHashes(""), []);
});

test("Tailscale Serve error messages guide users clearly", () => {
  const serveUrl = "https://login.tailscale.com/f/serve?node=npsfdyDTW611CNTRL";
  assert.equal(
    tailscaleApprovalUrl(
      `Serve is not enabled on your tailnet.\nTo enable, visit:\n  ${serveUrl}\n`,
    ),
    serveUrl,
  );
  assert.equal(tailscaleApprovalUrl("no link here"), null);

  const denied = tailscaleFailureMessage(
    "sending serve config: Access denied: serve config denied\nTo not require root, use 'sudo tailscale set --operator=$USER' once.",
    { retryCommand: "fleet phone", user: "exotic" },
  );
  assert.match(denied, /sudo tailscale set --operator=exotic/);
  assert.match(denied, /Then run fleet phone again/);
  assert.doesNotMatch(denied, /Tailscale is unavailable/);

  const timedOut = tailscaleFailureMessage("", {
    retryCommand: "fleet phone",
    timedOut: true,
    approvalUrl: serveUrl,
  });
  assert.match(timedOut, /Timed out waiting for Tailscale Serve approval/);
  assert.ok(timedOut.includes(serveUrl));

  const httpsNeeded = tailscaleFailureMessage("HTTPS is not enabled on your tailnet", {
    retryCommand: "fleet phone",
  });
  assert.match(httpsNeeded, /login\.tailscale\.com\/admin\/dns/);

  const generic = tailscaleFailureMessage("failed to connect to local tailscaled");
  assert.match(generic, /Tailscale is unavailable/);
});

test("tailscaleServe streams approval links live and surfaces clear errors", async () => {
  const serveUrl = "https://login.tailscale.com/f/serve?node=test123";
  const notices: string[] = [];
  await tailscaleServe(
    [
      "-e",
      `console.error("Serve is not enabled on your tailnet.\\nTo enable, visit:\\n  ${serveUrl}"); setTimeout(() => process.exit(0), 50);`,
    ],
    {
      executable: process.execPath,
      onNotice: (message) => notices.push(message),
    },
  );
  assert.equal(notices.length, 1);
  assert.ok(notices[0].includes(serveUrl));
  assert.match(notices[0], /Waiting for approval/);

  await assert.rejects(
    tailscaleServe(
      [
        "-e",
        'console.error("sending serve config: Access denied: serve config denied"); process.exit(1);',
      ],
      { executable: process.execPath, retryCommand: "fleet phone" },
    ),
    (error: Error) => {
      assert.match(error.message, /sudo tailscale set --operator=/);
      assert.doesNotMatch(error.message, /Tailscale is unavailable/);
      return true;
    },
  );

  const timeoutNotices: string[] = [];
  await assert.rejects(
    tailscaleServe(
      ["-e", `console.error("To enable, visit: ${serveUrl}"); setTimeout(() => {}, 5000);`],
      {
        executable: process.execPath,
        timeout: 150,
        onNotice: (message) => timeoutNotices.push(message),
      },
    ),
    (error: Error) => {
      assert.match(error.message, /Timed out waiting for Tailscale Serve approval/);
      assert.ok(error.message.includes(serveUrl));
      return true;
    },
  );
  assert.equal(timeoutNotices.length, 1);
});

test("turnOffPhoneRoute checks ownership before disabling Tailscale Serve", async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "fleet-v2-phone-off-"));
  cleanups.push(() => fs.rmSync(home, { recursive: true, force: true }));

  assert.deepEqual(await turnOffPhoneRoute(home), {
    removed: false,
    reason: "missing",
  });

  const routeFile = path.join(home, "phone-serve.json");
  fs.writeFileSync(
    routeFile,
    JSON.stringify({
      port: 8444,
      host: "emerald.ts.net",
      proxy: "http://127.0.0.1:42173",
    }),
  );

  await assert.rejects(
    turnOffPhoneRoute(home, {
      runTailscale: async () =>
        JSON.stringify({
          Web: {
            "emerald.ts.net:8444": {
              Handlers: { "/": { Proxy: "http://127.0.0.1:9999" } },
            },
          },
        }),
    }),
    /The setup route has changed/,
  );
  assert.equal(fs.existsSync(routeFile), true);

  const calls: string[][] = [];
  const result = await turnOffPhoneRoute(home, {
    runTailscale: async (args) => {
      calls.push(args);
      if (args[1] === "status") {
        return JSON.stringify({
          Web: {
            "emerald.ts.net:8444": {
              Handlers: { "/": { Proxy: "http://127.0.0.1:42173" } },
            },
          },
        });
      }
      return "";
    },
  });
  assert.deepEqual(result, { removed: true });
  assert.deepEqual(calls, [
    ["serve", "status", "--json"],
    ["serve", "--https=8444", "off"],
  ]);
  assert.equal(fs.existsSync(routeFile), false);
});
