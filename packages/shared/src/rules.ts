import {
  Enemy,
  Gem,
  BloodPool,
  WeaponState,
  ItemState,
  LevelUpChoice,
  LEVEL_UP_CHOICE_WEAPON,
  LEVEL_UP_CHOICE_ITEM,
  type Player,
  type RoomState,
} from "./schema.js";
import {
  ITEM_KINDS,
  itemValueAt,
  NEUTRAL_MULTIPLIER,
  type ItemEffect,
} from "./items.js";
import {
  COYOTE_TIME,
  ENEMY_CONTACT_COOLDOWN_S,
  ENEMY_CONTACT_DAMAGE,
  ENEMY_DESPAWN_RADIUS,
  ENEMY_GROUND_OFFSET,
  ENEMY_HP,
  ENEMY_RADIUS,
  ENEMY_SPAWN_INTERVAL_S,
  ENEMY_SPAWN_RADIUS,
  ENEMY_SPEED,
  FLYING_ENEMY_ALTITUDE,
  GEM_FAN_RADIUS,
  GEM_PICKUP_RADIUS,
  GEM_VALUE,
  GRAVITY,
  JUMP_BUFFER,
  JUMP_VELOCITY,
  LEVEL_UP_DEADLINE_TICKS,
  MAP_RADIUS,
  MAX_ENEMIES,
  PLAYER_GROUND_OFFSET,
  PLAYER_MAX_HP,
  PLAYER_RADIUS,
  PLAYER_SPEED,
  TARGETING_MAX_RANGE,
  TERMINAL_FALL_SPEED,
  TICK_RATE,
  xpForLevel,
} from "./constants.js";
import { terrainHeight } from "./terrain.js";
import { WEAPON_KINDS, statsAt, isProjectileWeapon, isOrbitWeapon, isMeleeArcWeapon, isAuraWeapon, isBoomerangWeapon, type WeaponDef, type TargetingMode, type MeleeArcWeaponDef, type AuraWeaponDef, type BoomerangWeaponDef, type BoomerangLevel } from "./weapons.js";
import { ENEMY_KINDS, enemyDefAt } from "./enemies.js";
import type { Rng } from "./rng.js";
import type {
  FireEvent,
  HitEvent,
  EnemyDiedEvent,
  GemCollectedEvent,
  LevelUpOfferedEvent,
  LevelUpResolvedEvent,
  PlayerDamagedEvent,
  PlayerDownedEvent,
  RunEndedEvent,
  MeleeSwipeEvent,
  BoomerangThrownEvent,
  LevelUpChoicePayload,
} from "./messages.js";

/**
 * Jump-forgiveness predicate (M7 US-010). True if the player is on the ground
 * OR they walked off a ledge within the last COYOTE_TIME seconds. Exported so
 * tests can verify the boundary; tickPlayers also calls it twice per tick
 * (once at jump-intent resolve, once at the post-snap buffered-jump check).
 *
 * `tick` is the current state.tick. `lastGroundedAt` is the latest tick the
 * player was grounded at end of phase 2 (always non-negative — see
 * tickPlayers' phase 3 update + ctor init in schema.ts).
 *
 * Argument is structural so the client predictor (M7 US-011) can call this
 * with its own non-Schema state object — both call paths share identical
 * coyote semantics, which is what keeps prediction in lockstep with server.
 */
/**
 * M9 US-002: single source of effect-multiplier lookup for passive
 * items. Walks `player.items`, multiplicatively accumulates the value
 * of every item whose `effect` matches, returns NEUTRAL_MULTIPLIER (1.0)
 * if no items match.
 *
 * Dispatches on the `effect` enum value ONLY — never on item name
 * (CLAUDE.md rule 12). Adding a new ItemEffect requires (a) extending
 * the union in items.ts, and (b) wiring the call at the new effect's
 * application site; this helper is unchanged.
 *
 * Stacking semantics: multiplicative. If a player owned two
 * damage_mult items at L1 (1.10 each), the combined multiplier would
 * be 1.21. In M9 there's one item per effect kind, so the multi-stack
 * path is defensive; future milestones may add second-effect items.
 *
 * Hot-path note: O(player.items.length) per call. Called from damage
 * emit sites (≤ 6 calls per damage tick across all enemies in radius),
 * cooldown set sites (once per fire), tickPlayers (once per player per
 * tick), tickGems (cached once per player at the start of the tick),
 * and item pickup. items.length ≤ 6 in M9 — net cost is negligible.
 */
export function getItemMultiplier(player: Player, effect: ItemEffect): number {
  let mult = NEUTRAL_MULTIPLIER;
  for (let i = 0; i < player.items.length; i++) {
    const item = player.items[i]!;
    const def = ITEM_KINDS[item.kind];
    if (def && def.effect === effect && item.level > 0) {
      mult *= itemValueAt(def, item.level);
    }
  }
  return mult;
}

export function canJump(
  state: { grounded: boolean; lastGroundedAt: number },
  tick: number,
): boolean {
  if (state.grounded) return true;
  return (tick - state.lastGroundedAt) * (1 / TICK_RATE) <= COYOTE_TIME;
}

/**
 * M10: shared "an enemy died this frame" path. Replaces the
 * six copy-pasted death-handling blocks across tickWeapons
 * (orbit), runMeleeArcSwing, runAuraTick, tickProjectiles,
 * tickBoomerangs, and tickBloodPools.
 *
 * Behavior (preserves pre-M10 semantics for slime exactly):
 *   - Look up the kind's gemDropCount.
 *   - Spawn 1 gem at (enemy.x, enemy.z) when gemDropCount === 1
 *     (preserves the M3 spawn position for slimes — the existing
 *     determinism test asserts this exact position).
 *   - Spawn N gems in an evenly-spaced ring at GEM_FAN_RADIUS for
 *     N > 1. Angles are `(i / N) * 2π` — deterministic, no rng.
 *   - Delete the enemy from state.enemies, evict orbit-hit cooldown,
 *     emit enemy_died.
 *
 * Caller responsibilities (intentionally NOT inside the helper):
 *   - Crediting the kill to `player.kills += 1` (caller knows the killer)
 *   - boomerang/projectile-specific bookkeeping (pierceRemaining, etc.)
 */
export function spawnGemFanAndEmitDeath(
  state: RoomState,
  enemy: Enemy,
  ctx: { nextGemId: () => number; orbitHitCooldown: OrbitHitCooldownLike },
  emit: Emit,
): void {
  const def = enemyDefAt(enemy.kind);
  const deathX = enemy.x;
  const deathZ = enemy.z;
  const deathId = enemy.id;
  const count = Math.max(1, def.gemDropCount | 0);

  if (count === 1) {
    const gem = new Gem();
    gem.id = ctx.nextGemId();
    gem.x = deathX;
    gem.z = deathZ;
    gem.value = GEM_VALUE;
    state.gems.set(String(gem.id), gem);
  } else {
    for (let i = 0; i < count; i++) {
      const angle = (i / count) * Math.PI * 2;   // deterministic — no rng
      const gem = new Gem();
      gem.id = ctx.nextGemId();
      gem.x = deathX + Math.cos(angle) * GEM_FAN_RADIUS;
      gem.z = deathZ + Math.sin(angle) * GEM_FAN_RADIUS;
      gem.value = GEM_VALUE;
      state.gems.set(String(gem.id), gem);
    }
  }

  state.enemies.delete(String(deathId));
  ctx.orbitHitCooldown.evictEnemy(deathId);

  emit({
    type: "enemy_died",
    enemyId: deathId,
    x: deathX,
    z: deathZ,
  });
}

/**
 * `jumpRequests` is a per-tick set of sessionIds that pressed jump on this
 * input window — a transient input intent, not synced state. The room
 * collects intents as input messages arrive (one entry per player whose
 * latest input had `jump=true`) and clears the set after `tickPlayers`
 * returns so the next tick starts empty. Per CLAUDE.md rule 4, the room
 * handler stays thin: it records intent; this function decides outcome.
 *
 * The set is read-only here — clearing/draining is the room's job, not
 * ours. Optional so test cases that don't exercise jump can omit it.
 */
export function tickPlayers(
  state: RoomState,
  dt: number,
  jumpRequests?: ReadonlySet<string>,
): void {
  if (state.runEnded) return;
  const max2 = MAP_RADIUS * MAP_RADIUS;
  state.players.forEach((p) => {
    if (p.downed) return;
    // M9 US-004: Sleipnir (speed_mult) multiplies PLAYER_SPEED. Default
    // 1.0 (no items) preserves M5–M8 behavior — existing tickPlayers
    // tests stay green.
    const speedMult = getItemMultiplier(p, "speed_mult");
    p.x += p.inputDir.x * PLAYER_SPEED * speedMult * dt;
    p.z += p.inputDir.z * PLAYER_SPEED * speedMult * dt;
    const r2 = p.x * p.x + p.z * p.z;
    if (r2 > max2) {
      const scale = MAP_RADIUS / Math.sqrt(r2);
      p.x *= scale;
      p.z *= scale;
    }

    // M7 US-009 + US-010: jump physics with forgiveness.
    //
    // Phase 1 — Resolve direct jump intent (this tick's input).
    //   If canJump (grounded OR within coyote): fire immediately, clear any
    //     stale buffer.
    //   Else: record press as jumpBufferedAt = state.tick. The latest press
    //     wins if multiple arrive within the same window (rare).
    // Phase 2 — Gravity, integrate Y, ground-snap.
    //   Apply -GRAVITY*dt to vy (clamped at TERMINAL_FALL_SPEED), integrate Y.
    //   If Y has fallen at or below the terrain surface, clamp Y to it, zero
    //     vy, set grounded=true. Otherwise grounded=false.
    // Phase 3 — Update lastGroundedAt if grounded at end of phase 2.
    //   This is what canJump's coyote arm reads on later ticks.
    // Phase 4 — Consume buffered jump.
    //   If a buffer is set AND canJump is now true (grounded just-now or
    //     coyote) AND the buffer is within JUMP_BUFFER seconds, fire the jump
    //     and clear the buffer. This is what makes "press just before
    //     landing" execute on the landing tick — phase 2 sets grounded=true,
    //     phase 4 reads it and fires.
    //
    // Ordering note: phase 1 fires BEFORE gravity so a same-tick press still
    // produces one frame of pre-gravity vy (matches US-009 behavior). Phase
    // 4 fires AFTER snap so the buffered press gets to use the just-restored
    // grounded=true. Phase 1 + phase 4 cannot both fire in the same tick on
    // the same player: phase 1 either fires (clearing the buffer) or buffers
    // (canJump was false); phase 4 only consumes buffers and only when
    // canJump is true. The only way phase 4 fires the SAME-tick press is if
    // phase 1 buffered (out of coyote) and phase 2's ground-snap made canJump
    // newly true — that's the design.
    const intent = jumpRequests?.has(p.sessionId) ?? false;
    if (intent) {
      if (canJump(p, state.tick)) {
        p.vy = JUMP_VELOCITY;
        p.grounded = false;
        p.jumpBufferedAt = -1;
      } else {
        p.jumpBufferedAt = state.tick;
      }
    }
    p.vy = Math.max(p.vy - GRAVITY * dt, -TERMINAL_FALL_SPEED);
    p.y += p.vy * dt;

    const groundY = terrainHeight(p.x, p.z) + PLAYER_GROUND_OFFSET;
    if (p.y <= groundY) {
      p.y = groundY;
      p.vy = 0;
      p.grounded = true;
    } else {
      p.grounded = false;
    }

    if (p.grounded) p.lastGroundedAt = state.tick;

    if (
      p.jumpBufferedAt !== -1 &&
      canJump(p, state.tick) &&
      (state.tick - p.jumpBufferedAt) * (1 / TICK_RATE) <= JUMP_BUFFER
    ) {
      p.vy = JUMP_VELOCITY;
      p.grounded = false;
      p.jumpBufferedAt = -1;
    }

    // M7 US-006: derive facing from movement direction. Input no longer
    // carries facing (clients send camera-relative WASD transformed to
    // world space; server is the only authority that decides where the
    // player faces). When stopped (zero inputDir), the previous facing
    // is held — this keeps the body rotation stable between bursts of
    // movement.
    const dirLen = Math.hypot(p.inputDir.x, p.inputDir.z);
    if (dirLen > 0) {
      p.facingX = p.inputDir.x / dirLen;
      p.facingZ = p.inputDir.z / dirLen;
    }
  });
}

/**
 * Each enemy steps toward its nearest player by ENEMY_SPEED * dt. No-op if
 * there are no players. Coincident enemy/player produces no NaN (zero step).
 *
 * Hot loop: squared-distance comparison for "which player is nearest" (no
 * Math.hypot per pair); one Math.sqrt per enemy for the normalized step.
 * Allocates only function-scope locals.
 */
/**
 * M8 US-009: apply a slow to an enemy. "Stronger wins, ignore duration"
 * per design doc resolution A2: a longer-but-weaker slow does NOT
 * extend a shorter-but-stronger slow's expiry. The strong slow expires
 * on schedule and the weaker slow re-applies on the next interaction.
 *
 *   - If no slow is active (slowExpiresAt < currentTick OR === -1):
 *     overwrite — apply the new slow.
 *   - If a slow is active AND the existing multiplier is at LEAST as
 *     strong (smaller-or-equal): keep the existing slow, ignore the
 *     incoming.
 *   - Otherwise (incoming is strictly stronger): overwrite.
 *
 * Pure mutation — no rng, no side effects beyond the enemy. Single
 * source of slow application; do not mutate `slowMultiplier` /
 * `slowExpiresAt` directly elsewhere (tickStatusEffects is the only
 * other writer, and it only resets to defaults on expiry).
 */
export function applySlow(
  enemy: Enemy,
  multiplier: number,
  durationTicks: number,
  currentTick: number,
): void {
  const slowActive = enemy.slowExpiresAt !== -1 && enemy.slowExpiresAt > currentTick;
  if (slowActive && enemy.slowMultiplier <= multiplier) {
    // Existing slow is at least as strong (smaller or equal multiplier
    // = stronger or equal slow). Do nothing.
    return;
  }
  enemy.slowMultiplier = multiplier;
  enemy.slowExpiresAt = currentTick + durationTicks;
}

/**
 * M8 US-009: clear status effects whose expiry tick has passed.
 * Inserted in the tick order BEFORE tickEnemies (CLAUDE.md rule 11) so
 * an enemy whose slow expires this tick is moved at full speed in the
 * same tick. Universal early-out on runEnded.
 *
 * Doesn't consume rng; the per-tick rng schedule (xp + spawner) is
 * unaffected by this insertion.
 */
export function tickStatusEffects(state: RoomState, currentTick: number): void {
  if (state.runEnded) return;
  state.enemies.forEach((enemy: Enemy) => {
    if (enemy.slowExpiresAt !== -1 && enemy.slowExpiresAt < currentTick) {
      enemy.slowMultiplier = 1;
      enemy.slowExpiresAt = -1;
    }
  });
}

export function tickEnemies(state: RoomState, dt: number): void {
  if (state.runEnded) return;
  if (state.players.size === 0) return;

  const despawnSq = ENEMY_DESPAWN_RADIUS * ENEMY_DESPAWN_RADIUS;
  const toDespawn: number[] = [];

  state.enemies.forEach((enemy: Enemy) => {
    const def = enemyDefAt(enemy.kind);

    let nearestDx = 0;
    let nearestDz = 0;
    let nearestSq = Infinity;

    state.players.forEach((p: Player) => {
      if (p.downed) return;
      const dx = p.x - enemy.x;
      const dz = p.z - enemy.z;
      const sq = dx * dx + dz * dz;
      if (sq < nearestSq) {
        nearestSq = sq;
        nearestDx = dx;
        nearestDz = dz;
      }
    });

    if (nearestSq === Infinity) {
      // No living players — freeze in place horizontally, but still snap Y.
      enemy.y = terrainHeight(enemy.x, enemy.z)
              + (def.flying ? FLYING_ENEMY_ALTITUDE : ENEMY_GROUND_OFFSET);
      return;
    }
    if (nearestSq > despawnSq) {
      toDespawn.push(enemy.id);
      return;
    }

    // M10: skip movement while winding up a boss ability. abilityFireAt
    // is -1 for non-bosses (set in the schema ctor + spawn paths) so the
    // branch is a no-op for them — single conditional on a int32 field.
    const isWindingUp = enemy.abilityFireAt > 0;

    if (nearestSq !== 0 && !isWindingUp) {
      const dist = Math.sqrt(nearestSq);
      // M10: per-kind speed multiplier. Slime preserves baseline 1.0.
      const step = ENEMY_SPEED * dt * def.speedMultiplier * enemy.slowMultiplier;
      enemy.x += (nearestDx / dist) * step;
      enemy.z += (nearestDz / dist) * step;
    }
    // M10: per-kind terrain snap. Flying enemies float at a constant
    // altitude above whatever ground is beneath them.
    enemy.y = terrainHeight(enemy.x, enemy.z)
            + (def.flying ? FLYING_ENEMY_ALTITUDE : ENEMY_GROUND_OFFSET);
  });

  for (const id of toDespawn) state.enemies.delete(String(id));
}

export type SpawnerState = {
  accumulator: number;   // seconds since last spawn
  nextEnemyId: number;   // monotonic; starts at 1 so id=0 is never valid
};

/**
 * M10: weighted-random kind pick over the currently-unlocked, non-boss
 * rows of ENEMY_KINDS. Single rng() call per pick. Deterministic
 * single-pass filter + accumulate — the loop runs ENEMY_KINDS.length
 * iterations regardless of which kind is picked, so spawn behavior is
 * order-independent across server/client.
 *
 * If totalWeight === 0 (e.g., earliest tick with no kinds unlocked
 * yet), falls back to kind 0 (slime), which is always spawnable at
 * tick=0 since its minSpawnTick is 0 and spawnWeight is positive.
 */
function pickEnemyKind(currentTick: number, rng: Rng): number {
  let totalWeight = 0;
  for (let i = 0; i < ENEMY_KINDS.length; i++) {
    const def = ENEMY_KINDS[i]!;
    if (def.isBoss) continue;
    if (currentTick < def.minSpawnTick) continue;
    totalWeight += def.spawnWeight;
  }
  if (totalWeight <= 0) return 0;
  let r = rng() * totalWeight;
  for (let i = 0; i < ENEMY_KINDS.length; i++) {
    const def = ENEMY_KINDS[i]!;
    if (def.isBoss) continue;
    if (currentTick < def.minSpawnTick) continue;
    r -= def.spawnWeight;
    if (r <= 0) return i;
  }
  return 0;
}

/**
 * Advance the spawn timer; emit enemies when the interval elapses.
 * No-op (and does NOT advance the accumulator) when the room is empty —
 * this avoids "join into a swarm" when a player joins a long-empty room.
 *
 * When state.enemies.size >= MAX_ENEMIES, drain the accumulator on the
 * same call. Reasoning: if it stalled, the moment one enemy was removed
 * (next milestone, when combat lands) we'd flood. Drain is the right
 * default.
 *
 * M6: Only non-downed players are eligible spawn anchors. If all players
 * are downed, bail early (run will end this tick anyway). Spawn positions
 * are clamped to MAP_RADIUS via a retry-3 loop; if all retries land
 * outside the map, the slot is skipped (accumulator still decremented).
 */
export function tickSpawner(
  state: RoomState,
  spawner: SpawnerState,
  dt: number,
  rng: Rng,
): void {
  if (state.runEnded) return;
  if (state.players.size === 0) return;

  // Count non-downed players; bail if all are downed (run will end this tick anyway).
  let liveCount = 0;
  state.players.forEach((p) => { if (!p.downed) liveCount += 1; });
  if (liveCount === 0) return;

  spawner.accumulator += dt;
  const map2 = MAP_RADIUS * MAP_RADIUS;

  while (spawner.accumulator >= ENEMY_SPAWN_INTERVAL_S) {
    if (state.enemies.size >= MAX_ENEMIES) {
      spawner.accumulator = 0;
      return;
    }

    // M10: kind pick — 1 rng() call. Must happen BEFORE the player + angle
    // picks; placed outside the angle retry loop so each spawn attempt
    // picks one kind regardless of how many angle retries it takes.
    const kind = pickEnemyKind(state.tick, rng);
    const def = enemyDefAt(kind);

    // Pick a random non-downed player. (unchanged)
    const liveIdx = Math.floor(rng() * liveCount);
    let i = 0;
    let target: Player | undefined;
    state.players.forEach((p) => {
      if (p.downed) return;
      if (i === liveIdx) target = p;
      i++;
    });
    if (!target) {
      throw new Error(
        `tickSpawner: unreachable — liveIdx=${liveIdx} out of range for liveCount=${liveCount}`,
      );
    }

    // Try up to 3 angles to land inside MAP_RADIUS; skip this slot if all fail.
    let placed = false;
    for (let attempt = 0; attempt < 3 && !placed; attempt++) {
      const angle = rng() * Math.PI * 2;
      const x = target.x + Math.cos(angle) * ENEMY_SPAWN_RADIUS;
      const z = target.z + Math.sin(angle) * ENEMY_SPAWN_RADIUS;
      if (x * x + z * z > map2) continue;
      const enemy = new Enemy();
      enemy.id = spawner.nextEnemyId++;
      enemy.kind = kind;
      enemy.x = x;
      enemy.z = z;
      enemy.y = terrainHeight(x, z)
              + (def.flying ? FLYING_ENEMY_ALTITUDE : ENEMY_GROUND_OFFSET);
      enemy.hp = def.baseHp;
      enemy.maxHp = def.baseHp;
      state.enemies.set(String(enemy.id), enemy);
      placed = true;
    }

    spawner.accumulator -= ENEMY_SPAWN_INTERVAL_S;
  }
}

/**
 * Used by the server's debug_spawn handler. Places `count` enemies (clamped
 * to MAX_ENEMIES - current) at random angles around centerPlayer at
 * ENEMY_SPAWN_RADIUS. Uses the same rng + nextEnemyId as the auto-spawner —
 * a burst does NOT desync future deterministic spawns.
 */
export function spawnDebugBurst(
  state: RoomState,
  spawner: SpawnerState,
  rng: Rng,
  centerPlayer: Player,
  count: number,
  kind: number,
): void {
  const remaining = MAX_ENEMIES - state.enemies.size;
  const n = Math.max(0, Math.min(count, remaining));
  const def = enemyDefAt(kind);

  for (let i = 0; i < n; i++) {
    const angle = rng() * Math.PI * 2;
    const enemy = new Enemy();
    enemy.id = spawner.nextEnemyId++;
    enemy.kind = kind;
    enemy.x = centerPlayer.x + Math.cos(angle) * ENEMY_SPAWN_RADIUS;
    enemy.z = centerPlayer.z + Math.sin(angle) * ENEMY_SPAWN_RADIUS;
    enemy.y = terrainHeight(enemy.x, enemy.z)
            + (def.flying ? FLYING_ENEMY_ALTITUDE : ENEMY_GROUND_OFFSET);
    enemy.hp = def.baseHp;
    enemy.maxHp = def.baseHp;
    state.enemies.set(String(enemy.id), enemy);
  }
}

// --------------------- M4 combat ---------------------

export type Projectile = {
  fireId: number;
  ownerId: string;
  weaponKind: number;
  damage: number;
  speed: number;
  radius: number;
  lifetime: number;
  age: number;
  // M7 US-013: 3D motion. dirX/dirY/dirZ together form a unit-length 3D
  // vector — `speed` is the scalar magnitude, identical to the 2D era.
  // prev{X,Y,Z} are written at the start of every tick for the
  // swept-sphere test; the test extends naturally from 2D segment-vs-disk
  // to 3D segment-vs-sphere by adding a Y component to every dot/length.
  dirX: number;
  dirY: number;
  dirZ: number;
  prevX: number;
  prevY: number;
  prevZ: number;
  x: number;
  y: number;
  z: number;
  // M8 US-002: enemy locked at fire time (-1 = no lock). Used by tickProjectiles
  // for homing — slerp dir toward target each tick — and emitted on FireEvent
  // so client closed-form sim agrees with server. Per open-question A3, no
  // re-acquire on death: a homing projectile whose locked target dies just
  // continues on its current heading.
  lockedTargetId: number;
  // M8 US-002: rad/sec. 0 = straight-line (current Bolt behavior). >0 enables
  // homing toward `lockedTargetId` capped at this turn rate. Baked onto the
  // projectile at fire so the value can't drift mid-flight on a level-up.
  homingTurnRate: number;
  // M8 US-002: hits remaining before despawn. Baked from
  // ProjectileLevel.pierceCount at fire. -1 = infinite (never decrements;
  // only lifetime expiry despawns). 1 = M5 Bolt baseline (single-hit drop).
  pierceRemaining: number;
  hitCooldownPerEnemyMs: number;
  // M8 US-002: per-projectile-per-enemy last-hit ms wallclock. Server-only
  // off-schema state (rule 10 spirit). Used by tickProjectiles to gate
  // re-hits when hitCooldownPerEnemyMs > 0.
  enemyHitCooldownsMs: Map<number, number>;
};

/**
 * M8 US-011: server-only state for an in-flight Bloody Axe (or future
 * boomerang weapons). Travels in 2 phases: outbound (fly out from
 * `originX/Z` along `dirX/Z` at `outboundSpeed` for `outboundDistance`
 * units), then return (turn around and fly toward owner.x/z at
 * `returnSpeed`). Y stays constant at `originY` — boomerangs travel
 * horizontally even when the owner jumps.
 *
 * `phase` discriminates current state. `outboundUsed` accumulates the
 * outbound distance traveled so far; once it reaches outboundDistance,
 * phase flips to "returning". `lastBloodPoolDistance` tracks how far
 * since the last blood pool spawn so we can drop pools at fixed
 * `bloodPoolSpawnIntervalUnits` along the path.
 *
 * `enemyHitCooldownsMs` (server-only Map) gates same-axe-same-enemy
 * double-hits when the axe crosses an enemy on outbound + return —
 * matches Projectile.enemyHitCooldownsMs's pattern.
 *
 * `frozenReturnX/Z` (set when the owner downs mid-flight per A1):
 * captures the owner's last-seen XZ so a downed owner doesn't trap the
 * axe in homing limbo. -Infinity sentinel means "owner still alive,
 * use live position."
 */
export type Boomerang = {
  fireId: number;
  ownerId: string;
  weaponKind: number;
  weaponLevel: number;
  damage: number;
  hitRadius: number;
  outboundDistance: number;
  outboundSpeed: number;
  returnSpeed: number;
  hitCooldownPerEnemyMs: number;
  leavesBloodPool: boolean;
  bloodPoolDamagePerTick: number;
  bloodPoolTickIntervalMs: number;
  bloodPoolLifetimeMs: number;
  bloodPoolSpawnIntervalUnits: number;
  // Phase + integration state
  phase: "outbound" | "returning";
  originX: number;
  originY: number;
  originZ: number;
  dirX: number;            // 2D direction in XZ — boomerangs fly horizontally
  dirZ: number;
  x: number;
  z: number;
  outboundUsed: number;
  lastBloodPoolDistance: number;
  // Per-enemy hit cooldowns (server-only state, NOT in schema)
  enemyHitCooldownsMs: Map<number, number>;
  // Owner-down freeze targets (A1: if owner downs mid-flight, return
  // target snaps to this XZ for the rest of the flight)
  frozenReturnX: number;   // -Infinity = owner still alive
  frozenReturnZ: number;
};

export type CombatEvent =
  | FireEvent
  | HitEvent
  | EnemyDiedEvent
  | GemCollectedEvent
  | LevelUpOfferedEvent
  | LevelUpResolvedEvent
  | PlayerDamagedEvent
  | PlayerDownedEvent
  | RunEndedEvent
  | MeleeSwipeEvent       // M8 US-005
  | BoomerangThrownEvent; // M8 US-011
export type Emit = (event: CombatEvent) => void;

/**
 * Server-supplied per-(player, weaponIndex, enemy) hit cooldown for orbit
 * weapons. Structural — the concrete implementation lives in
 * server/src/orbitHitCooldown.ts and satisfies this shape. Defined here
 * (not in a separate shared file) because tickWeapons is the only consumer.
 */
export interface OrbitHitCooldownLike {
  tryHit(playerId: string, weaponIndex: number, enemyId: number, nowMs: number, cooldownMs: number): boolean;
  evictEnemy(enemyId: number): void;
}

/**
 * Server-supplied per-(player, enemy) contact-damage cooldown. Structural —
 * the concrete implementation lives in server/src/contactCooldown.ts.
 */
export interface ContactCooldownLike {
  tryHit(playerId: string, enemyId: number, nowMs: number, cooldownMs: number): boolean;
  evictEnemy(enemyId: number): void;
  evictPlayer(playerId: string): void;
  sweep(nowMs: number, maxCooldownMs: number): void;
}

/**
 * M8 US-011: server-supplied per-(pool, enemy) DoT cooldown. Structural —
 * the concrete implementation lives in server/src/bloodPoolHitCooldown.ts,
 * parallel to OrbitHitCooldown / ContactCooldown. tickBloodPools is the
 * only consumer.
 */
export interface BloodPoolHitCooldownLike {
  tryHit(poolId: number, enemyId: number, nowMs: number, cooldownMs: number): boolean;
  evictEnemy(enemyId: number): void;
  evictPool(poolId: number): void;
}

export type WeaponContext = {
  nextFireId: () => number;
  serverNowMs: () => number;
  pushProjectile: (p: Projectile) => void;
  nextGemId: () => number;
  orbitHitCooldown: OrbitHitCooldownLike;
  // M8 US-005: melee_arc crit rolls and any future weapon RNG go through
  // this — the SAME deterministic mulberry32 seeded from RoomState.seed
  // that tickXp + tickSpawner already use. CLAUDE.md rule 6: NEVER
  // Math.random in gameplay code.
  rng: Rng;
  // M8 US-011: boomerang weapons (Bloody Axe in US-012) push axes via
  // pushBoomerang, and the L3+ blood-pool spawn path uses nextBloodPoolId
  // for monotonic pool ids on RoomState.bloodPools.
  pushBoomerang: (b: Boomerang) => void;
  nextBloodPoolId: () => number;
};

/**
 * M8 US-002: pick a fire target according to the projectile weapon's
 * targeting mode. Exported separately from tickWeapons so the three modes
 * can be unit-tested independently of the weapon table — and so any future
 * non-projectile behavior that wants targeting (e.g. a homing aura) can
 * reuse it.
 *
 * Returns null when no target/direction is selected (the caller should
 * skip firing, leaving its cooldown clamped at 0 per AD10).
 *
 * - "nearest"   — pick the in-range enemy with the smallest 3D distance
 *                 (M5 Bolt baseline). Returns its id and a unit-length 3D
 *                 direction toward it.
 * - "furthest"  — same gate, pick max 3D distance instead. Used by Gakkung
 *                 Bow (US-003) — rewards positioning that builds a tail.
 * - "facing"    — fire in player.facing (XZ plane, dirY = 0). Still gated
 *                 on "any enemy in range" so empty fields don't waste shots.
 *                 lockedTargetId = -1 (no specific lock; client renders
 *                 a straight-line projectile).
 */
export type SelectedTarget = {
  lockedTargetId: number;
  dirX: number;
  dirY: number;
  dirZ: number;
};

export function selectTarget(
  state: RoomState,
  player: Player,
  targeting: TargetingMode,
  rangeSq: number,
): SelectedTarget | null {
  if (targeting === "facing") {
    let anyInRange = false;
    state.enemies.forEach((enemy: Enemy) => {
      if (anyInRange) return;
      const dx = enemy.x - player.x;
      const dy = enemy.y - player.y;
      const dz = enemy.z - player.z;
      const sq = dx * dx + dy * dy + dz * dz;
      if (sq <= rangeSq) anyInRange = true;
    });
    if (!anyInRange) return null;
    return { lockedTargetId: -1, dirX: player.facingX, dirY: 0, dirZ: player.facingZ };
  }

  // `nearest` or `furthest` — initial best is set so the first in-range
  // enemy always wins; subsequent candidates compete by min/max sq distance.
  let bestSq = targeting === "furthest" ? -Infinity : Infinity;
  let bestDx = 0, bestDy = 0, bestDz = 0;
  let bestId = -1;
  let hasTarget = false;
  state.enemies.forEach((enemy: Enemy) => {
    const dx = enemy.x - player.x;
    const dy = enemy.y - player.y;
    const dz = enemy.z - player.z;
    const sq = dx * dx + dy * dy + dz * dz;
    if (sq > rangeSq) return;
    const better = targeting === "furthest" ? sq > bestSq : sq < bestSq;
    if (better) {
      bestSq = sq;
      bestDx = dx;
      bestDy = dy;
      bestDz = dz;
      bestId = enemy.id;
      hasTarget = true;
    }
  });
  if (!hasTarget) return null;
  if (bestSq === 0) return null; // defensive — skip firing at exact same position to avoid NaN dir
  const dist = Math.sqrt(bestSq);
  return {
    lockedTargetId: bestId,
    dirX: bestDx / dist,
    dirY: bestDy / dist,
    dirZ: bestDz / dist,
  };
}

/**
 * For each player's weapon: tick its cooldown; if ready and an in-range
 * target exists, pick the nearest, fire one projectile, reset the cooldown.
 * Per AD10, a weapon at cooldown 0 with no target stays clamped at 0
 * (does not go negative) until a target enters range.
 *
 * Hot loop: nearest-target selection uses squared distance (no Math.hypot
 * per pair); one Math.sqrt per fire to normalize the direction.
 *
 * Determinism: RNG-free. The fire-time `Date.now()` from ctx.serverNowMs
 * is wallclock used by clients for the closed-form projectile sim — it
 * never affects hit/no-hit, which is decided in tickProjectiles.
 */
export function tickWeapons(
  state: RoomState,
  dt: number,
  ctx: WeaponContext,
  emit: Emit,
): void {
  if (state.runEnded) return;
  const rangeSq = TARGETING_MAX_RANGE * TARGETING_MAX_RANGE;

  state.players.forEach((player: Player) => {
    if (player.downed) return;                 // M6 — downed players don't fire
    player.weapons.forEach((weapon: WeaponState) => {
      const def: WeaponDef | undefined = WEAPON_KINDS[weapon.kind];
      if (!def) return; // unknown kind — skip silently

      // Dispatch on behavior.kind. The switch keeps each behavior arm
      // localized and the `default` assertNever turns "added a third
      // WeaponBehavior kind without wiring it here" into a compile error
      // instead of a silent no-op.
      //
      // Inside each case we still use the user-defined predicate
      // (isProjectileWeapon) to narrow `def` for the call to the generic
      // `statsAt`. TS 5.x does narrow `def.behavior` through the case
      // label, but it does NOT fold that nested narrowing back into the
      // outer `def`'s union when computing `W["levels"][number]` —
      // statsAt then resolves to `ProjectileLevel | OrbitLevel` and
      // projectile-only fields (cooldown / projectileSpeed /
      // projectileLifetime) fail to typecheck. The predicate forwards
      // the narrowing into `W` directly. The switch shape still earns
      // its keep: the assertNever default is the exhaustiveness check
      // we were missing.
      switch (def.behavior.kind) {
        case "projectile": {
          if (!isProjectileWeapon(def)) return; // unreachable; see comment above
          const stats = statsAt(def, weapon.level);

          weapon.cooldownRemaining = Math.max(0, weapon.cooldownRemaining - dt);
          if (weapon.cooldownRemaining > 0) return;

          const sel = selectTarget(state, player, def.behavior.targeting, rangeSq);
          if (!sel) return;
          const dirX = sel.dirX;
          const dirY = sel.dirY;
          const dirZ = sel.dirZ;
          const lockedTargetId = sel.lockedTargetId;

          // M9 US-003: damage_mult BAKED into proj.damage at fire (not
          // re-read at hit time). Matches the single-writer-at-spawn
          // pattern: mid-flight item pickup doesn't retroactively boost
          // in-flight projectiles.
          const proj: Projectile = {
            fireId: ctx.nextFireId(),
            ownerId: player.sessionId,
            weaponKind: weapon.kind,
            damage: stats.damage * getItemMultiplier(player, "damage_mult"),
            speed: stats.projectileSpeed,
            radius: stats.hitRadius,
            lifetime: stats.projectileLifetime,
            age: 0,
            dirX,
            dirY,
            dirZ,
            prevX: player.x,
            prevY: player.y,
            prevZ: player.z,
            x: player.x,
            y: player.y,
            z: player.z,
            // M8 US-002: bake homing/pierce/per-enemy-cooldown onto the
            // projectile at fire so a mid-flight level-up doesn't change
            // the in-flight projectile's behavior. Same single-writer-at-spawn
            // pattern as `damage`/`speed`/`radius`/`lifetime` above.
            lockedTargetId,
            homingTurnRate: def.behavior.homingTurnRate,
            pierceRemaining: stats.pierceCount,
            hitCooldownPerEnemyMs: stats.hitCooldownPerEnemyMs,
            enemyHitCooldownsMs: new Map(),
          };
          ctx.pushProjectile(proj);

          emit({
            type: "fire",
            fireId: proj.fireId,
            weaponKind: weapon.kind,
            weaponLevel: weapon.level,
            lockedTargetId,
            ownerId: player.sessionId,
            originX: player.x,
            originY: player.y,
            originZ: player.z,
            dirX,
            dirY,
            dirZ,
            serverTick: state.tick,
            serverFireTimeMs: ctx.serverNowMs(),
          });

          // M9 US-003: cooldown_mult shortens the cooldown countdown.
          weapon.cooldownRemaining = stats.cooldown * getItemMultiplier(player, "cooldown_mult");
          break;
        }
        case "orbit": {
          if (!isOrbitWeapon(def)) return; // narrowing only — case already gates this
          const stats = statsAt(def, weapon.level);
          const tickTime = state.tick / TICK_RATE;
          const radiusSum = stats.hitRadius + ENEMY_RADIUS;
          const radiusSumSq = radiusSum * radiusSum;
          const nowMs = ctx.serverNowMs();

          // Resolve the index of `weapon` within `player.weapons`. ArraySchema.indexOf
          // exists; weapons are only pushed (never reordered), so the index is stable.
          const weaponIndex = player.weapons.indexOf(weapon);

          for (let i = 0; i < stats.orbCount; i++) {
            const angle = tickTime * stats.orbAngularSpeed + i * (2 * Math.PI / stats.orbCount);
            const orbX = player.x + Math.cos(angle) * stats.orbRadius;
            // M7 US-013: orbits orbit at player.y (not at y=0). When a
            // player jumps, their orbs lift with them — so an enemy on
            // the ground is out of reach until the player lands again.
            const orbY = player.y;
            const orbZ = player.z + Math.sin(angle) * stats.orbRadius;

            // Point-sphere vs each enemy. Per AD8: arc per tick at current angular
            // speeds is small enough that swept-arc isn't needed. Collect hits in a
            // temporary list because mutating state.enemies during a forEach causes
            // visit order to drift.
            const toHit: Enemy[] = [];
            state.enemies.forEach((enemy: Enemy) => {
              const dx = enemy.x - orbX;
              const dy = enemy.y - orbY;
              const dz = enemy.z - orbZ;
              if (dx * dx + dy * dy + dz * dz <= radiusSumSq) toHit.push(enemy);
            });

            // M9 US-003: damage_mult item effect applied AT EMIT TIME for
            // orbit (no fire-event spawn to bake into). Read once per
            // orbit cycle instead of per hit — items don't change
            // mid-cycle.
            const damageMult = getItemMultiplier(player, "damage_mult");
            for (const enemy of toHit) {
              if (!ctx.orbitHitCooldown.tryHit(player.sessionId, weaponIndex, enemy.id, nowMs, stats.hitCooldownPerEnemyMs)) {
                continue;
              }
              const orbitDamage = stats.damage * damageMult;
              enemy.hp -= orbitDamage;

              // fireId=0 sentinel — orbit hits don't correlate to a fire event.
              // M4 starts nextFireId at 1, so 0 is unambiguously "non-projectile".
              emit({
                type: "hit",
                fireId: 0,
                enemyId: enemy.id,
                damage: orbitDamage,
                x: enemy.x,
                y: enemy.y,
                z: enemy.z,
                serverTick: state.tick,
                tag: "default",
                weaponKind: weapon.kind,
              });

              if (enemy.hp <= 0) {
                player.kills += 1;
                spawnGemFanAndEmitDeath(state, enemy, ctx, emit);
              }
            }
          }
          break;
        }
        case "melee_arc": {
          if (!isMeleeArcWeapon(def)) return; // narrowing only
          weapon.cooldownRemaining = Math.max(0, weapon.cooldownRemaining - dt);
          if (weapon.cooldownRemaining > 0) return;
          const fired = runMeleeArcSwing(state, player, def, weapon.level, ctx, emit);
          if (fired) {
            const stats = statsAt(def, weapon.level);
            // M9 US-003: cooldown_mult applies.
            weapon.cooldownRemaining = stats.cooldown * getItemMultiplier(player, "cooldown_mult");
          }
          break;
        }
        case "boomerang": {
          if (!isBoomerangWeapon(def)) return; // narrowing only
          weapon.cooldownRemaining = Math.max(0, weapon.cooldownRemaining - dt);
          if (weapon.cooldownRemaining > 0) return;
          // Gate fire on "any enemy in range" — same AD10 pattern as
          // projectile/melee_arc. A boomerang's effective reach is its
          // outboundDistance; use that as the in-range gate so the axe
          // isn't thrown into empty fields.
          const stats = statsAt(def, weapon.level);
          const reachSq = stats.outboundDistance * stats.outboundDistance;
          let anyInReach = false;
          state.enemies.forEach((enemy: Enemy) => {
            if (anyInReach) return;
            const dx = enemy.x - player.x;
            const dz = enemy.z - player.z;
            if (dx * dx + dz * dz <= reachSq) anyInReach = true;
          });
          if (!anyInReach) return;
          runBoomerangThrow(state, player, def, weapon.level, ctx, emit);
          // M9 US-003: cooldown_mult applies.
          weapon.cooldownRemaining = stats.cooldown * getItemMultiplier(player, "cooldown_mult");
          break;
        }
        case "aura": {
          if (!isAuraWeapon(def)) return; // narrowing only
          // Aura semantics: WeaponState.cooldownRemaining is repurposed
          // as "seconds until next aura damage tick" (no schema migration
          // needed). Always counts down; on expiry, runs one aura tick
          // and resets to tickIntervalSec. A freshly-acquired aura
          // (cooldownRemaining=0 from the WeaponState constructor) fires
          // on its first tick — instant feedback when Kronos is picked.
          weapon.cooldownRemaining = Math.max(0, weapon.cooldownRemaining - dt);
          if (weapon.cooldownRemaining > 0) return;
          runAuraTick(state, player, def, weapon.level, ctx, emit);
          const stats = statsAt(def, weapon.level);
          // M9 US-003: cooldown_mult applies to aura ticks too — Kronos
          // ticks faster with Wind of Verdure stacked.
          weapon.cooldownRemaining = (stats.tickIntervalMs / 1000) * getItemMultiplier(player, "cooldown_mult");
          break;
        }
        default: {
          // Exhaustiveness guard. If a sixth behavior kind is added to
          // WeaponDef, this becomes a compile error: `def.behavior` will
          // not have type `never` and the assignment to `_exhaustive`
          // will fail.
          const _exhaustive: never = def.behavior;
          void _exhaustive;
        }
      }
    });
  });
}

/**
 * M8 US-005: execute one melee_arc swing — pick all enemies in the arc,
 * roll per-hit crits using the room PRNG (CLAUDE.md rule 6), apply damage
 * and optional knockback, emit one `melee_swipe` for VFX and one `hit`
 * per damaged enemy. Returns `true` iff a swing was emitted (the caller
 * uses this to decide whether to reset the weapon's cooldown).
 *
 * Exported separately from tickWeapons so the swing geometry, crit
 * determinism, and knockback can be unit-tested with a synthetic
 * MeleeArcWeaponDef without polluting the real WEAPON_KINDS table —
 * Damascus and Claymore enter WEAPON_KINDS in US-006 + US-007.
 *
 * Per A2 (design doc §10): if NO enemies are in the arc, the swing does
 * not fire — cooldown stays clamped at 0 (AD10), same as projectile/orbit
 * weapons that gate on "any target in range." This keeps melee weapons
 * from spamming swing VFX in empty fields.
 *
 * The crit decision is per-hit, but `MeleeSwipeEvent.isCrit` summarizes
 * the swing: true iff ANY hit in this swing rolled a crit. Drives a
 * brighter slash flash on the client. Per-hit crit detail rides on the
 * future HitEvent.tag field (US-013).
 */
export function runMeleeArcSwing(
  state: RoomState,
  player: Player,
  def: MeleeArcWeaponDef,
  weaponLevel: number,
  ctx: WeaponContext,
  emit: Emit,
): boolean {
  const stats = statsAt(def, weaponLevel);
  const range = stats.range;
  const rangeSq = range * range;
  const halfArc = stats.arcAngle * 0.5;
  const cosHalf = Math.cos(halfArc);

  // facingX/facingZ is unit-length in XZ (set by tickPlayers from
  // movement direction; defaults to (0, 1) at player construction).
  const fX = player.facingX;
  const fZ = player.facingZ;

  // Collect candidates (range + arc gate). MapSchema.forEach iteration
  // order is stable across server+clients; the per-hit damage/crit
  // application happens in this order so a future replay would be
  // identical. Mutating enemy.{x,z} via knockback inside this same
  // forEach is unsafe (visit order can drift), so collect first then
  // mutate.
  const candidates: Enemy[] = [];
  state.enemies.forEach((enemy: Enemy) => {
    const dx = enemy.x - player.x;
    const dy = enemy.y - player.y;
    const dz = enemy.z - player.z;
    const sq3 = dx * dx + dy * dy + dz * dz;
    if (sq3 > rangeSq) return;
    // Arc gate: dot of (player→enemy) XZ-unit with player facing must
    // be ≥ cos(arc/2). Fall back to "always in arc" for an exact-position
    // overlap (sqXZ === 0) to avoid NaN.
    const sqXZ = dx * dx + dz * dz;
    if (sqXZ === 0) {
      candidates.push(enemy);
      return;
    }
    const distXZ = Math.sqrt(sqXZ);
    const cosToEnemy = (dx * fX + dz * fZ) / distXZ;
    if (cosToEnemy >= cosHalf) candidates.push(enemy);
  });

  if (candidates.length === 0) return false;

  // Apply hits. Knockback mutates enemy x/z; safe now that we're outside
  // the forEach. Crit roll: ctx.rng() ∈ [0,1); roll < critChance → crit.
  //
  // M9 US-003: damage_mult applied at emit time (not baked at swing —
  // melee_arc has no fire-event spawn to bake into). Stacks
  // multiplicatively with crit: final damage = base × critMult × itemMult.
  const damageMult = getItemMultiplier(player, "damage_mult");
  let anyCrit = false;
  for (const enemy of candidates) {
    const isCrit = stats.critChance > 0 && ctx.rng() < stats.critChance;
    if (isCrit) anyCrit = true;
    const damage = (isCrit ? stats.damage * stats.critMultiplier : stats.damage) * damageMult;

    if (stats.knockback > 0) {
      const dx = enemy.x - player.x;
      const dz = enemy.z - player.z;
      const distXZ = Math.sqrt(dx * dx + dz * dz);
      if (distXZ > 0) {
        enemy.x += (dx / distXZ) * stats.knockback;
        enemy.z += (dz / distXZ) * stats.knockback;
      }
    }

    enemy.hp -= damage;

    emit({
      type: "hit",
      // fireId: 0 — same "non-projectile" sentinel orbit hits use; melee
      // hits don't correlate to a fire event. (M4 starts nextFireId at 1.)
      fireId: 0,
      enemyId: enemy.id,
      damage,
      x: enemy.x,
      y: enemy.y,
      z: enemy.z,
      serverTick: state.tick,
      // M8 US-013: per-hit crit tagging drives yellow/larger damage
      // numbers on the client (Damascus crit = yellow 1.4× font).
      tag: isCrit ? "crit" : "default",
      weaponKind: WEAPON_KINDS.indexOf(def),
    });

    if (enemy.hp <= 0) {
      player.kills += 1;
      spawnGemFanAndEmitDeath(state, enemy, ctx, emit);
    }
  }

  // One melee_swipe per swing. weaponKind not directly available on
  // `def` — caller passes the weapon level only. Fish the kind from
  // WEAPON_KINDS by reference equality: a future renaming-style tweak
  // could thread the kind index in explicitly.
  const weaponKind = WEAPON_KINDS.indexOf(def);

  emit({
    type: "melee_swipe",
    ownerId: player.sessionId,
    weaponKind,
    weaponLevel,
    originX: player.x,
    originY: player.y,
    originZ: player.z,
    facingX: fX,
    facingZ: fZ,
    arcAngle: stats.arcAngle,
    range: stats.range,
    isCrit: anyCrit,
    serverTick: state.tick,
    serverSwingTimeMs: ctx.serverNowMs(),
  });

  return true;
}

/**
 * M8 US-010: execute one aura damage tick — damage every enemy within
 * the aura's 3D radius and apply slow via applySlow. Caller (the aura
 * arm in tickWeapons) drives the cadence by counting down
 * WeaponState.cooldownRemaining (repurposed as "seconds until next aura
 * tick" for aura weapons, per the design doc note that no new schema
 * field is needed).
 *
 * Exported so the aura damage geometry, slow application, and gem-drop
 * + kill-credit paths can be unit-tested with a synthetic AuraWeaponDef
 * (Kronos enters WEAPON_KINDS in this story but the aura logic is
 * generic).
 *
 * Per A4 (design doc §10): aura uses 3D distance for the radius gate,
 * matching M7 US-013's projectile hit detection — a player on a hilltop
 * does NOT damage enemies in the valley below outside their 3D radius.
 *
 * Hits emit one HitEvent per damaged enemy with fireId=0 (the
 * "non-projectile" sentinel orbit + melee_arc already use). Slow ticks
 * are tagged via the future HitEvent.tag field in US-013 — for now
 * unbranded by tag and rendered with default white damage numbers.
 */
export function runAuraTick(
  state: RoomState,
  player: Player,
  def: AuraWeaponDef,
  weaponLevel: number,
  ctx: WeaponContext,
  emit: Emit,
): void {
  const stats = statsAt(def, weaponLevel);
  const radiusSq = stats.radius * stats.radius;
  // Convert ms duration → ticks (rounded up so a 300ms slow lasts at
  // least 6 full ticks at 20Hz). Min 1 tick — a slow that expires the
  // same tick it's applied wouldn't actually slow movement.
  const slowDurationTicks = Math.max(1, Math.ceil((stats.slowDurationMs * TICK_RATE) / 1000));

  // Collect candidates (range gate). Mutating enemy.hp inside forEach is
  // fine (no schema iteration changes), but kill removal MUST happen
  // outside forEach — same pattern tickEnemies/runMeleeArcSwing use.
  const hits: Enemy[] = [];
  state.enemies.forEach((enemy: Enemy) => {
    const dx = enemy.x - player.x;
    const dy = enemy.y - player.y;
    const dz = enemy.z - player.z;
    if (dx * dx + dy * dy + dz * dz > radiusSq) return;
    hits.push(enemy);
  });

  // M9 US-003: damage_mult applied at emit time for aura (no fire-event
  // spawn to bake into). Computed once per aura tick.
  const auraDamage = stats.damage * getItemMultiplier(player, "damage_mult");

  for (const enemy of hits) {
    enemy.hp -= auraDamage;
    applySlow(enemy, stats.slowMultiplier, slowDurationTicks, state.tick);

    emit({
      type: "hit",
      fireId: 0, // non-projectile sentinel
      enemyId: enemy.id,
      damage: auraDamage,
      x: enemy.x,
      y: enemy.y,
      z: enemy.z,
      serverTick: state.tick,
      // M8 US-013: aura ticks apply slow → "status" tag (icy blue
      // damage numbers on the client).
      tag: "status",
      weaponKind: WEAPON_KINDS.indexOf(def),
    });

    if (enemy.hp <= 0) {
      player.kills += 1;
      spawnGemFanAndEmitDeath(state, enemy, ctx, emit);
    }
  }
}

export type ProjectileContext = {
  nextGemId: () => number;
  orbitHitCooldown: OrbitHitCooldownLike;
  // M8 US-002: drives the per-projectile-per-enemy hit cooldown for pierce
  // weapons (Ahlspiess, future homing-pierce weapons). Same wallclock source
  // as WeaponContext.serverNowMs and OrbitHitCooldown — keeps the cooldown
  // semantics consistent across orbit and projectile arms.
  serverNowMs: () => number;
};

/**
 * M8 US-011: throw one Bloody Axe (or future boomerang weapon). Pushes
 * a Boomerang onto the active list via ctx.pushBoomerang and emits a
 * BoomerangThrownEvent so clients can simulate the trajectory locally
 * (rule 12). Direction comes from player.facing in the XZ plane —
 * boomerangs travel horizontally, ignoring player Y.
 *
 * Caller (tickWeapons boomerang arm) gates fire on "any enemy in
 * outbound range" before invoking this.
 */
export function runBoomerangThrow(
  state: RoomState,
  player: Player,
  def: BoomerangWeaponDef,
  weaponLevel: number,
  ctx: WeaponContext,
  emit: Emit,
): void {
  const stats = statsAt(def, weaponLevel);
  const fireId = ctx.nextFireId();
  // M9 US-003: damage_mult BAKED into both boomerang damage AND
  // bloodPoolDamagePerTick at throw time. Single-writer-at-spawn so a
  // mid-flight item pickup doesn't retroactively change in-flight axe
  // or pool damage (matches the existing single-writer-at-throw pattern
  // boomerang already uses for its own damage).
  const damageMult = getItemMultiplier(player, "damage_mult");
  const boomerang: Boomerang = {
    fireId,
    ownerId: player.sessionId,
    weaponKind: WEAPON_KINDS.indexOf(def),
    weaponLevel,
    damage: stats.damage * damageMult,
    hitRadius: stats.hitRadius,
    outboundDistance: stats.outboundDistance,
    outboundSpeed: stats.outboundSpeed,
    returnSpeed: stats.returnSpeed,
    hitCooldownPerEnemyMs: stats.hitCooldownPerEnemyMs,
    leavesBloodPool: stats.leavesBloodPool,
    bloodPoolDamagePerTick: stats.bloodPoolDamagePerTick * damageMult,
    bloodPoolTickIntervalMs: stats.bloodPoolTickIntervalMs,
    bloodPoolLifetimeMs: stats.bloodPoolLifetimeMs,
    bloodPoolSpawnIntervalUnits: stats.bloodPoolSpawnIntervalUnits,
    phase: "outbound",
    originX: player.x,
    originY: player.y,
    originZ: player.z,
    dirX: player.facingX,
    dirZ: player.facingZ,
    x: player.x,
    z: player.z,
    outboundUsed: 0,
    lastBloodPoolDistance: 0,
    enemyHitCooldownsMs: new Map(),
    frozenReturnX: -Infinity,
    frozenReturnZ: -Infinity,
  };
  ctx.pushBoomerang(boomerang);

  emit({
    type: "boomerang_thrown",
    fireId,
    ownerId: player.sessionId,
    weaponKind: WEAPON_KINDS.indexOf(def),
    weaponLevel,
    originX: player.x,
    originY: player.y,
    originZ: player.z,
    dirX: player.facingX,
    dirZ: player.facingZ,
    outboundDistance: stats.outboundDistance,
    outboundSpeed: stats.outboundSpeed,
    returnSpeed: stats.returnSpeed,
    leavesBloodPool: stats.leavesBloodPool,
    serverTick: state.tick,
    serverFireTimeMs: ctx.serverNowMs(),
  });
}

/**
 * M8 US-011: integrate every in-flight boomerang by `dt`. Two-phase
 * trajectory:
 *   - "outbound": move at outboundSpeed in (dirX, dirZ); when
 *     `outboundUsed` reaches `outboundDistance`, flip phase.
 *   - "returning": move at returnSpeed toward owner's CURRENT position
 *     (or `frozenReturn{X,Z}` if owner downed mid-flight, A1). Despawn
 *     when within DESPAWN_RADIUS or owner gone entirely.
 *
 * Per-tick collision: swept-sphere from prev to current XZ position
 * vs each enemy (Y matched against boomerang's originY since the axe
 * stays at throw height). Per-enemy hit cooldown gates double-hits.
 *
 * If `leavesBloodPool` is true and outbound, drops a BloodPool every
 * `bloodPoolSpawnIntervalUnits` of accumulated outbound distance.
 *
 * Inserted in the tick order between tickProjectiles and tickBloodPools
 * (rule 11 amended): boomerang motion happens BEFORE blood-pool DoT
 * processes the newly-spawned pools, so a pool spawned this tick can
 * damage enemies on the same tick if a tick intersection happens.
 */
export type BoomerangContext = {
  nextGemId: () => number;
  serverNowMs: () => number;
  orbitHitCooldown: OrbitHitCooldownLike;
  nextBloodPoolId: () => number;
};

const BOOMERANG_RETURN_DESPAWN_RADIUS = 0.6;

export function tickBoomerangs(
  state: RoomState,
  active: Boomerang[],
  dt: number,
  ctx: BoomerangContext,
  emit: Emit,
): void {
  if (state.runEnded) return;
  const nowMs = ctx.serverNowMs();
  let w = 0;
  for (let r = 0; r < active.length; r++) {
    const boomerang = active[r]!;
    const owner = state.players.get(boomerang.ownerId);

    // A1: if the owner is downed, freeze the return target at the
    // owner's last known XZ. If the owner is gone entirely, despawn
    // (don't carry forward).
    if (boomerang.phase === "returning" && boomerang.frozenReturnX === -Infinity) {
      if (!owner) continue; // owner left → despawn
      if (owner.downed) {
        boomerang.frozenReturnX = owner.x;
        boomerang.frozenReturnZ = owner.z;
      }
    }

    // Determine target for return phase
    let targetX = 0, targetZ = 0;
    if (boomerang.phase === "returning") {
      if (boomerang.frozenReturnX !== -Infinity) {
        targetX = boomerang.frozenReturnX;
        targetZ = boomerang.frozenReturnZ;
      } else if (owner) {
        targetX = owner.x;
        targetZ = owner.z;
      } else {
        // Owner gone, no freeze captured this tick — despawn.
        continue;
      }
    }

    // Compute the per-tick step
    const prevX = boomerang.x;
    const prevZ = boomerang.z;
    let stepX = 0, stepZ = 0;
    let stepLen = 0;
    let flipToReturning = false;
    if (boomerang.phase === "outbound") {
      stepX = boomerang.dirX * boomerang.outboundSpeed * dt;
      stepZ = boomerang.dirZ * boomerang.outboundSpeed * dt;
      stepLen = boomerang.outboundSpeed * dt;
      // Cap the step so we don't overshoot outboundDistance.
      // Note: phase flip is DEFERRED until after the blood-pool spawn
      // pass so the boundary tick still spawns its pool (the spawn pass
      // gates on phase === "outbound").
      const remaining = boomerang.outboundDistance - boomerang.outboundUsed;
      if (stepLen >= remaining) {
        const t = remaining / stepLen;
        stepX *= t;
        stepZ *= t;
        stepLen = remaining;
        flipToReturning = true;
      }
      boomerang.x = prevX + stepX;
      boomerang.z = prevZ + stepZ;
      boomerang.outboundUsed += stepLen;
    } else {
      // returning
      const tdx = targetX - boomerang.x;
      const tdz = targetZ - boomerang.z;
      const targetDist = Math.sqrt(tdx * tdx + tdz * tdz);
      if (targetDist <= BOOMERANG_RETURN_DESPAWN_RADIUS) {
        // Reached owner — despawn (don't copy forward).
        continue;
      }
      const desiredStep = boomerang.returnSpeed * dt;
      const actualStep = Math.min(desiredStep, targetDist);
      stepX = (tdx / targetDist) * actualStep;
      stepZ = (tdz / targetDist) * actualStep;
      stepLen = actualStep;
      boomerang.x = prevX + stepX;
      boomerang.z = prevZ + stepZ;
    }

    // Place blood pools along outbound path at fixed intervals (per
    // bloodPoolSpawnIntervalUnits). Deterministic — no rng (rule 6).
    // Runs BEFORE the deferred phase flip so the boundary tick still
    // spawns its pool (the gate is `phase === "outbound"`).
    if (boomerang.leavesBloodPool && boomerang.phase === "outbound") {
      boomerang.lastBloodPoolDistance += stepLen;
      while (boomerang.lastBloodPoolDistance >= boomerang.bloodPoolSpawnIntervalUnits) {
        boomerang.lastBloodPoolDistance -= boomerang.bloodPoolSpawnIntervalUnits;
        const pool = new BloodPool();
        pool.id = ctx.nextBloodPoolId();
        // Place the pool at the boomerang's CURRENT position minus the
        // overshoot we just consumed in lastBloodPoolDistance — but
        // for placement purposes "near current position" is good enough.
        pool.x = boomerang.x;
        pool.z = boomerang.z;
        pool.expiresAt = state.tick + Math.max(1, Math.ceil((boomerang.bloodPoolLifetimeMs * TICK_RATE) / 1000));
        pool.ownerId = boomerang.ownerId;
        pool.weaponKind = boomerang.weaponKind;
        // M9 US-003: bloodPoolDamagePerTick on the Boomerang struct may
        // be fractional (item damage_mult applied at throw time). Floor
        // to the uint16 schema field — Math.floor is explicit; without
        // it the underlying schema cast would still truncate, but the
        // intent is clearer this way.
        pool.damagePerTick = Math.floor(boomerang.bloodPoolDamagePerTick);
        pool.tickIntervalMs = boomerang.bloodPoolTickIntervalMs;
        state.bloodPools.set(String(pool.id), pool);
      }
    }

    // Swept-circle collision in XZ vs each enemy (the boomerang stays
    // at originY; enemies are on terrain at their own y, so the test
    // is 2D in XZ). hitRadius + ENEMY_RADIUS bounds the swept tube.
    const segLen2 = stepX * stepX + stepZ * stepZ;
    const radiusSum = boomerang.hitRadius + ENEMY_RADIUS;
    const radiusSumSq = radiusSum * radiusSum;
    state.enemies.forEach((enemy: Enemy) => {
      const toX = enemy.x - prevX;
      const toZ = enemy.z - prevZ;
      let u: number;
      if (segLen2 > 0) {
        u = (toX * stepX + toZ * stepZ) / segLen2;
        if (u < 0) u = 0; else if (u > 1) u = 1;
      } else {
        u = 0;
      }
      const closestX = prevX + u * stepX;
      const closestZ = prevZ + u * stepZ;
      const dx = enemy.x - closestX;
      const dz = enemy.z - closestZ;
      if (dx * dx + dz * dz > radiusSumSq) return;

      // Per-axe-per-enemy hit cooldown — gates the same axe re-hitting
      // an enemy on outbound + return crossings.
      if (boomerang.hitCooldownPerEnemyMs > 0) {
        const lastMs = boomerang.enemyHitCooldownsMs.get(enemy.id);
        if (lastMs !== undefined && nowMs - lastMs < boomerang.hitCooldownPerEnemyMs) return;
      }
      boomerang.enemyHitCooldownsMs.set(enemy.id, nowMs);

      enemy.hp -= boomerang.damage;
      emit({
        type: "hit",
        fireId: boomerang.fireId,
        enemyId: enemy.id,
        damage: boomerang.damage,
        x: enemy.x,
        y: enemy.y,
        z: enemy.z,
        serverTick: state.tick,
        tag: "default",
        weaponKind: boomerang.weaponKind,
      });

      if (enemy.hp <= 0) {
        if (owner) owner.kills += 1;
        spawnGemFanAndEmitDeath(state, enemy, ctx, emit);
      }
    });

    // Apply the deferred outbound→returning phase flip AFTER the
    // blood-pool spawn pass + collision check on this tick.
    if (flipToReturning) boomerang.phase = "returning";

    // Survives — copy forward.
    if (w !== r) active[w] = boomerang;
    w++;
  }
  active.length = w;
}

/**
 * M8 US-011: BloodPool DoT + cleanup. Runs in the amended tick order
 * AFTER tickBoomerangs (so pools placed this tick can DoT immediately
 * if they overlap an enemy) and BEFORE tickGems (so this-tick pool
 * kills drop pickups before pickup checks run).
 *
 * Per-pool-per-enemy DoT cadence is gated by the structural
 * BloodPoolHitCooldownLike (server-only Map keyed by (poolId, enemyId)).
 * Pool damage and tickIntervalMs are baked at spawn time on the
 * BloodPool schema — a mid-flight Bloody Axe level-up doesn't change
 * an in-flight pool's damage.
 *
 * Universal early-out on runEnded.
 */
export type BloodPoolContext = {
  serverNowMs: () => number;
  bloodPoolHitCooldown: BloodPoolHitCooldownLike;
  nextGemId: () => number;
  orbitHitCooldown: OrbitHitCooldownLike;
};

// Pool radius in world units. Pools are flat ground decals; this is
// the radius an enemy must be within (XZ distance) to take DoT damage.
const BLOOD_POOL_RADIUS = 1.2;

export function tickBloodPools(
  state: RoomState,
  ctx: BloodPoolContext,
  emit: Emit,
): void {
  if (state.runEnded) return;
  const nowMs = ctx.serverNowMs();
  const expiredIds: string[] = [];
  state.bloodPools.forEach((pool: BloodPool, key: string) => {
    if (pool.expiresAt < state.tick) {
      expiredIds.push(key);
      ctx.bloodPoolHitCooldown.evictPool(pool.id);
      return;
    }
    // DoT pass: every enemy within BLOOD_POOL_RADIUS of (pool.x, pool.z)
    // takes pool.damagePerTick if the per-pool-per-enemy cooldown allows.
    const radiusSumSq = (BLOOD_POOL_RADIUS + ENEMY_RADIUS) * (BLOOD_POOL_RADIUS + ENEMY_RADIUS);
    state.enemies.forEach((enemy: Enemy) => {
      const dx = enemy.x - pool.x;
      const dz = enemy.z - pool.z;
      if (dx * dx + dz * dz > radiusSumSq) return;
      if (!ctx.bloodPoolHitCooldown.tryHit(pool.id, enemy.id, nowMs, pool.tickIntervalMs)) return;

      enemy.hp -= pool.damagePerTick;
      emit({
        type: "hit",
        fireId: 0, // non-projectile sentinel
        enemyId: enemy.id,
        damage: pool.damagePerTick,
        x: enemy.x,
        y: enemy.y,
        z: enemy.z,
        serverTick: state.tick,
        // M8 US-013: blood-pool DoT is plain damage (not slow-applying);
        // "default" white numbers, not "status" blue.
        tag: "default",
        weaponKind: pool.weaponKind,
      });

      if (enemy.hp <= 0) {
        const owner = state.players.get(pool.ownerId);
        if (owner) owner.kills += 1;
        spawnGemFanAndEmitDeath(state, enemy, ctx, emit);
      }
    });
  });
  for (const k of expiredIds) state.bloodPools.delete(k);
}

/**
 * In-place slerp: rotate `proj.dir{X,Y,Z}` (assumed unit-length) toward the
 * unit vector `(des*)` by at most `maxStepRad` radians. Used by
 * tickProjectiles for homing weapons (Gakkung Bow). Determinism: pure math
 * over `proj`'s already-deterministic state plus the target's deterministic
 * position; no clock, no rng. Slerp of two unit vectors is unit-length
 * analytically — fp drift accumulates at ~1e-12 per step which is far
 * below any visible artifact over a projectile's seconds-long lifetime.
 */
function rotateDirTowardInPlace(
  proj: Projectile,
  desX: number, desY: number, desZ: number,
  maxStepRad: number,
): void {
  let cosA = proj.dirX * desX + proj.dirY * desY + proj.dirZ * desZ;
  if (cosA > 1) cosA = 1;
  else if (cosA < -1) cosA = -1;
  const angle = Math.acos(cosA);
  if (angle === 0) return;
  if (angle <= maxStepRad) {
    // Within one step of the target — snap to desired so the projectile
    // doesn't oscillate around the target by sub-step amounts.
    proj.dirX = desX;
    proj.dirY = desY;
    proj.dirZ = desZ;
    return;
  }
  const sinA = Math.sin(angle);
  if (sinA < 1e-6) {
    // Anti-parallel edge case (cosA ≈ -1). Slerp degenerates here. Snap to
    // desired so a turning projectile doesn't get stuck.
    proj.dirX = desX;
    proj.dirY = desY;
    proj.dirZ = desZ;
    return;
  }
  const t = maxStepRad / angle;
  const a = Math.sin((1 - t) * angle) / sinA;
  const b = Math.sin(t * angle) / sinA;
  const nx = a * proj.dirX + b * desX;
  const ny = a * proj.dirY + b * desY;
  const nz = a * proj.dirZ + b * desZ;
  proj.dirX = nx;
  proj.dirY = ny;
  proj.dirZ = nz;
}

/**
 * Integrate each projectile by `dt`, swept-circle test against each
 * enemy, apply damage / death / gem-drop, expire by lifetime. Compacts
 * `active` in place: write-index `w` trails read-index `r`; survivors
 * are copied forward, then `active.length = w`.
 *
 * Per AD3, the swept-circle test catches the tangent case (segment
 * passes through radius_sum even when both endpoints lie outside it).
 *
 * Per AD7, on a lethal hit: emit `hit` first, then schema-remove the
 * enemy and emit `enemy_died`. Order matters for client VFX — the hit
 * handler reads the enemy's interpolated position before the schema
 * removal patch lands, and the death event piggybacks the position.
 */
export function tickProjectiles(
  state: RoomState,
  active: Projectile[],
  dt: number,
  ctx: ProjectileContext,
  emit: Emit,
): void {
  if (state.runEnded) return;
  const nowMs = ctx.serverNowMs();
  let w = 0;
  for (let r = 0; r < active.length; r++) {
    const proj = active[r]!;

    // M8 US-002: homing — rotate dir toward locked target's current
    // position, capped at homingTurnRate*dt radians per tick. Runs BEFORE
    // integration so this tick's motion uses the new direction. If the
    // locked target is gone (dead or removed), keep current heading per
    // open-question A3 (no re-acquire).
    if (proj.homingTurnRate > 0 && proj.lockedTargetId !== -1) {
      const target = state.enemies.get(String(proj.lockedTargetId));
      if (target) {
        const tdx = target.x - proj.x;
        const tdy = target.y - proj.y;
        const tdz = target.z - proj.z;
        const tdist = Math.sqrt(tdx * tdx + tdy * tdy + tdz * tdz);
        if (tdist > 0) {
          rotateDirTowardInPlace(
            proj,
            tdx / tdist, tdy / tdist, tdz / tdist,
            proj.homingTurnRate * dt,
          );
        }
      }
    }

    // Integrate (3D, M7 US-013). Motion is straight-line: position
    // advances by `(dirX, dirY, dirZ) * speed * dt` with `(dir*)` already
    // unit-length, so `speed * dt` is the metric magnitude of the step.
    proj.prevX = proj.x;
    proj.prevY = proj.y;
    proj.prevZ = proj.z;
    proj.x += proj.dirX * proj.speed * dt;
    proj.y += proj.dirY * proj.speed * dt;
    proj.z += proj.dirZ * proj.speed * dt;
    proj.age += dt;

    if (proj.age >= proj.lifetime) {
      // Drop (do not copy forward).
      continue;
    }

    // Swept-sphere vs. each enemy in insertion order. The geometry
    // generalizes 2D segment-vs-disk: project the enemy center onto the
    // segment in 3D, clamp the parameter to [0,1], and compare squared
    // 3D distance to the sum-of-radii squared.
    //
    // M8 US-002: collect ALL intersected enemies up to the projectile's
    // pierce budget (was "first intersected wins" pre-M8). MapSchema
    // iteration order is the same on every tick across server+clients,
    // so the order in which a multi-pierce shot processes simultaneously
    // intersected enemies is stable. The per-enemy cooldown gate stops a
    // pierce projectile from re-hitting the same enemy on consecutive
    // ticks while it remains inside the radius.
    const segX = proj.x - proj.prevX;
    const segY = proj.y - proj.prevY;
    const segZ = proj.z - proj.prevZ;
    const segLen2 = segX * segX + segY * segY + segZ * segZ;
    const radiusSum = proj.radius + ENEMY_RADIUS;
    const radiusSumSq = radiusSum * radiusSum;
    const maxHits = proj.pierceRemaining === -1 ? Number.POSITIVE_INFINITY : proj.pierceRemaining;

    const hitsThisTick: Enemy[] = [];
    state.enemies.forEach((enemy: Enemy) => {
      if (hitsThisTick.length >= maxHits) return;

      const toX = enemy.x - proj.prevX;
      const toY = enemy.y - proj.prevY;
      const toZ = enemy.z - proj.prevZ;

      let u: number;
      if (segLen2 > 0) {
        u = (toX * segX + toY * segY + toZ * segZ) / segLen2;
        if (u < 0) u = 0;
        else if (u > 1) u = 1;
      } else {
        u = 0; // zero-length segment: fall back to point test at prev.
      }

      const closestX = proj.prevX + u * segX;
      const closestY = proj.prevY + u * segY;
      const closestZ = proj.prevZ + u * segZ;
      const dx = enemy.x - closestX;
      const dy = enemy.y - closestY;
      const dz = enemy.z - closestZ;
      if (dx * dx + dy * dy + dz * dz > radiusSumSq) return;

      // Per-enemy cooldown gate. Only meaningful when both pierce
      // (>1 or -1) AND a positive cooldown ms are configured; otherwise
      // a non-pierce shot already despawns after one hit.
      if (proj.hitCooldownPerEnemyMs > 0) {
        const lastMs = proj.enemyHitCooldownsMs.get(enemy.id);
        if (lastMs !== undefined && nowMs - lastMs < proj.hitCooldownPerEnemyMs) return;
      }
      hitsThisTick.push(enemy);
    });

    if (hitsThisTick.length > 0) {
      for (const enemy of hitsThisTick) {
        if (proj.hitCooldownPerEnemyMs > 0) proj.enemyHitCooldownsMs.set(enemy.id, nowMs);
        enemy.hp -= proj.damage;
        emit({
          type: "hit",
          fireId: proj.fireId,
          enemyId: enemy.id,
          damage: proj.damage,
          x: enemy.x,
          y: enemy.y,
          z: enemy.z,
          serverTick: state.tick,
          // M8 US-013: infinite-pierce projectiles (Ahlspiess) are
          // tagged "pierce" — drives a subtle additive glow on the
          // damage number. Finite-pierce/single-hit projectiles
          // (Bolt, Gakkung Bow) are "default".
          tag: proj.pierceRemaining === -1 ? "pierce" : "default",
          weaponKind: proj.weaponKind,
        });

        if (enemy.hp <= 0) {
          const owner = state.players.get(proj.ownerId);
          if (owner) owner.kills += 1;
          spawnGemFanAndEmitDeath(state, enemy, ctx, emit);
        }
      }

      // Decrement pierce budget for finite-pierce projectiles. -1 (infinite)
      // never decrements — only lifetime expiry despawns it.
      if (proj.pierceRemaining > 0) {
        proj.pierceRemaining -= hitsThisTick.length;
        if (proj.pierceRemaining <= 0) continue; // budget exhausted; drop.
      }
    }

    // Survives: copy forward.
    if (w !== r) active[w] = proj;
    w++;
  }

  active.length = w;
}

/**
 * For each gem, the first player (in `state.players` insertion order)
 * within GEM_PICKUP_RADIUS² collects it: increments xp, removes the gem
 * from state, emits gem_collected. Per AD8 — deterministic and
 * dependency-free.
 */
export function tickGems(state: RoomState, emit: Emit): void {
  if (state.runEnded) return;
  // M9 US-005: per-player effective magnet radius (Magnifier) and xp
  // gain multiplier (Bunny Top Hat). Computed ONCE per player at the
  // start of the tick — items don't change mid-tick, so caching is
  // safe and the inner pickup loop stays O(gems × players × constant)
  // instead of O(gems × players × items).
  const playerRadiusSq = new Map<string, number>();
  const playerXpMult = new Map<string, number>();
  state.players.forEach((p) => {
    const r = GEM_PICKUP_RADIUS * getItemMultiplier(p, "magnet_mult");
    playerRadiusSq.set(p.sessionId, r * r);
    playerXpMult.set(p.sessionId, getItemMultiplier(p, "xp_mult"));
  });
  // Fallback radius for players that somehow aren't in the cache
  // (defensive — should never happen since the forEach above seeds
  // every player). Equals the unmodified GEM_PICKUP_RADIUS².
  const fallbackRadiusSq = GEM_PICKUP_RADIUS * GEM_PICKUP_RADIUS;

  state.gems.forEach((gem: Gem, key: string) => {
    let collector: Player | undefined;
    state.players.forEach((p: Player) => {
      if (collector) return;
      const dx = p.x - gem.x;
      const dz = p.z - gem.z;
      const radiusSq = playerRadiusSq.get(p.sessionId) ?? fallbackRadiusSq;
      if (dx * dx + dz * dz <= radiusSq) collector = p;
    });
    if (!collector) return;

    // M9 US-005: xp_mult applied at gain. Event value stays the raw gem
    // value (it's a gem property); the player's actual xp gain may differ.
    const xpMult = playerXpMult.get(collector.sessionId) ?? 1;
    const xpGain = Math.floor(gem.value * xpMult);
    collector.xp += xpGain;
    collector.xpGained += xpGain;
    state.gems.delete(key);
    emit({
      type: "gem_collected",
      gemId: gem.id,
      playerId: collector.sessionId,
      value: gem.value,
    });
  });
}

/**
 * Pure: mutate `player` to apply the chosen level-up, then emit
 * `level_up_resolved`. Called from both the `level_up_choice` message
 * handler (autoPicked=false) and `tickLevelUpDeadlines` (autoPicked=true).
 *
 * Per spec §AD9. If the player already has a weapon of `weaponKind`,
 * increments its level (capped at WEAPON_KINDS[kind].levels.length).
 * Otherwise pushes a new WeaponState at level 1.
 */
export function resolveLevelUp(
  player: Player,
  picked: { type: "weapon" | "item"; index: number },
  emit: Emit,
  autoPicked: boolean,
): void {
  if (picked.type === "weapon") {
    const def = WEAPON_KINDS[picked.index];
    if (!def) {
      // Unknown kind — clear pending state to avoid wedging the player and bail.
      player.pendingLevelUp = false;
      player.levelUpChoices.length = 0;
      player.levelUpDeadlineTick = 0;
      return;
    }

    let newLevel: number;
    let existingIdx = -1;
    for (let i = 0; i < player.weapons.length; i++) {
      if (player.weapons[i]!.kind === picked.index) {
        existingIdx = i;
        break;
      }
    }
    if (existingIdx >= 0) {
      const w = player.weapons[existingIdx]!;
      w.level = Math.min(w.level + 1, def.levels.length);
      newLevel = w.level;
    } else {
      const w = new WeaponState();
      w.kind = picked.index;
      w.level = 1;
      w.cooldownRemaining = 0;
      player.weapons.push(w);
      newLevel = 1;
    }

    player.pendingLevelUp = false;
    player.levelUpChoices.length = 0;
    player.levelUpDeadlineTick = 0;

    emit({
      type: "level_up_resolved",
      playerId: player.sessionId,
      picked,
      newLevel,
      autoPicked,
    });
    return;
  }

  // picked.type === "item"
  const itemDef = ITEM_KINDS[picked.index];
  if (!itemDef) {
    player.pendingLevelUp = false;
    player.levelUpChoices.length = 0;
    player.levelUpDeadlineTick = 0;
    return;
  }

  let newLevel: number;
  let existingItemIdx = -1;
  for (let i = 0; i < player.items.length; i++) {
    if (player.items[i]!.kind === picked.index) {
      existingItemIdx = i;
      break;
    }
  }
  if (existingItemIdx >= 0) {
    const item = player.items[existingItemIdx]!;
    // Cap at L5 (silent no-op per open-question A1 resolution — a
    // maxed item picked again doesn't fizzle visibly; just doesn't
    // bump). Re-roll behavior is queued for a future polish pass.
    item.level = Math.min(item.level + 1, itemDef.values.length);
    newLevel = item.level;
  } else {
    const item = new ItemState();
    item.kind = picked.index;
    item.level = 1;
    player.items.push(item);
    newLevel = 1;
  }

  // M9 US-002: max_hp_mult item pickups apply their effect immediately —
  // recompute player.maxHp and heal for the diff (per A3 resolution:
  // full diff heal so Apple of Idun at low HP is valuable). Other item
  // effects are read on-demand at their application sites and don't
  // need a one-shot apply here.
  if (itemDef.effect === "max_hp_mult") {
    const oldMaxHp = player.maxHp;
    const newMaxHp = Math.floor(PLAYER_MAX_HP * getItemMultiplier(player, "max_hp_mult"));
    const diff = newMaxHp - oldMaxHp;
    player.maxHp = newMaxHp;
    player.hp = Math.min(player.hp + Math.max(0, diff), newMaxHp);
  }

  player.pendingLevelUp = false;
  player.levelUpChoices.length = 0;
  player.levelUpDeadlineTick = 0;

  emit({
    type: "level_up_resolved",
    playerId: player.sessionId,
    picked,
    newLevel,
    autoPicked,
  });
}

/**
 * For each player: if XP has crossed the threshold for their current level
 * AND they don't already have a pending level-up, drain the cost, increment
 * level, roll 3 weapon-kind choices via `rng` (with replacement), set
 * pendingLevelUp + levelUpChoices + levelUpDeadlineTick, emit
 * level_up_offered.
 *
 * Per spec §AD4 (one level per tick, drain via re-ticks) and §AD5 (room
 * rng, fixed tick order).
 */
export function tickXp(state: RoomState, rng: Rng, emit: Emit): void {
  if (state.runEnded) return;
  state.players.forEach((player: Player) => {
    if (player.pendingLevelUp) return;
    const need = xpForLevel(player.level);
    if (player.xp < need) return;

    player.xp -= need;
    player.level += 1;

    // M9 US-002: mixed pool — roll 3 choices (with replacement) from
    // the union of WEAPON_KINDS and ITEM_KINDS, equally weighted. Each
    // rng() call consumes one slot in the deterministic schedule;
    // sequence is identical to M8's pool but with extended range.
    player.levelUpChoices.length = 0;
    const choicesArr: LevelUpChoicePayload[] = [];
    const poolSize = WEAPON_KINDS.length + ITEM_KINDS.length;
    for (let i = 0; i < 3; i++) {
      const draw = Math.floor(rng() * poolSize);
      const isItem = draw >= WEAPON_KINDS.length;
      const index = isItem ? draw - WEAPON_KINDS.length : draw;
      const choice = new LevelUpChoice();
      choice.type = isItem ? LEVEL_UP_CHOICE_ITEM : LEVEL_UP_CHOICE_WEAPON;
      choice.index = index;
      player.levelUpChoices.push(choice);
      choicesArr.push({ type: isItem ? "item" : "weapon", index });
    }

    player.pendingLevelUp = true;
    player.levelUpDeadlineTick = state.tick + LEVEL_UP_DEADLINE_TICKS;

    emit({
      type: "level_up_offered",
      playerId: player.sessionId,
      newLevel: player.level,
      choices: choicesArr,
      deadlineTick: player.levelUpDeadlineTick,
    });
  });
}

/**
 * Auto-pick choice 0 for any player whose level-up deadline has passed.
 * Per spec §AD9 — same resolveLevelUp path, autoPicked=true.
 */
export function tickLevelUpDeadlines(state: RoomState, emit: Emit): void {
  if (state.runEnded) return;
  state.players.forEach((player: Player) => {
    if (!player.pendingLevelUp) return;
    if (state.tick < player.levelUpDeadlineTick) return;
    if (player.levelUpChoices.length === 0) {
      // Pending but no choices — defensive recovery; clear and bail.
      player.pendingLevelUp = false;
      player.levelUpDeadlineTick = 0;
      return;
    }
    // M9 US-002: choice 0 is now a LevelUpChoice schema with {type,
    // index}, not a bare weapon-kind int. Decode the wire-level uint8
    // type into the string literal expected by resolveLevelUp.
    const choice = player.levelUpChoices[0]!;
    resolveLevelUp(
      player,
      {
        type: choice.type === LEVEL_UP_CHOICE_ITEM ? "item" : "weapon",
        index: choice.index,
      },
      emit,
      /* autoPicked */ true,
    );
  });
}

/**
 * For each non-downed player, find every enemy whose center-to-center
 * distance is within (PLAYER_RADIUS + ENEMY_RADIUS). Each touching pair
 * tries to hit through `cooldown.tryHit(...)`; on success, apply
 * ENEMY_CONTACT_DAMAGE, emit `player_damaged`, and (if hp crosses 0) flip
 * `downed` + zero inputDir + emit `player_downed`.
 *
 * `nowMs` is the server's wall-clock; the cooldown store is the only
 * consumer of it. Determinism: outcomes (damage, downed) depend on the
 * cooldown decision, which depends on wall-clock — same pattern as orbit
 * hits in tickWeapons. Clients don't run this function, so cross-client
 * divergence is impossible by construction (server is authoritative).
 */
export function tickContactDamage(
  state: RoomState,
  cooldown: ContactCooldownLike,
  _dt: number,
  nowMs: number,
  emit: Emit,
): void {
  if (state.runEnded) return;
  const cooldownMs = ENEMY_CONTACT_COOLDOWN_S * 1000;
  const radiusSum = PLAYER_RADIUS + ENEMY_RADIUS;
  const radiusSumSq = radiusSum * radiusSum;

  state.players.forEach((player: Player) => {
    if (player.downed) return;

    state.enemies.forEach((enemy: Enemy) => {
      const dx = enemy.x - player.x;
      const dz = enemy.z - player.z;
      if (dx * dx + dz * dz > radiusSumSq) return;
      if (!cooldown.tryHit(player.sessionId, enemy.id, nowMs, cooldownMs)) return;

      const damage = Math.min(player.hp, ENEMY_CONTACT_DAMAGE);
      player.hp -= damage;
      emit({
        type: "player_damaged",
        playerId: player.sessionId,
        damage,
        x: player.x,
        y: player.y,
        z: player.z,
        serverTick: state.tick,
      });

      if (player.hp <= 0 && !player.downed) {
        player.downed = true;
        player.inputDir.x = 0;
        player.inputDir.z = 0;
        emit({
          type: "player_downed",
          playerId: player.sessionId,
          serverTick: state.tick,
        });
      }
    });
  });
}

/**
 * If every player is downed, set state.runEnded=true, snapshot
 * state.runEndedTick, and emit `run_ended`. No-op on empty room or if
 * runEnded is already true.
 */
export function tickRunEndCheck(state: RoomState, emit: Emit): void {
  if (state.runEnded) return;
  if (state.players.size === 0) return;

  let allDowned = true;
  state.players.forEach((p: Player) => {
    if (!p.downed) allDowned = false;
  });
  if (!allDowned) return;

  state.runEnded = true;
  state.runEndedTick = state.tick;
  emit({ type: "run_ended", serverTick: state.tick });
}
