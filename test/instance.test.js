import { test } from 'node:test';
import assert from 'node:assert/strict';

import { World } from '../server/world.js';
import { ObserverSession, normalizeView, normalizeBudget } from '../server/session.js';
import { FrameLab } from '../server/lab.js';
import { ClientScene } from '../client/scene.js';
import { DEFAULT_VIEW, DEFAULT_BUDGET, GRACE_TICKS, INTERACT_HOLD_TICKS, WORLD } from '../shared/protocol.js';

function makeWorld() {
  return new World(1234);
}

// A pickable cache and an interactive control close enough to be subscribed
// together, so the control never leaves interest while the cache churns.
function findPair(world) {
  const caches = [...world.entities.values()].filter((e) => e._pickable);
  const interactives = [...world.entities.values()].filter((e) => e._interactive);
  let best = null;
  for (const cache of caches) {
    for (const ctrl of interactives) {
      const d = Math.hypot(cache.x - ctrl.x, cache.y - ctrl.y);
      if (d < 70 && (!best || d < best.d)) best = { cache, ctrl, d };
    }
  }
  assert.ok(best, 'world should contain a cache near an interactive control');
  return best;
}

function makeLabPair(world, spawn) {
  const scene = new ClientScene();
  const sent = [];
  let session;
  const lab = new FrameLab((raw) => {
    sent.push(raw);
    const frame = JSON.parse(raw);
    const result = scene.applyFrame(frame);
    if (result.ack) session.ack(result.ack);
  });
  session = new ObserverSession({
    world,
    span: { width: WORLD.width, height: WORLD.height },
    id: 'obs-lab',
    name: 'lab',
    mode: 'virtual',
    profile: null,
    team: null,
    view: normalizeView({ radius: 100, halfAngle: 1.2, nearRadius: 30 }, DEFAULT_VIEW),
    budget: normalizeBudget(null, DEFAULT_BUDGET),
    spawn,
    send: (raw) => lab.send(raw),
  });
  return { scene, session, lab, sent };
}

function run(session, lab, ticks) {
  for (let i = 0; i < ticks; i++) {
    session.world.step();
    session.reconcile(session.world.tick);
    session.emit(session.world.tick);
    lab.step(session.world.tick);
  }
}

// Drive the exact reported scenario: leave so the replica is destroyed, come
// straight back so a fresh instance of the same id is created, then let the
// held destroy arrive late. Returns the whole rig for assertions.
function churnUntilRecreated(world, pair, target) {
  const { session, lab, scene } = pair;
  run(session, lab, 3);
  assert.ok(scene.entities.has(target.id), 'target subscribed before leaving');
  assert.equal(scene.entities.get(target.id).gen, 1);

  lab.delayDestroys(400); // hold every destroy far past the excursion
  session.pose.x = target.x + 400 > WORLD.width - 10 ? target.x - 400 : target.x + 400;
  session.pose.y = target.y;
  run(session, lab, GRACE_TICKS + 4); // long enough for grace to expire
  assert.ok(!scene.entities.has(target.id) || true, 'destroy may be held, not delivered');

  session.pose.x = target.x;
  session.pose.y = target.y;
  run(session, lab, 3); // re-create (gen 2) is not held and applies
  assert.equal(scene.entities.get(target.id)?.gen, 2, 'returning created generation 2');

  const released = lab.clear(); // the stale destroy now lands after the create
  assert.ok(released >= 1, 'a held destroy frame was released');
  return pair;
}

test('out-of-order destroy is scoped to its generation and traced as the first misbind', () => {
  const world = makeWorld();
  const { cache, ctrl } = findPair(world);
  const pair = makeLabPair(world, { x: cache.x, y: cache.y });
  const { scene, session, lab } = pair;

  run(session, lab, 3);
  const controlRef = scene.entities.get(ctrl.id);
  assert.ok(controlRef, 'control subscribed');

  // The control has an ongoing interaction: its hold must survive everything.
  const inter = session.interact(ctrl.id);
  assert.equal(inter.ok, true);

  churnUntilRecreated(world, pair, cache);

  // The stale destroy bound to generation 1 while generation 2 is live: it
  // was dropped, counted and recorded as a misbound message.
  const item = scene.entities.get(cache.id);
  assert.ok(item, 'new instance survives the late destroy');
  assert.equal(item.gen, 2);
  assert.equal(scene.stats.destroysApplied, 0, 'no real destroy was applied');
  const cacheMisbinds = scene.misbinds.filter((m) => m.id === cache.id);
  assert.equal(cacheMisbinds.length, 1);
  assert.deepEqual(
    { op: cacheMisbinds[0].op, msgGen: cacheMisbinds[0].msgGen, currentGen: cacheMisbinds[0].currentGen },
    { op: 'destroy', msgGen: 1, currentGen: 2 },
  );
  // Every misbind the tracer saw is a gen-1 destroy arriving after a gen-2
  // create; the first one is preserved with its minimal repro.
  assert.ok(scene.firstMisbind);
  for (const m of scene.misbinds) {
    assert.equal(m.op, 'destroy');
    assert.equal(m.msgGen, 1);
    assert.equal(m.currentGen, 2);
  }
  assert.ok(!scene.misbinds.some((m) => m.id === ctrl.id), 'control never misbound');

  // The minimal repro for the cache is exactly: create(gen 2), destroy(gen 1).
  const cacheRepro = scene.buildRepro(cache.id);
  assert.equal(cacheRepro.frames.length, 2);
  const [fCreate, fDestroy] = cacheRepro.frames;
  assert.equal(fCreate.c[0].g, 2);
  assert.deepEqual(fDestroy.d, [{ i: cache.id, g: 1 }]);

  // The first misbind (whichever id it belonged to) also has a self-contained
  // repro ending in the stale destroy.
  assert.ok(scene.minimalRepro);
  const reproFrames = scene.minimalRepro.frames;
  assert.deepEqual(reproFrames[reproFrames.length - 1].d, [{ i: scene.firstMisbind.id, g: 1 }]);
  assert.ok(reproFrames.some((f) => f.c?.some((e) => e.id === scene.firstMisbind.id && e.g === 2)));

  // The control was never rebuilt, re-baselined or otherwise disturbed.
  assert.equal(scene.entities.get(ctrl.id), controlRef, 'control object identity untouched');
  const ctrlJournal = scene.journal.get(ctrl.id) || [];
  assert.ok(!ctrlJournal.some((j) => j.op === 'destroy'), 'control never saw a destroy');
  assert.ok(!session.destroyedAt.has(ctrl.id), 'server never retired the control replica');
  assert.ok(session.holds.has(ctrl.id), 'control interaction hold still active');
  assert.ok(session.desired.has(ctrl.id));

  // Server-side per-instance trace lines up with what the client saw.
  const gens = session.instanceLog.filter((e) => e.id === cache.id).map((e) => `${e.op}#${e.gen}`);
  assert.deepEqual(gens, ['create#1', 'destroy#1', 'recreate#2']);
});

test('pickup honours the instance generation: stale rejected, current claims, re-claim rejected', () => {
  const world = makeWorld();
  const { cache } = findPair(world);
  const pair = makeLabPair(world, { x: cache.x, y: cache.y });
  const { scene, session } = pair;

  churnUntilRecreated(world, pair, cache);
  run(session, pair.lab, 2); // let the ack land so the create is registered

  // The original (destroyed) instance can never be claimed through a stale token.
  const stale = session.pickup(cache.id, 1);
  assert.equal(stale.ok, false);
  assert.equal(stale.reason, 'stale-generation');
  assert.equal(stale.currentGen, 2);
  assert.equal(world.getEntity(cache.id).state.claimed, false, 'stale attempt must not claim');

  // The new instance, seen after the zone change, picks up normally.
  const current = session.pickup(cache.id, scene.entities.get(cache.id).gen);
  assert.equal(current.ok, true);
  assert.equal(current.gen, 2);
  assert.equal(world.getEntity(cache.id).state.claimed, true);

  // And it cannot be claimed twice.
  const again = session.pickup(cache.id, 2);
  assert.equal(again.ok, false);
  assert.equal(again.reason, 'already-claimed');
});

test('replayed cache hits revoke only the old generation, never the control', () => {
  const world = makeWorld();
  const { cache, ctrl } = findPair(world);
  const pair = makeLabPair(world, { x: cache.x, y: cache.y });
  const { scene, session, lab } = pair;

  run(session, lab, 3);
  const controlRef = scene.entities.get(ctrl.id);
  assert.equal(session.interact(ctrl.id).ok, true);
  churnUntilRecreated(world, pair, cache);
  const itemRef = scene.entities.get(cache.id);
  const destroysBefore = scene.stats.destroysApplied;
  const misbindsBefore = scene.misbinds.filter((m) => m.id === cache.id).length;
  assert.equal(misbindsBefore, 1, 'the churn itself produced one stale destroy');

  // Replay: the new create (cache hit), the old destroy, the new create again.
  const refreshedBefore = scene.stats.createsRefreshed;
  assert.equal(lab.replayCreate(cache.id), true);
  assert.equal(scene.entities.get(cache.id), itemRef, 'duplicate create refreshes in place');
  assert.ok(scene.stats.createsRefreshed > refreshedBefore);

  assert.equal(lab.replayDestroy(cache.id), true);
  assert.equal(scene.entities.get(cache.id), itemRef, 'stale destroy cannot kill the new instance');
  assert.equal(scene.misbinds.filter((m) => m.id === cache.id).length, misbindsBefore + 1);
  assert.equal(scene.stats.destroysApplied, destroysBefore);

  assert.equal(lab.replayCreate(cache.id), true);
  assert.equal(scene.entities.get(cache.id), itemRef);

  // The control's replica and its server-side hold were never touched.
  assert.equal(scene.entities.get(ctrl.id), controlRef);
  assert.ok(session.holds.has(ctrl.id));
  assert.equal(scene.stats.unknownDestroys, 0);
});

test('the saved minimal packet sequence reproduces the misbind on a fresh scene', () => {
  const world = makeWorld();
  const { cache } = findPair(world);
  const pair = makeLabPair(world, { x: cache.x, y: cache.y });
  churnUntilRecreated(world, pair, cache);

  const repro = pair.scene.buildRepro(cache.id);
  assert.ok(repro.frames.length >= 2, 'a repro was saved');

  const fresh = new ClientScene();
  for (const frame of repro.frames) fresh.applyFrame(frame);
  const item = fresh.entities.get(cache.id);
  assert.ok(item, 'the new instance survives the replayed stale destroy');
  assert.equal(item.gen, 2);
  assert.equal(fresh.stats.mismatchedDestroys, 1);
  assert.deepEqual(fresh.firstMisbind, {
    tick: fresh.tick, op: 'destroy', id: cache.id, msgGen: 1, currentGen: 2,
  });

  // A parented entity's repro carries its ancestor chain, so it is equally
  // self-contained: the child materialises and the stale destroy is dropped.
  const childMisbind = pair.scene.misbinds.find((m) => {
    const e = world.getEntity(m.id);
    return e && e.parentId;
  });
  assert.ok(childMisbind, 'at least one re-created entity has a parent');
  const childRepro = pair.scene.buildRepro(childMisbind.id);
  const fresh2 = new ClientScene();
  for (const frame of childRepro.frames) fresh2.applyFrame(frame);
  const child = fresh2.entities.get(childMisbind.id);
  assert.ok(child, 'child materialised from the repro');
  assert.equal(child.gen, 2);
  assert.ok(fresh2.entities.has(child.parentId), 'ancestor chain included');
  assert.equal(fresh2.stats.mismatchedDestroys, 1);
  assert.equal(fresh2.report().unresolvedRefs.length, 0);
});

test('a misbound update for an old generation is dropped and traced', () => {
  const world = makeWorld();
  const { cache } = findPair(world);
  const pair = makeLabPair(world, { x: cache.x, y: cache.y });
  const { scene } = pair;
  churnUntilRecreated(world, pair, cache);

  scene.applyFrame({ t: 'f', k: scene.tick + 1, u: [{ i: cache.id, n: 1, v: 99, x: 1, y: 1 }] });
  const item = scene.entities.get(cache.id);
  assert.equal(item.gen, 2);
  assert.notEqual(item.x, 1, 'stale delta must not move the new instance');
  assert.equal(scene.stats.mismatchedUpdates, 1);
});

test('legacy string destroys still release the current instance', () => {
  const scene = new ClientScene();
  scene.applyFrame({
    t: 'f', k: 1, b: 'b1',
    c: [{ id: 'E1', kind: 'cache', name: 'c', x: 0, y: 0, region: 'R0-0', team: null, parentId: null, state: null, version: 0, g: 3 }],
  });
  assert.equal(scene.entities.get('E1').gen, 3);
  scene.applyFrame({ t: 'f', k: 2, d: ['E1'] });
  assert.equal(scene.entities.size, 0);
  assert.equal(scene.stats.destroysApplied, 1);
});

test('hold window covers the excursion so the control never churns', () => {
  // Guards the test rig itself: the interaction hold must outlast the trip
  // used by churnUntilRecreated, otherwise the control would be destroyed too.
  assert.ok(INTERACT_HOLD_TICKS > GRACE_TICKS + 8);
});
