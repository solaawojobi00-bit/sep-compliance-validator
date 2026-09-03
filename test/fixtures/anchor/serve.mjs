#!/usr/bin/env node
/**
 * Hermetic stand-in for a SEP-1 conformant anchor, used by the CI Action smoke test.
 *
 * The point of the smoke test is to prove the composite Action's own plumbing works —
 * that it runs the CLI, writes a report, sets its outputs, and propagates the exit
 * status. Pointing it at a live anchor makes that gate depend on a third party's
 * uptime, so it serves the one file SEP-1 checks read, over TLS, from localhost.
 *
 * TLS is not optional: src/checks/sep1.ts builds `https://${domain}/.well-known/stellar.toml`
 * unconditionally. A throwaway self-signed cert is generated on first run (never
 * committed — a checked-in private key in this repo would be both a bad example and a
 * secret-scanner hit). Point the client at it with:
 *
 *   NODE_EXTRA_CA_CERTS=<the CA path this script prints>
 *
 * Env: PORT (default 8443), FIXTURE_CERT_DIR (default <tmpdir>/sep-fixture-anchor).
 */
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { createServer } from "node:https";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const port = Number(process.env.PORT ?? 8443);
const certDir = process.env.FIXTURE_CERT_DIR ?? join(tmpdir(), "sep-fixture-anchor");
const certPath = join(certDir, "cert.pem");
const keyPath = join(certDir, "key.pem");

if (!existsSync(certPath) || !existsSync(keyPath)) {
  mkdirSync(certDir, { recursive: true });
  // CA:TRUE by default for -x509, so the same file works as the trust anchor via
  // NODE_EXTRA_CA_CERTS. SAN covers both the hostname and the literal address.
  execFileSync(
    "openssl",
    [
      "req", "-x509", "-newkey", "rsa:2048", "-nodes",
      "-keyout", keyPath,
      "-out", certPath,
      "-days", "2",
      "-subj", "/CN=localhost",
      "-addext", "subjectAltName=DNS:localhost,IP:127.0.0.1",
    ],
    { stdio: "inherit" },
  );
}

const toml = readFileSync(join(here, "stellar.toml"));

const server = createServer(
  { cert: readFileSync(certPath), key: readFileSync(keyPath) },
  (req, res) => {
    if (req.url === "/.well-known/stellar.toml") {
      res.writeHead(200, {
        "content-type": "text/plain",
        // SEP-1 requires the literal "*", not a reflected Origin. Vary: Origin because
        // the CORS probe in sep1.ts sends an Origin header on a separate request.
        "access-control-allow-origin": "*",
        vary: "Origin",
      });
      res.end(toml);
      return;
    }
    res.writeHead(404, { "content-type": "text/plain" });
    res.end("not found\n");
  },
);

server.listen(port, () => {
  console.log(`fixture anchor listening on https://localhost:${port}`);
  console.log(`NODE_EXTRA_CA_CERTS=${certPath}`);
});
