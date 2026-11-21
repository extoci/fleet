declare module "dns-packet" {
  export interface DnsQuestion {
    type: string;
    name: string;
    class?: string;
  }

  export interface DnsAnswer {
    name: string;
    type: string;
    class?: string;
    ttl?: number;
    data: string | Buffer;
  }

  export interface DnsPacket {
    type?: "query" | "response";
    id?: number;
    flags?: number;
    rcode?: string;
    questions?: DnsQuestion[];
    answers?: DnsAnswer[];
  }

  export const AUTHORITATIVE_ANSWER: number;
  export const RECURSION_DESIRED: number;
  export function decode(buf: Buffer, offset?: number): DnsPacket;
  export function encode(packet: DnsPacket, buf?: Buffer, offset?: number): Buffer;

  const dnsPacket: {
    AUTHORITATIVE_ANSWER: number;
    RECURSION_DESIRED: number;
    decode: typeof decode;
    encode: typeof encode;
  };
  export default dnsPacket;
}
