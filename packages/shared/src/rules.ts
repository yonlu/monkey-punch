import type { RoomState } from "./schema.js";
import { PLAYER_SPEED, SIM_DT_S } from "./constants.js";

// Re-export so existing consumers (server, tests) that import these from
// "@mp/shared" via rules.ts continue to work after the relocation.
export { PLAYER_SPEED, SIM_DT_S };

export function tickPlayers(state: RoomState, dt: number): void {
  state.players.forEach((p) => {
    p.x += p.inputDir.x * PLAYER_SPEED * dt;
    p.z += p.inputDir.z * PLAYER_SPEED * dt;
  });
}
