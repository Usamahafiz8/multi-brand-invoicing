#!/usr/bin/env node
/**
 * Payment application bundle budget (NFR-PRF-013): 400 KB compressed on first
 * load, because the page has a 1.5s first-contentful-paint target on 4G.
 *
 * A budget that only appears in a document is not a budget. This fails the
 * build.
 */
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CHUNK_DIR = path.join(ROOT, 'apps', 'payment', '.next', 'static', 'chunks');
const BUDGET_BYTES = 400 * 1024;

if (!fs.existsSync(CHUNK_DIR)) {
  process.stderr.write(`no build output at ${CHUNK_DIR} — run the payment app build first\n`);
  process.exit(1);
}

let total = 0;
const files = [];

for (const entry of walk(CHUNK_DIR)) {
  if (!entry.endsWith('.js')) continue;
  const gzipped = zlib.gzipSync(fs.readFileSync(entry)).byteLength;
  total += gzipped;
  files.push({ name: path.relative(CHUNK_DIR, entry), gzipped });
}

files.sort((a, b) => b.gzipped - a.gzipped);
for (const file of files.slice(0, 10)) {
  process.stdout.write(`  ${kb(file.gzipped).padStart(9)}  ${file.name}\n`);
}

process.stdout.write(`\nTotal client JS (gzipped): ${kb(total)} / budget ${kb(BUDGET_BYTES)}\n`);

if (total > BUDGET_BYTES) {
  process.stderr.write(
    `\nPayment bundle exceeds the NFR-PRF-013 budget by ${kb(total - BUDGET_BYTES)}.\n` +
      `Every dependency on the payment app is also a PCI scope question — remove one, ` +
      `do not raise the budget without an ADR.\n`,
  );
  process.exit(1);
}

function* walk(dir) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) yield* walk(full);
    else yield full;
  }
}

function kb(bytes) {
  return `${(bytes / 1024).toFixed(1)} KB`;
}
