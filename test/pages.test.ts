import assert from "node:assert/strict";
import { test } from "bun:test";
import {
  FONT_ROUTE,
  homePage,
  loginPage,
  offlinePage,
  phoneConnectedPage,
  phoneSetupPage,
  unavailablePage,
  wakePage,
} from "../src/pages.ts";

test("loginPage keeps accessible controls, escapes inputs, and loads Geist Pixel Square", () => {
  const html = loginPage("notes", "Invalid <script>alert(1)</script> code");
  assert.match(html, new RegExp(FONT_ROUTE.replace(/\//g, "\\/")));
  assert.match(html, /<code class="app-code">notes<\/code> needs you to log in first\./);
  assert.match(html, /aria-label="Device code"/);
  assert.match(html, /name="code"/);
  assert.match(html, /Connect device/);
  assert.match(html, /role="alert"/);
  assert.doesNotMatch(html, /<label/);
  assert.doesNotMatch(html, /30 days/);
  assert.doesNotMatch(html, /<script>alert\(1\)<\/script>/);
});

test("homePage renders welcome heading, app states, and empty state cleanly", () => {
  const empty = homePage([]);
  assert.match(empty, /<h1>Welcome back\.<\/h1>/);
  assert.match(empty, /fleet init/);
  assert.match(empty, /\/__fleet\/logout/);

  const populated = homePage([
    { name: "notes", url: "https://notes.fleet", running: true },
    { name: "docs", url: "https://docs.fleet", running: false, building: true },
    { name: "media", url: "https://media.fleet", running: false, peer: "studio", online: false },
    { name: "broken", url: "https://broken.fleet", running: false, error: "build failed" },
  ]);
  assert.match(populated, /●<\/span>Running/);
  assert.match(populated, /◐<\/span>Building/);
  assert.match(populated, /◇<\/span>Offline/);
  assert.match(populated, /✕<\/span>Needs attention/);
});

test("phoneSetupPage renders a 3-step wizard with required iOS setup paths and custom font URL", () => {
  const html = phoneSetupPage({
    profileUrl: "/setup/tok/fleet.mobileconfig",
    openUrl: "https://gate.fleet/phone?ticket=abc",
    fontUrl: "/setup/tok/geist-pixel-square.woff2",
  });
  assert.match(html, /data-pane="1"/);
  assert.match(html, /data-pane="2"/);
  assert.match(html, /data-pane="3"/);
  assert.match(html, /You'll need to install Fleet's certificate profile on your iPhone first\./);
  assert.match(html, /VPN &amp; Device Management/);
  assert.match(html, /Now, trust the certificate\./);
  assert.match(html, /Certificate Trust Settings/);
  assert.match(html, /Continue to Fleet to end the pairing process\./);
  assert.match(html, /href="\/setup\/tok\/fleet\.mobileconfig"/);
  assert.match(html, /href="https:\/\/gate\.fleet\/phone\?ticket=abc">Continue to Fleet</);
  assert.match(html, /\/setup\/tok\/geist-pixel-square\.woff2/);
  assert.doesNotMatch(html, /1 \/ 3/);
});

test("phoneConnectedPage, wakePage, offlinePage, and unavailablePage render expected content", () => {
  const connected = phoneConnectedPage({
    apps: [{ name: "notes", url: "https://notes.fleet", running: true }],
    routeClosed: true,
  });
  assert.match(connected, /Phone connected\./);
  assert.match(connected, /turned off automatically/);
  assert.match(connected, /notes/);

  const wake = wakePage("notes");
  assert.match(wake, /class="centered-body"/);
  assert.match(wake, /Waking notes\.\./);
  assert.match(wake, /This page will automatically open it when it's ready\./);
  assert.match(wake, /\/__fleet\/ready/);

  const offline = offlinePage("media", "https://gate.fleet");
  assert.match(offline, /This computer <span>is offline\.<\/span>/);
  assert.match(offline, /href="https:\/\/gate\.fleet"/);

  const unavailable = unavailablePage("https://gate.fleet");
  assert.match(unavailable, /This app <span>is unavailable\.<\/span>/);
});
