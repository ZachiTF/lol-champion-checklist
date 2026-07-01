// --- CELEBRATIONS ---
// Self-contained achievement easter eggs. Exposes `window.Celebrations`.
//
// Triggered from script.js whenever a champion is marked done (and after
// "Select all"). Gated by the same `lol_animations` flag as the ✨ toggle,
// which is ON by default. Confetti is powered by the canvas-confetti library
// loaded from a CDN in index.html; every call is guarded so a missing/blocked
// CDN still shows the banner and never throws.

window.Celebrations = (function () {
  const STORAGE_KEY = "lol_animations";

  // On-brand gold shades for the monochrome cheer (mirrors the progress-bar gradient).
  const GOLD_SHADES = ["#c89b3c", "#f0e6d2", "#a17a2b"];
  const RAINBOW = [
    "#e57373",
    "#ffb74d",
    "#ffd54f",
    "#81c784",
    "#4db6ac",
    "#64b5f6",
    "#ba68c8",
  ];

  const BANNER_DURATION = 4000; // ms the banner stays before fading out

  // Effects follow the existing ✨ animations toggle (default ON).
  function isEnabled() {
    return localStorage.getItem(STORAGE_KEY) !== "false";
  }

  function letterOf(name) {
    return (name || "?").charAt(0).toUpperCase();
  }

  function hasConfetti() {
    return typeof window.confetti === "function";
  }

  // Colorful, multi-burst celebration for reaching 100%.
  function fireColorful() {
    if (!hasConfetti()) return;
    const end = Date.now() + 2500;
    (function frame() {
      window.confetti({
        particleCount: 6,
        angle: 60,
        spread: 60,
        origin: { x: 0, y: 0.7 },
        colors: RAINBOW,
        disableForReducedMotion: true,
      });
      window.confetti({
        particleCount: 6,
        angle: 120,
        spread: 60,
        origin: { x: 1, y: 0.7 },
        colors: RAINBOW,
        disableForReducedMotion: true,
      });
      if (Date.now() < end) requestAnimationFrame(frame);
    })();
  }

  // Single monochrome (gold) burst for finishing a starting letter.
  function fireMono() {
    if (!hasConfetti()) return;
    window.confetti({
      particleCount: 90,
      spread: 75,
      startVelocity: 42,
      origin: { y: 0.7 },
      colors: GOLD_SHADES,
      disableForReducedMotion: true,
    });
  }

  // Transient banner pinned to the bottom of the page.
  function showBanner(message, variant) {
    // Replace any existing banner so they don't stack.
    const existing = document.querySelector(".achievement-banner");
    if (existing) existing.remove();

    const banner = document.createElement("div");
    banner.className = "achievement-banner " + variant;
    banner.setAttribute("role", "status");
    banner.textContent = message;
    document.body.appendChild(banner);

    // Trigger the fade-out shortly before removal.
    window.setTimeout(() => banner.classList.add("leaving"), BANNER_DURATION);
    window.setTimeout(() => banner.remove(), BANNER_DURATION + 600);
  }

  // Main entry point. Called after a champion is marked (markedChamp set) or
  // after a bulk "Select all" (markedChamp = null → only the 100% path runs).
  function check(champions, progress, markedChamp) {
    if (!isEnabled() || !champions || !champions.length) return;

    const total = champions.length;
    const done = champions.filter((c) => progress[c.id]).length;

    if (done === total) {
      fireColorful();
      showBanner("🏆 100% complete — every champion mastered!", "complete");
      return; // grand finale wins over the letter cheer
    }

    if (markedChamp) {
      const letter = letterOf(markedChamp.name);
      const group = champions.filter((c) => letterOf(c.name) === letter);
      if (group.length && group.every((c) => progress[c.id])) {
        fireMono();
        showBanner(
          `✨ All champions starting with "${letter}" complete!`,
          "letter",
        );
      }
    }
  }

  return { isEnabled, check };
})();
