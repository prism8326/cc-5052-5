// Demo server: HTTP static host + WebSocket observer transport + tick loop.
//
// Three scripted observers (horizontal crosser, vertical walker, rapidly
// spinning pivot) run against the real wire protocol using in-process
// ClientScene replicas, so the dashboard can compare what was sent, what was
// subscribed, and what the client actually built.
//
// `startServer()` is exported so the test suite can run the real transport.

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { WebSocketServer } from 'ws';

import { World } from './world.js';
import { ObserverSession, normalizeBudget, normalizeView } from './session.js';
import { ClientScene } from '../client/scene.js';
import {
  DEFAULT_BUDGET,
  DEFAULT_VIEW,
  TICK_MS,
  WORLD,
  regionIdAt,
} from '../shared/protocol.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
};

function serveFile(res, file) {
  const resolved = path.resolve(file);
  if (!resolved.startsWith(ROOT + path.sep)) {
    res.writeHead(403).end('forbidden');
    return;
  }
  fs.readFile(resolved, (err, buf) => {
    if (err) { res.writeHead(404).end('not found'); return; }
    res.writeHead(200, {
      'content-type': MIME[path.extname(resolved)] || 'application/octet-stream',
      'cache-control': 'no-store',
    });
    res.end(buf);
  });
}

const VIRTUAL = [
  {
    name: 'Crosser', profile: 'crosser', team: 'amber',
    spawn: { x: 40, y: WORLD.height * 0.34 },
    view: { radius: 132, halfAngle: Math.PI / 3.2, nearRadius: 24 },
    budget: { bytes: 3600, ops: 46 },
  },
  {
    name: 'Walker', profile: 'walker', team: 'cyan',
    spawn: { x: WORLD.width * 0.72, y: 36 },
    view: { radius: 118, halfAngle: Math.PI / 3.4, nearRadius: 22 },
    budget: { bytes: 3200, ops: 40 },
  },
  {
    name: 'Pivot', profile: 'snapspinner', team: 'amber',
    spawn: { x: WORLD.width * 0.5, y: WORLD.height * 0.5 },
    view: { radius: 150, halfAngle: Math.PI / 3, nearRadius: 26 },
    budget: { bytes: 4200, ops: 54 },
  },
];

export function startServer({ port = 4173, tickMs = TICK_MS, quiet = false } = {}) {
  const world = new World();
  const span = { width: WORLD.width, height: WORLD.height };
  const observers = new Map();
  const lifecycle = [];
  let nextObserver = 1;
  let tickCounter = 0;
  let timer = null;
  let telemetryTimer = null;

  function recordLifecycle(observer, event) {
    lifecycle.push({
      tick: tickCounter,
      observer: observer.id,
      observerName: observer.name,
      ...event,
    });
    if (lifecycle.length > 120) lifecycle.shift();
  }

  const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://localhost');
    if (url.pathname === '/api/state') {
      res.writeHead(200, { 'content-type': MIME['.json'], 'cache-control': 'no-store' });
      res.end(JSON.stringify(buildTelemetry()));
      return;
    }
    if (url.pathname === '/api/health') {
      res.writeHead(200, { 'content-type': MIME['.json'], 'cache-control': 'no-store' });
      res.end(JSON.stringify({ ok: true, tick: tickCounter, observers: observers.size }));
      return;
    }
    const rel = url.pathname === '/' ? '/public/index.html' : url.pathname;
    serveFile(res, path.join(ROOT, rel));
  });

  const wss = new WebSocketServer({ server, path: '/ws' });

  // ---- virtual observers --------------------------------------------------
  function createVirtual(spec) {
    const id = `obs-${nextObserver++}`;
    const observer = {
      id,
      name: spec.name,
      mode: 'virtual',
      profile: spec.profile,
      scene: new ClientScene(),
      conformance: emptyConformance(),
      lastReport: null,
      socket: null,
    };

    const session = new ObserverSession({
      world, span,
      id, name: spec.name,
      mode: 'virtual',
      profile: spec.profile,
      team: spec.team,
      view: normalizeView(spec.view, DEFAULT_VIEW),
      budget: normalizeBudget(spec.budget, DEFAULT_BUDGET),
      spawn: spec.spawn,
      send: (payload) => {
        const frame = JSON.parse(payload);
        const result = observer.scene.applyFrame(frame);
        if (result.ack) session.ack(result.ack);
        for (const ev of result.events) {
          if (ev.type === 'create' || ev.type === 'destroy' || ev.type === 'restage') {
            recordLifecycle(observer, { ...ev, source: 'virtual' });
          }
        }
      },
    });
    observer.session = session;
    session.region = regionIdAt(spec.spawn.x, spec.spawn.y);
    observers.set(id, observer);
    return observer;
  }

  for (const spec of VIRTUAL) createVirtual(spec);

  // ---- browser observers --------------------------------------------------
  wss.on('connection', (ws, req) => {
    const id = `obs-${nextObserver++}`;
    const url = new URL(req.url, 'http://localhost');
    const spawn = world.spawns[observers.size % world.spawns.length];
    const observer = {
      id,
      name: 'Browser',
      mode: 'browser',
      profile: 'free',
      scene: null, // lives in the browser
      conformance: emptyConformance(),
      lastReport: null,
      lastReportTick: -999,
      socket: ws,
    };

    const session = new ObserverSession({
      world, span,
      id, name: observer.name,
      mode: 'browser',
      profile: 'free',
      team: url.searchParams.get('team') || null,
      view: normalizeView(null, DEFAULT_VIEW),
      budget: normalizeBudget(null, DEFAULT_BUDGET),
      spawn,
      send: (payload) => {
        if (ws.readyState === ws.OPEN) ws.send(payload);
        else if (ws.readyState === 1) ws.send(payload);
      },
    });
    observer.session = session;
    observers.set(id, observer);
    recordLifecycle(observer, { type: 'observer-join', source: 'browser' });

    ws.send(JSON.stringify({
      t: 'welcome',
      observerId: id,
      tickMs,
      world: {
        width: WORLD.width, height: WORLD.height,
        cols: WORLD.cols, rows: WORLD.rows,
        cellW: WORLD.cellW, cellH: WORLD.cellH,
      },
      spawn,
      view: session.view,
      budget: session.budget,
      regions: [...world.regions.values()].map((r) => ({
        id: r.id, name: r.name, x0: r.x0, y0: r.y0, x1: r.x1, y1: r.y1,
      })),
      entitiesTotal: world.entities.size,
    }));

    ws.on('message', (raw) => {
      let msg;
      try { msg = JSON.parse(raw.toString()); } catch { return; }
      handleClientMessage(observer, msg);
    });
    ws.on('close', () => {
      recordLifecycle(observer, { type: 'observer-leave', source: 'browser' });
      observers.delete(id);
    });
    ws.on('error', () => {});
  });

  function handleClientMessage(observer, msg) {
    const session = observer.session;
    switch (msg.t) {
      case 'view': {
        session.setView(msg);
        break;
      }
      case 'identity': {
        if (typeof msg.name === 'string' && msg.name.trim()) {
          observer.name = session.name = msg.name.trim().slice(0, 24);
        }
        break;
      }
      case 'ack': {
        const ok = session.ack(msg.b);
        if (!ok) {
          observer.socket?.send(JSON.stringify({ t: 'ack-miss', b: msg.b }));
        }
        break;
      }
      case 'pin': {
        const ok = session.togglePin(msg.id, !!msg.on);
        observer.socket?.send(JSON.stringify({ t: 'pin-result', id: msg.id, on: !!msg.on, ok }));
        break;
      }
      case 'interact': {
        const result = session.interact(msg.id);
        observer.socket?.send(JSON.stringify({ t: 'interact-result', id: msg.id, ...result }));
        break;
      }
      case 'report': {
        observer.lastReport = {
          ids: Array.isArray(msg.ids) ? msg.ids : [],
          unresolved: Array.isArray(msg.unresolved) ? msg.unresolved : [],
          staged: Array.isArray(msg.staged) ? msg.staged : [],
          created: Number(msg.created) || 0,
          destroyed: Number(msg.destroyed) || 0,
          tick: msg.tick,
        };
        observer.lastReportTick = tickCounter;
        break;
      }
      case 'ping': {
        observer.socket?.send(JSON.stringify({ t: 'pong', at: msg.at }));
        break;
      }
      default:
        break;
    }
  }

  // ---- conformance: server expectation vs the client's real replica -------
  function checkConformance(observer) {
    const session = observer.session;
    if (!session.desired) return observer.conformance;
    const desired = session.desired;
    let missing = 0;
    let stale = 0;
    let unresolved = 0;
    let staged = 0;

    if (observer.scene) {
      const scene = observer.scene;
      for (const id of desired.keys()) {
        if (!scene.entities.has(id) && !scene.staged.has(id)) missing++;
      }
      for (const id of scene.entities.keys()) {
        const e = scene.entities.get(id);
        if (!desired.has(id)) stale++;
        if (e.parentId && !scene.entities.has(e.parentId)) unresolved++;
      }
      for (const entry of scene.staged.values()) {
        if (entry.missing && !scene.entities.has(entry.missing)) staged++;
      }
    } else if (observer.lastReport) {
      // The report describes the browser replica as of report.tick, which can
      // lag the live tick stream. Compare against interest history instead of
      // the instantaneous set so in-flight creates/destroys are not mistakes.
      const reportedTick = Number(observer.lastReport.tick) || 0;
      const reported = new Set(observer.lastReport.ids);
      for (const id of reported) {
        const since = session.desiredSince.get(id);
        const destroyedAt = session.destroyedAt.get(id) ?? -Infinity;
        const wantedAtReport = (since != null && since <= reportedTick) ||
          destroyedAt > reportedTick;
        if (!wantedAtReport) stale++;
      }
      for (const [id, since] of session.desiredSince) {
        if (since > reportedTick) continue; // entered interest after the snapshot
        if (reported.has(id) || session.pendingCreate.has(id)) continue;
        if (session.evicting.has(id) || session.created.has(id)) continue;
        missing++;
      }
      unresolved = observer.lastReport.unresolved.length;
      staged = observer.lastReport.staged.filter((s) => s?.missing).length;
    }

    observer.conformance = { missing, stale, unresolved, staged, lastTick: tickCounter };
    return observer.conformance;
  }

  // ---- tick loop ----------------------------------------------------------
  function step() {
    world.step();
    tickCounter = world.tick;
    for (const observer of observers.values()) {
      const session = observer.session;
      if (session.profile && session.mode === 'virtual') session.stepAutopilot();
      session.reconcile(world.tick);
      session.emit(world.tick);
      checkConformance(observer);
    }
  }

  function buildTelemetry(perspectiveId = null) {
    const stats = world.stats();
    return {
      t: 'telemetry',
      you: perspectiveId,
      tick: world.tick,
      tickMs,
      world: {
        ...stats,
        width: WORLD.width,
        height: WORLD.height,
        regions: [...world.regions.values()].map((r) => ({
          id: r.id, name: r.name, c: r.c, r: r.r,
          x0: r.x0, y0: r.y0, x1: r.x1, y1: r.y1,
        })),
      },
      observers: [...observers.values()].map((o) => {
        const tele = o.session.telemetry();
        return {
          ...tele,
          mode: o.mode,
          conformance: o.conformance,
          report: o.lastReport
            ? {
                ids: o.lastReport.ids.length,
                unresolved: o.lastReport.unresolved.length,
                staged: o.lastReport.staged.length,
                age: tickCounter - o.lastReportTick,
              }
            : null,
          scene: o.scene
            ? {
                ids: o.scene.entities.size,
                staged: [...o.scene.staged.entries()].map(([eid, s]) => ({
                  id: eid, missing: s.missing, reason: s.reason,
                })),
                stats: o.scene.stats,
                log: o.scene.log.slice(-6),
              }
            : null,
        };
      }),
      lifecycle: lifecycle.slice(-40),
    };
  }

  function broadcastTelemetry() {
    for (const observer of observers.values()) {
      const ws = observer.socket;
      if (!ws || ws.readyState !== 1) continue;
      ws.send(JSON.stringify(buildTelemetry(observer.id)));
    }
  }

  function start() {
    return new Promise((resolve) => {
      server.listen(port, () => {
        timer = setInterval(step, tickMs);
        telemetryTimer = setInterval(broadcastTelemetry, Math.max(120, Math.round(1000 / 4)));
        if (!quiet) {
          console.log(`wayline interest demo on http://localhost:${server.address().port}`);
          console.log(`world: ${world.entities.size} entities across ${world.regions.size} regions`);
        }
        resolve({
          server,
          wss,
          world,
          observers,
          get tick() { return tickCounter; },
          step,
          buildTelemetry,
          port: server.address().port,
          close: () => new Promise((done) => {
            clearInterval(timer);
            clearInterval(telemetryTimer);
            for (const o of observers.values()) {
              o.socket?.terminate?.();
            }
            wss.close(() => server.close(() => done()));
          }),
        });
      });
    });
  }

  return { start, world, observers, get tick() { return tickCounter; }, step, buildTelemetry };
}

function emptyConformance() {
  return { missing: 0, stale: 0, unresolved: 0, staged: 0, lastTick: 0 };
}

const isMain = process.argv[1] &&
  import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href;
if (isMain) {
  const app = startServer({ port: Number(process.env.PORT || 4173) });
  app.start().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
