using UnityEngine;

namespace MonkeyPunch.Render {
  // Pure math helpers used by PlayerAvatar to translate world-space
  // velocity into Animator parameters and facing rotation. Extracted
  // into a static class so the math is unit-testable without Unity's
  // runtime lifecycle.
  //
  // Tuning constants live here too — co-locating them with the math
  // keeps "what value, why" in one place.
  public static class LocomotionParams {
    // Below this horizontal speed (m/s) we treat the character as
    // stationary: TryComputeTargetYaw returns false so the caller holds
    // the previous yaw rather than snapping. 0.05 m/s is well below
    // PLAYER_SPEED (~5 m/s) and above per-frame jitter from snapshot
    // interpolation, so a player standing still does not visibly spin.
    public const float SPEED_EPSILON = 0.05f;

    // Per-second slerp rate for transform rotation toward target yaw.
    // Tuned for Megabonk-style "snaps toward direction of travel"
    // without feeling instant. Plan task 9 may revisit during smoke
    // testing.
    public const float YAW_SLERP_RATE = 12f;

    // Damp time passed to Animator.SetFloat. 0.1s is the conventional
    // Unity default and produces smooth blending between idle/walk/run
    // without visible lag.
    public const float SPEED_DAMP_TIME = 0.1f;

    /// <summary>
    /// Horizontal-plane magnitude of the velocity vector. Vertical
    /// component (jumping / gravity) is intentionally ignored —
    /// locomotion clips are XZ-plane animations.
    /// </summary>
    public static float ComputeSpeed(Vector3 velocity) {
      return new Vector2(velocity.x, velocity.z).magnitude;
    }

    /// <summary>
    /// Yaw angle (radians) the character should face when moving along
    /// `velocity`. Returns false if the horizontal speed is below
    /// SPEED_EPSILON, indicating the caller should hold its previous
    /// yaw rather than snap. Yaw convention: atan2(x, z), so 0 = +Z,
    /// +pi/2 = +X (matches Unity's left-handed Y-up world).
    /// </summary>
    public static bool TryComputeTargetYaw(Vector3 velocity, out float yaw) {
      float speed = ComputeSpeed(velocity);
      if (speed < SPEED_EPSILON) {
        yaw = 0f;
        return false;
      }
      yaw = Mathf.Atan2(velocity.x, velocity.z);
      return true;
    }
  }
}
