export const GRID_TICK_MS = 100;
export const MIN_GRID_DWELL_MS = 300;
export const MAX_GRID_DWELL_MS = 600;

type CellState = {
  layerIndex: number;
  ticksRemaining: number;
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

function randomDwellTicks(randomState: { value: number }) {
  const minimum = MIN_GRID_DWELL_MS / GRID_TICK_MS;
  const maximum = MAX_GRID_DWELL_MS / GRID_TICK_MS;
  return minimum + Math.floor(nextRandom(randomState) * (maximum - minimum + 1));
}

export function buildGridTimeline(
  layerIds: readonly string[],
  cellCount: number,
  seed: number,
) {
  if (layerIds.length === 0 || cellCount <= 0) return [];

  const randomState = {
    value: (hashLayerIds(layerIds) ^ seed ^ 0x9e3779b9) >>> 0,
  };
  const states: CellState[] = Array.from({ length: cellCount }, (_, cell) => ({
    layerIndex: cell % layerIds.length,
    ticksRemaining: randomDwellTicks(randomState),
  }));
  const tickCount = Math.max(
    MAX_GRID_DWELL_MS / GRID_TICK_MS,
    layerIds.length * (MIN_GRID_DWELL_MS / GRID_TICK_MS),
  );
  const timeline: number[][] = [];

  for (let tick = 0; tick < tickCount; tick += 1) {
    timeline.push(states.map(({ layerIndex }) => layerIndex));

    for (const state of states) {
      state.ticksRemaining -= 1;
      if (state.ticksRemaining > 0) continue;

      if (layerIds.length > 1) {
        const step = 1 + Math.floor(nextRandom(randomState) * (layerIds.length - 1));
        state.layerIndex = (state.layerIndex + step) % layerIds.length;
      }
      state.ticksRemaining = randomDwellTicks(randomState);
    }
  }

  return timeline;
}
