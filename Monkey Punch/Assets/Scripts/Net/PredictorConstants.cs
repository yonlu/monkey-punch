namespace MonkeyPunch.Net {
  // Physics + tick-cadence constants. Direct port of
  // packages/shared/src/constants.ts. CLAUDE.md rule #9: server and client
  // MUST agree on these values bit-for-bit — any divergence reproduces in
  // the predictor as cumulative drift between server and client.
  //
  // All values declared `double` to match TS IEEE 754 numerics. The C#
  // schema fields are float (Colyseus C# SDK uses single-precision for
  // "number"), so reconciliation does narrow on the wire — but the
  // predictor's internal math stays in double to prevent rounding from
  // compounding across replay steps.
  public static class PredictorConstants {
    public const double TICK_RATE = 20.0;            // Hz
    public const double SIM_DT_S = 1.0 / 20.0;       // 0.05 — hand-evaluated, NOT 1.0/TICK_RATE,
                                                     // because Roslyn's const folding of 1.0/20.0
                                                     // produces the same bits as TS's `1 / TICK_RATE`
                                                     // (both go through IEEE 754 division of 1 by 20).
    public const double PLAYER_SPEED = 5.0;
    public const double MAP_RADIUS = 60.0;
    public const double PLAYER_GROUND_OFFSET = 0.0;

    // Jump physics (used by future full-port; Phase 5 ships X/Z only).
    public const double GRAVITY = 25.0;
    public const double JUMP_VELOCITY = 9.0;
    public const double TERMINAL_FALL_SPEED = 30.0;
    public const double COYOTE_TIME = 0.1;
    public const double JUMP_BUFFER = 0.1;
  }
}
