/* ============================================================
   APEX KARTING LEAGUE — championship engine
   Vanilla JS. No dependencies. No build step.
   Reads live from Firestore (window.db/window.fb, set up by
   firebase-init.js) — see initFirestoreListeners() below.
   ============================================================ */

/* ---------- lap-time helpers ---------- */

// Accepts "mm:ss.mmm", "m:ss.mmm", "ss.mmm", or a raw millisecond number.
function parseLap(s) {
  if (s == null) return null;
  if (typeof s === "number") return s;
  s = String(s).trim().replace(",", ".");
  if (!s) return null;
  let ms;
  if (s.includes(":")) {
    const parts = s.split(":");
    const secPart = parseFloat(parts.pop());
    const mins = parseInt(parts.pop() || "0", 10);
    const hours = parts.length ? parseInt(parts.pop(), 10) : 0;
    ms = ((hours * 60 + mins) * 60 + secPart) * 1000;
  } else {
    ms = parseFloat(s) * 1000;
  }
  return isNaN(ms) ? null : Math.round(ms);
}

// Millis back to a readable lap string. Karts are usually sub-minute.
function formatLap(ms) {
  if (ms == null || isNaN(ms)) return "—";
  const totalSec = ms / 1000;
  const mins = Math.floor(totalSec / 60);
  const secs = totalSec - mins * 60;
  const secStr = secs.toFixed(3).padStart(6, "0");
  return mins > 0 ? `${mins}:${secStr}` : secStr;
}

/* ---------- misc helpers ---------- */

// Everything rendered here ultimately comes from Firestore, which anyone
// with edit access (or the Editor tab) can put arbitrary text into — a
// driver's name, quote, team, etc. Firestore's rules control WHO can write,
// not WHAT — there's no server-side sanitization of the content itself, so
// every such string must be escaped on the way to innerHTML, or a stray "<"
// turns into stored XSS that runs in every visitor's browser. Used for both
// HTML text and inside double-quoted attributes (it escapes '"' too, so it
// also blocks attribute-breakout).
function escapeHtml(s) {
  return String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
}

// "GB" -> 🇬🇧. Returns "" for anything that isn't a 2-letter code.
function flagEmoji(code) {
  if (!code || typeof code !== "string" || code.length !== 2) return "";
  const A = 0x1f1e6;
  return String.fromCodePoint(
    ...[...code.toUpperCase()].map((c) => A + (c.charCodeAt(0) - 65))
  );
}

// Signed seconds, e.g. +0.18s / −0.00s.
function formatDelta(ms) {
  if (ms == null || isNaN(ms)) return "—";
  const sign = ms > 0 ? "+" : ms < 0 ? "−" : "±";
  return `${sign}${Math.abs(ms / 1000).toFixed(2)}s`;
}

/* ---------- data loading (Firestore, live) ----------
   data/season.json is no longer fetched at runtime — Firestore is the
   source of truth, kept live via onSnapshot listeners so an allowlisted
   edit in the Editor (in ANY browser) shows up here immediately, not just
   after an export/import/commit cycle. window.db/window.fb come from
   firebase-init.js (a <script type="module">, loaded before this file's
   DOMContentLoaded-triggered init() ever runs — see that file's header
   comment for why the ordering is safe). */

// Standings/movement are computed by walking data.rounds in array order, so
// an out-of-order edit (manual or via the Editor tab) would silently corrupt
// them without this — sort once before anything reads the data.
function sortRoundsByDate(data) {
  if (Array.isArray(data.rounds)) {
    data.rounds.sort((a, b) => {
      const da = a.date || "";
      const db = b.date || "";
      if (da !== db) return da < db ? -1 : 1;
      const ta = a.time || "";
      const tb = b.time || "";
      return ta < tb ? -1 : ta > tb ? 1 : 0;
    });
  }
  return data;
}

// Defaults for the config/season doc, matching the old season.json shape.
// Used in-memory if that doc doesn't exist yet — editor.js seeds it for
// real (see ensureConfigDoc there) once an allowlisted user opens the
// Editor tab, so a brand-new project needs no manual Firestore setup.
// var (not const), same reasoning as the old EDITOR_DRAFT_KEY it replaces —
// guaranteed to land on window so editor.js can read it by name too.
var DEFAULT_CONFIG = {
  championship: "APEX KARTING LEAGUE",
  season: "",
  tagline: "",
  scoring: { points: [25, 18, 15, 12, 10, 8, 6, 4, 2, 1], fastestLapBadge: true },
  physics: { weightStepKg: 10, penaltySec: 0.1, refWeightKg: null },
};

// Latest snapshot of each Firestore source, assembled into the same
// season-shaped object the rest of this file (and editor.js) already
// expects. `ready` gates the first render until all four have reported at
// least once — Firestore's onSnapshot fires almost immediately even
// offline (served from its local cache), so this is a brief gate, not a
// real wait.
const FS = {
  config: null,
  drivers: [],
  tracks: [],
  rounds: [],
  ready: { config: false, drivers: false, tracks: false, rounds: false },
  offline: false,
};

function currentDataFromFirestore() {
  return sortRoundsByDate({
    ...DEFAULT_CONFIG,
    ...(FS.config || {}),
    drivers: FS.drivers,
    tracks: FS.tracks,
    rounds: FS.rounds.map((r) => ({ ...r })),
  });
}

let firstRenderDone = false;

function rebuildAndRender() {
  if (!(FS.ready.config && FS.ready.drivers && FS.ready.tracks && FS.ready.rounds)) return;
  renderPublicViews(currentDataFromFirestore());
  renderConnectionStatus(FS.offline);
  if (!firstRenderDone) {
    firstRenderDone = true;
    $("#app").classList.add("ready");
  }
  // Lets editor.js refresh its own list views (driver/track/round lists,
  // dropdowns) whenever the underlying data changes, from any source —
  // this browser's own edit, or someone else's, live.
  window.dispatchEvent(new CustomEvent("apex-data-changed"));
}

function initFirestoreListeners() {
  if (!window.db || !window.fb) {
    showError("Firebase failed to load — check your connection and reload.");
    return;
  }
  const { doc, collection, onSnapshot } = window.fb;
  const db = window.db;

  const onErr = (name) => (err) => {
    console.error(`${name} listener failed`, err);
    FS.ready[name] = true;
    rebuildAndRender();
  };

  onSnapshot(
    doc(db, "config", "season"),
    (snap) => {
      FS.config = snap.exists() ? snap.data() : DEFAULT_CONFIG;
      FS.offline = snap.metadata.fromCache;
      FS.ready.config = true;
      rebuildAndRender();
    },
    onErr("config")
  );

  [
    ["drivers", (arr) => (FS.drivers = arr)],
    ["tracks", (arr) => (FS.tracks = arr)],
    ["rounds", (arr) => (FS.rounds = arr)],
  ].forEach(([name, assign]) => {
    onSnapshot(
      collection(db, name),
      (snap) => {
        assign(snap.docs.map((d) => ({ id: d.id, ...d.data() })));
        FS.offline = FS.offline || snap.metadata.fromCache;
        FS.ready[name] = true;
        rebuildAndRender();
      },
      onErr(name)
    );
  });
}

/* ---------- championship maths ---------- */

// Score a single round: rank by fastest lap, assign position, points, FL flag.
function scoreRound(round, points) {
  const entries = (round.laps || [])
    .map((l) => ({ driver: l.driver, ms: parseLap(l.best), kart: l.kart }))
    .filter((e) => e.ms != null)
    .sort((a, b) => a.ms - b.ms);

  entries.forEach((e, i) => {
    e.position = i + 1;
    e.points = i < points.length ? points[i] : 0;
    e.fastestLap = i === 0; // outright quickest of the round earns the FL badge
  });
  return entries;
}

// Cumulative standings after the first `count` rounds. Returns ordered ids.
function standingsUpTo(data, count) {
  const points = data.scoring.points;
  const totals = {};
  data.drivers.forEach((d) => (totals[d.id] = { pts: 0, positions: [], best: null }));

  for (let r = 0; r < count; r++) {
    scoreRound(data.rounds[r], points).forEach((e) => {
      const t = totals[e.driver];
      if (!t) return;
      t.pts += e.points;
      t.positions.push(e.position);
      if (t.best == null || e.ms < t.best) t.best = e.ms;
    });
  }

  return data.drivers
    .map((d) => ({ id: d.id, ...totals[d.id] }))
    .sort((a, b) => tieBreak(a, b));
}

// F1-style countback: points, then most wins, then most 2nds, 3rds..., then fastest lap.
function tieBreak(a, b) {
  if (b.pts !== a.pts) return b.pts - a.pts;
  const maxPos = Math.max(
    a.positions.length ? Math.max(...a.positions) : 0,
    b.positions.length ? Math.max(...b.positions) : 0
  );
  for (let p = 1; p <= maxPos; p++) {
    const ca = a.positions.filter((x) => x === p).length;
    const cb = b.positions.filter((x) => x === p).length;
    if (ca !== cb) return cb - ca; // more of the better position wins
  }
  if (a.best != null && b.best != null && a.best !== b.best) return a.best - b.best;
  if (a.best != null && b.best == null) return -1;
  if (b.best != null && a.best == null) return 1;
  return 0;
}

/* ---------- weight maths ----------
   Karting rule of thumb: every extra `weightStepKg` over the reference
   weight costs `penaltySec` on a lap. Reference is either a fixed number
   (physics.refWeightKg) or, by default, the lightest driver in the field —
   so the lightest driver always shows 0 and everyone else shows their
   handicap relative to them. */

function referenceWeightKg(data) {
  const phys = data.physics || {};
  if (phys.refWeightKg != null) return phys.refWeightKg;
  const weights = data.drivers.map((d) => d.weightKg).filter((w) => w != null);
  return weights.length ? Math.min(...weights) : null;
}

// Extra milliseconds a driver's weight costs them per lap vs the reference.
function weightPenaltyMs(data, weightKg) {
  const ref = referenceWeightKg(data);
  if (weightKg == null || ref == null) return null;
  const phys = data.physics || {};
  const step = phys.weightStepKg || 10;
  const penalty = phys.penaltySec != null ? phys.penaltySec : 0.1;
  return ((weightKg - ref) / step) * penalty * 1000;
}

// Full-season table with per-driver stats + movement vs previous round.
function buildChampionship(data) {
  const points = data.scoring.points;
  const rounds = data.rounds;
  const stats = {};
  data.drivers.forEach((d) => {
    stats[d.id] = {
      driver: d,
      pts: 0,
      wins: 0,
      podiums: 0,
      rounds: 0,
      best: null,
      positions: [],
      form: [], // finishing positions, oldest→newest
    };
  });

  rounds.forEach((round) => {
    scoreRound(round, points).forEach((e) => {
      const s = stats[e.driver];
      if (!s) return;
      s.pts += e.points;
      s.rounds += 1;
      s.positions.push(e.position);
      s.form.push(e.position);
      if (e.position === 1) s.wins += 1;
      if (e.position <= 3) s.podiums += 1;
      if (s.best == null || e.ms < s.best) s.best = e.ms;
    });
  });

  const table = data.drivers.map((d) => stats[d.id]);
  table.sort((a, b) =>
    tieBreak(
      { pts: a.pts, positions: a.positions, best: a.best },
      { pts: b.pts, positions: b.positions, best: b.best }
    )
  );

  // movement: compare last two cumulative snapshots
  let movement = {};
  if (rounds.length >= 2) {
    const prev = standingsUpTo(data, rounds.length - 1).map((x) => x.id);
    const curr = standingsUpTo(data, rounds.length).map((x) => x.id);
    curr.forEach((id, i) => {
      const was = prev.indexOf(id);
      movement[id] = was === -1 ? 0 : was - i; // +ve = climbed
    });
  }

  table.forEach((row, i) => {
    row.rank = i + 1;
    row.move = movement[row.driver.id] || 0;
    row.weightDelta = weightPenaltyMs(data, row.driver.weightKg);
    // "Pace-adjusted" best: strip out the weight handicap to see who was
    // actually quickest underneath the ballast. Lightest driver's own
    // best is untouched (their delta is 0).
    row.adjustedBest =
      row.best != null && row.weightDelta != null ? row.best - row.weightDelta : row.best;
  });

  // season fastest lap trophy
  let flHolder = null;
  table.forEach((row) => {
    if (row.best != null && (flHolder == null || row.best < flHolder.best)) {
      flHolder = { id: row.driver.id, best: row.best };
    }
  });

  return { table, flHolder, rounds: rounds.length };
}

/* ---------- rendering ---------- */

// The last data/champ rendered — kept so the poster modal (opened via
// event delegation, long after the initial render) always uses whatever's
// currently on screen, not a stale copy from page load. editor.js reads
// currentData directly (e.g. for its delete/rename referential-integrity
// checks) instead of keeping its own copy — one live source of truth. var
// (not let), same reasoning as DEFAULT_CONFIG/EDITOR_DRAFT_KEY before it —
// guaranteed to land on window for cross-script use.
var currentData = null;
var currentChamp = null;

const $ = (sel, root = document) => root.querySelector(sel);
const el = (tag, cls, html) => {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (html != null) n.innerHTML = html;
  return n;
};
const ordinal = (n) => {
  const s = ["TH", "ST", "ND", "RD"];
  const v = n % 100;
  return n + (s[(v - 20) % 10] || s[v] || s[0]);
};

function starRating(rank, total) {
  const ratio = total > 1 ? (total - rank) / (total - 1) : 1; // 0..1
  return 1 + ratio * 4; // 1..5
}
function starsMarkup(value) {
  const full = Math.floor(value);
  const half = value - full >= 0.5;
  let out = "";
  for (let i = 0; i < 5; i++) {
    if (i < full) out += '<span class="star on">★</span>';
    else if (i === full && half) out += '<span class="star half">★</span>';
    else out += '<span class="star">★</span>';
  }
  return out;
}

// F1-game-style attribute bar, e.g. { label: "Pace", value: 84 } on a 0–99 scale.
function statBarMarkup(label, value) {
  const v = Math.max(0, Math.min(99, value || 0));
  return `
    <div class="stat-row">
      <span class="stat-label">${label}</span>
      <span class="stat-track"><span class="stat-fill" style="width:${v}%"></span></span>
      <span class="stat-val mono">${value != null ? value : "—"}</span>
    </div>`;
}

function statsMarkup(stats) {
  if (!stats) return "";
  const labels = { pace: "Pace", racecraft: "Racecraft", awareness: "Awareness", experience: "Experience" };
  return Object.keys(labels)
    .filter((k) => stats[k] != null)
    .map((k) => statBarMarkup(labels[k], stats[k]))
    .join("");
}

// Driver photo with a graceful fallback to their abbreviation if the image
// is missing or hasn't been dropped into assets/drivers/ yet.
function photoMarkup(d, cls) {
  const img = d.photo
    ? `<img src="${escapeHtml(d.photo)}" alt="" loading="lazy" onerror="this.remove()">`
    : "";
  return `<span class="${cls}"><span class="photo-fallback">${escapeHtml(d.abbr)}</span>${img}</span>`;
}

// Look up a round's track + layout by id. Degrades gracefully (nulls) if
// either reference is missing or dangling, so a bad hand-edit of season.json
// never crashes this tab.
function resolveTrackLayout(data, round) {
  const track = (data.tracks || []).find((t) => t.id === round.trackId) || null;
  const layout =
    track && round.layoutId ? (track.layouts || []).find((l) => l.id === round.layoutId) || null : null;
  return {
    trackName: track ? track.name : null,
    layoutName: layout ? layout.name : null,
    image: layout ? layout.image : null,
  };
}

// Track layout drawing — same graceful onerror fallback idiom as photoMarkup.
// No abbreviation fallback here since a track has no natural short label.
function layoutImageMarkup(image, alt, cls) {
  if (!image) return "";
  const clsAttr = cls ? ` class="${cls}"` : "";
  return `<img${clsAttr} src="${escapeHtml(image)}" alt="${escapeHtml(alt)}" loading="lazy" onerror="this.remove()">`;
}

function renderHero(data, champ) {
  $("#season-eyebrow").textContent = `${data.season} SEASON · ${champ.rounds} ROUND${champ.rounds === 1 ? "" : "S"}`;
  $("#champ-title").textContent = data.championship;
  $("#champ-tagline").textContent = data.tagline || "";

  const leader = champ.table[0];
  const fl = champ.flHolder ? data.drivers.find((d) => d.id === champ.flHolder.id) : null;
  const ledgeEl = $("#leader-ledge");
  if (leader) {
    ledgeEl.style.setProperty("--accent", leader.driver.color);
    ledgeEl.innerHTML = `
      <div class="ledge-label">Championship leader</div>
      <div class="ledge-name">${escapeHtml(leader.driver.name)}</div>
      <div class="ledge-meta">${escapeHtml(leader.driver.team)} · <strong>${leader.pts} pts</strong></div>`;
  }
  const flEl = $("#fl-ledge");
  if (fl && champ.flHolder) {
    flEl.style.setProperty("--accent", fl.color);
    flEl.innerHTML = `
      <div class="ledge-label">Fastest lap of the season</div>
      <div class="ledge-name">${escapeHtml(fl.name)}</div>
      <div class="ledge-meta mono">${formatLap(champ.flHolder.best)}</div>`;
  }
}

function renderPodium(data, champ) {
  const wrap = $("#podium");
  wrap.innerHTML = "";
  const top3 = champ.table.slice(0, 3);
  const order = [1, 0, 2]; // visual: P2 left, P1 centre, P3 right
  order.forEach((idx) => {
    const row = top3[idx];
    if (!row) return;
    const card = el("button", `podium-card p${row.rank}`);
    card.style.setProperty("--accent", row.driver.color);
    card.setAttribute("data-driver", row.driver.id);
    card.setAttribute("aria-label", `${row.driver.name}, position ${row.rank}`);
    card.innerHTML = `
      <div class="podium-pos">P${row.rank}</div>
      <div class="podium-num">${row.driver.number}</div>
      ${photoMarkup(row.driver, "podium-avatar")}
      <div class="podium-body">
        <div class="podium-abbr">${escapeHtml(row.driver.abbr)}</div>
        <div class="podium-name">${escapeHtml(row.driver.name)}</div>
        <div class="podium-team">${escapeHtml(row.driver.team)}</div>
      </div>
      <div class="podium-pts"><span>${row.pts}</span><small>PTS</small></div>`;
    wrap.appendChild(card);
  });
}

function renderStandings(data, champ) {
  const body = $("#standings-body");
  body.innerHTML = "";
  champ.table.forEach((row, i) => {
    const isFL = champ.flHolder && champ.flHolder.id === row.driver.id;
    const r = el("button", "srow");
    r.style.setProperty("--accent", row.driver.color);
    r.style.setProperty("--i", i);
    r.setAttribute("data-driver", row.driver.id);
    if (row.rank === 1) r.classList.add("leader");

    let moveMark = '<span class="move flat">–</span>';
    if (row.move > 0) moveMark = `<span class="move up">▲${row.move}</span>`;
    else if (row.move < 0) moveMark = `<span class="move down">▼${Math.abs(row.move)}</span>`;

    r.innerHTML = `
      <span class="s-pos">${row.rank}</span>
      <span class="s-move">${moveMark}</span>
      <span class="s-tab"></span>
      <span class="s-driver">
        ${photoMarkup(row.driver, "s-avatar")}
        <span class="s-driver-text">
          <span class="s-name">${escapeHtml(row.driver.name)}</span>
          <span class="s-team">${escapeHtml(row.driver.team)}${isFL ? '<span class="fl-chip">FL</span>' : ""}</span>
        </span>
      </span>
      <span class="s-stat s-rounds"><b>${row.rounds}</b><small>RND</small></span>
      <span class="s-stat s-wins"><b>${row.wins}</b><small>WIN</small></span>
      <span class="s-stat s-best mono">${formatLap(row.best)}<small>BEST</small></span>
      <span class="s-pts">${row.pts}</span>`;
    body.appendChild(r);
  });
}

function renderRounds(data) {
  const wrap = $("#rounds");
  wrap.innerHTML = "";
  const points = data.scoring.points;
  const byId = Object.fromEntries(data.drivers.map((d) => [d.id, d]));

  [...data.rounds].reverse().forEach((round, ri) => {
    const scored = scoreRound(round, points);
    const winner = scored[0] ? byId[scored[0].driver] : null;
    const card = el("div", "round-card");
    if (winner) card.style.setProperty("--accent", winner.color);

    const { trackName, layoutName, image } = resolveTrackLayout(data, round);

    const dateStr = round.date
      ? new Date(round.date + "T00:00:00").toLocaleDateString(undefined, {
          day: "numeric",
          month: "short",
          year: "numeric",
        })
      : "";
    const whenStr = [dateStr, round.time].filter(Boolean).join(" · ");

    // Best kart of the round: whoever set the fastest lap was P1, so their
    // kart is the one everyone will be asking about afterwards.
    const bestKart = scored[0] && scored[0].kart != null ? scored[0].kart : null;

    const attendeeIds =
      round.attendees && round.attendees.length
        ? round.attendees
        : (round.laps || []).map((l) => l.driver);
    const attendees = [...new Set(attendeeIds)].map((id) => byId[id]).filter(Boolean);

    const head = el("button", "round-head");
    head.setAttribute("aria-expanded", ri === 0 ? "true" : "false");
    head.innerHTML = `
      <span class="round-index">R${data.rounds.length - ri}</span>
      <span class="round-titles">
        <span class="round-name">${escapeHtml(round.name || trackName || "Round")}</span>
        <span class="round-sub">${escapeHtml([trackName, whenStr].filter(Boolean).join(" · "))}</span>
      </span>
      <span class="round-winner">${winner ? `<small>WON BY</small>${escapeHtml(winner.abbr)}` : ""}</span>
      <span class="round-chevron">▾</span>`;

    const list = el("div", "round-results" + (ri === 0 ? " open" : ""));
    const inner = el("div", "round-results-inner");

    if (layoutName || image || bestKart != null) {
      const meta = el("div", "round-meta");
      meta.innerHTML = `
        ${
          layoutName || image
            ? `<div class="round-layout">
                ${layoutImageMarkup(image, layoutName || "Track layout")}
                <span class="round-layout-name">${layoutName ? `Layout: ${escapeHtml(layoutName)}` : ""}</span>
              </div>`
            : ""
        }
        ${bestKart != null ? `<div class="best-kart-badge">Best kart <b>#${bestKart}</b></div>` : ""}`;
      inner.appendChild(meta);
    }

    if (attendees.length) {
      const att = el("div", "round-attendees");
      att.innerHTML = `<small>ATTENDED (${attendees.length})</small> ${attendees
        .map((d) => `<span class="attend-chip" style="--accent:${escapeHtml(d.color)}">${escapeHtml(d.abbr)}</span>`)
        .join("")}`;
      inner.appendChild(att);
    }

    scored.forEach((e) => {
      const d = byId[e.driver];
      if (!d) return;
      const line = el("div", "result-line");
      line.style.setProperty("--accent", d.color);
      line.innerHTML = `
        <span class="rl-pos">${e.position}</span>
        <span class="rl-tab"></span>
        <span class="rl-name">${escapeHtml(d.name)}${e.fastestLap ? '<span class="fl-chip">FL</span>' : ""}</span>
        <span class="rl-kart mono">${e.kart != null ? `#${e.kart}` : ""}</span>
        <span class="rl-time mono">${formatLap(e.ms)}</span>
        <span class="rl-pts">+${e.points}</span>`;
      inner.appendChild(line);
    });
    list.appendChild(inner);

    head.addEventListener("click", () => {
      const open = list.classList.toggle("open");
      head.setAttribute("aria-expanded", String(open));
    });

    card.appendChild(head);
    card.appendChild(list);
    wrap.appendChild(card);
  });
}

function renderDrivers(data, champ) {
  const wrap = $("#drivers-grid");
  wrap.innerHTML = "";
  champ.table.forEach((row) => {
    const d = row.driver;
    const flag = flagEmoji(d.countryCode);
    const card = el("button", "driver-chip");
    card.style.setProperty("--accent", d.color);
    card.setAttribute("data-driver", d.id);
    card.innerHTML = `
      <span class="chip-num-bg">${d.number}</span>
      ${photoMarkup(d, "chip-photo")}
      <span class="chip-body">
        <span class="chip-name">${escapeHtml(d.name)}${flag ? ` <span class="chip-flag">${flag}</span>` : ""}</span>
        <span class="chip-team">#${d.number} · ${escapeHtml(d.team)}</span>
      </span>
      <span class="chip-rank">P${row.rank}</span>`;
    wrap.appendChild(card);
  });
}

/* ---------- driver poster modal ---------- */

function openPoster(data, champ, id) {
  const row = champ.table.find((r) => r.driver.id === id);
  if (!row) return;
  const d = row.driver;
  const total = champ.table.length;
  const stars = starRating(row.rank, total);
  const isChampLeader = row.rank === 1;
  const isFL = champ.flHolder && champ.flHolder.id === id;

  const modal = $("#poster-modal");
  const stage = $("#poster-stage");
  stage.style.setProperty("--accent", d.color);
  stage.className = "poster" + (isChampLeader ? " is-leader" : "") + (d.photo ? " has-avatar" : "");

  const formMarkup = row.form
    .slice(-5)
    .map((p) => `<span class="form-pip p${p <= 3 ? p : "x"}">${p}</span>`)
    .join("");

  const surname = escapeHtml(d.name.split(" ").slice(-1)[0].toUpperCase());
  const firstname = escapeHtml(d.name.split(" ").slice(0, -1).join(" ").toUpperCase());
  const flag = flagEmoji(d.countryCode);

  const physiqueBits = [
    d.country ? `${flag} ${escapeHtml(d.country)}` : "",
    d.age != null ? `${d.age} yrs` : "",
    d.heightCm != null ? `${d.heightCm}cm` : "",
    d.weightKg != null ? `${d.weightKg}kg` : "",
  ].filter(Boolean);

  const weightBlock =
    row.weightDelta != null
      ? `<div class="poster-weight">
          <span class="pw-badge">${formatDelta(row.weightDelta)}<small>/LAP VS LIGHTEST</small></span>
          ${
            row.best != null
              ? `<span class="pw-adjusted">pace-adjusted best <b class="mono">${formatLap(row.adjustedBest)}</b></span>`
              : ""
          }
        </div>`
      : "";

  stage.innerHTML = `
    <div class="poster-topline">
      <span class="poster-badge">${isChampLeader ? "CHAMPIONSHIP LEADER" : ordinal(row.rank) + " OVERALL"}</span>
      <span class="poster-logo">${escapeHtml(d.abbr)}</span>
    </div>
    <div class="poster-first">${firstname}</div>
    <div class="poster-surname">${surname}</div>
    <div class="poster-number">${d.number}</div>
    ${photoMarkup(d, "poster-avatar")}
    <div class="poster-team">${escapeHtml(d.team)}</div>
    ${physiqueBits.length ? `<div class="poster-physique">${physiqueBits.join(" · ")}</div>` : ""}
    ${d.style ? `<div class="poster-style">${escapeHtml(d.style)}</div>` : ""}
    ${weightBlock}
    ${d.stats ? `<div class="poster-attrs">${statsMarkup(d.stats)}</div>` : ""}
    <div class="poster-quote">${d.quote ? `“${escapeHtml(d.quote)}”` : ""}</div>
    <div class="poster-stats">
      <div class="pstat"><b>${row.pts}</b><small>POINTS</small></div>
      <div class="pstat"><b>${row.wins}</b><small>WINS</small></div>
      <div class="pstat"><b>${row.podiums}</b><small>PODIUMS</small></div>
      <div class="pstat"><b class="mono">${formatLap(row.best)}</b><small>BEST LAP${isFL ? " ·" : ""}</small></div>
    </div>
    <div class="poster-foot">
      <div class="poster-stars">${starsMarkup(stars)}</div>
      <div class="poster-form">${row.form.length ? '<small>FORM</small>' + formMarkup : ""}</div>
    </div>`;

  modal.classList.add("open");
  modal.setAttribute("aria-hidden", "false");
  $("#poster-close").focus();
}

function closePoster() {
  const modal = $("#poster-modal");
  modal.classList.remove("open");
  modal.setAttribute("aria-hidden", "true");
}

/* ---------- wiring ---------- */

function wireTabs() {
  const tabs = document.querySelectorAll(".tab");
  const panels = document.querySelectorAll(".panel");
  tabs.forEach((tab) => {
    tab.addEventListener("click", () => {
      tabs.forEach((t) => t.classList.remove("active"));
      panels.forEach((p) => p.classList.remove("active"));
      tab.classList.add("active");
      $("#" + tab.dataset.panel).classList.add("active");
    });
  });
}

function wirePosters() {
  document.body.addEventListener("click", (e) => {
    const trigger = e.target.closest("[data-driver]");
    if (trigger && currentData && currentChamp) openPoster(currentData, currentChamp, trigger.dataset.driver);
  });
  $("#poster-close").addEventListener("click", closePoster);
  $("#poster-modal").addEventListener("click", (e) => {
    if (e.target.id === "poster-modal") closePoster();
  });
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape") closePoster();
  });
}

function showError(msg) {
  const app = $("#app");
  app.innerHTML = `
    <div class="fatal">
      <h2>Standings couldn't load</h2>
      <p>${escapeHtml(msg)}</p>
      <p class="fatal-hint">If you opened <code>index.html</code> by double-clicking it, your browser blocks the Firebase module scripts from loading over <code>file://</code>. Serve it instead:</p>
      <pre>cd karting-championship
python3 -m http.server 8000</pre>
      <p class="fatal-hint">then open <code>http://localhost:8000</code>. On GitHub Pages this just works — no server needed.</p>
    </div>`;
}

// Renders every public tab from a season-shaped data object. Called by
// rebuildAndRender() whenever any Firestore listener fires, so a change
// (from the Editor, in any browser) shows up here live.
function renderPublicViews(data) {
  const champ = buildChampionship(data);
  currentData = data;
  currentChamp = champ;
  document.title = `${data.championship} · ${data.season}`;
  renderHero(data, champ);
  renderPodium(data, champ);
  renderStandings(data, champ);
  renderRounds(data);
  renderDrivers(data, champ);
}

// Repurposed from the old localStorage-draft indicator: now surfaces when
// Firestore is serving cached data instead of a live server connection.
function renderConnectionStatus(offline) {
  const bar = $("#draft-indicator");
  if (!bar) return;
  if (!offline) {
    bar.hidden = true;
    bar.innerHTML = "";
    return;
  }
  bar.hidden = false;
  bar.textContent = "Offline — showing the last data received from the server.";
}

function init() {
  try {
    initFirestoreListeners();
    wireTabs();
    wirePosters();
  } catch (err) {
    console.error(err);
    showError(err.message || String(err));
  }
}

document.addEventListener("DOMContentLoaded", init);
