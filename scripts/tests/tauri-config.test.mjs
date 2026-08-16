import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const repositoryRoot = join(dirname(fileURLToPath(import.meta.url)), '../..');
const configPath = join(repositoryRoot, 'app', 'src-tauri', 'tauri.conf.json');

test('production windows use the bundled frontend instead of the Vite dev server', () => {
  const config = JSON.parse(readFileSync(configPath, 'utf8'));

  assert.equal(config.build.devUrl, 'http://localhost:1420');
  assert.equal(config.build.frontendDist, '../dist');
  for (const window of config.app.windows ?? []) {
    assert.equal(
      window.url,
      undefined,
      'production windows must not override the bundled frontend with a remote URL',
    );
  }
});
