// The scan scripts run as CLASSIC scripts in the page and the Web Worker, but
// every other test loads them through require(). Those are different worlds: a
// top-level `const` in a classic script is not a property of globalThis, so a
// sibling that reads `globalThis.SOME_CONST` gets undefined in the browser and
// the real value under Node. That once made the ARAM reader decline every frame
// in the app while the whole suite stayed green. This test loads the files the
// way the browser does and demands the same read as Node.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const core = require("../src/scan-core.js");
require("../src/scan-aram.js");
const { listCases, loadIconHashes } = require("../scripts/case-set.js");

const SRC = path.join(__dirname, "..", "src");

test("classic-script load (page/worker) reads the same as require()", () => {
  const ctx = vm.createContext({ console });
  for (const f of ["scan-core.js", "scan-aram.js"])
    vm.runInContext(fs.readFileSync(path.join(SRC, f), "utf8"), ctx, {
      filename: f,
    });
  const c = listCases().find((x) => x.name === "fixture-window-share");
  const frame = c.frame();
  const iconHashById = loadIconHashes();
  const ids = (r) =>
    r.client
      ? [...r.benchSlots, ...r.pickCircles].map((p) => p.m && p.m.id)
      : null;

  ctx.frame = frame;
  ctx.iconHashById = iconHashById;
  const browser = vm.runInContext(
    'runFrameRead(pipelineForMode("aram"), frame, { iconHashById, frameIsClient: true })',
    ctx,
  );
  const node = core.runFrameRead(core.pipelineForMode("aram"), frame, {
    iconHashById,
    frameIsClient: true,
  });
  assert.ok(node.client, "Node reads the fixture");
  assert.ok(browser.client, "the classic-script load must not decline it");
  assert.deepEqual(ids(browser), ids(node));
});
