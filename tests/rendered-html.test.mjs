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
            onRun({ sql, values });
            return { success: true, meta: { changes: 1 } };
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
    width: 1000,
    height: 700,
    strokes: [
      [
        { x: 800, y: 120 },
        { x: 500, y: 120 },
      ],
      [
        { x: 500, y: 120 },
        { x: 500, y: 320 },
      ],
      [
        { x: 500, y: 320 },
        { x: 760, y: 320 },
      ],
      [
        { x: 760, y: 320 },
        { x: 790, y: 470 },
      ],
      [
        { x: 790, y: 470 },
        { x: 520, y: 560 },
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
  assert.match(html, /<title>Follow the line<\/title>/i);
  assert.match(html, /Begin high and to the right\. Travel left\./);
  assert.doesNotMatch(html, /codex-preview|react-loading-skeleton/i);

  const css = await readFile(new URL("../app/globals.css", import.meta.url), "utf8");
  const client = await readFile(new URL("../app/Scribble.tsx", import.meta.url), "utf8");
  const gallery = await readFile(new URL("../app/5/Gallery.tsx", import.meta.url), "utf8");
  assert.match(css, /Futura-Regular\.woff2/);
  assert.doesNotMatch(css, /Futura-Bold\.woff2|font-weight:\s*(?:[5-9]00|bold)/);
  assert.match(client, /const MIN_STROKE_TRAVEL = 8;/);
  assert.match(client, /const AUTO_ADVANCE_TRAVEL = 96;/);
  assert.match(client, /finishStroke\(activeRef\.current, true\)/);
  assert.match(client, /saveControllerRef\.current\?\.abort\(\)/);
  assert.match(gallery, /const MAX_SELECTION = 50;/);
  assert.doesNotMatch(gallery, /toggleAll|allSelected/);
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
  assert.match(html, /animate/i);
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
  assert.match(html, /animation tool/i);
  assert.match(html, /blink/i);
  assert.match(html, /solo/i);
  assert.match(html, /grid/i);

  const animator = await readFile(
    new URL("../app/5A/Animator.tsx", import.meta.url),
    "utf8",
  );
  assert.match(animator, /const FRAME_MS = 300;/);
  assert.match(animator, /const WIDTH = 700;/);
  assert.match(animator, /const HEIGHT = 1000;/);
  assert.match(animator, /const BACKGROUND = "#FFFFFF";/);
  assert.match(animator, /const GREY = "#CCCCCC";/);
  assert.match(animator, /const GRID_COLUMNS = 5;/);
  assert.match(animator, /const GRID_ROWS = 10;/);
  assert.match(animator, /const SYNC_INTERVAL_MS = 10_000;/);
  assert.match(animator, /while \(cursor\)/);
  assert.match(animator, /new Mp4OutputFormat/);
  assert.match(animator, /type: "video\/mp4"/);
  assert.match(animator, /\.mp4`/);
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
  assert.equal((write.values[1].match(/<path /g) ?? []).length, 5);
  assert.doesNotMatch(write.values[1], /<script|onload=/i);
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
  assert.equal(data.drawings[0].previewUrl, `/api/drawings/${rows[0].id}.svg`);
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
  assert.equal(await response.text(), svg);
  assert.match(response.headers.get("content-type") ?? "", /^image\/svg\+xml/);
  assert.equal(response.headers.get("x-content-type-options"), "nosniff");
  assert.equal(response.headers.get("cross-origin-resource-policy"), "same-origin");
  assert.match(response.headers.get("content-security-policy") ?? "", /sandbox/);
  assert.match(response.headers.get("content-disposition") ?? "", /^inline;/);
});

test("downloads selected drawings as a ZIP", async () => {
  const worker = await loadWorker();
  const first = drawingPayload().id;
  const second = "11111111-2222-4222-8222-222222222222";
  const rows = [first, second].map((id, index) => ({
    id,
    svg: `<svg xmlns="http://www.w3.org/2000/svg"><title>${index}</title></svg>`,
    width: 1000,
    height: 700,
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
  assert.deepEqual(
    Object.values(files).map((contents) => strFromU8(contents)).sort(),
    rows.map((row) => row.svg).sort(),
  );
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
