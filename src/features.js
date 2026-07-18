// Features & usage guide panel — a collapsible "what can this do / what's new"
// list shown near the top of the app, for first-time users and for returning
// users who missed newer features (a "new" dot appears until they open it).
//
// ┌─────────────────────────────────────────────────────────────────────────┐
// │ MAINTAIN THIS: when you ship a user-facing feature, add a FEATURE_LIST    │
// │ entry with `since: FEATURES_VERSION + 1`, then bump FEATURES_VERSION.     │
// │ That surfaces the "new" dot for anyone who last opened an older version.  │
// └─────────────────────────────────────────────────────────────────────────┘
const FEATURES_VERSION = 3;
const FEATURES_SEEN_KEY = "lol_features_seen";

// Short "how to use" steps for someone opening the app for the first time.
const FEATURE_GUIDE = [
  "Click a champion tile to mark it done — click again to unmark. Your progress is saved in this browser.",
  "Search by name, add Globetrotter (region) or Harmony (trait) filters, sort, and hide completed.",
  "Use the tabs at the top to keep separate lists; the ⚙ tab menu renames, recolors, or undoes.",
  "Track the progress bar and the Progress History chart at the bottom.",
];

// The feature list. `since` = the FEATURES_VERSION a feature shipped in; entries
// newer than the viewer's last-seen version are flagged "new".
const FEATURE_LIST = [
  {
    icon: "📑",
    title: "Multiple tabs",
    desc: "Keep separate checklists, each with its own name and color.",
    since: 1,
    sub: [
      {
        title: "Undo banners",
        desc: "quickly revert an accidental mark, clear, or tab change.",
      },
    ],
  },
  {
    icon: "🔍",
    title: "Search, filters & sort",
    desc: "Fuzzy name search, Globetrotter/Harmony filters, sort by name/completion/date, hide completed.",
    since: 1,
  },
  {
    icon: "📈",
    title: "Progress history",
    desc: "A chart of your completion over time, with recent changes.",
    since: 1,
    sub: [
      {
        title: "Completion dates",
        desc: "hover a completed champion to see when you marked it.",
      },
    ],
  },
  {
    icon: "🎉",
    title: "Celebrations",
    desc: "Confetti and effects on milestones — toggle with ✨ in settings.",
    since: 1,
  },
  {
    icon: "🎨",
    title: "Light / dark / auto theme",
    desc: "Switch with the ◐ button top-right.",
    since: 1,
  },
  {
    icon: "🔊",
    title: "Champion voice lines",
    desc: "Hear a champion quote when you mark them — opt in with 🔊 in settings.",
    since: 2,
  },
  {
    icon: "📷",
    title: "Screenshot scan",
    desc: "Paste (Ctrl+V) or drop an ARAM champ-select screenshot — even a full-desktop print screen — and the offered champions you still need are pinned to the top. Open it with 📷 in settings.",
    since: 3,
  },
];

function renderFeaturesPanel() {
  const host = document.getElementById("features-panel");
  if (!host) return;
  host.innerHTML = "";

  const seen = parseInt(localStorage.getItem(FEATURES_SEEN_KEY) || "0", 10);
  const hasNew = seen < FEATURES_VERSION;

  const details = document.createElement("details");
  details.className = "features-panel";

  const summary = document.createElement("summary");
  summary.className = "features-summary";
  summary.innerHTML =
    '<span class="features-title">✨ Features &amp; guide</span>';
  if (hasNew) {
    const dot = document.createElement("span");
    dot.className = "features-new-dot";
    dot.textContent = seen === 0 ? "start here" : "new";
    summary.appendChild(dot);
  }
  details.appendChild(summary);

  const body = document.createElement("div");
  body.className = "features-body";

  const guide = document.createElement("ol");
  guide.className = "features-guide";
  for (const step of FEATURE_GUIDE) {
    const li = document.createElement("li");
    li.textContent = step;
    guide.appendChild(li);
  }
  body.appendChild(guide);

  const list = document.createElement("ul");
  list.className = "features-list";
  for (const f of FEATURE_LIST) {
    const li = document.createElement("li");
    li.className = "features-item";
    const isNew = seen > 0 && (f.since || 0) > seen;
    let html =
      `<span class="features-icon">${f.icon}</span>` +
      `<span class="features-text"><strong>${f.title}</strong>` +
      (isNew ? ' <span class="features-tag">new</span>' : "") +
      `<span class="features-desc">${f.desc}</span>`;
    if (f.sub) {
      html +=
        '<ul class="features-sub">' +
        f.sub
          .map(
            (s) =>
              `<li><strong>${s.title}</strong><span class="features-desc"> — ${s.desc}</span></li>`,
          )
          .join("") +
        "</ul>";
    }
    li.innerHTML = html + "</span>";
    list.appendChild(li);
  }
  body.appendChild(list);
  details.appendChild(body);

  // Opening the panel counts as "seen" — clears the dot and the per-item tags.
  details.addEventListener("toggle", () => {
    if (details.open && seen < FEATURES_VERSION) {
      localStorage.setItem(FEATURES_SEEN_KEY, String(FEATURES_VERSION));
      const dot = summary.querySelector(".features-new-dot");
      if (dot) dot.remove();
    }
  });

  host.appendChild(details);
}

// Render once on load (kept out of renderAll so the open/closed state survives
// grid re-renders). The #features-panel div is earlier in the body, so it exists.
renderFeaturesPanel();
