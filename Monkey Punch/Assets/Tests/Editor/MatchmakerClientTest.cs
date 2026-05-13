using System.Linq;
using NUnit.Framework;
using MonkeyPunch.Net;

namespace MonkeyPunch.Tests.Editor {
  public class MatchmakerClientTest {

    [Test]
    public void ToHttpUrl_Ws_ReturnsHttp() {
      Assert.AreEqual("http://localhost:2567/rooms/game",
        MatchmakerClient.ToHttpUrl("ws://localhost:2567"));
    }

    [Test]
    public void ToHttpUrl_Wss_ReturnsHttps() {
      Assert.AreEqual("https://prod.example.com/rooms/game",
        MatchmakerClient.ToHttpUrl("wss://prod.example.com"));
    }

    [Test]
    public void ToHttpUrl_WssNonStandardPort_KeepsPort() {
      Assert.AreEqual("https://prod.example.com:8443/rooms/game",
        MatchmakerClient.ToHttpUrl("wss://prod.example.com:8443"));
    }

    [Test]
    public void ToHttpUrl_TrailingSlash_Stripped() {
      Assert.AreEqual("http://host:9999/rooms/game",
        MatchmakerClient.ToHttpUrl("ws://host:9999/"));
    }

    [Test]
    public void ParseRooms_Valid_ReturnsAll() {
      const string json = "[" +
        "{\"roomId\":\"r1\",\"clients\":3,\"maxClients\":10," +
        "\"metadata\":{\"code\":\"K7M3\",\"hostName\":\"yon\"}}," +
        "{\"roomId\":\"r2\",\"clients\":0,\"maxClients\":10," +
        "\"metadata\":{\"code\":\"P2QX\",\"hostName\":null}}" +
      "]";

      var rooms = MatchmakerClient.ParseRooms(json);

      Assert.AreEqual(2, rooms.Count);
      Assert.AreEqual("K7M3", rooms[0].metadata.code);
      Assert.AreEqual("yon", rooms[0].metadata.hostName);
      Assert.AreEqual(3, rooms[0].clients);
      Assert.AreEqual("P2QX", rooms[1].metadata.code);
      // JsonUtility maps a JSON `null` string to "" — controller treats
      // both empty and null as "(no host)".
    }

    [Test]
    public void ParseRooms_MissingCode_RowDropped() {
      const string json = "[" +
        "{\"roomId\":\"r1\",\"clients\":1,\"maxClients\":10," +
        "\"metadata\":{\"hostName\":\"jess\"}}," +
        "{\"roomId\":\"r2\",\"clients\":2,\"maxClients\":10," +
        "\"metadata\":{\"code\":\"M4WT\",\"hostName\":\"alex\"}}" +
      "]";

      var rooms = MatchmakerClient.ParseRooms(json);

      Assert.AreEqual(1, rooms.Count);
      Assert.AreEqual("M4WT", rooms[0].metadata.code);
    }

    [Test]
    public void ParseRooms_EmptyArray_ReturnsEmpty() {
      var rooms = MatchmakerClient.ParseRooms("[]");
      Assert.AreEqual(0, rooms.Count);
    }

    [Test]
    public void ParseRooms_Malformed_ReturnsEmpty() {
      var rooms = MatchmakerClient.ParseRooms("not json");
      Assert.AreEqual(0, rooms.Count);
    }
  }
}
