/* ============================================================
   APEX KARTING LEAGUE — data editor
   Vanilla JS, no dependencies. Every mutation writes straight to
   Firestore (setDoc/deleteDoc/writeBatch, via window.db/window.fb
   from firebase-init.js) — there is no local draft anymore.
   app.js's own Firestore listeners pick up the change and re-render
   the public tabs automatically, in this browser AND everyone
   else's, so there's no explicit "push to public view" step left
   to call.

   List views here (driver/track/round lists, the round form's
   track/layout dropdowns) read directly from `currentData` — the
   same live cache app.js already maintains — instead of a separate
   cloned copy, and refresh on the 'apex-data-changed' event app.js
   dispatches after every render. Only the form *currently being
   filled in* is local, ephemeral UI state (cleared on submit/cancel,
   same as before).

   Editing is gated behind Google Sign-In + an email allowlist
   (window.isAllowlisted, from firebase-config.js's EDITOR_ALLOWLIST)
   — enforced for real by firestore.rules, mirrored here only for UI
   (hide/disable forms, show a sign-in prompt instead).

   Reuses app.js's globals (photoMarkup, flagEmoji, statsMarkup,
   parseLap, resolveTrackLayout, layoutImageMarkup, currentData,
   escapeHtml) since both files share one global scope by this
   codebase's no-module convention.
   ============================================================ */

(function () {
  "use strict";

  const $ = (sel, root = document) => root.querySelector(sel);
  const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));

  let initialized = false;
  let driverIdTouched = false;
  let trackIdTouched = false;
  let draftLayouts = []; // layouts of the track currently being composed in the track form
  let avatarManifest = []; // filenames listed in assets/drivers/manifest.json
  let flashTimer = null;
  let configSeeded = false;

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
  // escapeHtml/currentData are defined in app.js (loaded first) and reused
  // here, same as photoMarkup/flagEmoji/statsMarkup/parseLap.
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
  function flashStatus(msg) {
    const el = $("#editor-sync-status");
    if (!el) return;
    el.textContent = msg;
    if (flashTimer) clearTimeout(flashTimer);
    flashTimer = setTimeout(() => (el.textContent = ""), 3000);
  }

  function drivers() {
    return (currentData && currentData.drivers) || [];
  }
  function tracks() {
    return (currentData && currentData.tracks) || [];
  }
  function rounds() {
    return (currentData && currentData.rounds) || [];
  }

  // Downscales+recompresses an uploaded image client-side before turning it
  // into a data: URI, so an embedded track-layout drawing stays a few tens
  // of KB (well under Firestore's 1MB document limit) instead of the
  // several MB a phone photo would otherwise be. Driver avatars don't use
  // this — they're picked from the curated assets/drivers/ gallery instead.
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

  /* ---------- auth gating ---------- */

  function isAuthed() {
    return !!(window.currentUser && window.isAllowlisted(window.currentUser.email));
  }

  function updateAuthUI() {
    const user = window.currentUser;
    const statusEl = $("#editor-auth-status");
    const signinBtn = $("#editor-signin");
    const signoutBtn = $("#editor-signout");
    const gateMsg = $("#editor-gate-msg");

    if (!user) {
      statusEl.textContent = "Not signed in — you can browse, but editing needs an allowlisted Google account.";
      signinBtn.hidden = false;
      signoutBtn.hidden = true;
      gateMsg.hidden = true;
    } else if (isAuthed()) {
      statusEl.textContent = `Signed in as ${user.email}.`;
      signinBtn.hidden = true;
      signoutBtn.hidden = false;
      gateMsg.hidden = true;
    } else {
      statusEl.textContent = `Signed in as ${user.email}.`;
      signinBtn.hidden = true;
      signoutBtn.hidden = false;
      $("#editor-gate-email").textContent = user.email;
      gateMsg.hidden = false;
    }

    const authed = isAuthed();
    $$(".editor-needs-auth").forEach((el) => {
      el.hidden = !authed;
      if (el.tagName === "INPUT" || el.tagName === "BUTTON" || el.tagName === "SELECT") el.disabled = !authed;
    });
    renderDriverList();
    renderTrackList();
    renderRoundList();

    if (authed && !configSeeded) {
      configSeeded = true;
      ensureConfigDoc().catch((err) => console.error("config seed failed", err));
    }
  }

  // Creates config/season with sane defaults if it doesn't exist yet — only
  // attempted once signed in as an allowlisted user, since firestore.rules
  // requires that to write. A brand-new project needs no manual Firestore
  // setup beyond what's already been done.
  async function ensureConfigDoc() {
    const ref = window.fb.doc(window.db, "config", "season");
    const snap = await window.fb.getDoc(ref);
    if (!snap.exists()) await window.fb.setDoc(ref, DEFAULT_CONFIG);
  }

  function requireAuthed(errEl) {
    if (isAuthed()) return true;
    formError(errEl, "Sign in with an allowlisted Google account to save changes.");
    return false;
  }

  // A driver profile can only be edited/deleted by whoever created it,
  // UNLESS you're an admin (window.isAdmin, from ADMIN_ALLOWLIST) — admins
  // can edit/delete any driver, for fixing typos or setting things up for
  // someone who hasn't signed in yet. Enforced for real by firestore.rules
  // (resource.data.ownerEmail + the same admin check), this is just the
  // matching client-side check so the UI never even offers an Edit/Delete
  // button it isn't allowed to use. A driver with no ownerEmail yet
  // (pre-existing data) is "unclaimed" — the first allowlisted person to
  // save it becomes its owner.
  function isOwnDriver(d) {
    const email = window.currentUser && window.currentUser.email;
    if (!email) return false;
    return window.isAdmin(email) || !d.ownerEmail || d.ownerEmail === email;
  }

  /* ---------- cascading id updates (Firestore batch writes) ---------- */

  async function cascadeRenameDriverFS(oldId, newId) {
    const affected = rounds().filter(
      (r) => (r.laps || []).some((l) => l.driver === oldId) || (r.attendees || []).includes(oldId)
    );
    if (!affected.length) return;
    const batch = window.fb.writeBatch(window.db);
    affected.forEach((r) => {
      const updated = { ...r };
      updated.laps = (r.laps || []).map((l) => (l.driver === oldId ? { ...l, driver: newId } : l));
      if (r.attendees) updated.attendees = r.attendees.map((a) => (a === oldId ? newId : a));
      batch.set(window.fb.doc(window.db, "rounds", r.id), updated);
    });
    await batch.commit();
  }

  async function cascadeRenameTrackFS(oldId, newId) {
    const affected = rounds().filter((r) => r.trackId === oldId);
    if (!affected.length) return;
    const batch = window.fb.writeBatch(window.db);
    affected.forEach((r) => {
      batch.set(window.fb.doc(window.db, "rounds", r.id), { ...r, trackId: newId });
    });
    await batch.commit();
  }

  /* ---------- driver list + form ---------- */

  function renderDriverList() {
    const ul = $("#editor-driver-list");
    if (!drivers().length) {
      ul.innerHTML = '<li class="ef-empty">No drivers yet — add one above.</li>';
      return;
    }
    const authed = isAuthed();
    ul.innerHTML = drivers()
      .map((d) => {
        const flag = flagEmoji(d.countryCode);
        const mine = authed && isOwnDriver(d);
        return `
        <li class="editor-item" style="--accent:${escapeHtml(d.color || "#e10600")}">
          ${photoMarkup(d, "chip-photo")}
          <span class="editor-item-body">
            <span class="editor-item-title">${escapeHtml(d.name)}${flag ? ` ${flag}` : ""}</span>
            <span class="editor-item-sub">#${d.number ?? "—"} · ${escapeHtml(d.team || "")}</span>
          </span>
          ${
            mine
              ? `<span class="editor-item-actions">
                  <button type="button" class="ef-btn small" data-act="edit-driver" data-id="${escapeHtml(d.id)}">Edit</button>
                  <button type="button" class="ef-btn small ghost" data-act="delete-driver" data-id="${escapeHtml(d.id)}">Delete</button>
                </span>`
              : authed && d.ownerEmail
              ? `<span class="editor-item-owner">Owned by ${escapeHtml(d.ownerEmail)}</span>`
              : ""
          }
        </li>`;
      })
      .join("");
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

  async function handleDriverSubmit(e) {
    e.preventDefault();
    const errEl = $("#ed-error");
    clearFormError(errEl);
    if (!requireAuthed(errEl)) return;

    const name = $("#ed-name").value.trim();
    const numberVal = $("#ed-number").value;
    const team = $("#ed-team").value.trim();
    const color = $("#ed-color").value;
    if (!name || numberVal === "" || !team) return formError(errEl, "Name, race number and team are required.");

    const editingId = $("#ed-editing-id").value;
    const existingDriver = editingId ? drivers().find((d) => d.id === editingId) : null;
    if (existingDriver && !isOwnDriver(existingDriver)) {
      return formError(errEl, "You can only edit your own driver profile.");
    }
    const existingIds = drivers()
      .map((d) => d.id)
      .filter((x) => x !== editingId);
    const id = uniqueId(slugify($("#ed-id").value || name), existingIds);

    const driver = { id, name, number: Number(numberVal), team, color };
    driver.ownerEmail = (existingDriver && existingDriver.ownerEmail) || window.currentUser.email;
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

    try {
      if (editingId && editingId !== id) {
        await cascadeRenameDriverFS(editingId, id);
        await window.fb.deleteDoc(window.fb.doc(window.db, "drivers", editingId));
      }
      await window.fb.setDoc(window.fb.doc(window.db, "drivers", id), driver);
      flashStatus("Driver saved.");
      clearDriverForm();
    } catch (err) {
      console.error(err);
      formError(errEl, "Save failed: " + (err.message || err));
    }
  }

  async function deleteDriver(id) {
    const driver = drivers().find((d) => d.id === id);
    if (driver && !isOwnDriver(driver)) {
      alert("You can only delete your own driver profile.");
      return;
    }
    const referencing = rounds().filter((r) => (r.laps || []).some((l) => l.driver === id) || (r.attendees || []).includes(id));
    if (referencing.length) {
      const names = referencing.map((r) => r.name || r.id).join(", ");
      if (!confirm(`This driver appears in ${referencing.length} race(s): ${names}. Delete them and remove from those races?`)) return;
    } else if (!confirm("Delete this driver?")) {
      return;
    }
    try {
      if (referencing.length) {
        const batch = window.fb.writeBatch(window.db);
        referencing.forEach((r) => {
          const updated = { ...r };
          updated.laps = (r.laps || []).filter((l) => l.driver !== id);
          if (r.attendees) updated.attendees = r.attendees.filter((a) => a !== id);
          batch.set(window.fb.doc(window.db, "rounds", r.id), updated);
        });
        await batch.commit();
      }
      await window.fb.deleteDoc(window.fb.doc(window.db, "drivers", id));
      flashStatus("Driver deleted.");
      if ($("#ed-editing-id").value === id) clearDriverForm();
    } catch (err) {
      console.error(err);
      alert("Delete failed: " + (err.message || err));
    }
  }

  /* ---------- track list + form ---------- */

  function renderTrackList() {
    const ul = $("#editor-track-list");
    if (!tracks().length) {
      ul.innerHTML = '<li class="ef-empty">No tracks yet — add one above.</li>';
      return;
    }
    const authed = isAuthed();
    ul.innerHTML = tracks()
      .map((t) => {
        const count = (t.layouts || []).length;
        return `
        <li class="editor-item">
          <span class="editor-item-body">
            <span class="editor-item-title">${escapeHtml(t.name)}</span>
            <span class="editor-item-sub">${count} layout${count === 1 ? "" : "s"}</span>
          </span>
          ${
            authed
              ? `<span class="editor-item-actions">
                  <button type="button" class="ef-btn small" data-act="edit-track" data-id="${escapeHtml(t.id)}">Edit</button>
                  <button type="button" class="ef-btn small ghost" data-act="delete-track" data-id="${escapeHtml(t.id)}">Delete</button>
                </span>`
              : ""
          }
        </li>`;
      })
      .join("");
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

    const id = uniqueId(
      slugify(name),
      draftLayouts.map((l) => l.id)
    );
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

  async function handleLayoutRemoveClick(e) {
    const btn = e.target.closest(".ef-layout-remove");
    if (!btn) return;
    const i = Number(btn.dataset.i);
    const layout = draftLayouts[i];
    const trackId = $("#et-editing-id").value;
    if (trackId && layout) {
      const referencing = rounds().filter((r) => r.trackId === trackId && r.layoutId === layout.id);
      if (referencing.length) {
        const names = referencing.map((r) => r.name || r.id).join(", ");
        if (!confirm(`This layout is used by ${referencing.length} race(s): ${names}. Remove it and unassign from those races?`)) return;
        try {
          const batch = window.fb.writeBatch(window.db);
          referencing.forEach((r) => {
            const updated = { ...r };
            delete updated.layoutId;
            batch.set(window.fb.doc(window.db, "rounds", r.id), updated);
          });
          await batch.commit();
        } catch (err) {
          console.error(err);
          alert("Couldn't unassign that layout from affected races: " + (err.message || err));
          return;
        }
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

  async function handleTrackSubmit(e) {
    e.preventDefault();
    const errEl = $("#et-error");
    clearFormError(errEl);
    if (!requireAuthed(errEl)) return;
    const name = $("#et-name").value.trim();
    if (!name) return formError(errEl, "Track name is required.");

    const editingId = $("#et-editing-id").value;
    const existingIds = tracks()
      .map((t) => t.id)
      .filter((x) => x !== editingId);
    const id = uniqueId(slugify($("#et-id").value || name), existingIds);
    const track = { id, name, layouts: draftLayouts.map((l) => ({ ...l })) };

    try {
      if (editingId && editingId !== id) {
        await cascadeRenameTrackFS(editingId, id);
        await window.fb.deleteDoc(window.fb.doc(window.db, "tracks", editingId));
      }
      await window.fb.setDoc(window.fb.doc(window.db, "tracks", id), track);
      flashStatus("Track saved.");
      clearTrackForm();
    } catch (err) {
      console.error(err);
      formError(errEl, "Save failed: " + (err.message || err));
    }
  }

  async function deleteTrack(id) {
    const referencing = rounds().filter((r) => r.trackId === id);
    if (referencing.length) {
      const names = referencing.map((r) => r.name || r.id).join(", ");
      if (!confirm(`This track is used by ${referencing.length} race(s): ${names}. Delete it and unassign from those races?`)) return;
    } else if (!confirm("Delete this track?")) {
      return;
    }
    try {
      if (referencing.length) {
        const batch = window.fb.writeBatch(window.db);
        referencing.forEach((r) => {
          const updated = { ...r };
          delete updated.trackId;
          delete updated.layoutId;
          batch.set(window.fb.doc(window.db, "rounds", r.id), updated);
        });
        await batch.commit();
      }
      await window.fb.deleteDoc(window.fb.doc(window.db, "tracks", id));
      flashStatus("Track deleted.");
      if ($("#et-editing-id").value === id) clearTrackForm();
    } catch (err) {
      console.error(err);
      alert("Delete failed: " + (err.message || err));
    }
  }

  /* ---------- round list + form ---------- */

  function renderRoundList() {
    const ul = $("#editor-round-list");
    if (!rounds().length) {
      ul.innerHTML = '<li class="ef-empty">No races yet — add one above.</li>';
      return;
    }
    const authed = isAuthed();
    const sorted = rounds()
      .slice()
      .sort((a, b) => ((a.date || "") < (b.date || "") ? 1 : -1));
    ul.innerHTML = sorted
      .map((r) => {
        const { trackName, layoutName } = resolveTrackLayout(currentData, r);
        const count = (r.laps || []).length;
        return `
        <li class="editor-item">
          <span class="editor-item-body">
            <span class="editor-item-title">${escapeHtml(r.name)}</span>
            <span class="editor-item-sub">${[r.date, trackName, layoutName].filter(Boolean).map(escapeHtml).join(" · ")} · ${count} driver${
          count === 1 ? "" : "s"
        }</span>
          </span>
          ${
            authed
              ? `<span class="editor-item-actions">
                  <button type="button" class="ef-btn small" data-act="edit-round" data-id="${escapeHtml(r.id)}">Edit</button>
                  <button type="button" class="ef-btn small ghost" data-act="delete-round" data-id="${escapeHtml(r.id)}">Delete</button>
                </span>`
              : ""
          }
        </li>`;
      })
      .join("");
  }

  function renderRoundTrackOptions() {
    const sel = $("#er-track");
    const current = sel.value;
    sel.innerHTML = tracks().length
      ? `<option value="">— no track —</option>` + tracks().map((t) => `<option value="${escapeHtml(t.id)}">${escapeHtml(t.name)}</option>`).join("")
      : `<option value="">— add a track first —</option>`;
    sel.value = tracks().some((t) => t.id === current) ? current : "";
    renderRoundLayoutOptions(sel.value);
  }

  function renderRoundLayoutOptions(trackId, preselectLayoutId) {
    const field = $("#er-layout-field");
    const sel = $("#er-layout");
    const track = tracks().find((t) => t.id === trackId);
    const layouts = track ? track.layouts || [] : [];
    if (!layouts.length) {
      field.hidden = true;
      sel.innerHTML = "";
      return;
    }
    field.hidden = false;
    if (layouts.length === 1) {
      sel.innerHTML = `<option value="${escapeHtml(layouts[0].id)}">${escapeHtml(layouts[0].name)}</option>`;
      sel.value = layouts[0].id;
    } else {
      sel.innerHTML =
        `<option value="">Select layout…</option>` + layouts.map((l) => `<option value="${escapeHtml(l.id)}">${escapeHtml(l.name)}</option>`).join("");
      sel.value = layouts.some((l) => l.id === preselectLayoutId) ? preselectLayoutId : "";
    }
  }

  function renderAttendanceRows(round) {
    const wrap = $("#er-attendance-list");
    if (!drivers().length) {
      wrap.innerHTML = '<p class="ef-empty">Add drivers first.</p>';
      return;
    }
    const lapsById = {};
    (round?.laps || []).forEach((l) => (lapsById[l.driver] = l));
    const attendeesOverride = round?.attendees && round.attendees.length ? new Set(round.attendees) : null;

    wrap.innerHTML = drivers()
      .map((d) => {
        const lap = lapsById[d.id];
        const attended = !!lap || (attendeesOverride ? attendeesOverride.has(d.id) : false);
        return `
        <div class="ef-attend-row" data-driver-id="${escapeHtml(d.id)}">
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

  // Re-renders the attendance list from live data (e.g. a driver was just
  // added/removed elsewhere) without discarding whatever's already been
  // ticked/typed into the round form — otherwise adding a driver while
  // mid-way through building a race would silently wipe that progress.
  function refreshAttendanceRowsPreservingInput() {
    const list = $("#er-attendance-list");
    if (!list) return;
    const preserved = {};
    $$(".ef-attend-row", list).forEach((row) => {
      preserved[row.dataset.driverId] = {
        checked: row.querySelector(".ef-attend-toggle").checked,
        kart: row.querySelector(".ef-attend-kart").value,
        time: row.querySelector(".ef-attend-time").value,
      };
    });
    const editingId = $("#er-editing-id").value;
    const round = editingId ? rounds().find((r) => r.id === editingId) : null;
    renderAttendanceRows(round);
    $$(".ef-attend-row", list).forEach((row) => {
      const prev = preserved[row.dataset.driverId];
      if (!prev) return;
      const toggle = row.querySelector(".ef-attend-toggle");
      if (prev.checked && !toggle.checked) {
        toggle.checked = true;
        row.querySelector(".ef-attend-fields").hidden = false;
      }
      if (prev.kart) row.querySelector(".ef-attend-kart").value = prev.kart;
      if (prev.time) row.querySelector(".ef-attend-time").value = prev.time;
    });
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

  async function handleRoundSubmit(e) {
    e.preventDefault();
    const errEl = $("#er-error");
    clearFormError(errEl);
    if (!requireAuthed(errEl)) return;

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
      const d = drivers().find((x) => x.id === badDriver);
      return formError(errEl, `Lap time for ${d ? d.name : badDriver} doesn't look right (try 00:42.318).`);
    }

    const editingId = $("#er-editing-id").value;
    const id = editingId || uniqueId(slugify(name), rounds().map((r) => r.id));

    const round = { id, name, date };
    if (time) round.time = time;
    if (trackId) round.trackId = trackId;
    if (layoutId) round.layoutId = layoutId;
    round.laps = laps;
    if (hasUntimed) round.attendees = allAttended;

    try {
      await window.fb.setDoc(window.fb.doc(window.db, "rounds", id), round);
      flashStatus("Race saved.");
      clearRoundForm();
    } catch (err) {
      console.error(err);
      formError(errEl, "Save failed: " + (err.message || err));
    }
  }

  async function deleteRound(id) {
    if (!confirm("Delete this race?")) return;
    try {
      await window.fb.deleteDoc(window.fb.doc(window.db, "rounds", id));
      flashStatus("Race deleted.");
      if ($("#er-editing-id").value === id) clearRoundForm();
    } catch (err) {
      console.error(err);
      alert("Delete failed: " + (err.message || err));
    }
  }

  /* ---------- wiring ---------- */

  function refreshListsFromData() {
    renderDriverList();
    renderTrackList();
    renderRoundTrackOptions();
    renderRoundList();
    refreshAttendanceRowsPreservingInput();
  }

  function renderAllEditorSections() {
    refreshListsFromData();
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

  function wireAuthBar() {
    $("#editor-signin").addEventListener("click", async () => {
      try {
        await window.fbSignInWithGoogle();
      } catch (err) {
        if (err && err.code === "auth/popup-closed-by-user") return;
        console.error(err);
        alert("Sign-in failed: " + (err.message || err));
      }
    });
    $("#editor-signout").addEventListener("click", () => window.fbSignOut());
    window.addEventListener("fb-auth-changed", updateAuthUI);
    updateAuthUI();
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
      if (btn.dataset.act === "edit-driver") fillDriverForm(drivers().find((d) => d.id === btn.dataset.id));
      else if (btn.dataset.act === "delete-driver") deleteDriver(btn.dataset.id);
    });
    $("#editor-track-list").addEventListener("click", (e) => {
      const btn = e.target.closest("button[data-act]");
      if (!btn) return;
      if (btn.dataset.act === "edit-track") fillTrackForm(tracks().find((t) => t.id === btn.dataset.id));
      else if (btn.dataset.act === "delete-track") deleteTrack(btn.dataset.id);
    });
    $("#editor-round-list").addEventListener("click", (e) => {
      const btn = e.target.closest("button[data-act]");
      if (!btn) return;
      if (btn.dataset.act === "edit-round") fillRoundForm(rounds().find((r) => r.id === btn.dataset.id));
      else if (btn.dataset.act === "delete-round") deleteRound(btn.dataset.id);
    });
  }

  async function activateEditor() {
    if (initialized) return;
    initialized = true;
    await loadAvatarManifest();
    renderAllEditorSections();
    wireForms();
    wireListActions();
    window.addEventListener("apex-data-changed", refreshListsFromData);
  }

  document.addEventListener("DOMContentLoaded", () => {
    wireSubTabs();
    wireAuthBar();
    const tabBtn = document.querySelector('.tab[data-panel="panel-editor"]');
    if (tabBtn) tabBtn.addEventListener("click", activateEditor);
  });
})();
