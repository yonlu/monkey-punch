// Determinism gate for the Unity C# LocalPredictor port (Phase 5 of the
// Unity migration plan, see ~/.claude/plans/do-you-think-it-mighty-melody.md).
//
// This test runs the canonical TS LocalPredictor against a fixed input
// sequence (jump=false throughout — the C# predictor is X/Z-only by
// design; vertical/terrain is Phase 6) and writes the per-tick (X, Z)
// trace to a JSON fixture. The Unity Test Framework EditMode test at
// Monkey Punch/Assets/Tests/Editor/PredictorGoldenTest.cs reads the
// same JSON, runs the C# predictor against the same inputs, and asserts
// |delta| < 1e-9 per tick. Both sides must produce bit-identical doubles
// or — failing that — agree within nanometer tolerance.
//
// To regenerate: `pnpm --filter @mp/client test predictor-golden.gen`.
// CI does NOT auto-regenerate; the JSON is a checked-in artifact so
// drift in either side surfaces as a real test failure rather than
// silent mutual recalibration.

import { describe, it, beforeAll } from "vitest";
import { readFileSync } from "node:fs";
import { writeFileSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { LocalPredictor } from "./prediction.js";
import { initTerrain } from "@mp/shared";

const FIXTURE_PATH = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "../../../../test-fixtures/predictor-golden.json",
);

interface InputStep {
  dirX: number;
  dirZ: number;
}

interface TickRecord {
  tick: number;
  x: number;
  z: number;
}

// Fixed input sequence: 1200 ticks (60s at 20Hz) of mixed motion to
// exercise the X/Z integration AND the MAP_RADIUS=60 boundary clamp
// (a sustained eastward push for 300 ticks moves 75 units, well past
// the clamp at 60). All jump=false: the C# predictor doesn't predict
// Y, so we hold jump intent at zero to keep the comparison meaningful.
function buildInputs(): InputStep[] {
  const out: InputStep[] = [];
  const push = (n: number, dx: number, dz: number) => {
    for (let i = 0; i < n; i++) out.push({ dirX: dx, dirZ: dz });
  };
  push(300, 1, 0);                              // east, hits MAP_RADIUS clamp
  push(200, -1, 0);                             // west
  push(200, 0, 1);                              // north
  push(200, 0, -1);                             // south
  push(200, Math.SQRT1_2, Math.SQRT1_2);        // NE diagonal — non-trivial doubles
  push(100, 0, 0);                              // idle (no movement)
  return out;
}

describe("predictor golden fixture", () => {
  beforeAll(() => {
    // The TS predictor's applyTick calls terrainHeight on the Y branch.
    // That branch doesn't affect X/Z but the call would throw without
    // initialization. Seed 0 matches the test infra default.
    initTerrain(0);
  });

  it("predictor-golden.json matches the canonical TS predictor", () => {
    const inputs = buildInputs();
    const p = new LocalPredictor();
    const noop = () => {};

    const trace: TickRecord[] = [];
    for (let i = 0; i < inputs.length; i++) {
      const step = inputs[i]!;
      p.step({ x: step.dirX, z: step.dirZ }, false, noop);
      trace.push({ tick: p.predictedTick, x: p.predictedX, z: p.predictedZ });
    }

    const payload = {
      generator: "packages/client/src/net/predictor-golden.gen.test.ts",
      tickCount: trace.length,
      // Inputs are captured alongside the trace so the Unity test can
      // replay without re-implementing the input pattern.
      inputs,
      trace,
    };
    // JSON.stringify drops trailing zeroes on doubles; Number(string)
    // round-trips, and C# double.Parse on those strings is exact for
    // doubles representable in the JSON number grammar (which all
    // finite doubles are). So this fixture preserves the doubles
    // losslessly.
    const newJson = JSON.stringify(payload, null, 2) + "\n";

    if (process.env.REGEN_GOLDEN === "1") {
      // Explicit regen mode — overwrite the fixture. Used after any
      // intentional TS-predictor change. Commit the resulting diff so
      // the C# side can be brought into alignment (or vice versa) in
      // the same PR.
      mkdirSync(dirname(FIXTURE_PATH), { recursive: true });
      writeFileSync(FIXTURE_PATH, newJson);
      return;
    }

    // Default mode: assert the checked-in fixture is still what the
    // current TS predictor produces. If this fails, either the TS
    // predictor drifted (regen + reconcile the C# side) or the fixture
    // got hand-edited (revert). NEVER auto-regenerate in CI — the
    // whole point of the checked-in fixture is that TS-side drift is
    // a real test failure, not a silent recalibration.
    const existing = readFileSync(FIXTURE_PATH, "utf8");
    if (existing !== newJson) {
      throw new Error(
        "predictor-golden.json is out of date with the current TS LocalPredictor. " +
        "If the TS change is intentional, regenerate with " +
        "`REGEN_GOLDEN=1 pnpm --filter @mp/client test predictor-golden.gen` " +
        "and update the Unity C# predictor to match.",
      );
    }
  });
});
