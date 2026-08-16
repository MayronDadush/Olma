'use strict';
// In-memory sliding-window flood counter — the short-horizon protection that
// deliberately does NOT live in usage_ledger/quota_counters (wrong resolution,
// wrong retention). Lives in brokerd precisely because brokerd is the one
// process that stays alive between turns.

class FloodCounter {
  constructor({ limitPerMinute = 20, windowMs = 60_000 } = {}) {
    this.limit = limitPerMinute;
    this.windowMs = windowMs;
    this.hits = new Map(); // userId -> [timestamps]
  }

  // Records a hit and reports whether this user is over the per-minute limit.
  isFlooding(userId, now = Date.now()) {
    const cutoff = now - this.windowMs;
    const arr = (this.hits.get(userId) || []).filter((t) => t > cutoff);
    arr.push(now);
    this.hits.set(userId, arr);
    return arr.length > this.limit;
  }

  // Periodic cleanup so the map doesn't grow with dormant users.
  sweep(now = Date.now()) {
    const cutoff = now - this.windowMs;
    for (const [uid, arr] of this.hits) {
      const kept = arr.filter((t) => t > cutoff);
      if (kept.length === 0) this.hits.delete(uid);
      else this.hits.set(uid, kept);
    }
  }
}

module.exports = { FloodCounter };
