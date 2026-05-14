using UnityEngine;

namespace MonkeyPunch.Render {
  // Cosmetic spin + bob for collectible gems. One per gem GameObject.
  //
  // The root world position is driven by NetworkClient (server-authoritative).
  // This component animates a CHILD visual transform so the root stays
  // where the server says it is — same pattern as SlimeBob.
  //
  // Random phase per instance prevents all gems on screen from animating
  // in lockstep.
  public class GemSpinBob : MonoBehaviour {
    [Tooltip("Child transform holding the gem mesh. Defaults to self if unset.")]
    [SerializeField] private Transform visual;

    [Tooltip("Spin rate around the Y axis, degrees per second.")]
    [SerializeField] private float spinDegPerSec = 90f;

    [Tooltip("Bob cycles per second.")]
    [SerializeField] private float bobSpeed = 2f;

    [Tooltip("Peak vertical bob offset (world units) from the visual's resting local y.")]
    [SerializeField] private float bobHeight = 0.15f;

    private Vector3 visualInitialLocalPos;
    private float phase;

    void Awake() {
      if (visual == null) visual = transform;
      visualInitialLocalPos = visual.localPosition;
      phase = Random.Range(0f, Mathf.PI * 2f);
    }

    void Update() {
      float t = Time.time * bobSpeed + phase;
      float y = visualInitialLocalPos.y + Mathf.Sin(t) * bobHeight;
      visual.localPosition = new Vector3(visualInitialLocalPos.x, y, visualInitialLocalPos.z);
      visual.Rotate(0f, spinDegPerSec * Time.deltaTime, 0f, Space.Self);
    }
  }
}
