using System;
using System.IO;
using NUnit.Framework;
using MonkeyPunch.UI;

namespace MonkeyPunch.Tests.Editor {
  public class LobbyErrorsTest {
    [Test]
    public void Classify_LockedMessage_RoomFull() {
      var msg = LobbyErrors.Classify(new Exception("room is locked"));
      Assert.AreEqual("That room is full.", msg);
    }

    [Test]
    public void Classify_ExpiredMessage_BadCode() {
      var msg = LobbyErrors.Classify(new Exception("expired"));
      Assert.AreEqual("Couldn't find a room with that code.", msg);
    }

    [Test]
    public void Classify_InvalidCriteria_BadCode() {
      var msg = LobbyErrors.Classify(new Exception("ERR_MATCHMAKE_INVALID_CRITERIA"));
      Assert.AreEqual("Couldn't find a room with that code.", msg);
    }

    [Test]
    public void Classify_NetworkException_ServerUnreachable() {
      var msg = LobbyErrors.Classify(new IOException("matchmake 0 cannot connect"));
      Assert.AreEqual("Couldn't reach the server. Try again in a moment.", msg);
    }

    [Test]
    public void Classify_UnknownException_FallsBack() {
      var msg = LobbyErrors.Classify(new Exception("something weird"));
      StringAssert.StartsWith("Couldn't join:", msg);
      StringAssert.Contains("something weird", msg);
    }

    [Test]
    public void Classify_NullException_GenericFallback() {
      var msg = LobbyErrors.Classify(null);
      Assert.AreEqual("Couldn't reach the server. Try again in a moment.", msg);
    }
  }
}
