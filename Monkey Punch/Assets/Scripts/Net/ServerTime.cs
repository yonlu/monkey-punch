using System;

namespace MonkeyPunch.Net {
  // Smoothed estimate of (server wall clock - client wall clock).
  // Mirror of packages/client/src/net/serverTime.ts.
  //
  // First Observe sets OffsetMs exactly (no smoothing). Subsequent
  // observations exponentially smooth at α=0.2 — with the 1Hz pong
  // driver from NetworkClient that's an effective time constant of
  // ~5 seconds: fast enough to track clock drift, slow enough to
  // ignore per-sample jitter.
  //
  // Wall-clock semantics intentional: matches TS Date.now() so the
  // server's serverNow (also Date.now()-derived) can be compared
  // directly. Don't substitute Time.realtimeSinceStartup — that's
  // monotonic-since-process-start, not Unix epoch.
  public class ServerTime {
    private const double Alpha = 0.2;
    public double OffsetMs;
    private bool initialized;

    public void Observe(double serverNow, double halfRttMs) {
      double sample = serverNow + halfRttMs - LocalNowMs();
      if (!initialized) {
        OffsetMs = sample;
        initialized = true;
        return;
      }
      OffsetMs = OffsetMs * (1.0 - Alpha) + sample * Alpha;
    }

    public double ServerNow() => LocalNowMs() + OffsetMs;

    // Unix epoch ms — matches the server's Date.now() that
    // GameRoom's pong handler echoes in PongMessage.serverNow.
    public static double LocalNowMs() {
      return DateTimeOffset.UtcNow.ToUnixTimeMilliseconds();
    }
  }
}
