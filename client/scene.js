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
//  * Ids are reused across subscription generations. Every create/destroy/
//    update may carry the generation it belongs to; a message whose
//    generation does not match the live instance is dropped and recorded as
//    a misbind, never applied to the wrong incarnation.

export class ClientScene {
  constructor() {
    this.entities = new Map();
    this.staged = new Map(); // id -> { payload, missing, sinceTick, reason }
    this.childrenByParent = new Map();
    this.tick = 0;
    this.log = [];

    // Per-instance journal: every gen-carrying message for an id, in arrival
    // order. This is what lets the lab name the first message that bound to
    // the wrong instance and cut a minimal repro packet sequence.
    this.journal = new Map(); // id -> [{op, id, gen, tick, ...}]
    this.firstMisbind = null; // {tick, op, id, msgGen, currentGen}
    this.misbinds = [];
    this.minimalRepro = null; // {id, gen, frames:[...]}

    this.stats = {
      framesApplied: 0,
      baselinesApplied: 0,
      createsApplied: 0,
      createsRefreshed: 0,
      staleCreates: 0,
      updatesApplied: 0,
      updatesForStaged: 0,
      orphanUpdates: 0,
      staleUpdates: 0,
      mismatchedUpdates: 0,
      destroysApplied: 0,
      mismatchedDestroys: 0,
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

  _journalEntry(entry) {
    let list = this.journal.get(entry.id);
    if (!list) {
      if (this.journal.size > 200) this.journal.delete(this.journal.keys().next().value);
      this.journal.set(entry.id, (list = []));
    }
    list.push(entry);
    if (list.length > 30) list.shift();
  }

  // A message whose generation does not match the instance it would bind to.
  // The first one is preserved with the shortest packet sequence that
  // reproduces it: everything since the create of the current instance.
  _noteMisbind(entry) {
    const mb = { tick: this.tick, ...entry };
    this.misbinds.push(mb);
    if (this.misbinds.length > 20) this.misbinds.shift();
    if (this.firstMisbind) return;
    this.firstMisbind = mb;
    this.minimalRepro = this.buildRepro(entry.id);
  }

  // The shortest packet sequence that still reproduces the misbinding for an
  // id: the create of the live instance (plus the ancestor creates it needs
  // to resolve) followed by every later message for the id, including the
  // misbound one.
  buildRepro(id) {
    const currentGen = this.entities.get(id)?.gen ?? this.staged.get(id)?.payload?.g ?? null;
    const list = this.journal.get(id) || [];
    let start = 0;
    let createEntry = null;
    for (let i = list.length - 1; i >= 0; i--) {
      if (list[i].op === 'create' && list[i].gen === currentGen) { start = i; createEntry = list[i]; break; }
    }
    const frames = [];
    const ancestors = [];
    const seen = new Set();
    let p = createEntry?.payload?.parentId || null;
    while (p && !seen.has(p)) {
      seen.add(p);
      const parent = this.entities.get(p);
      if (!parent) break;
      ancestors.unshift(parent);
      p = parent.parentId;
    }
    if (ancestors.length) {
      frames.push({
        t: 'f',
        k: createEntry ? createEntry.tick : this.tick,
        b: 'brepro-ancestors',
        c: ancestors.map((a) => snapshot(a)),
      });
    }
    for (const j of list.slice(start)) {
      if (j.op === 'create' && j.payload) {
        frames.push({ t: 'f', k: j.tick, b: `brepro-${j.gen}`, c: [j.payload] });
      } else if (j.op === 'destroy') {
        frames.push({ t: 'f', k: j.tick, d: [{ i: id, g: j.gen }] });
      } else if (j.op === 'update' && j.u) {
        frames.push({ t: 'f', k: j.tick, u: [j.u] });
      }
    }
    return { id, gen: currentGen, frames };
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
    const gen = payload.g ?? null;
    const existing = this.entities.get(payload.id);
    if (existing) {
      if (gen != null && existing.gen != null && gen < existing.gen) {
        // A create for an older incarnation than the live one: cache hit or
        // reordered packet. It must not roll the instance back.
        this.stats.staleCreates++;
        this._journalEntry({ op: 'create', id: payload.id, gen, tick: this.tick, payload, stale: true });
        this._event('stale-create', { id: payload.id, gen, currentGen: existing.gen });
        events.push({ type: 'stale-create', id: payload.id, gen, currentGen: existing.gen });
        this._noteMisbind({ op: 'create', id: payload.id, msgGen: gen, currentGen: existing.gen });
        return;
      }
      // Idempotent re-baseline (lost ack, retry): refresh in place, keeping
      // object identity so ongoing interaction is not interrupted. A newer
      // generation is adopted the same way; its destroy was only a replica
      // event and the newer baseline supersedes it.
      existing.x = payload.x;
      existing.y = payload.y;
      existing.state = payload.state || null;
      existing.region = payload.region;
      existing.version = payload.version;
      if (gen != null) existing.gen = gen;
      existing.baselinedTick = this.tick;
      this.stats.createsRefreshed++;
      this._journalEntry({ op: 'create', id: payload.id, gen, tick: this.tick, payload });
      this._event('refresh', { id: payload.id, gen });
      events.push({ type: 'refresh', id: payload.id, gen });
      return;
    }
    const stagedPrior = this.staged.get(payload.id);
    if (stagedPrior) {
      const priorGen = stagedPrior.payload.g ?? null;
      if (gen != null && priorGen != null && gen < priorGen) {
        this.stats.staleCreates++;
        this._journalEntry({ op: 'create', id: payload.id, gen, tick: this.tick, payload, stale: true });
        this._event('stale-create', { id: payload.id, gen, currentGen: priorGen });
        events.push({ type: 'stale-create', id: payload.id, gen, currentGen: priorGen });
        this._noteMisbind({ op: 'create', id: payload.id, msgGen: gen, currentGen: priorGen });
        return;
      }
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
    this._journalEntry({ op: 'create', id: payload.id, gen, tick: this.tick, payload });
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
      gen: payload.g ?? null,
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
    this._event('create', { id, gen: entity.gen, parentId: payload.parentId || null });
    events.push({ type: 'create', id, gen: entity.gen, parentId: payload.parentId || null });
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
      if (u.n != null) this._journalEntry({ op: 'update', id: u.i, gen: u.n, tick: this.tick, u });
      if (u.n != null && e.gen != null && u.n !== e.gen) {
        // A delta produced for another incarnation of this id.
        this.stats.mismatchedUpdates++;
        this._event('stale-update', { id: u.i, gen: u.n, currentGen: e.gen });
        events.push({ type: 'stale-update', id: u.i, gen: u.n, currentGen: e.gen });
        this._noteMisbind({ op: 'update', id: u.i, msgGen: u.n, currentGen: e.gen });
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

  // Destroys arrive as {i, g} naming the exact instance generation they
  // retire (legacy plain ids are also accepted and apply to whatever instance
  // is current). A destroy for any other generation is a stale or reordered
  // message: it is dropped, so only the old incarnation's side effects are
  // revoked and the live instance — plus everything else in the scene — is
  // left completely untouched.
  _destroy(raw, events) {
    const id = typeof raw === 'object' && raw !== null ? raw.i : raw;
    const gen = typeof raw === 'object' && raw !== null ? (raw.g ?? null) : null;
    this._journalEntry({ op: 'destroy', id, gen, tick: this.tick });

    const staged = this.staged.get(id);
    if (staged) {
      const stagedGen = staged.payload.g ?? null;
      if (gen != null && stagedGen != null && gen !== stagedGen) {
        this.stats.mismatchedDestroys++;
        this._event('stale-destroy', { id, gen, currentGen: stagedGen, staged: true });
        events.push({ type: 'stale-destroy', id, gen, currentGen: stagedGen });
        this._noteMisbind({ op: 'destroy', id, msgGen: gen, currentGen: stagedGen });
        return;
      }
      this.staged.delete(id);
      this._event('unstage-destroy', { id, gen, missing: staged.missing || null });
      events.push({ type: 'unstage', id, gen });
    }
    const e = this.entities.get(id);
    if (!e) {
      if (!staged) this.stats.unknownDestroys++;
      return;
    }
    if (gen != null && e.gen != null && gen !== e.gen) {
      this.stats.mismatchedDestroys++;
      this._event('stale-destroy', { id, gen, currentGen: e.gen });
      events.push({ type: 'stale-destroy', id, gen, currentGen: e.gen });
      this._noteMisbind({ op: 'destroy', id, msgGen: gen, currentGen: e.gen });
      return;
    }
    this.entities.delete(id);
    this.stats.destroysApplied++;
    this._event('destroy', { id, gen, kind: e.kind });
    events.push({ type: 'destroy', id, gen });

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
    this.journal.clear();
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
      return { id, x: e.x, y: e.y, v: e.version, g: e.gen, p: e.parentId || null };
    });
    return {
      tick: this.tick,
      ids,
      staged,
      unresolvedRefs,
      peek,
      stats: { ...this.stats },
      log: this.log.slice(-12),
      firstMisbind: this.firstMisbind,
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
    state: e.state, version: e.version, g: e.gen ?? null,
  };
}
