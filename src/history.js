// Progress history timeline (per-day completion chart).

// --- PROGRESS HISTORY (timeline) ---
const DAY_MS = 86400000;

function startOfLocalDay(date) {
  const d = new Date(date);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

function formatDay(ms, withYear = false) {
  const opts = { month: "short", day: "numeric" };
  if (withYear) opts.year = "numeric";
  return new Date(ms).toLocaleDateString(undefined, opts);
}

// Whole-number gridline step (1/2/5 × 10ⁿ) aiming for ~4 lines up to `max`.
function historyAxisStep(max) {
  const target = Math.max(1, max / 4);
  const pow = Math.pow(10, Math.floor(Math.log10(target)));
  for (const m of [1, 2, 5, 10]) {
    if (m * pow >= target) return m * pow;
  }
  return 10 * pow;
}

function getHistoryTooltip() {
  let tip = document.getElementById("history-tooltip");
  if (!tip) {
    tip = document.createElement("div");
    tip.id = "history-tooltip";
    tip.className = "history-tooltip";
    document.getElementById("history-box").appendChild(tip);
  }
  return tip;
}

function renderHistory() {
  const box = document.getElementById("history-box");
  const chart = document.getElementById("history-chart");
  const axis = document.getElementById("history-axis");
  const recent = document.getElementById("history-recent");
  const summary = document.getElementById("history-summary");
  if (!box || !chart || !axis || !recent || !summary) return;

  chart.innerHTML = "";
  axis.innerHTML = "";
  recent.innerHTML = "";
  summary.textContent = "";
  document.getElementById("history-tooltip")?.classList.remove("visible");

  const page = state.pages[state.activePage];
  const nameById = new Map(champions.map((c) => [c.id, c.name]));

  // Collect dated completions (value is an ISO timestamp string)
  const entries = [];
  for (const [champId, value] of Object.entries(page?.progress || {})) {
    if (typeof value !== "string") continue;
    const time = new Date(value).getTime();
    if (!Number.isNaN(time)) {
      entries.push({ name: nameById.get(champId) || champId, time });
    }
  }
  entries.sort((a, b) => a.time - b.time);

  if (entries.length === 0) {
    const empty = document.createElement("div");
    empty.className = "history-empty";
    empty.textContent =
      "No progress yet — champions you mark will show up here.";
    chart.appendChild(empty);
    return;
  }

  // Bucket by day; widen to week/month when the span gets long
  const firstDay = startOfLocalDay(entries[0].time);
  const today = startOfLocalDay(Date.now());
  const daySpan = Math.round((today - firstDay) / DAY_MS) + 1;
  let bucketDays = 1;
  let bucketLabel = "day";
  if (daySpan > 365) {
    bucketDays = 30;
    bucketLabel = "month";
  } else if (daySpan > 90) {
    bucketDays = 7;
    bucketLabel = "week";
  }
  const bucketCount = Math.ceil(daySpan / bucketDays);
  const buckets = Array.from({ length: bucketCount }, (_, i) => ({
    start: firstDay + i * bucketDays * DAY_MS,
    names: [],
  }));
  for (const entry of entries) {
    const dayIndex = Math.round(
      (startOfLocalDay(entry.time) - firstDay) / DAY_MS,
    );
    buckets[
      Math.min(Math.floor(dayIndex / bucketDays), bucketCount - 1)
    ].names.push(entry.name);
  }
  const maxCount = Math.max(...buckets.map((b) => b.names.length));

  // Running total per bucket — drives the cumulative line, the gridline
  // axis, and the "total" figure in the bar tooltips.
  let running = 0;
  const cumulative = buckets.map((b) => (running += b.names.length));
  const axisStep = historyAxisStep(entries.length);
  const axisMax = Math.ceil(entries.length / axisStep) * axisStep;

  summary.textContent = `${entries.length} marked since ${formatDay(
    firstDay,
    true,
  )}`;
  const legend = document.createElement("span");
  legend.className = "history-legend";
  const legendBar = document.createElement("span");
  legendBar.className = "legend-item legend-bar";
  legendBar.textContent = `per ${bucketLabel}`;
  const legendLine = document.createElement("span");
  legendLine.className = "legend-item legend-line";
  legendLine.textContent = "total";
  legend.appendChild(legendBar);
  legend.appendChild(legendLine);
  summary.appendChild(legend);

  // Gridlines (scaled to the cumulative axis, labeled on the right)
  const gridOverlay = document.createElement("div");
  gridOverlay.className = "history-grid";
  for (let value = axisStep; value <= axisMax; value += axisStep) {
    const line = document.createElement("div");
    line.className = "history-gridline";
    line.style.bottom = `${(value / axisMax) * 100}%`;
    const label = document.createElement("span");
    label.textContent = value;
    line.appendChild(label);
    gridOverlay.appendChild(line);
  }
  chart.appendChild(gridOverlay);

  // Cumulative line overlay (same axis as the gridlines)
  const svgNS = "http://www.w3.org/2000/svg";
  const svg = document.createElementNS(svgNS, "svg");
  svg.setAttribute("class", "history-cumulative");
  svg.setAttribute("viewBox", "0 0 100 100");
  svg.setAttribute("preserveAspectRatio", "none");
  svg.setAttribute("aria-hidden", "true");
  const polyline = document.createElementNS(svgNS, "polyline");
  const points = ["0,100"];
  cumulative.forEach((total, i) => {
    const x = ((i + 0.5) / bucketCount) * 100;
    const y = 100 - (total / axisMax) * 100;
    points.push(`${x.toFixed(2)},${y.toFixed(2)}`);
  });
  polyline.setAttribute("points", points.join(" "));
  polyline.setAttribute("vector-effect", "non-scaling-stroke");
  svg.appendChild(polyline);
  chart.appendChild(svg);

  // Bars
  const tip = getHistoryTooltip();
  const hideTip = () => tip.classList.remove("visible");
  buckets.forEach((bucket, bucketIndex) => {
    const slot = document.createElement("div");
    slot.className = "history-slot";
    const count = bucket.names.length;

    const rangeEnd = Math.min(bucket.start + (bucketDays - 1) * DAY_MS, today);
    const dateText =
      bucketDays === 1 || rangeEnd === bucket.start
        ? formatDay(bucket.start, true)
        : `${formatDay(bucket.start)} – ${formatDay(rangeEnd, true)}`;

    if (count > 0) {
      const bar = document.createElement("div");
      bar.className = "history-bar";
      bar.style.height = `${Math.max(
        6,
        Math.round((count / maxCount) * 100),
      )}%`;
      slot.appendChild(bar);
      slot.tabIndex = 0;
      slot.setAttribute(
        "aria-label",
        `${count} champion${count === 1 ? "" : "s"} on ${dateText}`,
      );

      const showTip = () => {
        tip.innerHTML = "";
        const value = document.createElement("strong");
        value.textContent = `${count} champion${count === 1 ? "" : "s"}`;
        tip.appendChild(value);
        const when = document.createElement("span");
        when.textContent = dateText;
        tip.appendChild(when);
        const totalEl = document.createElement("span");
        totalEl.className = "tooltip-total";
        totalEl.textContent = `${cumulative[bucketIndex]} total by then`;
        tip.appendChild(totalEl);
        const shown = bucket.names.slice(0, 6);
        const namesEl = document.createElement("span");
        namesEl.className = "tooltip-names";
        namesEl.textContent =
          shown.join(", ") +
          (count > shown.length ? ` +${count - shown.length} more` : "");
        tip.appendChild(namesEl);

        tip.classList.add("visible");
        const boxRect = box.getBoundingClientRect();
        const slotRect = slot.getBoundingClientRect();
        let left =
          slotRect.left -
          boxRect.left +
          slotRect.width / 2 -
          tip.offsetWidth / 2;
        left = Math.max(
          4,
          Math.min(left, box.clientWidth - tip.offsetWidth - 4),
        );
        tip.style.left = `${left}px`;
        tip.style.top = `${chart.offsetTop - tip.offsetHeight - 6}px`;
      };
      slot.addEventListener("pointerenter", showTip);
      slot.addEventListener("focus", showTip);
      slot.addEventListener("pointerleave", hideTip);
      slot.addEventListener("blur", hideTip);
    }
    chart.appendChild(slot);
  });

  // Axis: first and last bucket dates
  const startLabel = document.createElement("span");
  startLabel.textContent = formatDay(firstDay, true);
  const endLabel = document.createElement("span");
  endLabel.textContent = formatDay(today, true);
  axis.appendChild(startLabel);
  axis.appendChild(endLabel);

  // Recent activity (newest first) — keeps every value reachable without hover
  const recentTitle = document.createElement("div");
  recentTitle.className = "history-recent-title";
  recentTitle.textContent = "Recent";
  recent.appendChild(recentTitle);
  entries
    .slice(-8)
    .reverse()
    .forEach((entry) => {
      const row = document.createElement("div");
      row.className = "history-recent-row";
      const name = document.createElement("span");
      name.className = "recent-name";
      name.textContent = entry.name;
      const date = document.createElement("span");
      date.className = "recent-date";
      date.textContent = formatDay(entry.time, true);
      row.appendChild(name);
      row.appendChild(date);
      recent.appendChild(row);
    });
}
