import forge from "node-forge";
import fs from "node:fs";
import path from "node:path";
import { randomBytes, randomUUID, createHash } from "node:crypto";
import { write } from "./state.mjs";

const pki = forge.pki;
const serial = () => `01${randomBytes(15).toString("hex")}`;
function makeCertificate(publicKey, cn, days) {
  const cert = pki.createCertificate();
  cert.publicKey = publicKey;
  cert.serialNumber = serial();
  cert.validity.notBefore = new Date(Date.now() - 300_000);
  cert.validity.notAfter = new Date(Date.now() + days * 86400_000);
  cert.setSubject([{ name: "commonName", value: cn }]);
  return cert;
}
export function authority(home) {
  const dir = path.join(home, "pki");
  const certFile = path.join(dir, "root.pem");
  const keyFile = path.join(dir, "root.key");
  if (fs.existsSync(certFile) !== fs.existsSync(keyFile))
    throw new Error(
      "Incomplete Fleet certificate state. Restore the root certificate and key together.",
    );
  if (!fs.existsSync(certFile)) {
    const keys = pki.rsa.generateKeyPair(2048);
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
    cert.sign(keys.privateKey, forge.md.sha256.create());
    write(keyFile, pki.privateKeyToPem(keys.privateKey));
    write(certFile, pki.certificateToPem(cert));
  }
  const cert = pki.certificateFromPem(fs.readFileSync(certFile, "utf8"));
  const key = pki.privateKeyFromPem(fs.readFileSync(keyFile, "utf8"));
  if (cert.publicKey.n.compareTo(key.n) !== 0)
    throw new Error("Fleet root key does not match its certificate.");
  return { cert, key, pem: fs.readFileSync(certFile, "utf8"), certFile };
}
export function leaf(home, name) {
  if (!/^[a-z0-9-]+\.fleet$/.test(name))
    throw new Error("Fleet issues certificates only for exact app names.");
  const ca = authority(home);
  const dir = path.join(home, "pki", name);
  const certFile = path.join(dir, "cert.pem");
  const keyFile = path.join(dir, "key.pem");
  if (fs.existsSync(certFile) && fs.existsSync(keyFile)) {
    const cert = pki.certificateFromPem(fs.readFileSync(certFile, "utf8"));
    if (
      cert.validity.notAfter.getTime() > Date.now() + 86400_000 &&
      ca.cert.verify(cert)
    ) {
      return {
        cert: fs.readFileSync(certFile, "utf8"),
        key: fs.readFileSync(keyFile, "utf8"),
      };
    }
  }
  const keys = pki.rsa.generateKeyPair(2048);
  const cert = makeCertificate(keys.publicKey, name, 30);
  cert.setIssuer(ca.cert.subject.attributes);
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
  cert.sign(ca.key, forge.md.sha256.create());
  write(keyFile, pki.privateKeyToPem(keys.privateKey));
  write(certFile, pki.certificateToPem(cert));
  return {
    cert: pki.certificateToPem(cert),
    key: pki.privateKeyToPem(keys.privateKey),
  };
}
const escape = (value) =>
  String(value).replace(
    /[<>&"']/g,
    (c) =>
      ({
        "<": "&lt;",
        ">": "&gt;",
        "&": "&amp;",
        '"': "&quot;",
        "'": "&apos;",
      })[c],
  );
export function mobileProfile(home) {
  const ca = authority(home);
  const der = Buffer.from(
    forge.asn1.toDer(pki.certificateToAsn1(ca.cert)).getBytes(),
    "binary",
  );
  const id = createHash("sha256").update(der).digest("hex").slice(0, 24);
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>PayloadType</key><string>Configuration</string><key>PayloadVersion</key><integer>1</integer>
<key>PayloadIdentifier</key><string>dev.fleet.${id}</string><key>PayloadUUID</key><string>${randomUUID()}</string>
<key>PayloadDisplayName</key><string>Fleet private apps</string>
<key>PayloadDescription</key><string>${escape("Trust HTTPS certificates from your own Fleet computer. Remove this profile to remove that trust.")}</string>
<key>PayloadContent</key><array><dict>
<key>PayloadType</key><string>com.apple.security.root</string><key>PayloadVersion</key><integer>1</integer>
<key>PayloadIdentifier</key><string>dev.fleet.${id}.root</string><key>PayloadUUID</key><string>${randomUUID()}</string>
<key>PayloadDisplayName</key><string>Fleet private apps</string><key>PayloadCertificateFileName</key><string>fleet-root.cer</string>
<key>PayloadContent</key><data>${der.toString("base64")}</data>
</dict></array></dict></plist>`;
}
