/**
 * Server-local per-(player, weaponIndex, enemy) hit cooldown for orbit-
 * behavior weapons. Per spec §AD7: not on the schema (clients have no use
 * for this value, syncing it would balloon snapshots).
 *
 * `weaponIndex` is the player's `weapons[]` array index. Stable for the
 * lifetime of the weapon: server only pushes to weapons[], never reorders
 * or splices.
 *
 * Eviction (defense in depth):
 *  - tryHit: lazy, overwrites expired entries on read.
 *  - evictEnemy: called from rules.ts on enemy death (both projectile path
 *    and orbit-arm path call this).
 *  - evictPlayer: called from GameRoom.onLeave on schema delete.
 *  - sweep: periodic safety net; drops entries older than the longest
 *    cooldown configured anywhere in WEAPON_KINDS.
 */
export interface OrbitHitCooldownStore {
  /**
   * Returns true and updates last-hit if the cooldown elapsed; false otherwise.
   * `nowMs` is the server's wallclock (Date.now()-style); `cooldownMs` is the
   * weapon's per-enemy hit cooldown for the level being applied.
   */
  tryHit(playerId: string, weaponIndex: number, enemyId: number, nowMs: number, cooldownMs: number): boolean;
  evictPlayer(playerId: string): void;
  evictEnemy(enemyId: number): void;
  /** Drop entries older than maxCooldownMs at nowMs. */
  sweep(nowMs: number, maxCooldownMs: number): void;
}

function key(playerId: string, weaponIndex: number, enemyId: number): string {
  return `${playerId}:${weaponIndex}:${enemyId}`;
}

export function createOrbitHitCooldownStore(): OrbitHitCooldownStore {
  const lastHit = new Map<string, number>();

  return {
    tryHit(playerId, weaponIndex, enemyId, nowMs, cooldownMs) {
      const k = key(playerId, weaponIndex, enemyId);
      const prev = lastHit.get(k);
      if (prev !== undefined && nowMs - prev < cooldownMs) return false;
      lastHit.set(k, nowMs);
      return true;
    },

    evictPlayer(playerId) {
      const prefix = `${playerId}:`;
      for (const k of lastHit.keys()) {
        if (k.startsWith(prefix)) lastHit.delete(k);
      }
    },

    evictEnemy(enemyId) {
      const suffix = `:${enemyId}`;
      for (const k of lastHit.keys()) {
        if (k.endsWith(suffix)) lastHit.delete(k);
      }
    },

    sweep(nowMs, maxCooldownMs) {
      for (const [k, t] of lastHit.entries()) {
        if (nowMs - t >= maxCooldownMs) lastHit.delete(k);
      }
    },
  };
}

/**
 * Compute the longest hit-cooldown across all orbit-behavior weapon levels
 * in WEAPON_KINDS. Used as the `maxCooldownMs` argument to sweep().
 */
export function maxOrbitHitCooldownMs(
  weaponKinds: readonly { behavior: { kind: string }; levels: ReadonlyArray<{ hitCooldownPerEnemyMs?: number }> }[],
): number {
  let max = 0;
  for (const def of weaponKinds) {
    if (def.behavior.kind !== "orbit") continue;
    for (const lvl of def.levels) {
      const c = lvl.hitCooldownPerEnemyMs ?? 0;
      if (c > max) max = c;
    }
  }
  return max;
}
