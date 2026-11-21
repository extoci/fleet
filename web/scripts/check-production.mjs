import assert from 'node:assert/strict';
import { once } from 'node:events';
import net from 'node:net';
import { spawn } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
import { checkContent, projectRoot } from './check-content.mjs';

const { pages } = checkContent();
const listener = net.createServer();
listener.listen(0, '127.0.0.1');
await once(listener, 'listening');
const port = listener.address().port;
await new Promise((resolve) => listener.close(resolve));
const base = `http://127.0.0.1:${port}`;
const server = spawn(process.execPath, ['dist/rsc/index.js'], {
  cwd: projectRoot,
  env: { ...process.env, PORT: String(port), HOST: '127.0.0.1' },
  stdio: ['ignore', 'pipe', 'pipe'],
});
let output = '';
server.stdout.on('data', (data) => {
  output += data;
});
server.stderr.on('data', (data) => {
  output += data;
});
server.on('error', (error) => {
  output += error.message;
});
const exited = once(server, 'exit');
const request = (route, options) =>
  fetch(`${base}${route}`, { signal: AbortSignal.timeout(30_000), ...options });

try {
  let ready = false;
  for (let attempt = 0; attempt < 150; attempt++) {
    assert(server.exitCode === null, `Production server exited:\n${output}`);
    try {
      const response = await request('/');
      if (response.ok) {
        ready = true;
        break;
      }
    } catch {
      // Server is still booting.
    }
    await delay(200);
  }
  assert(ready, `Production server did not become ready:\n${output}`);

  for (const [route, page] of pages) {
    const response = await request(route);
    assert.equal(response.status, 200, route);
    const html = (await response.text()).replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, '');
    assert.equal([...html.matchAll(/<h1(?:\s|>)/g)].length, 1, `${route}: one rendered H1`);
    const title = html.match(/<title>(.*?)<\/title>/s)?.[1];
    assert.equal(title, `${page.title} - Fleet`, `${route}: page title`);
    assert(html.includes('name="description"'), `${route}: description metadata`);
    assert(
      !html.includes('MDX Error') && !html.includes('Internal Server Error'),
      `${route}: rendering error`,
    );
    if (route === '/') {
      assert(html.includes('class="fleet-button"'), 'Landing CTA styles survive rendering');
      assert(html.includes('fleet-dither'), 'Landing dither canvas survives rendering');
      assert(html.includes('fleet-row-name'), 'Landing guide rows survive rendering');
      assert(
        !html.includes('href="https://notes.fleet"'),
        'Illustrated app address is not a live link',
      );
    }

    const markdownRoute = route === '/' ? '/index.md' : `${route}.md`;
    const markdown = await request(markdownRoute);
    assert.equal(markdown.status, 200, markdownRoute);
    assert((await markdown.text()).includes(page.title), `${markdownRoute}: exported title`);
    console.log(`PASS ${route} + markdown export`);
  }

  const redirect = await request('/docs', { redirect: 'manual' });
  assert([301, 302, 307, 308].includes(redirect.status), '/docs redirects');
  assert.equal(new URL(redirect.headers.get('location'), base).pathname, '/docs/overview');
  assert.equal((await request('/this-page-does-not-exist')).status, 404, 'missing route');

  for (const route of [
    '/fleet-light.svg',
    '/fleet-dark.svg',
    '/favicon.svg',
    '/install',
    '/install.sh',
    '/install.ps1',
    '/sitemap.xml',
    '/llms.txt',
    '/llms-full.txt',
    '/docs.zip',
  ]) {
    const response = await request(route);
    assert.equal(response.status, 200, route);
    const bytes = new Uint8Array(await response.arrayBuffer());
    assert(bytes.length > 30, `${route}: empty response`);
    if (route === '/docs.zip')
      assert.equal(String.fromCharCode(...bytes.slice(0, 2)), 'PK', 'zip signature');
    console.log(`PASS ${route}`);
  }
  console.log('Production smoke test passed. Browser interaction is not covered by this check.');
} catch (error) {
  console.error(output);
  throw error;
} finally {
  if (server.exitCode === null) server.kill();
  await exited;
}
