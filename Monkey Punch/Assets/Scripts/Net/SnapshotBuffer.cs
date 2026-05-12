using System.Collections.Generic;
using UnityEngine;

namespace MonkeyPunch.Net {
  // Ring buffer of (timeMs, x, y, z) snapshots with linear interpolation
  // at sample time. Mirror of packages/client/src/net/snapshots.ts:
  // no extrapolation — clamps to most-recent if renderTime is past it,
  // clamps to oldest if before. Lerps between bracketing pair otherwise.
  //
  // Time base is whatever the caller uses for both push and sample —
  // typically Time.realtimeSinceStartupAsDouble * 1000.0 (monotonic ms
  // since editor start). Render-time delay typical ~100ms (≈2 ticks
  // at the 20Hz server cadence) so we always have a "next" snapshot
  // to lerp to.
  public class SnapshotBuffer {
    public struct Snapshot {
      public double TimeMs;
      public float X, Y, Z;
    }

    private const int History = 5;
    private readonly List<Snapshot> snaps = new List<Snapshot>(History + 1);

    public int Count => snaps.Count;

    public void Push(double timeMs, float x, float y, float z) {
      snaps.Add(new Snapshot { TimeMs = timeMs, X = x, Y = y, Z = z });
      if (snaps.Count > History) snaps.RemoveAt(0);
    }

    // Returns false if buffer is empty.
    public bool Sample(double renderTimeMs, out Vector3 result) {
      int n = snaps.Count;
      if (n == 0) { result = Vector3.zero; return false; }
      if (n == 1) {
        var only = snaps[0];
        result = new Vector3(only.X, only.Y, only.Z);
        return true;
      }
      var last = snaps[n - 1];
      if (renderTimeMs >= last.TimeMs) {
        result = new Vector3(last.X, last.Y, last.Z);
        return true;
      }
      var first = snaps[0];
      if (renderTimeMs <= first.TimeMs) {
        result = new Vector3(first.X, first.Y, first.Z);
        return true;
      }
      for (int i = n - 1; i > 0; i--) {
        var a = snaps[i - 1];
        var b = snaps[i];
        if (renderTimeMs >= a.TimeMs && renderTimeMs <= b.TimeMs) {
          double span = b.TimeMs - a.TimeMs;
          float u = span > 0.0 ? (float)((renderTimeMs - a.TimeMs) / span) : 0f;
          result = new Vector3(
            a.X + (b.X - a.X) * u,
            a.Y + (b.Y - a.Y) * u,
            a.Z + (b.Z - a.Z) * u
          );
          return true;
        }
      }
      // Fallthrough — shouldn't normally hit, treated as "stay at last".
      result = new Vector3(last.X, last.Y, last.Z);
      return true;
    }
  }
}
