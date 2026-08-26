"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { containImageRect } from "./fit";
import { buildGridTimeline, type GridTimelineFrame } from "./grid";
import {
  buildMaskRects,
  GRID_COLUMNS,
  GRID_ROWS,
  MASK_REGION_COUNT,
  SLICE_COUNT,
  type MaskKind,
  type SliceDirection,
} from "./masks";
import {
  DEFAULT_STROKE_COLOR,
  DEFAULT_STROKE_WIDTH,
  MAX_STROKE_WIDTH,
  MIN_STROKE_WIDTH,
  normalizeStrokeColor,
  normalizeStrokeWidth,
  styleSvgStroke,
} from "./style";

type AnimationMode =
  | "blink"
  | "solo"
  | "grid"
  | "grid-v2"
  | "slice"
  | "slice-v2";

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
  sourceSvg: string;
  styleKey: string;
  image: HTMLImageElement;
  greyImage: HTMLImageElement;
  objectUrls: [string, string];
};

type AnimationLayer = {
  id: string;
  image: HTMLImageElement;
  greyImage?: HTMLImageElement;
};

type UploadedLayer = AnimationLayer & {
  name: string;
  objectUrl: string;
};

const WIDTH = 595;
const HEIGHT = 842;
const EXPORT_WIDTH = WIDTH * 2;
const EXPORT_HEIGHT = HEIGHT * 2;
const ENCODE_WIDTH = EXPORT_WIDTH + (EXPORT_WIDTH % 2);
const ENCODE_HEIGHT = EXPORT_HEIGHT + (EXPORT_HEIGHT % 2);
const DEFAULT_SPEED_MS = 300;
const MIN_SPEED_MS = 50;
const MAX_SPEED_MS = 5000;
const SYNC_INTERVAL_MS = 10_000;
const BACKGROUND = "#FFFFFF";
const GREY = "#CCCCCC";
const DIVIDER_COLOR = "#171713";

const EFFECTS: { mode: AnimationMode; label: string }[] = [
  { mode: "blink", label: "blink" },
  { mode: "solo", label: "solo" },
  { mode: "grid", label: "grid v1" },
  { mode: "grid-v2", label: "grid v2" },
  { mode: "slice", label: "slice v1" },
  { mode: "slice-v2", label: "slice v2" },
];

function isMaskMode(mode: AnimationMode) {
  return (
    mode === "grid" ||
    mode === "grid-v2" ||
    mode === "slice" ||
    mode === "slice-v2"
  );
}

function isSliceMode(mode: AnimationMode) {
  return mode === "slice" || mode === "slice-v2";
}

function usesUploadedLayers(mode: AnimationMode) {
  return mode === "grid-v2" || mode === "slice-v2";
}

function maskKindForMode(mode: AnimationMode): MaskKind {
  return isSliceMode(mode) ? "slice" : "grid";
}

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

function getStyleKey(color: string, width: number) {
  return `${normalizeStrokeColor(color)}:${normalizeStrokeWidth(width).toFixed(2)}`;
}

async function createStyledLayer(
  drawing: Drawing,
  sourceSvg: string,
  color: string,
  width: number,
  signal: AbortSignal,
) {
  const svg = styleSvgStroke(sourceSvg, color, width);
  const greySvg = styleSvgStroke(sourceSvg, GREY, width);
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
      sourceSvg,
      styleKey: getStyleKey(color, width),
      image,
      greyImage,
      objectUrls: [imageUrl, greyImageUrl] as [string, string],
    } satisfies Layer;
  } catch (error) {
    URL.revokeObjectURL(imageUrl);
    URL.revokeObjectURL(greyImageUrl);
    throw error;
  }
}

async function loadLayer(
  drawing: Drawing,
  signal: AbortSignal,
  color: string,
  width: number,
) {
  const response = await fetch(versionedPreview(drawing), {
    cache: "no-store",
    signal,
  });
  if (!response.ok) throw new Error("image failed");

  const sourceSvg = await response.text();
  return createStyledLayer(drawing, sourceSvg, color, width, signal);
}

function releaseLayer(layer: Layer) {
  for (const url of layer.objectUrls) URL.revokeObjectURL(url);
}

async function loadUploadedLayer(file: File, signal: AbortSignal) {
  const objectUrl = URL.createObjectURL(file);
  try {
    const image = await loadImage(objectUrl, signal);
    return {
      id: `upload-${crypto.randomUUID()}`,
      image,
      name: file.name,
      objectUrl,
    } satisfies UploadedLayer;
  } catch (error) {
    URL.revokeObjectURL(objectUrl);
    throw error;
  }
}

function releaseUploadedLayer(layer: UploadedLayer) {
  URL.revokeObjectURL(layer.objectUrl);
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
  layers: AnimationLayer[],
  mode: AnimationMode,
  frame: number,
  maskTimeline: GridTimelineFrame[],
  dividerOpacity: number,
  sliceDirection: SliceDirection,
  renderWidth = WIDTH,
  renderHeight = HEIGHT,
) {
  context.save();
  context.globalAlpha = 1;
  context.fillStyle = BACKGROUND;
  context.fillRect(0, 0, renderWidth, renderHeight);

  if (layers.length === 0) {
    context.restore();
    return;
  }

  const activeIndex = frame % layers.length;
  const drawLayer = (layer: AnimationLayer, grey = false) => {
    const image = grey && layer.greyImage ? layer.greyImage : layer.image;
    const rect = containImageRect(
      image.naturalWidth,
      image.naturalHeight,
      renderWidth,
      renderHeight,
    );
    context.drawImage(
      image,
      rect.x,
      rect.y,
      rect.width,
      rect.height,
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
    const maskRects = buildMaskRects(
      maskKindForMode(mode),
      renderWidth,
      renderHeight,
      sliceDirection,
    );
    const maskFrame =
      maskTimeline.length > 0
        ? maskTimeline[frame % maskTimeline.length].layerIndexes
        : null;
    for (let region = 0; region < maskRects.length; region += 1) {
      const rect = maskRects[region];
      const layer = layers[maskFrame?.[region] ?? region % layers.length];

      context.save();
      context.beginPath();
      context.rect(rect.x, rect.y, rect.width, rect.height);
      context.clip();
      drawLayer(layer);
      context.restore();
    }

    context.save();
    context.globalAlpha = dividerOpacity;
    context.strokeStyle = DIVIDER_COLOR;
    context.lineWidth = renderWidth / WIDTH;
    context.beginPath();
    if (isSliceMode(mode)) {
      if (sliceDirection === "vertical") {
        const sliceWidth = renderWidth / SLICE_COUNT;
        for (let slice = 1; slice < SLICE_COUNT; slice += 1) {
          const x = slice * sliceWidth;
          context.moveTo(x, 0);
          context.lineTo(x, renderHeight);
        }
      } else {
        const sliceHeight = renderHeight / SLICE_COUNT;
        for (let slice = 1; slice < SLICE_COUNT; slice += 1) {
          const y = slice * sliceHeight;
          context.moveTo(0, y);
          context.lineTo(renderWidth, y);
        }
      }
    } else {
      const cellWidth = renderWidth / GRID_COLUMNS;
      const cellHeight = renderHeight / GRID_ROWS;
      for (let column = 1; column < GRID_COLUMNS; column += 1) {
        const x = column * cellWidth;
        context.moveTo(x, 0);
        context.lineTo(x, renderHeight);
      }
      for (let row = 1; row < GRID_ROWS; row += 1) {
        const y = row * cellHeight;
        context.moveTo(0, y);
        context.lineTo(renderWidth, y);
      }
    }
    context.stroke();
    context.restore();
  }

  context.restore();
}

export default function Animator() {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const layerCacheRef = useRef<Map<string, Layer>>(new Map());
  const uploadedLayersRef = useRef<UploadedLayer[]>([]);
  const syncControllerRef = useRef<AbortController | null>(null);
  const uploadControllerRef = useRef<AbortController | null>(null);
  const styleControllerRef = useRef<AbortController | null>(null);
  const strokeColorRef = useRef(DEFAULT_STROKE_COLOR);
  const strokeWidthRef = useRef(DEFAULT_STROKE_WIDTH);
  const syncingRef = useRef(false);
  const previewUrlRef = useRef<string | null>(null);
  const previewGenerationRef = useRef(0);
  const [layers, setLayers] = useState<Layer[]>([]);
  const [uploadedLayers, setUploadedLayers] = useState<UploadedLayer[]>([]);
  const [hidden, setHidden] = useState<Set<string>>(new Set());
  const [mode, setMode] = useState<AnimationMode>("blink");
  const [frame, setFrame] = useState(0);
  const [speedInput, setSpeedInput] = useState(String(DEFAULT_SPEED_MS));
  const [strokeWidthInput, setStrokeWidthInput] = useState(
    DEFAULT_STROKE_WIDTH.toFixed(2),
  );
  const [strokeColor, setStrokeColor] = useState(DEFAULT_STROKE_COLOR);
  const [strokeColorInput, setStrokeColorInput] = useState(
    DEFAULT_STROKE_COLOR,
  );
  const [dividerOpacityPercent, setDividerOpacityPercent] = useState(100);
  const [sliceDirection, setSliceDirection] =
    useState<SliceDirection>("horizontal");
  const [maskSeed, setMaskSeed] = useState(() => Date.now() >>> 0);
  const [playing, setPlaying] = useState(true);
  const [status, setStatus] = useState<"loading" | "ready" | "error">(
    "loading",
  );
  const [exportStatus, setExportStatus] = useState<
    "idle" | "encoding" | "error" | "unsupported"
  >("idle");
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
  const [uploadStatus, setUploadStatus] = useState<
    "idle" | "loading" | "error"
  >("idle");

  const visibleLayers = useMemo(
    () => layers.filter((layer) => !hidden.has(layer.id)),
    [hidden, layers],
  );
  const animationLayers = usesUploadedLayers(mode)
    ? uploadedLayers
    : visibleLayers;
  const parsedSpeed = Number(speedInput);
  const speedMs = normalizeSpeed(
    speedInput.trim() !== "" && Number.isFinite(parsedSpeed)
      ? parsedSpeed
      : DEFAULT_SPEED_MS,
  );
  const parsedStrokeWidth = Number(strokeWidthInput);
  const strokeWidth = normalizeStrokeWidth(
    strokeWidthInput.trim() !== "" && Number.isFinite(parsedStrokeWidth)
      ? parsedStrokeWidth
      : DEFAULT_STROKE_WIDTH,
  );
  const maskTimeline = useMemo(
    () =>
      buildGridTimeline(
        animationLayers.map(({ id }) => id),
        MASK_REGION_COUNT,
        maskSeed,
        speedMs,
        speedMs * 2,
      ),
    [animationLayers, maskSeed, speedMs],
  );
  const dividerOpacity = dividerOpacityPercent / 100;

  useEffect(() => {
    strokeColorRef.current = strokeColor;
    strokeWidthRef.current = strokeWidth;
  }, [strokeColor, strokeWidth]);

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
        const layer = await loadLayer(
          drawing,
          controller.signal,
          strokeColorRef.current,
          strokeWidthRef.current,
        );
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
      uploadControllerRef.current?.abort();
      styleControllerRef.current?.abort();
      syncingRef.current = false;
      previewGenerationRef.current += 1;
      if (previewUrlRef.current) URL.revokeObjectURL(previewUrlRef.current);
      for (const layer of layerCacheRef.current.values()) releaseLayer(layer);
      layerCacheRef.current.clear();
      for (const layer of uploadedLayersRef.current) {
        releaseUploadedLayer(layer);
      }
      uploadedLayersRef.current = [];
    };
  }, [sync]);

  useEffect(() => {
    const targetStyleKey = getStyleKey(strokeColor, strokeWidth);
    if (layers.every((layer) => layer.styleKey === targetStyleKey)) return;

    styleControllerRef.current?.abort();
    const controller = new AbortController();
    styleControllerRef.current = controller;

    void mapWithConcurrency(layers, 8, async (layer) => {
      if (layer.styleKey === targetStyleKey) return { original: layer };
      try {
        return {
          original: layer,
          styled: await createStyledLayer(
            layer,
            layer.sourceSvg,
            strokeColor,
            strokeWidth,
            controller.signal,
          ),
        };
      } catch (error) {
        return { original: layer, error };
      }
    }).then((results) => {
      const styledResults = results.filter(
        (result): result is typeof result & { styled: Layer } =>
          "styled" in result,
      );
      if (
        controller.signal.aborted ||
        results.some((result) => "error" in result)
      ) {
        for (const result of styledResults) releaseLayer(result.styled);
        return;
      }

      const replacements = new Map(
        styledResults.map((result) => [result.original.id, result]),
      );
      discardExportPreview();
      setLayers((current) => {
        const used = new Set<string>();
        const next = current.map((layer) => {
          const replacement = replacements.get(layer.id);
          if (!replacement || replacement.original !== layer) return layer;
          used.add(layer.id);
          releaseLayer(layer);
          layerCacheRef.current.set(layer.id, replacement.styled);
          return replacement.styled;
        });
        for (const result of styledResults) {
          if (!used.has(result.original.id)) releaseLayer(result.styled);
        }
        return next;
      });
    });

    return () => controller.abort();
  }, [discardExportPreview, layers, strokeColor, strokeWidth]);

  useEffect(() => {
    if (!playing || animationLayers.length === 0) return;
    const delay =
      isMaskMode(mode)
        ? (maskTimeline[frame % maskTimeline.length]?.durationMs ?? speedMs)
        : speedMs;
    const timeout = window.setTimeout(
      () => setFrame((current) => current + 1),
      delay,
    );
    return () => window.clearTimeout(timeout);
  }, [animationLayers.length, frame, maskTimeline, mode, playing, speedMs]);

  useEffect(() => {
    const canvas = canvasRef.current;
    const context = canvas?.getContext("2d");
    if (!context) return;
    drawFrame(
      context,
      animationLayers,
      mode,
      frame,
      maskTimeline,
      dividerOpacity,
      sliceDirection,
    );
  }, [
    animationLayers,
    dividerOpacity,
    frame,
    maskTimeline,
    mode,
    sliceDirection,
  ]);

  const changeMode = (nextMode: AnimationMode) => {
    if (nextMode !== mode || isMaskMode(nextMode)) discardExportPreview();
    if (isMaskMode(nextMode)) {
      setMaskSeed((current) => (current + 0x9e3779b9) >>> 0);
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
    if (isMaskMode(mode)) {
      discardExportPreview();
      setMaskSeed((current) => (current + 0x9e3779b9) >>> 0);
    }
    setFrame(0);
  };

  const changeSpeed = (value: string) => {
    discardExportPreview();
    setSpeedInput(value);
    setFrame(0);
  };

  const changeStrokeWidth = (value: string) => {
    discardExportPreview();
    setStrokeWidthInput(value);
    setFrame(0);
  };

  const changeStrokeColor = (value: string) => {
    discardExportPreview();
    const normalized = normalizeStrokeColor(value);
    setStrokeColor(normalized);
    setStrokeColorInput(normalized);
    setFrame(0);
  };

  const changeStrokeColorInput = (value: string) => {
    discardExportPreview();
    setStrokeColorInput(value);
    if (/^#[0-9a-f]{6}$/i.test(value)) {
      setStrokeColor(normalizeStrokeColor(value));
      setFrame(0);
    }
  };

  const changeDividerOpacity = (value: number) => {
    if (!Number.isFinite(value)) return;
    discardExportPreview();
    setDividerOpacityPercent(clamp(Math.round(value), 0, 100));
  };

  const changeSliceDirection = (direction: SliceDirection) => {
    if (direction === sliceDirection) return;
    discardExportPreview();
    setSliceDirection(direction);
    setFrame(0);
  };

  const addUploadedImages = async (files: FileList | null) => {
    if (!files || files.length === 0) return;
    discardExportPreview();
    uploadControllerRef.current?.abort();
    const controller = new AbortController();
    uploadControllerRef.current = controller;
    setUploadStatus("loading");

    try {
      const imageFiles = [...files].filter((file) =>
        file.type.startsWith("image/"),
      );
      if (imageFiles.length === 0) throw new Error("no images");
      const results = await mapWithConcurrency(imageFiles, 4, async (file) => {
        try {
          return { layer: await loadUploadedLayer(file, controller.signal) };
        } catch (error) {
          return { error };
        }
      });
      const nextLayers = results.flatMap((result) =>
        result.layer ? [result.layer] : [],
      );
      if (results.some((result) => result.error)) {
        for (const layer of nextLayers) releaseUploadedLayer(layer);
        throw new Error("image failed");
      }
      if (controller.signal.aborted) {
        for (const layer of nextLayers) releaseUploadedLayer(layer);
        return;
      }
      setUploadedLayers((current) => {
        const next = [...current, ...nextLayers];
        uploadedLayersRef.current = next;
        return next;
      });
      setUploadStatus("idle");
      setFrame(0);
      setPlaying(true);
    } catch (error) {
      if (!(error instanceof DOMException && error.name === "AbortError")) {
        setUploadStatus("error");
      }
    } finally {
      if (uploadControllerRef.current === controller) {
        uploadControllerRef.current = null;
      }
    }
  };

  const removeUploadedLayer = (id: string) => {
    discardExportPreview();
    setUploadedLayers((current) => {
      const removed = current.find((layer) => layer.id === id);
      if (removed) releaseUploadedLayer(removed);
      const next = current.filter((layer) => layer.id !== id);
      uploadedLayersRef.current = next;
      return next;
    });
    setFrame(0);
  };

  const clearUploadedLayers = () => {
    discardExportPreview();
    for (const layer of uploadedLayersRef.current) {
      releaseUploadedLayer(layer);
    }
    uploadedLayersRef.current = [];
    setUploadedLayers([]);
    setFrame(0);
    setPlaying(false);
  };

  const previewAnimation = async () => {
    if (animationLayers.length === 0 || exportStatus === "encoding") return;
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
    exportCanvas.width = EXPORT_WIDTH;
    exportCanvas.height = EXPORT_HEIGHT;
    const context = exportCanvas.getContext("2d");
    if (!context) {
      setExportStatus("error");
      return;
    }
    const encoderCanvas = document.createElement("canvas");
    encoderCanvas.width = ENCODE_WIDTH;
    encoderCanvas.height = ENCODE_HEIGHT;
    const encoderContext = encoderCanvas.getContext("2d");
    if (!encoderContext) {
      setExportStatus("error");
      return;
    }

    try {
      const {
        BufferTarget,
        Mp4OutputFormat,
        Output,
        Quality,
        VideoSample,
        VideoSampleSource,
      } = await import("mediabunny");
      const target = new BufferTarget();
      const output = new Output({
        format: new Mp4OutputFormat({ fastStart: "in-memory" }),
        target,
      });
      const source = new VideoSampleSource({
        codec: "avc",
        quality: new Quality({ bitrate: 16_000_000 }),
        keyFrameInterval: 2,
      });
      output.addVideoTrack(source);
      await output.start();

      const exportFrameCount =
        isMaskMode(mode) ? maskTimeline.length : animationLayers.length;
      let exportTimestamp = 0;

      for (let exportFrame = 0; exportFrame < exportFrameCount; exportFrame += 1) {
        const exportFrameSeconds =
          isMaskMode(mode)
            ? maskTimeline[exportFrame].durationMs / 1000
            : speedMs / 1000;
        drawFrame(
          context,
          animationLayers,
          mode,
          exportFrame,
          maskTimeline,
          dividerOpacity,
          sliceDirection,
          EXPORT_WIDTH,
          EXPORT_HEIGHT,
        );
        encoderContext.drawImage(
          exportCanvas,
          0,
          0,
          EXPORT_WIDTH,
          EXPORT_HEIGHT,
          0,
          0,
          ENCODE_WIDTH,
          ENCODE_HEIGHT,
        );
        const videoFrame = new VideoFrame(encoderCanvas, {
          timestamp: Math.round(exportTimestamp * 1_000_000),
          duration: Math.round(exportFrameSeconds * 1_000_000),
          displayWidth: EXPORT_WIDTH,
          displayHeight: EXPORT_HEIGHT,
        });
        const sample = new VideoSample(videoFrame);
        try {
          await source.add(sample, { keyFrame: exportFrame === 0 });
        } finally {
          sample.close();
        }
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
    anchor.download = `5A-${mode}-${EXPORT_WIDTH}x${EXPORT_HEIGHT}.mp4`;
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
          {EFFECTS.map((effect) => (
            <button
              className={`animator-mode${mode === effect.mode ? " animator-mode--active" : ""}`}
              type="button"
              aria-pressed={mode === effect.mode}
              onClick={() => changeMode(effect.mode)}
              key={effect.mode}
            >
              <strong>{effect.label}</strong>
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
          {!usesUploadedLayers(mode) ? (
            <>
              <label className="animator-input-row">
                <span className="animator-label">stroke width</span>
                <span className="animator-input-value">
                  <input
                    type="number"
                    min={MIN_STROKE_WIDTH.toFixed(2)}
                    max={MAX_STROKE_WIDTH.toFixed(2)}
                    step="0.01"
                    value={strokeWidthInput}
                    onChange={(event) =>
                      changeStrokeWidth(event.currentTarget.value)
                    }
                    onBlur={() =>
                      setStrokeWidthInput(strokeWidth.toFixed(2))
                    }
                    aria-label="Stroke width in pixels"
                  />
                  <span>px</span>
                </span>
              </label>
              <label className="animator-input-row">
                <span className="animator-label">stroke colour</span>
                <span className="animator-color-value">
                  <input
                    type="color"
                    value={strokeColor}
                    onChange={(event) =>
                      changeStrokeColor(event.currentTarget.value)
                    }
                    aria-label="Stroke colour picker"
                  />
                  <input
                    type="text"
                    value={strokeColorInput}
                    maxLength={7}
                    spellCheck="false"
                    onChange={(event) =>
                      changeStrokeColorInput(event.currentTarget.value)
                    }
                    onBlur={() => setStrokeColorInput(strokeColor)}
                    aria-label="Stroke colour hex value"
                  />
                </span>
              </label>
            </>
          ) : null}
          {isMaskMode(mode) ? (
            <label className="animator-input-row">
              <span className="animator-label">
                {isSliceMode(mode) ? "slice opacity" : "grid opacity"}
              </span>
              <span className="animator-input-value">
                <input
                  type="number"
                  min="0"
                  max="100"
                  step="5"
                  value={dividerOpacityPercent}
                  onChange={(event) =>
                    changeDividerOpacity(event.currentTarget.valueAsNumber)
                  }
                  aria-label={`${isSliceMode(mode) ? "Slice" : "Grid"} opacity percentage`}
                />
                <span>%</span>
              </span>
            </label>
          ) : null}
          {isSliceMode(mode) ? (
            <div className="animator-input-row">
              <span className="animator-label">slice direction</span>
              <div
                className="animator-direction"
                role="group"
                aria-label="Slice direction"
              >
                {(["horizontal", "vertical"] as const).map((direction) => (
                  <button
                    type="button"
                    aria-pressed={sliceDirection === direction}
                    onClick={() => changeSliceDirection(direction)}
                    key={direction}
                  >
                    {direction}
                  </button>
                ))}
              </div>
            </div>
          ) : null}
          {usesUploadedLayers(mode) ? (
            <label className="animator-upload-row">
              <span className="animator-label">images</span>
              <span className="animator-upload-button">
                {uploadStatus === "loading" ? "loading…" : "choose images"}
                <input
                  type="file"
                  accept="image/*"
                  multiple
                  disabled={uploadStatus === "loading"}
                  aria-label="Upload A4 images"
                  onChange={(event) => {
                    const input = event.currentTarget;
                    void addUploadedImages(input.files).finally(() => {
                      input.value = "";
                    });
                  }}
                />
              </span>
              {uploadStatus === "error" ? (
                <span className="animator-upload-error">couldn’t load image.</span>
              ) : null}
            </label>
          ) : null}
        </div>

        <div className="animator-transport">
          <div className="animator-transport-row">
            <button
              type="button"
              disabled={animationLayers.length === 0}
              onClick={() => setPlaying((current) => !current)}
            >
              {playing ? "pause" : "play"}
            </button>
            <button
              type="button"
              disabled={animationLayers.length === 0}
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
            disabled={animationLayers.length === 0 || exportStatus === "encoding"}
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
            aria-label={`${mode} animation preview using ${animationLayers.length} visible layers`}
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
                aria-label={`${mode} MP4 export preview at ${EXPORT_WIDTH} by ${EXPORT_HEIGHT}`}
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
          {usesUploadedLayers(mode) && uploadedLayers.length === 0 ? (
            <p className="animator-empty">choose images.</p>
          ) : status === "ready" && layers.length === 0 ? (
            <p className="animator-empty">nothing kept yet.</p>
          ) : null}
        </div>
      </section>

      <aside className="animator-layers" aria-label="Drawing layers">
        <div className="animator-layers-header">
          <div>
            <span className="animator-label">
              layers · {usesUploadedLayers(mode) ? uploadedLayers.length : visibleLayers.length}
            </span>
          </div>
          {usesUploadedLayers(mode) ? (
            <div>
              <button
                type="button"
                onClick={clearUploadedLayers}
                disabled={uploadedLayers.length === 0}
              >
                clear
              </button>
            </div>
          ) : (
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
          )}
        </div>

        {status === "error" ? (
          <button className="animator-retry" type="button" onClick={() => void sync()}>
            retry layer sync
          </button>
        ) : null}

        <ol className="animator-layer-list">
          {usesUploadedLayers(mode)
            ? uploadedLayers.map((layer, index) => (
                <li key={layer.id}>
                  <div className="animator-uploaded-layer">
                    {/* eslint-disable-next-line @next/next/no-img-element */}
                    <img src={layer.image.src} alt="" draggable="false" />
                    <span>
                      <strong>image {String(index + 1).padStart(3, "0")}</strong>
                      <small title={layer.name}>{layer.name}</small>
                    </span>
                    <button
                      type="button"
                      aria-label={`Remove ${layer.name}`}
                      onClick={() => removeUploadedLayer(layer.id)}
                    >
                      ×
                    </button>
                  </div>
                </li>
              ))
            : layers.map((layer, index) => {
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
