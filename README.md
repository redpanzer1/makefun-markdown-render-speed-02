# markdown-render-speed-02

[![make.fun · markdown-render-speed-02](https://make.fun/badge/markdown-render-speed-02.svg)](https://make.fun/bounty/markdown-render-speed-02?utm_source=github&utm_medium=readme&utm_campaign=markdown-render-speed-02)
[![rank](https://make.fun/badge/markdown-render-speed-02/redpanzer1/makefun-markdown-render-speed-02/rank.svg)](https://make.fun/bounty/markdown-render-speed-02/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=markdown-render-speed-02)
[![reward](https://make.fun/badge/markdown-render-speed-02/redpanzer1/makefun-markdown-render-speed-02/reward.svg)](https://make.fun/bounty/markdown-render-speed-02?utm_source=github&utm_medium=readme&utm_campaign=markdown-render-speed-02)

A fast, dependency-free Markdown renderer written from scratch, byte-identical to [marked](https://github.com/markedjs/marked) 18.1.3 with default options (GFM enabled, breaks disabled) on the CommonMark 0.31.2 + GFM 0.29 test suite.

## How it works

`parse.js` is a hand-written, single-file ES module with no dependencies:

- **Block lexer** — ATX and setext headings, fenced and indented code, blockquotes (with lazy continuation lines), lists (tight/loose, task lists, nested), tables, thematic breaks, link reference definitions, and HTML blocks (all seven CommonMark types).
- **Inline lexer** — a flat atomiser followed by a CommonMark delimiter-stack resolver for emphasis, strong emphasis, and strikethrough (including the rule of three), plus links, images, autolinks, GFM extended autolinks (www, schemes, email), code spans, entities, and hard/soft breaks.
- **Speed** — first-character dispatch in both lexers, precompiled regular expressions, minimal allocation on the hot path, and a fast path for plain-text paragraphs.

`main.ts` is the driver: it reads `/input/cases.json` (or `$MAKEFUN_INPUT_DIR/cases.json`), renders every case with `parse()`, and writes the HTML array to `/output/html.json` (or `$MAKEFUN_OUTPUT_DIR/html.json`).

## Usage

```sh
node --experimental-strip-types main.ts
```

No build step and no dependencies — only built-in Node modules.

## License

MIT. See [LICENSE](LICENSE).

---
ref vian91
