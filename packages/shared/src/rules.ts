import type { RoomState } from "./schema.js";

export const PLAYER_SPEED = 5; // world units per second

// Fixed simulation step. The server runs setSimulationInterval at this dt,
// and the client's LocalPredictor advances the local player at this dt
// per input. They MUST agree exactly so reapplying unacknowledged inputs
// after a snapshot reproduces the server's authoritative position — see
// AD1 in docs/superpowers/specs/2026-05-04-sync-polish-design.md.
export const SIM_DT_S = 0.05; // 20 Hz

export function tickPlayers(state: RoomState, dt: number): void {
  state.players.forEach((p) => {
    p.x += p.inputDir.x * PLAYER_SPEED * dt;
    p.z += p.inputDir.z * PLAYER_SPEED * dt;
  });
}
