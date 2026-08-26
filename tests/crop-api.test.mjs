import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const DRAWING_ID = "11111111-1111-4111-8111-111111111111";
const SECOND_DRAWING_ID = "22222222-2222-4222-8222-222222222222";
const A4_CROP = Object.freeze({
  x: 59.5,
  y: 84.2,
  width: 476,
  height: 673.6,
});

async function loadWorker() {
  const workerUrl = new URL("../dist/server/index.js", import.meta.url);
  workerUrl.searchParams.set(
    "crop-test",
    `${process.pid}-${Date.now()}-${Math.random()}`,
  );
  return (await import(workerUrl.href)).default;
}

function executionContext() {
  return {
    waitUntil() {},
    passThroughOnException() {},
  };
}

function compactSql(sql) {
  return sql.replace(/\s+/g, " ").trim();
}

function storedDrawing(id = DRAWING_ID, overrides = {}) {
  return {
    id,
    svg: '<svg xmlns="http://www.w3.org/2000/svg"><path d="M 10 20 Q 30 40 50 60 L 300 400" fill="none" stroke="#171713"/></svg>',
    width: 595,
    height: 842,
    created_at: 1_787_558_400,
    updated_at: 1_787_558_450,
    ...overrides,
  };
}

function storedCrop(drawingId = DRAWING_ID, overrides = {}) {
  return {
    drawing_id: drawingId,
    ...A4_CROP,
    revision: 3,
    updated_at: 1_787_558_500,
    ...overrides,
  };
}

function sameOriginHeaders(extra = {}) {
  return {
    origin: "http://localhost",
    "sec-fetch-site": "same-origin",
    ...extra,
  };
}

/**
 * A deliberately small, SQL-aware D1 double. It models the query ordering used
 * by the crop routes instead of returning one catch-all value for every read.
 */
function makeStatefulEnv({
  drawings = [storedDrawing()],
  crops = [],
  rateLimit = true,
} = {}) {
  const drawingRows = new Map(
    drawings.map((drawing) => [drawing.id, { ...drawing }]),
  );
  const cropRows = new Map(
    crops.map((crop) => [crop.drawing_id, { ...crop }]),
  );
  const calls = {
    all: [],
    first: [],
    run: [],
    limits: [],
    prepared: [],
  };

  const DB = {
    prepare(sql) {
      const normalized = compactSql(sql);
      calls.prepared.push(normalized);
      let values = [];

      const statement = {
        bind(...nextValues) {
          values = nextValues;
          return statement;
        },
        async all() {
          calls.all.push({ sql: normalized, values: [...values] });
          if (
            /FROM drawings d LEFT JOIN drawing_crops c ON c\.drawing_id = d\.id/i.test(
              normalized,
            )
          ) {
            const limit = values.at(-1);
            const rows = [...drawingRows.values()]
              .sort(
                (left, right) =>
                  right.created_at - left.created_at ||
                  right.id.localeCompare(left.id),
              )
              .slice(0, typeof limit === "number" ? limit : undefined)
              .map((drawing) => {
                const crop = cropRows.get(drawing.id);
                return {
                  id: drawing.id,
                  width: drawing.width,
                  height: drawing.height,
                  created_at: drawing.created_at,
                  updated_at: drawing.updated_at,
                  crop_x: crop?.x ?? null,
                  crop_y: crop?.y ?? null,
                  crop_width: crop?.width ?? null,
                  crop_height: crop?.height ?? null,
                  crop_revision: crop?.revision ?? null,
                  crop_updated_at: crop?.updated_at ?? null,
                };
              });
            return { success: true, results: rows };
          }
          throw new Error(`Unexpected D1 all(): ${normalized}`);
        },
        async first() {
          calls.first.push({ sql: normalized, values: [...values] });
          if (/^INSERT INTO drawing_crops\b/i.test(normalized)) {
            const [drawingId, x, y, width, height, revision, updatedAt] = values;
            if (cropRows.has(drawingId)) return null;
            const stored = {
              drawing_id: drawingId,
              x,
              y,
              width,
              height,
              revision,
              updated_at: updatedAt,
            };
            cropRows.set(drawingId, stored);
            return { ...stored };
          }
          if (/^UPDATE drawing_crops\b/i.test(normalized)) {
            const [
              x,
              y,
              width,
              height,
              nextRevision,
              updatedAt,
              drawingId,
              revision,
            ] = values;
            const existing = cropRows.get(drawingId);
            if (!existing || existing.revision !== revision) return null;
            const stored = {
              ...existing,
              x,
              y,
              width,
              height,
              revision: nextRevision,
              updated_at: updatedAt,
            };
            cropRows.set(drawingId, stored);
            return { ...stored };
          }
          if (/^DELETE FROM drawing_crops\b/i.test(normalized)) {
            const [drawingId, revision] = values;
            const existing = cropRows.get(drawingId);
            if (!existing || existing.revision !== revision) return null;
            cropRows.delete(drawingId);
            return { ...existing };
          }
          if (/FROM drawing_crops WHERE drawing_id = \?/i.test(normalized)) {
            const crop = cropRows.get(values[0]);
            return crop ? { ...crop } : null;
          }
          if (/FROM drawings WHERE id = \?/i.test(normalized)) {
            const drawing = drawingRows.get(values[0]);
            return drawing ? { ...drawing } : null;
          }
          throw new Error(`Unexpected D1 first(): ${normalized}`);
        },
        async run() {
          calls.run.push({ sql: normalized, values: [...values] });
          if (/^INSERT INTO drawing_crops\b/i.test(normalized)) {
            const [drawingId, x, y, width, height, updatedAt] = values;
            const existing = cropRows.get(drawingId);
            cropRows.set(drawingId, {
              drawing_id: drawingId,
              x,
              y,
              width,
              height,
              revision: existing ? existing.revision + 1 : 1,
              updated_at: updatedAt,
            });
            return { success: true, meta: { changes: 1 } };
          }
          if (/^DELETE FROM drawing_crops WHERE drawing_id = \?/i.test(normalized)) {
            const changed = cropRows.delete(values[0]);
            return { success: true, meta: { changes: changed ? 1 : 0 } };
          }
          throw new Error(`Unexpected D1 run(): ${normalized}`);
        },
      };
      return statement;
    },
  };

  const env = {
    ASSETS: {
      fetch: async () => new Response("Not found", { status: 404 }),
    },
    DB,
    SUBMISSION_RATE_LIMITER: {
      async limit(options) {
        calls.limits.push(options);
        return {
          success:
            typeof rateLimit === "function"
              ? await rateLimit(options)
              : rateLimit,
        };
      },
    },
  };

  return { env, calls, drawingRows, cropRows };
}

function cropRequest(id, method, body, headers = {}) {
  const init = {
    method,
    headers: sameOriginHeaders({ "if-match": '"0"', ...headers }),
  };
  if (body !== undefined) init.body = JSON.stringify(body);
  return new Request(`http://localhost/api/drawings/${id}/crop`, init);
}

function pathElement(svg) {
  const match = svg.match(/<path\b[^>]*\/>/i);
  assert.ok(match, "expected an SVG path element");
  return match[0];
}

test("drawing list maps absent and stored crops without exposing SVG", async () => {
  const worker = await loadWorker();
  const drawingWithCrop = storedDrawing(DRAWING_ID, {
    created_at: 1_787_558_500,
  });
  const drawingWithoutCrop = storedDrawing(SECOND_DRAWING_ID, {
    created_at: 1_787_558_400,
  });
  const crop = storedCrop(DRAWING_ID, { revision: 9 });
  const { env, calls } = makeStatefulEnv({
    drawings: [drawingWithoutCrop, drawingWithCrop],
    crops: [crop],
  });

  const response = await worker.fetch(
    new Request("http://localhost/api/drawings?limit=2"),
    env,
    executionContext(),
  );

  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), {
    drawings: [
      {
        id: DRAWING_ID,
        width: 595,
        height: 842,
        createdAt: new Date(drawingWithCrop.created_at * 1000).toISOString(),
        updatedAt: new Date(drawingWithCrop.updated_at * 1000).toISOString(),
        previewUrl: `/api/drawings/${DRAWING_ID}.svg?preview=1`,
        downloadUrl: `/api/drawings/${DRAWING_ID}.svg?download=1`,
        crop: {
          x: crop.x,
          y: crop.y,
          width: crop.width,
          height: crop.height,
          revision: 9,
          updatedAt: new Date(crop.updated_at * 1000).toISOString(),
        },
      },
      {
        id: SECOND_DRAWING_ID,
        width: 595,
        height: 842,
        createdAt: new Date(drawingWithoutCrop.created_at * 1000).toISOString(),
        updatedAt: new Date(drawingWithoutCrop.updated_at * 1000).toISOString(),
        previewUrl: `/api/drawings/${SECOND_DRAWING_ID}.svg?preview=1`,
        downloadUrl: `/api/drawings/${SECOND_DRAWING_ID}.svg?download=1`,
        crop: null,
      },
    ],
    nextCursor: null,
  });
  assert.equal(calls.all.length, 1);
  assert.match(calls.all[0].sql, /LEFT JOIN drawing_crops/i);
});

test("crop preview changes only the A4 viewBox and keeps the original preview path styling", async () => {
  const worker = await loadWorker();
  const { env } = makeStatefulEnv({ crops: [storedCrop()] });

  const defaultResponse = await worker.fetch(
    new Request(`http://localhost/api/drawings/${DRAWING_ID}.svg?preview=1`),
    env,
    executionContext(),
  );
  const croppedResponse = await worker.fetch(
    new Request(
      `http://localhost/api/drawings/${DRAWING_ID}.svg?preview=1&crop=1`,
    ),
    env,
    executionContext(),
  );

  assert.equal(defaultResponse.status, 200);
  assert.equal(croppedResponse.status, 200);
  const defaultSvg = await defaultResponse.text();
  const croppedSvg = await croppedResponse.text();
  assert.match(defaultSvg, /width="595pt" height="842pt" viewBox="0 0 595 842"/);
  assert.doesNotMatch(defaultSvg, /overflow="hidden"/);
  assert.match(
    croppedSvg,
    /width="595pt" height="842pt" viewBox="59\.5 84\.2 476 673\.6" overflow="hidden"/,
  );
  assert.equal(pathElement(croppedSvg), pathElement(defaultSvg));
  assert.match(pathElement(croppedSvg), /stroke-width="2"/);
  assert.match(pathElement(croppedSvg), /vector-effect="non-scaling-stroke"/);
});

test("crop preview falls back to the unchanged full A4 page when no crop exists", async () => {
  const worker = await loadWorker();
  const { env } = makeStatefulEnv();
  const response = await worker.fetch(
    new Request(
      `http://localhost/api/drawings/${DRAWING_ID}.svg?preview=1&crop=1`,
    ),
    env,
    executionContext(),
  );

  assert.equal(response.status, 200);
  const svg = await response.text();
  assert.match(svg, /width="595pt" height="842pt" viewBox="0 0 595 842"/);
  assert.doesNotMatch(svg, /overflow="hidden"/);
  assert.match(svg, /stroke-width="2"/);
  assert.match(svg, /vector-effect="non-scaling-stroke"/);
});

test("same-origin PUT stores an exact crop with a fresh revision atomically", async () => {
  const worker = await loadWorker();
  const existing = storedCrop(DRAWING_ID, { revision: 7 });
  const { env, calls, cropRows } = makeStatefulEnv({ crops: [existing] });

  const response = await worker.fetch(
    cropRequest(DRAWING_ID, "PUT", A4_CROP, {
      "content-type": "application/json",
      "cf-connecting-ip": "203.0.113.51",
      "if-match": '"7"',
    }),
    env,
    executionContext(),
  );

  assert.equal(response.status, 200);
  const saved = cropRows.get(DRAWING_ID);
  assert.ok(saved);
  assert.notEqual(saved.revision, 7);
  assert.deepEqual(await response.json(), {
    id: DRAWING_ID,
    crop: {
      ...A4_CROP,
      revision: saved.revision,
      updatedAt: new Date(saved.updated_at * 1000).toISOString(),
    },
  });
  const mutation = calls.first.find(({ sql }) => /^UPDATE drawing_crops\b/i.test(sql));
  assert.ok(mutation);
  assert.match(
    mutation.sql,
    /revision = \?/i,
  );
  assert.match(mutation.sql, /WHERE drawing_id = \? AND revision = \?/i);
  assert.match(mutation.sql, /RETURNING drawing_id/i);
  assert.deepEqual(mutation.values.slice(0, 4), [
    A4_CROP.x,
    A4_CROP.y,
    A4_CROP.width,
    A4_CROP.height,
  ]);
  assert.deepEqual(mutation.values.slice(-2), [DRAWING_ID, 7]);
  assert.deepEqual(calls.limits, [
    { key: `crop:203.0.113.51:${DRAWING_ID}` },
  ]);
});

test("a first crop inserts only against revision zero with a fresh revision token", async () => {
  const worker = await loadWorker();
  const { env, calls } = makeStatefulEnv();
  const response = await worker.fetch(
    cropRequest(DRAWING_ID, "PUT", A4_CROP, {
      "content-type": "application/json",
    }),
    env,
    executionContext(),
  );

  assert.equal(response.status, 200);
  const revision = (await response.json()).crop.revision;
  assert.ok(Number.isSafeInteger(revision));
  assert.ok(revision >= 0x1_0000_0000);
  const mutation = calls.first.find(({ sql }) =>
    /^INSERT INTO drawing_crops\b/i.test(sql),
  );
  assert.ok(mutation);
  assert.match(mutation.sql, /ON CONFLICT\(drawing_id\) DO NOTHING/i);
  assert.match(mutation.sql, /RETURNING drawing_id/i);
});

test("delete and recreate never reuses revision one for a stale writer", async () => {
  const worker = await loadWorker();
  const { env } = makeStatefulEnv({
    crops: [storedCrop(DRAWING_ID, { revision: 1 })],
  });
  const deleted = await worker.fetch(
    cropRequest(DRAWING_ID, "DELETE", undefined, { "if-match": '"1"' }),
    env,
    executionContext(),
  );
  const recreated = await worker.fetch(
    cropRequest(DRAWING_ID, "PUT", A4_CROP, {
      "content-type": "application/json",
    }),
    env,
    executionContext(),
  );
  const stale = await worker.fetch(
    cropRequest(DRAWING_ID, "PUT", A4_CROP, {
      "content-type": "application/json",
      "if-match": '"1"',
    }),
    env,
    executionContext(),
  );

  assert.equal(deleted.status, 200);
  assert.equal(recreated.status, 200);
  const recreatedRevision = (await recreated.json()).crop.revision;
  assert.ok(recreatedRevision >= 0x1_0000_0000);
  assert.equal(stale.status, 412);
  assert.equal((await stale.json()).crop.revision, recreatedRevision);
});

test("stale crop revisions fail without overwriting the newer crop", async () => {
  const worker = await loadWorker();
  const current = storedCrop(DRAWING_ID, { revision: 8 });
  const { env, cropRows } = makeStatefulEnv({ crops: [current] });
  const response = await worker.fetch(
    cropRequest(DRAWING_ID, "PUT", A4_CROP, {
      "content-type": "application/json",
      "if-match": '"7"',
    }),
    env,
    executionContext(),
  );

  assert.equal(response.status, 412);
  assert.deepEqual(await response.json(), {
    error: "crop changed",
    crop: {
      x: current.x,
      y: current.y,
      width: current.width,
      height: current.height,
      revision: 8,
      updatedAt: new Date(current.updated_at * 1000).toISOString(),
    },
  });
  assert.deepEqual(cropRows.get(DRAWING_ID), current);
});

test("crop writes require a quoted revision precondition", async () => {
  const worker = await loadWorker();
  const missingState = makeStatefulEnv();
  const missing = await worker.fetch(
    new Request(`http://localhost/api/drawings/${DRAWING_ID}/crop`, {
      method: "PUT",
      headers: sameOriginHeaders({ "content-type": "application/json" }),
      body: JSON.stringify(A4_CROP),
    }),
    missingState.env,
    executionContext(),
  );
  const invalidState = makeStatefulEnv();
  const invalid = await worker.fetch(
    cropRequest(DRAWING_ID, "DELETE", undefined, { "if-match": "3" }),
    invalidState.env,
    executionContext(),
  );

  assert.equal(missing.status, 428);
  assert.deepEqual(await missing.json(), { error: "precondition required" });
  assert.equal(invalid.status, 400);
  assert.deepEqual(await invalid.json(), { error: "invalid crop revision" });
  assert.equal(missingState.calls.prepared.length, 0);
  assert.equal(invalidState.calls.prepared.length, 0);
});

test("a full-page PUT canonicalizes the crop to a DELETE", async () => {
  const worker = await loadWorker();
  const { env, calls, cropRows } = makeStatefulEnv({
    crops: [storedCrop()],
  });
  const response = await worker.fetch(
    cropRequest(
      DRAWING_ID,
      "PUT",
      { x: 0, y: 0, width: 595, height: 842 },
      { "content-type": "application/json", "if-match": '"3"' },
    ),
    env,
    executionContext(),
  );

  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { id: DRAWING_ID, crop: null });
  assert.equal(cropRows.has(DRAWING_ID), false);
  const mutation = calls.first.find(({ sql }) => /^DELETE FROM drawing_crops\b/i.test(sql));
  assert.ok(mutation);
  assert.deepEqual(mutation.values, [DRAWING_ID, 3]);
  assert.match(mutation.sql, /RETURNING drawing_id/i);
});

test("DELETE resets a persisted crop without changing the drawing", async () => {
  const worker = await loadWorker();
  const drawing = storedDrawing();
  const { env, calls, drawingRows, cropRows } = makeStatefulEnv({
    drawings: [drawing],
    crops: [storedCrop()],
  });
  const response = await worker.fetch(
    cropRequest(DRAWING_ID, "DELETE", undefined, {
      "cf-connecting-ip": "203.0.113.52",
      "if-match": '"3"',
    }),
    env,
    executionContext(),
  );

  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { id: DRAWING_ID, crop: null });
  assert.equal(cropRows.has(DRAWING_ID), false);
  assert.deepEqual(drawingRows.get(DRAWING_ID), drawing);
  const mutation = calls.first.find(({ sql }) => /^DELETE FROM drawing_crops\b/i.test(sql));
  assert.ok(mutation);
  assert.deepEqual(mutation.values, [DRAWING_ID, 3]);
});

test("PUT rejects invalid aspect, bounds, size, shape, and content type before writing", async (t) => {
  const invalidBodies = [
    ["aspect", { x: 0, y: 0, width: 300, height: 300 }],
    ["bounds", { x: 120, y: 0, width: 476, height: 673.6 }],
    [
      "tiny",
      { x: 0, y: 0, width: 10, height: (10 * 842) / 595 },
    ],
    ["extra field", { ...A4_CROP, opacity: 1 }],
  ];

  for (const [name, body] of invalidBodies) {
    await t.test(name, async () => {
      const worker = await loadWorker();
      const { env, calls } = makeStatefulEnv();
      const response = await worker.fetch(
        cropRequest(DRAWING_ID, "PUT", body, {
          "content-type": "application/json",
        }),
        env,
        executionContext(),
      );

      assert.equal(response.status, 400);
      assert.deepEqual(await response.json(), { error: "invalid crop" });
      assert.equal(calls.run.length, 0);
    });
  }

  await t.test("content type", async () => {
    const worker = await loadWorker();
    const { env, calls } = makeStatefulEnv();
    const response = await worker.fetch(
      cropRequest(DRAWING_ID, "PUT", A4_CROP, {
        "content-type": "text/plain",
      }),
      env,
      executionContext(),
    );

    assert.equal(response.status, 415);
    assert.deepEqual(await response.json(), {
      error: "unsupported content type",
    });
    assert.equal(calls.run.length, 0);
  });
});

test("crop writes reject cross-origin callers and rate limiting before D1", async () => {
  const worker = await loadWorker();
  const crossOriginState = makeStatefulEnv();
  const crossOrigin = await worker.fetch(
    new Request(`http://localhost/api/drawings/${DRAWING_ID}/crop`, {
      method: "PUT",
      headers: {
        "content-type": "application/json",
        origin: "https://example.com",
        "sec-fetch-site": "cross-site",
      },
      body: JSON.stringify(A4_CROP),
    }),
    crossOriginState.env,
    executionContext(),
  );

  assert.equal(crossOrigin.status, 403);
  assert.deepEqual(await crossOrigin.json(), { error: "forbidden" });
  assert.equal(crossOriginState.calls.limits.length, 0);
  assert.equal(crossOriginState.calls.prepared.length, 0);

  const limitedState = makeStatefulEnv({ rateLimit: false });
  const limited = await worker.fetch(
    cropRequest(DRAWING_ID, "PUT", A4_CROP, {
      "content-type": "application/json",
      "cf-connecting-ip": "203.0.113.53",
    }),
    limitedState.env,
    executionContext(),
  );

  assert.equal(limited.status, 429);
  assert.equal(limited.headers.get("retry-after"), "60");
  assert.deepEqual(await limited.json(), { error: "slow down" });
  assert.deepEqual(limitedState.calls.limits, [
    { key: `crop:203.0.113.53:${DRAWING_ID}` },
  ]);
  assert.equal(limitedState.calls.prepared.length, 0);
});

test("crop endpoints return 404 for a missing drawing and never write metadata", async (t) => {
  for (const method of ["GET", "PUT", "DELETE"]) {
    await t.test(method, async () => {
      const worker = await loadWorker();
      const { env, calls } = makeStatefulEnv({ drawings: [] });
      const response = await worker.fetch(
        method === "GET"
          ? new Request(
              `http://localhost/api/drawings/${DRAWING_ID}/crop`,
            )
          : cropRequest(
              DRAWING_ID,
              method,
              method === "PUT" ? A4_CROP : undefined,
              method === "PUT"
                ? { "content-type": "application/json" }
                : {},
            ),
        env,
        executionContext(),
      );

      assert.equal(response.status, 404);
      assert.deepEqual(await response.json(), { error: "not found" });
      assert.equal(calls.run.length, 0);
    });
  }
});

test("crop migration is additive, constrained, cascading, and leaves drawing writes immutable", async () => {
  const migration = await readFile(
    new URL("../migrations/0003_create_drawing_crops.sql", import.meta.url),
    "utf8",
  );
  const drawingsSource = await readFile(
    new URL("../db/drawings.ts", import.meta.url),
    "utf8",
  );
  const upsertStart = drawingsSource.indexOf(
    "export async function upsertDrawing(",
  );
  const upsertEnd = drawingsSource.indexOf(
    "export async function listDrawingMetadata(",
    upsertStart,
  );
  assert.ok(upsertStart >= 0 && upsertEnd > upsertStart);
  const drawingUpsert = compactSql(
    drawingsSource.slice(upsertStart, upsertEnd),
  );
  const compactMigration = compactSql(migration);

  assert.match(compactMigration, /^CREATE TABLE IF NOT EXISTS drawing_crops \(/i);
  assert.match(
    compactMigration,
    /drawing_id TEXT PRIMARY KEY NOT NULL REFERENCES drawings\(id\) ON DELETE CASCADE/i,
  );
  assert.match(
    compactMigration,
    /revision INTEGER NOT NULL DEFAULT 1 CHECK \(revision >= 1\)/i,
  );
  assert.match(compactMigration, /CHECK \(x \+ width <= 595\.001\)/i);
  assert.match(compactMigration, /CHECK \(y \+ height <= 842\.001\)/i);
  assert.match(
    compactMigration,
    /CHECK \(abs\(width \* 842\.0 - height \* 595\.0\) <= 1\.0\)/i,
  );
  assert.match(compactMigration, /\) STRICT;$/i);
  assert.doesNotMatch(compactMigration, /\b(?:ALTER|DROP) TABLE\b/i);

  assert.match(drawingUpsert, /ON CONFLICT\(id\) DO NOTHING/i);
  assert.doesNotMatch(drawingUpsert, /DO UPDATE/i);
});
