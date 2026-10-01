#!/usr/bin/env node
/**
 * §11.1-1 enforcement (honest, simple version):
 *  - src/contracts/** may not import anything runtime-level from other modules
 *  - files inside a module folder may only relative-import: own folder files,
 *    ../contracts/index.js, ../core/*.js, or a sibling module's PUBLIC face
 *    ../<module>/index.js
 *  - src root files (server.ts, app.ts, config.ts) = composition layer, exempt
 * Run: npm run check:arch
 */
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';

const SRC = path.resolve('src');
const MODULES = new Set(['core', 'contracts', 'gateway', 'tools', 'mcp', 'skills', 'sandbox', 'runs', 'security', 'auth', 'db']);

const files = [];
(function walk(dir) {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) walk(full);
    else if (e.name.endsWith('.ts')) files.push(full);
  }
})(SRC);

let violations = 0;
for (const file of files) {
  const relFromSrc = path.relative(SRC, file).split(path.sep);
  const owner = relFromSrc.length > 1 ? relFromSrc[0] : null;
  if (!owner) continue; // root composition files are exempt
  if (owner === 'contracts') {
    const text = readFileSync(file, 'utf8');
    for (const m of text.matchAll(/from\s+['"]([^'"]+)['"]/g)) {
      if (!m[1].startsWith('.')) continue;
      console.error(`BOUNDARY VIOLATION: contracts file ${relFromSrc.join('/')} imports "${m[1]}" (must stay dependency-free)`);
      violations++;
    }
    continue;
  }
  const text = readFileSync(file, 'utf8');
  for (const imp of [...text.matchAll(/from\s+['"](\.[^'"]+)['"]/g)].map((m) => m[1])) {
    const relTarget = path.relative(SRC, path.resolve(path.dirname(file), imp)).split(path.sep).join('/');
    const targetModule = relTarget.split('/')[0];
    if (!MODULES.has(targetModule)) continue; // inside own module or a non-module path
    if (targetModule === owner) continue;
    if (targetModule === 'core' || targetModule === 'contracts') continue;
    const isPublicFace = relTarget === `${targetModule}/index.js` || relTarget === `${targetModule}/index.ts`;
    if (!isPublicFace) {
      console.error(`BOUNDARY VIOLATION: ${relFromSrc.join('/')} deep-imports "${imp}" — import "../${targetModule}/index.js" instead (one module, one face)`);
      violations++;
    }
  }
}

if (violations > 0) {
  console.error(`\n${violations} boundary violation(s). See §11.1 of ORCHESTRATOR_PLAN.md.`);
  process.exit(1);
}
console.log(`check-boundaries: OK — ${files.length} files scanned, module seams clean`);
