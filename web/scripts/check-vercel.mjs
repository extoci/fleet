import assert from 'node:assert/strict';
import { cp, mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { checkContent, projectRoot } from './check-content.mjs';

const { pages } = checkContent();
const output = join(projectRoot, '.vercel/output');
const config = JSON.parse(await readFile(join(output, 'config.json'), 'utf8'));
assert.equal(config.version, 3, 'Vercel Build Output API v3');
assert(
  config.routes.some((route) => route.handle === 'filesystem'),
  'Static CDN routing',
);
assert(
  config.routes.some((route) => route.src === '/(.*)' && route.dest === '/'),
  'Server fallback routing',
);

const functionRoot = join(output, 'functions/index.func');
const functionConfig = JSON.parse(await readFile(join(functionRoot, '.vc-config.json'), 'utf8'));
assert.equal(functionConfig.runtime, 'nodejs22.x', 'Node runtime matches package engines');
assert.equal(functionConfig.supportsResponseStreaming, true, 'Streaming enabled');
for (const asset of [
  'fleet-light.svg',
  'fleet-dark.svg',
  'favicon.svg',
  'install',
  'install.sh',
  'install.ps1',
]) {
  assert((await stat(join(output, 'static', asset))).size > 0, `CDN asset ${asset}`);
}

// Resolve dependencies from the function bundle, outside the project's node_modules.
const isolatedRoot = await mkdtemp(join(tmpdir(), 'fleet-vercel-'));
const originalCwd = process.cwd();
try {
  await cp(functionRoot, isolatedRoot, { recursive: true });
  process.chdir(isolatedRoot);
  const { default: handler } = await import(
    pathToFileURL(join(isolatedRoot, functionConfig.handler)).href
  );
  assert.equal(typeof handler.fetch, 'function', 'Vercel fetch handler');
  const request = (path) => handler.fetch(new Request(`https://fleet.extoci.lol${path}`));

  for (const [route, page] of pages) {
    const response = await request(route);
    assert.equal(response.status, 200, route);
    const html = (await response.text()).replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, '');
    assert.equal([...html.matchAll(/<h1(?:\s|>)/g)].length, 1, `${route}: rendered H1`);
    assert(html.includes(`<title>${page.title} - Fleet</title>`), `${route}: title`);
    assert(
      !html.includes('MDX Error') && !html.includes('Internal Server Error'),
      `${route}: render error`,
    );
    const markdownRoute = route === '/' ? '/index.md' : `${route}.md`;
    const markdown = await request(markdownRoute);
    assert.equal(markdown.status, 200, markdownRoute);
    assert((await markdown.text()).includes(page.title), `${markdownRoute}: exported title`);
    console.log(`PASS packaged handler ${route} + markdown`);
  }

  const redirect = await request('/docs');
  assert([301, 302, 307, 308].includes(redirect.status), '/docs redirects');
  assert.equal(
    new URL(redirect.headers.get('location'), 'https://fleet.extoci.lol').pathname,
    '/docs/overview',
  );
  assert.equal((await request('/this-page-does-not-exist')).status, 404, 'Missing route');

  for (const route of ['/sitemap.xml', '/llms.txt', '/llms-full.txt', '/docs.zip']) {
    const response = await request(route);
    assert.equal(response.status, 200, route);
    const bytes = new Uint8Array(await response.arrayBuffer());
    assert(bytes.length > 30, `${route}: empty export`);
    if (route === '/docs.zip')
      assert.equal(String.fromCharCode(...bytes.slice(0, 2)), 'PK', 'ZIP signature');
  }
} finally {
  process.chdir(originalCwd);
  await rm(isolatedRoot, { recursive: true, force: true });
}
console.log(
  'Vercel output and packaged fetch-handler checks passed. This is not a hosted deployment test.',
);
