"use client";

import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type KeyboardEvent,
  type PointerEvent as ReactPointerEvent,
} from "react";

type Point = { x: number; y: number };
type DrawStatus =
  | "ready"
  | "drawing"
  | "transitioning"
  | "saving"
  | "saved"
  | "error";

const WIDTH = 1000;
const HEIGHT = 700;
const LAST_PROMPT = 4;
const MIN_POINT_GAP = 2.5;
const MIN_STROKE_TRAVEL = 8;

const prompts = [
  "Begin high and to the right. Travel left.",
  "From the end, fall straight down.",
  "Turn and move right, gently.",
  "Round the outside and sink lower.",
  "Sweep back toward the middle, then let go.",
] as const;

function clamp(value: number, min: number, max: number) {
  return Math.min(max, Math.max(min, value));
}

function distance(a: Point, b: Point) {
  return Math.hypot(b.x - a.x, b.y - a.y);
}

function lengthOf(points: Point[]) {
  let length = 0;
  for (let index = 1; index < points.length; index += 1) {
    length += distance(points[index - 1], points[index]);
  }
  return length;
}

function pathFromPoints(points: Point[]) {
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

function isAccepted(points: Point[]) {
  return points.length >= 2 && lengthOf(points) >= MIN_STROKE_TRAVEL;
}

function roundedPoints(points: Point[]) {
  return points.map(({ x, y }) => ({
    x: Math.round(clamp(x, 0, WIDTH) * 10) / 10,
    y: Math.round(clamp(y, 0, HEIGHT) * 10) / 10,
  }));
}

export default function Scribble() {
  const [promptIndex, setPromptIndex] = useState(0);
  const [strokes, setStrokes] = useState<Point[][]>([]);
  const [activeStroke, setActiveStroke] = useState<Point[]>([]);
  const [status, setStatus] = useState<DrawStatus>("ready");

  const surfaceRef = useRef<SVGSVGElement>(null);
  const activeRef = useRef<Point[]>([]);
  const activePointerRef = useRef<number | null>(null);
  const sessionRef = useRef("");
  const transitionTimerRef = useRef<number | null>(null);
  const unsavedRef = useRef<Point[][] | null>(null);
  const keyboardDrawingRef = useRef(false);

  const setCurrentStroke = useCallback((points: Point[]) => {
    activeRef.current = points;
    setActiveStroke(points);
  }, []);

  const clearTimers = useCallback(() => {
    if (transitionTimerRef.current !== null) {
      window.clearTimeout(transitionTimerRef.current);
      transitionTimerRef.current = null;
    }
  }, []);

  useEffect(() => clearTimers, [clearTimers]);

  const save = useCallback(async (nextStrokes: Point[][]) => {
    unsavedRef.current = nextStrokes;
    if (!sessionRef.current) sessionRef.current = crypto.randomUUID();

    try {
      const response = await fetch("/api/drawings", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          id: sessionRef.current,
          width: WIDTH,
          height: HEIGHT,
          strokes: nextStrokes.map(roundedPoints),
        }),
      });

      if (!response.ok) throw new Error("save failed");
      unsavedRef.current = null;
      setStatus("saved");
    } catch {
      setStatus("error");
    }
  }, []);

  const finishStroke = useCallback(
    (points: Point[]) => {
      const cleaned = roundedPoints(points);
      setCurrentStroke([]);
      keyboardDrawingRef.current = false;

      if (!isAccepted(cleaned)) {
        setStatus("ready");
        return;
      }

      const nextStrokes = [...strokes, cleaned];
      setStrokes(nextStrokes);
      setStatus("transitioning");

      if (promptIndex === LAST_PROMPT) {
        setPromptIndex(prompts.length);
        setStatus("saving");
        void save(nextStrokes);
        return;
      }

      transitionTimerRef.current = window.setTimeout(() => {
        setPromptIndex((current) => current + 1);
        setStatus("ready");
        transitionTimerRef.current = null;
      }, 180);
    },
    [promptIndex, save, setCurrentStroke, strokes],
  );

  const pointFromClient = useCallback((clientX: number, clientY: number) => {
    const surface = surfaceRef.current;
    if (!surface) return null;
    const bounds = surface.getBoundingClientRect();
    if (bounds.width === 0 || bounds.height === 0) return null;
    return {
      x: clamp(((clientX - bounds.left) / bounds.width) * WIDTH, 0, WIDTH),
      y: clamp(((clientY - bounds.top) / bounds.height) * HEIGHT, 0, HEIGHT),
    };
  }, []);

  const appendPoint = useCallback(
    (point: Point) => {
      const current = activeRef.current;
      const last = current.at(-1);
      if (last && distance(last, point) < MIN_POINT_GAP) return;
      if (current.length >= 900) return;
      setCurrentStroke([...current, point]);
    },
    [setCurrentStroke],
  );

  const canBegin = status === "ready";

  const handlePointerDown = (event: ReactPointerEvent<SVGSVGElement>) => {
    if (!canBegin || activePointerRef.current !== null) return;
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

    const nativeEvents = event.nativeEvent.getCoalescedEvents?.() ?? [event.nativeEvent];
    for (const nativeEvent of nativeEvents) {
      const point = pointFromClient(nativeEvent.clientX, nativeEvent.clientY);
      if (point) appendPoint(point);
    }
  };

  const endPointer = (event: ReactPointerEvent<SVGSVGElement>) => {
    if (event.pointerId !== activePointerRef.current) return;
    event.preventDefault();

    const point = pointFromClient(event.clientX, event.clientY);
    const points = point ? [...activeRef.current, point] : activeRef.current;

    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
    activePointerRef.current = null;
    finishStroke(points);
  };

  const cancelPointer = (event: ReactPointerEvent<SVGSVGElement>) => {
    if (event.pointerId !== activePointerRef.current) return;
    activePointerRef.current = null;
    setCurrentStroke([]);
    setStatus("ready");
  };

  const handleKeyDown = (event: KeyboardEvent<SVGSVGElement>) => {
    if (event.key === "Escape" && keyboardDrawingRef.current) {
      event.preventDefault();
      keyboardDrawingRef.current = false;
      setCurrentStroke([]);
      setStatus("ready");
      return;
    }

    if (event.key === "Enter") {
      event.preventDefault();
      if (keyboardDrawingRef.current) {
        finishStroke(activeRef.current);
      } else if (canBegin) {
        const previous = strokes.at(-1)?.at(-1);
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

  const reset = () => {
    clearTimers();
    activePointerRef.current = null;
    sessionRef.current = "";
    unsavedRef.current = null;
    keyboardDrawingRef.current = false;
    setPromptIndex(0);
    setStrokes([]);
    setCurrentStroke([]);
    setStatus("ready");
  };

  const retry = () => {
    if (!unsavedRef.current) return;
    setStatus("saving");
    void save(unsavedRef.current);
  };

  const message =
    promptIndex < prompts.length
      ? prompts[promptIndex]
      : status === "saving"
        ? "keeping…"
        : status === "error"
          ? "couldn’t keep it."
          : "kept.";

  return (
    <main className="page-shell">
      <div className="instruction" aria-live="polite" aria-atomic="true">
        <p key={`${promptIndex}-${status}`} className="instruction__text">
          {message}
        </p>
        {status === "error" ? (
          <button className="text-control" type="button" onClick={retry}>
            retry
          </button>
        ) : null}
        {status === "saved" ? (
          <button className="text-control" type="button" onClick={reset}>
            again
          </button>
        ) : null}
      </div>

      {status !== "saved" ? (
        <button className="clear-control" type="button" onClick={reset}>
          clear
        </button>
      ) : null}

      <svg
        ref={surfaceRef}
        className="drawing-surface"
        viewBox={`0 0 ${WIDTH} ${HEIGHT}`}
        preserveAspectRatio="none"
        role="application"
        aria-label="Drawing surface. Press Enter to begin or finish. Use arrow keys to move."
        tabIndex={0}
        onPointerDown={handlePointerDown}
        onPointerMove={handlePointerMove}
        onPointerUp={endPointer}
        onPointerCancel={cancelPointer}
        onKeyDown={handleKeyDown}
        onContextMenu={(event) => event.preventDefault()}
      >
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
    </main>
  );
}
