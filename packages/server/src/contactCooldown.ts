/**
 * Server-local per-(player, enemy) contact-damage cooldown. Per spec §AD3:
 * not on the schema (clients have no use for this value).
 *
 * Eviction:
 *  - tryHit: lazy, overwrites expired entries on read.
 *  - evictEnemy: called from GameRoom when an enemy dies (parallel path to
 *    orbitHitCooldown.evictEnemy).
 *  - evictPlayer: called from GameRoom.onLeave on schema delete.
 *  - sweep: periodic safety net; drops entries older than the longest
 *    cooldown configured (here just ENEMY_CONTACT_COOLDOWN_S * 1000).
 */
export interface ContactCooldownStore {
  tryHit(playerId: string, enemyId: number, nowMs: number, cooldownMs: number): boolean;
  evictPlayer(playerId: string): void;
  evictEnemy(enemyId: number): void;
  sweep(nowMs: number, maxCooldownMs: number): void;
}

function key(playerId: string, enemyId: number): string {
  return `${playerId}:${enemyId}`;
}

export function createContactCooldownStore(): ContactCooldownStore {
  const lastHit = new Map<string, number>();

  return {
    tryHit(playerId, enemyId, nowMs, cooldownMs) {
      const k = key(playerId, enemyId);
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
