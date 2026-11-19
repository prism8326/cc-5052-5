import { test } from 'node:test';
import assert from 'node:assert/strict';

import { World } from '../server/world.js';
import { ObserverSession, queryInterest, normalizeView, normalizeBudget } from '../server/session.js';
import { ClientScene } from '../client/scene.js';
import { REASON, DEFAULT_VIEW, DEFAULT_BUDGET, GRACE_TICKS, WORLD } from '../shared/protocol.js';

function makeWorld() {
  return new World(1234);
}

function makePair(world, opts = {}) {
  const scene = new ClientScene();
  const sent = [];
  const session = new ObserverSession({
    world,
    span: { width: WORLD.width, height: WORLD.height },
    id: 'obs-t',
    name: 'test',
    mode: 'virtual',
    profile: null,
    team: opts.team || null,
    view: normalizeView(opts.view, DEFAULT_VIEW),
    budget: normalizeBudget(opts.budget, DEFAULT_BUDGET),
    spawn: opts.spawn || { x: 40, y: 40 },
    send: (payload) => {
      sent.push(payload);
      const frame = JSON.parse(payload);
      const result = scene.applyFrame(frame);
      if (result.ack) session.ack(result.ack);
    },
  });
  return { scene, session, sent };
}

function run(session, ticks) {
  for (let i = 0; i < ticks; i++) {
    session.world.step();
    session.reconcile(session.world.tick);
    session.emit(session.world.tick);
  }
}

test('interest query honours near radius, cone and declared team links', () => {
  const world = makeWorld();
  // Place the observer at the centre of region R1-1 facing east.
  const pose = { x: 140 + 70, y: 120 + 60, facing: 0 };
  const view = { radius: 120, halfAngle: Math.PI / 4, nearRadius: 30 };
  const all = queryInterest(world, pose, view, {});
  assert.ok(all.size > 0);
  for (const [id, info] of all) {
    const e = world.getEntity(id);
    const d = Math.hypot(e.x - pose.x, e.y - pose.y);
    if (info.reasons.includes(REASON.NEAR)) assert.ok(d <= view.nearRadius + 0.001);
    else {
      assert.ok(d <= view.radius + 0.001);
      const ang = Math.acos(
        ((e.x - pose.x) * Math.cos(pose.facing) + (e.y - pose.y) * Math.sin(pose.facing)) / d,
      );
      assert.ok(ang <= view.halfAngle + 1e-6);
    }
  }

  // A team member far behind the observer must still be included by declaration.
  const npc = [...world.entities.values()].find((e) => e.kind === 'npc');
  npc.team = 'test-team';
  const npcPos = { x: npc.x, y: npc.y };
  const farPose = {
    x: npcPos.x - 400 > 0 ? npcPos.x - 400 : 5,
    y: npcPos.y,
    facing: Math.PI, // facing away
  };
  const withTeam = queryInterest(world, farPose, view, { team: 'test-team' });
  assert.ok(withTeam.has(npc.id), 'declared team link must survive distance');
  assert.ok(withTeam.get(npc.id).reasons.includes(REASON.TEAM));
});

test('dependency closure subscribes parents and creates are parent-first', () => {
  const world = makeWorld();
  const child = [...world.entities.values()].find((e) => e.parentId);
  assert.ok(child, 'world should contain child entities');
  const parent = world.getEntity(child.parentId);
  // Stand right on the child with a tiny view, so only the child is positional.
  const { scene, session, sent } = makePair(world, {
    view: { radius: 12, halfAngle: 0.4, nearRadius: 8 },
    spawn: { x: child.x, y: child.y },
  });
  run(session, 2);

  assert.ok(session.desired.has(child.id));
  assert.ok(session.desired.has(parent.id), 'parent must be pulled in as a dependency');
  assert.ok(session.desired.get(parent.id).reasons.has(REASON.DEP));
  assert.ok(scene.entities.has(parent.id));
  assert.ok(scene.entities.has(child.id));

  const firstFrameWithChild = sent
    .map((p) => JSON.parse(p))
    .find((f) => f.c && f.c.some((e) => e.id === child.id));
  const idxParent = firstFrameWithChild.c.findIndex((e) => e.id === parent.id);
  const idxChild = firstFrameWithChild.c.findIndex((e) => e.id === child.id);
  assert.ok(idxParent >= 0, 'parent must be in the same baseline batch');
  assert.ok(idxParent < idxChild, 'parent must precede the child in the batch');
  assert.equal(scene.staged.size, 0);
});

test('delta arriving before its baseline is never applied', () => {
  const scene = new ClientScene();
  const payload = {
    id: 'E001', kind: 'crate', name: 'x', x: 1, y: 1,
    region: 'R0-0', team: null, parentId: null, state: null, version: 3,
  };
  scene._applyUpdates([{ i: 'E001', v: 4, x: 9, y: 9 }], []);
  assert.equal(scene.entities.size, 0, 'no object without a baseline');
  assert.equal(scene.stats.orphanUpdates, 1);

  // Baseline arrives; now update applies.
  scene.applyFrame({ t: 'f', k: 1, b: 'b1', c: [payload] });
  assert.equal(scene.entities.get('E001').x, 1);
  scene._applyUpdates([{ i: 'E001', v: 4, x: 9, y: 9 }], []);
  assert.equal(scene.entities.get('E001').x, 9);
});

test('a child whose parent baseline is missing is staged, not half-built', () => {
  const scene = new ClientScene();
  const child = {
    id: 'E100', kind: 'valve', name: 'v', x: 5, y: 5,
    region: 'R0-0', team: null, parentId: 'E099', state: null, version: 0,
  };
  scene.applyFrame({ t: 'f', k: 1, b: 'b1', c: [child] });
  assert.equal(scene.entities.size, 0);
  assert.equal(scene.staged.size, 1);
  assert.equal(scene.staged.get('E100').missing, 'E099');

  // A delta for the staged child is not adopted into a displayed object.
  scene.applyFrame({ t: 'f', k: 2, u: [{ i: 'E100', v: 1, x: 7, y: 7 }] });
  assert.equal(scene.entities.size, 0);
  assert.equal(scene.stats.updatesForStaged, 1);

  const parent = {
    id: 'E099', kind: 'rig', name: 'p', x: 0, y: 0,
    region: 'R0-0', team: null, parentId: null, state: null, version: 0,
  };
  scene.applyFrame({ t: 'f', k: 3, b: 'b2', c: [parent] });
  assert.equal(scene.staged.size, 0);
  assert.equal(scene.entities.size, 2);
  assert.equal(scene.entities.get('E100').parent, scene.entities.get('E099'));
});

test('destroy of a parent re-stages its children with an explicit missing ref', () => {
  const scene = new ClientScene();
  const parent = {
    id: 'E010', kind: 'rig', name: 'p', x: 0, y: 0,
    region: 'R0-0', team: null, parentId: null, state: null, version: 0,
  };
  const child = {
    id: 'E011', kind: 'valve', name: 'v', x: 1, y: 1,
    region: 'R0-0', team: null, parentId: 'E010', state: null, version: 0,
  };
  scene.applyFrame({ t: 'f', k: 1, b: 'b1', c: [parent, child] });
  assert.equal(scene.entities.size, 2);
  scene.applyFrame({ t: 'f', k: 2, d: ['E010'] });
  assert.equal(scene.entities.size, 0);
  assert.equal(scene.staged.get('E011').missing, 'E010');
  assert.equal(scene.staged.get('E011').reason, 'parent-destroyed');
});

test('entity identity survives updates, grace and re-entry', () => {
  const world = makeWorld();
  const child = [...world.entities.values()].find((e) => e.parentId);
  const { scene, session } = makePair(world, {
    view: { radius: 70, halfAngle: 1.2, nearRadius: 20 },
    spawn: { x: child.x, y: child.y },
  });
  run(session, 3);
  const ref = scene.entities.get(child.id);
  assert.ok(ref, 'child should be built');

  // Move far away until the replica drops it, then return.
  session.pose.x = 20;
  session.pose.y = 20;
  run(session, 2);
  session.pose.x = child.x;
  session.pose.y = child.y;
  run(session, 2);
  const ref2 = scene.entities.get(child.id);
  assert.ok(ref2, 'child should be rebuilt on re-entry');
  // A destroy + recreate is expected across a full exit, but the *id* and
  // parent reference must remain explainable.
  assert.equal(ref2.id, child.id);
  assert.ok(scene.entities.has(ref2.parentId));
});

test('camera spins do not recreate entities that stay subscribed', () => {
  const world = makeWorld();
  const { scene, session, sent } = makePair(world, {
    view: { radius: 150, halfAngle: Math.PI, nearRadius: 60 },
    spawn: { x: WORLD.width / 2, y: WORLD.height / 2 },
  });
  run(session, 3);
  const baselineCreates = scene.stats.createsApplied;
  const objects = new Map([...scene.entities.entries()]);

  for (let i = 0; i < 40; i++) {
    session.pose.facing += 0.7;
    run(session, 1);
  }

  const victims = [];
  for (const [id, obj] of objects) {
    if (!scene.entities.has(id)) continue;
    if (scene.entities.get(id) !== obj) victims.push(id);
  }
  assert.deepEqual(victims, [], 'no subscribed entity object may be rebuilt by turning');
  // At most the entities that genuinely left the 360° near/radius set churn.
  assert.ok(scene.stats.createsApplied < baselineCreates * 2);
  assert.ok(scene.entities.size > 0);
});

test('region boundary crossings produce adds and removes, never a global reset', () => {
  const world = makeWorld();
  const { scene, session } = makePair(world, {
    view: { radius: 90, halfAngle: Math.PI / 3, nearRadius: 20 },
    spawn: { x: 40, y: WORLD.height * 0.34 },
  });
  const seen = new Set();
  const statsBefore = { ...scene.stats };
  session.pose.facing = 0;
  for (let i = 0; i < 200; i++) {
    session.pose.x = 35 + (i * 2.6) % (WORLD.width - 70);
    run(session, 1);
    for (const id of scene.entities.keys()) seen.add(id);
  }
  assert.ok(session.metrics.crossings >= 2, 'observer should cross region boundaries');
  assert.ok(seen.size > 10, 'multiple regions should have been visited');
  // Never more than the whole world worth of replicas at once.
  assert.ok(scene.entities.size < world.entities.size);
  assert.equal(scene.report().unresolvedRefs.length, 0);
});

test('network budget caps per-frame work and defers the rest', () => {
  const world = makeWorld();
  const { session, sent } = makePair(world, {
    view: { radius: 300, halfAngle: Math.PI, nearRadius: 80 },
    spawn: { x: WORLD.width / 2, y: WORLD.height / 2 },
    budget: { bytes: 700, ops: 6 },
  });
  run(session, 30);
  for (const raw of sent) {
    const frame = JSON.parse(raw);
    if (frame.t !== 'f') continue;
    const ops = (frame.c?.length || 0) + (frame.u?.length || 0) + (frame.d?.length || 0);
    assert.ok(Buffer.byteLength(raw) <= 700 + 40, `frame ${Buffer.byteLength(raw)}B budget`);
    assert.ok(ops <= 6, `frame has ${ops} ops`);
  }
  assert.ok(session.metrics.budgetSkips > 0, 'budget should have deferred work');
  // Eventually everything desired is replicated despite the small budget.
  run(session, 200);
  assert.ok(session.created.size >= session.desired.size - session.pendingCreate.size);
});

test('unacknowledged baselines are retried and updates stay withheld', () => {
  const world = makeWorld();
  const sent = [];
  const session = new ObserverSession({
    world,
    span: { width: WORLD.width, height: WORLD.height },
    id: 'obs-nack',
    name: 'nack',
    mode: 'virtual',
    team: null,
    view: normalizeView({ radius: 70, halfAngle: 1.2, nearRadius: 30 }, DEFAULT_VIEW),
    budget: normalizeBudget(null, DEFAULT_BUDGET),
    spawn: { x: 100, y: 100 },
    send: (payload) => sent.push(JSON.parse(payload)),
  });
  run(session, 4);
  assert.ok(session.pendingCreate.size > 0);
  assert.equal(session.created.size, 0, 'nothing is replicated before ack');
  const updatesBefore = sent.flatMap((f) => f.u || []).length;
  assert.equal(updatesBefore, 0, 'no delta before baseline ack');

  run(session, 20);
  assert.ok(session.metrics.baselineRetries > 0, 'baseline retries should happen');
});

test('leaving interest destroys only the replica; server entities persist', () => {
  const world = makeWorld();
  const worldCount = world.entities.size;
  const { scene, session } = makePair(world, {
    view: { radius: 80, halfAngle: 1.1, nearRadius: 25 },
    spawn: { x: 100, y: 100 },
  });
  run(session, 4);
  assert.ok(scene.entities.size > 0);
  const builtIds = [...scene.entities.keys()];

  session.pose.x = 520;
  session.pose.y = 340;
  session.pose.facing = 0;
  run(session, GRACE_TICKS + 4);

  for (const id of builtIds) assert.ok(world.entities.has(id), `${id} must still exist server-side`);
  assert.equal(world.entities.size, worldCount);
  assert.equal(session.metrics.destroysSent > 0, true);
});

test('interaction hold keeps an object subscribed through a camera turn', () => {
  const world = makeWorld();
  const interactive = [...world.entities.values()].find((e) => e._interactive);
  const { session } = makePair(world, {
    view: { radius: 60, halfAngle: 0.5, nearRadius: 18 },
    spawn: { x: interactive.x, y: interactive.y },
  });
  run(session, 3);
  assert.ok(session.created.has(interactive.id));
  const result = session.interact(interactive.id);
  assert.equal(result.ok, true);

  session.pose.facing = Math.PI; // face completely away
  session.pose.x -= 20;
  run(session, 5);
  assert.ok(session.desired.has(interactive.id), 'hold must survive the turn');
  assert.ok(session.desired.get(interactive.id).reasons.has(REASON.HOLD));
});

test('stale delta versions are ignored by the client', () => {
  const scene = new ClientScene();
  scene.applyFrame({
    t: 'f', k: 1, b: 'b1',
    c: [{ id: 'E1', kind: 'npc', name: 'n', x: 0, y: 0, region: 'R0-0', team: null, parentId: null, state: null, version: 5 }],
  });
  scene.applyFrame({ t: 'f', k: 2, u: [{ i: 'E1', v: 4, x: 99, y: 99 }] });
  assert.equal(scene.entities.get('E1').x, 0);
  assert.equal(scene.stats.staleUpdates, 1);
});

test('a budget too small for a child keeps it out until its parent fits, never dangling', () => {
  const world = makeWorld();
  // Find a child with a parent, and aim an extremely small budget at it.
  const child = [...world.entities.values()].find((e) => e.parentId);
  const parent = world.getEntity(child.parentId);
  const scene = new ClientScene();
  const frames = [];
  const session = new ObserverSession({
    world,
    span: { width: WORLD.width, height: WORLD.height },
    id: 'obs-tiny', name: 'tiny', mode: 'virtual',
    profile: null, team: null,
    view: normalizeView({ radius: 40, halfAngle: 1.4, nearRadius: 16 }, DEFAULT_VIEW),
    budget: normalizeBudget({ bytes: 320, ops: 2 }, DEFAULT_BUDGET),
    spawn: { x: parent.x, y: parent.y },
    send: (payload) => {
      const frame = JSON.parse(payload);
      frames.push(frame);
      const r = scene.applyFrame(frame);
      if (r.ack) session.ack(r.ack);
    },
  });
  for (let i = 0; i < 60; i++) {
    world.step();
    session.reconcile(world.tick);
    session.emit(world.tick);
  }
  for (const frame of frames) {
    if (!frame.c) continue;
    const ids = new Set(frame.c.map((e) => e.id));
    for (const e of frame.c) {
      if (e.parentId) {
        const parentKnown = ids.has(e.parentId) || scene.entities.has(e.parentId);
        assert.ok(parentKnown, `create of ${e.id} must not precede its parent`);
      }
    }
  }
  // Whatever did get created must be fully resolvable.
  assert.equal(scene.report().unresolvedRefs.length, 0);
  // The tiny budget must have deferred something.
  assert.ok(session.metrics.budgetSkips > 0);
});
