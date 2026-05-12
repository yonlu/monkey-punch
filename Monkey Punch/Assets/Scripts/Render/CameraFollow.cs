using System;
using UnityEngine;
using UnityEngine.InputSystem;
using MonkeyPunch.Net;

namespace MonkeyPunch.Render {
  // Phase 8 polish: orbit camera with right-mouse-drag yaw/pitch.
  // Conventions mirror packages/client/src/camera.ts so the Unity
  // client and the TS client feel the same to play:
  //
  //   - At yaw=0 the camera sits directly behind the player at +Z and
  //     looks toward -Z.
  //   - Mouse-right (positive mouseDelta.x) DECREASES yaw — the camera
  //     "looks more right" relative to the world ground. This matches
  //     the TS handler: `_yaw -= movementX * sensX`.
  //   - Yaw increasing rotates the camera position CCW as viewed from
  //     above (camera moves through +X).
  //   - Mouse-down (positive mouseDelta.y) INCREASES pitch (camera rises
  //     higher relative to the player). Clamped to [MIN, MAX].
  //   - Offset from player at yaw/pitch:
  //       offsetX = DIST * sin(yaw) * cos(pitch)
  //       offsetY = DIST * sin(pitch) + LOOK_HEIGHT
  //       offsetZ = DIST * cos(yaw) * cos(pitch)
  //
  // The static `Yaw` property is read by NetworkClient.ComputeWorldDir
  // to transform camera-space WASD into world-space movement (TS:
  // input.ts transformToWorld). NetworkClient and CameraFollow live in
  // different assemblies / namespaces but the static reference avoids
  // an Inspector-wired Singleton GameObject for a single-camera scene.
  [RequireComponent(typeof(Camera))]
  public class CameraFollow : MonoBehaviour {
    public static CameraFollow Instance { get; private set; }

    // Read by NetworkClient for camera-relative input. Double precision
    // is overkill for a yaw angle but matches the predictor's overall
    // numeric posture; allocation is identical to float for primitives.
    public double Yaw { get; private set; } = 0.0;
    public double Pitch { get; private set; } = DEFAULT_PITCH;

    [Header("Follow")]
    [Tooltip("Distance from the player along the yaw/pitch ray.")]
    [SerializeField] private float distance = 9f;       // matches CAMERA_DISTANCE in TS
    [SerializeField] private float lookHeight = 1.2f;   // matches CAMERA_LOOK_HEIGHT

    [Header("Smoothing")]
    [Tooltip("Frame-rate-independent follow rate. Per-frame factor = 1 - exp(-rate * dt). Higher = snappier.")]
    [SerializeField] private float followRate = 18f;    // matches CAMERA_FOLLOW_LERP

    [Header("Mouse Control")]
    [Tooltip("Radians per pixel of horizontal mouse motion (right-drag).")]
    // Defaults ~25× the TS reference values (TS X was 0.0025). The TS
    // client used pointer-lock with unlimited mouse travel; the Unity
    // editor's Game view does NOT lock the cursor, so the mouse hits
    // the screen edge fast and the perceived rate-per-screen needs to
    // be much higher. At 0.06 rad/px a ~105-pixel sweep is a full 360°.
    // Tunable in Inspector — drop lower if it overshoots.
    [SerializeField] private float mouseSensitivityX = 0.060f;
    [Tooltip("Radians per pixel of vertical mouse motion (right-drag).")]
    [SerializeField] private float mouseSensitivityY = 0.050f;

    private const double DEG = Math.PI / 180.0;
    private const double DEFAULT_PITCH = 35.0 * DEG;
    private const double PITCH_MIN = -10.0 * DEG;
    private const double PITCH_MAX = 60.0 * DEG;

    // Mouse-pos snapshot so we can compute screen-pixel deltas ourselves.
    // Mouse.delta.ReadValue() on macOS / Retina reports sub-pixel values
    // that no reasonable sensitivity scalar makes feel right; diffing
    // Mouse.position is robust to those quirks.
    private Vector2 lastMousePos;
    private bool rightHeldLastFrame;
    private bool didLogDeltaSample;

    void Awake() {
      if (Instance != null && Instance != this) {
        Debug.LogWarning("[CameraFollow] Multiple instances detected — using the latest.");
      }
      Instance = this;
    }

    void Update() {
      // Right-mouse-drag adjusts yaw/pitch. We don't use Cursor.lockState
      // (yet) — Phase 8 polish could add proper pointer-lock so the
      // pointer doesn't leave the window during long drags.
      //
      // Delta source: we diff Mouse.position frame-to-frame instead of
      // calling Mouse.delta.ReadValue(). On macOS / Retina screens the
      // Input System's `delta` channel can be sub-pixel (a slow
      // accumulator that doesn't reflect true cursor travel), which
      // makes any sensitivity scalar feel weak no matter how high.
      // Diffing position gives honest screen-pixel deltas everywhere.
      var mouse = Mouse.current;
      if (mouse == null) {
        rightHeldLastFrame = false;
        return;
      }
      Vector2 currentPos = mouse.position.ReadValue();
      bool held = mouse.rightButton.isPressed;
      if (!held) {
        rightHeldLastFrame = false;
        lastMousePos = currentPos;
        return;
      }
      // Edge case: right button just went down this frame. Skip the
      // delta — lastMousePos still holds wherever the cursor was last
      // frame (possibly far away if the user moved without holding
      // right), so diffing here would produce a huge spurious yaw kick.
      if (!rightHeldLastFrame) {
        rightHeldLastFrame = true;
        lastMousePos = currentPos;
        return;
      }

      Vector2 d = currentPos - lastMousePos;
      lastMousePos = currentPos;

      // One-shot diagnostic on the first non-zero delta of a session —
      // helps debug "no movement at all" reports without spamming the
      // console.
      if (!didLogDeltaSample && (Mathf.Abs(d.x) > 0.5f || Mathf.Abs(d.y) > 0.5f)) {
        didLogDeltaSample = true;
        Debug.Log($"[CameraFollow] First mouse delta sample: dx={d.x:F2} dy={d.y:F2} " +
                  $"sensX={mouseSensitivityX:F3} sensY={mouseSensitivityY:F3}");
      }

      Yaw -= d.x * mouseSensitivityX;
      // Unity screen Y is bottom-origin: Mouse.position.y INCREASES as
      // the cursor moves UP the screen. Subtract so mouse-up = look-up.
      Pitch -= d.y * mouseSensitivityY;
      if (Pitch < PITCH_MIN) Pitch = PITCH_MIN;
      if (Pitch > PITCH_MAX) Pitch = PITCH_MAX;
    }

    void LateUpdate() {
      var nc = NetworkClient.Instance;
      if (nc == null || nc.LocalPlayerTransform == null) return;

      Vector3 target = nc.LocalPlayerTransform.position;
      // Offset on yaw/pitch ray. cos(pitch) shrinks the XZ projection
      // as the camera rises; offsetY adds the lookHeight bump so the
      // camera looks slightly ABOVE the player's foot anchor.
      double cosP = Math.Cos(Pitch);
      double sinP = Math.Sin(Pitch);
      double sinY = Math.Sin(Yaw);
      double cosY = Math.Cos(Yaw);
      Vector3 offset = new Vector3(
        (float)(distance * sinY * cosP),
        (float)(distance * sinP + lookHeight),
        (float)(distance * cosY * cosP)
      );
      Vector3 desired = target + offset;
      // Frame-rate-independent exponential follow. dt should clamp on
      // long stalls; Time.deltaTime is already clamped by Unity to a
      // sane max (Time.maximumDeltaTime, default 0.333).
      float k = 1f - Mathf.Exp(-followRate * Time.deltaTime);
      transform.position = Vector3.Lerp(transform.position, desired, k);
      // Look at a point slightly above the player's foot to match the
      // offset's lookHeight bump — keeps the player centered when pitch
      // is mid-range rather than sliding toward the bottom of the screen.
      transform.LookAt(target + new Vector3(0f, lookHeight, 0f));
    }
  }
}
