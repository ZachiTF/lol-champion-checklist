// Screenshot scan — live screen capture (getDisplayMedia): the share session,
// the watching → reading → complete state machine, the preview canvas with its
// focus overlay, and the live controls. All per-share state lives in the one
// `live` object (see newLiveSession).

// ---- how it behaves ----
// Share the League window once and it auto-scans: it polls, retrying until it
// gets a complete read (bench + all 5 picks), pins that, and then stops scanning.
// After that it lightly watches for champion select to disappear and auto-drops
// the screen share when the game starts — so you never share during the game.
//
// With no LCU, the only "game started" signal is the pixels: champ select is no
// longer in the frame. That's reliable when you share the League WINDOW (it stays
// captured even when unfocused); when you share the whole SCREEN, "gone" is
// ambiguous with alt-tabbing, so there we also require a generous timer.
// Everything one share session owns, in one object. Stopping replaces it with a
// fresh one, so there is no list of fields to remember to reset by hand.
function newLiveSession() {
  return {
    stream: null,
    video: null, // frame source (kept live but hidden; the canvas is the preview)
    preview: null, // <canvas> showing the live frame + focus overlay
    grabCanvas: null, // reused by grabLiveFrame (see there)
    focus: null, // last read's boxes to stroke: { client, bench, circ }
    timer: null, // the single pending poll/watch timeout
    ticker: null, // 250ms interval that renders the "next check in Ns" line
    state: "idle", // idle | watching | reading | complete
    surface: "monitor", // "window" | "monitor" | "browser" (from the track)
    // Cached champ-select client rect — reused across polls (the frame is
    // pixel-stable), so we locate once and then do fast "tight" reads. Dropped
    // whenever a read comes back empty (window moved / champ select gone) to
    // force a re-locate.
    layout: null,
    // Temporal-consensus accumulator over the reading window (votes each slot
    // across frames). Reset whenever champ select goes missing so a fresh lobby
    // starts from a clean slate.
    agg: null,
    filledSlots: null, // bench slots that read as champions at the full read
    fullAt: 0, // when the full read landed (ms)
    goneSince: 0, // when champ select first went missing (ms), 0 = present
    nextCheckAt: 0, // when the next check is scheduled (ms) — drives the countdown
    checking: false, // true while a read is actually running (blocks the thread)
    history: [], // states we came from, most recent last: [{ state, at, why }]
    badStreak: 0, // consecutive frames whose layout failed verification
    watchPolls: 0, // watching-phase polls, for LIVE_RESCUE_EVERY
  };
}
let live = newLiveSession();

// ---- the live state machine ------------------------------------------------
// watching → reading → complete, plus an explicit way BACK. Going back is how the
// scanner recovers when it locked onto the wrong thing: re-entering an earlier
// state drops the caches the LATER states own, so the work is genuinely redone
// (back to "watching" drops the cached client rect, forcing a fresh full locate).
// Two things drive it: the automatic layout check (verifyLayout — a bench whose
// slots aren't all champions-or-empty means the window isn't where we think), and
// the user's "Start over" button when they can see it got something wrong.
const LIVE_FLOW = ["watching", "reading", "complete"];
// Bumped on every state change. A poll captures it before its first await and
// bails if it changed while the read was in flight — otherwise a read that
// started before "Start over" would land afterwards and undo it, which is
// exactly why the button looked like it did nothing. Deliberately NOT part of
// the session object: it must keep counting up across sessions, so a read from
// a stopped share can never match a new one's epoch.
let liveEpoch = 0;
const LIVE_VERIFY_STRIKES = 2; // fail this many in a row before stepping back —
// a single frame grabbed mid-animation can fail the check honestly.

// Entry actions. Each state resets what the states AFTER it derived, so entering
// an earlier state really does discard the later work rather than just relabel it.
function liveEnter(state) {
  live.state = state;
  live.badStreak = 0;
  liveEpoch++; // any read still in flight belongs to the old state — discard it
  if (state === "watching") {
    live.layout = null; // no cached client rect → next poll does a full locate
    live.agg = null;
    live.focus = null;
    live.filledSlots = null;
    live.goneSince = 0;
    scanSetStepStates(["done", "active", "pending", "pending"]);
  } else if (state === "reading") {
    // A fresh consensus every time we (re-)enter reading — otherwise coming back
    // from "complete" would re-finalize instantly off the old stable window.
    live.agg = createScanAggregator();
    live.filledSlots = null;
    live.goneSince = 0;
  }
}
// Move forward (or anywhere), remembering where we came from.
function liveSetState(next, why) {
  if (live.state === next) return;
  live.history.push({ state: live.state, at: Date.now(), why });
  if (live.history.length > 8) live.history.shift();
  liveEnter(next);
}
// Drop back to hunting for the window. Unlike liveSetState this re-runs the entry
// actions even when we're nominally already watching, so a rejected frame can't
// leave its cached rect or its focus overlay standing.
function liveRelocate(why) {
  if (live.state === "watching") liveEnter("watching");
  else liveSetState("watching", why);
}
// Step back one state and resume polling there. Repeated presses walk the ladder:
// complete → reading (re-read champion select) → watching (re-find the window).
function liveGoBack(why) {
  if (!live.video || live.state === "idle") return;
  const entry = live.history.pop();
  const prev =
    entry && entry.state !== "idle" && entry.state !== live.state
      ? entry.state
      : LIVE_FLOW[Math.max(0, LIVE_FLOW.indexOf(live.state) - 1)];
  liveEnter(prev);
  if (live.timer) {
    clearTimeout(live.timer);
    live.timer = null;
  }
  live.checking = false;
  scanSetStatus(
    prev === "watching"
      ? `Finding the League window again${why ? ` — ${why}` : ""}…`
      : `Reading champion select again${why ? ` — ${why}` : ""}…`,
  );
  scheduleNextCheck(prev === "complete" ? liveWatchTick : liveLoop, 150);
}

function liveIsSharing() {
  return !!live.video;
}
// The reader was switched mid-share. Restart the state machine at "watching":
// the cached client rect and the frame consensus both belong to the old reader.
// liveRelocate bumps the epoch, so a read already in flight lands as stale and
// is dropped.
function liveReaderChanged() {
  if (live.timer) {
    clearTimeout(live.timer);
    live.timer = null;
  }
  live.checking = false;
  liveRelocate("reader changed");
  scanSetStatus(
    `Watching for champion select with the ${scanReaderInfo().label} reader…`,
  );
  scheduleNextCheck(liveLoop, 150);
}

// Reads are cheap now (tight per-slot search, off-thread in a Web Worker), so we
// poll often and build a consensus from many frames rather than trusting one.
const LIVE_INTERVAL_MS = 600; // wait between reading-phase checks (shown as countdown)
const LIVE_WATCH_MS = 3000; // cheap "still in champ select?" re-check interval
// Looking for champion select polls several times a second, and most of those
// frames are not champion select at all. The locate stage's scale-ladder rescue
// (for a client that is not at the frame's own scale — see scan-aram.js) costs
// ~10x a cheap locate, so it runs on every Nth watching poll rather than all of
// them: unusual setups are still found within a few seconds, without pinning a
// core while someone is in a game.
const LIVE_RESCUE_EVERY = 5;
const LIVE_WINDOW_GONE_MS = 8000; // window share: gone this long → game started
const LIVE_SCREEN_GONE_MS = 15000; // screen share: gone this long (alt-tab tolerant)
const LIVE_SCREEN_MAX_MS = 120000; // screen share: hard cap after a full read

function stopLiveCapture() {
  if (live.timer) clearTimeout(live.timer);
  if (live.ticker) clearInterval(live.ticker);
  if (live.stream) live.stream.getTracks().forEach((t) => t.stop());
  if (live.video) live.video.srcObject = null;
  live = newLiveSession();
  liveEpoch++; // a read still in flight belongs to the stopped session — drop it
  // Nothing is running anymore — clear the checklist so its spinner stops turning.
  scanStepStates = null;
  scanRenderSteps();
}

// Draw the current live frame to a canvas → raw RGBA buffer, or null if not ready.
// The canvas is reused across polls: a fresh full-screen one every 600ms meant
// allocating (and then collecting) tens of MB of backing store on the main thread.
function grabLiveFrame() {
  if (!live.video || !live.video.videoWidth) return null;
  const w = live.video.videoWidth,
    h = live.video.videoHeight;
  if (!live.grabCanvas) live.grabCanvas = document.createElement("canvas");
  const canvas = live.grabCanvas;
  if (canvas.width !== w) canvas.width = w;
  if (canvas.height !== h) canvas.height = h;
  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  ctx.drawImage(live.video, 0, 0, w, h);
  return { buf: ctx.getImageData(0, 0, w, h).data, w, h };
}

async function startLiveCapture() {
  if (!navigator.mediaDevices || !navigator.mediaDevices.getDisplayMedia) {
    scanSetStatus("Live capture isn’t supported in this browser.", true);
    return;
  }
  try {
    live.stream = await navigator.mediaDevices.getDisplayMedia({
      // A few fps so each fast poll (~600ms) grabs a genuinely fresh frame — the
      // consensus wants independent frames, not the same one re-read. Champ select
      // is near-static, so this stays cheap.
      video: { frameRate: 5 },
      audio: false,
    });
  } catch (err) {
    scanSetStatus(
      err && err.name === "NotAllowedError"
        ? "Screen share was cancelled."
        : "Couldn’t start screen capture.",
      true,
    );
    return;
  }
  const track = live.stream.getVideoTracks()[0];
  live.surface =
    (track && track.getSettings && track.getSettings().displaySurface) ||
    "monitor";
  const video = document.createElement("video");
  video.className = "scan-live-video";
  video.muted = true;
  video.playsInline = true;
  video.srcObject = live.stream;
  await video.play().catch(() => {});
  live.video = video;
  lastScanImage = null; // live frames take over from any pasted screenshot
  // If the user stops sharing via the browser's own control, tear down cleanly.
  track?.addEventListener("ended", () => {
    stopLiveCapture();
    renderLiveControls(false);
    scanSetStatus("Screen sharing stopped.");
  });
  renderLiveControls(true);
  startLiveTicker();
  runLiveAuto();
}

// A light 250ms ticker that renders the cadence line: a countdown to the next
// check, or "Checking…" while one is running. (Replaces the old "Scan now" button
// — it shows WHEN the next automatic check happens instead of asking for a click.)
function startLiveTicker() {
  if (live.ticker) return;
  // ~4fps: matches the 5fps capture, so the canvas preview looks as smooth as the
  // raw video while letting us stroke the focus overlay on top of each frame.
  live.ticker = setInterval(() => {
    updateCadence();
    paintLivePreview();
  }, 250);
  updateCadence();
  paintLivePreview();
}

// Colors for the focus overlay, keyed by match verdict.
const FOCUS_COLORS = {
  accept: "#57e389",
  maybe: "#ffcf6b",
  reject: "rgba(255, 255, 255, 0.16)",
};
// Paint the current live frame into the preview canvas, then stroke what the
// scanner is focusing on: the located client rectangle (dashed) + every bench and
// team-circle box, colored by how confident the current match is. Everything is in
// captured-frame pixels and the canvas shares the frame's resolution, so the boxes
// line up with the video exactly (no letterbox math).
// The preview is never shown larger than a couple hundred CSS pixels, so backing
// it with a full 4K canvas (redrawn 4x/sec) was pure main-thread cost for pixels
// nobody sees. Cap the backing store and draw the overlay through a matching
// transform, so the boxes still line up and the picture looks identical.
const LIVE_PREVIEW_MAX_W = 900;
function paintLivePreview() {
  const cv = live.preview;
  if (!cv || !live.video || !live.video.videoWidth) return;
  const fw = live.video.videoWidth,
    fh = live.video.videoHeight;
  const sc = Math.min(1, LIVE_PREVIEW_MAX_W / fw); // frame px → canvas px
  const cw = Math.max(1, Math.round(fw * sc)),
    ch = Math.max(1, Math.round(fh * sc));
  if (cv.width !== cw) cv.width = cw;
  if (cv.height !== ch) cv.height = ch;
  const g = cv.getContext("2d");
  g.setTransform(1, 0, 0, 1, 0, 0);
  g.drawImage(live.video, 0, 0, cw, ch);
  const f = live.focus;
  if (!f || !f.client) return;
  g.setTransform(sc, 0, 0, sc, 0, 0); // everything below is in FRAME pixels
  const lw = Math.max(1.5, fw / 600) / sc; // constant on-screen stroke weight
  // Located client area.
  g.lineWidth = lw;
  g.setLineDash([lw * 4, lw * 3]);
  g.strokeStyle = "rgba(200, 155, 60, 0.85)";
  g.strokeRect(f.client.x, f.client.y, f.client.w, f.client.h);
  g.setLineDash([]);
  // Per-spot boxes, colored by verdict (empty/reject slots stay faint). Two marks:
  // the SOLID box is always the nominal grid cell (spot.cx/cy/size), so the overlay
  // tiles evenly on the bench pitch; the DASHED box, drawn only when the matcher's
  // winning crop (m.pos) drifted off that cell, shows where the icon actually
  // locked on. Keeping them separate turns the drift into readable information
  // instead of a box that straddles the neighbouring icon.
  const stroke = (list) => {
    for (const p of list || []) {
      const s = p.spot;
      if (!s) continue;
      const color = FOCUS_COLORS[p.verdict] || FOCUS_COLORS.reject;
      const gx = s.cx - s.size / 2,
        gy = s.cy - s.size / 2;
      g.strokeStyle = color;
      g.lineWidth = p.verdict === "reject" ? lw : lw * 1.7;
      g.setLineDash([]);
      g.strokeRect(gx, gy, s.size, s.size);
      const snap = p.verdict !== "reject" && p.m && p.m.pos;
      if (snap) {
        const drift =
          Math.abs(snap.x0 - gx) +
          Math.abs(snap.y0 - gy) +
          Math.abs(snap.size - s.size);
        if (drift > 1.5) {
          g.lineWidth = lw;
          g.setLineDash([lw * 3, lw * 2]);
          g.strokeRect(snap.x0, snap.y0, snap.size, snap.size);
          g.setLineDash([]);
        }
      }
    }
  };
  stroke(f.bench);
  stroke(f.circ);
}
function updateCadence() {
  const el = scanPanelEl()?.querySelector(".scan-live-next");
  if (!el) return;
  if (live.checking || !live.nextCheckAt) {
    el.textContent = live.checking ? "Checking…" : "";
    return;
  }
  const s = Math.max(0, Math.ceil((live.nextCheckAt - Date.now()) / 1000));
  el.textContent = s > 0 ? `Next check in ${s}s` : "Checking…";
}
// Schedule the next check `interval` ms out and reflect it in the countdown.
function scheduleNextCheck(fn, interval) {
  live.nextCheckAt = Date.now() + interval;
  live.timer = setTimeout(fn, interval);
  updateCadence();
}

// Prepare the DB once, then start polling for champion select.
async function runLiveAuto() {
  ensureScanPanel();
  scanBeginSteps();
  await nextPaint();
  scanStep(STEP_DB, "active");
  scanSetStatus("Preparing champion database…");
  await nextPaint();
  if (!(await ensureScanDb())) {
    scanStep(STEP_DB, "error");
    scanSetStatus("Couldn't load champion icons (offline?).", true);
    return;
  }
  if (!live.video) return; // sharing was stopped while the DB loaded
  ensureScanWorker(); // warm the worker (seed hashes) before the first poll
  live.history = [];
  liveEnter("watching");
  renderReaderSwitch();
  scanSetStatus(
    "Watching for champion select… open your ARAM lobby and it’ll read automatically.",
  );
  liveLoop();
}

// One poll: grab a frame, read it, fold it into the running consensus, and show
// the current best guess. Advances the state machine; finalizes only once the
// consensus is STABLE (all 5 picks settled across several frames), never on a
// single frame — that's what makes a transient misread unable to win.
async function liveLoop() {
  if (!live.video || (live.state !== "watching" && live.state !== "reading"))
    return;
  const epoch = liveEpoch; // this poll belongs to the state we start in
  live.checking = true;
  updateCadence();
  await nextPaint(); // let "Checking…" show before the read is dispatched
  if (epoch !== liveEpoch) return; // state changed under us — that poll owns it now
  const frame = grabLiveFrame();
  if (frame) {
    // Reuse the cached layout if we have one (fast tight reads); only pay for a
    // full locate when we don't. Runs in the Web Worker when available, so the UI
    // stays smooth during the first read and the watching-phase locates.
    const cached = !!live.layout;
    // A cached rect needs no locate at all; without one, pay for the full
    // search only every LIVE_RESCUE_EVERY polls.
    const rescue = !cached && live.watchPolls++ % LIVE_RESCUE_EVERY === 0;
    const res = await scanFrameAsync(frame.buf, frame.w, frame.h, {
      client: live.layout,
      tight: cached,
      rescue,
      // Sharing a single window means the captured surface IS champion select,
      // so the fixed template can skip looking for the client's own borders.
      frameIsClient: live.surface === "window",
    });
    // Sharing may have been stopped, or the user may have pressed Start over,
    // while the read was in flight. Either way this result is stale — drop it
    // without touching the state or scheduling a follow-up poll.
    if (
      !live.video ||
      epoch !== liveEpoch ||
      (live.state !== "watching" && live.state !== "reading")
    ) {
      live.checking = false;
      return;
    }
    if (!res.layout || (!res.ids.length && cached)) {
      // Nothing here — or a cached layout that stopped reading (window moved /
      // champ select ended). Going back to watching drops the cache + consensus.
      liveRelocate("champion select isn’t in the frame");
      scanSetStatus("Watching for champion select…");
    } else if (res.verify && !res.verify.ok) {
      // We found SOMETHING, but it doesn't hold together as an ARAM bench: every
      // slot should be a champion or an empty placeholder, left-packed. Usually
      // the League window isn't where we think it is (it moved under a cached
      // rect, or the locate stage latched onto other champion art on screen).
      // Don't let the frame vote, and step back to re-locate after a couple of
      // strikes — one bad frame can just be a mid-animation grab.
      live.badStreak++;
      live.focus = {
        client: res.layout,
        bench: res.benchSlots,
        circ: res.pickCircles,
      };
      paintLivePreview();
      if (live.badStreak >= LIVE_VERIFY_STRIKES) {
        liveRelocate(res.verify.reason);
        scanSetStatus(
          `That doesn’t look like champion select (${res.verify.reason}) — finding the League window again…`,
        );
      } else {
        scanSetStatus(`Checking the window is right (${res.verify.reason})…`);
      }
    } else {
      live.badStreak = 0;
      liveSetState("reading", "champion select found");
      if (res.ids.length) live.layout = res.layout; // cache a layout that reads
      // Update the live focus overlay from this frame's located area + boxes.
      live.focus = {
        client: res.layout,
        bench: res.benchSlots,
        circ: res.pickCircles,
      };
      paintLivePreview();
      // Fold this frame's per-position matches into the consensus, then read the
      // current aggregate — that (not the single frame) drives the UI.
      if (!live.agg) live.agg = createScanAggregator();
      aggregateFrame(live.agg, res.benchSlots, res.pickCircles);
      const agg = aggregateResult(live.agg);
      scanSetStepStates([
        "done",
        "done",
        agg.ids.length ? "done" : "active",
        agg.picksFilled >= 5 ? "done" : "active",
      ]);
      if (agg.ids.length) {
        // Show the running prediction every poll, uncertain ones flagged with the
        // alternatives they're being weighed against.
        scanState = {
          ids: agg.ids,
          uncertain: agg.uncertain,
          alternatives: agg.alternatives,
          confidence: agg.confidence,
          scores: agg.scores,
          active: true,
          finalized: agg.stable,
        };
        renderScanResults();
        if (agg.stable) {
          // Consensus locked — pin it, stop scanning, watch for game start.
          liveSetState("complete", "consensus stable");
          live.filledSlots = res.filledSlots;
          live.fullAt = Date.now();
          live.goneSince = 0;
          live.checking = false;
          const scope =
            live.surface === "window" ? "the League window" : "your screen";
          const nMaybe = agg.uncertain.size;
          scanSetStatus(
            `Champion select read ✓ — ${agg.ids.length} champions pinned below` +
              (nMaybe ? `, ${nMaybe} to double-check` : "") +
              `. Waiting for the game to start, then I’ll stop sharing ${scope}.`,
          );
          scheduleNextCheck(liveWatchTick, LIVE_WATCH_MS);
          return;
        }
        scanSetStatus(
          agg.picksFilled >= 5
            ? `All 5 picks in — confirming the read…`
            : `Reading champion select… ${agg.picksFilled}/5 picks locked, ` +
                `${agg.ids.length} champions so far.`,
        );
      } else {
        scanSetStatus("Champion select found — waiting for picks to lock in…");
      }
    }
  }
  live.checking = false;
  scheduleNextCheck(liveLoop, LIVE_INTERVAL_MS);
}

// Cheap "is champion select still on screen?" — re-check only the bench slots
// that were filled at the full read, instead of a full re-locate every tick.
function liveStillPresent(buf, w, h) {
  const slots = (live.filledSlots || []).slice(0, 6);
  let hits = 0;
  for (const slot of slots) {
    const m = matchSlot(buf, w, h, slot, iconHashes.byId, { tight: true });
    if (m && classifyMatch(m) !== "reject") hits++;
    if (hits >= 2) return true;
  }
  return false;
}

// After a full read: watch for champion select to vanish, then drop the share.
async function liveWatchTick() {
  if (!live.video || live.state !== "complete") return;
  const epoch = liveEpoch;
  live.checking = true;
  updateCadence();
  await nextPaint();
  if (!live.video || epoch !== liveEpoch || live.state !== "complete") return;
  const frame = grabLiveFrame();
  const present = frame ? liveStillPresent(frame.buf, frame.w, frame.h) : false;
  const now = Date.now();
  if (present) live.goneSince = 0;
  else if (!live.goneSince) live.goneSince = now;

  const goneFor = live.goneSince ? now - live.goneSince : 0;
  const elapsed = now - live.fullAt;
  const stop =
    live.surface === "window"
      ? goneFor >= LIVE_WINDOW_GONE_MS
      : goneFor >= LIVE_SCREEN_GONE_MS || elapsed >= LIVE_SCREEN_MAX_MS;

  if (stop) {
    const scope =
      live.surface === "window" ? "the League window" : "your screen";
    stopLiveCapture();
    renderLiveControls(false);
    scanSetStatus(
      `Game started — stopped sharing ${scope}. Your champions are still pinned below.`,
    );
    return;
  }
  live.checking = false;
  scheduleNextCheck(liveWatchTick, LIVE_WATCH_MS);
}

// (Re)build the live-capture controls inside the panel's .scan-live slot.
function renderLiveControls(active) {
  const wrap = scanPanelEl()?.querySelector(".scan-live");
  if (!wrap) return;
  wrap.innerHTML = "";
  if (active && live.video) {
    // The <video> is only a frame source now; the canvas is the visible preview
    // (so we can stroke the focus overlay on top with exact pixel alignment).
    live.video.className = "scan-live-source";
    const stage = document.createElement("div");
    stage.className = "scan-live-stage";
    const preview = document.createElement("canvas");
    preview.className = "scan-live-canvas";
    stage.appendChild(live.video);
    stage.appendChild(preview);
    live.preview = preview;
    wrap.appendChild(stage);
    paintLivePreview();
    // Cadence line where the old "Scan now" button was: shows when the next
    // automatic check runs, so it's clear the scanner is working on its own.
    const next = document.createElement("span");
    next.className = "scan-live-next";
    // Manual counterpart to the automatic layout check: if you can see it read
    // the wrong thing, walk the state machine back a step. Press again to go
    // further back (re-read champion select → re-find the League window).
    const back = document.createElement("button");
    back.className = "scan-action scan-live-back";
    back.textContent = "↩ Start over";
    back.title =
      "Go back a step: re-read champion select, or (again) re-find the League window";
    back.onclick = () => liveGoBack("you asked to start over");
    const stop = document.createElement("button");
    stop.className = "scan-action";
    stop.textContent = "Stop sharing";
    stop.onclick = () => {
      stopLiveCapture();
      renderLiveControls(false);
      scanSetStatus("Screen sharing stopped.");
    };
    const row = document.createElement("div");
    row.className = "scan-live-row";
    row.appendChild(next);
    row.appendChild(back);
    row.appendChild(stop);
    wrap.appendChild(row);
    updateCadence();
  } else {
    const start = document.createElement("button");
    start.className = "scan-live-start";
    start.textContent = "📹 Read live from your screen";
    start.onclick = startLiveCapture;
    wrap.appendChild(start);
  }
}
