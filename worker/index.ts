import handler from "vinext/server/app-router-entry";
import { upsertDrawing } from "../db/drawings";

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
  if (request.method !== "POST") {
    return json({ error: "method not allowed" }, 405, { allow: "POST" });
  }

  const contentType = request.headers.get("content-type")?.toLowerCase() ?? "";
  if (!contentType.startsWith("application/json")) {
    return json({ error: "unsupported content type" }, 415);
  }

  try {
    const payload = validatePayload(await readBoundedJson(request));
    const svg = buildSvg(payload);
    if (new TextEncoder().encode(svg).byteLength > MAX_BODY_BYTES) {
      throw new RequestError("too large", 413);
    }

    const result = await upsertDrawing(env.DB, {
      id: payload.id,
      svg,
      width: payload.width,
      height: payload.height,
    });
    if (!result.success) throw new Error("database write failed");

    console.log(
      JSON.stringify({
        event: "drawing.saved",
        id: payload.id,
        bytes: new TextEncoder().encode(svg).byteLength,
      }),
    );
    return json({ id: payload.id }, 201);
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
    return json({ error: "unable to keep drawing" }, 500);
  }
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    if (url.pathname === "/api/drawings") {
      return handleDrawing(request, env);
    }
    if (url.pathname.startsWith("/api/")) {
      return json({ error: "not found" }, 404);
    }

    return handler.fetch(request, env, ctx);
  },
} satisfies ExportedHandler<Env>;
