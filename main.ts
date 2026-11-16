// Driver for the markdown-render-speed-02 bounty.
// Reads /input/cases.json, renders each case with parse(), and writes
// /output/html.json. Input/output directories come from the
// MAKEFUN_INPUT_DIR / MAKEFUN_OUTPUT_DIR environment variables when set,
// defaulting to /input and /output like the baseline.
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { parse } from './parse.js';

const inputDir = process.env.MAKEFUN_INPUT_DIR || '/input';
const outputDir = process.env.MAKEFUN_OUTPUT_DIR || '/output';

const raw = readFileSync(join(inputDir, 'cases.json'), 'utf8');
const cases = JSON.parse(raw);

const out = [];
if (Array.isArray(cases)) {
  for (const c of cases) out.push(parse(c.markdown));
} else {
  const keys = Object.keys(cases).sort((a, b) => Number(a) - Number(b));
  for (const k of keys) out.push(parse(cases[k].markdown));
}

mkdirSync(outputDir, { recursive: true });
writeFileSync(join(outputDir, 'html.json'), JSON.stringify(out));
