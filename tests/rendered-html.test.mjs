import assert from "node:assert/strict";
import { access, readFile } from "node:fs/promises";
import test from "node:test";

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

function makeEnv(onWrite = () => {}) {
  return {
    ASSETS: {
      fetch: async () => new Response("Not found", { status: 404 }),
    },
    DB: {
      prepare(sql) {
        return {
          bind(...values) {
            return {
              async run() {
                onWrite({ sql, values });
                return { success: true };
              },
            };
          },
        };
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
  assert.match(css, /Futura-Regular\.woff2/);
  assert.match(css, /Futura-Bold\.woff2/);
  await access(new URL("../public/fonts/Futura-Regular.woff2", import.meta.url));
  await access(new URL("../public/fonts/Futura-Bold.woff2", import.meta.url));
  await assert.rejects(access(new URL("../app/_sites-preview", import.meta.url)));
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
    makeEnv((value) => {
      write = value;
    }),
    executionContext(),
  );

  assert.equal(response.status, 201);
  assert.ok(write);
  assert.match(write.sql, /INSERT INTO drawings/);
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
    makeEnv(() => {
      writes += 1;
    }),
    executionContext(),
  );

  assert.equal(response.status, 400);
  assert.equal(writes, 0);
});

test("keeps deployment metadata scoped to this project", async () => {
  const config = await readFile(new URL("../wrangler.jsonc", import.meta.url), "utf8");
  const hosting = await readFile(
    new URL("../.openai/hosting.json", import.meta.url),
    "utf8",
  );
  assert.match(config, /"name": "scribble"/);
  assert.match(config, /"binding": "DB"/);
  assert.match(hosting, /"d1": "DB"/);
  assert.ok(projectRoot);
});
