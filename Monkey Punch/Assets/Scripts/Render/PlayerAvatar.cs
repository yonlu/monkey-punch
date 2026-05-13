using UnityEngine;

namespace MonkeyPunch.Render {
  // M9: self-contained avatar driver. One per spawned Player GameObject.
  //
  // Each LateUpdate it reads its own transform.position (which
  // NetworkClient.Update has just written this frame — either via
  // predictor + extrapolation for the local player, or via
  // SnapshotBuffer interpolation for remotes) and diffs against the
  // previous frame to derive world-space velocity. Velocity feeds:
  //   - Animator "Speed" parameter (drives the 1D BlendTree).
  //   - Target yaw, slerped into transform.rotation.
  //
  // The two-path local-vs-remote velocity question is collapsed by
  // reading the post-write transform: it's the same code regardless of
  // whether the source upstream is predictor or snapshot buffer. See
  // M9 design doc Section 4 ("Facing & velocity computation").
  //
  // Ordering: LateUpdate is guaranteed to run after every Update, so
  // NetworkClient.Update's position write is always visible here. Same
  // pattern CameraFollow already uses.
  [RequireComponent(typeof(Animator))]
  public class PlayerAvatar : MonoBehaviour {
    // Hash lookups are faster than string parameter names; cache once.
    private static readonly int SpeedParamHash = Animator.StringToHash("Speed");

    private Animator animator;
    private Vector3 previousPosition;
    private bool hasPreviousPosition;
    private float heldYaw; // Last computed yaw, held while stationary.

    void Awake() {
      animator = GetComponent<Animator>();
      // Server is authoritative for position; the animator must not
      // move the root transform.
      animator.applyRootMotion = false;
      heldYaw = transform.eulerAngles.y * Mathf.Deg2Rad;
    }

    void LateUpdate() {
      Vector3 current = transform.position;
      float dt = Time.deltaTime;

      // First frame after spawn: no previous sample to diff against.
      // Initialize and bail; next frame produces a valid velocity.
      if (!hasPreviousPosition || dt <= 0f) {
        previousPosition = current;
        hasPreviousPosition = true;
        return;
      }

      Vector3 velocity = (current - previousPosition) / dt;
      previousPosition = current;

      float speed = LocomotionParams.ComputeSpeed(velocity);
      animator.SetFloat(SpeedParamHash, speed, LocomotionParams.SPEED_DAMP_TIME, dt);

      if (LocomotionParams.TryComputeTargetYaw(velocity, out float targetYaw)) {
        heldYaw = targetYaw;
      }
      // Slerp the actual rotation toward heldYaw at YAW_SLERP_RATE per
      // second. Quaternion.Slerp with t in [0,1] — use 1 - exp(-rate*dt)
      // for frame-rate-independent easing (same pattern as CameraFollow's
      // followRate).
      float t = 1f - Mathf.Exp(-LocomotionParams.YAW_SLERP_RATE * dt);
      Quaternion targetRot = Quaternion.Euler(0f, heldYaw * Mathf.Rad2Deg, 0f);
      transform.rotation = Quaternion.Slerp(transform.rotation, targetRot, t);
    }
  }
}
