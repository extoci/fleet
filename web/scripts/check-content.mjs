import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

export const projectRoot = fileURLToPath(new URL('../', import.meta.url));

export function pageSlugs(config) {
  return config.navigation.groups.flatMap(group => group.pages);
}

export function routeFor(slug) {
  return slug === 'index' ? '/' : `/${slug}`;
}

function filesIn(directory) {
  return fs.readdirSync(directory, { withFileTypes: true }).flatMap(entry => {
    const file = path.join(directory, entry.name);
    return entry.isDirectory() ? filesIn(file) : [file];
  });
}

export function checkContent(root = projectRoot) {
  const config = JSON.parse(fs.readFileSync(path.join(root, 'docs.json'), 'utf8'));
  const slugs = pageSlugs(config);
  assert.equal(new Set(slugs).size, slugs.length, 'Navigation has duplicate pages');
  assert(slugs.includes('index'), 'Navigation must include the homepage');
  const routes = new Set(slugs.map(routeFor));
  const redirects = config.redirects ?? [];
  const validRoutes = new Set([...routes, ...redirects.map(item => item.source)]);
  const pages = new Map();
  const titles = new Set();

  function checkLink(href, source) {
    if (!href.startsWith('/') || href.startsWith('//')) return;
    const target = href.split(/[?#]/)[0];
    assert(
      validRoutes.has(target) || fs.existsSync(path.join(root, 'public', target)),
      `${source}: unknown local link ${href}`,
    );
  }

  function checkSourceLinks(text, source) {
    for (const link of text.matchAll(/href="([^"]+)"|\]\((\/[^\s)]+)\)/g)) {
      checkLink(link[1] ?? link[2], source);
    }
  }

  for (const slug of slugs) {
    const file = path.join(root, 'pages', `${slug}.mdx`);
    assert(fs.existsSync(file), `Missing page: ${slug}`);
    const text = fs.readFileSync(file, 'utf8');
    const match = text.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n/);
    assert(match, `${slug}: missing frontmatter`);
    const metadata = {};
    for (const key of ['title', 'sidebarTitle', 'description']) {
      const value = match[1].match(new RegExp(`^${key}: (".+")$`, 'm'));
      assert(value, `${slug}: ${key} must be a quoted string`);
      metadata[key] = JSON.parse(value[1]);
    }
    assert(!titles.has(metadata.title), `${slug}: duplicate title`);
    titles.add(metadata.title);
    assert(metadata.sidebarTitle.length <= 30, `${slug}: sidebar title is too long`);
    const body = text.slice(match[0].length);
    const prose = body.replace(/^```[^\n]*\n[\s\S]*?^```/gm, '');
    const authoredH1s = [...prose.matchAll(/^#\s|<h1(?:\s|>)/gm)].length;
    assert(authoredH1s <= (slug === 'index' ? 1 : 0), `${slug}: duplicate H1`);
    checkSourceLinks(prose, slug);
    pages.set(routeFor(slug), { ...metadata, body });
  }

  const authored = filesIn(path.join(root, 'pages'))
    .filter(file => /\.mdx?$/.test(file))
    .map(file => path.relative(path.join(root, 'pages'), file).replaceAll(path.sep, '/').replace(/\.mdx?$/, ''));
  assert.deepEqual(authored.sort(), [...slugs].sort(), 'Every page must be in navigation');
  for (const item of redirects) assert(routes.has(item.destination), `Unknown redirect target: ${item.destination}`);
  function checkConfigLinks(value) {
    if (!value || typeof value !== 'object') return;
    if (typeof value.href === 'string') checkLink(value.href, 'docs.json');
    for (const child of Object.values(value)) checkConfigLinks(child);
  }
  checkConfigLinks(config);
  const components = path.join(root, 'components');
  if (fs.existsSync(components)) {
    for (const file of filesIn(components).filter(file => /\.[jt]sx?$/.test(file))) {
      checkSourceLinks(fs.readFileSync(file, 'utf8'), path.relative(root, file));
    }
  }
  return { config, pages };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const { pages } = checkContent();
  console.log(`Content check passed: ${pages.size} pages, navigation, metadata, and local link targets.`);
}
