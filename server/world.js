// Deterministic world generation and authoritative simulation.
// Entities exist on the server for the whole session. Visibility is a
// per-observer query, never a lifecycle owner.

import { WORLD, regionIdAt, regionNameAt } from '../shared/protocol.js';

const KIND_BY_REGION = [
  ['crate', 'lamp', 'valve'],
  ['torch', 'cargo', 'rig'],
  ['relic', 'pipe', 'barge'],
  ['gatehouse', 'door', 'tower'],
];

const KIND_LANDMARK = [
  'tower', 'barge', 'gatehouse', 'rig',
  'tower', 'relic', 'barge', 'rig',
  'gatehouse', 'tower', 'rig', 'barge',
];

function mulberry32(seed) {
  let a = seed >>> 0;
  return function random() {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export class World {
  constructor(seed = 20261118) {
    this.seed = seed;
    this.rand = mulberry32(seed);
    this.entities = new Map();
    this.regions = new Map();
    this.tick = 0;
    this.nextId = 1;
    this.spawns = [];
    this._build();
  }

  _add(kind, x, y, extra = {}) {
    const id = `E${String(this.nextId++).padStart(3, '0')}`;
    const region = regionIdAt(x, y);
    const entity = {
      id,
      kind,
      name: extra.name || `${kind.toUpperCase()}-${id.slice(1)}`,
      x: Math.round(x * 10) / 10,
      y: Math.round(y * 10) / 10,
      region,
      team: extra.team || null,
      parentId: extra.parentId || null,
      state: extra.state || null,
      version: 0,
      // Server-only metadata; never serialised into a snapshot.
      _baseX: x,
      _baseY: y,
      _phase: this.rand() * Math.PI * 2,
      _radius: extra.radius ?? 0,
      _speed: extra.speed ?? 0,
      _interactive: !!extra.interactive,
    };
    this.entities.set(id, entity);
    return entity;
  }

  _build() {
    for (let r = 0; r < WORLD.rows; r++) {
      for (let c = 0; c < WORLD.cols; c++) {
        const id = `R${c}-${r}`;
        const x0 = c * WORLD.cellW;
        const y0 = r * WORLD.cellH;
        const label = regionNameAt(x0 + 1, y0 + 1);
        this.regions.set(id, {
          id, c, r, name: label,
          x0, y0, x1: x0 + WORLD.cellW, y1: y0 + WORLD.cellH,
        });

        // Every region gets a landmark, three props, and two ambient entities.
        const kinds = KIND_BY_REGION[(r * WORLD.cols + c) % KIND_BY_REGION.length];
        const landmarkKind = KIND_LANDMARK[r * WORLD.cols + c];
        const landmark = this._add(landmarkKind, x0 + WORLD.cellW / 2, y0 + WORLD.cellH / 2, {
          name: `${label} ${landmarkKind}`,
          interactive: false,
        });

        // Child props hang off the landmark, so cross-region parent/child
        // dependencies are common and must be resolved by the protocol.
        for (let i = 0; i < 3; i++) {
          const kind = kinds[i % kinds.length];
          const px = x0 + 22 + this.rand() * (WORLD.cellW - 44);
          const py = y0 + 22 + this.rand() * (WORLD.cellH - 44);
          this._add(kind, px, py, {
            name: `${kind} @ ${label}`,
            parentId: landmark.id,
            interactive: kind === 'valve' || kind === 'door' || kind === 'torch',
            state: { active: this.rand() < 0.5, level: Math.floor(this.rand() * 5) },
          });
        }

        for (let i = 0; i < 2; i++) {
          const kind = this.rand() < 0.5 ? 'npc' : 'beacon';
          const px = x0 + 15 + this.rand() * (WORLD.cellW - 30);
          const py = y0 + 15 + this.rand() * (WORLD.cellH - 30);
          this._add(kind, px, py, {
            team: kind === 'npc' ? `drift-${(r + c) % 3}` : null,
            interactive: kind === 'npc',
            radius: 10 + this.rand() * 14,
            speed: 0.15 + this.rand() * 0.25,
            state: { hp: 60 + Math.floor(this.rand() * 40) },
          });
        }
      }
    }

    assertLandmarkRefs(this);

    this.spawns = [
      { x: WORLD.cellW * 0.5, y: WORLD.cellH * 0.5 },
      { x: WORLD.cellW * 1.5, y: WORLD.cellH * 1.5 },
    ];
  }

  getEntity(id) {
    return this.entities.get(id) || null;
  }

  // Ambient movement is server-authoritative; clients never advance it.
  step() {
    this.tick++;
    for (const e of this.entities.values()) {
      if (e.kind !== 'npc') continue;
      const t = this.tick * 0.035 * e._speed;
      e.x = Math.round((e._baseX + Math.cos(t * 2.3 + e._phase) * e._radius) * 10) / 10;
      e.y = Math.round((e._baseY + Math.sin(t * 1.7 + e._phase) * e._radius * 0.7) * 10) / 10;
      e.region = regionIdAt(e.x, e.y);
      e.version++;
    }
  }

  flagInteraction(entityId, observerId) {
    const e = this.entities.get(entityId);
    if (!e || !e._interactive) return false;
    e.version++;
    e.state = { ...(e.state || {}), lastBy: observerId, lastTick: this.tick };
    return true;
  }

  snapshotEntity(e) {
    return {
      id: e.id,
      kind: e.kind,
      name: e.name,
      x: e.x,
      y: e.y,
      region: e.region,
      team: e.team,
      parentId: e.parentId,
      state: e.state,
      version: e.version,
    };
  }

  stats() {
    const byRegion = {};
    for (const region of this.regions.values()) byRegion[region.id] = 0;
    for (const e of this.entities.values()) {
      if (byRegion[e.region] != null) byRegion[e.region]++;
    }
    return { entities: this.entities.size, regions: this.regions.size, byRegion, tick: this.tick };
  }
}

function assertLandmarkRefs(world) {
  for (const e of world.entities.values()) {
    if (e.parentId && !world.entities.has(e.parentId)) {
      throw new Error(`world generation produced dangling parent ${e.parentId} for ${e.id}`);
    }
  }
}
