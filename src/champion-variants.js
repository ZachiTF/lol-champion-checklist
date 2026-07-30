// Champion identity — fold League's Classic-mode duplicates onto the real champion.
//
// Classic mode brought back the 2009 versions of the original champions, and Data
// Dragon lists every one of them as a SECOND champion entry: same name, period
// art, an id prefixed "Jade_" and a numeric key offset by 60000 (Jade_Ahri key
// 60103 ↔ Ahri key 103). Taken at face value that puts ~60 champions in the grid
// twice, each copy holding its own progress and belonging to no challenge filter
// (the Globetrotter/Harmony lists only know the real ids).
//
// So the app keeps ONE entry per champion — the modern one, whose id every filter,
// saved page and scan result already uses — and hangs the old art off it as
// `champ.classic`, which the grid still shows (see createChampionCard).
//
// Pairing is by KEY OFFSET, not by the "Jade_" prefix: it's the link Riot actually
// maintains, and it's the only one that gets Wukong right — Jade_Wukong (60062)
// pairs with MonkeyKing (62), whose ids share nothing at all.
const CLASSIC_KEY_OFFSET = 60000;

// The modern entry a Classic-mode entry belongs to, or null if this isn't one.
function classicBaseFor(entry, byKey) {
  const key = Number(entry && entry.key);
  if (!Number.isFinite(key) || key <= CLASSIC_KEY_OFFSET) return null;
  return byKey.get(String(key - CLASSIC_KEY_OFFSET)) || null;
}

/**
 * Collapse a raw Data Dragon champion list to one entry per champion.
 * @param {Array|Object} entries champion.json `data` (object or array of entries)
 * @returns {{ champions: Array, aliases: Map<string,string> }} the deduped list
 *   (each folded champion carrying `classic: { id, key, image }`), plus a
 *   variant-id → champion-id map for everything keyed by id elsewhere.
 */
function foldClassicChampions(entries) {
  const list = Array.isArray(entries) ? entries : Object.values(entries || {});
  const byKey = new Map();
  for (const c of list) if (c && c.key != null) byKey.set(String(c.key), c);

  const aliases = new Map();
  const classicByBaseId = new Map();
  for (const c of list) {
    const base = classicBaseFor(c, byKey);
    if (!base) continue;
    aliases.set(c.id, base.id);
    classicByBaseId.set(base.id, c);
  }

  const champions = [];
  for (const c of list) {
    if (aliases.has(c.id)) continue; // a classic twin — folded onto its champion
    const classic = classicByBaseId.get(c.id);
    // A classic entry with no modern counterpart (shouldn't happen) stays a
    // champion of its own rather than disappearing from the grid.
    champions.push(
      classic
        ? {
            ...c,
            classic: {
              id: classic.id,
              key: classic.key,
              image: classic.image,
            },
          }
        : c,
    );
  }
  return { champions, aliases };
}

// Dual-use: expose the pure API to Node (tests) without disturbing the browser,
// where these top-level declarations are already globals shared across scripts.
if (typeof module !== "undefined" && module.exports) {
  module.exports = { CLASSIC_KEY_OFFSET, classicBaseFor, foldClassicChampions };
}
