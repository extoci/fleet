import {
  createHash,
  createPrivateKey,
  type KeyObject,
  randomBytes,
  randomUUID,
  X509Certificate,
} from "node:crypto";
import fs from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import type forge from "node-forge";
import { write } from "./state.ts";

// node-forge adds ~17 MB of JS to the daemon — only pay it when a certificate
// actually has to be generated; reads and checks go through node:crypto.
let forgeCache: typeof forge | undefined;
function forgeModule(): typeof forge {
  return (forgeCache ??= createRequire(import.meta.url)("node-forge") as typeof forge);
}

const serial = (): string => `01${randomBytes(15).toString("hex")}`;

function makeCertificate(publicKey: forge.pki.rsa.PublicKey, cn: string, days: number) {
  const cert = forgeModule().pki.createCertificate();
  cert.publicKey = publicKey;
  cert.serialNumber = serial();
  cert.validity.notBefore = new Date(Date.now() - 300_000);
  cert.validity.notAfter = new Date(Date.now() + days * 86400_000);
  cert.setSubject([{ name: "commonName", value: cn }]);
  return cert;
}

export interface Authority {
  pem: string;
  certFile: string;
}

function modulus(key: KeyObject): string | undefined {
  return (key.export({ format: "jwk" }) as JsonWebKey).n;
}

export function authority(home: string): Authority {
  const dir = path.join(home, "pki");
  const certFile = path.join(dir, "root.pem");
  const keyFile = path.join(dir, "root.key");
  if (fs.existsSync(certFile) !== fs.existsSync(keyFile)) {
    throw new Error(
      "Incomplete Fleet certificate state. Restore the root certificate and key together.",
    );
  }
  if (!fs.existsSync(certFile)) {
    const keys = forgeModule().pki.rsa.generateKeyPair(2048);
    const cert = makeCertificate(keys.publicKey, "Fleet private apps", 3650);
    cert.setIssuer(cert.subject.attributes);
    cert.setExtensions([
      {
        name: "basicConstraints",
        cA: true,
        critical: true,
        pathLenConstraint: 0,
      },
      { name: "keyUsage", keyCertSign: true, cRLSign: true, critical: true },
      { name: "subjectKeyIdentifier" },
    ]);
    cert.sign(keys.privateKey, forgeModule().md.sha256.create());
    write(keyFile, forgeModule().pki.privateKeyToPem(keys.privateKey));
    write(certFile, forgeModule().pki.certificateToPem(cert));
  }
  const pem = fs.readFileSync(certFile, "utf8");
  const cert = new X509Certificate(pem);
  const key = createPrivateKey(fs.readFileSync(keyFile, "utf8"));
  if (modulus(cert.publicKey) !== modulus(key)) {
    throw new Error("Fleet root key does not match its certificate.");
  }
  return { pem, certFile };
}

export function leaf(home: string, name: string): { cert: string; key: string } {
  if (!/^[a-z0-9-]+\.fleet$/.test(name)) {
    throw new Error("Fleet issues certificates only for exact app names.");
  }
  const ca = authority(home);
  const dir = path.join(home, "pki", name);
  const certFile = path.join(dir, "cert.pem");
  const keyFile = path.join(dir, "key.pem");
  if (fs.existsSync(certFile) && fs.existsSync(keyFile)) {
    const certPem = fs.readFileSync(certFile, "utf8");
    const cert = new X509Certificate(certPem);
    const root = new X509Certificate(ca.pem);
    if (
      cert.issuer === root.subject &&
      Date.parse(cert.validTo) > Date.now() + 86400_000 &&
      cert.verify(root.publicKey)
    ) {
      return { cert: certPem, key: fs.readFileSync(keyFile, "utf8") };
    }
  }
  const keys = forgeModule().pki.rsa.generateKeyPair(2048);
  const cert = makeCertificate(keys.publicKey, name, 30);
  const caCert = forgeModule().pki.certificateFromPem(ca.pem);
  cert.setIssuer(caCert.subject.attributes);
  cert.setExtensions([
    { name: "basicConstraints", cA: false, critical: true },
    {
      name: "keyUsage",
      digitalSignature: true,
      keyEncipherment: true,
      critical: true,
    },
    { name: "extKeyUsage", serverAuth: true },
    { name: "subjectAltName", altNames: [{ type: 2, value: name }] },
    { name: "subjectKeyIdentifier" },
  ]);
  const caKey = forgeModule().pki.privateKeyFromPem(
    fs.readFileSync(path.join(home, "pki", "root.key"), "utf8"),
  ) as forge.pki.rsa.PrivateKey;
  cert.sign(caKey, forgeModule().md.sha256.create());
  const certPem = forgeModule().pki.certificateToPem(cert);
  const keyPem = forgeModule().pki.privateKeyToPem(keys.privateKey);
  write(keyFile, keyPem);
  write(certFile, certPem);
  return { cert: certPem, key: keyPem };
}

const escapeXml = (value: string): string =>
  String(value).replace(
    /[<>&"']/g,
    (c) =>
      ({
        "<": "&lt;",
        ">": "&gt;",
        "&": "&amp;",
        '"': "&quot;",
        "'": "&apos;",
      })[c] ?? c,
  );

export function mobileProfile(home: string): string {
  const der = new X509Certificate(authority(home).pem).raw;
  const id = createHash("sha256").update(der).digest("hex").slice(0, 24);
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>PayloadType</key><string>Configuration</string><key>PayloadVersion</key><integer>1</integer>
<key>PayloadIdentifier</key><string>dev.fleet.${id}</string><key>PayloadUUID</key><string>${randomUUID()}</string>
<key>PayloadDisplayName</key><string>Fleet private apps</string>
<key>PayloadDescription</key><string>${escapeXml("Trust HTTPS certificates from your own Fleet computer. Remove this profile to remove that trust.")}</string>
<key>PayloadContent</key><array><dict>
<key>PayloadType</key><string>com.apple.security.root</string><key>PayloadVersion</key><integer>1</integer>
<key>PayloadIdentifier</key><string>dev.fleet.${id}.root</string><key>PayloadUUID</key><string>${randomUUID()}</string>
<key>PayloadDisplayName</key><string>Fleet private apps</string><key>PayloadCertificateFileName</key><string>fleet-root.cer</string>
<key>PayloadContent</key><data>${der.toString("base64")}</data>
</dict></array></dict></plist>`;
}
