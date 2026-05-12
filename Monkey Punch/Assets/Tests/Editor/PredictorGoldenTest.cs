using System;
using System.IO;
using NUnit.Framework;
using UnityEngine;
using MonkeyPunch.Net;

namespace MonkeyPunch.Tests.Editor {
  // Phase 5 determinism gate (Unity migration plan §Phase 5):
  // Loads the per-tick X/Z trace produced by the canonical TS predictor
  // (packages/client/src/net/predictor-golden.gen.test.ts), replays the
  // same inputs through the C# LocalPredictor, and asserts each tick's
  // X and Z match within 1e-9. Anything looser is a port bug — the
  // doubles must agree because identical operations on identical inputs
  // produce identical IEEE 754 results in both runtimes.
  //
  // To regenerate the fixture:
  //   pnpm --filter @mp/client test predictor-golden.gen
  //
  // The fixture file is checked into version control; CI does not regen
  // it, so any drift in either side surfaces as a real test failure
  // here.
  public class PredictorGoldenTest {
    [Serializable]
    private class GoldenInput {
      public double dirX;
      public double dirZ;
    }

    [Serializable]
    private class GoldenTick {
      public int tick;
      public double x;
      public double z;
    }

    [Serializable]
    private class GoldenFixture {
      public string generator;
      public string generatedAt;
      public int tickCount;
      public GoldenInput[] inputs;
      public GoldenTick[] trace;
    }

    private const double Tolerance = 1e-9;

    [Test]
    public void CSharpPredictor_MatchesTsTracePerTick() {
      // Application.dataPath is <project>/Assets. The fixture lives at
      // <repo>/test-fixtures/predictor-golden.json. The Unity project
      // is at <repo>/Monkey Punch/, so we walk up two directories.
      string path = Path.GetFullPath(
        Path.Combine(Application.dataPath, "..", "..", "test-fixtures", "predictor-golden.json")
      );
      Assert.IsTrue(File.Exists(path),
        $"Golden fixture not found at {path}. Run `pnpm --filter @mp/client test predictor-golden.gen` to regenerate.");

      string json = File.ReadAllText(path);
      var fixture = JsonUtility.FromJson<GoldenFixture>(json);
      Assert.IsNotNull(fixture, "JsonUtility failed to parse golden fixture.");
      Assert.AreEqual(fixture.tickCount, fixture.inputs.Length, "inputs length mismatch");
      Assert.AreEqual(fixture.tickCount, fixture.trace.Length, "trace length mismatch");

      var p = new LocalPredictor();
      p.Initialize(0, 0, 0);

      double maxAbsDxObserved = 0;
      double maxAbsDzObserved = 0;
      int firstFailureTick = -1;

      for (int i = 0; i < fixture.inputs.Length; i++) {
        var input = fixture.inputs[i];
        var expected = fixture.trace[i];

        // Step exercises the seq counter and unacked queue, mirroring
        // how the runtime client calls the predictor each input tick.
        p.Step(input.dirX, input.dirZ, false);

        double dx = Math.Abs(p.X - expected.x);
        double dz = Math.Abs(p.Z - expected.z);
        if (dx > maxAbsDxObserved) maxAbsDxObserved = dx;
        if (dz > maxAbsDzObserved) maxAbsDzObserved = dz;

        if ((dx > Tolerance || dz > Tolerance) && firstFailureTick < 0) {
          firstFailureTick = expected.tick;
          // Don't bail — collect both axes' max deltas for the report.
        }
      }

      Debug.Log($"[PredictorGoldenTest] {fixture.tickCount} ticks, " +
                $"maxDx={maxAbsDxObserved:E3}, maxDz={maxAbsDzObserved:E3}, tolerance={Tolerance:E0}");

      if (firstFailureTick >= 0) {
        Assert.Fail(
          $"Predictor diverged at tick {firstFailureTick}. " +
          $"maxAbsDx={maxAbsDxObserved}, maxAbsDz={maxAbsDzObserved}, tolerance={Tolerance}. " +
          "Either operator order or constant values drifted between TS and C#."
        );
      }
    }
  }
}
