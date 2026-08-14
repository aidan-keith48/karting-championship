# Apex Karting League

A static, F1-style championship board for a go-karting friend group. One file drives
everything — `data/season.json` — and the site recomputes the standings, podium,
per-round results and driver posters automatically. No backend, no build step, no
database. Perfect for GitHub Pages.

You don't have to hand-edit that JSON, though: open the site and click the **Editor**
tab. It's a form — matching the rest of the site — for adding/editing drivers, tracks
and races, and it produces an updated `season.json` you drop back into `data/`. See
[Using the Editor tab](#using-the-editor-tab) below. The manual-JSON instructions that
follow are still here as reference for exactly what the editor produces (and as a
fallback if you'd rather just type it by hand).

---

## How the scoring works

1. **Fastest lap sets the grid.** In each round, drivers are ranked by their single
   fastest lap. Quickest = P1, next = P2, and so on.
2. **Points follow the F1 curve.** Position awards points from `scoring.points` in
   `season.json` — by default `25, 18, 15, 12, 10, 8, 6, 4, 2, 1`. Anyone finishing
   outside that list scores 0 for the round. Miss a round entirely = 0 that round.
3. **Fastest lap badge.** Whoever sets the outright quickest lap of a round gets the
   purple **FL** badge (it's always P1, since position *is* fastest lap).
4. **Season Fastest Lap trophy.** The single quickest lap set by anyone all year — shown
   in the hero and marked with an FL chip in the table. This is independent of the
   championship (a P3 driver can hold it).
5. **Ties are broken F1-style (countback):** most points, then most wins, then most 2nds,
   then most 3rds… and if still level, the faster single best lap wins.

Movement arrows (▲ / ▼) in the table compare the standings after the latest round to
the standings after the previous one.

---

## Editing the season (the only file you touch)

Open `data/season.json`.

### Add a driver
Only `id`, `name`, `abbr`, `number`, `team` and `color` are required — everything
else (photo, physical stats, driving style, F1-style attributes) is optional and
just won't render if left out.
```json
{
  "id": "nova",                       // unique, lowercase, no spaces
  "name": "Riley Nova",
  "abbr": "NOV",                      // 2–3 letters, shown as a tag
  "number": 88,
  "team": "Frostbite",
  "color": "#33e0ff",                 // any hex — drives that driver's accent everywhere
  "quote": "Ice in the veins.",       // shown on their poster
  "photo": "assets/drivers/nova.jpg", // drop the file in assets/drivers/ — see below
  "country": "Norway",
  "countryCode": "NO",                // 2-letter ISO code, used to show a 🇳🇴 flag
  "age": 25,
  "heightCm": 174,
  "weightKg": 69,
  "style": "Ice-cold defender",       // free text, shown as a tag on their poster
  "stats": {                          // F1-game style attributes, 0–99 each
    "pace": 85,
    "racecraft": 79,
    "awareness": 88,
    "experience": 60
  }
}
```

**Driver avatars:** the Editor's Drivers form has a picker — click a face, it sets
`photo` to that file's path for you. The gallery comes from
`assets/drivers/manifest.json`: drop a PNG into `assets/drivers/` and add its
filename to that file's `avatars` list to make it choosable. Cut the character out
with a **real transparent background** (actual alpha transparency, not a
checkerboard *pattern* baked into the image — some AI image generators render the
"empty" checker icon as literal pixels instead of transparency, which looks fine in
an image viewer but shows up as a solid grey/white box on the site). The avatar gets
overlaid in front of the driver's number on their poster, driver card, podium spot
and standings row, so a clean cutout matters more than resolution — a few hundred
pixels tall is plenty.

No avatar picked? Leave `photo` out entirely (or just don't pick one in the Editor)
— everything that shows an avatar falls back to the driver's `abbr` in a circle
instead. Nothing breaks either way, and you can still set `photo` to a plain path by
hand if you'd rather manage the file yourself outside the gallery.

### The weight penalty (and what it means for lap times)
Real-world kart rule of thumb: extra ballast costs you lap time. `physics` in
`season.json` controls the maths:
```json
"physics": {
  "weightStepKg": 10,
  "penaltySec": 0.1,
  "refWeightKg": null
}
```
That's "+10kg = +0.1s/lap" by default. Every driver is compared against a reference
weight — leave `refWeightKg` as `null` and the **lightest driver in your roster**
becomes the reference (they show 0 impact, everyone else shows their handicap). Set
`refWeightKg` to a fixed number instead if you'd rather compare against something
fixed, like the kart's minimum ballast weight.

Each driver's poster shows this as two things:
- **Weight impact** — how many extra tenths their `weightKg` is costing them per lap
  versus the reference driver.
- **Pace-adjusted best** — their actual best lap with that handicap subtracted back
  out, so you can see who's genuinely quickest underneath the ballast, not just who's
  lightest.

### Add a track
Your group races at the same venue a lot, but its layout changes often — so tracks and
layouts are their own list, and a round just points at one. Add an object to `tracks`:
```json
{
  "id": "teamsport",
  "name": "TeamSport Circuit",
  "layouts": [
    { "id": "standard", "name": "Standard Layout", "image": "assets/tracks/teamsport-standard.png" },
    { "id": "reverse-club", "name": "Reverse Club Loop", "image": "assets/tracks/teamsport-reverse.png" }
  ]
}
```
`layouts` can be empty (`[]`) for a venue that never changes — a round just won't show
a layout name/drawing for it. `image` is optional per layout; drop the actual drawing
(a photo/scan of your sketch works fine) into `assets/tracks/` and point `image` at it.

### Add a round
Add an object to `rounds`, pointing at a track/layout by id and listing each driver's
best lap — and optionally which kart they were in — for that round.
```json
{
  "id": "r4",
  "name": "Summer Showdown",
  "date": "2025-06-14",               // YYYY-MM-DD
  "time": "19:30",                    // optional, 24h "HH:MM"
  "trackId": "teamsport",             // optional — must match a tracks[].id
  "layoutId": "reverse-club",         // optional — must match a layout id under that track
  "laps": [
    { "driver": "carter", "best": "00:41.402", "kart": 12 },
    { "driver": "nova",   "best": "41.118",     "kart": 7 }
  ]
}
```
`driver` must match a driver `id`. That's it — save, refresh, standings update.

**Lap time formats accepted:** `"00:42.318"`, `"42.318"`, `"1:02.5"`, or a raw number
of milliseconds. Commas work as decimals too (`"42,318"`).

**Best kart of the round:** worked out automatically — it's whichever kart number
the round winner (fastest lap) was driving, shown as a badge on the round card. No
extra field to fill in; just make sure each `laps` entry has a `kart` number.

**Who attended:** by default, "attended" = everyone with a `laps` entry for that
round. If someone showed up but didn't set a time (DNF, no-show on the sheet, etc.)
and you still want them listed, add an explicit `attendees` array of driver ids to
the round — it overrides the default and should list *everyone* who attended
(timed or not):
```json
"attendees": ["carter", "rivera", "nova"]
```

Rounds don't need to be added in date order — the site always sorts by `date`/`time`
before computing standings, so an out-of-order entry can't corrupt the table.

### Change how many positions score
Edit `scoring.points`. Fewer entries = fewer paying positions. Want everyone who shows up
to score? Make the array longer. Example (top-5 only):
```json
"points": [10, 6, 4, 2, 1]
```

---

## Using the Editor tab

Open the site and click **Editor**. Three sections — Drivers, Tracks, Races — each
with a form (matching the site's look) and a list of what you've already added, with
Edit/Delete on every item.

- **You see what you add, right away.** Standings/Rounds/Drivers update live as you
  edit — a banner appears under the hero whenever you're looking at that local data
  ("Showing local Editor data… unpublished, only visible in this browser") so it's
  always clear it's a draft. Nobody else sees it until you export and swap the file
  in. Edits also autosave to this browser only, so a refresh or an accidental
  tab-close doesn't lose work — reopening the Editor tab offers to restore that draft.
- **Driver avatars are a picker, not an upload** — see [Driver avatars](#add-a-driver)
  above. **Track layout drawings** still need a file: either upload one (it gets
  embedded directly in the exported `season.json`, no separate file to manage) or
  point at a path you're keeping in `assets/tracks/` yourself.
- **When you're ready, use the export bar at the bottom:**
  - **Save to file…** (Chrome/Edge) — pick `data/season.json` once, and every click
    after that writes straight back to it.
  - **Download season.json** — works everywhere; downloads the file, and you move it
    into `data/season.json` yourself.
  - **Import JSON…** to load an existing `season.json` back in and keep editing it
    later, on this or another browser.
- Deleting a driver/track/layout that's still used by a race will ask you to confirm
  and then cleans up the reference for you rather than leaving something dangling.

---

## Preview it locally

Because the page reads `season.json`, you can't just double-click `index.html`
(browsers block reading local files over `file://`). Serve it instead:

```bash
cd karting-championship
python3 -m http.server 8000
```
Then open <http://localhost:8000>. Any static server works.

---

## Deploy to GitHub Pages

1. Create a repo and push these files (keep the folder structure).
2. Repo **Settings → Pages**.
3. **Source:** Deploy from a branch → `main` → `/ (root)` → Save.
4. Wait a minute; your board is live at `https://<you>.github.io/<repo>/`.

On GitHub Pages the files are served over HTTPS, so `season.json` loads fine — no server
setup needed.

---

## Files

```
index.html             page shell (tabs + poster modal + editor panel)
assets/css/style.css   the racing theme
assets/css/editor.css  Editor tab styling
assets/js/app.js       scoring engine + rendering (public tabs)
assets/js/editor.js    Editor tab logic (forms, export/import, autosave)
assets/drivers/        driver avatars + manifest.json (the Editor's picker gallery)
assets/tracks/         track layout drawings — drop scans/photos here
data/season.json       ← what you're ultimately editing, by hand or via the Editor tab
```
