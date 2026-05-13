using NUnit.Framework;
using UnityEngine;
using MonkeyPunch.Render;

namespace MonkeyPunch.Tests.Editor {
  public class LocomotionParamsTest {
    [Test]
    public void ComputeSpeed_ZeroVelocity_ReturnsZero() {
      Assert.AreEqual(0f, LocomotionParams.ComputeSpeed(Vector3.zero), 1e-6f);
    }

    [Test]
    public void ComputeSpeed_HorizontalOnly_ReturnsMagnitude() {
      // (3, 0, 4) -> 5 (classic 3-4-5 triangle on XZ).
      Assert.AreEqual(5f, LocomotionParams.ComputeSpeed(new Vector3(3f, 0f, 4f)), 1e-6f);
    }

    [Test]
    public void ComputeSpeed_IgnoresVerticalComponent() {
      // Vertical velocity (jump / gravity) must not affect locomotion speed.
      // (3, 100, 4) still returns 5.
      Assert.AreEqual(5f, LocomotionParams.ComputeSpeed(new Vector3(3f, 100f, 4f)), 1e-6f);
    }

    [Test]
    public void TryComputeTargetYaw_BelowEpsilon_ReturnsFalse() {
      // 0.01 m/s is below SPEED_EPSILON (0.05). Should return false so the
      // caller knows to hold the previous yaw rather than snap.
      bool ok = LocomotionParams.TryComputeTargetYaw(new Vector3(0.01f, 0f, 0f), out _);
      Assert.IsFalse(ok);
    }

    [Test]
    public void TryComputeTargetYaw_MovingPositiveZ_ReturnsZeroYaw() {
      // Heading toward world +Z is yaw 0 (atan2(0, +z) = 0). This is the
      // identity facing in Unity's left-handed Y-up convention.
      bool ok = LocomotionParams.TryComputeTargetYaw(new Vector3(0f, 0f, 5f), out float yaw);
      Assert.IsTrue(ok);
      Assert.AreEqual(0f, yaw, 1e-6f);
    }

    [Test]
    public void TryComputeTargetYaw_MovingPositiveX_ReturnsPiOverTwo() {
      // Heading toward world +X. atan2(+x, 0) = pi/2.
      bool ok = LocomotionParams.TryComputeTargetYaw(new Vector3(5f, 0f, 0f), out float yaw);
      Assert.IsTrue(ok);
      Assert.AreEqual(Mathf.PI / 2f, yaw, 1e-6f);
    }

    [Test]
    public void TryComputeTargetYaw_MovingNegativeZ_ReturnsPi() {
      // Heading toward world -Z (a 180° turn). atan2(0, -z) -> pi.
      bool ok = LocomotionParams.TryComputeTargetYaw(new Vector3(0f, 0f, -5f), out float yaw);
      Assert.IsTrue(ok);
      Assert.AreEqual(Mathf.PI, yaw, 1e-6f);
    }

    [Test]
    public void TryComputeTargetYaw_IgnoresVerticalVelocity() {
      // (0, 100, 5) — vertical doesn't influence yaw.
      bool ok = LocomotionParams.TryComputeTargetYaw(new Vector3(0f, 100f, 5f), out float yaw);
      Assert.IsTrue(ok);
      Assert.AreEqual(0f, yaw, 1e-6f);
    }
  }
}
