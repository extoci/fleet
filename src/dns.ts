import dgram from "node:dgram";
import net from "node:net";
import packet from "dns-packet";

export interface DnsOptions {
  host: string;
  port?: number;
  addresses: string[];
  names: () => Set<string>;
}

export interface DnsServer {
  port: number;
  close: () => Promise<void>;
}

export async function startDNS({
  host,
  port = 53,
  addresses,
  names,
}: DnsOptions): Promise<DnsServer> {
  function answer(data: Buffer): Buffer | null {
    try {
      const query = packet.decode(data);
      if (query.type !== "query" || query.questions?.length !== 1) return null;
      const question = query.questions[0];
      const name = question.name.toLowerCase().replace(/\.$/, "");
      const allowed = names().has(name);
      const inZone = name.endsWith(".fleet") && name.split(".").length === 2;
      const answers = allowed
        ? addresses
            .filter((ip) => question.type === (net.isIP(ip) === 6 ? "AAAA" : "A"))
            .map((ip) => ({
              name: question.name,
              type: net.isIP(ip) === 6 ? "AAAA" : "A",
              class: "IN",
              ttl: 5,
              data: ip,
            }))
        : [];
      return packet.encode({
        type: "response",
        id: query.id,
        flags:
          packet.AUTHORITATIVE_ANSWER |
          ((query.flags ?? 0) & packet.RECURSION_DESIRED) |
          (!inZone ? 5 : !allowed ? 3 : 0),
        questions: query.questions,
        answers,
      });
    } catch {
      return null;
    }
  }

  const udp = dgram.createSocket(net.isIP(host) === 6 ? "udp6" : "udp4");
  const tcpClients = new Set<net.Socket>();
  const tcp = net.createServer((socket) => {
    tcpClients.add(socket);
    socket.on("error", () => {
      // Ignore client disconnects.
    });
    socket.on("close", () => tcpClients.delete(socket));
    socket.setTimeout(5000, () => socket.destroy());
    let buffer = Buffer.alloc(0);
    socket.on("data", (data) => {
      buffer = Buffer.concat([buffer, typeof data === "string" ? Buffer.from(data) : data]);
      if (buffer.length > 65537) {
        socket.destroy();
        return;
      }
      while (buffer.length >= 2 && buffer.length >= buffer.readUInt16BE(0) + 2) {
        const size = buffer.readUInt16BE(0);
        const response = answer(buffer.subarray(2, size + 2));
        buffer = buffer.subarray(size + 2);
        if (response) {
          const length = Buffer.alloc(2);
          length.writeUInt16BE(response.length);
          socket.write(Buffer.concat([length, response]));
        }
      }
    });
  });

  udp.on("message", (message, remote) => {
    const response = answer(message);
    if (response) udp.send(response, remote.port, remote.address);
  });

  await new Promise<void>((resolve, reject) => {
    udp.once("error", reject);
    udp.bind(port, host, () => resolve());
  });
  try {
    await new Promise<void>((resolve, reject) => {
      tcp.once("error", reject);
      tcp.listen(port || udp.address().port, host, () => resolve());
    });
  } catch (error) {
    udp.close();
    throw error;
  }

  return {
    port: udp.address().port,
    close: async () => {
      for (const socket of tcpClients) socket.destroy();
      await Promise.all([
        new Promise<void>((resolve) => udp.close(() => resolve())),
        new Promise<void>((resolve) => tcp.close(() => resolve())),
      ]);
    },
  };
}
