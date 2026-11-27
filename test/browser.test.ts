import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, test } from "bun:test";
import { type BrowserContext, chromium } from "playwright-core";
import { authority } from "../src/certificates.ts";
import { start } from "../src/server.ts";
import { secret, write } from "../src/state.ts";

const cleanups: Array<() => void | Promise<void>> = [];
afterEach(async () => {
  for (const fn of cleanups.splice(0).reverse()) await fn();
});

const browserTest =
  process.env.FLEET_BROWSER_EXECUTABLE && process.env.FLEET_CERTUTIL ? test : test.skip;

browserTest(
  "a mobile-size browser signs in, saves data, and receives live edits over trusted HTTPS",
  async () => {
    const browserExecutable = process.env.FLEET_BROWSER_EXECUTABLE!;
    const certutil = process.env.FLEET_CERTUTIL!;
    const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "fleet-browser-"));
    const home = path.join(temporary, "fleet");
    const browserHome = path.join(temporary, "browser-home");
    const project = path.join(temporary, "notes");
    const cli = fileURLToPath(new URL("../src/cli.ts", import.meta.url));
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
    const browserRef: { current?: BrowserContext } = {};
    cleanups.push(async () => {
      await browserRef.current?.close();
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
    execFileSync(certutil, ["-N", "-d", `sql:${nss}`, "--empty-password"]);
    execFileSync(certutil, [
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
    const browser = await chromium.launchPersistentContext(path.join(temporary, "profile"), {
      executablePath: browserExecutable,
      headless: true,
      env: { ...process.env, HOME: browserHome },
      viewport: { width: 390, height: 844 },
      isMobile: true,
      args: ["--host-resolver-rules=MAP *.fleet 127.0.0.1", "--no-proxy-server"],
    });
    browserRef.current = browser;
    const page = await browser.newPage();
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    await page.goto(`https://notes.fleet:${daemon.httpsPort}/`);
    await page.getByLabel("Device code").fill(daemon.gate.pair());
    await page.getByRole("button", { name: "Connect device" }).click();
    try {
      await page.getByLabel("New note").waitFor({ timeout: 10000 });
    } catch (error) {
      throw new Error(
        `${error instanceof Error ? error.message : String(error)}\nURL: ${page.url()}\nBrowser errors: ${errors.join("; ")}\nPage: ${await page.locator("body").innerText()}`,
        { cause: error },
      );
    }
    await page.waitForFunction(() => {
      const logo = document.querySelector<HTMLImageElement>('img[alt="Fleet"]');
      const loadedFonts = [...document.fonts]
        .filter((font) => font.status === "loaded")
        .map((font) => font.family.replaceAll('"', ""));
      return (
        logo &&
        logo.naturalWidth > 0 &&
        ["Geist", "Geist Pixel Square"].every((font) => loadedFonts.includes(font))
      );
    });
    await page.getByLabel("New note").fill("My phone can use this app.");
    await page.getByRole("button", { name: "Save note" }).click();
    await page.getByText("My phone can use this app.", { exact: true }).waitFor();
    assert.equal(await page.evaluate(() => window.isSecureContext && Boolean(crypto.subtle)), true);
    assert.equal(
      await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth),
      true,
    );
    assert.ok(
      (await browser.cookies()).some(
        (cookie) => cookie.name === "__Host-fleet" && cookie.secure && cookie.httpOnly,
      ),
    );
    write(client, fs.readFileSync(client, "utf8").replace("<h1>Notes</h1>", "<h1>My notes</h1>"));
    await page.getByRole("heading", { name: "My notes" }).waitFor({ timeout: 15000 });
    await page.getByText("My phone can use this app.", { exact: true }).waitFor();
    assert.deepEqual(errors, []);

    await page.goto(`https://gate.fleet:${daemon.httpsPort}/`);
    await page.getByRole("heading", { name: "Welcome back." }).waitFor();
    const gateName = page.locator(".app-name").first();
    await gateName.waitFor();
    assert.equal(await gateName.textContent(), "notes");
    assert.equal(
      await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth),
      true,
    );
    assert.equal(
      await page.evaluate(() => document.documentElement.hasAttribute("data-blur-pii")),
      false,
    );
    const toggle = page.locator("[data-blur-toggle]");
    const blurToggle = page.getByRole("button", { name: "Blur app names" });
    await blurToggle.waitFor();
    assert.equal(await toggle.getAttribute("aria-pressed"), "false");
    assert.equal(await gateName.evaluate((el) => getComputedStyle(el).filter), "none");
    await blurToggle.click();
    await page.waitForFunction(() => document.documentElement.dataset.blurPii === "1");
    const showToggle = page.getByRole("button", { name: "Show app names" });
    await showToggle.waitFor();
    assert.equal(await toggle.getAttribute("aria-pressed"), "true");
    await page.waitForFunction(() => {
      const name = document.querySelector(".app-name");
      if (!name) return false;
      const styles = getComputedStyle(name);
      return styles.filter.includes("blur(4px)") && styles.userSelect === "none";
    });
    await page.waitForFunction(() => document.querySelector(".app-name")?.textContent !== "notes");
    const redacted = await gateName.textContent();
    assert.ok(redacted);
    assert.notEqual(redacted, "notes");
    assert.equal(redacted.length, "notes".length);
    await page.reload();
    await page.getByRole("heading", { name: "Welcome back." }).waitFor();
    assert.equal(await page.evaluate(() => document.documentElement.dataset.blurPii), "1");
    const persistedToggle = page.getByRole("button", { name: "Show app names" });
    await persistedToggle.waitFor();
    assert.equal(await toggle.getAttribute("aria-pressed"), "true");
    await page.waitForFunction(() => {
      const name = document.querySelector(".app-name");
      return name !== null && getComputedStyle(name).filter.includes("blur(4px)");
    });
    await page.waitForFunction(
      (expected) => document.querySelector(".app-name")?.textContent === expected,
      redacted,
    );
    assert.equal(await gateName.textContent(), redacted);
    await persistedToggle.click();
    await page.waitForFunction(() => !document.documentElement.dataset.blurPii);
    const restoredToggle = page.getByRole("button", { name: "Blur app names" });
    await restoredToggle.waitFor();
    assert.equal(await toggle.getAttribute("aria-pressed"), "false");
    await page.waitForFunction(() => document.querySelector(".app-name")?.textContent === "notes");
    assert.equal(await gateName.textContent(), "notes");
    await page.evaluate(() => {
      const btn = document.querySelector<HTMLButtonElement>("[data-blur-toggle]");
      btn?.click();
      btn?.click();
    });
    await page.waitForTimeout(250);
    assert.equal(
      await page.evaluate(() => document.documentElement.hasAttribute("data-blur-pii")),
      false,
    );
    assert.equal(await gateName.textContent(), "notes");
    await page.goto(`https://notes.fleet:${daemon.httpsPort}/`);
    await page.getByText("My phone can use this app.", { exact: true }).waitFor();
    assert.deepEqual(errors, []);

    const reports = ["Browser exception", "Browser rejection"].map((message) =>
      page.waitForResponse(
        (response) =>
          response.url().endsWith("/__fleet/client-error") &&
          Boolean(
            (response.request().postDataJSON() as { message?: string } | null)?.message?.includes(
              message,
            ),
          ),
      ),
    );
    await page.evaluate(() => {
      setTimeout(() => {
        throw new Error("Browser exception");
      }, 0);
      Promise.reject(new Error("Browser rejection"));
    });
    for (const response of await Promise.all(reports)) {
      assert.equal(response.status(), 204);
    }
    const app = daemon.runtime.find("notes");
    assert.ok(app);
    const log = fs.readFileSync(path.join(home, "logs", `${app.id}.log`), "utf8");
    assert.match(log, /Client error: .*Browser exception/);
    assert.match(log, /Client error: Browser rejection/);
    errors.length = 0;

    await page.addInitScript(() => {
      const win = window as unknown as {
        requests: Array<{ route: string; keepalive?: boolean }>;
        delayPoll?: boolean;
        finishPoll?: () => void;
      };
      win.requests = [];
      (window as unknown as { fetch: unknown }).fetch = async (
        route: string | URL | Request,
        options?: RequestInit,
      ) => {
        const url = String(route);
        win.requests.push({ route: url, keepalive: options?.keepalive });
        if (win.delayPoll && url.endsWith("/timedPoll")) {
          win.delayPoll = false;
          return new Promise((resolve) => {
            win.finishPoll = () => resolve(Response.json({ value: "stale" }));
          });
        }
        return Response.json({ value: "ready" });
      };
    });
    await page.clock.install();
    write(
      client,
      `
      import { render } from "preact";
      import { call, useMutation, useQuery } from "fleet/client";
      function App() {
        const { data } = useQuery("timedPoll", null, { pollMs: 10_000 });
        useQuery("defaultPoll");
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
    `,
    );
    await page.getByText("ready", { exact: true }).waitFor();
    const requestNames = () =>
      page.evaluate(() =>
        (window as unknown as { requests: Array<{ route: string }> }).requests.map(({ route }) =>
          route.split("/").at(-1),
        ),
      );
    assert.deepEqual(await requestNames(), ["timedPoll", "defaultPoll", "noPoll", "zeroPoll"]);
    await page.evaluate(() => {
      (window as unknown as { delayPoll: boolean }).delayPoll = true;
    });
    await page.clock.fastForward(10_000);
    assert.deepEqual(await requestNames(), [
      "timedPoll",
      "defaultPoll",
      "noPoll",
      "zeroPoll",
      "timedPoll",
    ]);

    await page.getByRole("button", { name: "Selective" }).click();
    await page.getByRole("button", { name: "Quiet" }).click();
    await page.getByRole("button", { name: "All" }).click();
    await page.getByRole("button", { name: "Leaving" }).click();
    assert.deepEqual((await requestNames()).slice(5), [
      "selective",
      "noPoll",
      "quiet",
      "all",
      "timedPoll",
      "defaultPoll",
      "noPoll",
      "zeroPoll",
      "leaving",
    ]);
    assert.deepEqual(
      await page.evaluate(() =>
        (
          window as unknown as { requests: Array<{ route: string; keepalive?: boolean }> }
        ).requests.at(-1),
      ),
      {
        route: "/__fleet/api/mutations/leaving",
        keepalive: true,
      },
    );
    const activeQueries = ["timedPoll", "defaultPoll", "noPoll", "zeroPoll"];
    const expectRefresh = async (dispatch: string) => {
      await page.evaluate((source) => {
        const win = window as unknown as {
          requests: Array<{ route: string }>;
          __fleet: { events: EventSource };
        };
        win.requests.length = 0;
        if (source === "data") {
          win.__fleet.events.dispatchEvent(
            new MessageEvent("message", {
              data: JSON.stringify({ type: "data", dataVersion: 1 }),
            }),
          );
        } else if (source === "visibility") {
          document.dispatchEvent(new Event("visibilitychange"));
        } else {
          win.__fleet.events.dispatchEvent(new Event("open"));
        }
      }, dispatch);
      assert.deepEqual(await requestNames(), activeQueries);
    };
    await expectRefresh("data");
    await expectRefresh("visibility");
    await expectRefresh("reconnect");
    await page.evaluate(async () => {
      (window as unknown as { finishPoll?: () => void }).finishPoll?.();
      await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    });
    assert.equal(await page.locator("output").innerText(), "ready");
    const crashReports = await page.evaluate(() => {
      const win = window as unknown as {
        requests: Array<{ route: string; keepalive?: boolean }>;
      };
      win.requests.length = 0;
      for (let i = 0; i < 7; i++) {
        window.dispatchEvent(new ErrorEvent("error", { message: "Repeated crash" }));
      }
      return win.requests.filter(({ route }) => route === "/__fleet/client-error");
    });
    assert.equal(crashReports.length, 5);
    assert.ok(crashReports.every(({ keepalive }) => keepalive));
    assert.deepEqual(errors, []);
  },
  30_000,
);
