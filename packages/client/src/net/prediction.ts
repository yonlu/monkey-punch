import { PLAYER_SPEED, SIM_DT_S } from "@mp/shared";
import type { InputMessage } from "@mp/shared";

type UnackedInput = {
  seq: number;
  dir: { x: number; z: number };
};

export type SendInput = (msg: InputMessage) => void;

/**
 * Owns the local player's predicted state. The network layer calls step()
 * once per 20 Hz client tick (sending the current input + advancing the
 * prediction), and calls reconcile() each time an authoritative snapshot
 * arrives for the local player. Both sides must use the same SIM_DT_S
 * (imported from @mp/shared) so per-input displacement is bit-identical
 * — see AD1 in the M2 design doc.
 */
export class LocalPredictor {
  predictedX = 0;
  predictedZ = 0;
  lastReconErr = 0;

  private seq = 0;
  private unacked: UnackedInput[] = [];

  /**
   * Advance one prediction tick: increment seq, send the input, queue it
   * for later reconciliation, and locally apply dir * speed * dt.
   */
  step(dir: { x: number; z: number }, send: SendInput): void {
    this.seq += 1;
    const msg = { type: "input" as const, seq: this.seq, dir: { x: dir.x, z: dir.z } };
    send(msg);
    this.unacked.push({ seq: this.seq, dir: msg.dir });
    this.predictedX += dir.x * PLAYER_SPEED * SIM_DT_S;
    this.predictedZ += dir.z * PLAYER_SPEED * SIM_DT_S;
  }

  /**
   * Apply an authoritative snapshot for the local player. Drops acked
   * inputs from the queue, recomputes predicted pos by replaying any
   * remaining queued inputs onto the server position, and records the
   * magnitude of the correction in lastReconErr.
   */
  reconcile(serverX: number, serverZ: number, lastProcessedInput: number): void {
    while (this.unacked.length > 0 && this.unacked[0]!.seq <= lastProcessedInput) {
      this.unacked.shift();
    }

    let nextX = serverX;
    let nextZ = serverZ;
    for (const u of this.unacked) {
      nextX += u.dir.x * PLAYER_SPEED * SIM_DT_S;
      nextZ += u.dir.z * PLAYER_SPEED * SIM_DT_S;
    }

    const dx = nextX - this.predictedX;
    const dz = nextZ - this.predictedZ;
    this.lastReconErr = Math.hypot(dx, dz);
    this.predictedX = nextX;
    this.predictedZ = nextZ;
  }
}
