# `/5A` animation module handoff

Last updated: 26 August 2026

This document is the working handoff for the animation module in Scribble. It
describes the state that is currently deployed, how `/5A` relates to the drawing
and gallery pages, where the data comes from, how each animation works, and the
constraints that should be preserved when extending it.

## Start here

- Repository: `https://github.com/anandmacwan123-tech/scribble`
- Continue from branch: `codex/5a-animation`
- Current branch commit: `c185244ee2fdeba0fa86ec42ad31eca7f387c683`
- Live module: `https://scribble.anandmacwan123.workers.dev/5A`
- Cloudflare Worker: `scribble`
- Current deployed version at the time of this handoff:
  `22840c86-7657-458d-99eb-d1b08cc963ce`
- Production D1 database: `scribble-db`
- D1 binding: `DB`

Important: do not start new animation work from `origin/main`. The complete
animation module and the restored A4 drawing-page baseline are on
`codex/5a-animation`. At the time of writing, `origin/main` points to `6015fcb`
and does not contain the current `/5A` work. There is also a local `main` branch
at `a0bb954`; it is not the deployed animation branch.

The worktree was clean when this document was created, before adding this file.

## Product overview

Scribble has three user-facing pages:

1. `/` is the A4 portrait drawing page. A visitor draws one or more marks on a
   595 × 842 SVG surface and submits the full sheet.
2. `/5` is the kept-drawings gallery. It lists every stored submission, supports
   selecting and downloading SVGs, and contains the destructive delete-all
   control.
3. `/5A` is the animation tool. It reads every stored submission as a separate
   layer and produces a live canvas animation and an MP4 preview/download. It
   does not save, update, or delete drawings.

The core relationship is:

```text
/ drawing page
    |
    | POST /api/drawings
    v
Cloudflare Worker -> canonical A4 SVG -> D1 drawings table
                                           |
                       GET /api/drawings   |
                         + SVG endpoints   |
                        /                  \
                       v                    v
                /5 gallery              /5A animator
```

`/5` and `/5A` do not share React state. They independently request the same API.
Selecting a drawing in `/5` does not control the layers in `/5A`; `/5A` always
loads the complete saved library and maintains its own local visibility set.

There is deliberately no `/5A` link on `/5` at present. `/5A` has a back arrow
to `/5`, but the animation route is otherwise reached directly. A rendered HTML
test explicitly checks that `/5` does not contain an animation-tool link, so
adding one is a product decision and requires updating that test.

## Source map

### Animation module

- `app/5A/page.tsx`
  - Route entry and metadata only.
  - Renders the client component.
- `app/5A/Animator.tsx`
  - Owns all animation state, synchronization, layer loading, canvas drawing,
    uploaded image handling, transport controls, MP4 generation, preview, and
    layer UI.
- `app/5A/grid.ts`
  - Builds deterministic seeded timelines with independent dwell times for every
    masked region (grid cell or slice).
- `app/5A/masks.ts`
  - Builds the 50 mask rectangles used by Grid and Slice.
  - Grid is 5 × 10; Slice is 50 horizontal or vertical strips.
- `app/5A/fit.ts`
  - Computes an aspect-preserving `contain` rectangle for SVG/raster layers.
  - This is the fix that prevents A4 drawings and uploads from being squashed.
- `app/5A/style.ts`
  - Validates and normalizes SVG stroke width and colour.
  - Rewrites every canonical SVG `stroke` and `stroke-width` attribute.
- `app/globals.css`
  - Animation styles begin at `.animator-page`.
  - The selectors are scoped so the black `/5A` UI does not recolour `/` or `/5`.

### Shared data and related pages

- `app/Scribble.tsx`
  - Home drawing UI, undo/redo/clear/submit, zoom, and recent-submission previews.
- `app/gesture.ts`
  - Canonical A4 dimensions and pointer-to-canvas coordinate conversion.
- `app/history.ts`
  - Pure undo/redo helpers.
- `app/5/Gallery.tsx`
  - Loads every drawing through paginated API calls, provides selection, ZIP
    download, and delete-all UI.
- `worker/index.ts`
  - API validation, canonical SVG construction, preview/download responses,
    pagination, ZIP generation, deletion, and routing into the vinext app.
- `db/drawings.ts`
  - D1 reads and writes.
- `db/schema.ts` and `migrations/`
  - `drawings` table definition and its `(created_at DESC, id DESC)` index.
- `wrangler.jsonc`
  - Worker, D1, rate-limit, asset, and observability configuration.

### Tests most relevant to `/5A`

- `tests/rendered-html.test.mjs`
  - Route smoke tests plus structural assertions for animation constants,
    controls, export, colours, and A4 sizing.
- `tests/grid-animation.test.mjs`
  - Independent dwell times and seeded randomness.
- `tests/image-fit.test.mjs`
  - A4 and non-A4 aspect-ratio preservation.
- `tests/svg-style.test.mjs`
  - Stroke colour validation and two-decimal 0–10 px width clamping.

## Stored drawing model

Every accepted drawing is stored in D1 as one canonical server-generated SVG:

```text
drawings
- id          TEXT PRIMARY KEY (UUID)
- svg         TEXT NOT NULL
- width       INTEGER NOT NULL
- height      INTEGER NOT NULL
- created_at  INTEGER NOT NULL
- updated_at  INTEGER NOT NULL
```

The current canonical size is A4 portrait, `595 × 842`. The drawing page uses
those same viewBox dimensions. The API still accepts the previous landscape A4
size (`842 × 595`) and the legacy canvas (`1000 × 700`) so old clients/data remain
compatible. The Worker contains and centres those coordinates onto the canonical
portrait A4 page before storage.

The Worker builds the SVG itself from validated numeric points. Client-provided
SVG/markup is never stored. All strokes on a submitted sheet are combined into a
single `<path>` containing multiple `M` subpaths. The stored default is a 1 pt
`#171713` rounded stroke with no canvas grid or UI decoration.

`upsertDrawing()` currently uses `ON CONFLICT(id) DO NOTHING`. Reposting an
existing UUID does not modify that row and does not advance `updated_at`. This is
intentional data-retention behaviour; do not casually change it to `DO UPDATE`.

The backend no longer performs “five shape” detection. Any valid, sufficiently
long mark can be kept even though the UI language calls submissions fives.

## API contract consumed by `/5A`

`GET /api/drawings?limit=100&cursor=...` returns newest-first metadata:

```ts
{
  drawings: Array<{
    id: string;
    width: number;
    height: number;
    createdAt: string;
    updatedAt: string;
    previewUrl: string;
    downloadUrl: string;
  }>;
  nextCursor: string | null;
}
```

The cursor is `created_at:id`. `/5A` follows every cursor until it has loaded the
entire library. Do not replace this with a single request: the server caps a page
at 100 entries.

For each item, `/5A` fetches `previewUrl` with `cache: "no-store"` and adds
`v=<updatedAt>` to the URL. The preview endpoint returns a canonical A4 SVG with
a visually stable preview stroke. `/5A` then rewrites that trusted server SVG in
memory for the selected animation stroke colour and width.

The list and SVG responses use `cache-control: no-store`. SVG responses are also
sandboxed, same-origin, and generated by the Worker.

## Synchronization and layer lifecycle

`Animator.sync()` is responsible for keeping the animation library current.

- It runs immediately after mount.
- It runs every 10 seconds (`SYNC_INTERVAL_MS = 10_000`).
- It runs when the window regains focus.
- It runs when the document becomes visible again.
- The user can trigger it with the `sync` button.
- Only one synchronization runs at a time.
- A new synchronization aborts the previous request controller.
- Drawings are fetched in all paginated batches.
- SVG/image layers are loaded with concurrency 8.
- The cache is keyed by drawing ID.
- An unchanged `updatedAt` reuses the existing layer and object URLs.
- New or changed rows are fetched and rasterized.
- Removed rows are released and removed from the hidden-layer set.
- Every obsolete Blob URL is revoked.
- Any layer change invalidates an encoded MP4 preview.

This means a normal refresh and the automatic sync both account for new and
removed submissions without touching existing D1 records.

The order in `/5A` is the API order: newest `created_at` first, then descending
ID for timestamp ties. Labels such as `five 001` are positional and can change
when a newer drawing appears; they are not persistent names.

## Canvas and sizing invariants

- Live preview canvas: `595 × 842`.
- MP4 display/export size: `1190 × 1684` (exactly 2× in each dimension).
- Aspect ratio: `595 / 842`, A4 portrait.
- Artwork/export background: pure white `#FFFFFF`.
- `/5A` UI chrome: pure black `#000000` with white text/controls.
- Layer thumbnails have white backgrounds.
- The CSS sizes the live paper responsively but never changes its ratio.
- Every source image is drawn with `containImageRect()` and centred. It is never
  stretched or cropped.

Keep preview dimensions and export dimensions conceptually separate. Increasing
export resolution should not enlarge the on-screen A4 paper. `ENCODE_WIDTH` and
`ENCODE_HEIGHT` round up to an even number for AVC compatibility; VideoFrame
`displayWidth`/`displayHeight` preserve the intended export dimensions.

The grid rule is 1 canvas pixel in the preview and scales to 2 pixels at the 2×
export size. The fives themselves stay fully opaque in grid modes.

## Effects

### Blink

- Uses the stored SVG layer library.
- Draws every visible layer in solid `#CCCCCC` at 100% opacity.
- Draws one active layer over them in the chosen stroke colour.
- Advances one layer at a time.
- Each frame lasts the user-entered speed value.
- Default speed is 300 ms.

The grey is not “black at 20% opacity.” It must remain the literal hex colour
`#CCCCCC` at full opacity.

### Solo

- Uses the stored SVG layer library.
- Draws only one visible layer at a time on white.
- There are no grey background layers.
- Each frame lasts the user-entered speed value.

### Grid v1

- Uses the stored SVG layer library and its current visibility selection.
- Divides the A4 page into 5 columns × 10 rows (50 cells).
- Every cell clips the same full-page layer at that cell boundary. The drawing is
  not resized or repositioned per cell; only a different layer is revealed.
- Every cell has its own independently randomized dwell time.
- Dwell range is `speedMs` through `speedMs * 2`, inclusive after rounding. With
  the default 300 ms speed, each cell remains for 300–600 ms.
- A cell always changes to a different layer when at least two layers exist.
- The timeline is deterministic for a given layer list and seed.
- Entering a grid mode or restarting increments the seed, producing a fresh
  pattern.
- The grid opacity control changes only the grid-line alpha from 0–100%. It does
  not change the opacity of any five.

### Grid v2

- Uses local user-uploaded raster/image files instead of stored SVG submissions.
- Uses the same 5 × 10 clipping and randomized timing logic as Grid v1.
- Multiple images can be selected at once.
- Non-image MIME types are ignored; any load failure rejects that upload batch.
- Upload loading concurrency is 4.
- Uploaded images preserve their native aspect ratio and are contained/centred
  on the A4 page before the grid masks are applied.
- Uploaded images are held only in browser memory as object URLs.
- They are never sent to the Worker or D1.
- They disappear on refresh/navigation.
- They can be removed individually or cleared together.
- Stroke width and stroke colour controls are hidden because raster uploads
  cannot be restyled as SVG paths.

Persisting Grid v2 images would be a new backend/storage feature, not a small UI
change. It should not be implemented by putting blobs into the existing
`drawings.svg` column.

### Slice v1

- Uses the stored SVG layer library and its current visibility selection.
- Divides the A4 page into 50 equal strips.
- Direction is user-selectable: horizontal is the default, and vertical is the
  alternative.
- Every strip clips the same full-page layer at its strip boundary. The drawing
  keeps its A4 position and size; only the visible layer changes per strip.
- Each strip changes independently using the same seeded randomized timeline as
  Grid v1.
- Dwell range is `speedMs` through `speedMs * 2`.
- The slice opacity control affects only the 49 direction-matched divider lines. It does
  not affect the fives.
- SVG stroke width and colour controls apply normally.

### Slice v2

- Uses the same local uploaded-image library as Grid v2.
- Uses the same 50 user-directed masks and timing as Slice v1.
- Uploads remain aspect-preserved, centred, browser-local, and ephemeral.
- Switching between Grid v2 and Slice v2 reuses the current uploaded image set.
- Stroke controls are hidden because the uploaded layers are raster images.
- The slice opacity control changes divider lines only.

## Animation controls

- Speed accepts integer milliseconds and is clamped to 50–5000 ms on blur/use.
- Stroke width accepts 0.00–10.00 px in 0.01 increments and is rounded to two
  decimal places.
- Stroke colour accepts only a six-digit hex value (`#RRGGBB`) and normalizes it
  to uppercase. Default/fallback is `#171713`.
- Stroke changes rebuild the black/colour and grey Blob-backed SVG images for
  every stored layer, concurrently, then release the previous URLs.
- Stroke controls affect Blink, Solo, and Grid v1, including their exports.
- Grid/slice divider opacity is shown only in the four masked modes. Its label
  follows the selected geometry.
- Slice v1/v2 show a direction control. Changing direction resets the live frame
  and invalidates any encoded preview.
- Pause/play stops or resumes frame progression.
- Restart returns to frame zero; in grid modes it also creates a new randomized
  timeline.
- Hiding all stored layers also pauses playback.
- Any change that makes an existing encoded preview stale discards it and
  revokes its URL.

## Rendering details

`drawFrame()` is the single renderer used by both the live canvas and MP4 export.
Keeping a single rendering path is important: a new effect should not have a
separate visual implementation for preview and export.

Inputs to `drawFrame()` are:

- 2D canvas context
- active animation layers
- mode
- frame index
- grid timeline
- grid-line opacity
- optional render width/height

It always clears/fills the complete frame white first. If there are no layers,
the result remains a blank white frame.

Each stored layer has two preloaded images:

- `image`: chosen user stroke colour/width
- `greyImage`: `#CCCCCC` with the same width

Grid v2 and Slice v2 layers have only `image`.

## MP4 pipeline

MP4 encoding happens entirely in the browser after the user chooses
`preview mp4`.

1. Create a `1190 × 1684` export canvas.
2. Draw each frame through `drawFrame()`.
3. Copy it to the even-dimension encoder canvas.
4. Create `VideoFrame` objects with microsecond timestamps/durations.
5. Encode AVC through the browser WebCodecs `VideoEncoder`.
6. Mux MP4 in memory with `mediabunny`.
7. Create a Blob URL and place a looping, muted `<video>` over the A4 canvas.
8. The user inspects the animation, then explicitly downloads it.

Current video settings:

- Container: MP4
- Codec: AVC
- Bitrate: 16 Mbps
- Keyframe interval: 2 seconds
- Fast start: in-memory
- MIME type: `video/mp4`
- Filename: `5A-<mode>-1190x1684.mp4`

Blink and Solo export one frame per active layer, each lasting `speedMs`. Grid
and Slice export every frame of the generated timeline using the timeline's
individual durations. The overall mask timeline duration is the greater of the
maximum dwell and `layerCount * minimumDwell`; large layer sets therefore create
longer masked exports.

Encoding is unsupported when `VideoEncoder` is unavailable. The UI shows an
explicit unsupported message; there is no server-side export fallback.

The preview URL is generation-guarded so an old asynchronous encode cannot
replace a newer state. Blob URLs are revoked when discarded and on unmount.

## Relationship to `/` and `/5`

### `/` drawing page

- Uses the same `595 × 842` coordinate system as `/5A`'s live canvas.
- Shows a 10% dot grid and zoom only in the editor; neither is stored.
- Supports multiple strokes, undo, redo, clear, zoom, pointer input, and keyboard
  drawing.
- Samples/limits points before POSTing to the API.
- After a successful submit, refreshes its three recent previews and resets the
  editor for a new sheet.
- The Worker, not the client, is responsible for canonical SVG output.

Do not “fix” animation dimensions by changing the home canvas. Both already use
the current portrait A4 coordinate system.

### `/5` gallery

- Loads all drawings using the same 100-item cursor pagination as `/5A`.
- Selection exists only for gallery ZIP downloads.
- Maximum bulk selection/download is 500.
- `POST /api/drawings/download` creates an uncompressed SVG ZIP in the Worker.
- `DELETE /api/admin/drawings` deletes every production drawing after the exact
  text `CONFIRM`, same-origin validation, and rate limiting.

The delete-all endpoint is the only existing feature that clears the library.
Never use it during animation development or testing against production.

## Data-safety rules

The animation module must remain read-only with respect to stored submissions.
Normal `/5A` work should only call:

- `GET /api/drawings`
- `GET /api/drawings/:id.svg?preview=1`

Before and after a production deployment, verify the exact D1 row fingerprint:

```bash
WRANGLER_LOG_PATH=.wrangler/wrangler.log npm exec -- wrangler d1 execute scribble-db --remote --command "SELECT COUNT(*) AS drawing_count, group_concat(id || ':' || created_at || ':' || updated_at, '|') AS fingerprint FROM (SELECT id, created_at, updated_at FROM drawings ORDER BY id)" --json
```

Compare both the count and the full fingerprint, not only the count. At the last
deployment check there were 33 drawings, and the complete pre/post fingerprint
was identical. That count is historical context, not a permanent expectation;
new submissions can arrive at any time.

Deploy with `--keep-vars` so dashboard-managed state/configuration is retained.
Do not recreate, replace, delete, or migrate `scribble-db` for a frontend-only
animation change.

## Local development

Requirements:

- Node.js `>=22.13.0`
- npm lockfile install
- Wrangler 4.x (the repository currently pins 4.92.0)

Setup:

```bash
npm ci
npm exec -- wrangler d1 migrations apply scribble-db --local
npm run dev
```

Useful routes:

- `http://localhost:3000/`
- `http://localhost:3000/5`
- `http://localhost:3000/5A`

The Vite config deliberately uses polling inside the Codex Seatbelt sandbox and
keeps Wrangler/Miniflare state under `.wrangler/`.

## Required checks

Run all of these before committing:

```bash
npm run typecheck
npm run lint
npm test
```

`npm test` runs a production build first and then the Node test suites. At the
time of this handoff, all 35 tests passed.

For visual verification, check at least:

- `/5A` chrome computes to `rgb(0, 0, 0)`.
- `.animation-paper` computes to `rgb(255, 255, 255)`.
- The paper remains portrait A4 at desktop and mobile widths.
- A stored A4 five is not stretched.
- Blink uses literal `#CCCCCC` grey.
- Grid opacity changes lines only.
- Slice renders 50 equal strips in the chosen direction; slice opacity changes
  lines only.
- Grid v2 keeps a landscape and a portrait upload in their original ratios.
- Slice v2 reuses uploads without changing their position or aspect ratio.
- A generated MP4 preview plays before download.
- The MP4 preview accessibility label reports `1190 by 1684`.
- New saved entries appear after sync without reloading `/5A`.

## Git and deployment workflow

Continue on `codex/5a-animation` unless the user explicitly asks to merge or
rebase. Preserve unrelated local changes and stage exact paths only.

Recommended sequence:

```bash
git status --short --branch
npm run typecheck
npm run lint
npm test
git diff --check
git add -- <exact changed paths>
git diff --cached --check
git commit -m "<focused message>"
git push origin codex/5a-animation
```

Then perform the D1 predeploy fingerprint, verify Wrangler, dry-run, and deploy:

```bash
WRANGLER_LOG_PATH=.wrangler/wrangler.log npm exec -- wrangler --version
WRANGLER_LOG_PATH=.wrangler/wrangler.log npm exec -- wrangler deploy --dry-run --strict --keep-vars
WRANGLER_LOG_PATH=.wrangler/wrangler.log npm exec -- wrangler deploy --strict --keep-vars
```

Run the identical D1 fingerprint query after deployment and test the live route.

The Worker deploy uses vinext's redirected generated configuration under
`dist/server/wrangler.json`, with `wrangler.jsonc` as the project source config.
The Worker has these production bindings:

- `env.DB` -> `scribble-db`
- `env.SUBMISSION_RATE_LIMITER` -> 12 requests per 60 seconds
- `env.ASSETS` -> static assets

## Known pitfalls

1. **Do not stretch layers.** Drawing the image directly to a target rectangle
   without `containImageRect()` caused the original “squished fives” bug.
2. **Do not treat grid opacity as artwork opacity.** It controls only the grid
   stroke. Fives remain 100% opaque.
3. **Do not implement Blink grey with alpha.** The requirement is solid
   `#CCCCCC`, not 20% black.
4. **Do not use only the first API page.** The layer library must include every
   saved drawing.
5. **Do not merge Grid v2 uploads into D1 implicitly.** They are private local
   working inputs and currently ephemeral.
6. **Do not apply SVG stroke controls to raster uploads.** Those controls only
   make sense for the canonical SVG library.
7. **Do not create separate preview/export renderers.** Changes can easily make
   preview and downloaded video disagree; extend `drawFrame()` instead.
8. **Do not forget MP4 invalidation.** Layer, mode, speed, stroke, opacity,
   upload, or grid-seed changes must discard a stale encoded preview.
9. **Do not leak Blob URLs.** Release replaced SVG layers, uploaded images, and
   MP4 previews.
10. **Do not assume WebCodecs everywhere.** Preserve the unsupported state unless
    a real fallback is implemented.
11. **Do not deploy from `origin/main` as it stands.** It lacks this module's
    current commit chain.
12. **Do not use the gallery delete-all control in production verification.**
13. **Do not turn Slice into 50 resized thumbnails.** Every strip clips a
    full-page, aspect-preserved layer at its native A4 position.

## Extending the module safely

To add an effect:

1. Add its literal to `AnimationMode`.
2. Add its button label to `EFFECTS`.
3. Define whether it uses stored SVG layers or uploaded layers.
4. Add its visual branch to `drawFrame()`.
5. Define its timer delay in the playback effect.
6. Define its frame count and frame durations in `previewAnimation()`.
7. Decide which controls apply to it.
8. Ensure all relevant state changes invalidate the MP4 preview.
9. Add pure helper tests where possible and structural/render tests where needed.
10. Verify live preview and MP4 output visually.

If changing grid/slice timing, prefer changing/testing `buildGridTimeline()` rather
than adding ad hoc random calls inside `drawFrame()`. Seeded timelines keep live
playback and exported playback consistent.

If changing layer data, preserve ID-based caching, abort handling, bounded
concurrency, pagination, and object URL cleanup. The current implementation was
designed to tolerate a library that grows beyond 100 submissions.

If adding persistence or collaboration, treat it as a separate backend design:
define ownership, storage limits, file validation, retention, access control,
schema/migrations, and how it coexists with the public saved-drawing library.

## Recent animation commit history

The feature was built in this order, which helps explain several intentional
decisions:

```text
220d425 Add 5A animation tool
06dd94d Refine 5A portrait MP4 export
0a8bc38 Add MP4 preview before animation download
5a22f0a Restore gallery and preserve native animation layers
eaff6ff Merge latest A4 canvas baseline
460354a Keep 5A preview at exact A4 ratio
8acd34e Randomize grid cell animation timing
673678a Add animation speed and grid opacity controls
3a6af39 Add uploaded-image grid animation
f735ae9 Add animation stroke controls
c185244 Double animation export resolution
```

The merge at `eaff6ff` is significant: it brought the current portrait A4 home
canvas/history work from the `b053b99` line into the animation branch without
discarding the already-built `/5A` implementation.

## Current product decisions to preserve unless the user changes them

- A4 portrait everywhere that represents a submitted sheet.
- White canvas and white exported video background.
- Pure black animation UI.
- Preview before download; no immediate blind export.
- MP4 output rather than GIF/WebM.
- 2× export resolution (`1190 × 1684`).
- Stored submissions automatically sync into separate SVG layers.
- Grid v1 uses stored layers; Grid v2 uses local image uploads.
- Grid mask is 5 × 10.
- Slice v1 uses stored layers; Slice v2 uses the same local image uploads.
- Slice mask is 50 equal horizontal or vertical strips, chosen in the UI.
- Grid-cell/slice dwell range is 1×–2× the entered speed.
- Grid and slice opacity affect divider lines only.
- Stroke controls apply to SVG fives only.
- Existing saved data must survive every deploy.
