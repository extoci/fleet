// Installed as a root-owned copy with a root-owned Node executable on Unix.
// This process only forwards sockets. App code runs in the owner's daemon.
import fs from "node:fs";
import net from "node:net";
import dgram from "node:dgram";
import { spawn } from "node:child_process";

const config = JSON.parse(fs.readFileSync(process.argv[2], "utf8"));
if (
  !Number.isInteger(config.uid) ||
  config.uid === 0 ||
  !Number.isInteger(config.gid)
)
  throw new Error("An unprivileged owner is required.");
const cleanEnv = {
  PATH: "/usr/local/bin:/usr/bin:/bin",
  HOME: config.userHome,
  FLEET_V2_HOME: config.home,
};
let child;
let stopping = false;
function launch() {
  child = spawn(config.node, [config.cli, "daemon", "--forwarded"], {
    uid: config.uid,
    gid: config.gid,
    env: cleanEnv,
    stdio: "inherit",
  });
  child.on("error", (error) => console.error(error.message));
  child.on("exit", () => {
    if (!stopping) setTimeout(launch, 3000);
  });
}
launch();
const resources = [];
let connections = 0;
for (const address of config.mode === "node"
  ? []
  : ["127.0.0.1", ...config.addresses.filter((a) => net.isIP(a) !== 0)]) {
  if (address !== "127.0.0.1" && !/^fd7a:115c:a1e0:/i.test(address)) {
    const bytes = address.split(".").map(Number);
    if (bytes[0] !== 100 || bytes[1] < 64 || bytes[1] > 127)
      throw new Error("Only loopback and Tailscale addresses can be bound.");
  }
  for (const [external, internal] of [
    [443, 8443],
    [53, 1053],
  ]) {
    const server = net.createServer((socket) => {
      if (++connections > 512) {
        connections--;
        socket.destroy();
        return;
      }
      const target = net.connect(internal, "127.0.0.1");
      socket.on("error", () => target.destroy());
      target.on("error", () => socket.destroy());
      socket.once("close", () => {
        connections--;
        target.destroy();
      });
      target.once("close", () => socket.destroy());
      socket.pipe(target).pipe(socket);
    });
    server.on("error", (error) => {
      console.error(`Fleet port ${external}: ${error.message}`);
      process.exit(1);
    });
    server.listen(external, address);
    resources.push(server);
  }
  const socket = dgram.createSocket(net.isIP(address) === 6 ? "udp6" : "udp4");
  let pending = 0;
  socket.on("message", (message, remote) => {
    if (message.length > 4096 || pending >= 128) return;
    pending++;
    const upstream = dgram.createSocket("udp4");
    let closed = false;
    const finish = () => {
      if (!closed) {
        closed = true;
        pending--;
        clearTimeout(timer);
        upstream.close();
      }
    };
    const timer = setTimeout(finish, 3000);
    upstream.on("error", finish);
    upstream.once("message", (response) => {
      socket.send(response, remote.port, remote.address);
      finish();
    });
    upstream.send(message, 1053, "127.0.0.1");
  });
  socket.on("error", (error) => {
    console.error(error.message);
    process.exit(1);
  });
  socket.bind(53, address);
  resources.push(socket);
}
for (const signal of ["SIGINT", "SIGTERM"])
  process.on(signal, () => {
    stopping = true;
    child?.kill();
    for (const resource of resources) resource.close();
    setTimeout(() => process.exit(0), 1000);
  });
process.on("exit", () => child?.kill());
