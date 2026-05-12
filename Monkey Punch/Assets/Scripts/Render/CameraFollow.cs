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

    [Header("Mouse Control (Megabonk-style continuous mouselook)")]
    [Tooltip("Radians per Mouse.delta count (horizontal). In Cursor.lockState=Locked, Unity reads raw HID deltas — magnitude differs from screen pixels, so this is tuned independently from any windowed-cursor approach.")]
    [SerializeField] private float mouseSensitivityX = 0.005f;
    [Tooltip("Radians per Mouse.delta count (vertical).")]
    [SerializeField] private float mouseSensitivityY = 0.004f;

    private const double DEG = Math.PI / 180.0;
    private const double DEFAULT_PITCH = 35.0 * DEG;
    private const double PITCH_MIN = -10.0 * DEG;
    private const double PITCH_MAX = 60.0 * DEG;

    private bool didLogDeltaSample;

    void Awake() {
      if (Instance != null && Instance != this) {
        Debug.LogWarning("[CameraFollow] Multiple instances detected — using the latest.");
      }
      Instance = this;
      // Megabonk-style mouselook: lock the cursor on entry so mouse
      // motion drives the camera continuously, no right-click gate.
      // GameUI is responsible for unlocking when a modal is shown
      // (level-up overlay needs button clicks; run-over needs the
      // Restart button).
      Cursor.lockState = CursorLockMode.Locked;
      Cursor.visible = false;
    }

    void Update() {
      // If a modal owns the cursor (GameUI explicitly unlocked it),
      // skip camera rotation entirely — the user is clicking UI, not
      // aiming. CameraFollow polls cursor state rather than asking
      // GameUI directly so the two components stay decoupled.
      if (Cursor.lockState != CursorLockMode.Locked) return;

      var mouse = Mouse.current;
      if (mouse == null) return;

      // In Locked mode the Input System routes raw mouse motion (HID
      // deltas) directly to Mouse.delta. macOS / Retina's sub-pixel
      // accumulator quirk only affects the UNLOCKED cursor path; with
      // the cursor locked, delta magnitudes are honest counts and the
      // sensitivity scalar works as expected.
      Vector2 d = mouse.delta.ReadValue();

      // One-shot diagnostic so we have a concrete sample if the
      // sensitivity feels wrong on this hardware. Logged at the first
      // non-trivial frame of motion only.
      if (!didLogDeltaSample && (Mathf.Abs(d.x) > 0.5f || Mathf.Abs(d.y) > 0.5f)) {
        didLogDeltaSample = true;
        Debug.Log($"[CameraFollow] First locked-mode mouse delta: dx={d.x:F2} dy={d.y:F2} " +
                  $"sensX={mouseSensitivityX:F3} sensY={mouseSensitivityY:F3}");
      }

      Yaw -= d.x * mouseSensitivityX;
      // Unity Mouse.delta.y is POSITIVE when the mouse moves up the
      // screen. We want mouse-up = look-up (camera lowers / view tilts
      // toward sky) so subtract.
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
