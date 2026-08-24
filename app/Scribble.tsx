"use client";

import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type KeyboardEvent,
  type PointerEvent as ReactPointerEvent,
} from "react";
import {
  CANVAS_HEIGHT as HEIGHT,
  CANVAS_WIDTH as WIDTH,
  MIN_POINT_GAP,
  clientPointToCanvas,
  distance,
  hasDetectedFive,
  isAccepted,
  type Point,
} from "./gesture";
import { redoStroke, undoStroke } from "./history";

type DrawStatus = "ready" | "drawing" | "saving" | "saved" | "error";
type RecentDrawing = {
  id: string;
  createdAt: string;
  previewUrl: string;
};

const ZOOM_LEVELS = [1, 1.25, 1.5, 2] as const;
const MAX_SUBMISSION_POINTS = 7600;
const MAX_POINTS_PER_STROKE = 880;
const recentDateFormatter = new Intl.DateTimeFormat(undefined, {
  dateStyle: "medium",
  timeStyle: "short",
});

async function loadRecentDrawings(signal?: AbortSignal) {
  try {
    const response = await fetch("/api/drawings?limit=3", { signal });
    if (!response.ok) return null;
    const result = (await response.json()) as { drawings?: RecentDrawing[] };
    return Array.isArray(result.drawings) ? result.drawings.slice(0, 3) : null;
  } catch (error) {
    if (error instanceof DOMException && error.name === "AbortError") return null;
    return null;
  }
}

function clamp(value: number, min: number, max: number) {
  return Math.min(max, Math.max(min, value));
}

function pathFromPoints(points: readonly Point[]) {
  if (points.length < 2) return "";

  let path = `M ${points[0].x.toFixed(1)} ${points[0].y.toFixed(1)}`;
  for (let index = 1; index < points.length - 1; index += 1) {
    const point = points[index];
    const next = points[index + 1];
    const midX = (point.x + next.x) / 2;
    const midY = (point.y + next.y) / 2;
    path += ` Q ${point.x.toFixed(1)} ${point.y.toFixed(1)} ${midX.toFixed(1)} ${midY.toFixed(1)}`;
  }

  const last = points[points.length - 1];
  return `${path} L ${last.x.toFixed(1)} ${last.y.toFixed(1)}`;
}

function roundedPoints(points: readonly Point[]) {
  return points.map(({ x, y }) => ({
    x: Math.round(clamp(x, 0, WIDTH) * 10) / 10,
    y: Math.round(clamp(y, 0, HEIGHT) * 10) / 10,
  }));
}

function samplePoints(points: readonly Point[], limit: number) {
  if (points.length <= limit) return roundedPoints(points);

  const sampled: Point[] = [];
  for (let index = 0; index < limit; index += 1) {
    const sourceIndex = Math.round(
      (index * (points.length - 1)) / (limit - 1),
    );
    sampled.push(points[sourceIndex]);
  }
  return roundedPoints(sampled);
}

function prepareStrokesForSubmission(strokes: readonly Point[][]) {
  let remainingPoints = MAX_SUBMISSION_POINTS;

  return strokes.map((stroke, index) => {
    const remainingStrokes = strokes.length - index;
    const fairShare = Math.max(
      2,
      Math.floor(remainingPoints / remainingStrokes),
    );
    const sampled = samplePoints(
      stroke,
      Math.min(MAX_POINTS_PER_STROKE, fairShare),
    );
    remainingPoints -= sampled.length;
    return sampled;
  });
}

export default function Scribble() {
  const [strokes, setStrokes] = useState<Point[][]>([]);
  const [activeStroke, setActiveStroke] = useState<Point[]>([]);
  const [redoStrokes, setRedoStrokes] = useState<Point[][]>([]);
  const [hasFive, setHasFive] = useState(false);
  const [status, setStatus] = useState<DrawStatus>("ready");
  const [zoomIndex, setZoomIndex] = useState(0);
  const [recentDrawings, setRecentDrawings] = useState<RecentDrawing[]>([]);

  const stageRef = useRef<HTMLDivElement>(null);
  const surfaceRef = useRef<SVGSVGElement>(null);
  const activeRef = useRef<Point[]>([]);
  const activePointerRef = useRef<number | null>(null);
  const strokesRef = useRef<Point[][]>([]);
  const redoStrokesRef = useRef<Point[][]>([]);
  const hasFiveRef = useRef(false);
  const sessionRef = useRef("");
  const saveControllerRef = useRef<AbortController | null>(null);
  const recentControllerRef = useRef<AbortController | null>(null);
  const keyboardDrawingRef = useRef(false);

  const zoom = ZOOM_LEVELS[zoomIndex];

  const setCurrentStroke = useCallback((points: Point[]) => {
    activeRef.current = points;
    setActiveStroke(points);
  }, []);

  const setFiveDetected = useCallback((detected: boolean) => {
    hasFiveRef.current = detected;
    setHasFive(detected);
  }, []);

  const setRedoHistory = useCallback((nextStrokes: Point[][]) => {
    redoStrokesRef.current = nextStrokes;
    setRedoStrokes(nextStrokes);
  }, []);

  const refreshRecentDrawings = useCallback(() => {
    recentControllerRef.current?.abort();
    const controller = new AbortController();
    recentControllerRef.current = controller;

    void loadRecentDrawings(controller.signal).then((recent) => {
      if (recentControllerRef.current !== controller) return;
      recentControllerRef.current = null;
      if (recent) setRecentDrawings(recent);
    });
  }, []);

  useEffect(
    () => () => {
      saveControllerRef.current?.abort();
      recentControllerRef.current?.abort();
      recentControllerRef.current = null;
    },
    [],
  );

  useEffect(() => {
    const controller = new AbortController();
    recentControllerRef.current?.abort();
    recentControllerRef.current = controller;

    void (async () => {
      const recent = await loadRecentDrawings(controller.signal);
      if (recentControllerRef.current !== controller) return;
      recentControllerRef.current = null;
      if (recent) setRecentDrawings(recent);
    })();
    return () => {
      controller.abort();
      if (recentControllerRef.current === controller) {
        recentControllerRef.current = null;
      }
    };
  }, []);

  const save = useCallback(async (nextStrokes: Point[][]) => {
    if (!sessionRef.current) sessionRef.current = crypto.randomUUID();
    saveControllerRef.current?.abort();
    const controller = new AbortController();
    saveControllerRef.current = controller;

    try {
      const response = await fetch("/api/drawings", {
        method: "POST",
        headers: { "content-type": "application/json" },
        signal: controller.signal,
        body: JSON.stringify({
          id: sessionRef.current,
          width: WIDTH,
          height: HEIGHT,
          strokes: prepareStrokesForSubmission(nextStrokes),
        }),
      });

      if (!response.ok) throw new Error("save failed");
      if (saveControllerRef.current !== controller) return;
      setStatus("saved");
      refreshRecentDrawings();
    } catch {
      if (controller.signal.aborted || saveControllerRef.current !== controller) {
        return;
      }
      setStatus("error");
    } finally {
      if (saveControllerRef.current === controller) {
        saveControllerRef.current = null;
      }
    }
  }, [refreshRecentDrawings]);

  const detectFive = useCallback(
    (points: readonly Point[]) => {
      if (!hasFiveRef.current && hasDetectedFive(points)) {
        setFiveDetected(true);
      }
    },
    [setFiveDetected],
  );

  const finishStroke = useCallback(
    (points: readonly Point[]) => {
      const cleaned = roundedPoints(points);
      if (isAccepted(cleaned)) {
        detectFive(cleaned);
        const nextStrokes = [...strokesRef.current, cleaned];
        strokesRef.current = nextStrokes;
        setStrokes(nextStrokes);
        setRedoHistory([]);
      }

      setCurrentStroke([]);
      keyboardDrawingRef.current = false;
      setStatus("ready");
    },
    [detectFive, setCurrentStroke, setRedoHistory],
  );

  const pointFromClient = useCallback(
    (clientX: number, clientY: number) => {
      const stage = stageRef.current;
      if (!stage) return null;
      return clientPointToCanvas(
        clientX,
        clientY,
        stage.getBoundingClientRect(),
        zoom,
      );
    },
    [zoom],
  );

  const appendPoint = useCallback(
    (point: Point) => {
      const current = activeRef.current;
      const last = current.at(-1);
      if (last && distance(last, point) < MIN_POINT_GAP) return;

      const retainedPoints =
        current.length >= MAX_POINTS_PER_STROKE
          ? current.filter(
              (_, index) => index % 2 === 0 || index === current.length - 1,
            )
          : current;
      const nextPoints = [...retainedPoints, point];
      setCurrentStroke(nextPoints);
      detectFive(nextPoints);
    },
    [detectFive, setCurrentStroke],
  );

  const canDraw = status !== "saving" && status !== "saved";

  const handlePointerDown = (event: ReactPointerEvent<SVGSVGElement>) => {
    if (!canDraw || activePointerRef.current !== null) return;
    if (event.pointerType === "mouse" && event.button !== 0) return;
    const point = pointFromClient(event.clientX, event.clientY);
    if (!point) return;

    event.preventDefault();
    activePointerRef.current = event.pointerId;
    event.currentTarget.setPointerCapture(event.pointerId);
    setCurrentStroke([point]);
    setStatus("drawing");
  };

  const handlePointerMove = (event: ReactPointerEvent<SVGSVGElement>) => {
    if (event.pointerId !== activePointerRef.current) return;
    event.preventDefault();

    const nativeEvents =
      event.nativeEvent.getCoalescedEvents?.() ?? [event.nativeEvent];
    for (const nativeEvent of nativeEvents) {
      const point = pointFromClient(nativeEvent.clientX, nativeEvent.clientY);
      if (point) appendPoint(point);
    }
  };

  const endPointer = (event: ReactPointerEvent<SVGSVGElement>) => {
    if (event.pointerId !== activePointerRef.current) return;
    event.preventDefault();

    const point = pointFromClient(event.clientX, event.clientY);
    const last = activeRef.current.at(-1);
    const points =
      point && (!last || distance(last, point) >= MIN_POINT_GAP)
        ? [...activeRef.current, point]
        : activeRef.current;

    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
    activePointerRef.current = null;
    finishStroke(points);
  };

  const cancelActiveStroke = useCallback(() => {
    activePointerRef.current = null;
    setCurrentStroke([]);
    keyboardDrawingRef.current = false;
    setFiveDetected(strokesRef.current.some(hasDetectedFive));
    setStatus("ready");
  }, [setCurrentStroke, setFiveDetected]);

  const cancelPointer = (event: ReactPointerEvent<SVGSVGElement>) => {
    if (event.pointerId !== activePointerRef.current) return;
    cancelActiveStroke();
  };

  const handleKeyDown = (event: KeyboardEvent<SVGSVGElement>) => {
    if (event.key === "Escape" && keyboardDrawingRef.current) {
      event.preventDefault();
      cancelActiveStroke();
      return;
    }

    if (event.key === "Enter") {
      event.preventDefault();
      if (keyboardDrawingRef.current) {
        finishStroke(activeRef.current);
      } else if (canDraw) {
        const previous = strokesRef.current.at(-1)?.at(-1);
        const start = previous ?? { x: WIDTH * 0.76, y: HEIGHT * 0.22 };
        keyboardDrawingRef.current = true;
        setCurrentStroke([start]);
        setStatus("drawing");
      }
      return;
    }

    if (!keyboardDrawingRef.current) return;
    const direction: Record<string, Point> = {
      ArrowLeft: { x: -1, y: 0 },
      ArrowRight: { x: 1, y: 0 },
      ArrowUp: { x: 0, y: -1 },
      ArrowDown: { x: 0, y: 1 },
    };
    const move = direction[event.key];
    if (!move) return;

    event.preventDefault();
    const current = activeRef.current.at(-1);
    if (!current) return;
    const amount = event.shiftKey ? 24 : 10;
    appendPoint({
      x: clamp(current.x + move.x * amount, 0, WIDTH),
      y: clamp(current.y + move.y * amount, 0, HEIGHT),
    });
  };

  const clearAll = () => {
    saveControllerRef.current?.abort();
    saveControllerRef.current = null;

    const pointerId = activePointerRef.current;
    if (
      pointerId !== null &&
      surfaceRef.current?.hasPointerCapture(pointerId)
    ) {
      surfaceRef.current.releasePointerCapture(pointerId);
    }

    activePointerRef.current = null;
    strokesRef.current = [];
    sessionRef.current = "";
    keyboardDrawingRef.current = false;
    setFiveDetected(false);
    setStrokes([]);
    setRedoHistory([]);
    setCurrentStroke([]);
    setStatus("ready");
  };

  const historyAvailable =
    (status === "ready" || status === "error") && activeStroke.length === 0;

  const undo = () => {
    if (!historyAvailable || activeRef.current.length !== 0) return;
    const next = undoStroke(strokesRef.current, redoStrokesRef.current);
    if (!next) return;

    strokesRef.current = next.strokes;
    setStrokes(next.strokes);
    setRedoHistory(next.redoStrokes);
    setFiveDetected(next.strokes.some(hasDetectedFive));
    setStatus("ready");
  };

  const redo = () => {
    if (!historyAvailable || activeRef.current.length !== 0) return;
    const next = redoStroke(strokesRef.current, redoStrokesRef.current);
    if (!next) return;

    strokesRef.current = next.strokes;
    setStrokes(next.strokes);
    setRedoHistory(next.redoStrokes);
    setFiveDetected(next.strokes.some(hasDetectedFive));
    setStatus("ready");
  };

  const submit = () => {
    if (!hasFiveRef.current || status === "saving" || status === "saved") return;

    let nextStrokes = strokesRef.current;
    if (isAccepted(activeRef.current)) {
      const cleaned = roundedPoints(activeRef.current);
      nextStrokes = [...nextStrokes, cleaned];
      strokesRef.current = nextStrokes;
      setStrokes(nextStrokes);
      setRedoHistory([]);
    }
    setCurrentStroke([]);
    keyboardDrawingRef.current = false;
    if (nextStrokes.length === 0) return;

    const pointerId = activePointerRef.current;
    if (
      pointerId !== null &&
      surfaceRef.current?.hasPointerCapture(pointerId)
    ) {
      surfaceRef.current.releasePointerCapture(pointerId);
    }
    activePointerRef.current = null;
    setStatus("saving");
    void save(nextStrokes);
  };

  const submitLabel =
    status === "saving"
      ? "Submitting…"
      : status === "saved"
        ? "Submitted"
        : status === "error"
          ? "Try again"
          : "Submit";
  const submitDisabled = !hasFive || status === "saving" || status === "saved";
  const statusMessage =
    status === "saving"
      ? "Submitting your sheet."
      : status === "saved"
        ? "Sheet submitted."
        : status === "error"
          ? "Submission failed. Try again."
          : hasFive
            ? "Five detected. Submit available."
            : "";
  const viewWidth = WIDTH / zoom;
  const viewHeight = HEIGHT / zoom;
  const canvasViewBox = `${(WIDTH - viewWidth) / 2} ${(HEIGHT - viewHeight) / 2} ${viewWidth} ${viewHeight}`;

  return (
    <main className="page-shell">
      <div ref={stageRef} className="canvas-stage">
        <svg
          ref={surfaceRef}
          className="drawing-surface"
          viewBox={canvasViewBox}
          preserveAspectRatio="none"
          role="application"
          aria-label="A4 drawing surface. Draw a five. Press Enter to begin or finish and use arrow keys to draw."
          aria-describedby="drawing-instruction"
          tabIndex={0}
          onPointerDown={handlePointerDown}
          onPointerMove={handlePointerMove}
          onPointerUp={endPointer}
          onPointerCancel={cancelPointer}
          onKeyDown={handleKeyDown}
          onContextMenu={(event) => event.preventDefault()}
        >
          <defs>
            <pattern
              id="drawing-dot-grid"
              width="16"
              height="16"
              patternUnits="userSpaceOnUse"
            >
              <circle
                className="dot-grid"
                cx="1"
                cy="1"
                r="0.8"
                fill="currentColor"
              />
            </pattern>
          </defs>
          <rect
            width={WIDTH}
            height={HEIGHT}
            fill="url(#drawing-dot-grid)"
            pointerEvents="none"
          />
          {strokes.map((points, index) => (
            <path
              className="mark"
              d={pathFromPoints(points)}
              key={`${index}-${points.length}`}
            />
          ))}
          {activeStroke.length > 1 ? (
            <path className="mark" d={pathFromPoints(activeStroke)} />
          ) : null}
        </svg>
      </div>

      <div className="instruction">
        <p id="drawing-instruction" className="instruction__text">
          Draw a 5.
        </p>
      </div>

      <p className="drawing-status" role="status" aria-live="polite" aria-atomic="true">
        {statusMessage}
      </p>

      <div className="drawing-controls" role="group" aria-label="Drawing actions">
        <button
          className="drawing-control"
          type="button"
          disabled={!historyAvailable || strokes.length === 0}
          onClick={undo}
        >
          Undo
        </button>
        <button
          className="drawing-control"
          type="button"
          disabled={!historyAvailable || redoStrokes.length === 0}
          onClick={redo}
        >
          Redo
        </button>
        <button className="drawing-control" type="button" onClick={clearAll}>
          Clear all
        </button>
        <button
          className="drawing-control drawing-control--submit"
          type="button"
          disabled={submitDisabled}
          onClick={submit}
        >
          {submitLabel}
        </button>
      </div>

      <div className="zoom-controls" role="group" aria-label="Canvas zoom">
        <button
          className="zoom-control"
          type="button"
          aria-label="Zoom out"
          disabled={zoomIndex === 0}
          onClick={() => setZoomIndex((current) => Math.max(0, current - 1))}
        >
          −
        </button>
        <span className="zoom-level" aria-live="polite">
          {Math.round(zoom * 100)}%
        </span>
        <button
          className="zoom-control"
          type="button"
          aria-label="Zoom in"
          disabled={zoomIndex === ZOOM_LEVELS.length - 1}
          onClick={() =>
            setZoomIndex((current) =>
              Math.min(ZOOM_LEVELS.length - 1, current + 1),
            )
          }
        >
          +
        </button>
      </div>

      {recentDrawings.length > 0 ? (
        <aside className="recent-submissions" aria-label="Recent submissions">
          {recentDrawings.map((drawing) => {
            const label = recentDateFormatter.format(new Date(drawing.createdAt));
            return (
              <a
                className="recent-submission"
                href="/5"
                key={drawing.id}
                aria-label={`Open saved drawings; recent submission saved ${label}`}
              >
                {/* Dynamic Worker SVGs are already canonical and should not pass through image optimization. */}
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img
                  src={drawing.previewUrl}
                  alt=""
                  draggable="false"
                />
              </a>
            );
          })}
        </aside>
      ) : null}
    </main>
  );
}
