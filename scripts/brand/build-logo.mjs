// Builds the Lapis brand assets: the "L." mark, the outlined "lapis"
// wordmark (Alegreya 500), the README logo (light and dark), the favicon and
// the path constants used by the web app.
//
// The tools are not project dependencies. Install them into the git-ignored
// .tmp/brand folder, then run the generator from the repository root:
//
//   npm install --no-save --no-package-lock --prefix .tmp/brand opentype.js@2.0.0 @fontsource/alegreya@5.3.0
//   node scripts/brand/build-logo.mjs
//
// The output is deterministic: rerunning the script leaves git status clean.

import { readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const require = createRequire(join(root, ".tmp/brand/noop.cjs"));
const opentype = require("opentype.js");

const FONT_FILE = join(
  root,
  ".tmp/brand/node_modules/@fontsource/alegreya/files/alegreya-latin-500-normal.woff",
);

// Mark geometry on a 32-unit grid: the L (stem = left margin, foot = last
// line) and the full stop.
const MARK_VIEWBOX = "0 0 32 32";
const MARK_L_PATH = "M7 5h4v18h11v4H7z";
const MARK_DOT = { cx: 26, cy: 25, r: 3 };
const MARK_BOX = { x1: 7, y1: 5, x2: MARK_DOT.cx + MARK_DOT.r, y2: 28 };
const MARK_L_TOP = 5;
const MARK_L_BOTTOM = 27;

const WORD = "lapis";
// Font size of the wordmark constants used by the app (units of the viewBox).
const WORDMARK_SIZE = 100;
// Font size of the wordmark in the 960x420 README logo.
const WIDE_SIZE = 192;
const WIDE = { width: 960, height: 420 };
const GAP_RATIO = 0.35;

const COLORS = {
  light: { ink: "#1c2433", dot: "#b03a2e" },
  dark: { ink: "#e7e2d6", dot: "#e0705c" },
};
const FAVICON_BG = { light: "#f3efe2", dark: "#12161e" };

const A11Y = 'role="img" aria-label="Lapis"';
const TITLE = "<title>Lapis</title>";

// Two decimals, no trailing zeros, no "-0".
function num(value) {
  const rounded = Math.round(value * 100) / 100;
  return String(Object.is(rounded, -0) ? 0 : rounded);
}

function loadFont() {
  const buffer = readFileSync(FONT_FILE);
  return opentype.parse(
    buffer.buffer.slice(
      buffer.byteOffset,
      buffer.byteOffset + buffer.byteLength,
    ),
  );
}

function wordmarkAt(font, x, baseline, size) {
  const path = font.getPath(WORD, x, baseline, size);
  return { d: path.toPathData(2), box: path.getBoundingBox() };
}

function markGroup(transform, colors, classes = {}) {
  const inkClass = classes.ink ? ` class="${classes.ink}"` : "";
  const dotClass = classes.dot ? ` class="${classes.dot}"` : "";
  return [
    `  <g transform="${transform}">`,
    `    <path${inkClass} d="${MARK_L_PATH}" fill="${colors.ink}"/>`,
    `    <circle${dotClass} cx="${MARK_DOT.cx}" cy="${MARK_DOT.cy}" r="${MARK_DOT.r}" fill="${colors.dot}"/>`,
    "  </g>",
  ];
}

function wideLogo(font, colors) {
  // Probe the wordmark at the origin to read its metrics.
  const probe = font.getPath(WORD, 0, 0, WIDE_SIZE).getBoundingBox();
  const ascender = -font.getPath("l", 0, 0, WIDE_SIZE).getBoundingBox().y1;
  // The L stem is as tall as the ascender of the outlined "l".
  const markHeight = ascender;
  const scale = markHeight / (MARK_L_BOTTOM - MARK_L_TOP);
  const gap = GAP_RATIO * markHeight;
  const markWidth = (MARK_BOX.x2 - MARK_BOX.x1) * scale;
  const wordWidth = probe.x2 - probe.x1;
  const groupWidth = markWidth + gap + wordWidth;
  const top = -ascender;
  const bottom = Math.max(probe.y2, (MARK_BOX.y2 - MARK_L_BOTTOM) * scale);
  const left = (WIDE.width - groupWidth) / 2;
  const baseline = (WIDE.height - (bottom - top)) / 2 - top;
  // The L foot bottom sits on the wordmark baseline.
  const markX = left - MARK_BOX.x1 * scale;
  const markY = baseline - MARK_L_BOTTOM * scale;
  const word = wordmarkAt(
    font,
    left + markWidth + gap - probe.x1,
    baseline,
    WIDE_SIZE,
  );
  return [
    `<svg xmlns="http://www.w3.org/2000/svg" width="${WIDE.width}" height="${WIDE.height}" viewBox="0 0 ${WIDE.width} ${WIDE.height}" ${A11Y}>`,
    `  ${TITLE}`,
    ...markGroup(
      `translate(${num(markX)} ${num(markY)}) scale(${Math.round(scale * 10000) / 10000})`,
      colors,
    ),
    `  <path d="${word.d}" fill="${colors.ink}"/>`,
    "</svg>",
    "",
  ].join("\n");
}

function markSvg(colors) {
  return [
    `<svg xmlns="http://www.w3.org/2000/svg" width="256" height="256" viewBox="${MARK_VIEWBOX}" ${A11Y}>`,
    `  ${TITLE}`,
    `  <path d="${MARK_L_PATH}" fill="${colors.ink}"/>`,
    `  <circle cx="${MARK_DOT.cx}" cy="${MARK_DOT.cy}" r="${MARK_DOT.r}" fill="${colors.dot}"/>`,
    "</svg>",
    "",
  ].join("\n");
}

function favicon() {
  const dx = 16 - (MARK_BOX.x1 + MARK_BOX.x2) / 2;
  const dy = 16 - (MARK_BOX.y1 + MARK_BOX.y2) / 2;
  const { dark } = COLORS;
  return [
    `<svg xmlns="http://www.w3.org/2000/svg" width="32" height="32" viewBox="0 0 32 32" ${A11Y}>`,
    `  ${TITLE}`,
    `  <style>@media (prefers-color-scheme: dark){.bg{fill:${FAVICON_BG.dark}}.ink{fill:${dark.ink}}.dot{fill:${dark.dot}}}</style>`,
    `  <rect width="32" height="32" rx="7" class="bg" fill="${FAVICON_BG.light}"/>`,
    ...markGroup(`translate(${num(dx)} ${num(dy)})`, COLORS.light, {
      ink: "ink",
      dot: "dot",
    }),
    "</svg>",
    "",
  ].join("\n");
}

function logoPaths(font) {
  const probe = font.getPath(WORD, 0, 0, WORDMARK_SIZE).getBoundingBox();
  // Baseline at y=0, left edge of the outlines at x=0.
  const word = wordmarkAt(font, -probe.x1, 0, WORDMARK_SIZE);
  const x1 = Math.floor(word.box.x1 * 100) / 100;
  const y1 = Math.floor(word.box.y1 * 100) / 100;
  const x2 = Math.ceil(word.box.x2 * 100) / 100;
  const y2 = Math.ceil(word.box.y2 * 100) / 100;
  const viewBox = [x1, y1, x2 - x1, y2 - y1].map(num).join(" ");
  return [
    "// Generated by scripts/brand/build-logo.mjs; do not edit.",
    "",
    `export const MARK_VIEWBOX = "${MARK_VIEWBOX}";`,
    `export const MARK_L_PATH = "${MARK_L_PATH}";`,
    `export const MARK_DOT = { cx: ${MARK_DOT.cx}, cy: ${MARK_DOT.cy}, r: ${MARK_DOT.r} } as const;`,
    `export const WORDMARK_VIEWBOX = "${viewBox}";`,
    `export const WORDMARK_PATH =`,
    `  "${word.d}";`,
    "",
  ].join("\n");
}

const font = loadFont();
const outputs = [
  ["assets/lapis-logo-wide.svg", wideLogo(font, COLORS.light)],
  ["assets/lapis-logo-wide-dark.svg", wideLogo(font, COLORS.dark)],
  ["assets/lapis-mark.svg", markSvg(COLORS.light)],
  ["apps/web/public/favicon.svg", favicon()],
  ["apps/web/src/components/lapis-logo-paths.ts", logoPaths(font)],
];

for (const [file, content] of outputs) {
  writeFileSync(join(root, file), content);
  console.log(`wrote ${file}`);
}
