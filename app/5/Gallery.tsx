"use client";

import { useEffect, useMemo, useState } from "react";

type Drawing = {
  id: string;
  createdAt: string;
  previewUrl: string;
};

type DrawingPage = {
  drawings: Drawing[];
  nextCursor: string | null;
};

const MAX_BULK_SELECTION = 500;

const dateFormatter = new Intl.DateTimeFormat(undefined, {
  dateStyle: "medium",
  timeStyle: "short",
});

async function loadPage(cursor: string | null, signal?: AbortSignal) {
  const query = new URLSearchParams({ limit: "100" });
  if (cursor) query.set("cursor", cursor);
  const response = await fetch(`/api/drawings?${query}`, { signal });
  if (!response.ok) throw new Error("load failed");
  return (await response.json()) as DrawingPage;
}

export default function Gallery() {
  const [drawings, setDrawings] = useState<Drawing[]>([]);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [status, setStatus] = useState<"loading" | "ready" | "error">(
    "loading",
  );
  const [downloading, setDownloading] = useState(false);
  const [downloadFailed, setDownloadFailed] = useState(false);

  useEffect(() => {
    const controller = new AbortController();

    void (async () => {
      const loaded = new Map<string, Drawing>();
      const visitedCursors = new Set<string>();
      let cursor: string | null = null;

      do {
        const page = await loadPage(cursor, controller.signal);
        for (const drawing of page.drawings) loaded.set(drawing.id, drawing);
        setDrawings([...loaded.values()]);

        cursor = page.nextCursor;
        if (cursor && visitedCursors.has(cursor)) {
          throw new Error("repeated cursor");
        }
        if (cursor) visitedCursors.add(cursor);
      } while (cursor);

      if (!controller.signal.aborted) {
        setStatus("ready");
      }
    })().catch((error: unknown) => {
      if (error instanceof DOMException && error.name === "AbortError") return;
      setStatus("error");
    });

    return () => controller.abort();
  }, []);

  const selectedIds = useMemo(
    () => drawings.filter(({ id }) => selected.has(id)).map(({ id }) => id),
    [drawings, selected],
  );
  const allSelected =
    drawings.length > 0 &&
    selectedIds.length === Math.min(drawings.length, MAX_BULK_SELECTION);
  const selectionFull = selectedIds.length >= MAX_BULK_SELECTION;

  const toggle = (id: string) => {
    setSelected((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else if (next.size < MAX_BULK_SELECTION) next.add(id);
      return next;
    });
  };

  const toggleAll = () => {
    setSelected(
      allSelected
        ? new Set()
        : new Set(
            drawings
              .slice(0, MAX_BULK_SELECTION)
              .map(({ id }) => id),
          ),
    );
  };

  const download = async () => {
    if (selectedIds.length === 0 || downloading) return;
    setDownloading(true);
    setDownloadFailed(false);

    try {
      const response = await fetch("/api/drawings/download", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ ids: selectedIds }),
      });
      if (!response.ok) throw new Error("download failed");

      const href = URL.createObjectURL(await response.blob());
      const anchor = document.createElement("a");
      anchor.href = href;
      anchor.download = "kept.zip";
      document.body.appendChild(anchor);
      anchor.click();
      anchor.remove();
      window.setTimeout(() => URL.revokeObjectURL(href), 0);
    } catch {
      setDownloadFailed(true);
    } finally {
      setDownloading(false);
    }
  };

  return (
    <main
      className="gallery-page"
      aria-busy={status === "loading" || downloading}
    >
      <nav className="gallery-nav" aria-label="Gallery controls">
        {/* A plain document navigation avoids retaining gallery selection state. */}
        {/* eslint-disable-next-line @next/next/no-html-link-for-pages */}
        <a className="gallery-control gallery-back" href="/" aria-label="Back">
          ←
        </a>
        <div className="gallery-actions">
          <button
            className="gallery-control"
            type="button"
            disabled={
              status !== "ready" || drawings.length === 0 || downloading
            }
            onClick={toggleAll}
          >
            {allSelected
              ? "clear"
              : drawings.length > MAX_BULK_SELECTION
                ? `select ${MAX_BULK_SELECTION}`
                : "select all"}
          </button>
          <button
            className="gallery-control"
            type="button"
            disabled={
              status !== "ready" || selectedIds.length === 0 || downloading
            }
            onClick={download}
          >
            {downloading
              ? "preparing…"
              : selectedIds.length > 0
                ? `download · ${selectedIds.length}`
                : "download"}
          </button>
        </div>
      </nav>

      <header className="gallery-heading">
        <h1>kept.</h1>
      </header>

      {status === "loading" ? <p className="gallery-state">loading…</p> : null}
      {status === "error" ? (
        <p className="gallery-state">
          {drawings.length > 0 ? "couldn’t load more." : "couldn’t load."}
        </p>
      ) : null}
      {downloadFailed ? (
        <p className="gallery-state">couldn’t prepare.</p>
      ) : null}
      {status === "ready" && drawings.length > MAX_BULK_SELECTION ? (
        <p className="gallery-state">{MAX_BULK_SELECTION} per download.</p>
      ) : null}
      {status === "ready" && drawings.length === 0 ? (
        <p className="gallery-state">nothing yet.</p>
      ) : null}

      {drawings.length > 0 ? (
        <ul className="gallery-grid">
          {drawings.map((drawing) => {
            const date = new Date(drawing.createdAt);
            const label = dateFormatter.format(date);
            const isSelected = selected.has(drawing.id);

            return (
              <li key={drawing.id}>
                <label
                  className={`gallery-card${isSelected ? " gallery-card--selected" : ""}`}
                >
                  <input
                    className="gallery-checkbox"
                    type="checkbox"
                    checked={isSelected}
                    disabled={!isSelected && selectionFull}
                    onChange={() => toggle(drawing.id)}
                    aria-label={`Select drawing saved ${label}`}
                  />
                  <span className="gallery-check" aria-hidden="true" />
                  <span className="gallery-preview">
                    {/* Canonical user SVGs are dynamic Worker responses, so the image optimizer cannot pre-size them. */}
                    {/* eslint-disable-next-line @next/next/no-img-element */}
                    <img
                      src={drawing.previewUrl}
                      alt={`Drawing saved ${label}`}
                      loading="lazy"
                      draggable="false"
                    />
                  </span>
                  <time dateTime={drawing.createdAt}>{label}</time>
                </label>
              </li>
            );
          })}
        </ul>
      ) : null}
    </main>
  );
}
