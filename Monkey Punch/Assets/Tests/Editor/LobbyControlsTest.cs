using NUnit.Framework;
using MonkeyPunch.UI;

namespace MonkeyPunch.Tests.Editor {
  public class LobbyControlsTest {
    [Test]
    public void Compute_EmptyName_AllDisabled() {
      var s = LobbyControls.Compute(name: "", code: "", state: LobbyState.Idle);
      Assert.IsFalse(s.CreateEnabled);
      Assert.IsFalse(s.JoinByCodeEnabled);
      Assert.IsFalse(s.RowClickEnabled);
    }

    [Test]
    public void Compute_NameOnly_CreateAndRowsEnabledJoinDisabled() {
      var s = LobbyControls.Compute(name: "yon", code: "", state: LobbyState.Idle);
      Assert.IsTrue(s.CreateEnabled);
      Assert.IsFalse(s.JoinByCodeEnabled);
      Assert.IsTrue(s.RowClickEnabled);
    }

    [Test]
    public void Compute_PartialCode_JoinDisabled() {
      var s = LobbyControls.Compute(name: "yon", code: "K7", state: LobbyState.Idle);
      Assert.IsTrue(s.CreateEnabled);
      Assert.IsFalse(s.JoinByCodeEnabled);
      Assert.IsTrue(s.RowClickEnabled);
    }

    [Test]
    public void Compute_FullCode_AllEnabled() {
      var s = LobbyControls.Compute(name: "yon", code: "K7M3", state: LobbyState.Idle);
      Assert.IsTrue(s.CreateEnabled);
      Assert.IsTrue(s.JoinByCodeEnabled);
      Assert.IsTrue(s.RowClickEnabled);
    }

    [Test]
    public void Compute_NameWithWhitespaceOnly_TreatedAsEmpty() {
      var s = LobbyControls.Compute(name: "   ", code: "K7M3", state: LobbyState.Idle);
      Assert.IsFalse(s.CreateEnabled);
      Assert.IsFalse(s.JoinByCodeEnabled);
      Assert.IsFalse(s.RowClickEnabled);
    }

    [Test]
    public void Compute_Connecting_AllDisabledRegardless() {
      var s = LobbyControls.Compute(name: "yon", code: "K7M3", state: LobbyState.Connecting);
      Assert.IsFalse(s.CreateEnabled);
      Assert.IsFalse(s.JoinByCodeEnabled);
      Assert.IsFalse(s.RowClickEnabled);
    }
  }
}
