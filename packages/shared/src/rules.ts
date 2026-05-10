import {
  Enemy,
  Gem,
  WeaponState,
  type Player,
  type RoomState,
} from "./schema.js";
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
  GEM_PICKUP_RADIUS,
  GEM_VALUE,
  GRAVITY,
  JUMP_BUFFER,
  JUMP_VELOCITY,
  LEVEL_UP_DEADLINE_TICKS,
  MAP_RADIUS,
  MAX_ENEMIES,
  PLAYER_GROUND_OFFSET,
  PLAYER_RADIUS,
  PLAYER_SPEED,
  TARGETING_MAX_RANGE,
  TERMINAL_FALL_SPEED,
  TICK_RATE,
  xpForLevel,
} from "./constants.js";
import { terrainHeight } from "./terrain.js";
import { WEAPON_KINDS, statsAt, isProjectileWeapon, isOrbitWeapon, type WeaponDef } from "./weapons.js";
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
export function canJump(
  state: { grounded: boolean; lastGroundedAt: number },
  tick: number,
): boolean {
  if (state.grounded) return true;
  return (tick - state.lastGroundedAt) * (1 / TICK_RATE) <= COYOTE_TIME;
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
    p.x += p.inputDir.x * PLAYER_SPEED * dt;
    p.z += p.inputDir.z * PLAYER_SPEED * dt;
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
export function tickEnemies(state: RoomState, dt: number): void {
  if (state.runEnded) return;
  if (state.players.size === 0) return;

  const despawnSq = ENEMY_DESPAWN_RADIUS * ENEMY_DESPAWN_RADIUS;
  const toDespawn: number[] = [];

  state.enemies.forEach((enemy: Enemy) => {
    let nearestDx = 0;
    let nearestDz = 0;
    let nearestSq = Infinity;

    state.players.forEach((p: Player) => {
      if (p.downed) return;                    // skip downed for targeting + despawn
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
      // No living players — freeze in place horizontally, but still snap Y
      // (a fresh enemy spawned this tick has y=0 from the ctor; the snap
      // makes its first rendered frame correct even before it moves).
      enemy.y = terrainHeight(enemy.x, enemy.z) + ENEMY_GROUND_OFFSET;
      return;
    }
    if (nearestSq > despawnSq) {
      toDespawn.push(enemy.id);
      return;
    }
    if (nearestSq !== 0) {
      const dist = Math.sqrt(nearestSq);
      const step = ENEMY_SPEED * dt;
      enemy.x += (nearestDx / dist) * step;
      enemy.z += (nearestDz / dist) * step;
    }
    // M7 US-012: snap Y to terrain after horizontal movement. No vy, no
    // gravity, no jump for enemies (per PRD § US-012). The render-side
    // InstancedMesh keys by Enemy.id (CLAUDE.md rule 10) so per-instance
    // Y reaches the GPU through the snapshot interpolation buffer.
    enemy.y = terrainHeight(enemy.x, enemy.z) + ENEMY_GROUND_OFFSET;
  });

  for (const id of toDespawn) state.enemies.delete(String(id));
}

export type SpawnerState = {
  accumulator: number;   // seconds since last spawn
  nextEnemyId: number;   // monotonic; starts at 1 so id=0 is never valid
};

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

    // Pick a random non-downed player.
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
      enemy.kind = 0;
      enemy.x = x;
      enemy.z = z;
      enemy.y = terrainHeight(x, z) + ENEMY_GROUND_OFFSET;
      enemy.hp = ENEMY_HP;
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

  for (let i = 0; i < n; i++) {
    const angle = rng() * Math.PI * 2;
    const enemy = new Enemy();
    enemy.id = spawner.nextEnemyId++;
    enemy.kind = kind;
    enemy.x = centerPlayer.x + Math.cos(angle) * ENEMY_SPAWN_RADIUS;
    enemy.z = centerPlayer.z + Math.sin(angle) * ENEMY_SPAWN_RADIUS;
    enemy.y = terrainHeight(enemy.x, enemy.z) + ENEMY_GROUND_OFFSET;
    enemy.hp = ENEMY_HP;
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
  dirX: number;          // pre-normalized
  dirZ: number;
  prevX: number;         // for swept-circle
  prevZ: number;
  x: number;
  z: number;
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
  | RunEndedEvent;
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

export type WeaponContext = {
  nextFireId: () => number;
  serverNowMs: () => number;
  pushProjectile: (p: Projectile) => void;
  nextGemId: () => number;
  orbitHitCooldown: OrbitHitCooldownLike;
};

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

          let bestSq = Infinity;
          let bestDx = 0;
          let bestDz = 0;
          let hasTarget = false;
          state.enemies.forEach((enemy: Enemy) => {
            const dx = enemy.x - player.x;
            const dz = enemy.z - player.z;
            const sq = dx * dx + dz * dz;
            if (sq <= rangeSq && sq < bestSq) {
              bestSq = sq;
              bestDx = dx;
              bestDz = dz;
              hasTarget = true;
            }
          });
          if (!hasTarget) return;
          if (bestSq === 0) return;

          const dist = Math.sqrt(bestSq);
          const dirX = bestDx / dist;
          const dirZ = bestDz / dist;

          const proj: Projectile = {
            fireId: ctx.nextFireId(),
            ownerId: player.sessionId,
            weaponKind: weapon.kind,
            damage: stats.damage,
            speed: stats.projectileSpeed,
            radius: stats.hitRadius,
            lifetime: stats.projectileLifetime,
            age: 0,
            dirX,
            dirZ,
            prevX: player.x,
            prevZ: player.z,
            x: player.x,
            z: player.z,
          };
          ctx.pushProjectile(proj);

          emit({
            type: "fire",
            fireId: proj.fireId,
            weaponKind: weapon.kind,
            ownerId: player.sessionId,
            originX: player.x,
            originZ: player.z,
            dirX,
            dirZ,
            serverTick: state.tick,
            serverFireTimeMs: ctx.serverNowMs(),
          });

          weapon.cooldownRemaining = stats.cooldown;
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
            const orbZ = player.z + Math.sin(angle) * stats.orbRadius;

            // Point-circle vs each enemy. Per AD8: arc per tick at current angular
            // speeds is small enough that swept-arc isn't needed. Collect hits in a
            // temporary list because mutating state.enemies during a forEach causes
            // visit order to drift.
            const toHit: Enemy[] = [];
            state.enemies.forEach((enemy: Enemy) => {
              const dx = enemy.x - orbX;
              const dz = enemy.z - orbZ;
              if (dx * dx + dz * dz <= radiusSumSq) toHit.push(enemy);
            });

            for (const enemy of toHit) {
              if (!ctx.orbitHitCooldown.tryHit(player.sessionId, weaponIndex, enemy.id, nowMs, stats.hitCooldownPerEnemyMs)) {
                continue;
              }
              enemy.hp -= stats.damage;

              // fireId=0 sentinel — orbit hits don't correlate to a fire event.
              // M4 starts nextFireId at 1, so 0 is unambiguously "non-projectile".
              emit({
                type: "hit",
                fireId: 0,
                enemyId: enemy.id,
                damage: stats.damage,
                serverTick: state.tick,
              });

              if (enemy.hp <= 0) {
                const gem = new Gem();
                gem.id = ctx.nextGemId();
                gem.x = enemy.x;
                gem.z = enemy.z;
                gem.value = GEM_VALUE;
                state.gems.set(String(gem.id), gem);

                const deathX = enemy.x;
                const deathZ = enemy.z;
                const deathId = enemy.id;
                state.enemies.delete(String(enemy.id));
                player.kills += 1;
                ctx.orbitHitCooldown.evictEnemy(deathId);

                emit({
                  type: "enemy_died",
                  enemyId: deathId,
                  x: deathX,
                  z: deathZ,
                });
              }
            }
          }
          break;
        }
        default: {
          // Exhaustiveness guard. If a third behavior kind is added to
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

export type ProjectileContext = {
  nextGemId: () => number;
  orbitHitCooldown: OrbitHitCooldownLike;
};

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
  let w = 0;
  for (let r = 0; r < active.length; r++) {
    const proj = active[r]!;

    // Integrate.
    proj.prevX = proj.x;
    proj.prevZ = proj.z;
    proj.x += proj.dirX * proj.speed * dt;
    proj.z += proj.dirZ * proj.speed * dt;
    proj.age += dt;

    if (proj.age >= proj.lifetime) {
      // Drop (do not copy forward).
      continue;
    }

    // Swept-circle vs. each enemy in insertion order. First intersected wins.
    const segX = proj.x - proj.prevX;
    const segZ = proj.z - proj.prevZ;
    const segLen2 = segX * segX + segZ * segZ;
    const radiusSum = proj.radius + ENEMY_RADIUS;
    const radiusSumSq = radiusSum * radiusSum;

    let hitEnemy: Enemy | undefined;
    state.enemies.forEach((enemy: Enemy) => {
      if (hitEnemy) return; // first intersected wins; bail on rest

      const toX = enemy.x - proj.prevX;
      const toZ = enemy.z - proj.prevZ;

      let u: number;
      if (segLen2 > 0) {
        u = (toX * segX + toZ * segZ) / segLen2;
        if (u < 0) u = 0;
        else if (u > 1) u = 1;
      } else {
        u = 0; // zero-length segment: fall back to point test at prev.
      }

      const closestX = proj.prevX + u * segX;
      const closestZ = proj.prevZ + u * segZ;
      const dx = enemy.x - closestX;
      const dz = enemy.z - closestZ;
      if (dx * dx + dz * dz <= radiusSumSq) {
        hitEnemy = enemy;
      }
    });

    if (hitEnemy) {
      hitEnemy.hp -= proj.damage;
      emit({
        type: "hit",
        fireId: proj.fireId,
        enemyId: hitEnemy.id,
        damage: proj.damage,
        serverTick: state.tick,
      });

      if (hitEnemy.hp <= 0) {
        const gem = new Gem();
        gem.id = ctx.nextGemId();
        gem.x = hitEnemy.x;
        gem.z = hitEnemy.z;
        gem.value = GEM_VALUE;
        state.gems.set(String(gem.id), gem);

        const deathX = hitEnemy.x;
        const deathZ = hitEnemy.z;
        const deathId = hitEnemy.id;
        const owner = state.players.get(proj.ownerId);
        if (owner) owner.kills += 1;
        state.enemies.delete(String(hitEnemy.id));
        ctx.orbitHitCooldown.evictEnemy(deathId);

        emit({
          type: "enemy_died",
          enemyId: deathId,
          x: deathX,
          z: deathZ,
        });
      }
      // Drop the projectile (consumed by the hit).
      continue;
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
  const radiusSq = GEM_PICKUP_RADIUS * GEM_PICKUP_RADIUS;
  state.gems.forEach((gem: Gem, key: string) => {
    let collector: Player | undefined;
    state.players.forEach((p: Player) => {
      if (collector) return;
      const dx = p.x - gem.x;
      const dz = p.z - gem.z;
      if (dx * dx + dz * dz <= radiusSq) collector = p;
    });
    if (!collector) return;

    collector.xp += gem.value;
    collector.xpGained += gem.value;
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
  weaponKind: number,
  emit: Emit,
  autoPicked: boolean,
): void {
  const def = WEAPON_KINDS[weaponKind];
  if (!def) {
    // Unknown kind; clear pending state to avoid wedging the player and bail.
    player.pendingLevelUp = false;
    player.levelUpChoices.length = 0;
    player.levelUpDeadlineTick = 0;
    return;
  }

  let newWeaponLevel: number;
  let existingIdx = -1;
  for (let i = 0; i < player.weapons.length; i++) {
    if (player.weapons[i]!.kind === weaponKind) {
      existingIdx = i;
      break;
    }
  }
  if (existingIdx >= 0) {
    const w = player.weapons[existingIdx]!;
    w.level = Math.min(w.level + 1, def.levels.length);
    newWeaponLevel = w.level;
  } else {
    const w = new WeaponState();
    w.kind = weaponKind;
    w.level = 1;
    w.cooldownRemaining = 0;
    player.weapons.push(w);
    newWeaponLevel = 1;
  }

  player.pendingLevelUp = false;
  player.levelUpChoices.length = 0;
  player.levelUpDeadlineTick = 0;

  emit({
    type: "level_up_resolved",
    playerId: player.sessionId,
    weaponKind,
    newWeaponLevel,
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

    // Roll 3 choices (with replacement). Mutate in place: clear+push.
    player.levelUpChoices.length = 0;
    const choicesArr: number[] = [];
    for (let i = 0; i < 3; i++) {
      const k = Math.floor(rng() * WEAPON_KINDS.length);
      player.levelUpChoices.push(k);
      choicesArr.push(k);
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
    const weaponKind = player.levelUpChoices[0]!;
    resolveLevelUp(player, weaponKind, emit, /* autoPicked */ true);
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
