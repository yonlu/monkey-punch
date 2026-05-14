using UnityEngine;

namespace MonkeyPunch.Render {
  /// <summary>
  /// M10: procedural float animator for the Ghost enemy. Y-bob on a
  /// slow sine + continuous Y-rotation drift. No squash (ghost is
  /// already flowing fabric). No facing-from-velocity (ghosts read
  /// fine without committed facing — adds to the "haunted" read).
  /// </summary>
  public class GhostFloat : MonoBehaviour {
    [SerializeField] private Transform visual;
    [SerializeField] private float bobSpeed = 1.2f;
    [Range(0f, 0.5f)]
    [SerializeField] private float bobAmplitude = 0.20f;
    [SerializeField] private float yawDriftDegPerSec = 18f;

    private Vector3 visualInitialLocalPos;
    private float phase;
    private float currentYaw;

    void Awake() {
      if (visual == null) visual = transform;
      visualInitialLocalPos = visual.localPosition;
      phase = Random.Range(0f, Mathf.PI * 2f);
      currentYaw = visual.localEulerAngles.y;
    }

    void LateUpdate() {
      float t = Time.time * bobSpeed + phase;
      float bob = Mathf.Sin(t) * bobAmplitude;
      visual.localPosition = new Vector3(
        visualInitialLocalPos.x,
        visualInitialLocalPos.y + bob,
        visualInitialLocalPos.z
      );
      currentYaw += yawDriftDegPerSec * Time.deltaTime;
      visual.localRotation = Quaternion.Euler(0f, currentYaw, 0f);
    }
  }
}
