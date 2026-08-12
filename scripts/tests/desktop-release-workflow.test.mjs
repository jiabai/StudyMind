import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

const gitignore = fs.readFileSync(path.join(repositoryRoot, '.gitignore'), 'utf8');
assert.ok(
  gitignore.split(/\r?\n/).includes('!app/package-lock.json'),
  '.gitignore must contain the exact line !app/package-lock.json',
);

const lockfilePath = path.join(repositoryRoot, 'app', 'package-lock.json');
const lockfile = JSON.parse(fs.readFileSync(lockfilePath, 'utf8'));
assert.ok(
  Number.isInteger(lockfile.lockfileVersion) && lockfile.lockfileVersion >= 1,
  'app/package-lock.json must have lockfileVersion >= 1',
);
