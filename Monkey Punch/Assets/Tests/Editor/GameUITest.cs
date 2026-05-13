using NUnit.Framework;
using MonkeyPunch.UI;

namespace MonkeyPunch.Tests.Editor {
  public class GameUITest {
    [Test]
    public void FormatTime_Zero_ReturnsZeroPadded() {
      Assert.AreEqual("00:00", GameUI.FormatTime(0.0));
    }

    [Test]
    public void FormatTime_OneMinuteTwentyOneSeconds_FormatsCorrectly() {
      Assert.AreEqual("01:21", GameUI.FormatTime(81.0));
    }

    [Test]
    public void FormatTime_NegativeClampsToZero() {
      Assert.AreEqual("00:00", GameUI.FormatTime(-5.0));
    }
  }
}
