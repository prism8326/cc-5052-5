// Shared constants and wire vocabulary for the continuous-world demo.

export const TICK_MS = 100;

export const WORLD = Object.freeze({
  cols: 4,
  rows: 3,
  cellW: 140,
  cellH: 120,
  get width() { return this.cols * this.cellW; },
  get height() { return this.rows * this.cellH; },
});

export const REGION_NAMES = Object.freeze([
  ['Rustwater', 'Glassfield', 'Pinebreak', 'Ember Cut'],
  ['Copper Flats', 'Mist Hollow', 'Kestrel Ridge', 'Old Kiln'],
  ['Saltmarsh', 'Dry Creek', 'Verdant Span', 'Cinder Gate'],
]);

export const DEFAULT_VIEW = Object.freeze({
  radius: 105,
  halfAngle: Math.PI / 3,
  nearRadius: 26,
});

export const DEFAULT_BUDGET = Object.freeze({
  bytes: 3800,
  ops: 48,
});

// Retention windows. Grace must outlast the scripted observer's look-around
// dwell, otherwise every camera swing destroys and rebuilds identities instead
// of merely flipping them in and out of the active cone.
export const GRACE_TICKS = 12;
export const INTERACT_HOLD_TICKS = 40;

export const REASON = Object.freeze({
  NEAR: 'near',
  CONE: 'cone',
  TEAM: 'team-link',
  PINNED: 'pinned',
  HOLD: 'interaction-hold',
  GRACE: 'interest-grace',
  DEP: 'dependency',
});

export const REASON_INFO = Object.freeze({
  near: {
    label: 'Near ring',
    color: '#5ee1b3',
    note: 'Inside the always-visible near radius, regardless of facing.',
  },
  cone: {
    label: 'View cone',
    color: '#63b7ff',
    note: 'Inside the declared view radius and horizontal cone.',
  },
  'team-link': {
    label: 'Team link',
    color: '#c68cff',
    note: 'Declared team visibility: squad avatars remain replicated at any distance.',
  },
  pinned: {
    label: 'Pinned',
    color: '#ffd166',
    note: 'Explicitly declared by the observer (objective marker / focused entity).',
  },
  'interaction-hold': {
    label: 'Interaction hold',
    color: '#ff8f6b',
    note: 'Retained briefly after an interaction so camera turns cannot cut an active object.',
  },
  'interest-grace': {
    label: 'Interest grace',
    color: '#9aa7b8',
    note: 'Short hysteresis after leaving the cone, preventing spawn/despawn thrash while panning.',
  },
  dependency: {
    label: 'Dependency',
    color: '#f472b6',
    note: 'Parent required to resolve a subscribed child transform/reference.',
  },
});

export function regionCoords(x, y) {
  return {
    c: Math.max(0, Math.min(WORLD.cols - 1, Math.floor(x / WORLD.cellW))),
    r: Math.max(0, Math.min(WORLD.rows - 1, Math.floor(y / WORLD.cellH))),
  };
}

export function regionIdAt(x, y) {
  const { c, r } = regionCoords(x, y);
  return `R${c}-${r}`;
}

export function regionNameAt(x, y) {
  const { c, r } = regionCoords(x, y);
  return REGION_NAMES[r]?.[c] ?? `R${c}-${r}`;
}
