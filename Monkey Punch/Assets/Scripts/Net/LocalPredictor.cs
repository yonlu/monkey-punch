using System;
using System.Collections.Generic;

namespace MonkeyPunch.Net {
  // C# port of packages/client/src/net/prediction.ts. Owns the local
  // player's predicted X/Z. Step() is called once per 20Hz client tick
  // (sending the input, queuing it for replay, advancing one server-
  // equivalent tickPlayers pass). Reconcile() is called each time an
  // authoritative snapshot arrives for the local player: it resets X/Z
  // to the server's values, drops acked inputs from the queue, replays
  // remaining inputs through ApplyTick().
  //
  // SCOPE LIMIT — Phase 5 X/Z only.
  // The TS predictor also owns vertical state (y, vy, grounded,
  // lastGroundedAt, jumpBufferedAt) and snaps Y to terrainHeight() each
  // tick. terrainHeight() is the alea + simplex-noise function that the
  // migration plan defers to Phase 6 because porting it bit-identically
  // to C# is the highest-risk part of the whole port (see Phase 6 in
  // ~/.claude/plans/do-you-think-it-mighty-melody.md). To avoid pulling
  // that risk into Phase 5, this C# predictor predicts X/Z only. Y is
  // taken straight from server snapshots — the render layer reads
  // server.y from the Player schema directly. Net effect: walking is
  // instant; jumping has the same 50ms server round-trip lag Phase 3
  // had. Phase 6 (terrain streaming) will unblock the full port.
  //
  // Determinism gate (Phase 5 PRD): C# ApplyTick must produce
  // bit-identical doubles vs TS LocalPredictor.applyTick for the X/Z
  // subset. See Assets/Tests/Editor/PredictorGoldenTest.cs.
  //
  // Render-offset smoothing (visual catch-up after reconcile snaps)
  // mirrors AD4 in 2026-05-04-local-jitter-fix-design.md.
  public class LocalPredictor {
    public double X;
    public double Z;
    public int Tick;
    public double LastReconErr;

    // Cached speed_mult from the most recent reconcile. Multiplies
    // PLAYER_SPEED in ApplyTick so Sleipnir (and any future
    // speed_mult items) take effect in prediction — without this,
    // picking Sleipnir produces ~5–25% rubber-band on every snapshot.
    // Set externally via the SpeedMult property before Reconcile so
    // the replay re-applies unacked inputs at the up-to-date rate.
    // Default 1.0 (no items) preserves the bit-identical determinism
    // gate (golden fixture uses zero items).
    public double SpeedMult = 1.0;

    // Visual catch-up offset — added to (X, Z) at render time, decayed
    // exponentially in Update(). A reconcile that moves predicted X by
    // +Δ is compensated by an offset of -Δ so the cube stays put
    // visually while the offset decays to zero.
    public double RenderOffsetX;
    public double RenderOffsetZ;

    public int LastSentSeq => seq;

    // SMOOTHING_TAU_S=0.1s from prediction.ts. Matches TS render loop.
    public const double SmoothingTauS = 0.1;

    private int seq;
    private readonly Queue<UnackedInput> unacked = new Queue<UnackedInput>();

    private struct UnackedInput {
      public int Seq;
      public double DirX;
      public double DirZ;
      public bool Jump;
    }

    /// <summary>
    /// Build the next InputMessage payload and advance the predictor by
    /// one server-equivalent tick. Caller is responsible for sending the
    /// returned dictionary via room.Send("input", ...).
    /// </summary>
    public Dictionary<string, object> Step(double dirX, double dirZ, bool jump) {
      seq++;
      unacked.Enqueue(new UnackedInput { Seq = seq, DirX = dirX, DirZ = dirZ, Jump = jump });
      Tick++;
      ApplyTick(dirX, dirZ);
      return new Dictionary<string, object> {
        { "type", "input" },
        { "seq", seq },
        { "dir", new Dictionary<string, object> { { "x", dirX }, { "z", dirZ } } },
        { "jump", jump },
      };
    }

    /// <summary>
    /// Authoritative snapshot arrived for the local player. Drop acked
    /// inputs, snap to server (X, Z), replay remaining inputs, accumulate
    /// the visual catch-up offset so the rendered cube doesn't pop.
    /// </summary>
    public void Reconcile(double serverX, double serverZ, int lastProcessedInput, int serverTick) {
      while (unacked.Count > 0 && unacked.Peek().Seq <= lastProcessedInput) {
        unacked.Dequeue();
      }

      double prevX = X;
      double prevZ = Z;

      X = serverX;
      Z = serverZ;
      Tick = serverTick;

      foreach (var u in unacked) {
        Tick++;
        ApplyTick(u.DirX, u.DirZ);
      }

      double dx = X - prevX;
      double dz = Z - prevZ;
      LastReconErr = Math.Sqrt(dx * dx + dz * dz);

      // Visual catch-up — see AD4 in 2026-05-04-local-jitter-fix-design.md.
      // Keep the rendered cube where it WAS, let the render decay walk
      // the offset toward zero.
      RenderOffsetX += prevX - X;
      RenderOffsetZ += prevZ - Z;
    }

    /// <summary>
    /// Single-tick simulation. Mirrors tickPlayers in shared/rules.ts for
    /// one player — X/Z subset only. Direct line-for-line port of the
    /// horizontal-motion phase, identical operator order so the doubles
    /// match bit-for-bit.
    ///
    /// TS reference:
    ///   p.x += p.inputDir.x * PLAYER_SPEED * dt;
    ///   p.z += p.inputDir.z * PLAYER_SPEED * dt;
    ///   const r2 = p.x * p.x + p.z * p.z;
    ///   if (r2 > max2) {
    ///     const scale = MAP_RADIUS / Math.sqrt(r2);
    ///     p.x *= scale; p.z *= scale;
    ///   }
    ///
    /// Phase 8 polish: SpeedMult is now applied here. Sleipnir item
    /// (kind=3) advances this from 1.0 to up-to-1.25× at level 5.
    /// Set the SpeedMult field before Reconcile so the replay walks
    /// unacked inputs at the up-to-date rate.
    /// </summary>
    public void ApplyTick(double dirX, double dirZ) {
      X += dirX * PredictorConstants.PLAYER_SPEED * SpeedMult * PredictorConstants.SIM_DT_S;
      Z += dirZ * PredictorConstants.PLAYER_SPEED * SpeedMult * PredictorConstants.SIM_DT_S;

      double r2 = X * X + Z * Z;
      double maxR2 = PredictorConstants.MAP_RADIUS * PredictorConstants.MAP_RADIUS;
      if (r2 > maxR2) {
        double scale = PredictorConstants.MAP_RADIUS / Math.Sqrt(r2);
        X *= scale;
        Z *= scale;
      }
    }

    /// <summary>
    /// Reset the predictor state to a known starting position. Called
    /// once when the local player's schema first appears.
    /// </summary>
    public void Initialize(double serverX, double serverZ, int serverTick) {
      X = serverX;
      Z = serverZ;
      Tick = serverTick;
      seq = 0;
      unacked.Clear();
      RenderOffsetX = 0;
      RenderOffsetZ = 0;
      LastReconErr = 0;
      SpeedMult = 1.0;
    }

    /// <summary>
    /// Decay RenderOffset toward zero at the configured time constant.
    /// Called once per render frame with the elapsed dt. exp(-dt/tau) is
    /// the multiplicative shrink factor — Σ over frames matches the
    /// PlayerCube.tsx render loop.
    /// </summary>
    public void DecayRenderOffset(double dtSeconds) {
      double k = Math.Exp(-dtSeconds / SmoothingTauS);
      RenderOffsetX *= k;
      RenderOffsetZ *= k;
    }
  }
}
