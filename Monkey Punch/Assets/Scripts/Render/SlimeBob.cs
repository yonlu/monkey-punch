using UnityEngine;

namespace MonkeyPunch.Render {
  // Procedural slime/blob locomotion-feel — no rig, no Animator.
  //
  // The server drives the slime's world position (NetworkClient writes
  // root transform.position every Update). SlimeBob layers TWO things
  // on a CHILD transform so it doesn't fight the server's writes on
  // the root:
  //   1. Squash-and-stretch + vertical hop (cosmetic life).
  //   2. Facing rotation derived from the root's per-frame velocity,
  //      using LocomotionParams (same helpers as PlayerAvatar — see
  //      M9 design doc Section 4).
  //
  // One SlimeBob per spawned enemy GameObject. Per-frame cost is one
  // sin, one atan2, one slerp — scales fine to MAX_ENEMIES=300.
  public class SlimeBob : MonoBehaviour {
    [Tooltip("The child transform that holds the slime visual mesh. " +
             "Its localScale, localPosition.y, and localRotation are " +
             "driven each frame.")]
    [SerializeField] private Transform visual;

    [Tooltip("Bobs per second.")]
    [SerializeField] private float bobSpeed = 5f;

    [Tooltip("Peak vertical scale change (1 + squashAmount on stretch, " +
             "1 - squashAmount on compress).")]
    [Range(0f, 0.5f)]
    [SerializeField] private float squashAmount = 0.18f;

    [Tooltip("Peak vertical hop offset (world units) at stretch peak.")]
    [SerializeField] private float bobHeight = 0.08f;

    private Vector3 visualInitialScale;
    private Vector3 visualInitialLocalPos;
    private float phase;

    // Facing state — derived from root transform.position delta each
    // LateUpdate. Same pattern as PlayerAvatar.
    private Vector3 previousRootPos;
    private bool hasPreviousRootPos;
    private float heldYaw; // last computed yaw (radians), held while stationary

    void Awake() {
      if (visual == null) {
        visual = transform;
      }
      visualInitialScale = visual.localScale;
      visualInitialLocalPos = visual.localPosition;
      phase = Random.Range(0f, Mathf.PI * 2f);
      heldYaw = visual.localEulerAngles.y * Mathf.Deg2Rad;
    }

    void LateUpdate() {
      // --- Facing (derived from root velocity) ---
      Vector3 currentRoot = transform.position;
      float dt = Time.deltaTime;
      if (hasPreviousRootPos && dt > 0f) {
        Vector3 velocity = (currentRoot - previousRootPos) / dt;
        if (LocomotionParams.TryComputeTargetYaw(velocity, out float targetYaw)) {
          heldYaw = targetYaw;
        }
        float k = 1f - Mathf.Exp(-LocomotionParams.YAW_SLERP_RATE * dt);
        Quaternion targetRot = Quaternion.Euler(0f, heldYaw * Mathf.Rad2Deg, 0f);
        visual.localRotation = Quaternion.Slerp(visual.localRotation, targetRot, k);
      }
      previousRootPos = currentRoot;
      hasPreviousRootPos = true;

      // --- Squash + hop ---
      float t = Time.time * bobSpeed + phase;
      float sinT = Mathf.Sin(t);
      // Volume-conserving squash: 1/sqrt(vScale) horizontal so the slime
      // appears to retain mass as it stretches.
      float vScale = 1f + squashAmount * sinT;
      float hScale = 1f / Mathf.Sqrt(vScale);
      visual.localScale = new Vector3(
        visualInitialScale.x * hScale,
        visualInitialScale.y * vScale,
        visualInitialScale.z * hScale
      );
      // Hop rises during the stretch half only (max(0, sin)) so the
      // slime doesn't sink below its base during compress.
      float hop = bobHeight * Mathf.Max(0f, sinT);
      visual.localPosition = new Vector3(
        visualInitialLocalPos.x,
        visualInitialLocalPos.y + hop,
        visualInitialLocalPos.z
      );
    }
  }
}
