import { readFileSync, writeFileSync } from 'node:fs';

const manifestPath = process.argv[2];

function fail(error) {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`${message}\n`);
  process.exitCode = 1;
}

if (!manifestPath) {
  fail(new Error('usage: node normalize-updater-manifest.mjs <manifest path>'));
} else {
  try {
    let bytes = readFileSync(manifestPath);
    if (bytes.length >= 3 && bytes[0] === 0xEF && bytes[1] === 0xBB && bytes[2] === 0xBF) {
      bytes = bytes.subarray(3);
    }

    const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    JSON.parse(text);
    writeFileSync(manifestPath, Buffer.from(text, 'utf8'));
  } catch (error) {
    fail(error);
  }
}
