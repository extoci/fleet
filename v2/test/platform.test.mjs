import test from "node:test";
import assert from "node:assert/strict";
import {
  keychainHashes,
  nonSystemLibraries,
  libraryRpaths,
  libraryCandidates,
  serviceFiles,
} from "../src/platform.mjs";

test("macOS rpaths include all universal slices without duplicates", () => {
  const command = (value) =>
    `Load command 1\n          cmd LC_RPATH\n      cmdsize 48\n         path ${value} (offset 12)\n`;
  assert.deepEqual(
    libraryRpaths(
      command("@loader_path") +
        command("@loader_path/../lib") +
        command("@loader_path"),
    ),
    ["@loader_path", "@loader_path/../lib"],
  );
  assert.deepEqual(libraryRpaths(""), []);
  assert.deepEqual(
    libraryRpaths("cmd LC_LOAD_DYLIB\n cmdsize 48\n name /lib/foo (offset 12)"),
    [],
  );
});

test("macOS library references resolve relative to the referencing image", () => {
  const resolve = (reference, rpaths = []) =>
    libraryCandidates(reference, "/brew/lib/a.dylib", "/brew/bin/node", rpaths);
  assert.deepEqual(
    resolve("@rpath/b.dylib", [
      "@loader_path",
      "@executable_path/../lib",
      "/other/lib",
    ]),
    ["/brew/lib/b.dylib", "/brew/lib/b.dylib", "/other/lib/b.dylib"],
  );
  assert.deepEqual(resolve("@loader_path/../b.dylib"), ["/brew/b.dylib"]);
  assert.deepEqual(resolve("@executable_path/b.dylib"), ["/brew/bin/b.dylib"]);
  assert.deepEqual(resolve("/usr/lib/b.dylib"), ["/usr/lib/b.dylib"]);
  assert.deepEqual(resolve("@rpath/b.dylib"), []);
  assert.throws(() => resolve("relative.dylib"), /Unsupported library path/);
  assert.throws(
    () => resolve("@rpath/b.dylib", ["@unknown"]),
    /Unsupported library path/,
  );
});

test("macOS daemon uses a private OpenSSL configuration", () => {
  const files = serviceFiles(
    "/home/fleet",
    { addresses: [], mode: "node" },
    "darwin",
  );
  assert.ok(
    files.content.includes(
      `<string>--openssl-config=${files.destination}/openssl.cnf</string>`,
    ),
  );
});

test("macOS setup finds Node.js libraries outside the system", () => {
  const homebrew = `/opt/homebrew/Cellar/node/24.21.0/bin/node:
\t@rpath/libnode.137.dylib (compatibility version 0.0.0, current version 0.0.0)
\t/opt/homebrew/opt/libuv/lib/libuv.1.dylib (compatibility version 2.0.0, current version 2.0.0)
\t/usr/lib/libc++.1.dylib (compatibility version 1.0.0, current version 1900.180.0)
\t/System/Library/Frameworks/CoreFoundation.framework/Versions/A/CoreFoundation (compatibility version 150.0.0, current version 3502.1.401)
`;
  assert.deepEqual(nonSystemLibraries(homebrew), [
    "@rpath/libnode.137.dylib",
    "/opt/homebrew/opt/libuv/lib/libuv.1.dylib",
  ]);
  const official = `/usr/local/bin/node:
\t/usr/lib/libSystem.B.dylib (compatibility version 1.0.0, current version 1351.0.0)
\t/System/Library/Frameworks/Security.framework/Versions/A/Security (compatibility version 1.0.0, current version 61439.1.2)
`;
  assert.deepEqual(nonSystemLibraries(official), []);
  const universal = `/usr/local/bin/node (architecture x86_64):
\t/System/Library/Frameworks/CoreFoundation.framework/Versions/A/CoreFoundation (compatibility version 150.0.0, current version 1971.0.0)
\t/usr/lib/libSystem.B.dylib (compatibility version 1.0.0, current version 1311.100.3)
/usr/local/bin/node (architecture arm64):
\t/System/Library/Frameworks/CoreFoundation.framework/Versions/A/CoreFoundation (compatibility version 150.0.0, current version 1971.0.0)
\t/usr/lib/libSystem.B.dylib (compatibility version 1.0.0, current version 1311.100.3)
`;
  assert.deepEqual(nonSystemLibraries(universal), []);
  assert.deepEqual(
    nonSystemLibraries(
      universal.replaceAll(
        "\t/usr/lib/libSystem",
        "\t@rpath/libnode.137.dylib (compatibility version 0.0.0, current version 0.0.0)\n\t/usr/lib/libSystem",
      ),
    ),
    ["@rpath/libnode.137.dylib"],
  );
});

test("macOS uninstall reads every keychain copy of the Fleet root", () => {
  const a = "A".repeat(40);
  const b = "0123456789ABCDEF0123456789ABCDEF01234567";
  const output = `SHA-256 hash: ${"C".repeat(64)}\nSHA-1 hash: ${a}\nkeychain: "/Library/Keychains/System.keychain"\nSHA-1 hash: ${b}\n`;
  assert.deepEqual(keychainHashes(output), [a, b]);
  assert.deepEqual(keychainHashes(""), []);
});
