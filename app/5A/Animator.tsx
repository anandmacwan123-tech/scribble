"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { buildGridTimeline, type GridTimelineFrame } from "./grid";

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
  greyImage: HTMLImageElement;
  objectUrls: [string, string];
};

const WIDTH = 595;
const HEIGHT = 842;
const DEFAULT_SPEED_MS = 300;
const MIN_SPEED_MS = 50;
const MAX_SPEED_MS = 5000;
const GRID_COLUMNS = 5;
const GRID_ROWS = 10;
const GRID_CELLS = GRID_COLUMNS * GRID_ROWS;
const SYNC_INTERVAL_MS = 10_000;
const BACKGROUND = "#FFFFFF";
const GREY = "#CCCCCC";

function clamp(value: number, minimum: number, maximum: number) {
  return Math.min(maximum, Math.max(minimum, value));
}

function normalizeSpeed(value: number) {
  return clamp(Math.round(value), MIN_SPEED_MS, MAX_SPEED_MS);
}

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

function loadImage(source: string, signal: AbortSignal) {
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
    image.src = source;
  });
}

async function loadLayer(drawing: Drawing, signal: AbortSignal) {
  const response = await fetch(versionedPreview(drawing), {
    cache: "no-store",
    signal,
  });
  if (!response.ok) throw new Error("image failed");

  const svg = await response.text();
  const greySvg = svg.replace(/#171713/gi, GREY);
  const imageUrl = URL.createObjectURL(
    new Blob([svg], { type: "image/svg+xml;charset=utf-8" }),
  );
  const greyImageUrl = URL.createObjectURL(
    new Blob([greySvg], { type: "image/svg+xml;charset=utf-8" }),
  );

  try {
    const [image, greyImage] = await Promise.all([
      loadImage(imageUrl, signal),
      loadImage(greyImageUrl, signal),
    ]);
    return {
      ...drawing,
      image,
      greyImage,
      objectUrls: [imageUrl, greyImageUrl] as [string, string],
    };
  } catch (error) {
    URL.revokeObjectURL(imageUrl);
    URL.revokeObjectURL(greyImageUrl);
    throw error;
  }
}

function releaseLayer(layer: Layer) {
  for (const url of layer.objectUrls) URL.revokeObjectURL(url);
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
  gridTimeline: GridTimelineFrame[],
  gridOpacity: number,
) {
  context.save();
  context.globalAlpha = 1;
  context.fillStyle = BACKGROUND;
  context.fillRect(0, 0, WIDTH, HEIGHT);

  if (layers.length === 0) {
    context.restore();
    return;
  }

  const activeIndex = frame % layers.length;
  const drawLayer = (layer: Layer, grey = false) => {
    context.drawImage(
      grey ? layer.greyImage : layer.image,
      0,
      0,
      WIDTH,
      HEIGHT,
    );
  };

  if (mode === "blink") {
    for (const layer of layers) {
      drawLayer(layer, true);
    }
    drawLayer(layers[activeIndex]);
  } else if (mode === "solo") {
    drawLayer(layers[activeIndex]);
  } else {
    const cellWidth = WIDTH / GRID_COLUMNS;
    const cellHeight = HEIGHT / GRID_ROWS;
    const gridFrame =
      gridTimeline.length > 0
        ? gridTimeline[frame % gridTimeline.length].layerIndexes
        : null;
    context.globalAlpha = gridOpacity;

    for (let cell = 0; cell < GRID_CELLS; cell += 1) {
      const column = cell % GRID_COLUMNS;
      const row = Math.floor(cell / GRID_COLUMNS);
      const layer = layers[gridFrame?.[cell] ?? cell % layers.length];

      context.save();
      context.beginPath();
      context.rect(
        column * cellWidth,
        row * cellHeight,
        cellWidth,
        cellHeight,
      );
      context.clip();
      drawLayer(layer);
      context.restore();
    }
  }

  context.restore();
}

export default function Animator() {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const layerCacheRef = useRef<Map<string, Layer>>(new Map());
  const syncControllerRef = useRef<AbortController | null>(null);
  const syncingRef = useRef(false);
  const previewUrlRef = useRef<string | null>(null);
  const previewGenerationRef = useRef(0);
  const [layers, setLayers] = useState<Layer[]>([]);
  const [hidden, setHidden] = useState<Set<string>>(new Set());
  const [mode, setMode] = useState<AnimationMode>("blink");
  const [frame, setFrame] = useState(0);
  const [speedInput, setSpeedInput] = useState(String(DEFAULT_SPEED_MS));
  const [gridOpacityPercent, setGridOpacityPercent] = useState(100);
  const [gridSeed, setGridSeed] = useState(() => Date.now() >>> 0);
  const [playing, setPlaying] = useState(true);
  const [status, setStatus] = useState<"loading" | "ready" | "error">(
    "loading",
  );
  const [exportStatus, setExportStatus] = useState<
    "idle" | "encoding" | "error" | "unsupported"
  >("idle");
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);

  const visibleLayers = useMemo(
    () => layers.filter((layer) => !hidden.has(layer.id)),
    [hidden, layers],
  );
  const parsedSpeed = Number(speedInput);
  const speedMs = normalizeSpeed(
    speedInput.trim() !== "" && Number.isFinite(parsedSpeed)
      ? parsedSpeed
      : DEFAULT_SPEED_MS,
  );
  const gridTimeline = useMemo(
    () =>
      buildGridTimeline(
        visibleLayers.map(({ id }) => id),
        GRID_CELLS,
        gridSeed,
        speedMs,
        speedMs * 2,
      ),
    [gridSeed, speedMs, visibleLayers],
  );
  const gridOpacity = gridOpacityPercent / 100;

  const discardExportPreview = useCallback(() => {
    previewGenerationRef.current += 1;
    if (previewUrlRef.current) {
      URL.revokeObjectURL(previewUrlRef.current);
      previewUrlRef.current = null;
    }
    setPreviewUrl(null);
    setExportStatus("idle");
  }, []);

  const sync = useCallback(async () => {
    if (syncingRef.current) return;
    syncingRef.current = true;
    syncControllerRef.current?.abort();
    const controller = new AbortController();
    syncControllerRef.current = controller;
    const createdLayers: Layer[] = [];

    try {
      const drawings = await loadAllDrawings(controller.signal);
      const currentCache = layerCacheRef.current;
      const nextLayers = await mapWithConcurrency(drawings, 8, async (drawing) => {
        const cached = currentCache.get(drawing.id);
        if (cached?.updatedAt === drawing.updatedAt) return cached;
        const layer = await loadLayer(drawing, controller.signal);
        createdLayers.push(layer);
        return layer;
      });
      const nextCache = new Map(nextLayers.map((layer) => [layer.id, layer]));
      const layersChanged =
        nextLayers.length !== currentCache.size ||
        nextLayers.some((layer) => currentCache.get(layer.id) !== layer);
      for (const [id, layer] of currentCache) {
        if (nextCache.get(id) !== layer) releaseLayer(layer);
      }
      layerCacheRef.current = nextCache;
      if (layersChanged) discardExportPreview();
      setLayers(nextLayers);
      setHidden((current) => {
        const next = new Set([...current].filter((id) => nextCache.has(id)));
        return next.size === current.size ? current : next;
      });
      setStatus("ready");
    } catch (error) {
      for (const layer of createdLayers) releaseLayer(layer);
      if (!(error instanceof DOMException && error.name === "AbortError")) {
        setStatus("error");
      }
    } finally {
      if (syncControllerRef.current === controller) {
        syncingRef.current = false;
      }
    }
  }, [discardExportPreview]);

  useEffect(() => {
    const firstSync = window.setTimeout(() => void sync(), 0);
    const interval = window.setInterval(() => void sync(), SYNC_INTERVAL_MS);
    const syncWhenVisible = () => {
      if (document.visibilityState === "visible") void sync();
    };
    window.addEventListener("focus", syncWhenVisible);
    document.addEventListener("visibilitychange", syncWhenVisible);

    return () => {
      window.clearTimeout(firstSync);
      window.clearInterval(interval);
      window.removeEventListener("focus", syncWhenVisible);
      document.removeEventListener("visibilitychange", syncWhenVisible);
      syncControllerRef.current?.abort();
      syncingRef.current = false;
      previewGenerationRef.current += 1;
      if (previewUrlRef.current) URL.revokeObjectURL(previewUrlRef.current);
      for (const layer of layerCacheRef.current.values()) releaseLayer(layer);
      layerCacheRef.current.clear();
    };
  }, [sync]);

  useEffect(() => {
    if (!playing || visibleLayers.length === 0) return;
    const delay =
      mode === "grid"
        ? (gridTimeline[frame % gridTimeline.length]?.durationMs ?? speedMs)
        : speedMs;
    const timeout = window.setTimeout(
      () => setFrame((current) => current + 1),
      delay,
    );
    return () => window.clearTimeout(timeout);
  }, [frame, gridTimeline, mode, playing, speedMs, visibleLayers.length]);

  useEffect(() => {
    const canvas = canvasRef.current;
    const context = canvas?.getContext("2d");
    if (!context) return;
    drawFrame(
      context,
      visibleLayers,
      mode,
      frame,
      gridTimeline,
      gridOpacity,
    );
  }, [frame, gridOpacity, gridTimeline, mode, visibleLayers]);

  const changeMode = (nextMode: AnimationMode) => {
    if (nextMode !== mode || nextMode === "grid") discardExportPreview();
    if (nextMode === "grid") {
      setGridSeed((current) => (current + 0x9e3779b9) >>> 0);
    }
    setMode(nextMode);
    setFrame(0);
    setPlaying(true);
  };

  const toggleLayer = (id: string) => {
    discardExportPreview();
    setHidden((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
    setFrame(0);
  };

  const showAll = () => {
    discardExportPreview();
    setHidden(new Set());
    setFrame(0);
  };

  const hideAll = () => {
    discardExportPreview();
    setHidden(new Set(layers.map((layer) => layer.id)));
    setFrame(0);
    setPlaying(false);
  };

  const restart = () => {
    if (mode === "grid") {
      discardExportPreview();
      setGridSeed((current) => (current + 0x9e3779b9) >>> 0);
    }
    setFrame(0);
  };

  const changeSpeed = (value: string) => {
    discardExportPreview();
    setSpeedInput(value);
    setFrame(0);
  };

  const changeGridOpacity = (value: number) => {
    if (!Number.isFinite(value)) return;
    discardExportPreview();
    setGridOpacityPercent(clamp(Math.round(value), 0, 100));
  };

  const previewAnimation = async () => {
    if (visibleLayers.length === 0 || exportStatus === "encoding") return;
    if (typeof VideoEncoder === "undefined") {
      setExportStatus("unsupported");
      return;
    }

    const generation = previewGenerationRef.current + 1;
    previewGenerationRef.current = generation;
    if (previewUrlRef.current) {
      URL.revokeObjectURL(previewUrlRef.current);
      previewUrlRef.current = null;
    }
    setPreviewUrl(null);
    setExportStatus("encoding");
    const exportCanvas = document.createElement("canvas");
    exportCanvas.width = WIDTH;
    exportCanvas.height = HEIGHT;
    const context = exportCanvas.getContext("2d");
    if (!context) {
      setExportStatus("error");
      return;
    }

    try {
      const {
        BufferTarget,
        CanvasSource,
        Mp4OutputFormat,
        Output,
        Quality,
      } = await import("mediabunny");
      const target = new BufferTarget();
      const output = new Output({
        format: new Mp4OutputFormat({ fastStart: "in-memory" }),
        target,
      });
      const source = new CanvasSource(exportCanvas, {
        codec: "avc",
        quality: new Quality({ bitrate: 8_000_000 }),
        keyFrameInterval: 2,
      });
      output.addVideoTrack(source);
      await output.start();

      const exportFrameCount =
        mode === "grid" ? gridTimeline.length : visibleLayers.length;
      let exportTimestamp = 0;

      for (let exportFrame = 0; exportFrame < exportFrameCount; exportFrame += 1) {
        const exportFrameSeconds =
          mode === "grid"
            ? gridTimeline[exportFrame].durationMs / 1000
            : speedMs / 1000;
        drawFrame(
          context,
          visibleLayers,
          mode,
          exportFrame,
          gridTimeline,
          gridOpacity,
        );
        await source.add(exportTimestamp, exportFrameSeconds, {
          keyFrame: exportFrame === 0,
        });
        exportTimestamp += exportFrameSeconds;
      }
      await output.finalize();
      if (!target.buffer) throw new Error("empty export");
      if (previewGenerationRef.current !== generation) return;

      const blob = new Blob([target.buffer], { type: "video/mp4" });
      const url = URL.createObjectURL(blob);
      previewUrlRef.current = url;
      setPreviewUrl(url);
      setExportStatus("idle");
    } catch {
      if (previewGenerationRef.current === generation) {
        setExportStatus("error");
      }
    }
  };

  const downloadPreview = () => {
    if (!previewUrlRef.current) return;
    const anchor = document.createElement("a");
    anchor.href = previewUrlRef.current;
    anchor.download = `5A-${mode}-${WIDTH}x${HEIGHT}.mp4`;
    document.body.appendChild(anchor);
    anchor.click();
    anchor.remove();
  };

  return (
    <main className="animator-page" aria-busy={status === "loading"}>
      <header className="animator-header">
        <div className="animator-title-group">
          <a className="animator-back" href="/5" aria-label="Back to kept drawings">
            ←
          </a>
          <h1>5A.</h1>
        </div>
        <div className="animator-sync" aria-live="polite">
          <button
            type="button"
            disabled={status === "loading"}
            onClick={() => void sync()}
          >
            {status === "loading" ? "loading…" : status === "error" ? "retry" : "sync"}
          </button>
        </div>
      </header>

      <section className="animator-tools" aria-label="Animation controls">
        <div className="animator-tool-group">
          <span className="animator-label">effect</span>
          {(["blink", "solo", "grid"] as const).map((effect) => (
            <button
              className={`animator-mode${mode === effect ? " animator-mode--active" : ""}`}
              type="button"
              aria-pressed={mode === effect}
              onClick={() => changeMode(effect)}
              key={effect}
            >
              <strong>{effect}</strong>
            </button>
          ))}
        </div>

        <div className="animator-settings">
          <label className="animator-input-row">
            <span className="animator-label">speed</span>
            <span className="animator-input-value">
              <input
                type="number"
                min={MIN_SPEED_MS}
                max={MAX_SPEED_MS}
                step="1"
                value={speedInput}
                onChange={(event) => changeSpeed(event.currentTarget.value)}
                onBlur={() => setSpeedInput(String(speedMs))}
                aria-label="Animation speed in milliseconds"
              />
              <span>ms</span>
            </span>
          </label>
          {mode === "grid" ? (
            <label className="animator-input-row">
              <span className="animator-label">opacity</span>
              <span className="animator-input-value">
                <input
                  type="number"
                  min="0"
                  max="100"
                  step="5"
                  value={gridOpacityPercent}
                  onChange={(event) =>
                    changeGridOpacity(event.currentTarget.valueAsNumber)
                  }
                  aria-label="Grid opacity percentage"
                />
                <span>%</span>
              </span>
            </label>
          ) : null}
        </div>

        <div className="animator-transport">
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
              onClick={restart}
            >
              restart
            </button>
          </div>
        </div>

        <div className="animator-export">
          <span className="animator-label">output</span>
          <button
            type="button"
            disabled={visibleLayers.length === 0 || exportStatus === "encoding"}
            onClick={() => void previewAnimation()}
          >
            {exportStatus === "encoding" ? "encoding preview…" : "preview mp4"}
          </button>
          {exportStatus === "unsupported" ? (
            <p className="animator-error">animation export isn’t supported here.</p>
          ) : null}
          {exportStatus === "error" ? (
            <p className="animator-error">couldn’t build this preview.</p>
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
          {previewUrl ? (
            <div
              className="animation-export-preview"
              role="region"
              aria-label="Encoded MP4 preview"
            >
              <video
                src={previewUrl}
                autoPlay
                loop
                muted
                controls
                playsInline
                aria-label={`${mode} MP4 export preview`}
              />
              <div className="animation-export-actions">
                <button type="button" onClick={downloadPreview}>
                  download mp4
                </button>
                <button type="button" onClick={discardExportPreview}>
                  close
                </button>
              </div>
            </div>
          ) : null}
          {status === "ready" && layers.length === 0 ? (
            <p className="animator-empty">nothing kept yet.</p>
          ) : null}
        </div>
      </section>

      <aside className="animator-layers" aria-label="Drawing layers">
        <div className="animator-layers-header">
          <div>
            <span className="animator-label">layers · {visibleLayers.length}</span>
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
                  </span>
                </label>
              </li>
            );
          })}
        </ol>

      </aside>
    </main>
  );
}
