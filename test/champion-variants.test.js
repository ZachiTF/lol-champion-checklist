// Tests for folding Classic-mode duplicates onto the real champion
// (src/champion-variants.js). Data Dragon lists each original champion twice
// since Classic mode shipped; the grid, the filters and the saved progress must
// keep seeing exactly one champion.
//
// Run: npm test

const test = require("node:test");
const assert = require("node:assert/strict");
const { foldClassicChampions } = require("../src/champion-variants.js");

const champ = (id, key, extra) => ({
  id,
  key: String(key),
  name: id,
  image: { full: `${id}.png` },
  ...extra,
});

// A miniature champion.json: two modern-only champions, one folded pair, and the
// Wukong case where the ids share nothing and only the key offset links them.
const DATA = {
  Ahri: champ("Ahri", 103),
  Jade_Ahri: champ("Jade_Ahri", 60103),
  Aatrox: champ("Aatrox", 266),
  MonkeyKing: champ("MonkeyKing", 62, { name: "Wukong" }),
  Jade_Wukong: champ("Jade_Wukong", 60062, { name: "Wukong" }),
};

test("folds classic duplicates onto their champion", () => {
  const { champions, aliases } = foldClassicChampions(DATA);
  assert.deepEqual(
    champions.map((c) => c.id),
    ["Ahri", "Aatrox", "MonkeyKing"],
  );
  assert.deepEqual(
    [...aliases],
    [
      ["Jade_Ahri", "Ahri"],
      ["Jade_Wukong", "MonkeyKing"],
    ],
  );
});

test("pairs by key offset, not by id or name (Wukong/MonkeyKing)", () => {
  const { champions } = foldClassicChampions(DATA);
  const wukong = champions.find((c) => c.id === "MonkeyKing");
  assert.equal(wukong.classic.id, "Jade_Wukong");
  assert.equal(wukong.classic.image.full, "Jade_Wukong.png");
});

test("keeps the modern icon and hangs the classic art alongside it", () => {
  const { champions } = foldClassicChampions(DATA);
  const ahri = champions.find((c) => c.id === "Ahri");
  assert.equal(ahri.image.full, "Ahri.png");
  assert.equal(ahri.classic.image.full, "Jade_Ahri.png");
  assert.equal(ahri.classic.key, "60103");
});

test("champions without a classic twin are untouched", () => {
  const { champions } = foldClassicChampions(DATA);
  const aatrox = champions.find((c) => c.id === "Aatrox");
  assert.equal(aatrox.classic, undefined);
});

test("does not mutate the Data Dragon entries it was given", () => {
  foldClassicChampions(DATA);
  assert.equal(DATA.Ahri.classic, undefined);
});

test("a classic entry with no modern counterpart stays a champion", () => {
  const { champions, aliases } = foldClassicChampions({
    Jade_Ghost: champ("Jade_Ghost", 60999),
  });
  assert.deepEqual(
    champions.map((c) => c.id),
    ["Jade_Ghost"],
  );
  assert.equal(aliases.size, 0);
});

test("accepts an array as well as the raw data object", () => {
  const { champions } = foldClassicChampions(Object.values(DATA));
  assert.equal(champions.length, 3);
});

// The whole thing has to disappear cleanly when Riot retires the duplicates:
// no aliases, no `classic` art, the plain champion list back as it was.
test("a patch without any duplicates passes straight through", () => {
  const { champions, aliases } = foldClassicChampions({
    Ahri: champ("Ahri", 103),
    Aatrox: champ("Aatrox", 266),
  });
  assert.equal(aliases.size, 0);
  assert.deepEqual(
    champions.map((c) => c.id),
    ["Ahri", "Aatrox"],
  );
  assert.ok(champions.every((c) => c.classic === undefined));
});
