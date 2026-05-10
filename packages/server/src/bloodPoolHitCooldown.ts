/**
 * M8 US-011: server-local per-(poolId, enemyId) DoT cooldown for the
 * BloodPool DoT in tickBloodPools. Parallel structure to
 * orbitHitCooldown — same lazy-overwrite-on-read pattern, plus
 * evictEnemy (on enemy death) and evictPool (on pool expiry).
 *
 * Not on the schema: per-pool-per-enemy cooldown state has no use on
 * the client (rule 10 spirit — server-only counters do not pollute
 * schema; clients consume HitEvents, not cooldown state).
 */
export interface BloodPoolHitCooldownStore {
  tryHit(poolId: number, enemyId: number, nowMs: number, cooldownMs: number): boolean;
  evictEnemy(enemyId: number): void;
  evictPool(poolId: number): void;
}

function key(poolId: number, enemyId: number): string {
  return `${poolId}:${enemyId}`;
}

export function createBloodPoolHitCooldownStore(): BloodPoolHitCooldownStore {
  const lastHit = new Map<string, number>();

  return {
    tryHit(poolId, enemyId, nowMs, cooldownMs) {
      const k = key(poolId, enemyId);
      const prev = lastHit.get(k);
      if (prev !== undefined && nowMs - prev < cooldownMs) return false;
      lastHit.set(k, nowMs);
      return true;
    },

    evictEnemy(enemyId) {
      const suffix = `:${enemyId}`;
      for (const k of lastHit.keys()) {
        if (k.endsWith(suffix)) lastHit.delete(k);
      }
    },

    evictPool(poolId) {
      const prefix = `${poolId}:`;
      for (const k of lastHit.keys()) {
        if (k.startsWith(prefix)) lastHit.delete(k);
      }
    },
  };
}
