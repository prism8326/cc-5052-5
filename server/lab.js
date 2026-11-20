// Frame-level fault injector for the instance lab. It sits between a session
// and its transport so out-of-order delivery can be reproduced on demand:
//  * delay-creates  — hold frames that carry creates (area subscription lag)
//  * delay-destroys — hold frames that carry destroys
//  * replay         — re-deliver a cached frame (a stale cache hit)
// Held frames flush in send order once their due tick passes or clear() runs.

export class FrameLab {
  constructor(deliver) {
    this.deliver = deliver;
    this.holdCreatesUntil = -1;
    this.holdDestroysUntil = -1;
    this.held = [];   // { raw, due }
    this.cache = [];  // recent delivered frames, oldest first
    this.tick = 0;
    this.replays = 0;
  }

  send(raw) {
    let frame;
    try { frame = JSON.parse(raw); } catch { this._deliver(raw); return; }
    if (frame.t !== 'f') { this._deliver(raw); return; }
    let due = -1;
    if (frame.c && this.tick < this.holdCreatesUntil) due = this.holdCreatesUntil;
    if (frame.d && this.tick < this.holdDestroysUntil) due = Math.max(due, this.holdDestroysUntil);
    if (due > 0) { this.held.push({ raw, due }); return; }
    this._deliver(raw);
  }

  _deliver(raw) {
    this.cache.push(raw);
    if (this.cache.length > 80) this.cache.shift();
    this.deliver(raw);
  }

  step(tick) {
    this.tick = tick;
    if (!this.held.length) return;
    const due = this.held.filter((h) => h.due <= tick);
    if (!due.length) return;
    this.held = this.held.filter((h) => h.due > tick);
    for (const h of due) this._deliver(h.raw);
  }

  delayCreates(ticks) { this.holdCreatesUntil = this.tick + Math.max(1, ticks | 0); }
  delayDestroys(ticks) { this.holdDestroysUntil = this.tick + Math.max(1, ticks | 0); }

  // Re-deliver the newest cached frame matching `match`. Returns true if one
  // was found. The frame is delivered as-is, exactly like a stale cache hit.
  _replay(match) {
    for (let i = this.cache.length - 1; i >= 0; i--) {
      let frame;
      try { frame = JSON.parse(this.cache[i]); } catch { continue; }
      if (frame.t !== 'f') continue;
      if (!match(frame)) continue;
      this.replays++;
      this.deliver(this.cache[i]);
      return true;
    }
    return false;
  }

  replayDestroy(id) {
    return this._replay((f) => Array.isArray(f.d) &&
      f.d.some((ref) => (typeof ref === 'object' ? ref.i : ref) === id));
  }

  replayCreate(id) {
    return this._replay((f) => Array.isArray(f.c) && f.c.some((e) => e.id === id));
  }

  // Release every held frame in order and disarm the delays.
  clear() {
    this.holdCreatesUntil = -1;
    this.holdDestroysUntil = -1;
    const pending = this.held;
    this.held = [];
    for (const h of pending) this._deliver(h.raw);
    return pending.length;
  }
}
