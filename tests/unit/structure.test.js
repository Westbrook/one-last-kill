import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../..', import.meta.url));
function scripts(directory) {
  return readdirSync(directory, { withFileTypes: true }).flatMap(entry => {
    const path = resolve(directory, entry.name);
    return entry.isDirectory() ? scripts(path) : path.endsWith('.js') ? [path] : [];
  });
}

test('every local source import resolves to a workspace file', () => {
  for (const path of scripts(resolve(root, 'src'))) {
    const source = readFileSync(path, 'utf8');
    for (const match of source.matchAll(/(?:from\s+|import\s*\(?\s*)['"](\.[^'"]+)['"]/g)) {
      assert.ok(existsSync(resolve(dirname(path), match[1])), `${path}: missing ${match[1]}`);
    }
  }
});

test('runtime has no CDN or production debug globals', () => {
  for (const path of scripts(resolve(root, 'src')).filter(path => !path.includes('/testing/'))) {
    const source = readFileSync(path, 'utf8');
    assert.doesNotMatch(source, /from\s+['"]https?:\/\//, path);
    assert.doesNotMatch(source, /window\.__punisher\w*\s*=/, path);
  }
});

test('generated game assets and provenance are included locally', () => {
  for (const name of ['last-kill-keyart.png', 'plaster-aged.png', 'brick-weathered.png', 'textures.prompt.txt', 'last-kill-keyart.prompt.txt']) {
    assert.ok(existsSync(resolve(root, 'public/assets', name)), name);
  }
});
