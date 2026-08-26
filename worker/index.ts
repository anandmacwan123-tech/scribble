import handler from "vinext/server/app-router-entry";
import { zipSync } from "fflate";
import {
  deleteDrawingCrop,
  deleteAllDrawings,
  drawingExistsById,
  findDrawingById,
  findDrawingCropById,
  findDrawingsByIds,
  listDrawingMetadata,
  upsertDrawingCrop,
  type BaseDrawingMetadataRow,
  type DrawingCropRow,
  upsertDrawing,
  type DrawingRow,
} from "../db/drawings";

type Point = { x: number; y: number };
type DrawingPayload = {
  id: string;
  width: number;
  height: number;
  strokes: Point[][];
};
type DrawingCrop = {
  x: number;
  y: number;
  width: number;
  height: number;
};

const A4_WIDTH = 595;
const A4_HEIGHT = 842;
const PREVIOUS_A4_WIDTH = 842;
const PREVIOUS_A4_HEIGHT = 595;
const LEGACY_WIDTH = 1000;
const LEGACY_HEIGHT = 700;
const MAX_BODY_BYTES = 384 * 1024;
const MAX_POINTS_PER_STROKE = 900;
const MAX_POINTS = 8000;
const MAX_STROKES = MAX_POINTS / 2;
const LIST_PAGE_SIZE = 100;
const MAX_DOWNLOADS = 500;
const MAX_ARCHIVE_INPUT_BYTES = 8 * 1024 * 1024;
const MIN_CROP_WIDTH = 12;
const MIN_CROP_HEIGHT = (MIN_CROP_WIDTH * A4_HEIGHT) / A4_WIDTH;
const CROP_CROSS_PRODUCT_TOLERANCE = 1;
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
  const usesA4Canvas = value.width === A4_WIDTH && value.height === A4_HEIGHT;
  const usesPreviousA4Canvas =
    value.width === PREVIOUS_A4_WIDTH && value.height === PREVIOUS_A4_HEIGHT;
  const usesLegacyCanvas =
    value.width === LEGACY_WIDTH && value.height === LEGACY_HEIGHT;
  if (!usesA4Canvas && !usesPreviousA4Canvas && !usesLegacyCanvas) {
    throw new RequestError("invalid drawing", 400);
  }
  const width = value.width as number;
  const height = value.height as number;
  if (
    !Array.isArray(value.strokes) ||
    value.strokes.length < 1 ||
    value.strokes.length > MAX_STROKES
  ) {
    throw new RequestError("invalid drawing", 400);
  }

  let pointCount = 0;
  const strokes = value.strokes.map((stroke) => {
    if (
      !Array.isArray(stroke) ||
      stroke.length < 2 ||
      stroke.length > MAX_POINTS_PER_STROKE
    ) {
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
        x > width ||
        y < 0 ||
        y > height
      ) {
        throw new RequestError("invalid drawing", 400);
      }
      return { x, y };
    });
  });

  return {
    id: value.id,
    width,
    height,
    strokes,
  };
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

function validateDeleteAll(value: unknown) {
  if (
    !isRecord(value) ||
    Object.keys(value).length !== 1 ||
    value.confirmation !== "CONFIRM"
  ) {
    throw new RequestError("invalid confirmation", 400);
  }
}

function roundedCropCoordinate(value: number) {
  return Math.round(value * 1000) / 1000;
}

function validateCrop(value: unknown, status = 400): DrawingCrop {
  if (
    !isRecord(value) ||
    Object.keys(value).length !== 4 ||
    typeof value.x !== "number" ||
    typeof value.y !== "number" ||
    typeof value.width !== "number" ||
    typeof value.height !== "number"
  ) {
    throw new RequestError("invalid crop", status);
  }

  const crop = {
    x: roundedCropCoordinate(value.x),
    y: roundedCropCoordinate(value.y),
    width: roundedCropCoordinate(value.width),
    height: roundedCropCoordinate(value.height),
  };
  if (
    !Object.values(crop).every(Number.isFinite) ||
    crop.x < 0 ||
    crop.y < 0 ||
    crop.width < MIN_CROP_WIDTH ||
    crop.height < MIN_CROP_HEIGHT ||
    crop.x + crop.width > A4_WIDTH + 0.001 ||
    crop.y + crop.height > A4_HEIGHT + 0.001 ||
    Math.abs(crop.width * A4_HEIGHT - crop.height * A4_WIDTH) >
      CROP_CROSS_PRODUCT_TOLERANCE
  ) {
    throw new RequestError("invalid crop", status);
  }

  return crop;
}

function isFullCrop(crop: DrawingCrop) {
  return (
    Math.abs(crop.x) < 0.001 &&
    Math.abs(crop.y) < 0.001 &&
    Math.abs(crop.width - A4_WIDTH) < 0.001 &&
    Math.abs(crop.height - A4_HEIGHT) < 0.001
  );
}

function cropJson(crop: DrawingCropRow | null) {
  return crop
    ? {
        x: crop.x,
        y: crop.y,
        width: crop.width,
        height: crop.height,
        revision: crop.revision,
        updatedAt: new Date(crop.updated_at * 1000).toISOString(),
      }
    : null;
}

function requireCropRevision(request: Request) {
  const value = request.headers.get("if-match");
  if (value === null) {
    throw new RequestError("precondition required", 428);
  }
  const match = value.match(/^"(0|[1-9][0-9]*)"$/);
  const revision = match ? Number(match[1]) : Number.NaN;
  if (!Number.isSafeInteger(revision) || revision < 0) {
    throw new RequestError("invalid crop revision", 400);
  }
  return revision;
}

function freshCropRevision() {
  const words = crypto.getRandomValues(new Uint32Array(2));
  const high = (words[0] & 0x1fffff) || 1;
  return high * 0x1_0000_0000 + words[1];
}

function requireSameOrigin(request: Request, url: URL) {
  const fetchSite = request.headers.get("sec-fetch-site");
  if (
    request.headers.get("origin") !== url.origin ||
    (fetchSite !== null && fetchSite !== "same-origin")
  ) {
    throw new RequestError("forbidden", 403);
  }
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

function drawingName(drawing: BaseDrawingMetadataRow) {
  const timestamp = new Date(drawing.created_at * 1000)
    .toISOString()
    .replace(/[:.]/g, "-");
  return `${timestamp}_${drawing.id}.svg`;
}

function fixed(value: number) {
  const rounded = Math.abs(value) < 0.0005 ? 0 : value;
  return rounded.toFixed(3).replace(/\.?0+$/, "");
}

function placementOnA4(width: number, height: number) {
  if (
    !Number.isFinite(width) ||
    !Number.isFinite(height) ||
    width <= 0 ||
    height <= 0
  ) {
    throw new RequestError("invalid stored drawing", 500);
  }

  const scale = Math.min(A4_WIDTH / width, A4_HEIGHT / height);
  return {
    scale,
    offsetX: (A4_WIDTH - width * scale) / 2,
    offsetY: (A4_HEIGHT - height * scale) / 2,
  };
}

function placePointsOnA4(points: Point[], width: number, height: number) {
  const { scale, offsetX, offsetY } = placementOnA4(width, height);
  return points.map(({ x, y }) => ({
    x: x * scale + offsetX,
    y: y * scale + offsetY,
  }));
}

function pathFromPoints(points: Point[]) {
  let path = `M ${fixed(points[0].x)} ${fixed(points[0].y)}`;

  for (let index = 1; index < points.length - 1; index += 1) {
    const point = points[index];
    const next = points[index + 1];
    path += ` Q ${fixed(point.x)} ${fixed(point.y)} ${fixed((point.x + next.x) / 2)} ${fixed((point.y + next.y) / 2)}`;
  }

  const last = points[points.length - 1];
  return `${path} L ${fixed(last.x)} ${fixed(last.y)}`;
}

function buildA4Svg(
  paths: string[],
  strokeWidth = 1,
  nonScalingStroke = false,
  viewBox: DrawingCrop = {
    x: 0,
    y: 0,
    width: A4_WIDTH,
    height: A4_HEIGHT,
  },
) {
  const compoundPath = paths.join(" ");
  const vectorEffect = nonScalingStroke
    ? ' vector-effect="non-scaling-stroke"'
    : "";
  const element = `<path d="${compoundPath}" fill="none" stroke="#171713" stroke-width="${strokeWidth}"${vectorEffect} stroke-linecap="round" stroke-linejoin="round"/>`;
  const overflow = isFullCrop(viewBox) ? "" : ' overflow="hidden"';

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${A4_WIDTH}pt" height="${A4_HEIGHT}pt" viewBox="${fixed(viewBox.x)} ${fixed(viewBox.y)} ${fixed(viewBox.width)} ${fixed(viewBox.height)}"${overflow}><title>Kept fives</title>${element}</svg>`;
}

function buildSvg(payload: DrawingPayload) {
  return buildA4Svg(
    payload.strokes.map((stroke) =>
      pathFromPoints(
        placePointsOnA4(stroke, payload.width, payload.height),
      ),
    ),
  );
}

const PATH_NUMBER = /[-+]?(?:\d+\.?\d*|\.\d+)(?:e[-+]?\d+)?/gi;

function transformPathToA4(path: string, width: number, height: number) {
  const residue = path.replace(PATH_NUMBER, "");
  if (!/^[\s,MLQ]+$/i.test(residue)) {
    throw new RequestError("invalid stored drawing", 500);
  }

  const { scale, offsetX, offsetY } = placementOnA4(width, height);
  let coordinateIndex = 0;
  const transformed = path.replace(PATH_NUMBER, (token) => {
    const coordinate = Number(token);
    if (!Number.isFinite(coordinate)) {
      throw new RequestError("invalid stored drawing", 500);
    }
    const isX = coordinateIndex % 2 === 0;
    coordinateIndex += 1;
    return fixed(coordinate * scale + (isX ? offsetX : offsetY));
  });

  if (coordinateIndex === 0 || coordinateIndex % 2 !== 0) {
    throw new RequestError("invalid stored drawing", 500);
  }
  return transformed;
}

function buildDownloadSvg(
  drawing: DrawingRow,
  strokeWidth = 1,
  nonScalingStroke = false,
  crop?: DrawingCrop,
) {
  const paths = [
    ...drawing.svg.matchAll(/<path\b[^>]*\bd="([^"]+)"[^>]*>/gi),
  ].map((match) => match[1]);
  if (paths.length === 0) {
    throw new RequestError("invalid stored drawing", 500);
  }

  return buildA4Svg(
    paths.map((path) =>
      transformPathToA4(path, drawing.width, drawing.height),
    ),
    strokeWidth,
    nonScalingStroke,
    crop,
  );
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
    width: A4_WIDTH,
    height: A4_HEIGHT,
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
      previewUrl: `/api/drawings/${drawing.id}.svg?preview=1`,
      downloadUrl: `/api/drawings/${drawing.id}.svg?download=1`,
      crop:
        typeof drawing.crop_x === "number" &&
        typeof drawing.crop_y === "number" &&
        typeof drawing.crop_width === "number" &&
        typeof drawing.crop_height === "number" &&
        typeof drawing.crop_revision === "number" &&
        typeof drawing.crop_updated_at === "number"
          ? {
              x: drawing.crop_x,
              y: drawing.crop_y,
              width: drawing.crop_width,
              height: drawing.crop_height,
              revision: drawing.crop_revision,
              updatedAt: new Date(
                drawing.crop_updated_at * 1000,
              ).toISOString(),
            }
          : null,
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
  const preview = !attachment && url.searchParams.get("preview") === "1";
  const cropRow =
    !attachment && url.searchParams.get("crop") === "1"
      ? await findDrawingCropById(env.DB, id)
      : null;
  const crop = cropRow
    ? validateCrop(
        {
          x: cropRow.x,
          y: cropRow.y,
          width: cropRow.width,
          height: cropRow.height,
        },
        500,
      )
    : undefined;
  const svg = buildDownloadSvg(drawing, preview ? 2 : 1, preview, crop);
  const headers = {
    "cache-control": "no-store",
    "content-disposition": `${attachment ? "attachment" : "inline"}; filename="${drawingName(drawing)}"`,
    "content-security-policy": "default-src 'none'; sandbox",
    "content-type": "image/svg+xml; charset=utf-8",
    "cross-origin-resource-policy": "same-origin",
    "x-content-type-options": "nosniff",
  };
  return new Response(request.method === "HEAD" ? null : svg, { headers });
}

async function handleDrawingCrop(
  request: Request,
  url: URL,
  env: Env,
  id: string,
) {
  if (request.method === "GET") {
    if (!(await drawingExistsById(env.DB, id))) {
      return json({ error: "not found" }, 404);
    }
    return json({ id, crop: cropJson(await findDrawingCropById(env.DB, id)) });
  }

  if (request.method !== "PUT" && request.method !== "DELETE") {
    return json({ error: "method not allowed" }, 405, {
      allow: "GET, PUT, DELETE",
    });
  }

  requireSameOrigin(request, url);
  const expectedRevision = requireCropRevision(request);
  const actor = request.headers.get("cf-connecting-ip") ?? "unknown";
  const { success } = await env.SUBMISSION_RATE_LIMITER.limit({
    key: `crop:${actor}:${id}`,
  });
  if (!success) {
    return json({ error: "slow down" }, 429, { "retry-after": "60" });
  }

  if (!(await drawingExistsById(env.DB, id))) {
    return json({ error: "not found" }, 404);
  }

  if (request.method === "DELETE") {
    if (expectedRevision === 0) {
      const current = await findDrawingCropById(env.DB, id);
      if (current) {
        return json({ error: "crop changed", crop: cropJson(current) }, 412);
      }
    } else {
      const deleted = await deleteDrawingCrop(env.DB, id, expectedRevision);
      if (!deleted) {
        const current = await findDrawingCropById(env.DB, id);
        return json({ error: "crop changed", crop: cropJson(current) }, 412);
      }
    }
    console.log(JSON.stringify({ event: "drawing.crop.reset", id }));
    return json({ id, crop: null });
  }

  const contentType = request.headers.get("content-type")?.toLowerCase() ?? "";
  if (!contentType.startsWith("application/json")) {
    return json({ error: "unsupported content type" }, 415);
  }
  const crop = validateCrop(await readBoundedJson(request));
  if (isFullCrop(crop)) {
    if (expectedRevision === 0) {
      const current = await findDrawingCropById(env.DB, id);
      if (current) {
        return json({ error: "crop changed", crop: cropJson(current) }, 412);
      }
    } else {
      const deleted = await deleteDrawingCrop(env.DB, id, expectedRevision);
      if (!deleted) {
        const current = await findDrawingCropById(env.DB, id);
        return json({ error: "crop changed", crop: cropJson(current) }, 412);
      }
    }
    return json({ id, crop: null });
  }

  const stored = await upsertDrawingCrop(
    env.DB,
    id,
    crop,
    expectedRevision,
    freshCropRevision(),
  );
  if (!stored) {
    const current = await findDrawingCropById(env.DB, id);
    return json({ error: "crop changed", crop: cropJson(current) }, 412);
  }
  console.log(JSON.stringify({ event: "drawing.crop.saved", id }));
  return json({ id, crop: cropJson(stored) });
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
  const encoder = new TextEncoder();
  let inputBytes = 0;
  const files: Record<string, Uint8Array> = {};

  for (let index = 0; index < ids.length; index += 50) {
    const batchIds = ids.slice(index, index + 50);
    const rows = await findDrawingsByIds(env.DB, batchIds);
    const byId = new Map(rows.map((drawing) => [drawing.id, drawing]));
    if (byId.size !== batchIds.length) {
      throw new RequestError("not found", 404);
    }

    for (const id of batchIds) {
      const drawing = byId.get(id);
      if (!drawing) throw new RequestError("not found", 404);
      const svg = buildDownloadSvg(drawing);
      const bytes = encoder.encode(svg);
      inputBytes += bytes.byteLength;
      if (inputBytes > MAX_ARCHIVE_INPUT_BYTES) {
        throw new RequestError("selection too large", 413);
      }
      files[drawingName(drawing)] = bytes;
    }
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

async function handleDeleteAllDrawings(
  request: Request,
  url: URL,
  env: Env,
) {
  if (request.method !== "DELETE") {
    return json({ error: "method not allowed" }, 405, { allow: "DELETE" });
  }

  requireSameOrigin(request, url);

  const contentType = request.headers.get("content-type")?.toLowerCase() ?? "";
  if (!contentType.startsWith("application/json")) {
    return json({ error: "unsupported content type" }, 415);
  }

  const actor = request.headers.get("cf-connecting-ip") ?? "unknown";
  const { success } = await env.SUBMISSION_RATE_LIMITER.limit({
    key: `delete-all:${actor}`,
  });
  if (!success) {
    return json({ error: "slow down" }, 429, { "retry-after": "60" });
  }

  validateDeleteAll(await readBoundedJson(request));
  const result = await deleteAllDrawings(env.DB);
  if (!result.success) throw new Error("database delete failed");

  const deleted = result.meta.changes ?? 0;
  console.log(JSON.stringify({ event: "drawings.deleted", deleted }));
  return json({ deleted });
}

async function handleApi(request: Request, url: URL, env: Env) {
  try {
    if (url.pathname === "/api/admin/drawings") {
      return await handleDeleteAllDrawings(request, url, env);
    }

    if (url.pathname === "/api/drawings/download") {
      if (request.method === "POST") {
        const actor = request.headers.get("cf-connecting-ip") ?? "unknown";
        const { success } = await env.SUBMISSION_RATE_LIMITER.limit({
          key: `download:${actor}`,
        });
        if (!success) {
          return json({ error: "slow down" }, 429, { "retry-after": "60" });
        }
      }
      return await handleDrawingDownload(request, env);
    }

    const cropMatch = url.pathname.match(
      /^\/api\/drawings\/([0-9a-f-]+)\/crop$/i,
    );
    if (cropMatch) {
      if (!UUID_PATTERN.test(cropMatch[1])) {
        return json({ error: "not found" }, 404);
      }
      return await handleDrawingCrop(request, url, env, cropMatch[1]);
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
