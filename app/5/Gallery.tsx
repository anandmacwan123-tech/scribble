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

const MAX_SELECTION = 50;

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
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [loadingMore, setLoadingMore] = useState(false);
  const [downloading, setDownloading] = useState(false);
  const [downloadFailed, setDownloadFailed] = useState(false);

  useEffect(() => {
    const controller = new AbortController();

    void loadPage(null, controller.signal)
      .then((page) => {
        setDrawings(page.drawings);
        setNextCursor(page.nextCursor);
        setStatus("ready");
      })
      .catch((error: unknown) => {
        if (error instanceof DOMException && error.name === "AbortError") return;
        setStatus("error");
      });

    return () => controller.abort();
  }, []);

  const loadMore = async () => {
    if (!nextCursor || loadingMore) return;
    setLoadingMore(true);
    try {
      const page = await loadPage(nextCursor);
      setDrawings((current) => [...current, ...page.drawings]);
      setNextCursor(page.nextCursor);
      setStatus("ready");
    } catch {
      setStatus("error");
    } finally {
      setLoadingMore(false);
    }
  };

  const selectedIds = useMemo(() => [...selected], [selected]);
  const selectionFull = selected.size >= MAX_SELECTION;

  const toggle = (id: string) => {
    setSelected((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else if (next.size < MAX_SELECTION) next.add(id);
      return next;
    });
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
      aria-busy={status === "loading" || loadingMore || downloading}
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
            disabled={selectedIds.length === 0 || downloading}
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

      {nextCursor ? (
        <div className="gallery-more">
          <button
            className="gallery-control"
            type="button"
            disabled={loadingMore}
            onClick={loadMore}
          >
            {loadingMore ? "loading…" : "more"}
          </button>
        </div>
      ) : null}
    </main>
  );
}
