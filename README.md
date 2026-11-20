# Wayline — interest-managed continuous world

A runnable demo of server-side interest management for a continuous multiplayer
world. The server keeps every entity for the whole session; each observer gets
only the subset it should see, over a budgeted network stream with a proper
create/destroy lifecycle.

```bash
npm install
npm start          # http://localhost:4173
npm test           # 26 unit + integration tests
```

No build step. `ws` is the only dependency.

## What is demonstrated

**Server-side filtering, not client-side hiding.** Every observer has a pose,
a view radius, a cone half-angle, a near radius, a team, and a pin list.
`server/session.js:queryInterest` computes the visible set on the server. The
full world state is never broadcast; the dashboard shows `built`/`subscribed`
against the 84-entity world.

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

**Instance generations.** Short entity ids are reused every time an observer
leaves and re-enters interest. Each (observer, id) pair therefore has a
generation counter (`session.js:instanceGen`): every create carries `g`, every
destroy is `{i, g}`, every update carries `n`. A destroy or delta whose
generation does not match the live instance is dropped and recorded as a
misbind — a delayed or replayed "delete E042" can never kill the fresh E042
that was born after it (`client/scene.js:_destroy`). Re-baselines of the same
generation still refresh in place, so object identity survives.

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

**Generation-checked pickup.** Each region has a claimable `cache`. A pickup
names the instance generation the client sees (`session.js:pickup`): a stale
generation is rejected (`stale-generation`), a live one claims the item, and a
claimed item rejects further claims (`already-claimed`). The original instance
of a re-created id can therefore never be looted twice.

## Instance lab

The dashboard's **Instance lab** card is a side-by-side per-instance trace:
what the server emitted for an id (left) versus what this client did with it
(right), generation by generation. A `FrameLab` (`server/lab.js`) sits between
the session and the socket so out-of-order delivery is reproducible on demand:

- **delay sub ×6t** — hold frames carrying creates (area subscription lag).
- **delay destroy ×6t** — hold frames carrying destroys; **release held**
  delivers them, e.g. after the re-create they were meant to precede.
- **replay destroy / replay create** — re-deliver the cached frame for the
  target id, like a stale cache hit.
- **pick up (current) / (stale)** — claim the target with the live or the
  previous generation, to watch the server reject the stale one.
- **save repro** — download the minimal packet sequence for the target: the
  create of the live instance (plus any ancestor creates it needs) followed by
  every later message, ending in the first misbound one.

When a message binds to the wrong generation, the client drops it, counts it,
and the red banner names the first misbound message. Replays are surgical:
only the addressed id's old generation is affected — a control object with an
ongoing interaction hold in the same scene is never rebuilt or reset.

## Layout

| Path | Role |
| --- | --- |
| `shared/protocol.js` | world constants, reasons, retention windows |
| `server/world.js` | deterministic world, authoritative simulation |
| `server/session.js` | interest query, replica lifecycle, generations, budget, retention |
| `server/lab.js` | frame-level fault injector (hold creates/destroys, replay cache) |
| `client/scene.js` | transport-free client replica shared by browser and tests |
| `server/index.js` | HTTP + WebSocket host, scripted observers, telemetry |
| `public/` | canvas dashboard: reasons, staging, network, instance lab, lifecycle log |
| `test/` | unit tests and real-WebSocket integration tests |

## Using the dashboard

- Drag on the map to move; arrow keys step precisely across region borders.
- Click an entity to pin it; double-click to interact; `p` / `i` do the same.
- "Autopilot" patrols the observer. Three scripted observers (a horizontal
  crosser, a vertical walker, a look-around pivot) run on the real protocol.
- Tighten the byte/op sliders to watch deferral and retry behaviour.
- In the Instance lab: track the nearest cache, walk out of its region until
  it is destroyed, walk back, then use **delay destroy** + **release held** or
  **replay destroy** to deliver the old destroy after the new create. The
  trace shows the stale message being dropped; **save repro** keeps the
  shortest packet sequence that reproduces the misbind.

## Protocol sketch

Client → server: `view {x,y,facing,view,budget}`, `ack {b}`, `pin {id,on}`,
`interact {id}`, `pickup {id,gen}`, `lab {op,ticks?,id?}`,
`report {tick,ids,unresolved,staged}`.

Server → client: `welcome`, `f {k,b?,c?,u?,d?}` (frame, baseline id, creates,
updates, destroys), `pickup-result`, `lab-result`, `telemetry` (4 Hz). Creates
carry full entity payloads plus `g` (instance generation); updates carry
`{i,v,x,y,n?,s?,g?}` (`n` = generation, `g` = region); destroys are
`{i,g}` (id + generation). Legacy plain-id destroys are still accepted by the
client and apply to the current instance.
