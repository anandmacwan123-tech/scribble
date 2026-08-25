import assert from "node:assert/strict";
import { access, readFile } from "node:fs/promises";
import test from "node:test";
import { strFromU8, unzipSync } from "fflate";

const projectRoot = new URL("../", import.meta.url);

async function loadWorker() {
  const workerUrl = new URL("../dist/server/index.js", import.meta.url);
  workerUrl.searchParams.set("test", `${process.pid}-${Date.now()}-${Math.random()}`);
  return (await import(workerUrl.href)).default;
}

function executionContext() {
  return {
    waitUntil() {},
    passThroughOnException() {},
  };
}

function makeEnv({ onRun = () => {}, onAll, onFirst, onLimit } = {}) {
  return {
    ASSETS: {
      fetch: async () => new Response("Not found", { status: 404 }),
    },
    DB: {
      prepare(sql) {
        let values = [];
        const statement = {
          bind(...nextValues) {
            values = nextValues;
            return statement;
          },
          async run() {
            return (
              (await onRun({ sql, values })) ?? {
                success: true,
                meta: { changes: 1 },
              }
            );
          },
          async all() {
            return {
              success: true,
              results: (await onAll?.({ sql, values })) ?? [],
            };
          },
          async first() {
            return (await onFirst?.({ sql, values })) ?? null;
          },
        };
        return statement;
      },
    },
    SUBMISSION_RATE_LIMITER: {
      async limit(options) {
        return { success: (await onLimit?.(options)) ?? true };
      },
    },
  };
}

function drawingPayload() {
  return {
    id: "11111111-1111-4111-8111-111111111111",
    width: 595,
    height: 842,
    strokes: [
      [
        { x: 500, y: 100 },
        { x: 430, y: 100 },
      ],
      [
        { x: 430, y: 100 },
        { x: 430, y: 190 },
      ],
      [
        { x: 430, y: 190 },
        { x: 500, y: 190 },
      ],
      [
        { x: 500, y: 190 },
        { x: 500, y: 280 },
      ],
      [
        { x: 500, y: 280 },
        { x: 430, y: 280 },
      ],
    ],
  };
}

test("renders the quiet drawing surface with the supplied typeface", async () => {
  const worker = await loadWorker();
  const response = await worker.fetch(
    new Request("http://localhost/", { headers: { accept: "text/html" } }),
    makeEnv(),
    executionContext(),
  );

  assert.equal(response.status, 200);
  assert.match(response.headers.get("content-type") ?? "", /^text\/html\b/i);

  const html = await response.text();
  assert.match(html, /<title>Draw a 5<\/title>/i);
  assert.match(html, /Draw a 5\./);
  assert.match(html, /<button[^>]*aria-label="Undo"[^>]*disabled[^>]*>/);
  assert.match(html, /<button[^>]*aria-label="Redo"[^>]*disabled[^>]*>/);
  assert.match(html, />Clear all<\/button>/);
  assert.match(html, /<button[^>]*disabled[^>]*>Submit<\/button>/);
  assert.doesNotMatch(html, /Begin high|Travel left|fall straight|Sweep back/i);
  assert.doesNotMatch(html, /codex-preview|react-loading-skeleton/i);

  const css = await readFile(new URL("../app/globals.css", import.meta.url), "utf8");
  const client = await readFile(new URL("../app/Scribble.tsx", import.meta.url), "utf8");
  const gesture = await readFile(new URL("../app/gesture.ts", import.meta.url), "utf8");
  const gallery = await readFile(new URL("../app/5/Gallery.tsx", import.meta.url), "utf8");
  assert.match(css, /Futura-Regular\.woff2/);
  assert.doesNotMatch(css, /Futura-Bold\.woff2|font-weight:\s*(?:[5-9]00|bold)/);
  assert.match(css, /\.instruction\s*{[^}]*bottom:[^}]*left:\s*50%[^}]*text-align:\s*center/s);
  assert.match(css, /aspect-ratio:\s*595\s*\/\s*842/);
  assert.match(css, /\.canvas-stage\s*{[^}]*--canvas-inline-width:\s*calc\(100vw\s*-\s*32px\)[^}]*70\.66508314dvh[^}]*box-shadow:\s*0 0 0 1pt rgba\(23, 23, 19, 0\.05\)/s);
  assert.match(css, /@media \(max-width:\s*600px\)[\s\S]*?\.canvas-stage\s*{[^}]*top:\s*calc\(50%\s*-\s*34px\)[^}]*70\.66508314dvh\s*-\s*144\.157px/s);
  assert.match(css, /\.dot-grid\s*{[^}]*opacity:\s*0\.1/s);
  assert.match(css, /\.recent-submissions\s*{[^}]*right:[^}]*width:[^}]*transform:\s*translateY\(-50%\)/s);
  assert.match(css, /\.recent-submission\s*{[^}]*aspect-ratio:\s*595\s*\/\s*842/s);
  assert.match(css, /\.recent-submissions\s*{[^}]*pointer-events:\s*none/s);
  assert.match(css, /@media \(max-width:\s*700px\), \(max-aspect-ratio:\s*3\s*\/\s*4\)[\s\S]*?--canvas-inline-width:\s*calc\(100vw\s*-\s*104px\)/s);
  assert.match(css, /vector-effect:\s*non-scaling-stroke/);
  assert.match(gesture, /MIN_STROKE_TRAVEL = 8/);
  assert.doesNotMatch(gesture, /hasReachedPrompt|hasDetectedFive|getFiveProgress/);
  assert.match(gesture, /function clientPointToCanvas/);
  assert.doesNotMatch(client, /AUTO_ADVANCE_TRAVEL|IDLE_ADVANCE_MS/);
  assert.doesNotMatch(client, /const prompts|eraser/i);
  assert.match(client, /Draw a 5\./);
  assert.match(client, /Clear all/);
  assert.match(client, /Undo/);
  assert.match(client, /Redo/);
  assert.match(client, /M5\.82843 6\.99955L8\.36396 9\.53509/);
  assert.match(client, /M18\.1716 6\.99955H11/);
  assert.match(client, /undoStroke\(strokesRef\.current, redoStrokesRef\.current\)/);
  assert.match(client, /redoStroke\(strokesRef\.current, redoStrokesRef\.current\)/);
  assert.match(client, /fetch\("\/api\/drawings\?limit=3"/);
  assert.match(client, /result\.drawings\.slice\(0, 3\)/);
  assert.match(client, /recentControllerRef\.current\?\.abort\(\)/);
  assert.match(client, /recentControllerRef\.current !== controller/);
  assert.match(client, /aria-label="Recent submission previews"/);
  assert.doesNotMatch(client, /className="recent-submission"[\s\S]*?href="\/5"/);
  assert.match(client, /refreshRecentDrawings\(\);\s*resetDrawing\(\);/);
  assert.match(client, /disabled={submitDisabled}/);
  assert.match(client, /const canvasViewBox/);
  assert.match(client, /Submit available\./);
  assert.doesNotMatch(client, /hasFive|hasDetectedFive|Five detected/);
  assert.match(client, /saveControllerRef\.current\?\.abort\(\)/);
  assert.match(gallery, /const MAX_BULK_SELECTION = 500;/);
  assert.match(gallery, /toggleAll|allSelected/);
  assert.match(gallery, /while \(cursor\)/);
  assert.match(gallery, /\/api\/admin\/drawings/);
  assert.match(gallery, /confirmation !== "CONFIRM"/);
  assert.match(gallery, /Type CONFIRM to continue\./);
  assert.match(gallery, /<dialog/);
  assert.match(gallery, /deleteFocusTargetRef\.current = "status"/);
  assert.match(gallery, /deleteStatusRef\.current\?\.focus\(\)/);
  assert.doesNotMatch(client, /failedAttempts|previousEnd|mark--rejected/);
  await access(new URL("../public/fonts/Futura-Regular.woff2", import.meta.url));
  await assert.rejects(access(new URL("../app/_sites-preview", import.meta.url)));
});

test("renders the saved drawing gallery", async () => {
  const worker = await loadWorker();
  const response = await worker.fetch(
    new Request("http://localhost/5", { headers: { accept: "text/html" } }),
    makeEnv(),
    executionContext(),
  );

  assert.equal(response.status, 200);
  const html = await response.text();
  assert.match(html, /<title>Kept<\/title>/i);
  assert.match(html, />kept\.<\/h1>/i);
  assert.match(html, /download/i);
  assert.match(html, /delete all/i);
  assert.match(html, /Type CONFIRM to continue\./);
  assert.doesNotMatch(html, /animation tool|href="\/5A"/i);
});

test("renders the 5A animation tool", async () => {
  const worker = await loadWorker();
  const response = await worker.fetch(
    new Request("http://localhost/5A", { headers: { accept: "text/html" } }),
    makeEnv(),
    executionContext(),
  );

  assert.equal(response.status, 200);
  const html = await response.text();
  assert.match(html, /<title>5A — Animation<\/title>/i);
  assert.doesNotMatch(html, /animation tool/i);
  assert.match(html, /blink/i);
  assert.match(html, /solo/i);
  assert.match(html, /grid/i);
  assert.match(html, /speed/i);

  const animator = await readFile(
    new URL("../app/5A/Animator.tsx", import.meta.url),
    "utf8",
  );
  assert.match(animator, /const DEFAULT_SPEED_MS = 300;/);
  assert.match(animator, /const WIDTH = 595;/);
  assert.match(animator, /const HEIGHT = 842;/);
  assert.match(animator, /const EXPORT_WIDTH = WIDTH \* 2;/);
  assert.match(animator, /const EXPORT_HEIGHT = HEIGHT \* 2;/);
  assert.match(animator, /const ENCODE_WIDTH = EXPORT_WIDTH \+ \(EXPORT_WIDTH % 2\);/);
  assert.match(animator, /const BACKGROUND = "#FFFFFF";/);
  assert.match(animator, /const GREY = "#CCCCCC";/);
  assert.match(animator, /const GRID_COLUMNS = 5;/);
  assert.match(animator, /const GRID_ROWS = 10;/);
  assert.match(animator, /aria-label="Animation speed in milliseconds"/);
  assert.match(animator, /aria-label="Stroke width in pixels"/);
  assert.match(animator, /aria-label="Stroke colour picker"/);
  assert.match(animator, /aria-label="Stroke colour hex value"/);
  assert.match(animator, /step="0\.01"/);
  assert.match(animator, /MIN_STROKE_WIDTH\.toFixed\(2\)/);
  assert.match(animator, /MAX_STROKE_WIDTH\.toFixed\(2\)/);
  assert.match(animator, /styleSvgStroke/);
  assert.match(animator, /aria-label="Grid opacity percentage"/);
  assert.match(animator, /context\.globalAlpha = gridOpacity;/);
  assert.match(animator, /context\.strokeStyle = GRID_COLOR;/);
  assert.match(animator, /grid v2/i);
  assert.match(animator, /aria-label="Upload A4 images"/);
  assert.match(animator, /mode === "grid-v2" \? uploadedLayers : visibleLayers/);
  assert.match(animator, /containImageRect/);
  assert.match(animator, /speedMs \* 2/);
  assert.match(animator, /const SYNC_INTERVAL_MS = 10_000;/);
  assert.match(animator, /while \(cursor\)/);
  assert.match(animator, /context\.drawImage\([\s\S]*?rect\.x,[\s\S]*?rect\.y,[\s\S]*?rect\.width,[\s\S]*?rect\.height,/);
  assert.doesNotMatch(animator, /DRAWING_SCALE|DRAWING_WIDTH|DRAWING_HEIGHT|layer\.width|layer\.height/);
  assert.match(animator, /new Mp4OutputFormat/);
  assert.match(animator, /new VideoSampleSource/);
  assert.match(animator, /displayWidth: EXPORT_WIDTH/);
  assert.match(animator, /displayHeight: EXPORT_HEIGHT/);
  assert.match(animator, /type: "video\/mp4"/);
  assert.match(animator, /preview mp4/i);
  assert.match(animator, /MP4 export preview at \$\{EXPORT_WIDTH\} by \$\{EXPORT_HEIGHT\}/);
  assert.match(animator, /<video/);
  assert.match(animator, /downloadPreview/);
  assert.match(animator, /URL\.createObjectURL\(blob\)/);
  assert.match(animator, /\.mp4`/);

  const css = await readFile(
    new URL("../app/globals.css", import.meta.url),
    "utf8",
  );
  assert.match(css, /\.animation-paper\s*\{[\s\S]*?aspect-ratio:\s*595\s*\/\s*842;[\s\S]*?flex:\s*0\s+0\s+auto;/);
  assert.match(css, /\.animator-page\s*\{[\s\S]*?background:\s*#000;[\s\S]*?color:\s*#fff;/);
  assert.match(css, /\.animation-paper\s*\{[\s\S]*?background:\s*#fff;/);
});

test("constructs canonical SVG on the server and writes it to D1", async () => {
  const worker = await loadWorker();
  let write;
  const response = await worker.fetch(
    new Request("http://localhost/api/drawings", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(drawingPayload()),
    }),
    makeEnv({
      onRun(value) {
        write = value;
      },
    }),
    executionContext(),
  );

  assert.equal(response.status, 201);
  assert.ok(write);
  assert.match(write.sql, /INSERT INTO drawings/);
  assert.match(write.sql, /ON CONFLICT\(id\) DO NOTHING/);
  assert.doesNotMatch(write.sql, /DO UPDATE/);
  assert.equal(write.values[0], drawingPayload().id);
  assert.match(write.values[1], /^<svg xmlns=/);
  assert.match(write.values[1], /width="595pt"/);
  assert.match(write.values[1], /height="842pt"/);
  assert.match(write.values[1], /viewBox="0 0 595 842"/);
  assert.match(write.values[1], /stroke-width="1"/);
  assert.equal((write.values[1].match(/<path /g) ?? []).length, 1);
  assert.equal((write.values[1].match(/\bM /g) ?? []).length, 5);
  assert.equal(write.values[2], 595);
  assert.equal(write.values[3], 842);
  assert.doesNotMatch(write.values[1], /<script|onload=/i);
  assert.doesNotMatch(write.values[1], /<pattern|<circle|dot-grid|zoom/i);
});

test("accepts a multi-stroke A4 sheet and keeps every stroke in one SVG path", async () => {
  const worker = await loadWorker();
  const payload = drawingPayload();
  payload.strokes = [
    drawingPayload().strokes.flat(),
    [
        { x: 0, y: 0 },
        { x: 595, y: 842 },
    ],
    ...Array.from({ length: 10 }, (_, index) => {
    const column = index % 4;
    const row = Math.floor(index / 4);
    const x = 80 + column * 120;
    const y = 70 + row * 170;
    return [
      { x, y },
      { x: x + 70, y: y + 60 },
    ];
    }),
  ];

  let write;
  const response = await worker.fetch(
    new Request("http://localhost/api/drawings", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload),
    }),
    makeEnv({
      onRun(value) {
        write = value;
      },
    }),
    executionContext(),
  );

  assert.equal(response.status, 201);
  assert.ok(write);
  assert.equal((write.values[1].match(/<path /g) ?? []).length, 1);
  assert.equal((write.values[1].match(/\bM /g) ?? []).length, 12);
  assert.match(write.values[1], /width="595pt"/);
  assert.match(write.values[1], /height="842pt"/);
  assert.match(write.values[1], /stroke-width="1"/);
  assert.match(write.values[1], /M 0 0 L 595 842/);
  assert.doesNotMatch(write.values[1], /<pattern|<circle|dot-grid|zoom/i);
});

test("keeps accepting legacy canvas dimensions", async () => {
  const worker = await loadWorker();
  const payload = drawingPayload();
  payload.width = 1000;
  payload.height = 700;
  payload.strokes = payload.strokes.map((stroke) =>
    stroke.map(({ x, y }) => ({
      x: (x / 595) * 1000,
      y: (y / 842) * 700,
    })),
  );

  let write;
  const response = await worker.fetch(
    new Request("http://localhost/api/drawings", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload),
    }),
    makeEnv({
      onRun(value) {
        write = value;
      },
    }),
    executionContext(),
  );

  assert.equal(response.status, 201);
  assert.ok(write);
  assert.equal(write.values[2], 595);
  assert.equal(write.values[3], 842);
  assert.match(write.values[1], /stroke-width="1"/);
});

test("keeps accepting the previous landscape A4 canvas", async () => {
  const worker = await loadWorker();
  const payload = drawingPayload();
  payload.width = 842;
  payload.height = 595;
  payload.strokes = payload.strokes.map((stroke) =>
    stroke.map(({ x, y }) => ({
      x: (x / 595) * 842,
      y: (y / 842) * 595,
    })),
  );

  let write;
  const response = await worker.fetch(
    new Request("http://localhost/api/drawings", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload),
    }),
    makeEnv({
      onRun(value) {
        write = value;
      },
    }),
    executionContext(),
  );

  assert.equal(response.status, 201);
  assert.ok(write);
  assert.equal(write.values[2], 595);
  assert.equal(write.values[3], 842);
  assert.match(write.values[1], /viewBox="0 0 595 842"/);
  assert.match(write.values[1], /stroke-width="1"/);
});

test("accepts an arbitrary drawing without shape detection", async () => {
  const worker = await loadWorker();
  const payload = drawingPayload();
  payload.strokes = [
    [
      { x: 100, y: 100 },
      { x: 550, y: 100 },
    ],
  ];
  let writes = 0;

  const response = await worker.fetch(
    new Request("http://localhost/api/drawings", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload),
    }),
    makeEnv({
      onRun() {
        writes += 1;
      },
    }),
    executionContext(),
  );

  assert.equal(response.status, 201);
  assert.equal(writes, 1);
});

test("rejects markup and malformed point data before touching D1", async () => {
  const worker = await loadWorker();
  let writes = 0;
  const payload = drawingPayload();
  payload.strokes[0][0].x = "<script>alert(1)</script>";

  const response = await worker.fetch(
    new Request("http://localhost/api/drawings", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload),
    }),
    makeEnv({
      onRun() {
        writes += 1;
      },
    }),
    executionContext(),
  );

  assert.equal(response.status, 400);
  assert.equal(writes, 0);
});

test("rate limits anonymous permanent submissions before touching D1", async () => {
  const worker = await loadWorker();
  let writes = 0;
  const response = await worker.fetch(
    new Request("http://localhost/api/drawings", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "cf-connecting-ip": "203.0.113.8",
      },
      body: JSON.stringify(drawingPayload()),
    }),
    makeEnv({
      onLimit: async () => false,
      onRun() {
        writes += 1;
      },
    }),
    executionContext(),
  );

  assert.equal(response.status, 429);
  assert.equal(response.headers.get("retry-after"), "60");
  assert.equal(writes, 0);
});

test("lists timestamped metadata without exposing stored SVG", async () => {
  const worker = await loadWorker();
  const rows = [
    {
      id: "33333333-3333-4333-8333-333333333333",
      width: 1000,
      height: 700,
      created_at: 1_787_558_400,
      updated_at: 1_787_558_400,
    },
    {
      id: "22222222-2222-4222-8222-222222222222",
      width: 1000,
      height: 700,
      created_at: 1_787_558_300,
      updated_at: 1_787_558_350,
    },
  ];
  const response = await worker.fetch(
    new Request("http://localhost/api/drawings?limit=1"),
    makeEnv({ onAll: async () => rows }),
    executionContext(),
  );

  assert.equal(response.status, 200);
  const data = await response.json();
  assert.equal(data.drawings.length, 1);
  assert.equal(data.drawings[0].id, rows[0].id);
  assert.equal(data.drawings[0].createdAt, "2026-08-24T08:00:00.000Z");
  assert.equal(data.drawings[0].previewUrl, `/api/drawings/${rows[0].id}.svg?preview=1`);
  assert.equal("svg" in data.drawings[0], false);
  assert.equal(data.nextCursor, `${rows[0].created_at}:${rows[0].id}`);
});

test("serves only canonical stored SVG with restrictive headers", async () => {
  const worker = await loadWorker();
  const id = drawingPayload().id;
  const svg = '<svg xmlns="http://www.w3.org/2000/svg"><path d="M 0 0 L 1 1"/></svg>';
  const stored = {
    id,
    svg,
    width: 1000,
    height: 700,
    created_at: 1_787_558_400,
    updated_at: 1_787_558_400,
  };
  const response = await worker.fetch(
    new Request(`http://localhost/api/drawings/${id}.svg`),
    makeEnv({ onFirst: async () => stored }),
    executionContext(),
  );

  assert.equal(response.status, 200);
  const canonical = await response.text();
  assert.notEqual(canonical, svg);
  assert.match(canonical, /width="595pt"/);
  assert.match(canonical, /height="842pt"/);
  assert.match(canonical, /viewBox="0 0 595 842"/);
  assert.match(canonical, /stroke-width="1"/);
  assert.doesNotMatch(canonical, /vector-effect=/);
  assert.equal((canonical.match(/<path /g) ?? []).length, 1);
  assert.match(response.headers.get("content-type") ?? "", /^image\/svg\+xml/);
  assert.equal(response.headers.get("x-content-type-options"), "nosniff");
  assert.equal(response.headers.get("cross-origin-resource-policy"), "same-origin");
  assert.match(response.headers.get("content-security-policy") ?? "", /sandbox/);
  assert.match(response.headers.get("content-disposition") ?? "", /^inline;/);
});

test("renders thicker preview strokes without changing canonical SVGs", async () => {
  const worker = await loadWorker();
  const id = drawingPayload().id;
  const stored = {
    id,
    svg: '<svg xmlns="http://www.w3.org/2000/svg"><path d="M 0 0 L 1 1"/></svg>',
    width: 595,
    height: 842,
    created_at: 1_787_558_400,
    updated_at: 1_787_558_400,
  };
  const response = await worker.fetch(
    new Request(`http://localhost/api/drawings/${id}.svg?preview=1`),
    makeEnv({ onFirst: async () => stored }),
    executionContext(),
  );

  assert.equal(response.status, 200);
  const preview = await response.text();
  assert.match(preview, /stroke-width="2"/);
  assert.match(preview, /vector-effect="non-scaling-stroke"/);
  assert.match(response.headers.get("content-disposition") ?? "", /^inline;/);
});

test("downloads selected drawings as a ZIP", async () => {
  const worker = await loadWorker();
  const first = drawingPayload().id;
  const second = "11111111-2222-4222-8222-222222222222";
  const rows = [first, second].map((id, index) => ({
    id,
    svg:
      index === 0
        ? '<svg xmlns="http://www.w3.org/2000/svg"><path d="M 700 100 L 620 100 M 620 100 L 620 165"/></svg>'
        : '<svg xmlns="http://www.w3.org/2000/svg"><path d="M 800 120 L 500 120"/><path d="M 500 120 L 500 320"/></svg>',
    width: index === 0 ? 842 : 1000,
    height: index === 0 ? 595 : 700,
    created_at: 1_787_558_400,
    updated_at: 1_787_558_400,
  }));
  const response = await worker.fetch(
    new Request("http://localhost/api/drawings/download", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ ids: [first, second] }),
    }),
    makeEnv({ onAll: async () => rows }),
    executionContext(),
  );

  assert.equal(response.status, 200);
  assert.equal(response.headers.get("content-type"), "application/zip");
  assert.match(response.headers.get("content-disposition") ?? "", /kept\.zip/);
  const files = unzipSync(new Uint8Array(await response.arrayBuffer()));
  assert.equal(Object.keys(files).length, 2);
  assert.ok(Object.keys(files).some((name) => name.includes(first)));
  assert.ok(Object.keys(files).some((name) => name.includes(second)));
  for (const contents of Object.values(files)) {
    const svg = strFromU8(contents);
    assert.match(svg, /width="595pt"/);
    assert.match(svg, /height="842pt"/);
    assert.match(svg, /viewBox="0 0 595 842"/);
    assert.match(svg, /stroke-width="1"/);
    assert.equal((svg.match(/<path /g) ?? []).length, 1);
  }
});

test("rate limits bulk archives before querying D1", async () => {
  const worker = await loadWorker();
  let reads = 0;
  const response = await worker.fetch(
    new Request("http://localhost/api/drawings/download", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "cf-connecting-ip": "203.0.113.9",
      },
      body: JSON.stringify({ ids: [drawingPayload().id] }),
    }),
    makeEnv({
      onLimit: async () => false,
      onAll: async () => {
        reads += 1;
        return [];
      },
    }),
    executionContext(),
  );

  assert.equal(response.status, 429);
  assert.equal(response.headers.get("retry-after"), "60");
  assert.equal(reads, 0);
});

test("deletes every response only after exact same-origin confirmation", async () => {
  const worker = await loadWorker();
  let deletion;
  const response = await worker.fetch(
    new Request("http://localhost/api/admin/drawings", {
      method: "DELETE",
      headers: {
        "content-type": "application/json",
        origin: "http://localhost",
        "sec-fetch-site": "same-origin",
      },
      body: JSON.stringify({ confirmation: "CONFIRM" }),
    }),
    makeEnv({
      onRun(value) {
        deletion = value;
        return { success: true, meta: { changes: 7 } };
      },
    }),
    executionContext(),
  );

  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { deleted: 7 });
  assert.ok(deletion);
  assert.equal(deletion.sql, "DELETE FROM drawings");
  assert.deepEqual(deletion.values, []);
});

test("rejects inexact delete confirmations before touching D1", async () => {
  const worker = await loadWorker();
  const bodies = [
    { confirmation: "confirm" },
    { confirmation: " CONFIRM " },
    {},
    { confirmation: "CONFIRM", extra: true },
  ];

  for (const body of bodies) {
    let writes = 0;
    const response = await worker.fetch(
      new Request("http://localhost/api/admin/drawings", {
        method: "DELETE",
        headers: {
          "content-type": "application/json",
          origin: "http://localhost",
          "sec-fetch-site": "same-origin",
        },
        body: JSON.stringify(body),
      }),
      makeEnv({
        onRun() {
          writes += 1;
        },
      }),
      executionContext(),
    );

    assert.equal(response.status, 400);
    assert.deepEqual(await response.json(), { error: "invalid confirmation" });
    assert.equal(writes, 0);
  }
});

test("rejects cross-site deletion and rate limits before touching D1", async () => {
  const worker = await loadWorker();
  let writes = 0;
  const crossSite = await worker.fetch(
    new Request("http://localhost/api/admin/drawings", {
      method: "DELETE",
      headers: {
        "content-type": "application/json",
        origin: "https://example.com",
        "sec-fetch-site": "cross-site",
      },
      body: JSON.stringify({ confirmation: "CONFIRM" }),
    }),
    makeEnv({
      onRun() {
        writes += 1;
      },
    }),
    executionContext(),
  );
  const limited = await worker.fetch(
    new Request("http://localhost/api/admin/drawings", {
      method: "DELETE",
      headers: {
        "content-type": "application/json",
        origin: "http://localhost",
        "sec-fetch-site": "same-origin",
      },
      body: JSON.stringify({ confirmation: "CONFIRM" }),
    }),
    makeEnv({
      onLimit: async () => false,
      onRun() {
        writes += 1;
      },
    }),
    executionContext(),
  );

  assert.equal(crossSite.status, 403);
  assert.equal(limited.status, 429);
  assert.equal(limited.headers.get("retry-after"), "60");
  assert.equal(writes, 0);
});

test("keeps deletion failures generic and leaves success reporting to D1", async () => {
  const worker = await loadWorker();
  const response = await worker.fetch(
    new Request("http://localhost/api/admin/drawings", {
      method: "DELETE",
      headers: {
        "content-type": "application/json",
        origin: "http://localhost",
      },
      body: JSON.stringify({ confirmation: "CONFIRM" }),
    }),
    makeEnv({
      onRun: async () => ({ success: false, meta: { changes: 0 } }),
    }),
    executionContext(),
  );

  assert.equal(response.status, 500);
  assert.deepEqual(await response.json(), { error: "unable to complete request" });
});

test("rejects malformed gallery cursors and selections", async () => {
  const worker = await loadWorker();
  const badCursor = await worker.fetch(
    new Request("http://localhost/api/drawings?cursor=nope"),
    makeEnv(),
    executionContext(),
  );
  const duplicateSelection = await worker.fetch(
    new Request("http://localhost/api/drawings/download", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ ids: [drawingPayload().id, drawingPayload().id] }),
    }),
    makeEnv(),
    executionContext(),
  );

  assert.equal(badCursor.status, 400);
  assert.equal(duplicateSelection.status, 400);
});

test("keeps deployment metadata scoped to this project", async () => {
  const config = await readFile(new URL("../wrangler.jsonc", import.meta.url), "utf8");
  const hosting = await readFile(
    new URL("../.openai/hosting.json", import.meta.url),
    "utf8",
  );
  assert.match(config, /"name": "scribble"/);
  assert.match(config, /"binding": "DB"/);
  assert.match(config, /"name": "SUBMISSION_RATE_LIMITER"/);
  assert.match(hosting, /"d1": "DB"/);
  await access(new URL("../migrations/0002_drawings_created_at_index.sql", import.meta.url));
  assert.ok(projectRoot);
});
