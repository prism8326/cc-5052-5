// Browser observer. Uses the exact same ClientScene replica as the server-side
// virtual observers and the tests; it only adds transport, input and drawing.

import { ClientScene } from '/client/scene.js';
import { REASON_INFO } from '/shared/protocol.js';

const scene = new ClientScene();
const $ = (id) => document.getElementById(id);

const state = {
  ready: false,
  world: null,
  regions: [],
  entitiesTotal: 0,
  view: { radius: 132, halfAngle: Math.PI / 3, nearRadius: 24 },
  budget: { bytes: 3600, ops: 46 },
  pose: { x: 0, y: 0, facing: 0 },
  telemetry: null,
  me: null,
  pins: new Set(),
  autopilot: false,
  autoT: 0,
  hoverId: null,
  netHistory: [],
  team: '',
  labTarget: '',
  pickupLog: [],
  labNote: '',
};

// ---- transport ------------------------------------------------------------

let ws = null;
let connState = 'connecting';
let pingSentAt = 0;
let rtt = null;

function connect() {
  const scheme = location.protocol === 'https:' ? 'wss' : 'ws';
  ws = new WebSocket(`${scheme}://${location.host}/ws${state.team ? `?team=${state.team}` : ''}`);
  ws.onopen = () => { connState = 'live'; renderConn(); };
  ws.onclose = () => {
    connState = 'disconnected';
    renderConn();
    setTimeout(connect, 1200);
  };
  ws.onerror = () => { connState = 'error'; renderConn(); };
  ws.onmessage = (ev) => {
    const msg = JSON.parse(ev.data);
    if (msg.t === 'welcome') {
      state.ready = true;
      state.myId = msg.observerId;
      state.world = msg.world;
      state.regions = msg.regions;
      state.entitiesTotal = msg.entitiesTotal;
      state.pose = { ...msg.spawn, facing: 0 };
      state.view = msg.view;
      state.budget = msg.budget;
      syncControlsFromServer();
      resize();
      sendView(true);
    } else if (msg.t === 'telemetry') {
      state.telemetry = msg;
      state.me = msg.observers.find((o) => o.id === state.myId) || null;
      applyTelemetry(msg);
    } else if (msg.t === 'pong') {
      rtt = msg.at - pingSentAt;
    } else if (msg.t === 'interact-result' || msg.t === 'pin-result') {
      // handled optimistically in UI; nothing to mirror
    } else if (msg.t === 'pickup-result') {
      notePickup(msg);
    } else if (msg.t === 'lab-result') {
      noteLabResult(msg);
    } else if (msg.t === 'f') {
      // ClientScene.applyFrame is wrapped below to ack baselines.
      const result = scene.applyFrame(msg);
      for (const ev of result.events) {
        if (ev.type === 'create' || ev.type === 'destroy' || ev.type === 'restage') {
          noteSceneEvent(ev);
        }
      }
    }
  };
}

function send(obj) {
  if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(obj));
}

let lastViewSent = 0;
let lastViewKey = '';
function sendView(force = false) {
  const now = performance.now();
  const key = `${round1(state.pose.x)}|${round1(state.pose.y)}|${round2(state.pose.facing)}|${state.view.radius}|${state.view.halfAngle}|${state.view.nearRadius}|${state.budget.bytes}|${state.budget.ops}`;
  // Coalesce pose updates: at most one per network tick, and only on change.
  if (!force && key === lastViewKey) return;
  if (!force && now - lastViewSent < 90) return;
  lastViewKey = key;
  lastViewSent = now;
  send({
    t: 'view',
    x: round1(state.pose.x),
    y: round1(state.pose.y),
    facing: state.pose.facing,
    view: state.view,
    budget: state.budget,
  });
}

// The server tracks acknowledgement per baseline id. A delta is never applied
// before its baseline, so acking the baseline is what lets the delta flow.
const acked = new Set();
function sendAckIfNeeded(id) {
  if (!id || acked.has(id)) return;
  acked.add(id);
  send({ t: 'ack', b: id });
  if (acked.size > 4000) acked.clear();
}
const origApply = scene.applyFrame.bind(scene);
scene.applyFrame = (frame) => {
  const r = origApply(frame);
  if (r.ack) sendAckIfNeeded(r.ack);
  return r;
};

// ---- reporting ------------------------------------------------------------

const notedEvents = [];
function noteSceneEvent(ev) {
  notedEvents.push({ ...ev, at: scene.tick });
  if (notedEvents.length > 30) notedEvents.shift();
}

setInterval(() => {
  if (!state.ready) return;
  const report = scene.report(0);
  send({
    t: 'report',
    tick: scene.tick,
    ids: report.ids,
    unresolved: report.unresolvedRefs,
    staged: report.staged,
    created: scene.stats.createsApplied,
    destroyed: scene.stats.destroysApplied,
  });
}, 250);

setInterval(() => {
  if (!ws || ws.readyState !== 1) return;
  pingSentAt = performance.now();
  send({ t: 'ping', at: pingSentAt });
}, 2000);

// ---- input ----------------------------------------------------------------

const canvas = $('world');
const ctx = canvas.getContext('2d');
let dragging = false;
let moved = false;

function canvasPoint(ev) {
  const rect = canvas.getBoundingClientRect();
  return {
    px: ev.clientX - rect.left,
    py: ev.clientY - rect.top,
    w: rect.width,
    h: rect.height,
  };
}

function screenToWorld(px, py, w, h) {
  const { scale, offX, offY } = viewTransform(w, h);
  return { x: (px - offX) / scale, y: (py - offY) / scale };
}

function viewTransform(w, h) {
  if (!state.world) return { scale: 1, offX: 0, offY: 0 };
  const scale = Math.min(w / state.world.width, h / state.world.height) * 0.96;
  return {
    scale,
    offX: (w - state.world.width * scale) / 2,
    offY: (h - state.world.height * scale) / 2,
  };
}

canvas.addEventListener('pointerdown', (ev) => {
  dragging = true;
  moved = false;
  try { canvas.setPointerCapture(ev.pointerId); } catch { /* synthetic events */ }
});

canvas.addEventListener('pointermove', (ev) => {
  const { px, py, w, h } = canvasPoint(ev);
  const world = screenToWorld(px, py, w, h);
  state.hoverId = hitTest(world.x, world.y);
  if (!dragging) return;
  moved = true;
  state.pose.x = clamp(world.x, 0, state.world.width);
  state.pose.y = clamp(world.y, 0, state.world.height);
  sendView();
});

canvas.addEventListener('pointerup', () => {
  if (dragging && !moved && state.hoverId) {
    togglePin(state.hoverId);
  }
  dragging = false;
});

canvas.addEventListener('dblclick', () => {
  if (state.hoverId) send({ t: 'interact', id: state.hoverId });
});

window.addEventListener('keydown', (ev) => {
  if (ev.target.tagName === 'INPUT' || ev.target.tagName === 'SELECT') return;
  if (ev.key === 'i' && state.hoverId) send({ t: 'interact', id: state.hoverId });
  if (ev.key === 'p' && state.hoverId) togglePin(state.hoverId);
});

function togglePin(id) {
  const on = !state.pins.has(id);
  if (on && state.pins.size >= 12) return;
  if (on) state.pins.add(id); else state.pins.delete(id);
  send({ t: 'pin', id, on });
  renderEntityList(state.me);
}

function hitTest(x, y) {
  let best = null;
  let bestD = 14 * 14;
  for (const e of scene.entities.values()) {
    const d = (e.x - x) ** 2 + (e.y - y) ** 2;
    if (d < bestD) { bestD = d; best = e.id; }
  }
  return best;
}

// Autopilot is time-based so its speed does not depend on frame rate. Kept to
// a walking pace so the interest set evolves the way a real observer's would.
function autopilotStep(nowMs) {
  if (!state.autopilot || !state.world) return;
  state.autoT = nowMs / 1000;
  const W = state.world.width;
  const H = state.world.height;
  state.pose.x = W / 2 + Math.cos(state.autoT * 0.055) * W * 0.34;
  state.pose.y = H / 2 + Math.sin(state.autoT * 0.09) * H * 0.28;
  state.pose.facing = Math.atan2(
    Math.cos(state.autoT * 0.09) * 0.09 * H * 0.28,
    -Math.sin(state.autoT * 0.055) * 0.055 * W * 0.34,
  );
  sendView();
}

// Move with arrow keys for precise boundary work.
const keys = new Set();
window.addEventListener('keydown', (e) => keys.add(e.key));
window.addEventListener('keyup', (e) => keys.delete(e.key));
function keyboardStep() {
  if (state.autopilot) return;
  const s = 4;
  let moved = false;
  if (keys.has('ArrowLeft')) { state.pose.x -= s; moved = true; }
  if (keys.has('ArrowRight')) { state.pose.x += s; moved = true; }
  if (keys.has('ArrowUp')) { state.pose.y -= s; moved = true; }
  if (keys.has('ArrowDown')) { state.pose.y += s; moved = true; }
  if (moved) {
    state.pose.x = clamp(state.pose.x, 0, state.world.width);
    state.pose.y = clamp(state.pose.y, 0, state.world.height);
    sendView();
  }
}

// ---- controls -------------------------------------------------------------

function syncControlsFromServer() {
  $('radius').value = state.view.radius;
  $('radiusv').textContent = Math.round(state.view.radius);
  $('cone').value = Math.round((state.view.halfAngle * 180) / Math.PI);
  $('conev').textContent = `${Math.round((state.view.halfAngle * 180) / Math.PI)}°`;
  $('near').value = state.view.nearRadius;
  $('nearv').textContent = Math.round(state.view.nearRadius);
  $('bytes').value = state.budget.bytes;
  $('bytesv').textContent = state.budget.bytes;
  $('ops').value = state.budget.ops;
  $('opsv').textContent = state.budget.ops;
}

function bindControls() {
  $('radius').addEventListener('input', (e) => {
    state.view.radius = Number(e.target.value);
    $('radiusv').textContent = state.view.radius;
    sendView(true);
  });
  $('cone').addEventListener('input', (e) => {
    state.view.halfAngle = (Number(e.target.value) * Math.PI) / 180;
    $('conev').textContent = `${e.target.value}°`;
    sendView(true);
  });
  $('near').addEventListener('input', (e) => {
    state.view.nearRadius = Number(e.target.value);
    $('nearv').textContent = e.target.value;
    sendView(true);
  });
  $('bytes').addEventListener('input', (e) => {
    state.budget.bytes = Number(e.target.value);
    $('bytesv').textContent = e.target.value;
    sendView(true);
  });
  $('ops').addEventListener('input', (e) => {
    state.budget.ops = Number(e.target.value);
    $('opsv').textContent = e.target.value;
    sendView(true);
  });
  $('nameinput').addEventListener('change', (e) => {
    send({ t: 'identity', name: e.target.value });
  });
  $('teamselect').addEventListener('change', (e) => {
    state.team = e.target.value;
    acked.clear();
    scene.reset();
    ws?.close();
  });
  $('autobtn').addEventListener('click', () => {
    state.autopilot = !state.autopilot;
    $('autobtn').classList.toggle('on', state.autopilot);
  });
  $('resetbtn').addEventListener('click', () => {
    acked.clear();
    scene.reset();
    ws?.close();
  });

  // Instance lab
  $('labtarget').addEventListener('input', (e) => { state.labTarget = e.target.value.trim(); renderLab(); });
  $('labnearest').addEventListener('click', () => { const id = nearestCacheId(); if (id) setLabTarget(id); });
  $('labhover').addEventListener('click', () => { if (state.hoverId) setLabTarget(state.hoverId); });
  $('labdelaycreate').addEventListener('click', () => send({ t: 'lab', op: 'delay-creates', ticks: 6 }));
  $('labdelaydestroy').addEventListener('click', () => send({ t: 'lab', op: 'delay-destroys', ticks: 6 }));
  $('labclear').addEventListener('click', () => send({ t: 'lab', op: 'clear' }));
  $('labreplaydestroy').addEventListener('click', () => send({ t: 'lab', op: 'replay-destroy', id: state.labTarget.trim() }));
  $('labreplaycreate').addEventListener('click', () => send({ t: 'lab', op: 'replay-create', id: state.labTarget.trim() }));
  $('labpickup').addEventListener('click', () => {
    const id = state.labTarget.trim();
    if (!id) return;
    send({ t: 'pickup', id, gen: scene.entities.get(id)?.gen });
  });
  $('labpickupstale').addEventListener('click', () => {
    const id = state.labTarget.trim();
    if (!id) return;
    const gen = (scene.entities.get(id)?.gen ?? 2) - 1;
    send({ t: 'pickup', id, gen });
  });
  $('labsaverepro').addEventListener('click', saveRepro);
}

// ---- telemetry rendering --------------------------------------------------

function applyTelemetry(msg) {
  $('tickpill').textContent = `tick ${msg.tick}`;
  const net = state.me ? state.me.metrics : null;
  $('budgetpill').textContent = net
    ? `${net.bytesPerTickAvg} B · ${net.opsPerTickAvg} ops / tick`
    : '— B · — ops';
  if (!state.me) return;
  renderReplica(state.me);
  renderReasons(state.me);
  renderNet(state.me);
  renderObservers(msg.observers);
  renderLifecycle(msg.lifecycle);
  renderLab();
}

function renderConn() {
  const el = $('conn');
  el.textContent = connState;
  el.className = `pill ${connState === 'live' ? 'ok' : connState === 'connecting' ? 'muted' : 'bad'}`;
}

function renderReplica(me) {
  $('replicacount').textContent = `${scene.entities.size} local`;
  const con = me.conformance || {};
  const cells = [
    ['Built', scene.entities.size, 'good'],
    ['Staged', scene.staged.size, scene.staged.size ? 'warn' : ''],
    ['Awaiting baseline', me.inFlight, ''],
    ['Subscribed', me.subscribed, ''],
    ['Missing', con.missing ?? 0, (con.missing ? 'bad' : 'good')],
    ['Unresolved refs', con.unresolved ?? 0, (con.unresolved ? 'bad' : 'good')],
    ['Stale replicas', con.stale ?? 0, (con.stale ? 'warn' : '')],
    ['Baselines acked', scene.stats.ackedBaselines, ''],
  ];
  $('replicastats').innerHTML = cells
    .map(([k, v, cls]) => `<div class="cell"><span>${k}</span><b class="${cls}">${v}</b></div>`)
    .join('');

  const stageEl = $('staging');
  if (!scene.staged.size) {
    stageEl.innerHTML = '';
  } else {
    stageEl.innerHTML = [...scene.staged.entries()]
      .map(([id, s]) => `
        <div class="stageitem">
          <span>${id} <span class="why">${s.reason}</span></span>
          <span class="miss">needs ${s.missing || 'baseline'}</span>
        </div>`)
      .join('');
  }
}

function renderReasons(me) {
  const counts = me.counts || {};
  const total = Math.max(1, Object.values(counts).reduce((a, b) => a + b, 0));
  const order = ['near', 'cone', 'team-link', 'pinned', 'interaction-hold', 'interest-grace', 'dependency'];
  $('reasonbars').innerHTML = order
    .map((key) => {
      const n = counts[key] || 0;
      const info = REASON_INFO[key];
      const pct = Math.round((n / total) * 100);
      return `<div class="rb">
        <span class="name" title="${info.note}">${info.label}</span>
        <span class="track"><span class="fill" style="width:${pct}%;background:${info.color}"></span></span>
        <b>${n}</b>
      </div>`;
    })
    .join('');
  renderEntityList(me);
}

function renderEntityList(me) {
  if (!me) return;
  const rows = (me.reasons || []).slice(0, 26).map((r) => {
    const pinned = state.pins.has(r.id);
    const tags = r.reasons
      .map((why) => `<span class="tag" style="color:${REASON_INFO[why].color};border-color:${REASON_INFO[why].color}55">${why}</span>`)
      .join('');
    return `<div class="erow ${pinned ? 'pinned' : ''}" data-id="${r.id}">
      <span class="eid">${r.id}</span>
      <span class="why">${tags}</span>
      <span class="dist">${Math.round(r.dist)}u</span>
    </div>`;
  });
  const el = $('entitylist');
  el.innerHTML = rows.join('') || '<div class="empty">no entities subscribed at this pose</div>';
  el.querySelectorAll('.erow').forEach((row) => {
    row.addEventListener('click', () => {
      const id = row.dataset.id;
      send({ t: 'pin', id, on: !state.pins.has(id) });
      if (state.pins.has(id)) state.pins.delete(id); else state.pins.add(id);
      renderEntityList(me);
    });
    row.addEventListener('dblclick', () => send({ t: 'interact', id: row.dataset.id }));
  });
}

function renderNet(me) {
  const m = me.metrics;
  $('netaverage').textContent = `${m.bytesPerTickAvg} B/tick avg`;
  const cells = [
    ['Bytes sent', m.bytesSent.toLocaleString()],
    ['Ops sent', m.opsSent.toLocaleString()],
    ['Baselines', m.baselinesSent],
    ['Creates', m.createsSent],
    ['Updates', m.updatesSent],
    ['Destroys', m.destroysSent],
    ['Recreated', m.recreatedSent],
    ['Region crossings', m.crossings],
    ['Budget skips', m.budgetSkips, m.budgetSkips ? 'warn' : ''],
    ['Retries/fail', `${m.baselineRetries}/${m.baselineFailures}`, m.baselineFailures ? 'bad' : ''],
  ];
  $('netstats').innerHTML = cells
    .map(([k, v, cls]) => `<div class="cell"><span>${k}</span><b class="${cls || ''}">${v}</b></div>`)
    .join('');

  state.netHistory.push({ b: m.lastBytes, o: m.lastOps });
  if (state.netHistory.length > 120) state.netHistory.shift();
  drawNetChart();
}

function drawNetChart() {
  const c = $('netchart');
  const dpr = window.devicePixelRatio || 1;
  const w = c.clientWidth, h = c.clientHeight;
  if (!w || !h) return;
  if (c.width !== w * dpr || c.height !== h * dpr) {
    c.width = w * dpr; c.height = h * dpr;
  }
  const g = c.getContext('2d');
  g.setTransform(dpr, 0, 0, dpr, 0, 0);
  g.clearRect(0, 0, w, h);
  const budget = state.me?.budget?.bytes || state.budget.bytes;
  const max = Math.max(budget * 1.15, ...state.netHistory.map((p) => p.b), 100);
  // budget line
  const by = h - (budget / max) * (h - 8) - 4;
  g.strokeStyle = '#ffd16666';
  g.setLineDash([4, 4]);
  g.beginPath(); g.moveTo(0, by); g.lineTo(w, by); g.stroke();
  g.setLineDash([]);
  g.strokeStyle = '#63b7ff';
  g.lineWidth = 1.5;
  g.beginPath();
  state.netHistory.forEach((p, i) => {
    const x = (i / Math.max(1, state.netHistory.length - 1)) * w;
    const y = h - (p.b / max) * (h - 8) - 4;
    if (i === 0) g.moveTo(x, y); else g.lineTo(x, y);
  });
  g.stroke();
  g.fillStyle = '#8da0b8';
  g.font = '9px ui-monospace, monospace';
  g.fillText(`max ${max}`, 4, 10);
  g.fillText(`budget ${budget}`, 4, by - 4 > 8 ? by - 4 : by + 11);
}

function renderObservers(list) {
  const el = $('observers');
  el.innerHTML = list
    .filter((o) => o.mode === 'virtual' || o.id === state.myId)
    .map((o) => {
      const m = o.metrics;
      const c = o.conformance || {};
      const bad = (c.missing || 0) + (c.unresolved || 0) > 0;
      return `<div class="obrow">
        <div class="head">
          <span class="nm">${escapeHtml(o.name)}</span>
          <span class="rg">${o.region} · ${o.profile || 'free'}</span>
          <span class="mode">${o.mode}${o.team ? ` · ${o.team}` : ''}</span>
        </div>
        <div class="nums">
          <div><span>built</span>${o.scene ? o.scene.ids : o.report?.ids ?? '—'}</div>
          <div><span>subs</span>${o.subscribed}</div>
          <div><span>sent</span>${m.bytesPerTickAvg}B</div>
          <div><span>ops</span>${m.opsPerTickAvg}</div>
        </div>
        <div class="chips">
          <span class="chip ${bad ? 'bad' : 'good'}">missing ${c.missing || 0}</span>
          <span class="chip ${(c.unresolved || 0) ? 'bad' : ''}">unresolved ${c.unresolved || 0}</span>
          <span class="chip ${(o.scene?.staged?.length) ? 'warn' : ''}">staged ${o.scene?.staged?.length ?? c.staged ?? 0}</span>
          <span class="chip">x-region ${m.crossings}</span>
          <span class="chip ${m.budgetSkips ? 'warn' : ''}">skips ${m.budgetSkips}</span>
          <span class="chip ${m.recreatedSent ? 'warn' : ''}" title="entities destroyed then recreated as new baselines">churn ${m.recreatedSent}</span>
        </div>
      </div>`;
    })
    .join('');
}

function renderLifecycle(events) {
  const el = $('lifecycle');
  const rows = [...events].reverse().slice(0, 22).map((e) => {
    const detail = e.type === 'create'
      ? `create ${e.id}${e.parentId ? ` ← ${e.parentId}` : ''}`
      : e.type === 'destroy'
        ? `destroy ${e.id} (server keeps it)`
        : e.type === 'restage'
          ? `restage ${e.id} needs ${e.missing}`
          : e.type === 'observer-join' || e.type === 'observer-leave'
            ? `${e.type} ${e.observer}`
            : `${e.type} ${e.id || ''}`;
    return `<div class="lc ${e.type}">
      <span class="t">${e.tick}</span>
      <span class="who">${escapeHtml(e.observerName || e.observer || '')}</span>
      <span class="what">${escapeHtml(detail)}</span>
    </div>`;
  });
  el.innerHTML = rows.join('') || '<div class="empty">no lifecycle events yet</div>';
}

// ---- instance lab ---------------------------------------------------------
// Side-by-side per-instance trace: what the server emitted for an id versus
// what this client actually did with it. The fault buttons drive the
// server-side FrameLab, which can hold creates, hold destroys, or replay a
// cached frame to reproduce out-of-order delivery.

function setLabTarget(id) {
  state.labTarget = id || '';
  $('labtarget').value = state.labTarget;
  renderLab();
}

function nearestCacheId() {
  let best = null;
  let bestD = Infinity;
  for (const e of scene.entities.values()) {
    if (e.kind !== 'cache') continue;
    const d = (e.x - state.pose.x) ** 2 + (e.y - state.pose.y) ** 2;
    if (d < bestD) { bestD = d; best = e.id; }
  }
  return best;
}

function notePickup(msg) {
  state.pickupLog.unshift({
    at: scene.tick,
    id: msg.id,
    ok: msg.ok,
    text: msg.ok
      ? `claimed gen ${msg.gen}`
      : `rejected: ${msg.reason}${msg.currentGen != null ? ` (live gen ${msg.currentGen})` : ''}`,
  });
  if (state.pickupLog.length > 6) state.pickupLog.pop();
  renderLab();
}

function noteLabResult(msg) {
  state.labNote = msg.ok
    ? `${msg.op}: ok${msg.released ? ` — released ${msg.released} held frame(s)` : ''}${msg.held ? ` — ${msg.held} still held` : ''}`
    : `${msg.op}: no matching cached frame`;
  renderLab();
}

function saveRepro() {
  const id = state.labTarget.trim();
  const repro = id ? scene.buildRepro(id) : scene.minimalRepro;
  if (!repro || !repro.frames || !repro.frames.length) {
    state.labNote = `no repro available for ${id || 'the first misbind'} yet`;
    renderLab();
    return;
  }
  const blob = new Blob([JSON.stringify(repro, null, 2)], { type: 'application/json' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `repro-${repro.id}-gen${repro.gen}.json`;
  a.click();
  URL.revokeObjectURL(a.href);
  state.labNote = `saved ${repro.frames.length}-frame repro for ${repro.id} (gen ${repro.gen})`;
  renderLab();
}

function renderLab() {
  if (!state.me) return;
  if (!state.labTarget && scene.firstMisbind) setLabTarget(scene.firstMisbind.id);
  const id = state.labTarget.trim();

  const lab = state.me.lab || {};
  $('labstatus').textContent = [
    lab.holdingCreates ? 'holding creates' : null,
    lab.holdingDestroys ? 'holding destroys' : null,
    lab.held ? `${lab.held} frame(s) held` : null,
    lab.replays ? `${lab.replays} replay(s)` : null,
    state.labNote,
  ].filter(Boolean).join(' · ') || 'lab idle — no delays armed, nothing held';

  const mb = scene.firstMisbind;
  const banner = $('misbindbanner');
  if (mb) {
    banner.classList.remove('hidden');
    banner.textContent =
      `first misbound message @tick ${mb.tick}: ${mb.op} ${mb.id} gen ${mb.msgGen} ` +
      `arrived for live gen ${mb.currentGen} — dropped, instance kept`;
  } else {
    banner.classList.add('hidden');
  }

  const serverEl = $('traceserver');
  const clientEl = $('traceclient');
  if (!id) {
    serverEl.innerHTML = '<div class="empty">pick a target id</div>';
    clientEl.innerHTML = '<div class="empty">pick a target id</div>';
    $('traceservergen').textContent = '';
    $('traceclientgen').textContent = '';
  } else {
    const serverLog = (state.me.instanceLog || []).filter((e) => e.id === id);
    const clientLog = scene.log.filter((e) => e.id === id);
    let serverGen = '—';
    for (let i = serverLog.length - 1; i >= 0; i--) {
      const op = serverLog[i].op;
      if (op === 'destroy') { serverGen = `gen ${serverLog[i].gen} · destroyed`; break; }
      if (op.startsWith('create') || op === 'recreate') { serverGen = `gen ${serverLog[i].gen}`; break; }
    }
    $('traceservergen').textContent = serverGen;
    const ce = scene.entities.get(id);
    $('traceclientgen').textContent = ce
      ? `gen ${ce.gen}${ce.state?.claimed ? ' · claimed' : ''}`
      : scene.staged.has(id) ? 'staged' : '—';
    serverEl.innerHTML = serverLog.slice(-12).map((e) =>
      `<div class="tr ${e.op}"><span class="t">${e.tick}</span><span class="op">${escapeHtml(e.op)}</span><span class="g">#${e.gen ?? '—'}</span><span class="nt">${escapeHtml(e.note || '')}</span></div>`,
    ).join('') || '<div class="empty">no server events for this id</div>';
    clientEl.innerHTML = clientLog.slice(-12).map((e) =>
      `<div class="tr ${e.type}"><span class="t">${e.tick}</span><span class="op">${escapeHtml(e.type)}</span><span class="g">#${e.gen ?? '—'}</span><span class="nt">${e.currentGen != null ? `live #${e.currentGen}` : ''}</span></div>`,
    ).join('') || '<div class="empty">no client events for this id</div>';
  }

  $('pickuplog').innerHTML = state.pickupLog.map((p) =>
    `<div class="pk ${p.ok ? 'ok' : 'bad'}"><span class="t">${p.at}</span> ${escapeHtml(p.id)} · ${escapeHtml(p.text)}</div>`,
  ).join('');
}

// ---- world drawing --------------------------------------------------------

let dpr = 1;
function resize() {
  const rect = canvas.getBoundingClientRect();
  dpr = window.devicePixelRatio || 1;
  canvas.width = Math.max(1, rect.width * dpr);
  canvas.height = Math.max(1, rect.height * dpr);
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
}

window.addEventListener('resize', resize);

const KIND_COLOR = {
  player: '#5ee1b3',
  npc: '#8fa6c2',
  tower: '#7c8aa5',
  barge: '#5b7fa6',
  gatehouse: '#6f7f9c',
  rig: '#7a8aa0',
  relic: '#c68cff',
  crate: '#8b6f47',
  lamp: '#ffd166',
  valve: '#63b7ff',
  torch: '#ff8f6b',
  cargo: '#9a8668',
  pipe: '#7f93a8',
  door: '#c0a06a',
  beacon: '#f472b6',
  cache: '#e3b341',
};

function draw() {
  const rect = canvas.getBoundingClientRect();
  const w = rect.width, h = rect.height;
  ctx.clearRect(0, 0, w, h);
  if (!state.world) return;
  const { scale, offX, offY } = viewTransform(w, h);
  const mapW = state.world.width * scale;
  const mapH = state.world.height * scale;

  // backdrop
  ctx.fillStyle = '#0a111b';
  ctx.fillRect(offX, offY, mapW, mapH);

  // region grid
  const cellW = state.world.cellW * scale;
  const cellH = state.world.cellH * scale;
  ctx.lineWidth = 1;
  ctx.strokeStyle = '#1e2c3f';
  for (let r = 0; r < state.world.rows; r++) {
    for (let c = 0; c < state.world.cols; c++) {
      ctx.strokeRect(offX + c * cellW, offY + r * cellH, cellW, cellH);
    }
  }
  ctx.fillStyle = '#40536b';
  ctx.font = `${Math.max(8, 9 * scale)}px ui-monospace, monospace`;
  for (const region of state.regions) {
    ctx.fillText(region.name.toUpperCase(), offX + region.x0 * scale + 6, offY + region.y0 * scale + 14);
  }

  if (!state.myId) {
    // before identification, draw the whole static world lightly
  }

  const toScreen = (x, y) => ({ x: offX + x * scale, y: offY + y * scale });

  // view cone + radius for the local observer
  const me = toScreen(state.pose.x, state.pose.y);
  const rPix = state.view.radius * scale;
  const coneR = state.view.halfAngle;
  const facing = state.pose.facing;
  const nearR = state.view.nearRadius * scale;
  ctx.beginPath();
  ctx.moveTo(me.x, me.y);
  ctx.arc(me.x, me.y, rPix, facing - coneR, facing + coneR);
  ctx.closePath();
  ctx.fillStyle = '#63b7ff14';
  ctx.fill();
  ctx.strokeStyle = '#63b7ff35';
  ctx.stroke();
  ctx.beginPath();
  ctx.arc(me.x, me.y, nearR, 0, Math.PI * 2);
  ctx.strokeStyle = '#5ee1b344';
  ctx.setLineDash([3, 5]);
  ctx.stroke();
  ctx.setLineDash([]);
  // facing arrow
  ctx.beginPath();
  ctx.moveTo(me.x, me.y);
  ctx.lineTo(me.x + Math.cos(facing) * 22, me.y + Math.sin(facing) * 22);
  ctx.strokeStyle = '#63b7ff88';
  ctx.lineWidth = 2;
  ctx.stroke();
  ctx.lineWidth = 1;

  // Everything the client actually built, with parent links.
  const primaryById = new Map();
  if (state.me) {
    for (const r of state.me.reasons) primaryById.set(r.id, r.primary);
  }
  for (const e of scene.entities.values()) {
    const p = toScreen(e.x, e.y);
    if (e.parentId) {
      const parent = scene.entities.get(e.parentId);
      if (parent) {
        const pp = toScreen(parent.x, parent.y);
        ctx.strokeStyle = '#2c3f57';
        ctx.beginPath();
        ctx.moveTo(pp.x, pp.y);
        ctx.lineTo(p.x, p.y);
        ctx.stroke();
      }
    }
  }
  for (const e of scene.entities.values()) {
    const p = toScreen(e.x, e.y);
    const why = primaryById.get(e.id);
    // Fill = why it is subscribed; a thin kind-coloured ring keeps identity
    // legible without overloading the reason colour.
    const reasonColor = why ? REASON_INFO[why].color : '#7f93a8';
    const kindColor = KIND_COLOR[e.kind] || '#7f93a8';
    const claimed = e.kind === 'cache' && e.state?.claimed;
    const s = e.kind === 'npc' ? 5 : e.kind === 'beacon' ? 4.5 : 4;
    ctx.fillStyle = reasonColor;
    ctx.beginPath();
    ctx.arc(p.x, p.y, s, 0, Math.PI * 2);
    ctx.fill();
    ctx.strokeStyle = kindColor + 'cc';
    ctx.lineWidth = 1.5;
    ctx.stroke();
    ctx.lineWidth = 1;
    if (claimed) {
      ctx.strokeStyle = '#e3b341';
      ctx.beginPath();
      ctx.moveTo(p.x - 3.4, p.y + 0.2);
      ctx.lineTo(p.x - 0.9, p.y + 2.8);
      ctx.lineTo(p.x + 3.6, p.y - 2.6);
      ctx.stroke();
    }
    if (e.id === state.labTarget && state.labTarget) {
      ctx.strokeStyle = '#ffffff';
      ctx.setLineDash([3, 3]);
      ctx.beginPath();
      ctx.arc(p.x, p.y, s + 8, 0, Math.PI * 2);
      ctx.stroke();
      ctx.setLineDash([]);
    }
    if (why === 'interest-grace') ctx.globalAlpha = 0.55;
    if (e.id === state.hoverId) {
      ctx.strokeStyle = '#ffffffaa';
      ctx.beginPath();
      ctx.arc(p.x, p.y, s + 4, 0, Math.PI * 2);
      ctx.stroke();
    }
    if (state.pins.has(e.id)) {
      ctx.strokeStyle = '#ffd166';
      ctx.beginPath();
      ctx.arc(p.x, p.y, s + 6, 0, Math.PI * 2);
      ctx.stroke();
    }
    if (scale > 1.1) {
      ctx.fillStyle = '#8da0b8';
      ctx.font = '8px ui-monospace, monospace';
      ctx.fillText(e.id, p.x + 7, p.y + 3);
    }
    ctx.globalAlpha = 1;
  }

  // Staged entities: draw at their declared position with a broken link icon.
  for (const [id, s] of scene.staged) {
    const p = toScreen(s.payload.x, s.payload.y);
    ctx.strokeStyle = '#ff8f6b';
    ctx.setLineDash([2, 3]);
    ctx.beginPath();
    ctx.arc(p.x, p.y, 5, 0, Math.PI * 2);
    ctx.stroke();
    ctx.setLineDash([]);
    ctx.fillStyle = '#ff8f6b';
    ctx.font = '8px ui-monospace, monospace';
    ctx.fillText(`?${s.missing || ''}`, p.x + 7, p.y + 3);
  }

  // Local observer marker.
  ctx.fillStyle = '#5ee1b3';
  ctx.beginPath();
  ctx.arc(me.x, me.y, 6, 0, Math.PI * 2);
  ctx.fill();
  ctx.strokeStyle = '#0b1017';
  ctx.lineWidth = 2;
  ctx.stroke();
  ctx.lineWidth = 1;
}

// ---- frame loop -----------------------------------------------------------

function round1(v) { return Math.round(v * 10) / 10; }
function round2(v) { return Math.round(v * 100) / 100; }
function clamp(v, lo, hi) { return Math.max(lo, Math.min(hi, v)); }
function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]));
}

function loop(nowMs) {
  keyboardStep();
  autopilotStep(nowMs);
  draw();
  requestAnimationFrame(loop);
}

// ---- boot -----------------------------------------------------------------

$('conn').textContent = 'connecting';
renderConn();
bindControls();
connect();
resize();
requestAnimationFrame(loop);
window.__wayline = { scene, state };
