import assert from "node:assert/strict";
import dgram from "node:dgram";
import net from "node:net";
import { afterEach, test } from "bun:test";
import packet from "dns-packet";
import { startDNS } from "../src/dns.ts";

const cleanups: Array<() => void | Promise<void>> = [];
afterEach(async () => {
  for (const fn of cleanups.splice(0).reverse()) await fn();
});

test("the suffix resolver supports UDP/TCP, IPv4/IPv6, browser HTTPS queries, and refuses recursion", async () => {
  const dns = await startDNS({
    host: "127.0.0.1",
    port: 0,
    addresses: ["100.90.1.2", "fd7a:115c:a1e0::1"],
    names: () => new Set(["notes.fleet"]),
  });
  cleanups.push(() => dns.close());

  async function query(name: string, type: string, tcp = false) {
    const encoded = packet.encode({
      type: "query",
      id: 42,
      flags: packet.RECURSION_DESIRED,
      questions: [{ name, type }],
    });
    const bytes = await new Promise<Buffer>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("DNS test timed out.")), 3000);
      if (tcp) {
        const socket = net.connect(dns.port, "127.0.0.1");
        socket.on("error", reject);
        let result = Buffer.alloc(0);
        socket.on("connect", () => {
          const length = Buffer.alloc(2);
          length.writeUInt16BE(encoded.length);
          socket.write(Buffer.concat([length, encoded]));
        });
        socket.on("data", (part) => {
          result = Buffer.concat([result, typeof part === "string" ? Buffer.from(part) : part]);
          if (result.length >= 2 && result.length >= result.readUInt16BE(0) + 2) {
            clearTimeout(timer);
            resolve(result.subarray(2));
            socket.destroy();
          }
        });
      } else {
        const socket = dgram.createSocket("udp4");
        socket.on("error", reject);
        socket.once("message", (result) => {
          clearTimeout(timer);
          socket.close();
          resolve(result);
        });
        socket.send(encoded, dns.port, "127.0.0.1");
      }
    });
    return packet.decode(bytes);
  }

  assert.equal((await query("NOTES.FLEET", "A")).answers?.[0].data, "100.90.1.2");
  assert.equal((await query("notes.fleet", "AAAA", true)).answers?.[0].data, "fd7a:115c:a1e0::1");
  const https = await query("notes.fleet", "HTTPS");
  assert.equal(https.rcode, "NOERROR");
  assert.deepEqual(https.answers, []);
  assert.equal((await query("missing.fleet", "A")).rcode, "NXDOMAIN");
  assert.equal((await query("notes.fleet.example.com", "A")).rcode, "REFUSED");
  assert.equal((await query("example.com", "A", true)).rcode, "REFUSED");
});
