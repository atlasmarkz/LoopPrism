"use strict";
// Compiles src/tui.tsx (Solid JSX for OpenTUI) to plain JavaScript in src/tui.js.
//
// Why: OpenCode compiles JSX for plugin files it loads from a folder, but not for a package installed
// under node_modules (tested on 2.0.32: the .tsx there was compiled as React JSX and failed with
// "Cannot find package 'react'"). The compiled file only imports "@opentui/solid" and "solid-js", which
// OpenCode resolves itself, so the package does not need to install them.
//
// Run `node scripts/build-tui.cjs` after changing src/tui.tsx and commit src/tui.js. There is no npm "build" or "prepack" script on purpose:
// OpenCode's installer fails on git packages that have one, and a test checks that src/tui.js is up to date.
// The build tools are not in package.json (OpenCode's installer cannot prepare git packages that have
// devDependencies): install them for a build with
//   npm install --no-save @babel/core@7 babel-preset-solid@1.9 @babel/preset-typescript@7
const babel = require("@babel/core");
const fs = require("node:fs");
const path = require("node:path");

const src = path.join(__dirname, "..", "src", "tui.tsx");
const out = path.join(__dirname, "..", "src", "tui.js");

/** The text src/tui.js should contain. */
function compile() {
  const result = babel.transformSync(fs.readFileSync(src, "utf8"), {
    filename: src,
    babelrc: false,
    configFile: false,
    presets: [
      ["babel-preset-solid", { moduleName: "@opentui/solid", generate: "universal" }],
      ["@babel/preset-typescript", { isTSX: true, allExtensions: true }],
    ],
  });
  return `// GENERATED from tui.tsx by scripts/build-tui.cjs. Do not edit.\n${result.code}\n`;
}

module.exports = { compile, out };

if (require.main === module) {
  const code = compile();
  fs.writeFileSync(out, code);
  console.log(`wrote ${path.relative(process.cwd(), out)} (${code.length} bytes)`);
}
