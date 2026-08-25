type CellState = {
  layerIndex: number;
  nextChangeAt: number;
};

export type GridTimelineFrame = {
  durationMs: number;
  layerIndexes: number[];
};

function hashLayerIds(layerIds: readonly string[]) {
  let hash = 2166136261;
  for (const id of layerIds) {
    for (let index = 0; index < id.length; index += 1) {
      hash ^= id.charCodeAt(index);
      hash = Math.imul(hash, 16777619);
    }
  }
  return hash >>> 0;
}

function nextRandom(state: { value: number }) {
  let value = state.value || 0x6d2b79f5;
  value ^= value << 13;
  value ^= value >>> 17;
  value ^= value << 5;
  state.value = value >>> 0;
  return state.value / 0x1_0000_0000;
}

function randomDwellMs(
  randomState: { value: number },
  minimumDwellMs: number,
  maximumDwellMs: number,
) {
  const minimum = Math.max(1, Math.round(minimumDwellMs));
  const maximum = Math.max(minimum, Math.round(maximumDwellMs));
  return minimum + Math.floor(nextRandom(randomState) * (maximum - minimum + 1));
}

export function buildGridTimeline(
  layerIds: readonly string[],
  cellCount: number,
  seed: number,
  minimumDwellMs: number,
  maximumDwellMs: number,
) {
  if (layerIds.length === 0 || cellCount <= 0) return [];

  const randomState = {
    value: (hashLayerIds(layerIds) ^ seed ^ 0x9e3779b9) >>> 0,
  };
  const states: CellState[] = Array.from({ length: cellCount }, (_, cell) => ({
    layerIndex: cell % layerIds.length,
    nextChangeAt: randomDwellMs(
      randomState,
      minimumDwellMs,
      maximumDwellMs,
    ),
  }));
  const durationMs = Math.max(
    Math.round(maximumDwellMs),
    layerIds.length * Math.round(minimumDwellMs),
  );
  const timeline: GridTimelineFrame[] = [];
  let elapsedMs = 0;

  while (elapsedMs < durationMs) {
    const nextChangeAt = Math.min(
      durationMs,
      ...states.map((state) => state.nextChangeAt),
    );
    timeline.push({
      durationMs: nextChangeAt - elapsedMs,
      layerIndexes: states.map(({ layerIndex }) => layerIndex),
    });
    elapsedMs = nextChangeAt;

    for (const state of states) {
      if (state.nextChangeAt > elapsedMs) continue;

      if (layerIds.length > 1) {
        const step = 1 + Math.floor(nextRandom(randomState) * (layerIds.length - 1));
        state.layerIndex = (state.layerIndex + step) % layerIds.length;
      }
      state.nextChangeAt =
        elapsedMs +
        randomDwellMs(randomState, minimumDwellMs, maximumDwellMs);
    }
  }

  return timeline;
}
