// Screenshot scan — the pinned "Available now" group: the champions the last
// read found, as checklist cards, plus a "double-check" list for uncertain ones.
// Reads scanState (scan-ui.js); writes nothing but the DOM.

// ---- the pinned "Available now" group (its own child of #scan-results) ----
function scanDoneCount() {
  const progress = getProgress();
  let done = 0;
  for (const id of scanState.ids) if (progress[id]) done++;
  return { done, total: scanState.ids.length };
}
function refreshScanCount() {
  const el = document.querySelector("#scan-results .scan-count");
  if (!el) return;
  const { done, total } = scanDoneCount();
  const missing = total - done;
  el.textContent = missing
    ? `${missing} still needed · ${done}/${total} done`
    : `all ${total} done ✓`;
  el.classList.toggle("complete", missing === 0);
}
function syncChampionCardState(champId, nowDone) {
  document
    .querySelectorAll(`.champion[data-champ-id="${champId}"]`)
    .forEach((el) => {
      el.classList.toggle("done", nowDone);
      el.setAttribute("aria-pressed", String(nowDone));
    });
}
function renderScanResults() {
  const host = document.getElementById("scan-results");
  if (!host) return;
  let pinned = host.querySelector(".scan-pinned");
  if (!scanState.active || !scanState.ids.length) {
    pinned?.remove();
    return;
  }
  if (!pinned) {
    pinned = document.createElement("div");
    pinned.className = "scan-pinned";
    host.appendChild(pinned); // always after the panel
  }
  pinned.innerHTML = "";

  const byId = new Map(champions.map((c) => [c.id, c]));

  const section = document.createElement("div");
  section.className = "scan-section";

  const header = document.createElement("div");
  header.className = "scan-header";
  const title = document.createElement("span");
  title.className = "scan-title";
  title.textContent = "📷 Available now";
  const count = document.createElement("span");
  count.className = "scan-count";
  header.appendChild(title);
  header.appendChild(count);

  const rescan = document.createElement("button");
  rescan.className = "scan-action";
  rescan.textContent = "Scan again";
  rescan.onclick = openScanPanel;
  header.appendChild(rescan);

  const clear = document.createElement("button");
  clear.className = "scan-action scan-clear";
  clear.textContent = "×";
  clear.title = "Dismiss";
  clear.onclick = () => {
    scanState = {
      ids: [],
      uncertain: new Set(),
      alternatives: new Map(),
      active: false,
    };
    renderScanResults();
  };
  header.appendChild(clear);
  section.appendChild(header);

  const grid = document.createElement("div");
  grid.className = "champion-grid-region scan-grid";
  const alternatives = scanState.alternatives || new Map();
  scanState.ids.forEach((id) => {
    const champ = byId.get(id);
    if (!champ) return;
    const card = createChampionCard(champ);
    if (scanState.uncertain.has(id)) {
      card.classList.add("scan-uncertain");
      const alts = (alternatives.get(id) || [])
        .map((a) => byId.get(a)?.name)
        .filter(Boolean);
      card.title =
        (card.title ? card.title + " — " : "") +
        "uncertain match, verify" +
        (alts.length ? ` (or ${alts.join(", ")})` : "");
    }
    grid.appendChild(card);
  });
  section.appendChild(grid);

  // "Double-check" list: for every uncertain champion, show what else it might be
  // so the user can eyeball the alternatives instead of just trusting the pick.
  const uncertainWithAlts = scanState.ids.filter(
    (id) => scanState.uncertain.has(id) && (alternatives.get(id) || []).length,
  );
  if (uncertainWithAlts.length) {
    const note = document.createElement("div");
    note.className = "scan-uncertain-list";
    const h = document.createElement("div");
    h.className = "scan-uncertain-head";
    h.textContent = scanState.finalized
      ? "Double-check these — best guess vs. alternatives:"
      : "Still deciding — current best guess vs. alternatives:";
    note.appendChild(h);
    for (const id of uncertainWithAlts) {
      const champ = byId.get(id);
      if (!champ) continue;
      const rowScores = scanState.scores?.get(id);
      const row = document.createElement("div");
      row.className = "scan-uncertain-row";
      row.appendChild(scanMiniChip(champ, "best", rowScores?.self));
      const arrow = document.createElement("span");
      arrow.className = "scan-uncertain-or";
      arrow.textContent = "or";
      row.appendChild(arrow);
      const altWrap = document.createElement("div");
      altWrap.className = "scan-uncertain-alts";
      for (const altId of alternatives.get(id) || []) {
        const alt = byId.get(altId);
        if (alt)
          altWrap.appendChild(
            scanMiniChip(alt, "alt", rowScores?.alts?.get(altId)),
          );
      }
      row.appendChild(altWrap);
      note.appendChild(row);
    }
    section.appendChild(note);
  }

  pinned.appendChild(section);
  refreshScanCount();
}

// A small icon+name chip used in the "double-check" alternatives list. `kind` is
// "best" (the winning guess) or "alt" (a runner-up). Display-only (not clickable —
// the real toggle lives on the champion card above): it shows the match distance
// as a confidence number so the best guess and its alternatives can be compared.
// `score` is that distance (lower = closer icon match), or null if unavailable.
function scanMiniChip(champ, kind, score) {
  const chip = document.createElement("div");
  chip.className = "scan-chip scan-chip-" + kind;
  chip.title =
    kind === "best" ? `${champ.name} — best guess` : `Could be ${champ.name}`;
  const img = document.createElement("img");
  img.src = `${CHAMPION_ICON_BASE}${champ.image.full}`;
  img.alt = champ.name;
  const name = document.createElement("span");
  name.className = "scan-chip-name";
  name.textContent = champ.name;
  chip.appendChild(img);
  chip.appendChild(name);
  if (score != null && Number.isFinite(score)) {
    const conf = document.createElement("span");
    conf.className = "scan-chip-conf";
    conf.textContent = score.toFixed(1);
    conf.title = "match distance — lower means a closer icon match";
    chip.appendChild(conf);
  }
  return chip;
}
