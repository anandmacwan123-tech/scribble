"use client";

/* eslint-disable @next/next/no-img-element */

import Link from "next/link";
import {
  type ChangeEvent,
  type CSSProperties,
  type KeyboardEvent,
  type MouseEvent,
  type PointerEvent,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import {
  MAX_ZOOM,
  MIN_ZOOM,
  type CropRect,
  cropsEqual,
  fullCrop,
  isFullCrop,
  moveCrop,
  normalizeCrop,
  setCropZoom,
  zoomForCrop,
} from "./crop";
import styles from "./crop-editor.module.css";

type CropMetadata = CropRect & {
  revision?: string | number;
  updatedAt: string;
};

type Drawing = {
  id: string;
  width: number;
  height: number;
  createdAt: string;
  updatedAt: string;
  previewUrl: string;
  downloadUrl: string;
  crop: CropMetadata | null;
};

type DrawingPage = {
  drawings: Drawing[];
  nextCursor: string | null;
};

type CropDraft = {
  crop: CropRect;
  baseRevision: number;
};

type LoadState = "loading" | "ready" | "refreshing" | "error";

type ReferenceImage = {
  name: string;
  url: string;
};

type DragState = {
  pointerId: number;
  drawingId: string;
  startX: number;
  startY: number;
  crop: CropRect;
  viewportWidth: number;
  viewportHeight: number;
};

const SYNC_INTERVAL_MS = 10_000;
const KEYBOARD_STEP = 1;
const KEYBOARD_LARGE_STEP = 10;
const ZOOM_STEP = 0.1;

function isAbortError(error: unknown) {
  return error instanceof DOMException && error.name === "AbortError";
}

function versionedSource(drawing: Drawing) {
  const separator = drawing.previewUrl.includes("?") ? "&" : "?";
  return `${drawing.previewUrl}${separator}v=${encodeURIComponent(drawing.updatedAt)}`;
}

function isCropRect(value: unknown): value is CropRect {
  if (!value || typeof value !== "object") return false;
  const crop = value as Record<string, unknown>;
  return (
    typeof crop.x === "number" &&
    typeof crop.y === "number" &&
    typeof crop.width === "number" &&
    typeof crop.height === "number"
  );
}

function cropFromResponse(value: unknown): CropMetadata | null {
  if (!value || typeof value !== "object") return null;
  const payload = value as Record<string, unknown>;
  const candidate = "crop" in payload ? payload.crop : payload;
  if (!isCropRect(candidate)) return null;
  const metadata = candidate as Record<string, unknown>;
  return {
    ...normalizeCrop(candidate),
    revision:
      typeof metadata.revision === "string" ||
      typeof metadata.revision === "number"
        ? metadata.revision
        : undefined,
    updatedAt:
      typeof metadata.updatedAt === "string"
        ? metadata.updatedAt
        : new Date().toISOString(),
  };
}

function revisionForCrop(crop: CropMetadata | null | undefined) {
  const revision = Number(crop?.revision ?? 0);
  return Number.isSafeInteger(revision) && revision > 0 ? revision : 0;
}

async function loadAllDrawings(signal: AbortSignal) {
  const drawings: Drawing[] = [];
  const visited = new Set<string>();
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
    if (cursor && visited.has(cursor)) throw new Error("repeated cursor");
    if (cursor) visited.add(cursor);
  } while (cursor);

  return drawings;
}

export default function CropEditor() {
  const [drawings, setDrawings] = useState<Drawing[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [drafts, setDrafts] = useState<Map<string, CropDraft>>(new Map());
  const [loadState, setLoadState] = useState<LoadState>("loading");
  const [savingId, setSavingId] = useState<string | null>(null);
  const [operationError, setOperationError] = useState("");
  const [dragging, setDragging] = useState(false);
  const [reference, setReference] = useState<ReferenceImage | null>(null);
  const [referenceVisible, setReferenceVisible] = useState(true);
  const [referenceOpacity, setReferenceOpacity] = useState(50);
  const syncControllerRef = useRef<AbortController | null>(null);
  const dragRef = useRef<DragState | null>(null);
  const savingRef = useRef(false);

  const sync = useCallback(async () => {
    if (savingRef.current) return;
    syncControllerRef.current?.abort();
    const controller = new AbortController();
    syncControllerRef.current = controller;
    setLoadState((current) =>
      current === "loading" ? "loading" : "refreshing",
    );

    try {
      const next = await loadAllDrawings(controller.signal);
      if (controller.signal.aborted) return;
      const nextIds = new Set(next.map(({ id }) => id));
      setDrawings(next);
      setSelectedId((current) =>
        current && nextIds.has(current) ? current : (next[0]?.id ?? null),
      );
      setDrafts((current) => {
        const retained = new Map<string, CropDraft>();
        for (const [id, draft] of current) {
          if (nextIds.has(id)) retained.set(id, draft);
        }
        return retained;
      });
      setLoadState("ready");
    } catch (error: unknown) {
      if (!isAbortError(error)) setLoadState("error");
    }
  }, []);

  useEffect(() => {
    const initialSync = window.setTimeout(() => void sync(), 0);
    const interval = window.setInterval(() => void sync(), SYNC_INTERVAL_MS);
    const onFocus = () => void sync();
    window.addEventListener("focus", onFocus);
    return () => {
      window.clearTimeout(initialSync);
      window.clearInterval(interval);
      window.removeEventListener("focus", onFocus);
      syncControllerRef.current?.abort();
    };
  }, [sync]);

  useEffect(() => {
    return () => {
      if (reference) URL.revokeObjectURL(reference.url);
    };
  }, [reference]);

  const selectedIndex = useMemo(
    () => drawings.findIndex(({ id }) => id === selectedId),
    [drawings, selectedId],
  );
  const selected = selectedIndex >= 0 ? drawings[selectedIndex] : null;
  const savedCrop = normalizeCrop(selected?.crop);
  const savedRevision = revisionForCrop(selected?.crop);
  const crop = selectedId
    ? (drafts.get(selectedId)?.crop ?? savedCrop)
    : fullCrop();
  const dirty = selectedId ? drafts.has(selectedId) : false;
  const hasUnsavedDrafts = drafts.size > 0;
  const zoom = zoomForCrop(crop);
  const saving = selectedId !== null && savingId === selectedId;

  const editCrop = useCallback(
    (next: CropRect) => {
      if (!selectedId) return;
      setDrafts((current) => {
        const updated = new Map(current);
        const normalized = normalizeCrop(next);
        if (cropsEqual(normalized, savedCrop)) updated.delete(selectedId);
        else {
          updated.set(selectedId, {
            crop: normalized,
            baseRevision:
              current.get(selectedId)?.baseRevision ?? savedRevision,
          });
        }
        return updated;
      });
      setOperationError("");
    },
    [savedCrop, savedRevision, selectedId],
  );

  const setZoom = (nextZoom: number) => editCrop(setCropZoom(crop, nextZoom));

  const save = async () => {
    if (!selectedId || !dirty || savingId) return;
    const id = selectedId;
    const draft = drafts.get(id);
    if (!draft) return;
    const submitted = draft.crop;
    const expectedRevision = draft.baseRevision;
    savingRef.current = true;
    syncControllerRef.current?.abort();
    setLoadState((current) =>
      current === "refreshing" ? "ready" : current,
    );
    setSavingId(id);
    setOperationError("");

    try {
      const reset = isFullCrop(submitted);
      const response = await fetch(`/api/drawings/${id}/crop`, {
        method: reset ? "DELETE" : "PUT",
        headers: {
          "if-match": `"${expectedRevision}"`,
          ...(reset ? {} : { "content-type": "application/json" }),
        },
        body: reset ? undefined : JSON.stringify(submitted),
      });
      const payload = (await response.json()) as unknown;
      if (response.status === 412) {
        const currentCrop = cropFromResponse(payload);
        setDrawings((current) =>
          current.map((drawing) =>
            drawing.id === id ? { ...drawing, crop: currentCrop } : drawing,
          ),
        );
        setDrafts((current) => {
          const latest = current.get(id);
          if (
            !latest ||
            latest.baseRevision !== expectedRevision ||
            !cropsEqual(latest.crop, submitted)
          ) {
            return current;
          }
          const updated = new Map(current);
          updated.set(id, {
            crop: latest.crop,
            baseRevision: revisionForCrop(currentCrop),
          });
          return updated;
        });
        setOperationError("crop changed · save again");
        return;
      }
      if (!response.ok) throw new Error("save failed");
      const saved = reset ? null : cropFromResponse(payload);
      if (!reset && !saved) throw new Error("invalid crop response");
      setDrawings((current) =>
        current.map((drawing) =>
          drawing.id === id ? { ...drawing, crop: saved } : drawing,
        ),
      );
      setDrafts((current) => {
        const latest = current.get(id);
        if (
          !latest ||
          latest.baseRevision !== expectedRevision ||
          !cropsEqual(latest.crop, submitted)
        ) {
          return current;
        }
        const updated = new Map(current);
        updated.delete(id);
        return updated;
      });
    } catch {
      setOperationError("save failed");
    } finally {
      savingRef.current = false;
      setSavingId(null);
    }
  };

  useEffect(() => {
    if (!hasUnsavedDrafts && !savingId) return;
    const warnBeforeUnload = (event: BeforeUnloadEvent) => {
      event.preventDefault();
      event.returnValue = "";
    };
    window.addEventListener("beforeunload", warnBeforeUnload);
    return () => window.removeEventListener("beforeunload", warnBeforeUnload);
  }, [hasUnsavedDrafts, savingId]);

  const confirmBack = (event: MouseEvent<HTMLAnchorElement>) => {
    if (
      (hasUnsavedDrafts || savingId) &&
      !window.confirm("Leave with unsaved crop changes?")
    ) {
      event.preventDefault();
    }
  };

  const select = (id: string) => {
    dragRef.current = null;
    setDragging(false);
    setSelectedId(id);
    setOperationError("");
  };

  const moveSelection = (offset: number) => {
    const nextIndex = selectedIndex + offset;
    const next = drawings[nextIndex];
    if (next) select(next.id);
  };

  const onStageKeyDown = (event: KeyboardEvent<HTMLButtonElement>) => {
    const step = event.shiftKey ? KEYBOARD_LARGE_STEP : KEYBOARD_STEP;
    let next: CropRect | null = null;

    if (event.key === "ArrowLeft") next = moveCrop(crop, -step, 0);
    else if (event.key === "ArrowRight") next = moveCrop(crop, step, 0);
    else if (event.key === "ArrowUp") next = moveCrop(crop, 0, -step);
    else if (event.key === "ArrowDown") next = moveCrop(crop, 0, step);
    else if (event.key === "+" || event.key === "=") {
      next = setCropZoom(crop, zoom + ZOOM_STEP);
    } else if (event.key === "-" || event.key === "_") {
      next = setCropZoom(crop, zoom - ZOOM_STEP);
    } else if (event.key === "0") {
      next = fullCrop();
    }

    if (next) {
      event.preventDefault();
      editCrop(next);
    }
  };

  const onPointerDown = (event: PointerEvent<HTMLButtonElement>) => {
    if (!selectedId || event.button !== 0) return;
    const bounds = event.currentTarget.getBoundingClientRect();
    event.currentTarget.setPointerCapture(event.pointerId);
    dragRef.current = {
      pointerId: event.pointerId,
      drawingId: selectedId,
      startX: event.clientX,
      startY: event.clientY,
      crop,
      viewportWidth: bounds.width,
      viewportHeight: bounds.height,
    };
    setDragging(true);
  };

  const onPointerMove = (event: PointerEvent<HTMLButtonElement>) => {
    const drag = dragRef.current;
    if (!drag || drag.pointerId !== event.pointerId || drag.drawingId !== selectedId) {
      return;
    }
    const deltaX = event.clientX - drag.startX;
    const deltaY = event.clientY - drag.startY;
    editCrop(
      moveCrop(
        drag.crop,
        (-deltaX * drag.crop.width) / drag.viewportWidth,
        (-deltaY * drag.crop.height) / drag.viewportHeight,
      ),
    );
  };

  const endDrag = (event: PointerEvent<HTMLButtonElement>) => {
    if (dragRef.current?.pointerId !== event.pointerId) return;
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
    dragRef.current = null;
    setDragging(false);
  };

  const chooseReference = (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    event.target.value = "";
    if (!file) return;
    setReference({ name: file.name, url: URL.createObjectURL(file) });
    setReferenceVisible(true);
  };

  const imageStyle = {
    width: `${zoom * 100}%`,
    height: `${zoom * 100}%`,
    left: `${(-crop.x / crop.width) * 100}%`,
    top: `${(-crop.y / crop.height) * 100}%`,
  } satisfies CSSProperties;

  const statusText = savingId
    ? "saving"
    : operationError
      ? operationError
      : loadState === "loading"
        ? "loading"
        : loadState === "refreshing"
          ? "syncing"
          : loadState === "error"
            ? "sync failed"
            : dirty
              ? "unsaved"
              : hasUnsavedDrafts
                ? `${drafts.size} unsaved`
              : "synced";

  return (
    <main className={styles.page}>
      <header className={styles.header}>
        <div className={styles.titleGroup}>
          <Link
            className={styles.back}
            href="/5A"
            aria-label="Back to animation"
            onClick={confirmBack}
          >
            ←
          </Link>
          <h1>5E</h1>
        </div>
        <div className={styles.sync}>
          <span role="status" aria-live="polite">
            {statusText}
          </span>
          <button type="button" onClick={() => void sync()} disabled={loadState === "refreshing"}>
            refresh
          </button>
        </div>
      </header>

      <aside className={styles.tools} aria-label="Crop controls">
        <section className={styles.controlGroup}>
          <span className={styles.label}>crop</span>
          <div className={styles.navigation}>
            <button
              type="button"
              onClick={() => moveSelection(-1)}
              disabled={selectedIndex <= 0}
              aria-label="Previous five"
            >
              ←
            </button>
            <span>
              {selected ? `${selectedIndex + 1}/${drawings.length}` : `0/${drawings.length}`}
            </span>
            <button
              type="button"
              onClick={() => moveSelection(1)}
              disabled={selectedIndex < 0 || selectedIndex >= drawings.length - 1}
              aria-label="Next five"
            >
              →
            </button>
          </div>
        </section>

        <section className={styles.controlGroup}>
          <label className={styles.rangeHeader} htmlFor="crop-zoom">
            <span className={styles.label}>zoom</span>
            <output>{Math.round(zoom * 100)}%</output>
          </label>
          <input
            id="crop-zoom"
            className={styles.range}
            type="range"
            min={MIN_ZOOM * 100}
            max={MAX_ZOOM * 100}
            step="1"
            value={Math.round(zoom * 100)}
            disabled={!selected}
            onChange={(event) => setZoom(Number(event.target.value) / 100)}
          />
        </section>

        <section className={styles.controlGroup}>
          <div className={styles.actionRow}>
            <button
              className={styles.primaryAction}
              type="button"
              onClick={() => void save()}
              disabled={!selected || !dirty || Boolean(savingId)}
            >
              {saving ? "saving" : "save"}
            </button>
            <button
              type="button"
              onClick={() => editCrop(fullCrop())}
              disabled={!selected || isFullCrop(crop) || Boolean(savingId)}
            >
              reset
            </button>
          </div>
        </section>

        <section className={styles.controlGroup}>
          <div className={styles.referenceHeader}>
            <span className={styles.label}>reference</span>
            {reference ? (
              <button
                className={styles.textAction}
                type="button"
                onClick={() => setReferenceVisible((current) => !current)}
                aria-pressed={referenceVisible}
              >
                {referenceVisible ? "hide" : "show"}
              </button>
            ) : null}
          </div>
          <label className={styles.fileButton}>
            {reference ? "replace" : "upload"}
            <input type="file" accept="image/*" onChange={chooseReference} />
          </label>
          {reference ? (
            <>
              <span className={styles.fileName} title={reference.name}>
                {reference.name}
              </span>
              <label className={styles.rangeHeader} htmlFor="reference-opacity">
                <span className={styles.label}>opacity</span>
                <output>{referenceOpacity}%</output>
              </label>
              <input
                id="reference-opacity"
                className={styles.range}
                type="range"
                min="0"
                max="100"
                step="1"
                value={referenceOpacity}
                onChange={(event) => setReferenceOpacity(Number(event.target.value))}
              />
              <button className={styles.clearAction} type="button" onClick={() => setReference(null)}>
                clear
              </button>
            </>
          ) : null}
        </section>
      </aside>

      <section className={styles.stage} aria-label="Crop editor">
        <button
          type="button"
          className={`${styles.paper}${dragging ? ` ${styles.dragging}` : ""}`}
          aria-label="A4 crop. Drag to pan. Use arrow keys to move, plus or minus to zoom, and zero to reset."
          disabled={!selected}
          onKeyDown={onStageKeyDown}
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={endDrag}
          onPointerCancel={endDrag}
        >
          {selected ? (
            <img
              className={styles.sourceImage}
              src={versionedSource(selected)}
              alt=""
              draggable={false}
              style={imageStyle}
            />
          ) : null}
          {reference && referenceVisible ? (
            <img
              className={styles.referenceImage}
              src={reference.url}
              alt=""
              draggable={false}
              style={{ opacity: referenceOpacity / 100 }}
            />
          ) : null}
          {!selected ? (
            <span className={styles.empty}>
              {loadState === "loading" ? "loading" : loadState === "error" ? "load failed" : "no fives"}
            </span>
          ) : null}
        </button>
      </section>

      <aside className={styles.library} aria-label="Kept fives">
        <div className={styles.libraryHeader}>
          <span className={styles.label}>fives</span>
          <span>{drawings.length}</span>
        </div>
        {loadState === "error" && drawings.length === 0 ? (
          <button className={styles.retry} type="button" onClick={() => void sync()}>
            retry
          </button>
        ) : null}
        <ol className={styles.list}>
          {drawings.map((drawing, index) => {
            const itemDirty = drafts.has(drawing.id);
            const edited = drawing.crop !== null;
            return (
              <li key={drawing.id}>
                <button
                  type="button"
                  className={drawing.id === selectedId ? styles.selectedItem : undefined}
                  onClick={() => select(drawing.id)}
                  aria-current={drawing.id === selectedId ? "true" : undefined}
                >
                  <img src={versionedSource(drawing)} alt="" loading="lazy" />
                  <span className={styles.itemText}>
                    <strong>five {String(index + 1).padStart(2, "0")}</strong>
                    <small>{itemDirty ? "unsaved" : edited ? "edited" : "original"}</small>
                  </span>
                  <span
                    className={`${styles.marker}${edited ? ` ${styles.editedMarker}` : ""}${
                      itemDirty ? ` ${styles.dirtyMarker}` : ""
                    }`}
                    aria-hidden="true"
                  />
                </button>
              </li>
            );
          })}
        </ol>
      </aside>
    </main>
  );
}
