import handler from "vinext/server/app-router-entry";
import { strToU8, zipSync } from "fflate";
import {
  findDrawingById,
  findDrawingsByIds,
  listDrawingMetadata,
  upsertDrawing,
  type DrawingMetadataRow,
  type DrawingRow,
} from "../db/drawings";

type Point = { x: number; y: number };
type DrawingPayload = {
  id: string;
  width: number;
  height: number;
  strokes: Point[][];
};

const WIDTH = 1000;
const HEIGHT = 700;
const MAX_BODY_BYTES = 128 * 1024;
const MAX_POINTS = 3200;
const LIST_PAGE_SIZE = 100;
const MAX_DOWNLOADS = 50;
const MAX_ARCHIVE_INPUT_BYTES = 1024 * 1024;
const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

class RequestError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
}

function json(data: unknown, status = 200, extraHeaders?: HeadersInit) {
  return Response.json(data, {
    status,
    headers: {
      "cache-control": "no-store",
      "x-content-type-options": "nosniff",
      ...extraHeaders,
    },
  });
}

async function readBoundedJson(request: Request) {
  const declaredLength = Number(request.headers.get("content-length") ?? "0");
  if (Number.isFinite(declaredLength) && declaredLength > MAX_BODY_BYTES) {
    throw new RequestError("too large", 413);
  }
  if (!request.body) throw new RequestError("missing body", 400);

  const reader = request.body.getReader();
  const decoder = new TextDecoder();
  let size = 0;
  let text = "";

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > MAX_BODY_BYTES) {
        await reader.cancel();
        throw new RequestError("too large", 413);
      }
      text += decoder.decode(value, { stream: true });
    }
    text += decoder.decode();
  } finally {
    reader.releaseLock();
  }

  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new RequestError("invalid body", 400);
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function validatePayload(value: unknown): DrawingPayload {
  if (!isRecord(value)) throw new RequestError("invalid drawing", 400);
  if (typeof value.id !== "string" || !UUID_PATTERN.test(value.id)) {
    throw new RequestError("invalid drawing", 400);
  }
  if (value.width !== WIDTH || value.height !== HEIGHT) {
    throw new RequestError("invalid drawing", 400);
  }
  if (!Array.isArray(value.strokes) || value.strokes.length !== 5) {
    throw new RequestError("invalid drawing", 400);
  }

  let pointCount = 0;
  const strokes = value.strokes.map((stroke) => {
    if (!Array.isArray(stroke) || stroke.length < 2 || stroke.length > 900) {
      throw new RequestError("invalid drawing", 400);
    }
    pointCount += stroke.length;
    if (pointCount > MAX_POINTS) throw new RequestError("too large", 413);

    return stroke.map((point) => {
      if (!isRecord(point)) throw new RequestError("invalid drawing", 400);
      const x = point.x;
      const y = point.y;
      if (
        typeof x !== "number" ||
        typeof y !== "number" ||
        !Number.isFinite(x) ||
        !Number.isFinite(y) ||
        x < 0 ||
        x > WIDTH ||
        y < 0 ||
        y > HEIGHT
      ) {
        throw new RequestError("invalid drawing", 400);
      }
      return { x, y };
    });
  });

  return { id: value.id, width: WIDTH, height: HEIGHT, strokes };
}

function validateDownload(value: unknown) {
  if (!isRecord(value) || !Array.isArray(value.ids)) {
    throw new RequestError("invalid selection", 400);
  }
  if (value.ids.length < 1 || value.ids.length > MAX_DOWNLOADS) {
    throw new RequestError("invalid selection", 400);
  }

  const ids = value.ids.map((id) => {
    if (typeof id !== "string" || !UUID_PATTERN.test(id)) {
      throw new RequestError("invalid selection", 400);
    }
    return id;
  });
  if (new Set(ids).size !== ids.length) {
    throw new RequestError("invalid selection", 400);
  }
  return ids;
}

function parseCursor(value: string | null) {
  if (value === null) return undefined;
  const separator = value.indexOf(":");
  const createdAt = Number(value.slice(0, separator));
  const id = value.slice(separator + 1);
  if (
    separator < 1 ||
    !Number.isSafeInteger(createdAt) ||
    createdAt < 0 ||
    !UUID_PATTERN.test(id)
  ) {
    throw new RequestError("invalid cursor", 400);
  }
  return { createdAt, id };
}

function drawingName(drawing: DrawingMetadataRow) {
  const timestamp = new Date(drawing.created_at * 1000)
    .toISOString()
    .replace(/[:.]/g, "-");
  return `${timestamp}_${drawing.id}.svg`;
}

function pathFromPoints(points: Point[]) {
  const fixed = (value: number) => value.toFixed(1);
  let path = `M ${fixed(points[0].x)} ${fixed(points[0].y)}`;

  for (let index = 1; index < points.length - 1; index += 1) {
    const point = points[index];
    const next = points[index + 1];
    path += ` Q ${fixed(point.x)} ${fixed(point.y)} ${fixed((point.x + next.x) / 2)} ${fixed((point.y + next.y) / 2)}`;
  }

  const last = points[points.length - 1];
  return `${path} L ${fixed(last.x)} ${fixed(last.y)}`;
}

function buildSvg(payload: DrawingPayload) {
  const paths = payload.strokes
    .map(
      (stroke) =>
        `<path d="${pathFromPoints(stroke)}" fill="none" stroke="#171713" stroke-width="4" stroke-linecap="round" stroke-linejoin="round"/>`,
    )
    .join("");

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${WIDTH}" height="${HEIGHT}" viewBox="0 0 ${WIDTH} ${HEIGHT}"><title>Untitled gesture</title>${paths}</svg>`;
}

async function handleDrawing(request: Request, env: Env) {
  const contentType = request.headers.get("content-type")?.toLowerCase() ?? "";
  if (!contentType.startsWith("application/json")) {
    return json({ error: "unsupported content type" }, 415);
  }

  const payload = validatePayload(await readBoundedJson(request));
  const svg = buildSvg(payload);
  const bytes = new TextEncoder().encode(svg).byteLength;
  if (bytes > MAX_BODY_BYTES) {
    throw new RequestError("too large", 413);
  }

  const result = await upsertDrawing(env.DB, {
    id: payload.id,
    svg,
    width: payload.width,
    height: payload.height,
  });
  if (!result.success) throw new Error("database write failed");

  console.log(JSON.stringify({ event: "drawing.saved", id: payload.id, bytes }));
  return json({ id: payload.id }, 201);
}

async function handleDrawingList(url: URL, env: Env) {
  const requestedLimit = Number(url.searchParams.get("limit") ?? LIST_PAGE_SIZE);
  if (
    !Number.isInteger(requestedLimit) ||
    requestedLimit < 1 ||
    requestedLimit > LIST_PAGE_SIZE
  ) {
    throw new RequestError("invalid limit", 400);
  }

  const rows = await listDrawingMetadata(
    env.DB,
    requestedLimit + 1,
    parseCursor(url.searchParams.get("cursor")),
  );
  const hasMore = rows.length > requestedLimit;
  const page = rows.slice(0, requestedLimit);
  const last = page.at(-1);

  return json({
    drawings: page.map((drawing) => ({
      id: drawing.id,
      width: drawing.width,
      height: drawing.height,
      createdAt: new Date(drawing.created_at * 1000).toISOString(),
      updatedAt: new Date(drawing.updated_at * 1000).toISOString(),
      previewUrl: `/api/drawings/${drawing.id}.svg`,
      downloadUrl: `/api/drawings/${drawing.id}.svg?download=1`,
    })),
    nextCursor:
      hasMore && last !== undefined ? `${last.created_at}:${last.id}` : null,
  });
}

async function handleDrawingSvg(
  request: Request,
  url: URL,
  env: Env,
  id: string,
) {
  if (request.method !== "GET" && request.method !== "HEAD") {
    return json({ error: "method not allowed" }, 405, { allow: "GET, HEAD" });
  }

  const drawing = await findDrawingById(env.DB, id);
  if (!drawing) return json({ error: "not found" }, 404);

  const attachment = url.searchParams.get("download") === "1";
  const headers = {
    "cache-control": "no-store",
    "content-disposition": `${attachment ? "attachment" : "inline"}; filename="${drawingName(drawing)}"`,
    "content-security-policy": "default-src 'none'; sandbox",
    "content-type": "image/svg+xml; charset=utf-8",
    "cross-origin-resource-policy": "same-origin",
    "x-content-type-options": "nosniff",
  };
  return new Response(request.method === "HEAD" ? null : drawing.svg, { headers });
}

async function handleDrawingDownload(request: Request, env: Env) {
  if (request.method !== "POST") {
    return json({ error: "method not allowed" }, 405, { allow: "POST" });
  }
  const contentType = request.headers.get("content-type")?.toLowerCase() ?? "";
  if (!contentType.startsWith("application/json")) {
    return json({ error: "unsupported content type" }, 415);
  }

  const ids = validateDownload(await readBoundedJson(request));
  const rows: DrawingRow[] = [];
  for (let index = 0; index < ids.length; index += 50) {
    rows.push(...(await findDrawingsByIds(env.DB, ids.slice(index, index + 50))));
  }
  const byId = new Map(rows.map((drawing) => [drawing.id, drawing]));
  if (byId.size !== ids.length) throw new RequestError("not found", 404);

  const encoder = new TextEncoder();
  let inputBytes = 0;
  const files: Record<string, Uint8Array> = {};
  for (const id of ids) {
    const drawing = byId.get(id);
    if (!drawing) throw new RequestError("not found", 404);
    const bytes = encoder.encode(drawing.svg);
    inputBytes += bytes.byteLength;
    if (inputBytes > MAX_ARCHIVE_INPUT_BYTES) {
      throw new RequestError("selection too large", 413);
    }
    files[drawingName(drawing)] = strToU8(drawing.svg);
  }

  const archive = zipSync(files, { level: 0 });
  const body = archive.buffer.slice(
    archive.byteOffset,
    archive.byteOffset + archive.byteLength,
  ) as ArrayBuffer;
  return new Response(body, {
    headers: {
      "cache-control": "no-store",
      "content-disposition": 'attachment; filename="kept.zip"',
      "content-type": "application/zip",
      "x-content-type-options": "nosniff",
    },
  });
}

async function handleApi(request: Request, url: URL, env: Env) {
  try {
    if (url.pathname === "/api/drawings/download") {
      return await handleDrawingDownload(request, env);
    }

    const drawingMatch = url.pathname.match(
      /^\/api\/drawings\/([0-9a-f-]+)\.svg$/i,
    );
    if (drawingMatch) {
      if (!UUID_PATTERN.test(drawingMatch[1])) return json({ error: "not found" }, 404);
      return await handleDrawingSvg(request, url, env, drawingMatch[1]);
    }

    if (url.pathname === "/api/drawings") {
      if (request.method === "GET") return await handleDrawingList(url, env);
      if (request.method === "POST") {
        const actor = request.headers.get("cf-connecting-ip") ?? "unknown";
        const { success } = await env.SUBMISSION_RATE_LIMITER.limit({
          key: `drawing:${actor}`,
        });
        if (!success) {
          return json({ error: "slow down" }, 429, { "retry-after": "60" });
        }
        return await handleDrawing(request, env);
      }
      return json({ error: "method not allowed" }, 405, { allow: "GET, POST" });
    }
    return json({ error: "not found" }, 404);
  } catch (error) {
    if (error instanceof RequestError) {
      return json({ error: error.message }, error.status);
    }
    console.error(
      JSON.stringify({
        event: "drawing.failed",
        requestId: crypto.randomUUID(),
      }),
    );
    return json({ error: "unable to complete request" }, 500);
  }
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    if (url.pathname.startsWith("/api/")) {
      return handleApi(request, url, env);
    }

    return handler.fetch(request, env, ctx);
  },
} satisfies ExportedHandler<Env>;
