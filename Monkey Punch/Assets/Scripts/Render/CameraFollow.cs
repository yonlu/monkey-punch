using UnityEngine;
using MonkeyPunch.Net;

namespace MonkeyPunch.Render {
  // Simple third-person camera follow. Polls NetworkClient.Instance for
  // the local player's Transform each LateUpdate and snaps the camera
  // to (target + offset) in world space. Smoothing kept light so server
  // ticks (20Hz) and snapshot interp (~100ms behind) don't compound
  // with camera-lag visual noise. No yaw / orbit / Cinemachine yet —
  // Phase 7 will swap to a proper FreeLook.
  [RequireComponent(typeof(Camera))]
  public class CameraFollow : MonoBehaviour {
    [Header("Follow")]
    [SerializeField] private Vector3 offset = new Vector3(0f, 8f, -10f);
    [Tooltip("0 = snap, 1 = no follow. Lerp factor toward target per frame.")]
    [Range(0f, 1f)]
    [SerializeField] private float smoothness = 0.2f;

    void LateUpdate() {
      var nc = NetworkClient.Instance;
      if (nc == null || nc.LocalPlayerTransform == null) return;

      Vector3 desired = nc.LocalPlayerTransform.position + offset;
      if (smoothness <= 0f) {
        transform.position = desired;
      } else {
        transform.position = Vector3.Lerp(transform.position, desired, 1f - smoothness);
      }
      transform.LookAt(nc.LocalPlayerTransform.position);
    }
  }
}
