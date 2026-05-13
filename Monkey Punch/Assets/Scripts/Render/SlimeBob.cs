using UnityEngine;

namespace MonkeyPunch.Render {
  // Procedural slime/blob locomotion-feel — no rig, no Animator.
  //
  // The server drives the slime's world position (NetworkClient writes
  // root transform.position every Update). SlimeBob layers a procedural
  // squash-and-stretch on a CHILD transform's localScale + localPosition
  // so the visible mesh hops/squashes without fighting the server's
  // authoritative position writes on the root.
  //
  // One SlimeBob per spawned enemy GameObject. ~Zero per-frame cost
  // (one sin + a couple multiplies), so this scales fine up to the
  // MAX_ENEMIES=300 ceiling.
  public class SlimeBob : MonoBehaviour {
    [Tooltip("The child transform that holds the slime visual mesh. " +
             "Its localScale + localPosition.y are driven each frame.")]
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

    void Awake() {
      if (visual == null) {
        // Fallback: bob the root itself. This overwrites position once
        // per frame which fights server writes — acceptable only when
        // the prefab is misconfigured and the visual child is missing.
        visual = transform;
      }
      visualInitialScale = visual.localScale;
      visualInitialLocalPos = visual.localPosition;
      // Random phase so a swarm of slimes doesn't squash in lockstep.
      phase = Random.Range(0f, Mathf.PI * 2f);
    }

    void LateUpdate() {
      float t = Time.time * bobSpeed + phase;
      float sinT = Mathf.Sin(t);

      // Volume-conserving squash: vertical scale * vertical, horizontal
      // scale * 1/sqrt(vertical) so the slime appears to retain mass as
      // it stretches. Pure sin gives equal time in compress and stretch.
      float vScale = 1f + squashAmount * sinT;
      float hScale = 1f / Mathf.Sqrt(vScale);
      visual.localScale = new Vector3(
        visualInitialScale.x * hScale,
        visualInitialScale.y * vScale,
        visualInitialScale.z * hScale
      );

      // Hop: rises only during the stretch half of the cycle. Using
      // max(0, sin) so the slime doesn't sink below its base during
      // compress (compress already visually anchors it to the ground).
      float hop = bobHeight * Mathf.Max(0f, sinT);
      visual.localPosition = new Vector3(
        visualInitialLocalPos.x,
        visualInitialLocalPos.y + hop,
        visualInitialLocalPos.z
      );
    }
  }
}
