#!/usr/bin/env python3
"""Check private HTTPS and an Apple certificate payload without system changes.

Requires Python 3 and OpenSSL. Uses a temporary directory and an ephemeral
loopback listener. Does not change DNS, Tailscale, or certificate trust.
This is a research fixture, not a Fleet app server or an iPhone test.
"""

import http.server
import pathlib
import plistlib
import socket
import ssl
import subprocess
import tempfile
import threading
import uuid


def openssl(directory, *args):
    return subprocess.run(
        ["openssl", *args], cwd=directory, check=True,
        capture_output=True, timeout=15,
    ).stdout


def make_profile(root_der):
    profile_id = "dev.fleet.research." + str(uuid.uuid4())
    return {
        "PayloadType": "Configuration",
        "PayloadVersion": 1,
        "PayloadIdentifier": profile_id,
        "PayloadUUID": str(uuid.uuid4()).upper(),
        "PayloadDisplayName": "Fleet research certificate",
        "PayloadDescription": "Temporary research fixture. Do not install.",
        "PayloadContent": [{
            "PayloadType": "com.apple.security.root",
            "PayloadVersion": 1,
            "PayloadIdentifier": profile_id + ".root",
            "PayloadUUID": str(uuid.uuid4()).upper(),
            "PayloadDisplayName": "Fleet research root",
            "PayloadCertificateFileName": "fleet-root.cer",
            "PayloadContent": root_der,
        }],
    }


class Handler(http.server.BaseHTTPRequestHandler):
    def do_GET(self):
        if self.headers.get("Host") != "notes.fleet":
            self.send_error(421)
            return
        body = b"notes.fleet private HTTPS proof\n"
        self.send_response(200)
        self.send_header("Content-Type", "text/plain")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def log_message(self, *_args):
        pass


def request(context, port, hostname):
    with socket.create_connection(("127.0.0.1", port), timeout=3) as raw:
        with context.wrap_socket(raw, server_hostname=hostname) as stream:
            stream.sendall(
                b"GET / HTTP/1.1\r\nHost: notes.fleet\r\nConnection: close\r\n\r\n"
            )
            chunks = []
            while chunk := stream.recv(4096):
                chunks.append(chunk)
            return b"".join(chunks)


def expect_rejected(context, port, hostname):
    try:
        request(context, port, hostname)
    except ssl.SSLCertVerificationError:
        return
    raise RuntimeError("TLS accepted an untrusted certificate or wrong hostname")


def main():
    with tempfile.TemporaryDirectory(prefix="fleet-mobile-proof-") as temporary:
        directory = pathlib.Path(temporary)
        openssl(directory, "req", "-x509", "-newkey", "rsa:2048", "-nodes",
                "-keyout", "root.key", "-out", "root.pem", "-days", "2",
                "-sha256", "-subj", "/CN=Fleet temporary research root",
                "-addext", "basicConstraints=critical,CA:TRUE,pathlen:0",
                "-addext", "keyUsage=critical,keyCertSign,cRLSign")
        openssl(directory, "req", "-new", "-newkey", "rsa:2048", "-nodes",
                "-keyout", "notes.key", "-out", "notes.csr",
                "-subj", "/CN=notes.fleet")
        (directory / "leaf.ext").write_text(
            "subjectAltName=DNS:notes.fleet\n"
            "basicConstraints=critical,CA:FALSE\n"
            "keyUsage=critical,digitalSignature,keyEncipherment\n"
            "extendedKeyUsage=serverAuth\n"
        )
        openssl(directory, "x509", "-req", "-in", "notes.csr",
                "-CA", "root.pem", "-CAkey", "root.key", "-CAcreateserial",
                "-out", "notes.pem", "-days", "1", "-sha256",
                "-extfile", "leaf.ext")
        root_der = openssl(directory, "x509", "-in", "root.pem", "-outform", "DER")
        encoded = plistlib.dumps(make_profile(root_der))
        (directory / "fleet.mobileconfig").write_bytes(encoded)
        decoded = plistlib.loads(encoded)
        payloads = decoded["PayloadContent"]
        if len(payloads) != 1 or payloads[0]["PayloadContent"] != root_der:
            raise RuntimeError("Certificate payload changed during profile encoding")
        if payloads[0]["PayloadType"] != "com.apple.security.root":
            raise RuntimeError("Unexpected Apple payload type")
        # The payload has one public DER certificate. No identity/key payload.
        print("PASS: Apple root profile round-trips the public certificate only")

        server_context = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
        server_context.load_cert_chain(directory / "notes.pem", directory / "notes.key")
        server = http.server.HTTPServer(("127.0.0.1", 0), Handler)
        server.socket = server_context.wrap_socket(server.socket, server_side=True)
        worker = threading.Thread(target=server.serve_forever, daemon=True)
        worker.start()
        try:
            port = server.server_address[1]
            expect_rejected(ssl.create_default_context(), port, "notes.fleet")
            print("PASS: Default trust rejects the private certificate")
            trusted = ssl.create_default_context(cafile=str(directory / "root.pem"))
            expect_rejected(trusted, port, "other.fleet")
            print("PASS: Trusted root still rejects a different app hostname")
            response = request(trusted, port, "notes.fleet")
            if b"200 OK" not in response or not response.endswith(
                b"notes.fleet private HTTPS proof\n"
            ):
                raise RuntimeError("HTTPS response did not match the test app")
            print("PASS: HTTPS request verifies notes.fleet with the private root")
        finally:
            server.shutdown()
            server.server_close()
            worker.join(timeout=3)
            if worker.is_alive():
                raise RuntimeError("Research server did not stop")
    print("Removed temporary keys, profile, and listener. System settings unchanged.")
    print("Not tested: DNS, tailnet policy, Safari, iOS profile installation, or Gate.")


if __name__ == "__main__":
    main()
