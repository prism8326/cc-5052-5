import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import WebSocket from 'ws';

import { startServer } from '../server/index.js';
import { ClientScene } from '../client/scene.js';
import { WORLD } from '../shared/protocol.js';

let app;
let baseUrl;
let wsUrl;

before(async () => {
  app = startServer({ port: 0, tickMs: 25, quiet: true });
  const started = await app.start();
  baseUrl = `http://localhost:${started.port}`;
  wsUrl = `ws://localhost:${started.port}/ws`;
  startedRef = started;
});

let startedRef;
after(async () => {
  await startedRef.close();
});

function connectClient(team = '') {
  return new Promise((resolve) => {
    const scene = new ClientScene();
    const ws = new WebSocket(`${wsUrl}${team ? `?team=${team}` : ''}`);
    const client = {
      scene,
      ws,
      welcome: null,
      frames: 0,
      bytes: 0,
      events: [],
      view(x, y, facing, view, budget) {
        ws.send(JSON.stringify({ t: 'view', x, y, facing, view, budget }));
      },
      sendAck(b) { ws.send(JSON.stringify({ t: 'ack', b })); },
      close() { ws.close(); },
    };
    ws.on('message', (raw) => {
      const msg = JSON.parse(raw.toString());
      if (msg.t === 'welcome') { client.welcome = msg; resolve(client); return; }
      if (msg.t === 'f') {
        client.frames++;
        client.bytes += Buffer.byteLength(raw.toString());
        const result = scene.applyFrame(msg);
        if (result.ack) client.sendAck(result.ack);
        for (const ev of result.events) client.events.push(ev);
      }
    });
  });
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

test('http endpoints serve the dashboard and telemetry', async () => {
  const page = await fetch(`${baseUrl}/`);
  assert.equal(page.status, 200);
  const html = await page.text();
  assert.match(html, /Wayline/);

  const health = await (await fetch(`${baseUrl}/api/health`)).json();
  assert.equal(health.ok, true);
  assert.ok(health.tick >= 0);

  const state = await (await fetch(`${baseUrl}/api/state`)).json();
  assert.equal(state.world.entities, 84);
  assert.equal(state.world.regions.length, 12);
  assert.equal(state.observers.filter((o) => o.mode === 'virtual').length, 3);
});

test('multiple observers see different subsets and stay consistent', async () => {
  const a = await connectClient();
  const b = await connectClient();

  // Two very different poses: opposite corners, opposite facings.
  a.view(40, 40, 0);
  b.view(WORLD.width - 40, WORLD.height - 40, Math.PI);

  await sleep(900);

  const reportA = a.scene.report();
  const reportB = b.scene.report();
  assert.ok(reportA.ids.length > 0, 'observer A should build objects');
  assert.ok(reportB.ids.length > 0, 'observer B should build objects');
  assert.notDeepEqual(reportA.ids, reportB.ids, 'observers at opposite corners must not see the same set');
  assert.equal(reportA.unresolvedRefs.length, 0);
  assert.equal(reportB.unresolvedRefs.length, 0);
  assert.equal(reportA.staged.length, 0);
  assert.equal(reportB.staged.length, 0);

  // Each built object exists in the authoritative world.
  for (const id of reportA.ids) assert.ok(app.world.entities.has(id), `${id} must exist server-side`);

  // The union is still far smaller than the world (server-side filtering).
  const union = new Set([...reportA.ids, ...reportB.ids]);
  assert.ok(union.size < app.world.entities.size, 'subset, not the whole world');

  a.close();
  b.close();
});

test('observer crossing regions adds and removes without a global reset', async () => {
  const c = await connectClient();
  c.view(30, 60, 0, { radius: 120, halfAngle: 1.0, nearRadius: 24 }, { bytes: 3000, ops: 36 });
  await sleep(400);
  const first = new Set(c.scene.report().ids);
  assert.ok(first.size > 0);

  const seen = new Set(first);
  const removed = [];
  for (let i = 0; i < 40; i++) {
    c.view(30 + i * 13, 60 + Math.sin(i * 0.2) * 20, 0);
    await sleep(28);
    for (const id of c.scene.entities.keys()) seen.add(id);
  }
  const finalReport = c.scene.report();
  for (const id of first) if (!c.scene.entities.has(id)) removed.push(id);

  assert.ok(seen.size > first.size, 'should discover new entities while travelling');
  assert.ok(removed.length > 0, 'should release entities left behind');
  assert.ok(c.scene.entities.size < app.world.entities.size, 'still a subset');
  assert.equal(finalReport.unresolvedRefs.length, 0);
  assert.equal(finalReport.stats.orphanUpdates, 0);
  assert.equal(finalReport.stats.unknownDestroys, 0);

  // Everything ever seen still exists on the server: removes are replicas only.
  for (const id of seen) assert.ok(app.world.entities.has(id));
  c.close();
});

test('rapid camera spins never rebuild object identity', async () => {
  const d = await connectClient();
  d.view(WORLD.width / 2, WORLD.height / 2, 0, { radius: 170, halfAngle: Math.PI, nearRadius: 70 }, { bytes: 6000, ops: 80 });
  await sleep(500);

  const objectsBefore = new Map([...d.scene.entities.entries()]);
  const objectRefs = new Map(objectsBefore);
  for (let i = 0; i < 50; i++) {
    d.view(WORLD.width / 2, WORLD.height / 2, i * 0.9);
    await sleep(22);
  }
  await sleep(200);
  let rebuilt = 0;
  for (const [id, obj] of objectRefs) {
    if (d.scene.entities.get(id) && d.scene.entities.get(id) !== obj) rebuilt++;
  }
  assert.equal(rebuilt, 0, 'no scene object should be replaced while subscribed');

  // Server telemetry should report per-observer settled conformance.
  const state = await (await fetch(`${baseUrl}/api/state`)).json();
  const mine = state.observers.find((o) => o.id === d.welcome.observerId);
  assert.ok(mine, 'observer visible in telemetry');
  assert.equal(mine.conformance.unresolved, 0);
  assert.equal(mine.conformance.missing, 0);
  assert.ok(mine.metrics.bytesPerTickAvg > 0);
  d.close();
});

test('a declared team link survives being far outside the view cone', async () => {
  // Telemetry exposes team membership so we can drive a client to an NPC that
  // shares its team but sits on the far side of the map.
  const targetNpc = [...app.world.entities.values()].find((e) => e.kind === 'npc');
  targetNpc.team = 'integration-team';
  const d = await connectClient('integration-team');
  // Stand far away and face away from the NPC.
  const farX = targetNpc.x > WORLD.width / 2 ? 20 : WORLD.width - 20;
  d.view(farX, 20, targetNpc.x > WORLD.width / 2 ? 0 : Math.PI);
  await sleep(700);
  const report = d.scene.report();
  assert.ok(report.ids.includes(targetNpc.id), 'team member replicated across the map');

  const state = await (await fetch(`${baseUrl}/api/state`)).json();
  const mine = state.observers.find((o) => o.id === d.welcome.observerId);
  assert.ok(mine.counts['team-link'] >= 1);
  d.close();
});

test('lab reorder over a real socket: stale destroy is scoped, pickup validates generations', async () => {
  // A pickable cache with an interactive neighbour that acts as the control.
  const caches = [...app.world.entities.values()].filter((e) => e._pickable);
  let target = null;
  for (const cache of caches) {
    const ctrl = [...app.world.entities.values()].find((e) =>
      e._interactive && Math.hypot(e.x - cache.x, e.y - cache.y) < 70);
    if (ctrl) { target = { cache, ctrl }; break; }
  }
  assert.ok(target, 'found a cache with an interactive control nearby');
  const { cache, ctrl } = target;

  const c = await connectClient();
  const pickupResults = [];
  c.ws.on('message', (raw) => {
    const msg = JSON.parse(raw.toString());
    if (msg.t === 'pickup-result') pickupResults.push(msg);
  });
  const farX = cache.x + 400 > WORLD.width - 10 ? cache.x - 400 : cache.x + 400;
  c.view(cache.x, cache.y, 0, { radius: 110, halfAngle: Math.PI, nearRadius: 30 }, { bytes: 5000, ops: 60 });
  await sleep(600);
  assert.ok(c.scene.entities.has(cache.id), 'cache subscribed');
  assert.equal(c.scene.entities.get(cache.id).gen, 1);
  const controlRef = c.scene.entities.get(ctrl.id);
  assert.ok(controlRef, 'control subscribed');

  // Ongoing interaction on the control: its hold must survive the lab.
  c.ws.send(JSON.stringify({ t: 'interact', id: ctrl.id }));
  await sleep(120);

  // Hold destroys, leave past the grace window, come straight back.
  c.ws.send(JSON.stringify({ t: 'lab', op: 'delay-destroys', ticks: 200 }));
  await sleep(80);
  c.view(farX, cache.y, 0);
  await sleep(600); // grace (12 ticks at 25ms) expires; the destroy is held
  c.view(cache.x, cache.y, 0);
  await sleep(500); // the re-create (gen 2) is not held and applies
  assert.equal(c.scene.entities.get(cache.id)?.gen, 2, 'returning created generation 2');

  // Releasing the lab delivers the old destroy after the new create.
  c.ws.send(JSON.stringify({ t: 'lab', op: 'clear' }));
  await sleep(250);

  const item = c.scene.entities.get(cache.id);
  assert.ok(item, 'new instance survives the late destroy');
  assert.equal(item.gen, 2);
  assert.ok(c.scene.misbinds.some((m) => m.id === cache.id && m.op === 'destroy' && m.msgGen === 1 && m.currentGen === 2),
    'tracer recorded the misbound destroy');
  assert.ok(c.scene.minimalRepro, 'a minimal packet sequence was saved');
  assert.equal(c.scene.entities.get(ctrl.id), controlRef, 'control object identity untouched');

  // Actual pickup results: the original instance is gone for good, the new
  // one claims normally, and no instance can be claimed twice.
  const pickup = (id, gen) => {
    c.ws.send(JSON.stringify({ t: 'pickup', id, gen }));
    return sleep(120);
  };
  await pickup(cache.id, 1);
  await pickup(cache.id, 2);
  await pickup(cache.id, 2);
  assert.equal(pickupResults.length, 3);
  assert.deepEqual(
    pickupResults.map((r) => ({ ok: r.ok, reason: r.reason || null })),
    [
      { ok: false, reason: 'stale-generation' },
      { ok: true, reason: null },
      { ok: false, reason: 'already-claimed' },
    ],
  );

  // Telemetry exposes the server side of the per-instance trace.
  const state = await (await fetch(`${baseUrl}/api/state`)).json();
  const mine = state.observers.find((o) => o.id === c.welcome.observerId);
  const ops = mine.instanceLog.filter((e) => e.id === cache.id).map((e) => `${e.op}#${e.gen}`);
  assert.ok(ops.includes('destroy#1') && ops.includes('recreate#2'), `server trace has the churn: ${ops}`);
  assert.ok(mine.instanceLog.some((e) => e.op === 'pickup' && e.id === cache.id), 'pickup traced server-side');
  c.close();
});
