import test from "node:test";
import assert from "node:assert/strict";
import { keychainHashes, nonSystemLibraries } from "../src/platform.mjs";

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
});

test("macOS uninstall reads every keychain copy of the Fleet root", () => {
  const a = "A".repeat(40);
  const b = "0123456789ABCDEF0123456789ABCDEF01234567";
  const output = `SHA-256 hash: ${"C".repeat(64)}\nSHA-1 hash: ${a}\nkeychain: "/Library/Keychains/System.keychain"\nSHA-1 hash: ${b}\n`;
  assert.deepEqual(keychainHashes(output), [a, b]);
  assert.deepEqual(keychainHashes(""), []);
});
