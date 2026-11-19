// Client-side scene replica. No DOM and no network: importable by the browser,
// by the in-process virtual observers and by the test suite.
//
// Invariants enforced here:
//  * A create is the baseline. Nothing is ever displayed from a delta that
//    arrived before a baseline.
//  * Entity object identity is stable across updates. Camera turns and
//    re-interest never throw away and rebuild a scene object for the same id.
//  * Children whose parent reference cannot be resolved are held in
//    `staged` with an explicit `missing` list, never half-built.
//  * A destroy only releases the local replica. Whether the server keeps the
//    entity is not the client's business.

export class ClientScene {
  constructor() {
    this.entities = new Map();
    this.staged = new Map(); // id -> { payload, missing, sinceTick, reason }
    this.childrenByParent = new Map();
    this.tick = 0;
    this.log = [];

    this.stats = {
      framesApplied: 0,
      baselinesApplied: 0,
      createsApplied: 0,
      createsRefreshed: 0,
      updatesApplied: 0,
      updatesForStaged: 0,
      orphanUpdates: 0,
      staleUpdates: 0,
      destroysApplied: 0,
      stagedNow: 0,
      stagedTotal: 0,
      resolvedTotal: 0,
      dependencyRebuilds: 0,
      unknownDestroys: 0,
      ackedBaselines: 0,
    };
  }

  _event(type, data = {}) {
    this.log.push({ type, tick: this.tick, ...data });
    if (this.log.length > 80) this.log.shift();
  }

  /** @returns {{ack: string|null, events: object[]}} */
  applyFrame(frame) {
    const events = [];
    this.stats.framesApplied++;
    if (frame.k != null) this.tick = frame.k;

    if (frame.d && frame.d.length) {
      for (const id of frame.d) this._destroy(id, events);
    }
    if (frame.c && frame.c.length) {
      this.stats.baselinesApplied++;
      for (const payload of frame.c) this._upsertOrStage(payload, events);
    }
    if (frame.u && frame.u.length) this._applyUpdates(frame.u, events);
    this._resolveStaged(events);

    this.stats.stagedNow = this.staged.size;
    let ack = null;
    if (frame.b) {
      ack = frame.b;
      this.stats.ackedBaselines++;
    }
    return { ack, events, tick: this.tick };
  }

  _upsertOrStage(payload, events) {
    const existing = this.entities.get(payload.id);
    if (existing) {
      // Idempotent re-baseline (lost ack, retry): refresh in place, keeping
      // object identity so ongoing interaction is not interrupted.
      existing.x = payload.x;
      existing.y = payload.y;
      existing.state = payload.state || null;
      existing.region = payload.region;
      existing.version = payload.version;
      existing.baselinedTick = this.tick;
      this.stats.createsRefreshed++;
      events.push({ type: 'refresh', id: payload.id });
      return;
    }
    const missing = payload.parentId && !this.entities.has(payload.parentId)
      ? payload.parentId : null;
    this.staged.set(payload.id, {
      payload,
      missing,
      sinceTick: this.tick,
      reason: missing ? 'parent-not-yet-present' : 'ready',
    });
    this.stats.stagedTotal++;
  }

  _resolveStaged(events) {
    let progressed = true;
    while (progressed) {
      progressed = false;
      for (const [id, entry] of [...this.staged]) {
        if (entry.missing && !this.entities.has(entry.missing)) continue;
        this._materialize(id, entry, events);
        progressed = true;
      }
    }
    if (this.staged.size) this.stats.stagedNow = this.staged.size;
  }

  _materialize(id, entry, events) {
    const { payload } = entry;
    const parent = payload.parentId ? this.entities.get(payload.parentId) || null : null;
    const entity = {
      id: payload.id,
      kind: payload.kind,
      name: payload.name,
      x: payload.x,
      y: payload.y,
      region: payload.region,
      team: payload.team,
      parentId: payload.parentId,
      parent,
      state: payload.state || null,
      version: payload.version,
      baselinedTick: this.tick,
    };
    this.entities.set(id, entity);
    if (entity.parentId) {
      let kids = this.childrenByParent.get(entity.parentId);
      if (!kids) this.childrenByParent.set(entity.parentId, (kids = new Set()));
      kids.add(id);
    }
    this.staged.delete(id);
    this.stats.createsApplied++;
    this.stats.resolvedTotal++;
    this._event('create', { id, parentId: payload.parentId || null });
    events.push({ type: 'create', id, parentId: payload.parentId || null });
  }

  _applyUpdates(list, events) {
    for (const u of list) {
      const e = this.entities.get(u.i);
      if (!e) {
        if (this.staged.has(u.i)) this.stats.updatesForStaged++;
        else this.stats.orphanUpdates++;
        // A delta for a non-existent baseline is explicitly not adopted.
        continue;
      }
      if (u.v != null && u.v < e.version) {
        this.stats.staleUpdates++;
        continue;
      }
      if (u.x != null) e.x = u.x;
      if (u.y != null) e.y = u.y;
      if ('s' in u) e.state = u.s;
      if (u.g != null) e.region = u.g;
      if (u.v != null) e.version = u.v;
      this.stats.updatesApplied++;
      events.push({ type: 'update', id: u.i });
    }
  }

  _destroy(id, events) {
    const staged = this.staged.get(id);
    if (staged) {
      this.staged.delete(id);
      this._event('unstage-destroy', { id, missing: staged.missing || null });
      events.push({ type: 'unstage', id });
    }
    const e = this.entities.get(id);
    if (!e) {
      if (!staged) this.stats.unknownDestroys++;
      return;
    }
    this.entities.delete(id);
    this.stats.destroysApplied++;
    this._event('destroy', { id, kind: e.kind });
    events.push({ type: 'destroy', id });

    // Children that were resolvable only through this parent go back to
    // staging with an explicit missing reference. This should not happen in
    // normal operation (the server's dependency closure keeps the parent).
    const kids = this.childrenByParent.get(id);
    if (kids) {
      for (const childId of kids) {
        const child = this.entities.get(childId);
        if (!child) continue;
        this.stats.dependencyRebuilds++;
        this.entities.delete(childId);
        this.childrenByParent.get(id).delete(childId);
        this.staged.set(childId, {
          payload: snapshot(child),
          missing: id,
          sinceTick: this.tick,
          reason: 'parent-destroyed',
        });
        this._event('restage', { id: childId, missing: id });
        events.push({ type: 'restage', id: childId, missing: id });
      }
    }
    this.childrenByParent.delete(id);
    if (e.parentId) this.childrenByParent.get(e.parentId)?.delete(id);
  }

  reset() {
    this.entities.clear();
    this.staged.clear();
    this.childrenByParent.clear();
    this.log = [];
    this.stats.stagedNow = 0;
  }

  report(peekLimit = 28) {
    const ids = [...this.entities.keys()].sort();
    const staged = [...this.staged.entries()].map(([id, s]) => ({
      id, missing: s.missing || null, reason: s.reason, ticks: this.tick - s.sinceTick,
    }));
    const unresolvedRefs = ids.filter((id) => {
      const e = this.entities.get(id);
      return e.parentId && !this.entities.has(e.parentId);
    });
    const peek = ids.slice(0, peekLimit).map((id) => {
      const e = this.entities.get(id);
      return { id, x: e.x, y: e.y, v: e.version, p: e.parentId || null };
    });
    return {
      tick: this.tick,
      ids,
      staged,
      unresolvedRefs,
      peek,
      stats: { ...this.stats },
      log: this.log.slice(-12),
    };
  }

  drawables() {
    const out = [...this.entities.values()];
    return out;
  }
}

function snapshot(e) {
  return {
    id: e.id, kind: e.kind, name: e.name, x: e.x, y: e.y,
    region: e.region, team: e.team, parentId: e.parentId,
    state: e.state, version: e.version,
  };
}
