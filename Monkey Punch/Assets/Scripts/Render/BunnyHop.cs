using UnityEngine;

namespace MonkeyPunch.Render {
  /// <summary>
  /// M10: procedural hop animator for the Bunny enemy. Same pattern as
  /// SlimeBob.cs — drives a CHILD visual transform so it doesn't fight
  /// the server's per-frame root transform.position writes.
  ///
  /// Vertical sine wave with a slight forward lean on the upstroke
  /// (suggests rapid little hops). Faster bobSpeed than slime by default.
  /// </summary>
  public class BunnyHop : MonoBehaviour {
    [SerializeField] private Transform visual;
    [SerializeField] private float bobSpeed = 9f;       // faster than slime (5)
    [Range(0f, 0.4f)]
    [SerializeField] private float hopHeight = 0.15f;
    [Range(0f, 25f)]
    [SerializeField] private float forwardLeanDegrees = 12f;

    private Vector3 visualInitialLocalPos;
    private Vector3 visualInitialEulerAngles;
    private Vector3 previousRootPos;
    private bool hasPreviousRootPos;
    private float heldYaw;
    private float phase;

    void Awake() {
      if (visual == null) visual = transform;
      visualInitialLocalPos = visual.localPosition;
      visualInitialEulerAngles = visual.localEulerAngles;
      phase = Random.Range(0f, Mathf.PI * 2f);
      heldYaw = visualInitialEulerAngles.y * Mathf.Deg2Rad;
    }

    void LateUpdate() {
      Vector3 currentRoot = transform.position;
      float dt = Time.deltaTime;
      if (hasPreviousRootPos && dt > 0f) {
        Vector3 velocity = (currentRoot - previousRootPos) / dt;
        if (LocomotionParams.TryComputeTargetYaw(velocity, out float targetYaw)) {
          heldYaw = targetYaw;
        }
      }
      previousRootPos = currentRoot;
      hasPreviousRootPos = true;

      float t = Time.time * bobSpeed + phase;
      float sinT = Mathf.Sin(t);
      float hop = hopHeight * Mathf.Max(0f, sinT);
      // Forward lean on upstroke — positive sin means going up means lean forward.
      float lean = forwardLeanDegrees * Mathf.Max(0f, sinT);

      visual.localPosition = new Vector3(
        visualInitialLocalPos.x,
        visualInitialLocalPos.y + hop,
        visualInitialLocalPos.z
      );
      // Apply yaw + lean. Yaw around Y, lean around X (forward axis tilt).
      visual.localRotation = Quaternion.Euler(
        visualInitialEulerAngles.x + lean,
        heldYaw * Mathf.Rad2Deg,
        visualInitialEulerAngles.z
      );
    }
  }
}
