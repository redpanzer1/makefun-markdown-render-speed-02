// Driver for the make.fun markdown-render-speed-02 bounty: reads every case
// from /input/cases.json (or $MAKEFUN_INPUT_DIR outside a container),
// renders each one alone with parse() from parse.js, and writes
// /output/html.json (or $MAKEFUN_OUTPUT_DIR/html.json): a JSON array of the
// HTML strings, one per case and in the cases' order. Runs as `node main.ts`
// on Node 22, which strips TypeScript types natively (erasable syntax only).
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parse } from "./parse.js";

const inputDir = process.env.MAKEFUN_INPUT_DIR ?? "/input";
const outputDir = process.env.MAKEFUN_OUTPUT_DIR ?? "/output";

const cases = JSON.parse(
  readFileSync(join(inputDir, "cases.json"), "utf8"),
) as { id: string; markdown: string }[];

const html: string[] = new Array(cases.length);
for (let i = 0; i < cases.length; i++) {
  html[i] = parse(cases[i].markdown);
}

mkdirSync(outputDir, { recursive: true });
writeFileSync(join(outputDir, "html.json"), JSON.stringify(html));
