// The app's classic scripts share ONE global scope in the page, so a top-level
// name declared in two of them is a SyntaxError in the browser ("Identifier has
// already been declared") that require()-based tests never see. This reads the
// load list straight out of index.html and checks each file parses and that no
// top-level name is declared twice across the set.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const ROOT = path.join(__dirname, "..");
const html = fs.readFileSync(path.join(ROOT, "index.html"), "utf8");
const scripts = [
  ...[...html.matchAll(/<script src="((?:src|data)\/[^"]+\.js)"/g)].map(
    (m) => m[1],
  ),
  ...[...html.matchAll(/^\s*"(src\/[^"]+\.js)",$/gm)].map((m) => m[1]),
];

test("index.html loads the scan scripts", () => {
  for (const f of ["src/scan-ui.js", "src/scan-live.js", "src/scan-runner.js"])
    assert.ok(scripts.includes(f), `${f} is in the load list`);
});

test("every app script parses, and no top-level name is declared twice", () => {
  const owner = new Map();
  const decl =
    /^(?:async\s+)?(?:function\*?|let|const|var|class)\s+([A-Za-z_$][\w$]*)/gm;
  for (const f of scripts) {
    const src = fs.readFileSync(path.join(ROOT, f), "utf8");
    new vm.Script(src, { filename: f }); // throws on a syntax error
    for (const m of src.matchAll(decl)) {
      const prev = owner.get(m[1]);
      assert.ok(!prev, `${m[1]} is declared in both ${prev} and ${f}`);
      owner.set(m[1], f);
    }
  }
});
