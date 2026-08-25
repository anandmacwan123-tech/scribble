"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";

type AnimationMode = "blink" | "solo" | "grid";

type Drawing = {
  id: string;
  width: number;
  height: number;
  createdAt: string;
  updatedAt: string;
  previewUrl: string;
};

type DrawingPage = {
  drawings: Drawing[];
  nextCursor: string | null;
};

type Layer = Drawing & {
  image: HTMLImageElement;
};

const WIDTH = 1000;
const HEIGHT = 700;
const FRAME_MS = 300;
const GRID_COLUMNS = 5;
const GRID_ROWS = 10;
const GRID_CELLS = GRID_COLUMNS * GRID_ROWS;
const SYNC_INTERVAL_MS = 10_000;
const PAPER = "#f2f0ea";

const modeCopy: Record<AnimationMode, string> = {
  blink: "all at 20%; one turns black",
  solo: "one black five at a time",
  grid: "5 × 10 masks; sources shift",
};

const timeFormatter = new Intl.DateTimeFormat(undefined, {
  month: "short",
  day: "numeric",
  hour: "2-digit",
  minute: "2-digit",
});

function versionedPreview(drawing: Drawing) {
  const url = new URL(drawing.previewUrl, window.location.origin);
  url.searchParams.set("v", drawing.updatedAt);
  return url.toString();
}

async function loadAllDrawings(signal: AbortSignal) {
  const drawings: Drawing[] = [];
  let cursor: string | null = null;

  do {
    const query = new URLSearchParams({ limit: "100" });
    if (cursor) query.set("cursor", cursor);
    const response = await fetch(`/api/drawings?${query}`, {
      cache: "no-store",
      signal,
    });
    if (!response.ok) throw new Error("load failed");
    const page = (await response.json()) as DrawingPage;
    drawings.push(...page.drawings);
    cursor = page.nextCursor;
  } while (cursor);

  return drawings;
}

function loadImage(drawing: Drawing, signal: AbortSignal) {
  return new Promise<HTMLImageElement>((resolve, reject) => {
    const image = new Image();
    const abort = () => {
      image.src = "";
      reject(new DOMException("Aborted", "AbortError"));
    };

    signal.addEventListener("abort", abort, { once: true });
    image.onload = () => {
      signal.removeEventListener("abort", abort);
      resolve(image);
    };
    image.onerror = () => {
      signal.removeEventListener("abort", abort);
      reject(new Error("image failed"));
    };
    image.src = versionedPreview(drawing);
  });
}

async function mapWithConcurrency<T, R>(
  values: T[],
  limit: number,
  task: (value: T) => Promise<R>,
) {
  const results = new Array<R>(values.length);
  let nextIndex = 0;

  const workers = Array.from(
    { length: Math.min(limit, values.length) },
    async () => {
      while (nextIndex < values.length) {
        const index = nextIndex;
        nextIndex += 1;
        results[index] = await task(values[index]);
      }
    },
  );

  await Promise.all(workers);
  return results;
}

function drawFrame(
  context: CanvasRenderingContext2D,
  layers: Layer[],
  mode: AnimationMode,
  frame: number,
) {
  context.save();
  context.globalAlpha = 1;
  context.fillStyle = PAPER;
  context.fillRect(0, 0, WIDTH, HEIGHT);

  if (layers.length === 0) {
    context.restore();
    return;
  }

  const activeIndex = frame % layers.length;

  if (mode === "blink") {
    context.globalAlpha = 0.2;
    for (const layer of layers) {
      context.drawImage(layer.image, 0, 0, WIDTH, HEIGHT);
    }
    context.globalAlpha = 1;
    context.drawImage(layers[activeIndex].image, 0, 0, WIDTH, HEIGHT);
  } else if (mode === "solo") {
    context.drawImage(layers[activeIndex].image, 0, 0, WIDTH, HEIGHT);
  } else {
    const cellWidth = WIDTH / GRID_COLUMNS;
    const cellHeight = HEIGHT / GRID_ROWS;

    for (let cell = 0; cell < GRID_CELLS; cell += 1) {
      const column = cell % GRID_COLUMNS;
      const row = Math.floor(cell / GRID_COLUMNS);
      const layer = layers[(cell + frame) % layers.length];

      context.save();
      context.beginPath();
      context.rect(
        column * cellWidth,
        row * cellHeight,
        cellWidth,
        cellHeight,
      );
      context.clip();
      context.drawImage(layer.image, 0, 0, WIDTH, HEIGHT);
      context.restore();
    }
  }

  context.restore();
}

function preferredRecordingType() {
  if (typeof MediaRecorder === "undefined") return null;
  const types = [
    "video/webm;codecs=vp9",
    "video/webm;codecs=vp8",
    "video/webm",
    "video/mp4",
  ];
  return types.find((type) => MediaRecorder.isTypeSupported(type)) ?? null;
}

function wait(milliseconds: number) {
  return new Promise<void>((resolve) => window.setTimeout(resolve, milliseconds));
}

export default function Animator() {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const layerCacheRef = useRef<Map<string, Layer>>(new Map());
  const syncControllerRef = useRef<AbortController | null>(null);
  const syncingRef = useRef(false);
  const [layers, setLayers] = useState<Layer[]>([]);
  const [hidden, setHidden] = useState<Set<string>>(new Set());
  const [mode, setMode] = useState<AnimationMode>("blink");
  const [frame, setFrame] = useState(0);
  const [playing, setPlaying] = useState(true);
  const [status, setStatus] = useState<"loading" | "ready" | "error">(
    "loading",
  );
  const [lastSyncedAt, setLastSyncedAt] = useState<Date | null>(null);
  const [exportStatus, setExportStatus] = useState<
    "idle" | "recording" | "error" | "unsupported"
  >("idle");

  const visibleLayers = useMemo(
    () => layers.filter((layer) => !hidden.has(layer.id)),
    [hidden, layers],
  );

  const sync = useCallback(async () => {
    if (syncingRef.current) return;
    syncingRef.current = true;
    syncControllerRef.current?.abort();
    const controller = new AbortController();
    syncControllerRef.current = controller;

    try {
      const drawings = await loadAllDrawings(controller.signal);
      const currentCache = layerCacheRef.current;
      const nextLayers = await mapWithConcurrency(drawings, 8, async (drawing) => {
        const cached = currentCache.get(drawing.id);
        if (cached?.updatedAt === drawing.updatedAt) return cached;
        return { ...drawing, image: await loadImage(drawing, controller.signal) };
      });
      const nextCache = new Map(nextLayers.map((layer) => [layer.id, layer]));
      layerCacheRef.current = nextCache;
      setLayers(nextLayers);
      setHidden((current) => {
        const next = new Set([...current].filter((id) => nextCache.has(id)));
        return next.size === current.size ? current : next;
      });
      setLastSyncedAt(new Date());
      setStatus("ready");
    } catch (error) {
      if (!(error instanceof DOMException && error.name === "AbortError")) {
        setStatus("error");
      }
    } finally {
      if (syncControllerRef.current === controller) {
        syncingRef.current = false;
      }
    }
  }, []);

  useEffect(() => {
    void sync();
    const interval = window.setInterval(() => void sync(), SYNC_INTERVAL_MS);
    const syncWhenVisible = () => {
      if (document.visibilityState === "visible") void sync();
    };
    window.addEventListener("focus", syncWhenVisible);
    document.addEventListener("visibilitychange", syncWhenVisible);

    return () => {
      window.clearInterval(interval);
      window.removeEventListener("focus", syncWhenVisible);
      document.removeEventListener("visibilitychange", syncWhenVisible);
      syncControllerRef.current?.abort();
    };
  }, [sync]);

  useEffect(() => {
    if (!playing || visibleLayers.length === 0) return;
    const interval = window.setInterval(
      () => setFrame((current) => current + 1),
      FRAME_MS,
    );
    return () => window.clearInterval(interval);
  }, [playing, visibleLayers.length]);

  useEffect(() => {
    const canvas = canvasRef.current;
    const context = canvas?.getContext("2d");
    if (!context) return;
    drawFrame(context, visibleLayers, mode, frame);
  }, [frame, mode, visibleLayers]);

  const changeMode = (nextMode: AnimationMode) => {
    setMode(nextMode);
    setFrame(0);
    setPlaying(true);
  };

  const toggleLayer = (id: string) => {
    setHidden((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
    setFrame(0);
  };

  const showAll = () => {
    setHidden(new Set());
    setFrame(0);
  };

  const hideAll = () => {
    setHidden(new Set(layers.map((layer) => layer.id)));
    setFrame(0);
    setPlaying(false);
  };

  const exportAnimation = async () => {
    if (visibleLayers.length === 0 || exportStatus === "recording") return;
    const mimeType = preferredRecordingType();
    const sourceCanvas = canvasRef.current;
    if (!mimeType || !sourceCanvas || !("captureStream" in sourceCanvas)) {
      setExportStatus("unsupported");
      return;
    }

    setExportStatus("recording");
    const exportCanvas = document.createElement("canvas");
    exportCanvas.width = WIDTH;
    exportCanvas.height = HEIGHT;
    const context = exportCanvas.getContext("2d");
    if (!context) {
      setExportStatus("error");
      return;
    }

    const stream = exportCanvas.captureStream(30);
    const recorder = new MediaRecorder(stream, {
      mimeType,
      videoBitsPerSecond: 8_000_000,
    });
    const chunks: Blob[] = [];
    recorder.ondataavailable = (event) => {
      if (event.data.size > 0) chunks.push(event.data);
    };

    const finished = new Promise<Blob>((resolve, reject) => {
      recorder.onerror = () => reject(new Error("recording failed"));
      recorder.onstop = () => resolve(new Blob(chunks, { type: mimeType }));
    });

    try {
      recorder.start();
      for (let exportFrame = 0; exportFrame < visibleLayers.length; exportFrame += 1) {
        drawFrame(context, visibleLayers, mode, exportFrame);
        await wait(FRAME_MS);
      }
      recorder.stop();
      const blob = await finished;
      const href = URL.createObjectURL(blob);
      const anchor = document.createElement("a");
      const extension = mimeType.includes("mp4") ? "mp4" : "webm";
      anchor.href = href;
      anchor.download = `5A-${mode}-${WIDTH}x${HEIGHT}.${extension}`;
      document.body.appendChild(anchor);
      anchor.click();
      anchor.remove();
      window.setTimeout(() => URL.revokeObjectURL(href), 0);
      setExportStatus("idle");
    } catch {
      if (recorder.state !== "inactive") recorder.stop();
      setExportStatus("error");
    } finally {
      for (const track of stream.getTracks()) track.stop();
    }
  };

  const cycleSeconds = (visibleLayers.length * FRAME_MS) / 1000;
  const activeLayer =
    visibleLayers.length > 0 ? (frame % visibleLayers.length) + 1 : 0;

  return (
    <main className="animator-page" aria-busy={status === "loading"}>
      <header className="animator-header">
        <div className="animator-title-group">
          <a className="animator-back" href="/5" aria-label="Back to kept drawings">
            ←
          </a>
          <h1>5A.</h1>
          <span className="animator-subtitle">animation tool</span>
        </div>
        <div className="animator-sync" aria-live="polite">
          <span>
            {status === "loading"
              ? "importing layers…"
              : status === "error"
                ? "sync interrupted"
                : `${layers.length} layer${layers.length === 1 ? "" : "s"} · live`}
          </span>
          <button type="button" onClick={() => void sync()}>
            sync
          </button>
        </div>
      </header>

      <section className="animator-tools" aria-label="Animation controls">
        <div className="animator-tool-group">
          <span className="animator-label">effect</span>
          {(["blink", "solo", "grid"] as const).map((effect, index) => (
            <button
              className={`animator-mode${mode === effect ? " animator-mode--active" : ""}`}
              type="button"
              aria-pressed={mode === effect}
              onClick={() => changeMode(effect)}
              key={effect}
            >
              <span>{index + 1}</span>
              <strong>{effect}</strong>
              <small>{modeCopy[effect]}</small>
            </button>
          ))}
        </div>

        <div className="animator-transport">
          <span className="animator-label">transport</span>
          <div className="animator-transport-row">
            <button
              type="button"
              disabled={visibleLayers.length === 0}
              onClick={() => setPlaying((current) => !current)}
            >
              {playing ? "pause" : "play"}
            </button>
            <button
              type="button"
              disabled={visibleLayers.length === 0}
              onClick={() => setFrame(0)}
            >
              restart
            </button>
          </div>
          <p>
            frame {activeLayer} / {visibleLayers.length}
            <br />
            300 ms · {cycleSeconds.toFixed(1)} s loop
          </p>
        </div>

        <div className="animator-export">
          <span className="animator-label">output</span>
          <button
            type="button"
            disabled={visibleLayers.length === 0 || exportStatus === "recording"}
            onClick={() => void exportAnimation()}
          >
            {exportStatus === "recording" ? "recording loop…" : "export animation"}
          </button>
          <p>A4 canvas · {WIDTH} × {HEIGHT}</p>
          {exportStatus === "unsupported" ? (
            <p className="animator-error">animation export isn’t supported here.</p>
          ) : null}
          {exportStatus === "error" ? (
            <p className="animator-error">couldn’t export this loop.</p>
          ) : null}
        </div>
      </section>

      <section className="animator-stage" aria-label="Animation preview">
        <div className="animation-paper">
          <canvas
            ref={canvasRef}
            width={WIDTH}
            height={HEIGHT}
            role="img"
            aria-label={`${mode} animation preview using ${visibleLayers.length} visible layers`}
          />
          {status === "ready" && layers.length === 0 ? (
            <p className="animator-empty">nothing kept yet.</p>
          ) : null}
        </div>
        <div className="animator-stage-note">
          <span>{modeCopy[mode]}</span>
          <span>{playing ? "playing" : "paused"}</span>
        </div>
      </section>

      <aside className="animator-layers" aria-label="Drawing layers">
        <div className="animator-layers-header">
          <div>
            <span className="animator-label">layers</span>
            <p>{visibleLayers.length} visible</p>
          </div>
          <div>
            <button type="button" onClick={showAll} disabled={hidden.size === 0}>
              all
            </button>
            <button
              type="button"
              onClick={hideAll}
              disabled={visibleLayers.length === 0}
            >
              none
            </button>
          </div>
        </div>

        {status === "error" ? (
          <button className="animator-retry" type="button" onClick={() => void sync()}>
            retry layer sync
          </button>
        ) : null}

        <ol className="animator-layer-list">
          {layers.map((layer, index) => {
            const visible = !hidden.has(layer.id);
            return (
              <li key={layer.id}>
                <label className={visible ? "" : "animator-layer--hidden"}>
                  <input
                    type="checkbox"
                    checked={visible}
                    onChange={() => toggleLayer(layer.id)}
                  />
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img src={layer.image.src} alt="" loading="lazy" draggable="false" />
                  <span>
                    <strong>five {String(index + 1).padStart(3, "0")}</strong>
                    <small>{timeFormatter.format(new Date(layer.createdAt))}</small>
                  </span>
                </label>
              </li>
            );
          })}
        </ol>

        <p className="animator-last-sync">
          {lastSyncedAt
            ? `synced ${lastSyncedAt.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" })}`
            : "waiting for first sync"}
        </p>
      </aside>
    </main>
  );
}
