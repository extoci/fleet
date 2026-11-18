import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { checkContent, pageSlugs, routeFor } from './check-content.mjs';

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'fleet-content-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.mkdirSync(path.join(root, 'pages'));
  fs.mkdirSync(path.join(root, 'public'));
  const config = { navigation: { groups: [{ group: 'Start', pages: ['index'] }] } };
  const page = '---\ntitle: "Personal apps"\nsidebarTitle: "Home"\ndescription: "An example homepage."\n---\n<h1>Personal apps</h1>\n';
  const save = (body = page, nextConfig = config) => {
    fs.writeFileSync(path.join(root, 'docs.json'), JSON.stringify(nextConfig));
    fs.writeFileSync(path.join(root, 'pages', 'index.mdx'), body);
  };
  save();
  return { root, config, page, save };
}

test('maps navigation to routes', () => {
  assert.equal(routeFor('index'), '/');
  assert.equal(routeFor('docs/apps'), '/docs/apps');
  assert.deepEqual(pageSlugs({ navigation: { groups: [{ pages: ['index', 'docs/apps'] }] } }), ['index', 'docs/apps']);
});

test('validates the actual site', () => {
  assert.equal(checkContent().pages.size, 12);
});

test('accepts a valid minimal site', t => {
  assert.equal(checkContent(fixture(t).root).pages.size, 1);
});

test('rejects missing navigation targets', t => {
  const { root, config, save } = fixture(t);
  config.navigation.groups[0].pages.push('missing');
  save(undefined, config);
  assert.throws(() => checkContent(root), /Missing page/);
});

test('rejects broken local links', t => {
  const { root, page, save } = fixture(t);
  save(`${page}\n[Missing](/docs/missing)`);
  assert.throws(() => checkContent(root), /unknown local link/);
});

test('rejects duplicate navigation entries', t => {
  const { root, config, save } = fixture(t);
  config.navigation.groups[0].pages.push('index');
  save(undefined, config);
  assert.throws(() => checkContent(root), /duplicate pages/);
});

test('rejects unquoted metadata and duplicate headings', t => {
  const { root, page, save } = fixture(t);
  save(page.replace('title: "Personal apps"', 'title: Personal apps'));
  assert.throws(() => checkContent(root), /quoted string/);
  save(`${page}\n# Another title`);
  assert.throws(() => checkContent(root), /duplicate or missing H1/);
});

test('rejects orphaned pages', t => {
  const { root } = fixture(t);
  fs.writeFileSync(path.join(root, 'pages', 'orphan.mdx'), '# Orphan');
  assert.throws(() => checkContent(root), /Every page must be in navigation/);
});
