import fs from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';

const root = process.cwd();
const excludedDirectories = new Set(['.git', 'node_modules', 'coverage']);
const binaryExtensions = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp', '.ico', '.pptx', '.zip', '.pdf']);
const han = /[\u3400-\u9fff\uf900-\ufaff]/u;
const violations = [];

async function walk(directory) {
  const entries = await fs.readdir(directory, { withFileTypes: true });
  for (const entry of entries) {
    if (excludedDirectories.has(entry.name)) continue;
    const absolute = path.join(directory, entry.name);
    const relative = path.relative(root, absolute).replaceAll('\\', '/');
    if (han.test(entry.name)) violations.push(`${relative}: non-English filename`);
    if (entry.isDirectory()) {
      await walk(absolute);
      continue;
    }
    if (binaryExtensions.has(path.extname(entry.name).toLowerCase())) continue;
    const stat = await fs.stat(absolute);
    if (stat.size > 2_000_000) continue;
    const content = await fs.readFile(absolute, 'utf8');
    content.split(/\r?\n/).forEach((line, index) => {
      if (han.test(line)) violations.push(`${relative}:${index + 1}`);
    });
  }
}

await walk(root);
if (violations.length) {
  console.error(`English-only check failed:\n${violations.join('\n')}`);
  process.exit(1);
}
console.log('English-only check passed.');

