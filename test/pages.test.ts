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

test("homePage renders the blur PII toggle with data-pii names and persistence wiring", () => {
  const html = homePage([
    { name: "notes", url: "https://notes.fleet", running: true },
    { name: "docs", url: "https://docs.fleet", running: false },
  ]);
  const actionsAt = html.indexOf("topbar-actions");
  const toggleAt = html.indexOf("data-blur-toggle");
  const logoutAt = html.indexOf("/__fleet/logout");
  assert.ok(actionsAt > -1, "expected a .topbar-actions container");
  assert.ok(toggleAt > actionsAt, "blur toggle should render inside .topbar-actions");
  assert.ok(html.indexOf("</div>", actionsAt) > toggleAt);
  assert.ok(logoutAt > toggleAt, "blur toggle should render before the logout form");
  const buttonStart = html.lastIndexOf("<button", toggleAt);
  const buttonHtml = html.slice(buttonStart, html.indexOf("</button>", toggleAt));
  assert.match(buttonHtml, /class="[^"]*\bicon-btn\b[^"]*"/);
  assert.match(buttonHtml, /type="button"/);
  assert.match(buttonHtml, /aria-pressed="false"/);
  assert.match(buttonHtml, /aria-label="Blur app names"/);
  assert.match(buttonHtml, /title="Blur app names"/);
  const icons = buttonHtml.match(/<svg\b[^>]*>/g) ?? [];
  const eye = icons.find((tag) => /icon-eye(?!-)/.test(tag));
  const eyeOff = icons.find((tag) => /icon-eye-off/.test(tag));
  assert.ok(eye, "expected an .icon-eye svg in the blur toggle");
  assert.ok(eyeOff, "expected an .icon-eye-off svg in the blur toggle");
  assert.match(eye, /aria-hidden="true"/);
  assert.match(eyeOff, /aria-hidden="true"/);
  assert.match(html, /<span\b(?=[^>]*class="app-name")(?=[^>]*\bdata-pii\b)[^>]*>notes<\/span>/);
  assert.match(html, /<span\b(?=[^>]*class="app-name")(?=[^>]*\bdata-pii\b)[^>]*>docs<\/span>/);
  const head = html.slice(0, html.indexOf("</head>"));
  assert.match(head, /localStorage\.getItem\((['"])fleet-blur-pii\1\)/);
  assert.match(head, /documentElement\.dataset\.blurPii/);
  const body = html.slice(html.indexOf("</head>"));
  const scripts = [...body.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/g)].map(
    (match) => match[1],
  );
  const script = scripts.find((source) => source.includes("fleet-blur-pii")) ?? "";
  assert.ok(script, "expected a body script persisting fleet-blur-pii");
  assert.match(script, /localStorage\.(?:setItem|removeItem)\(/);
  assert.match(script, /data-?blur-?pii|dataset\.blurPii/i);
  assert.match(script, /aria-?pressed/i);
  assert.match(script, /aria-?label/i);
  assert.match(script, /title/);
  assert.match(script, /Show app names/);
  assert.match(script, /Blur app names/);
  assert.match(script, /data-pii/);
  assert.match(script, /textContent|innerText|nodeValue|\.data\b/);
  assert.match(html, /\[data-blur-pii=("?)1\1\]\s*\[data-pii\]/);
  assert.match(html, /blur\(\s*4px\s*\)/);
  assert.match(html, /user-select:\s*none/);
});

test("homePage escapes hostile app names inside the data-pii span", () => {
  const html = homePage([
    { name: "<img src=x onerror=alert(1)>", url: "https://notes.fleet", running: true },
  ]);
  assert.doesNotMatch(html, /<img src=x/);
  assert.match(
    html,
    /<span\b(?=[^>]*class="app-name")(?=[^>]*\bdata-pii\b)[^>]*>&lt;img src=x onerror=alert\(1\)&gt;<\/span>/,
  );
});

test("blur PII toggle renders on phoneConnectedPage with apps and no other pages", () => {
  const connected = phoneConnectedPage({
    apps: [{ name: "notes", url: "https://notes.fleet", running: true }],
    routeClosed: true,
  });
  assert.match(connected, /data-blur-toggle/);
  assert.match(connected, /fleet-blur-pii/);
  assert.match(
    connected,
    /<span\b(?=[^>]*class="app-name")(?=[^>]*\bdata-pii\b)[^>]*>notes<\/span>/,
  );
  assert.doesNotMatch(phoneConnectedPage({ apps: [], routeClosed: true }), /data-blur-toggle/);
  for (const html of [
    loginPage("notes"),
    phoneSetupPage({
      profileUrl: "/setup/tok/fleet.mobileconfig",
      openUrl: "https://gate.fleet/phone?ticket=abc",
    }),
    wakePage("notes"),
    offlinePage("media", "https://gate.fleet"),
    unavailablePage("https://gate.fleet"),
  ]) {
    assert.doesNotMatch(html, /data-blur-toggle/);
  }
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
