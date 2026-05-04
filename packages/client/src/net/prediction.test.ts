import { describe, it, expect } from "vitest";
import { LocalPredictor } from "./prediction.js";
import { PLAYER_SPEED, SIM_DT_S } from "@mp/shared";

describe("LocalPredictor", () => {
  it("starts at origin with seq=0", () => {
    const p = new LocalPredictor();
    expect(p.predictedX).toBe(0);
    expect(p.predictedZ).toBe(0);
    expect(p.lastReconErr).toBe(0);
  });

  it("step advances predicted position by dir * speed * fixed dt and queues input", () => {
    const p = new LocalPredictor();
    const sent: Array<{ seq: number; dir: { x: number; z: number } }> = [];
    p.step({ x: 1, z: 0 }, (msg) => sent.push({ seq: msg.seq, dir: msg.dir }));
    expect(p.predictedX).toBeCloseTo(PLAYER_SPEED * SIM_DT_S);
    expect(p.predictedZ).toBe(0);
    expect(sent).toEqual([{ seq: 1, dir: { x: 1, z: 0 } }]);
  });

  it("reconcile against acked seq drops queue and snaps to authoritative", () => {
    const p = new LocalPredictor();
    p.step({ x: 1, z: 0 }, () => {});
    p.step({ x: 1, z: 0 }, () => {});
    p.step({ x: 1, z: 0 }, () => {});

    const expected = 3 * PLAYER_SPEED * SIM_DT_S;
    p.reconcile(expected, 0, 3);

    expect(p.predictedX).toBeCloseTo(expected);
    expect(p.predictedZ).toBe(0);
    expect(p.lastReconErr).toBeCloseTo(0);
  });

  it("reconcile re-applies unacked inputs after authoritative snapshot", () => {
    const p = new LocalPredictor();
    p.step({ x: 1, z: 0 }, () => {}); // seq 1
    p.step({ x: 1, z: 0 }, () => {}); // seq 2
    p.step({ x: 1, z: 0 }, () => {}); // seq 3 — server has not yet processed

    const ackedX = 2 * PLAYER_SPEED * SIM_DT_S;
    p.reconcile(ackedX, 0, 2);

    expect(p.predictedX).toBeCloseTo(3 * PLAYER_SPEED * SIM_DT_S);
  });

  it("reconcile records the magnitude of the correction in lastReconErr", () => {
    const p = new LocalPredictor();
    p.step({ x: 1, z: 0 }, () => {});
    p.reconcile(0, 0, 1);
    expect(p.predictedX).toBe(0);
    expect(p.lastReconErr).toBeCloseTo(PLAYER_SPEED * SIM_DT_S);
  });

  it("ignores stale acks (lastProcessedInput < latest queued)", () => {
    const p = new LocalPredictor();
    p.step({ x: 1, z: 0 }, () => {}); // seq 1
    p.step({ x: 1, z: 0 }, () => {}); // seq 2

    p.reconcile(PLAYER_SPEED * SIM_DT_S, 0, 1);

    expect(p.predictedX).toBeCloseTo(2 * PLAYER_SPEED * SIM_DT_S);
  });
});
