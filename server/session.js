// Per-observer interest query, replica lifecycle and budgeted replication.
//
// Lifecycle rules:
//  * The world owns entities for the whole session. A session only ever owns a
//    *replica*; losing interest queues a destroy for that observer, never a
//    deletion of server state.
//  * A create is a full baseline. Updates for an entity are withheld until the
//    client acknowledges that baseline, so a delta can never be the first thing
//    a client applies. Unacknowledged baselines are retried at a fixed cadence.
//  * Any entity with a parentId drags its ancestor chain into the subscription
//    (reason "dependency"). Creates are emitted parent-first; the client holds
//    orphaned children in a staging area until the parent baseline arrives.
//  * Leaving the view cone does not drop an object instantly: interest grace
//    absorbs camera jitter and interaction holds keep active objects alive.

import {
  GRACE_TICKS,
  INTERACT_HOLD_TICKS,
  REASON,
  regionIdAt,
} from '../shared/protocol.js';

const PRIORITY = {
  near: 0,
  pinned: 1,
  cone: 2,
  'team-link': 3,
  'interaction-hold': 4,
  'interest-grace': 5,
  dependency: 6,
};

const FRAME_OVERHEAD = 96;
const BASELINE_RETRY_TICKS = 12;
const MAX_BASELINE_RETRIES = 4;
const MAX_RETRY_FRAMES_PER_TICK = 2;
const MAX_PINS = 12;

export function normalizeView(view, fallback) {
  const v = view && typeof view === 'object' ? view : {};
  const num = (x, lo, hi, dflt) =>
    Number.isFinite(x) ? Math.min(hi, Math.max(lo, x)) : dflt;
  return {
    radius: num(v.radius, 40, 300, fallback.radius),
    halfAngle: num(v.halfAngle, 0.15, Math.PI, fallback.halfAngle),
    nearRadius: num(v.nearRadius, 0, 100, fallback.nearRadius),
  };
}

export function normalizeBudget(budget, fallback) {
  const b = budget && typeof budget === 'object' ? budget : {};
  const num = (x, lo, hi, dflt) =>
    Number.isFinite(x) ? Math.round(Math.min(hi, Math.max(lo, x))) : dflt;
  return {
    bytes: num(b.bytes, 200, 20000, fallback.bytes),
    ops: num(b.ops, 1, 200, fallback.ops),
  };
}

// Pure query: Map<entityId, {reasons, dist, angle}> for positional and
// declared interest. Retention (hold/grace) and dependency closure are
// layered on top by ObserverSession.reconcile.
export function queryInterest(world, pose, view, opts = {}) {
  const team = opts.team || null;
  const pins = opts.pins || new Set();
  const out = new Map();
  const cos = Math.cos(pose.facing);
  const sin = Math.sin(pose.facing);

  for (const e of world.entities.values()) {
    const dx = e.x - pose.x;
    const dy = e.y - pose.y;
    const dist = Math.hypot(dx, dy);
    const reasons = [];

    if (dist <= view.nearRadius) {
      reasons.push(REASON.NEAR);
    } else if (dist <= view.radius) {
      const dot = dist === 0 ? 1 : (dx * cos + dy * sin) / dist;
      const angle = Math.acos(Math.max(-1, Math.min(1, dot)));
      if (angle <= view.halfAngle) reasons.push(REASON.CONE);
    }
    if (pins.has(e.id)) reasons.push(REASON.PINNED);
    if (team && e.team && e.team === team) reasons.push(REASON.TEAM);

    if (reasons.length) out.set(e.id, { reasons, dist });
  }
  return out;
}

export class ObserverSession {
  constructor({ world, span, id, name, mode, profile, team, view, budget, send, spawn }) {
    this.world = world;
    this.span = span;
    this.id = id;
    this.name = name;
    this.mode = mode;
    this.profile = profile || null;
    this.team = team || null;
    this.view = view;
    this.budget = budget;
    this.send = send;

    this.pose = { x: spawn.x, y: spawn.y, facing: 0 };
    this.region = regionIdAt(spawn.x, spawn.y);
    this.pins = new Set();
    this.holds = new Map();       // id -> tick the hold ends
    this.graceUntil = new Map();  // id -> tick the grace ends

    this.created = new Map();       // id -> {versionSent, xSent, ySent, stateSent, regionSent, gen}
    this.pendingCreate = new Map(); // id -> {baselineId, sentTick, version, retries, gen, ...}
    this.awaitingBaselines = new Map(); // baselineId -> Set<id>
    this.evicting = new Map();      // id -> tick at which the destroy is due
    this.archived = new Set();      // ids this observer has seen destroyed

    // Instance generations: how many times this observer has been sent a
    // create for an id. Every create/destroy/update carries the generation so
    // a stale message can never bind to a newer instance of the same id.
    this.instanceGen = new Map();   // id -> latest generation emitted
    this.instanceLog = [];          // recent per-instance events for tracing

    this.desired = new Map();
    this.desiredSince = new Map(); // id -> tick it first entered interest
    this.destroyedAt = new Map();  // id -> tick its destroy was sent
    this.baselineCounter = 0;
    this.deferred = { creates: 0, updates: 0 };
    this.lastFrame = null;

    this.metrics = {
      framesSent: 0,
      opsSent: 0,
      bytesSent: 0,
      baselinesSent: 0,
      createsSent: 0,
      updatesSent: 0,
      destroysSent: 0,
      recreatedSent: 0,
      crossings: 0,
      budgetSkips: 0,
      baselineRetries: 0,
      baselineFailures: 0,
    };
    this.bytesPerTick = [];
    this.opsPerTick = [];
    this.lastOps = 0;
    this.lastBytes = 0;

    this._autoT = Math.random() * 400;
    this._origin = { ...this.pose };
    this._dir = 1;
  }

  setView(msg) {
    if (Number.isFinite(msg.x)) this.pose.x = msg.x;
    if (Number.isFinite(msg.y)) this.pose.y = msg.y;
    if (Number.isFinite(msg.facing)) this.pose.facing = msg.facing;
    if (msg.view) this.view = normalizeView(msg.view, this.view);
    if (msg.budget) this.budget = normalizeBudget(msg.budget, this.budget);
  }

  togglePin(id, on) {
    if (!on) { this.pins.delete(id); return true; }
    if (this.pins.size >= MAX_PINS) return false;
    if (!this.world.entities.has(id)) return false;
    this.pins.add(id);
    return true;
  }

  interact(id) {
    if (!this.created.has(id) && !this.pendingCreate.has(id)) {
      return { ok: false, reason: 'entity is not replicated to this observer' };
    }
    if (!this.world.flagInteraction(id, this.id)) {
      return { ok: false, reason: 'entity does not accept interaction' };
    }
    this.holds.set(id, this.world.tick + INTERACT_HOLD_TICKS);
    return { ok: true, holdTicks: INTERACT_HOLD_TICKS };
  }

  // A pickup names the instance generation the client is looking at. A stale
  // generation means the client is acting on a replica the server has already
  // torn down, so it must never touch the live item.
  pickup(id, gen) {
    const e = this.world.getEntity(id);
    if (!e || !e._pickable) return { ok: false, reason: 'not-pickable' };
    const rec = this.created.get(id) || this.pendingCreate.get(id);
    if (!rec) return { ok: false, reason: 'not-replicated' };
    if (gen != null && rec.gen !== gen) {
      this._logInstance('pickup-stale', id, gen, `current gen ${rec.gen}`);
      return { ok: false, reason: 'stale-generation', currentGen: rec.gen };
    }
    if (!this.world.claim(id, this.id)) {
      this._logInstance('pickup-denied', id, rec.gen, 'already-claimed');
      return { ok: false, reason: 'already-claimed', gen: rec.gen };
    }
    this.holds.set(id, this.world.tick + INTERACT_HOLD_TICKS);
    this._logInstance('pickup', id, rec.gen, 'claimed');
    return { ok: true, gen: rec.gen };
  }

  _logInstance(op, id, gen, note) {
    this.instanceLog.push({ tick: this.world.tick, op, id, gen, ...(note ? { note } : {}) });
    if (this.instanceLog.length > 120) this.instanceLog.shift();
  }

  ack(baselineId) {
    const ids = this.awaitingBaselines.get(baselineId);
    if (!ids) return false;
    for (const id of ids) {
      const waiting = this.pendingCreate.get(id);
      if (!waiting || waiting.baselineId !== baselineId) continue;
      this.pendingCreate.delete(id);
      this.created.set(id, {
        versionSent: waiting.version,
        xSent: waiting.x,
        ySent: waiting.y,
        stateSent: waiting.stateJSON,
        regionSent: waiting.region,
        gen: waiting.gen,
      });
    }
    this.awaitingBaselines.delete(baselineId);
    return true;
  }

  // ---- autopilot ---------------------------------------------------------
  stepAutopilot() {
    const t = (this._autoT += 1);
    const { width, height } = this.span;
    switch (this.profile) {
      case 'crosser': {
        this.pose.x += 5.5 * this._dir;
        if (this.pose.x > width - 35) { this.pose.x = width - 35; this._dir = -1; }
        if (this.pose.x < 35) { this.pose.x = 35; this._dir = 1; }
        const lane = this._origin.y < height / 2 ? 0.34 : 0.66;
        this.pose.y = height * lane + Math.sin(t * 0.03) * 26;
        this.pose.facing = this._dir > 0 ? 0 : Math.PI;
        break;
      }
      case 'sweeper': {
        const ang = 0.012 * t + this._origin.x * 0.001;
        this.pose.x = width / 2 + Math.cos(ang) * width * 0.33;
        this.pose.y = height / 2 + Math.sin(ang) * height * 0.31;
        this.pose.facing = ang + Math.PI / 2;
        break;
      }
      case 'orbiter': {
        this.pose.x = width * 0.5;
        this.pose.y = height * 0.5;
        this.pose.facing = (0.34 * t) % (Math.PI * 2);
        break;
      }
      case 'snapspinner': {
        // Flips between two opposing looks, holding each for less than the
        // grace window. Everything behind stays in interest grace and keeps
        // its identity, so no object is destroyed and re-created per swing.
        this.pose.x = width * 0.5;
        this.pose.y = height * 0.5;
        const phase = Math.floor(t / 10) % 2;
        this.pose.facing = phase === 0 ? 0 : Math.PI;
        break;
      }
      case 'walker': {
        const base = this._origin.x < width / 2 ? width * 0.28 : width * 0.72;
        this.pose.x = base + Math.sin(t * 0.012) * 20;
        this.pose.y = height / 2 + Math.sin(t * 0.05) * height * 0.33;
        this.pose.facing = Math.cos(t * 0.05) > 0 ? Math.PI / 2 : -Math.PI / 2;
        break;
      }
      default:
        break;
    }
  }

  // ---- reconciliation ----------------------------------------------------
  reconcile(tick) {
    const world = this.world;
    const region = regionIdAt(this.pose.x, this.pose.y);
    if (region !== this.region) {
      this.region = region;
      this.metrics.crossings++;
    }

    const base = queryInterest(world, this.pose, this.view, {
      team: this.team,
      pins: this.pins,
    });

    const desired = new Map();
    const keep = (id, reason, dist) => {
      let entry = desired.get(id);
      if (!entry) {
        entry = { reasons: new Set(), primary: reason, dist };
        desired.set(id, entry);
      }
      entry.reasons.add(reason);
      if (PRIORITY[reason] < PRIORITY[entry.primary]) entry.primary = reason;
    };

    for (const [id, info] of base) {
      this.graceUntil.delete(id);
      for (const reason of info.reasons) keep(id, reason, info.dist);
    }

    // Interaction holds outrank a camera turn.
    for (const [id, until] of this.holds) {
      if (tick > until) { this.holds.delete(id); continue; }
      const e = world.getEntity(id);
      if (!e) { this.holds.delete(id); continue; }
      keep(id, REASON.HOLD, Math.hypot(e.x - this.pose.x, e.y - this.pose.y));
    }

    // Short interest grace for anything this observer already knows about.
    const known = new Set([...this.created.keys(), ...this.pendingCreate.keys()]);
    for (const id of known) {
      if (desired.has(id) || this.holds.has(id)) { this.graceUntil.delete(id); continue; }
      let until = this.graceUntil.get(id);
      if (until == null) { until = tick + GRACE_TICKS; this.graceUntil.set(id, until); }
      if (tick <= until) {
        const e = world.getEntity(id);
        keep(id, REASON.GRACE, e ? Math.hypot(e.x - this.pose.x, e.y - this.pose.y) : Infinity);
      } else {
        this.graceUntil.delete(id);
      }
    }

    // Dependency closure: subscribe ancestors so child references resolve.
    // This runs after grace so a retained child also retains its parent, and
    // the DEP reason is recorded even when the parent was already kept alive
    // for another reason.
    const queue = [...desired.keys()];
    const walked = new Set(queue);
    while (queue.length) {
      const id = queue.pop();
      const e = world.getEntity(id);
      if (!e || !e.parentId) continue;
      const parent = world.getEntity(e.parentId);
      if (!parent) continue;
      keep(parent.id, REASON.DEP,
        Math.hypot(parent.x - this.pose.x, parent.y - this.pose.y));
      if (!walked.has(parent.id)) { walked.add(parent.id); queue.push(parent.id); }
    }

    // A parent that is only wanted as a dependency disappears together with
    // its last wanted descendant.
    for (const id of desired.keys()) {
      if (!this.desired.has(id)) this.desiredSince.set(id, tick);
    }
    for (const id of this.desiredSince.keys()) {
      if (!desired.has(id)) this.desiredSince.delete(id);
    }
    this.desired = desired;

    // Anything known but not desired gets a destroy after grace expires.
    for (const id of known) {
      if (desired.has(id)) { this.evicting.delete(id); continue; }
      if (this.graceUntil.has(id)) continue;
      if (!this.evicting.has(id)) this.evicting.set(id, tick);
    }
    for (const id of [...this.evicting.keys()]) {
      if (desired.has(id)) this.evicting.delete(id);
    }
  }

  // ---- outgoing ----------------------------------------------------------
  emit(tick) {
    const world = this.world;
    const byteBudget = this.budget.bytes;
    const opBudget = this.budget.ops;
    let ops = 0;
    let est = FRAME_OVERHEAD;

    // Destroys are tiny and run first. This is the *only* thing that happens
    // when an observer loses interest; server entities are untouched.
    // Children are released before parents (reverse of creation order) so a
    // client never has to stage a child whose parent is in the same frame.
    // Each destroy names the generation of the instance it retires, so a
    // delayed or replayed destroy cannot bind to a newer incarnation.
    const destroys = [];
    const evictOrder = [...this.evicting.keys()].sort((a, b) => {
      const ea = world.getEntity(a);
      const eb = world.getEntity(b);
      return this.chainDepth(eb) - this.chainDepth(ea);
    });
    for (const id of evictOrder) {
      if (ops >= opBudget || est + 18 > byteBudget) break;
      const rec = this.created.get(id) || this.pendingCreate.get(id);
      const gen = rec ? rec.gen : (this.instanceGen.get(id) || 1);
      destroys.push({ i: id, g: gen });
      est += 18;
      ops++;
    }

    // Creates, parent-first, within budget. A child whose parent was not
    // replicated or is not in this batch is deferred, never sent dangling.
    const candidates = [];
    for (const [id, info] of this.desired) {
      if (this.created.has(id) || this.pendingCreate.has(id) || this.evicting.has(id)) continue;
      const e = world.getEntity(id);
      if (!e) continue;
      candidates.push({ id, info, depth: this.chainDepth(e), dist: info.dist });
    }
    candidates.sort((a, b) =>
      a.depth - b.depth ||
      PRIORITY[a.info.primary] - PRIORITY[b.info.primary] ||
      a.dist - b.dist ||
      (a.id < b.id ? -1 : 1),
    );

    const creates = [];
    const included = new Set();
    for (const cand of candidates) {
      if (ops >= opBudget) break;
      const e = world.getEntity(cand.id);
      if (!e) continue;
      if (e.parentId &&
          !this.created.has(e.parentId) &&
          !included.has(e.parentId) &&
          !this.pendingCreate.has(e.parentId)) {
        continue; // parent filtered by budget: hold the child explicitly
      }
      const payload = world.snapshotEntity(e);
      // Tentative generation, committed only if this create survives trimming
      // and is registered below. A trimmed create leaves no generation gap.
      payload.g = (this.instanceGen.get(cand.id) || 0) + 1;
      const size = JSON.stringify(payload).length + 1;
      if (est + size > byteBudget) continue;
      creates.push(payload);
      included.add(cand.id);
      est += size;
      ops++;
    }

    // Updates, only for entities whose baseline was acknowledged.
    const updates = [];
    const updCandidates = [];
    for (const [id, rec] of this.created) {
      if (this.evicting.has(id)) continue;
      const e = world.getEntity(id);
      if (!e) continue;
      const stateJSON = e.state ? JSON.stringify(e.state) : null;
      const dirtyPos = e.x !== rec.xSent || e.y !== rec.ySent;
      const dirtyState = stateJSON !== rec.stateSent;
      const dirtyRegion = e.region !== rec.regionSent;
      if (e.version === rec.versionSent && !dirtyPos && !dirtyState && !dirtyRegion) continue;
      const info = this.desired.get(id);
      updCandidates.push({
        e, rec, stateJSON, dirtyState, dirtyRegion,
        priority: info ? PRIORITY[info.primary] : 9,
        dist: info ? info.dist : Infinity,
      });
    }
    updCandidates.sort((a, b) =>
      a.priority - b.priority || a.dist - b.dist || (a.e.id < b.e.id ? -1 : 1),
    );
    for (const cand of updCandidates) {
      if (ops >= opBudget) break;
      const u = { i: cand.e.id, v: cand.e.version, x: cand.e.x, y: cand.e.y, n: cand.rec.gen };
      if (cand.dirtyState) u.s = cand.e.state;
      if (cand.dirtyRegion) u.g = cand.e.region;
      const size = JSON.stringify(u).length + 1;
      if (est + size > byteBudget) continue;
      updates.push(u);
      est += size;
      ops++;
      cand.rec.versionSent = cand.e.version;
      cand.rec.xSent = cand.e.x;
      cand.rec.ySent = cand.e.y;
      cand.rec.stateSent = cand.stateJSON;
      cand.rec.regionSent = cand.e.region;
    }

    const frame = {
      t: 'f',
      k: tick,
      p: { x: round1(this.pose.x), y: round1(this.pose.y), f: round2(this.pose.facing) },
    };
    if (destroys.length) frame.d = destroys;
    if (creates.length) frame.c = creates;
    if (updates.length) frame.u = updates;

    const heartbeat = tick % 10 === 0;
    const idle = !frame.d && !frame.c && !frame.u;

    // Assign the baseline id *before* serialising, so the id the client acks
    // is actually on the wire. Creates are trimmed afterwards; if none
    // survive, the id is withdrawn below.
    let baselineId = null;
    if (frame.c) {
      baselineId = `b${this.id}-${++this.baselineCounter}`;
      frame.b = baselineId;
    }

    // Serialise with hard trimming. Updates are shed first, then a
    // parent-closed suffix of creates. Registration happens only after the
    // final frame is known, so an ack can never cover an unsent create.
    let payload = JSON.stringify(frame);
    while (payload.length > byteBudget && frame.u && frame.u.length) {
      frame.u.pop();
      payload = JSON.stringify(frame);
    }
    while (payload.length > byteBudget) {
      const last = frame.c && frame.c[frame.c.length - 1];
      if (!last) break;
      const referenced = frame.c.some((x) => x.parentId === last.id);
      if (referenced) break;
      frame.c.pop();
      payload = JSON.stringify(frame);
    }
    if (frame.u && !frame.u.length) delete frame.u;
    if (frame.c && !frame.c.length) delete frame.c;
    if (!frame.c || !frame.c.length) {
      delete frame.b;
      baselineId = null;
      if (frame.c) delete frame.c;
      payload = JSON.stringify(frame);
    }

    if (frame.c) {
      const ids = new Set();
      for (const payloadEntity of frame.c) {
        const e = world.getEntity(payloadEntity.id);
        const recreated = this.archived.delete(payloadEntity.id);
        if (recreated) this.metrics.recreatedSent++;
        this.instanceGen.set(payloadEntity.id, payloadEntity.g);
        this._logInstance(recreated ? 'recreate' : 'create', payloadEntity.id, payloadEntity.g);
        this.pendingCreate.set(payloadEntity.id, {
          baselineId,
          sentTick: tick,
          retries: 0,
          gen: payloadEntity.g,
          version: e.version,
          stateJSON: e.state ? JSON.stringify(e.state) : null,
          region: e.region,
          x: e.x,
          y: e.y,
        });
        ids.add(payloadEntity.id);
      }
      this.awaitingBaselines.set(baselineId, ids);
      this.metrics.baselinesSent++;
      this.metrics.createsSent += frame.c.length;
    }

    for (const ref of destroys) {
      const id = ref.i;
      this.created.delete(id);
      this.pendingCreate.delete(id);
      this.evicting.delete(id);
      this.graceUntil.delete(id);
      this.archived.add(id);
      this.destroyedAt.set(id, tick);
      this.metrics.destroysSent++;
      this._logInstance('destroy', id, ref.g);
    }
    if (this.destroyedAt.size > 400) {
      for (const id of [...this.destroyedAt.keys()].slice(0, 200)) this.destroyedAt.delete(id);
    }
    // Drop ack bookkeeping for ids that were destroyed before acking.
    if (destroys.length) {
      const ids = destroys.map((ref) => ref.i);
      for (const [bid, idSet] of this.awaitingBaselines) {
        for (const id of ids) idSet.delete(id);
        if (!idSet.size) this.awaitingBaselines.delete(bid);
      }
    }

    this.metrics.updatesSent += frame.u ? frame.u.length : 0;

    const bytes = Buffer.byteLength(payload);
    this.lastBytes = bytes;
    this.lastOps = ops;
    if (!idle || heartbeat) {
      this.send(payload);
      this.metrics.framesSent++;
      this.metrics.bytesSent += bytes;
      this.metrics.opsSent += ops;
      this.bytesPerTick.push(bytes);
      this.opsPerTick.push(ops);
      if (this.bytesPerTick.length > 150) this.bytesPerTick.shift();
      if (this.opsPerTick.length > 150) this.opsPerTick.shift();
      this.lastFrame = {
        tick,
        bytes,
        ops,
        creates: frame.c ? frame.c.length : 0,
        updates: frame.u ? frame.u.length : 0,
        destroys: frame.d ? frame.d.length : 0,
        baseline: baselineId,
      };
    }

    this.deferred = {
      creates: Math.max(0, candidates.length - creates.length),
      updates: Math.max(0, updCandidates.length - (frame.u ? frame.u.length : 0)),
    };
    this.metrics.budgetSkips += this.deferred.creates + this.deferred.updates;

    this.retryBaselines(tick);
  }

  retryBaselines(tick) {
    let sent = 0;
    for (const [id, pending] of [...this.pendingCreate]) {
      if (sent >= MAX_RETRY_FRAMES_PER_TICK) break;
      if (tick - pending.sentTick < BASELINE_RETRY_TICKS) continue;
      if (!this.desired.has(id)) continue;
      if (pending.retries >= MAX_BASELINE_RETRIES) {
        this.metrics.baselineFailures++;
        continue;
      }
      const e = this.world.getEntity(id);
      if (!e) continue;
      if (e.parentId && !this.created.has(e.parentId) && !this.pendingCreate.has(e.parentId)) {
        continue; // wait for the parent baseline first
      }
      // Retire the old ack slot.
      const old = this.awaitingBaselines.get(pending.baselineId);
      if (old) {
        old.delete(id);
        if (!old.size) this.awaitingBaselines.delete(pending.baselineId);
      }
      const baselineId = `b${this.id}-${++this.baselineCounter}`;
      const payloadEntity = this.world.snapshotEntity(e);
      payloadEntity.g = pending.gen;
      pending.baselineId = baselineId;
      pending.sentTick = tick;
      pending.retries++;
      pending.version = e.version;
      pending.x = e.x;
      pending.y = e.y;
      pending.stateJSON = e.state ? JSON.stringify(e.state) : null;
      pending.region = e.region;
      this.awaitingBaselines.set(baselineId, new Set([id]));
      this._logInstance('create-retry', id, pending.gen);
      const retryFrame = {
        t: 'f', k: tick, b: baselineId, c: [payloadEntity],
        r: 1, p: { x: round1(this.pose.x), y: round1(this.pose.y), f: round2(this.pose.facing) },
      };
      this.send(JSON.stringify(retryFrame));
      this.metrics.baselineRetries++;
      this.metrics.framesSent++;
      sent++;
    }
  }

  chainDepth(entity) {
    let depth = 0;
    let cur = entity;
    const seen = new Set();
    while (cur && cur.parentId && !seen.has(cur.id)) {
      seen.add(cur.id);
      cur = this.world.getEntity(cur.parentId);
      if (!cur) break;
      depth++;
    }
    return depth;
  }

  telemetry() {
    const counts = {
      near: 0, cone: 0, 'team-link': 0, pinned: 0,
      'interaction-hold': 0, 'interest-grace': 0, dependency: 0,
    };
    const reasons = [];
    for (const [id, info] of (this.desired || [])) {
      for (const r of info.reasons) if (counts[r] != null) counts[r]++;
      reasons.push({
        id,
        primary: info.primary,
        reasons: [...info.reasons].sort((a, b) => PRIORITY[a] - PRIORITY[b]),
        dist: round1(info.dist),
      });
    }
    reasons.sort((a, b) => PRIORITY[a.primary] - PRIORITY[b.primary] || a.id.localeCompare(b.id));
    const avg = (arr) => (arr.length ? Math.round((arr.reduce((a, b) => a + b, 0) / arr.length) * 10) / 10 : 0);
    return {
      id: this.id,
      name: this.name,
      mode: this.mode,
      profile: this.profile,
      team: this.team,
      pose: { x: round1(this.pose.x), y: round1(this.pose.y), facing: round2(this.pose.facing) },
      region: this.region,
      view: this.view,
      budget: this.budget,
      subscribed: this.desired ? this.desired.size : 0,
      reasons,
      counts,
      replicated: this.created.size,
      inFlight: this.pendingCreate.size,
      pinned: [...this.pins],
      instanceLog: this.instanceLog.slice(-40),
      metrics: {
        ...this.metrics,
        bytesPerTickAvg: avg(this.bytesPerTick),
        opsPerTickAvg: avg(this.opsPerTick),
        lastBytes: this.lastBytes,
        lastOps: this.lastOps,
        deferred: this.deferred,
        lastFrame: this.lastFrame,
      },
    };
  }
}

function round1(v) { return Math.round(v * 10) / 10; }
function round2(v) { return Math.round(v * 100) / 100; }
