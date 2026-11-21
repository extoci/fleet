import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";
import { chromium } from "playwright-core";
import { start } from "../src/server.mjs";
import { authority } from "../src/certificates.mjs";
import { write, secret } from "../src/state.mjs";

test(
  "a mobile-size browser signs in, saves data, and receives live edits over trusted HTTPS",
  {
    skip: !process.env.FLEET_BROWSER_EXECUTABLE || !process.env.FLEET_CERTUTIL,
  },
  async (t) => {
    const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "fleet-browser-"));
    const home = path.join(temporary, "fleet");
    const browserHome = path.join(temporary, "browser-home");
    const project = path.join(temporary, "notes");
    const cli = fileURLToPath(new URL("../src/cli.mjs", import.meta.url));
    execFileSync(process.execPath, [cli, "init", project], {
      env: { ...process.env, FLEET_V2_HOME: home },
      stdio: "pipe",
    });
    const client = path.join(project, "client", "index.tsx");
    const localPreact = path.join(project, "node_modules", "preact");
    fs.cpSync(new URL("../node_modules/preact/", import.meta.url), localPreact, {
      recursive: true,
    });
    write(
      client,
      fs.readFileSync(client, "utf8").replace(
        "import { useState } from 'preact/hooks';",
        `import { useState } from 'react';
import { useState as preactUseState } from 'preact/hooks';
import { render as reactRender } from 'react-dom';
import { render as compatRender } from 'preact/compat';
if (useState !== preactUseState || reactRender !== compatRender)
  throw new Error('Multiple Preact copies');`,
      ),
    );
    write(path.join(home, "config.json"), {
      version: 2,
      addresses: ["127.0.0.1"],
      adminToken: secret(),
      httpsPort: 0,
      dnsPort: 0,
      adminPort: 0,
    });
    const daemon = await start(home, {
      hosts: ["127.0.0.1"],
      httpsPort: 0,
      adminPort: 0,
      noDns: true,
      pollMs: 150,
    });
    let browser;
    t.after(async () => {
      await browser?.close();
      await daemon.close();
      fs.rmSync(temporary, {
        recursive: true,
        force: true,
        maxRetries: 10,
        retryDelay: 100,
      });
    });
    // Import the private root into an isolated Linux NSS database. Do not use
    // ignoreHTTPSErrors, insecure-origin overrides, or a system trust mutation.
    const nss = path.join(browserHome, ".pki", "nssdb");
    fs.mkdirSync(nss, { recursive: true });
    execFileSync(process.env.FLEET_CERTUTIL, [
      "-N",
      "-d",
      `sql:${nss}`,
      "--empty-password",
    ]);
    execFileSync(process.env.FLEET_CERTUTIL, [
      "-A",
      "-d",
      `sql:${nss}`,
      "-n",
      "Fleet test root",
      "-t",
      "C,,",
      "-i",
      authority(home).certFile,
    ]);
    browser = await chromium.launchPersistentContext(
      path.join(temporary, "profile"),
      {
        executablePath: process.env.FLEET_BROWSER_EXECUTABLE,
        headless: true,
        env: { ...process.env, HOME: browserHome },
        viewport: { width: 390, height: 844 },
        isMobile: true,
        args: [
          "--host-resolver-rules=MAP *.fleet 127.0.0.1",
          "--no-proxy-server",
        ],
      },
    );
    const page = await browser.newPage();
    const errors = [];
    page.on("pageerror", (error) => errors.push(error.message));
    await page.goto(`https://notes.fleet:${daemon.httpsPort}/`);
    await page.getByLabel("Device code").fill(daemon.gate.pair());
    await page.getByRole("button", { name: "Connect device" }).click();
    try {
      await page.getByLabel("New note").waitFor({ timeout: 10000 });
    } catch (error) {
      throw new Error(
        `${error.message}\nURL: ${page.url()}\nBrowser errors: ${errors.join("; ")}\nPage: ${await page.locator("body").innerText()}`,
      );
    }
    await page.getByLabel("New note").fill("My phone can use this app.");
    await page.getByRole("button", { name: "Save note" }).click();
    await page
      .getByText("My phone can use this app.", { exact: true })
      .waitFor();
    assert.equal(
      await page.evaluate(
        () => window.isSecureContext && Boolean(crypto.subtle),
      ),
      true,
    );
    assert.equal(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
      true,
    );
    assert.ok(
      (await browser.cookies()).some(
        (cookie) =>
          cookie.name === "__Host-fleet" && cookie.secure && cookie.httpOnly,
      ),
    );
    write(
      client,
      fs.readFileSync(client, "utf8").replace("A place for", "A home for"),
    );
    await page
      .getByRole("heading", { name: "A home for your thoughts." })
      .waitFor({ timeout: 15000 });
    await page
      .getByText("My phone can use this app.", { exact: true })
      .waitFor();
    assert.deepEqual(errors, []);

    await page.addInitScript(() => {
      window.requests = [];
      window.fetch = async (route, options) => {
        window.requests.push({ route, keepalive: options?.keepalive });
        if (window.delayPoll && route.endsWith("/defaultPoll")) {
          window.delayPoll = false;
          return new Promise((resolve) => {
            window.finishPoll = () => resolve(Response.json({ value: "stale" }));
          });
        }
        return Response.json({ value: "ready" });
      };
    });
    await page.clock.install();
    write(client, `
      import { render } from "preact";
      import { call, useMutation, useQuery } from "fleet/client";
      function App() {
        const { data } = useQuery("defaultPoll");
        useQuery("noPoll", null, { pollMs: false });
        useQuery("zeroPoll", null, { pollMs: 0 });
        const selective = useMutation("selective", { invalidate: ["noPoll"] });
        const quiet = useMutation("quiet", { invalidate: false });
        const all = useMutation("all");
        return <main>
          <output>{data}</output>
          <button onClick={() => selective()}>Selective</button>
          <button onClick={() => quiet()}>Quiet</button>
          <button onClick={() => all()}>All</button>
          <button onClick={() => call("mutations", "leaving", null, { keepalive: true })}>Leaving</button>
        </main>;
      }
      render(<App />, document.getElementById("app"));
    `);
    await page.getByText("ready", { exact: true }).waitFor();
    const requestNames = () =>
      page.evaluate(() =>
        window.requests.map(({ route }) => route.split("/").at(-1)),
      );
    assert.deepEqual(await requestNames(), ["defaultPoll", "noPoll", "zeroPoll"]);
    await page.evaluate(() => { window.delayPoll = true; });
    await page.clock.fastForward(10_000);
    assert.deepEqual(await requestNames(), [
      "defaultPoll", "noPoll", "zeroPoll", "defaultPoll",
    ]);

    await page.getByRole("button", { name: "Selective" }).click();
    await page.getByRole("button", { name: "Quiet" }).click();
    await page.getByRole("button", { name: "All" }).click();
    await page.getByRole("button", { name: "Leaving" }).click();
    assert.deepEqual((await requestNames()).slice(4), [
      "selective", "noPoll", "quiet", "all", "defaultPoll", "noPoll", "zeroPoll", "leaving",
    ]);
    assert.deepEqual(await page.evaluate(() => window.requests.at(-1)), {
      route: "/__fleet/api/mutations/leaving",
      keepalive: true,
    });
    await page.evaluate(async () => {
      window.finishPoll();
      await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    });
    assert.equal(await page.locator("output").innerText(), "ready");
    assert.deepEqual(errors, []);
  },
);
