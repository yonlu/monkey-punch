import { describe, it, expect, vi } from "vitest";
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
    p.step({ x: 1, z: 0 }, false, (msg) => sent.push({ seq: msg.seq, dir: msg.dir }));
    expect(p.predictedX).toBeCloseTo(PLAYER_SPEED * SIM_DT_S);
    expect(p.predictedZ).toBe(0);
    expect(sent).toEqual([{ seq: 1, dir: { x: 1, z: 0 } }]);
  });

  it("step() updates lastStepTime to the current performance.now()", () => {
    const nowSpy = vi.spyOn(performance, "now");
    try {
      nowSpy.mockReturnValue(1000);
      const p = new LocalPredictor();
      expect(p.lastStepTime).toBe(1000);

      nowSpy.mockReturnValue(1050);
      p.step({ x: 0, z: 0 }, false, () => {});
      expect(p.lastStepTime).toBe(1050);

      nowSpy.mockReturnValue(1100);
      p.step({ x: 0, z: 0 }, false, () => {});
      expect(p.lastStepTime).toBe(1100);
    } finally {
      nowSpy.mockRestore();
    }
  });

  it("reconcile against acked seq drops queue and snaps to authoritative", () => {
    const p = new LocalPredictor();
    p.step({ x: 1, z: 0 }, false, () => {});
    p.step({ x: 1, z: 0 }, false, () => {});
    p.step({ x: 1, z: 0 }, false, () => {});

    const expected = 3 * PLAYER_SPEED * SIM_DT_S;
    p.reconcile(expected, 0, 3);

    expect(p.predictedX).toBeCloseTo(expected);
    expect(p.predictedZ).toBe(0);
    expect(p.lastReconErr).toBeCloseTo(0);
  });

  it("reconcile re-applies unacked inputs after authoritative snapshot", () => {
    const p = new LocalPredictor();
    p.step({ x: 1, z: 0 }, false, () => {}); // seq 1
    p.step({ x: 1, z: 0 }, false, () => {}); // seq 2
    p.step({ x: 1, z: 0 }, false, () => {}); // seq 3 — server has not yet processed

    const ackedX = 2 * PLAYER_SPEED * SIM_DT_S;
    p.reconcile(ackedX, 0, 2);

    expect(p.predictedX).toBeCloseTo(3 * PLAYER_SPEED * SIM_DT_S);
  });

  it("reconcile records the magnitude of the correction in lastReconErr", () => {
    const p = new LocalPredictor();
    p.step({ x: 1, z: 0 }, false, () => {});
    p.reconcile(0, 0, 1);
    expect(p.predictedX).toBe(0);
    expect(p.lastReconErr).toBeCloseTo(PLAYER_SPEED * SIM_DT_S);
  });

  it("ignores stale acks (lastProcessedInput < latest queued)", () => {
    const p = new LocalPredictor();
    p.step({ x: 1, z: 0 }, false, () => {}); // seq 1
    p.step({ x: 1, z: 0 }, false, () => {}); // seq 2

    p.reconcile(PLAYER_SPEED * SIM_DT_S, 0, 1);

    expect(p.predictedX).toBeCloseTo(2 * PLAYER_SPEED * SIM_DT_S);
  });

  it("reconcile() with no prediction error leaves renderOffset at zero", () => {
    const p = new LocalPredictor();
    p.step({ x: 1, z: 0 }, false, () => {});
    // server confirms exactly what we predicted, ack drains the queue
    p.reconcile(PLAYER_SPEED * SIM_DT_S, 0, 1);
    expect(p.renderOffset.x).toBeCloseTo(0);
    expect(p.renderOffset.z).toBeCloseTo(0);
    expect(p.lastReconErr).toBeCloseTo(0);
  });

  it("reconcile() snap-back records compensating renderOffset", () => {
    const p = new LocalPredictor();
    p.step({ x: 1, z: 0 }, false, () => {});
    // server says we're still at origin (input was lost / collapsed),
    // but acks our seq so the unacked queue drains
    p.reconcile(0, 0, 1);
    expect(p.predictedX).toBe(0);
    // Offset compensates for the snap-back: predictedX moved -0.25,
    // so renderOffset.x = +0.25 keeps the visible cube where it was.
    expect(p.renderOffset.x).toBeCloseTo(PLAYER_SPEED * SIM_DT_S);
    expect(p.renderOffset.z).toBeCloseTo(0);
  });

  it("renderOffset accumulates additively across multiple reconciliations", () => {
    const p = new LocalPredictor();
    const oneStep = PLAYER_SPEED * SIM_DT_S;

    p.step({ x: 1, z: 0 }, false, () => {});
    p.reconcile(0, 0, 1);
    expect(p.renderOffset.x).toBeCloseTo(oneStep);

    // After the first reconcile predictedX is 0. Step again and snap again.
    p.step({ x: 1, z: 0 }, false, () => {});
    p.reconcile(0, 0, 2);
    // Each reconcile contributes +oneStep; total should be 2 * oneStep,
    // NOT oneStep (which would mean the second reconcile overwrote the
    // first instead of adding to it).
    expect(p.renderOffset.x).toBeCloseTo(2 * oneStep);
  });
});
