import {
  Enemy,
  Gem,
  type Player,
  type RoomState,
  type WeaponState,
} from "./schema.js";
import {
  ENEMY_HP,
  ENEMY_RADIUS,
  ENEMY_SPAWN_INTERVAL_S,
  ENEMY_SPAWN_RADIUS,
  ENEMY_SPEED,
  GEM_PICKUP_RADIUS,
  GEM_VALUE,
  MAX_ENEMIES,
  PLAYER_SPEED,
  TARGETING_MAX_RANGE,
  TICK_RATE,
} from "./constants.js";
import { WEAPON_KINDS, statsAt, isProjectileWeapon, isOrbitWeapon, type WeaponDef } from "./weapons.js";
import type { Rng } from "./rng.js";
import type {
  FireEvent,
  HitEvent,
  EnemyDiedEvent,
  GemCollectedEvent,
} from "./messages.js";

export function tickPlayers(state: RoomState, dt: number): void {
  state.players.forEach((p) => {
    p.x += p.inputDir.x * PLAYER_SPEED * dt;
    p.z += p.inputDir.z * PLAYER_SPEED * dt;
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
  if (state.players.size === 0) return;

  state.enemies.forEach((enemy: Enemy) => {
    let nearestDx = 0;
    let nearestDz = 0;
    let nearestSq = Infinity;

    state.players.forEach((p: Player) => {
      const dx = p.x - enemy.x;
      const dz = p.z - enemy.z;
      const sq = dx * dx + dz * dz;
      if (sq < nearestSq) {
        nearestSq = sq;
        nearestDx = dx;
        nearestDz = dz;
      }
    });

    if (nearestSq === 0) return;            // coincident: no step
    const dist = Math.sqrt(nearestSq);
    const step = ENEMY_SPEED * dt;
    enemy.x += (nearestDx / dist) * step;
    enemy.z += (nearestDz / dist) * step;
  });
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
 */
export function tickSpawner(
  state: RoomState,
  spawner: SpawnerState,
  dt: number,
  rng: Rng,
): void {
  if (state.players.size === 0) return;

  spawner.accumulator += dt;

  while (spawner.accumulator >= ENEMY_SPAWN_INTERVAL_S) {
    if (state.enemies.size >= MAX_ENEMIES) {
      spawner.accumulator = 0;
      return;
    }

    const playerIdx = Math.floor(rng() * state.players.size);
    let i = 0;
    let target: Player | undefined;
    state.players.forEach((p) => {
      if (i === playerIdx) target = p;
      i++;
    });
    if (!target) {
      // Unreachable given mulberry32's [0,1) output range and the size>0
      // check above (state.players.size === 0 short-circuits at the top).
      // Throw rather than silently swallow so a future refactor that
      // breaks the index math surfaces immediately instead of degrading
      // determinism by consuming RNG calls in an asymmetric pattern.
      throw new Error(
        `tickSpawner: unreachable — playerIdx=${playerIdx} out of range for size=${state.players.size}`,
      );
    }

    const angle = rng() * Math.PI * 2;
    const enemy = new Enemy();
    enemy.id = spawner.nextEnemyId++;
    enemy.kind = 0;
    enemy.x = target.x + Math.cos(angle) * ENEMY_SPAWN_RADIUS;
    enemy.z = target.z + Math.sin(angle) * ENEMY_SPAWN_RADIUS;
    enemy.hp = ENEMY_HP;
    state.enemies.set(String(enemy.id), enemy);

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

export type CombatEvent = FireEvent | HitEvent | EnemyDiedEvent | GemCollectedEvent;
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
  const rangeSq = TARGETING_MAX_RANGE * TARGETING_MAX_RANGE;

  state.players.forEach((player: Player) => {
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
    state.gems.delete(key);
    emit({
      type: "gem_collected",
      gemId: gem.id,
      playerId: collector.sessionId,
      value: gem.value,
    });
  });
}
