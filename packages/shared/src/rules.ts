import type { Enemy, Player, RoomState } from "./schema.js";
import { ENEMY_SPEED, PLAYER_SPEED } from "./constants.js";

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
