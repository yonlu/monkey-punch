import { Enemy, type Player, type RoomState } from "./schema.js";
import {
  ENEMY_HP,
  ENEMY_SPAWN_INTERVAL_S,
  ENEMY_SPAWN_RADIUS,
  ENEMY_SPEED,
  MAX_ENEMIES,
  PLAYER_SPEED,
} from "./constants.js";
import type { Rng } from "./rng.js";

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
