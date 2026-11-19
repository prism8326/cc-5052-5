# Wayline — interest-managed continuous world

A runnable demo of server-side interest management for a continuous multiplayer
world. The server keeps every entity for the whole session; each observer gets
only the subset it should see, over a budgeted network stream with a proper
create/destroy lifecycle.

```bash
npm install
npm start          # http://localhost:4173
npm test           # 18 unit + integration tests
```

No build step. `ws` is the only dependency.

## What is demonstrated

**Server-side filtering, not client-side hiding.** Every observer has a pose,
a view radius, a cone half-angle, a near radius, a team, and a pin list.
`server/session.js:queryInterest` computes the visible set on the server. The
full world state is never broadcast; the dashboard shows `built`/`subscribed`
against the 72-entity world.

**Declared relationships.** Interest is not only positional:
- `team-link` — squad members replicate at any distance.
- `pinned` — observer-chosen focal entities.
- `dependency` — every ancestor of a subscribed child is pulled in, so a
  child's `parentId` always resolves. Parents are created before children, and
  destroyed after them (`server/session.js:emit`).

**Baseline before delta.** A create is a full baseline tied to a baseline id.
The server sends updates for an entity only after the client acks that
baseline; unacked baselines are retried at a fixed cadence
(`session.js:retryBaselines`). The client refuses deltas for unknown entities
and for staged children (`client/scene.js:_applyUpdates`).

**Missing dependencies are staged, explicitly.** If a child's parent has not
arrived, the child is held in `ClientScene.staged` with a `missing` id and is
visible in the panel. It is never half-built, and its deltas are not adopted.

**Interest hysteresis.** Leaving the cone starts a grace window
(`GRACE_TICKS`), and interacting sets a hold (`INTERACT_HOLD_TICKS`). A camera
turn therefore neither destroys active objects nor hands out fresh identities.
Scene objects keep stable identity for as long as the id stays subscribed; the
browser and tests assert object identity across turns and updates.

**Budgeted replication.** Each observer has byte and op budgets per tick.
Creates are parent-first, destroys child-first, updates are prioritised by
reason and distance, and everything over budget is deferred — never truncated
mid-reference (`session.js:emit`).

**Leaving view ≠ deleting.** A destroy is a replica-only message; the server
entity is untouched. The test "leaving interest destroys only the replica"
checks every released id still exists in `world.entities`.

## Layout

| Path | Role |
| --- | --- |
| `shared/protocol.js` | world constants, reasons, retention windows |
| `server/world.js` | deterministic world, authoritative simulation |
| `server/session.js` | interest query, replica lifecycle, budget, retention |
| `client/scene.js` | transport-free client replica shared by browser and tests |
| `server/index.js` | HTTP + WebSocket host, scripted observers, telemetry |
| `public/` | canvas dashboard: reasons, staging, network, lifecycle log |
| `test/` | unit tests and real-WebSocket integration tests |

## Using the dashboard

- Drag on the map to move; arrow keys step precisely across region borders.
- Click an entity to pin it; double-click to interact; `p` / `i` do the same.
- "Autopilot" patrols the observer. Three scripted observers (a horizontal
  crosser, a vertical walker, a look-around pivot) run on the real protocol.
- Tighten the byte/op sliders to watch deferral and retry behaviour.

## Protocol sketch

Client → server: `view {x,y,facing,view,budget}`, `ack {b}`, `pin {id,on}`,
`interact {id}`, `report {tick,ids,unresolved,staged}`.

Server → client: `welcome`, `f {k,b?,c?,u?,d?}` (frame, baseline id, creates,
updates, destroys), `telemetry` (4 Hz). Creates carry full entity payloads;
updates carry `{i,v,x,y,s?,g?}`; destroys are id strings.
