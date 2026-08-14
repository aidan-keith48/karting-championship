/* ============================================================
   APEX KARTING LEAGUE — data editor
   Vanilla JS, no dependencies. Lives entirely client-side: edits an
   in-memory draft (seeded from data/season.json), autosaves that draft
   to localStorage as a safety net, and lets you export it back out as
   season.json. It never writes to the public tabs or the real file on
   disk by itself — Standings/Rounds/Drivers only ever read the fetched
   data/season.json, so there's no ambiguity about what's "published".
   Reuses app.js's globals (photoMarkup, flagEmoji, statsMarkup, parseLap,
   resolveTrackLayout, layoutImageMarkup, renderPublicViews, EDITOR_DRAFT_KEY)
   since both files share one global scope by this codebase's no-module
   convention. Every mutation calls syncPublicView(), which persists the
   draft AND pushes it straight into the public Standings/Rounds/Drivers
   tabs — so adding/editing something here shows up immediately, not just
   after a reload or an export.
   ============================================================ */

(function () {
  "use strict";

  const $ = (sel, root = document) => root.querySelector(sel);
  const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));
  const clone = (o) => (typeof structuredClone === "function" ? structuredClone(o) : JSON.parse(JSON.stringify(o)));

  let editorState = null;
  let initialized = false;
  let activeFileHandle = null; // File System Access API handle — not serialized, not persisted
  let driverIdTouched = false;
  let trackIdTouched = false;
  let draftLayouts = []; // layouts of the track currently being composed in the track form
  let avatarManifest = []; // filenames listed in assets/drivers/manifest.json
  let flashTimer = null;

  /* ---------- small utils ---------- */

  function slugify(s) {
    return (
      String(s || "")
        .toLowerCase()
        .trim()
        .replace(/[^a-z0-9]+/g, "-")
        .replace(/^-+|-+$/g, "") || "item"
    );
  }
  function uniqueId(base, existingIds) {
    let id = base;
    let n = 2;
    while (existingIds.includes(id)) {
      id = `${base}-${n}`;
      n++;
    }
    return id;
  }
  // escapeHtml is defined in app.js (loaded first) and reused here, same as
  // photoMarkup/flagEmoji/statsMarkup/parseLap — one shared global scope.
  function fmtTime(ts) {
    return new Date(ts).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });
  }
  function formError(el, msg) {
    if (el) {
      el.hidden = false;
      el.textContent = msg;
    } else {
      alert(msg);
    }
  }
  function clearFormError(el) {
    el.hidden = true;
    el.textContent = "";
  }

  // Downscales+recompresses an uploaded image client-side before turning it
  // into a data: URI, so an embedded avatar/layout drawing stays a few tens
  // of KB (fine for season.json and localStorage) instead of the several MB
  // a phone photo would otherwise be.
  function resizeImageToDataUri(file, maxDim, quality) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => {
        const img = new Image();
        img.onload = () => {
          let { width, height } = img;
          if (width > maxDim || height > maxDim) {
            if (width >= height) {
              height = Math.round((height / width) * maxDim);
              width = maxDim;
            } else {
              width = Math.round((width / height) * maxDim);
              height = maxDim;
            }
          }
          const canvas = document.createElement("canvas");
          canvas.width = width;
          canvas.height = height;
          canvas.getContext("2d").drawImage(img, 0, 0, width, height);
          resolve(canvas.toDataURL("image/jpeg", quality));
        };
        img.onerror = () => reject(new Error("Couldn't decode that image."));
        img.src = reader.result;
      };
      reader.onerror = () => reject(new Error("Couldn't read that file."));
      reader.readAsDataURL(file);
    });
  }

  // The driver-photo picker's options — whatever's listed in
  // assets/drivers/manifest.json. Missing/unreadable manifest just means an
  // empty gallery (the "…or type a path" field still works either way).
  async function loadAvatarManifest() {
    try {
      const res = await fetch("assets/drivers/manifest.json", { cache: "no-store" });
      if (res.ok) {
        const data = await res.json();
        if (Array.isArray(data.avatars)) avatarManifest = data.avatars;
      }
    } catch (e) {
      avatarManifest = [];
    }
  }

  /* ---------- state ---------- */

  function emptySeason() {
    return {
      championship: "APEX KARTING LEAGUE",
      season: "",
      tagline: "",
      scoring: { points: [25, 18, 15, 12, 10, 8, 6, 4, 2, 1], fastestLapBadge: true },
      physics: { weightStepKg: 10, penaltySec: 0.1, refWeightKg: null },
      drivers: [],
      tracks: [],
      rounds: [],
    };
  }
  function normalizeState() {
    if (!Array.isArray(editorState.drivers)) editorState.drivers = [];
    if (!Array.isArray(editorState.tracks)) editorState.tracks = [];
    if (!Array.isArray(editorState.rounds)) editorState.rounds = [];
  }

  async function ensureState() {
    if (editorState) return editorState;

    let draft = null;
    const draftRaw = localStorage.getItem(EDITOR_DRAFT_KEY);
    if (draftRaw) {
      try {
        const parsed = JSON.parse(draftRaw);
        if (parsed && parsed.schemaVersion === 1 && parsed.state) draft = parsed;
      } catch (e) {
        /* corrupt draft — ignore, treat as absent */
      }
    }

    let fetched = null;
    try {
      const res = await fetch("data/season.json", { cache: "no-store" });
      if (res.ok) fetched = await res.json();
    } catch (e) {
      /* offline or missing — fall back to an empty skeleton below */
    }

    editorState = fetched ? clone(fetched) : emptySeason();
    normalizeState();

    if (draft) showDraftBanner(draft);
    return editorState;
  }

  function showDraftBanner(draft) {
    const banner = $("#editor-draft-banner");
    banner.hidden = false;
    banner.innerHTML = `
      <span>Unsaved local draft found from ${fmtTime(draft.savedAt)}.</span>
      <button type="button" class="ef-btn small primary" id="editor-restore-draft">Restore draft</button>
      <button type="button" class="ef-btn small ghost" id="editor-discard-draft">Discard, start from season.json</button>`;
    $("#editor-restore-draft").addEventListener("click", () => {
      editorState = clone(draft.state);
      normalizeState();
      banner.hidden = true;
      renderAllEditorSections();
      if (typeof renderPublicViews === "function") renderPublicViews(editorState, true);
    });
    $("#editor-discard-draft").addEventListener("click", () => {
      localStorage.removeItem(EDITOR_DRAFT_KEY);
      banner.hidden = true;
      if (typeof renderPublicViews === "function") renderPublicViews(editorState, false);
    });
  }

  // Writes the autosave safety net to localStorage. Immediate, no debounce —
  // every call site here is a discrete action (submit/delete/import), never
  // a raw keystroke, so there's nothing to coalesce.
  function persistDraft() {
    try {
      localStorage.setItem(EDITOR_DRAFT_KEY, JSON.stringify({ schemaVersion: 1, savedAt: Date.now(), state: editorState }));
      updateDraftStatus();
    } catch (e) {
      /* storage full/unavailable — not fatal, the in-memory draft still works this session */
    }
  }

  // The one call every mutating action should make: persist the safety net
  // AND push the change into the public tabs immediately.
  function syncPublicView() {
    persistDraft();
    if (typeof renderPublicViews === "function") renderPublicViews(editorState, true);
  }

  function updateDraftStatus() {
    const raw = localStorage.getItem(EDITOR_DRAFT_KEY);
    const statusEl = $("#editor-draft-status");
    if (!raw) {
      statusEl.textContent = "No local draft.";
      return;
    }
    try {
      statusEl.textContent = `Draft autosaved ${fmtTime(JSON.parse(raw).savedAt)}.`;
    } catch (e) {
      statusEl.textContent = "";
    }
  }
  function flashStatus(msg) {
    $("#editor-draft-status").textContent = msg;
    if (flashTimer) clearTimeout(flashTimer);
    flashTimer = setTimeout(updateDraftStatus, 3000);
  }

  /* ---------- cascading id updates ---------- */

  function cascadeRenameDriver(oldId, newId) {
    editorState.rounds.forEach((r) => {
      (r.laps || []).forEach((l) => {
        if (l.driver === oldId) l.driver = newId;
      });
      if (r.attendees) r.attendees = r.attendees.map((a) => (a === oldId ? newId : a));
    });
  }
  function cascadeRenameTrack(oldId, newId) {
    editorState.rounds.forEach((r) => {
      if (r.trackId === oldId) r.trackId = newId;
    });
  }

  /* ---------- driver list + form ---------- */

  function renderDriverList() {
    const ul = $("#editor-driver-list");
    ul.innerHTML = "";
    if (!editorState.drivers.length) {
      ul.innerHTML = '<li class="ef-empty">No drivers yet — add one above.</li>';
      return;
    }
    editorState.drivers.forEach((d) => {
      const flag = flagEmoji(d.countryCode);
      const li = document.createElement("li");
      li.className = "editor-item";
      li.style.setProperty("--accent", d.color || "#e10600");
      li.innerHTML = `
        ${photoMarkup(d, "chip-photo")}
        <span class="editor-item-body">
          <span class="editor-item-title">${escapeHtml(d.name)}${flag ? ` ${flag}` : ""}</span>
          <span class="editor-item-sub">#${d.number ?? "—"} · ${escapeHtml(d.team || "")}</span>
        </span>
        <span class="editor-item-actions">
          <button type="button" class="ef-btn small" data-act="edit-driver" data-id="${d.id}">Edit</button>
          <button type="button" class="ef-btn small ghost" data-act="delete-driver" data-id="${d.id}">Delete</button>
        </span>`;
      ul.appendChild(li);
    });
  }

  function updatePhotoPreview() {
    const path = $("#ed-photo").value.trim();
    const abbr = ($("#ed-abbr").value.trim() || $("#ed-name").value.trim().slice(0, 3) || "?").toUpperCase();
    const color = $("#ed-color").value || "#e10600";
    const preview = $("#ed-photo-preview");
    preview.style.setProperty("--accent", color);
    preview.innerHTML = photoMarkup({ photo: path || null, abbr, color }, "chip-photo");
  }

  // Avatar gallery: a picker over whatever's listed in assets/drivers/manifest.json,
  // rather than an upload — the driver just clicks a face, we save that path.
  function renderAvatarGallery(selectedPath) {
    const wrap = $("#ed-avatar-gallery");
    if (!wrap) return;
    const options = [{ path: "", file: null }, ...avatarManifest.map((file) => ({ path: `assets/drivers/${file}`, file }))];
    wrap.innerHTML = options
      .map(({ path, file }) => {
        const selected = (selectedPath || "") === path;
        return `
        <button type="button" class="ef-avatar-opt${selected ? " selected" : ""}" data-path="${escapeHtml(path)}" title="${escapeHtml(file || "No avatar")}" aria-pressed="${selected}">
          ${file ? `<img src="${escapeHtml(path)}" alt="" loading="lazy">` : `<span class="ef-avatar-none">—</span>`}
        </button>`;
      })
      .join("");
  }
  function updateFlagPreview() {
    $("#ed-flag-preview").textContent = flagEmoji($("#ed-country-code").value.trim().toUpperCase());
  }
  function updateStatsPreview() {
    const stats = {
      pace: Number($("#ed-stat-pace").value),
      racecraft: Number($("#ed-stat-racecraft").value),
      awareness: Number($("#ed-stat-awareness").value),
      experience: Number($("#ed-stat-experience").value),
    };
    $("#ed-stats-preview").innerHTML = statsMarkup(stats);
  }

  function fillDriverForm(d) {
    if (!d) return;
    $("#ed-editing-id").value = d.id;
    $("#ed-name").value = d.name || "";
    $("#ed-id").value = d.id || "";
    driverIdTouched = true;
    $("#ed-abbr").value = d.abbr || "";
    $("#ed-number").value = d.number ?? "";
    $("#ed-team").value = d.team || "";
    $("#ed-color").value = d.color || "#e10600";
    $("#ed-quote").value = d.quote || "";
    $("#ed-country").value = d.country || "";
    $("#ed-country-code").value = d.countryCode || "";
    $("#ed-age").value = d.age ?? "";
    $("#ed-height").value = d.heightCm ?? "";
    $("#ed-weight").value = d.weightKg ?? "";
    $("#ed-style").value = d.style || "";
    $("#ed-photo").value = d.photo || "";
    const s = d.stats || {};
    $("#ed-stat-pace").value = s.pace ?? 70;
    $("#ed-stat-racecraft").value = s.racecraft ?? 70;
    $("#ed-stat-awareness").value = s.awareness ?? 70;
    $("#ed-stat-experience").value = s.experience ?? 70;
    renderAvatarGallery(d.photo || "");
    updatePhotoPreview();
    updateFlagPreview();
    updateStatsPreview();
    clearFormError($("#ed-error"));
    $("#editor-driver-form").scrollIntoView({ behavior: "smooth", block: "start" });
  }

  function clearDriverForm() {
    $("#editor-driver-form").reset();
    $("#ed-editing-id").value = "";
    driverIdTouched = false;
    renderAvatarGallery("");
    updatePhotoPreview();
    updateFlagPreview();
    updateStatsPreview();
    clearFormError($("#ed-error"));
  }

  function handleDriverSubmit(e) {
    e.preventDefault();
    const errEl = $("#ed-error");
    clearFormError(errEl);

    const name = $("#ed-name").value.trim();
    const numberVal = $("#ed-number").value;
    const team = $("#ed-team").value.trim();
    const color = $("#ed-color").value;
    if (!name || numberVal === "" || !team) return formError(errEl, "Name, race number and team are required.");

    const editingId = $("#ed-editing-id").value;
    const existingIds = editorState.drivers.map((d) => d.id).filter((x) => x !== editingId);
    const id = uniqueId(slugify($("#ed-id").value || name), existingIds);

    const driver = { id, name, number: Number(numberVal), team, color };
    driver.abbr = ($("#ed-abbr").value.trim() || name.slice(0, 3)).toUpperCase();
    const quote = $("#ed-quote").value.trim();
    if (quote) driver.quote = quote;
    const photo = $("#ed-photo").value.trim();
    if (photo) driver.photo = photo;
    const country = $("#ed-country").value.trim();
    if (country) driver.country = country;
    const countryCode = $("#ed-country-code").value.trim().toUpperCase();
    if (countryCode) driver.countryCode = countryCode;
    const age = $("#ed-age").value;
    if (age !== "") driver.age = Number(age);
    const height = $("#ed-height").value;
    if (height !== "") driver.heightCm = Number(height);
    const weight = $("#ed-weight").value;
    if (weight !== "") driver.weightKg = Number(weight);
    const style = $("#ed-style").value.trim();
    if (style) driver.style = style;
    driver.stats = {
      pace: Number($("#ed-stat-pace").value),
      racecraft: Number($("#ed-stat-racecraft").value),
      awareness: Number($("#ed-stat-awareness").value),
      experience: Number($("#ed-stat-experience").value),
    };

    if (editingId) {
      const idx = editorState.drivers.findIndex((d) => d.id === editingId);
      if (idx !== -1) {
        if (editingId !== id) cascadeRenameDriver(editingId, id);
        editorState.drivers[idx] = driver;
      }
    } else {
      editorState.drivers.push(driver);
    }
    syncPublicView();
    renderDriverList();
    renderRoundList();
    renderAttendanceRows(); // roster changed — refresh the round form's attendance rows too
    clearDriverForm();
  }

  function deleteDriver(id) {
    const referencing = editorState.rounds.filter(
      (r) => (r.laps || []).some((l) => l.driver === id) || (r.attendees || []).includes(id)
    );
    if (referencing.length) {
      const names = referencing.map((r) => r.name || r.id).join(", ");
      if (!confirm(`This driver appears in ${referencing.length} race(s): ${names}. Delete them and remove from those races?`)) return;
      referencing.forEach((r) => {
        r.laps = (r.laps || []).filter((l) => l.driver !== id);
        if (r.attendees) r.attendees = r.attendees.filter((a) => a !== id);
      });
    } else if (!confirm("Delete this driver?")) {
      return;
    }
    editorState.drivers = editorState.drivers.filter((d) => d.id !== id);
    syncPublicView();
    renderDriverList();
    renderRoundList();
    renderAttendanceRows();
    if ($("#ed-editing-id").value === id) clearDriverForm();
  }

  /* ---------- track list + form ---------- */

  function renderTrackList() {
    const ul = $("#editor-track-list");
    ul.innerHTML = "";
    if (!editorState.tracks.length) {
      ul.innerHTML = '<li class="ef-empty">No tracks yet — add one above.</li>';
      return;
    }
    editorState.tracks.forEach((t) => {
      const count = (t.layouts || []).length;
      const li = document.createElement("li");
      li.className = "editor-item";
      li.innerHTML = `
        <span class="editor-item-body">
          <span class="editor-item-title">${escapeHtml(t.name)}</span>
          <span class="editor-item-sub">${count} layout${count === 1 ? "" : "s"}</span>
        </span>
        <span class="editor-item-actions">
          <button type="button" class="ef-btn small" data-act="edit-track" data-id="${t.id}">Edit</button>
          <button type="button" class="ef-btn small ghost" data-act="delete-track" data-id="${t.id}">Delete</button>
        </span>`;
      ul.appendChild(li);
    });
  }

  function renderTrackLayoutsEditor() {
    const list = $("#et-layouts-list");
    if (!draftLayouts.length) {
      list.innerHTML = '<p class="ef-empty">No layouts yet — add one below.</p>';
      return;
    }
    list.innerHTML = draftLayouts
      .map(
        (layout, i) => `
      <div class="ef-layout-row">
        ${layoutImageMarkup(layout.image, layout.name, "ef-layout-thumb")}
        <input type="text" value="${escapeHtml(layout.name)}" data-i="${i}" data-field="name" placeholder="Layout name" />
        <input type="text" value="${escapeHtml(layout.image || "")}" data-i="${i}" data-field="image" placeholder="assets/tracks/..." />
        <button type="button" class="ef-btn small ghost ef-layout-remove" data-i="${i}">Remove</button>
      </div>`
      )
      .join("");
  }

  async function handleAddLayout() {
    const errEl = $("#et-error");
    const name = $("#et-layout-name").value.trim();
    if (!name) return formError(errEl, "Give the layout a name first.");

    const file = $("#et-layout-file").files[0];
    let image = $("#et-layout-image").value.trim();
    if (file) {
      try {
        image = await resizeImageToDataUri(file, 800, 0.88);
      } catch (err) {
        return formError(errEl, err.message || "Couldn't read that image — try a different file.");
      }
    }

    const id = uniqueId(slugify(name), draftLayouts.map((l) => l.id));
    draftLayouts.push({ id, name, ...(image ? { image } : {}) });
    $("#et-layout-name").value = "";
    $("#et-layout-image").value = "";
    $("#et-layout-file").value = "";
    renderTrackLayoutsEditor();
    clearFormError(errEl);
  }

  function handleLayoutFieldInput(e) {
    const t = e.target;
    const i = Number(t.dataset.i);
    const field = t.dataset.field;
    if (!isNaN(i) && field && draftLayouts[i]) draftLayouts[i][field] = t.value;
  }

  function handleLayoutRemoveClick(e) {
    const btn = e.target.closest(".ef-layout-remove");
    if (!btn) return;
    const i = Number(btn.dataset.i);
    const layout = draftLayouts[i];
    const trackId = $("#et-editing-id").value;
    if (trackId && layout) {
      const referencing = editorState.rounds.filter((r) => r.trackId === trackId && r.layoutId === layout.id);
      if (referencing.length) {
        const names = referencing.map((r) => r.name || r.id).join(", ");
        if (!confirm(`This layout is used by ${referencing.length} race(s): ${names}. Remove it and unassign from those races?`)) return;
        referencing.forEach((r) => delete r.layoutId);
        syncPublicView();
        renderRoundList();
      }
    }
    draftLayouts.splice(i, 1);
    renderTrackLayoutsEditor();
  }

  function fillTrackForm(t) {
    if (!t) return;
    $("#et-editing-id").value = t.id;
    $("#et-name").value = t.name || "";
    $("#et-id").value = t.id || "";
    trackIdTouched = true;
    draftLayouts = (t.layouts || []).map((l) => ({ ...l }));
    renderTrackLayoutsEditor();
    clearFormError($("#et-error"));
    $("#editor-track-form").scrollIntoView({ behavior: "smooth", block: "start" });
  }

  function clearTrackForm() {
    $("#editor-track-form").reset();
    $("#et-editing-id").value = "";
    trackIdTouched = false;
    draftLayouts = [];
    renderTrackLayoutsEditor();
    clearFormError($("#et-error"));
  }

  function handleTrackSubmit(e) {
    e.preventDefault();
    const errEl = $("#et-error");
    clearFormError(errEl);
    const name = $("#et-name").value.trim();
    if (!name) return formError(errEl, "Track name is required.");

    const editingId = $("#et-editing-id").value;
    const existingIds = editorState.tracks.map((t) => t.id).filter((x) => x !== editingId);
    const id = uniqueId(slugify($("#et-id").value || name), existingIds);
    const track = { id, name, layouts: draftLayouts.map((l) => ({ ...l })) };

    if (editingId) {
      const idx = editorState.tracks.findIndex((t) => t.id === editingId);
      if (idx !== -1) {
        if (editingId !== id) cascadeRenameTrack(editingId, id);
        editorState.tracks[idx] = track;
      }
    } else {
      editorState.tracks.push(track);
    }
    syncPublicView();
    renderTrackList();
    renderRoundList();
    renderRoundTrackOptions();
    clearTrackForm();
  }

  function deleteTrack(id) {
    const referencing = editorState.rounds.filter((r) => r.trackId === id);
    if (referencing.length) {
      const names = referencing.map((r) => r.name || r.id).join(", ");
      if (!confirm(`This track is used by ${referencing.length} race(s): ${names}. Delete it and unassign from those races?`)) return;
      referencing.forEach((r) => {
        delete r.trackId;
        delete r.layoutId;
      });
    } else if (!confirm("Delete this track?")) {
      return;
    }
    editorState.tracks = editorState.tracks.filter((t) => t.id !== id);
    syncPublicView();
    renderTrackList();
    renderRoundList();
    renderRoundTrackOptions();
    if ($("#et-editing-id").value === id) clearTrackForm();
  }

  /* ---------- round list + form ---------- */

  function renderRoundList() {
    const ul = $("#editor-round-list");
    ul.innerHTML = "";
    if (!editorState.rounds.length) {
      ul.innerHTML = '<li class="ef-empty">No races yet — add one above.</li>';
      return;
    }
    const sorted = editorState.rounds.slice().sort((a, b) => ((a.date || "") < (b.date || "") ? 1 : -1));
    sorted.forEach((r) => {
      const { trackName, layoutName } = resolveTrackLayout(editorState, r);
      const count = (r.laps || []).length;
      const li = document.createElement("li");
      li.className = "editor-item";
      li.innerHTML = `
        <span class="editor-item-body">
          <span class="editor-item-title">${escapeHtml(r.name)}</span>
          <span class="editor-item-sub">${[r.date, trackName, layoutName].filter(Boolean).map(escapeHtml).join(" · ")} · ${count} driver${
        count === 1 ? "" : "s"
      }</span>
        </span>
        <span class="editor-item-actions">
          <button type="button" class="ef-btn small" data-act="edit-round" data-id="${r.id}">Edit</button>
          <button type="button" class="ef-btn small ghost" data-act="delete-round" data-id="${r.id}">Delete</button>
        </span>`;
      ul.appendChild(li);
    });
  }

  function renderRoundTrackOptions() {
    const sel = $("#er-track");
    const current = sel.value;
    sel.innerHTML = editorState.tracks.length
      ? `<option value="">— no track —</option>` + editorState.tracks.map((t) => `<option value="${t.id}">${escapeHtml(t.name)}</option>`).join("")
      : `<option value="">— add a track first —</option>`;
    sel.value = editorState.tracks.some((t) => t.id === current) ? current : "";
    renderRoundLayoutOptions(sel.value);
  }

  function renderRoundLayoutOptions(trackId, preselectLayoutId) {
    const field = $("#er-layout-field");
    const sel = $("#er-layout");
    const track = editorState.tracks.find((t) => t.id === trackId);
    const layouts = track ? track.layouts || [] : [];
    if (!layouts.length) {
      field.hidden = true;
      sel.innerHTML = "";
      return;
    }
    field.hidden = false;
    if (layouts.length === 1) {
      sel.innerHTML = `<option value="${layouts[0].id}">${escapeHtml(layouts[0].name)}</option>`;
      sel.value = layouts[0].id;
    } else {
      sel.innerHTML =
        `<option value="">Select layout…</option>` + layouts.map((l) => `<option value="${l.id}">${escapeHtml(l.name)}</option>`).join("");
      sel.value = layouts.some((l) => l.id === preselectLayoutId) ? preselectLayoutId : "";
    }
  }

  function renderAttendanceRows(round) {
    const wrap = $("#er-attendance-list");
    if (!editorState.drivers.length) {
      wrap.innerHTML = '<p class="ef-empty">Add drivers first.</p>';
      return;
    }
    const lapsById = {};
    (round?.laps || []).forEach((l) => (lapsById[l.driver] = l));
    const attendeesOverride = round?.attendees && round.attendees.length ? new Set(round.attendees) : null;

    wrap.innerHTML = editorState.drivers
      .map((d) => {
        const lap = lapsById[d.id];
        const attended = !!lap || (attendeesOverride ? attendeesOverride.has(d.id) : false);
        return `
        <div class="ef-attend-row" data-driver-id="${d.id}">
          <label class="ef-attend-check">
            <input type="checkbox" class="ef-attend-toggle" ${attended ? "checked" : ""} />
            <span style="--accent:${escapeHtml(d.color)}">${escapeHtml(d.name)}</span>
          </label>
          <div class="ef-attend-fields" ${attended ? "" : "hidden"}>
            <label>Kart # <input type="number" class="ef-attend-kart" min="0" value="${lap && lap.kart != null ? lap.kart : ""}" /></label>
            <label>Best lap <input type="text" class="ef-attend-time" placeholder="00:42.318" value="${lap ? escapeHtml(lap.best) : ""}" /></label>
          </div>
        </div>`;
      })
      .join("");
  }

  function handleAttendToggle(e) {
    if (!e.target.classList.contains("ef-attend-toggle")) return;
    const fields = e.target.closest(".ef-attend-row").querySelector(".ef-attend-fields");
    fields.hidden = !e.target.checked;
  }

  function fillRoundForm(r) {
    if (!r) return;
    $("#er-editing-id").value = r.id;
    $("#er-name").value = r.name || "";
    $("#er-date").value = r.date || "";
    $("#er-time").value = r.time || "";
    $("#er-track").value = r.trackId || "";
    renderRoundLayoutOptions(r.trackId || "", r.layoutId || "");
    renderAttendanceRows(r);
    clearFormError($("#er-error"));
    $("#editor-round-form").scrollIntoView({ behavior: "smooth", block: "start" });
  }

  function clearRoundForm() {
    $("#editor-round-form").reset();
    $("#er-editing-id").value = "";
    renderRoundLayoutOptions($("#er-track").value);
    renderAttendanceRows();
    clearFormError($("#er-error"));
  }

  function handleRoundSubmit(e) {
    e.preventDefault();
    const errEl = $("#er-error");
    clearFormError(errEl);

    const name = $("#er-name").value.trim();
    const date = $("#er-date").value;
    if (!name || !date) return formError(errEl, "Race name and date are required.");
    const time = $("#er-time").value;
    const trackId = $("#er-track").value || null;
    const layoutId = $("#er-layout").value || null;

    const laps = [];
    const allAttended = [];
    let hasUntimed = false;
    let badDriver = null;

    $$(".ef-attend-row", $("#er-attendance-list")).forEach((row) => {
      const driverId = row.dataset.driverId;
      if (!row.querySelector(".ef-attend-toggle").checked) return;
      allAttended.push(driverId);
      const timeVal = row.querySelector(".ef-attend-time").value.trim();
      const kartVal = row.querySelector(".ef-attend-kart").value;
      if (timeVal) {
        if (parseLap(timeVal) == null) {
          badDriver = driverId;
          return;
        }
        const lap = { driver: driverId, best: timeVal };
        if (kartVal !== "") lap.kart = Number(kartVal);
        laps.push(lap);
      } else {
        hasUntimed = true;
      }
    });
    if (badDriver) {
      const d = editorState.drivers.find((x) => x.id === badDriver);
      return formError(errEl, `Lap time for ${d ? d.name : badDriver} doesn't look right (try 00:42.318).`);
    }

    const editingId = $("#er-editing-id").value;
    const id = editingId || uniqueId(slugify(name), editorState.rounds.map((r) => r.id));

    const round = { id, name, date };
    if (time) round.time = time;
    if (trackId) round.trackId = trackId;
    if (layoutId) round.layoutId = layoutId;
    round.laps = laps;
    if (hasUntimed) round.attendees = allAttended;

    if (editingId) {
      const idx = editorState.rounds.findIndex((r) => r.id === editingId);
      if (idx !== -1) editorState.rounds[idx] = round;
    } else {
      editorState.rounds.push(round);
    }
    syncPublicView();
    renderRoundList();
    clearRoundForm();
  }

  function deleteRound(id) {
    if (!confirm("Delete this race?")) return;
    editorState.rounds = editorState.rounds.filter((r) => r.id !== id);
    syncPublicView();
    renderRoundList();
    if ($("#er-editing-id").value === id) clearRoundForm();
  }

  /* ---------- export / import ---------- */

  function sortedForExport() {
    const out = clone(editorState);
    out.rounds = (out.rounds || []).slice().sort((a, b) => {
      const da = a.date || "",
        db = b.date || "";
      if (da !== db) return da < db ? -1 : 1;
      const ta = a.time || "",
        tb = b.time || "";
      return ta < tb ? -1 : ta > tb ? 1 : 0;
    });
    return out;
  }

  function editorDownload() {
    const json = JSON.stringify(sortedForExport(), null, 2);
    const blob = new Blob([json], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = "season.json";
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
    flashStatus("Downloaded season.json.");
  }

  async function editorSaveToFile() {
    if (!("showSaveFilePicker" in window)) return editorDownload();
    try {
      if (!activeFileHandle) {
        activeFileHandle = await window.showSaveFilePicker({
          suggestedName: "season.json",
          types: [{ description: "JSON", accept: { "application/json": [".json"] } }],
        });
      }
      const writable = await activeFileHandle.createWritable();
      await writable.write(JSON.stringify(sortedForExport(), null, 2));
      await writable.close();
      flashStatus("Saved to file.");
    } catch (err) {
      if (err && err.name === "AbortError") return; // user cancelled the picker
      console.error(err);
      flashStatus("Save failed — downloading instead.");
      editorDownload();
    }
  }

  function handleImportFile(file) {
    const reader = new FileReader();
    reader.onload = () => {
      let parsed;
      try {
        parsed = JSON.parse(reader.result);
      } catch (err) {
        return formError(null, "Import failed — not valid JSON: " + err.message);
      }
      if (!Array.isArray(parsed.drivers) || !Array.isArray(parsed.rounds)) {
        return formError(null, "That doesn't look like a season.json (missing drivers/rounds arrays).");
      }
      if (!Array.isArray(parsed.tracks)) parsed.tracks = [];
      editorState = clone(parsed);
      normalizeState();
      syncPublicView();
      renderAllEditorSections();
      flashStatus("Imported.");
    };
    reader.readAsText(file);
  }

  /* ---------- wiring ---------- */

  function renderAllEditorSections() {
    renderDriverList();
    renderTrackList();
    renderRoundTrackOptions();
    renderRoundList();
    clearDriverForm();
    clearTrackForm();
    clearRoundForm();
  }

  function wireSubTabs() {
    $$(".editor-subtab").forEach((btn) => {
      btn.addEventListener("click", () => {
        $$(".editor-subtab").forEach((b) => b.classList.remove("active"));
        $$(".editor-section").forEach((s) => s.classList.remove("active"));
        btn.classList.add("active");
        $(`#editor-${btn.dataset.sub}-section`).classList.add("active");
      });
    });
  }

  function wireForms() {
    $("#editor-driver-form").addEventListener("submit", handleDriverSubmit);
    $("#ed-cancel").addEventListener("click", clearDriverForm);
    $("#ed-id").addEventListener("input", () => {
      driverIdTouched = true;
    });
    $("#ed-name").addEventListener("input", () => {
      if (!driverIdTouched) $("#ed-id").value = slugify($("#ed-name").value);
      updatePhotoPreview();
    });
    ["#ed-abbr", "#ed-color"].forEach((sel) => $(sel).addEventListener("input", updatePhotoPreview));
    $("#ed-photo").addEventListener("input", () => {
      renderAvatarGallery($("#ed-photo").value.trim());
      updatePhotoPreview();
    });
    $("#ed-avatar-gallery").addEventListener("click", (e) => {
      const btn = e.target.closest(".ef-avatar-opt");
      if (!btn) return;
      $("#ed-photo").value = btn.dataset.path;
      renderAvatarGallery(btn.dataset.path);
      updatePhotoPreview();
    });
    $("#ed-country-code").addEventListener("input", updateFlagPreview);
    ["pace", "racecraft", "awareness", "experience"].forEach((k) => $(`#ed-stat-${k}`).addEventListener("input", updateStatsPreview));

    $("#editor-track-form").addEventListener("submit", handleTrackSubmit);
    $("#et-cancel").addEventListener("click", clearTrackForm);
    $("#et-id").addEventListener("input", () => {
      trackIdTouched = true;
    });
    $("#et-name").addEventListener("input", () => {
      if (!trackIdTouched) $("#et-id").value = slugify($("#et-name").value);
    });
    $("#et-layout-add").addEventListener("click", handleAddLayout);
    $("#et-layouts-list").addEventListener("input", handleLayoutFieldInput);
    $("#et-layouts-list").addEventListener("click", handleLayoutRemoveClick);

    $("#editor-round-form").addEventListener("submit", handleRoundSubmit);
    $("#er-cancel").addEventListener("click", clearRoundForm);
    $("#er-track").addEventListener("change", () => renderRoundLayoutOptions($("#er-track").value));
    $("#er-attendance-list").addEventListener("change", handleAttendToggle);
  }

  function wireListActions() {
    $("#editor-driver-list").addEventListener("click", (e) => {
      const btn = e.target.closest("button[data-act]");
      if (!btn) return;
      if (btn.dataset.act === "edit-driver") fillDriverForm(editorState.drivers.find((d) => d.id === btn.dataset.id));
      else if (btn.dataset.act === "delete-driver") deleteDriver(btn.dataset.id);
    });
    $("#editor-track-list").addEventListener("click", (e) => {
      const btn = e.target.closest("button[data-act]");
      if (!btn) return;
      if (btn.dataset.act === "edit-track") fillTrackForm(editorState.tracks.find((t) => t.id === btn.dataset.id));
      else if (btn.dataset.act === "delete-track") deleteTrack(btn.dataset.id);
    });
    $("#editor-round-list").addEventListener("click", (e) => {
      const btn = e.target.closest("button[data-act]");
      if (!btn) return;
      if (btn.dataset.act === "edit-round") fillRoundForm(editorState.rounds.find((r) => r.id === btn.dataset.id));
      else if (btn.dataset.act === "delete-round") deleteRound(btn.dataset.id);
    });
  }

  function wireExportBar() {
    const hasFSAccess = "showSaveFilePicker" in window;
    $("#editor-save-file").hidden = !hasFSAccess;
    $("#editor-save-file").addEventListener("click", editorSaveToFile);
    $("#editor-download").addEventListener("click", editorDownload);
    $("#editor-import").addEventListener("click", () => $("#editor-import-input").click());
    $("#editor-import-input").addEventListener("change", (e) => {
      const file = e.target.files[0];
      if (file) handleImportFile(file);
      e.target.value = "";
    });
    $("#editor-clear-draft").addEventListener("click", () => {
      localStorage.removeItem(EDITOR_DRAFT_KEY);
      flashStatus("Local draft cleared.");
      // Keep showing the current in-progress edits — this only clears the
      // localStorage safety net, not the work itself.
      if (typeof renderPublicViews === "function") renderPublicViews(editorState, true);
    });
    updateDraftStatus();
  }

  async function activateEditor() {
    if (initialized) return;
    initialized = true;
    await Promise.all([ensureState(), loadAvatarManifest()]);
    renderAllEditorSections();
    wireForms();
    wireListActions();
    wireExportBar();
  }

  document.addEventListener("DOMContentLoaded", () => {
    wireSubTabs();
    const tabBtn = document.querySelector('.tab[data-panel="panel-editor"]');
    if (tabBtn) tabBtn.addEventListener("click", activateEditor);
  });
})();
