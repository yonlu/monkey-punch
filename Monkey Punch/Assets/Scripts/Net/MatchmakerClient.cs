using System;
using System.Collections.Generic;
using System.IO;
using System.Threading;
using System.Threading.Tasks;
using UnityEngine;
using UnityEngine.Networking;

namespace MonkeyPunch.Net {
  // Pure HTTP helper. Mirrors packages/client/src/net/matchmake.ts.
  // No Unity lifecycle, no MonoBehaviour. ParseRooms is split out so
  // edit-mode tests can exercise it without UnityWebRequest.
  public static class MatchmakerClient {
    [Serializable]
    public class RoomMetadata {
      public string code;
      public string hostName;
    }

    [Serializable]
    public class AvailableRoom {
      public string roomId;
      public int clients;
      public int maxClients;
      public RoomMetadata metadata;
    }

    [Serializable]
    private class AvailableRoomArray {
      public AvailableRoom[] items;
    }

    // ws://… → http://…   wss://… → https://…
    // Strips trailing slash and appends /rooms/game.
    public static string ToHttpUrl(string wsUrl) {
      var uri = new Uri(wsUrl);
      var scheme = uri.Scheme == "wss" ? "https" : "http";
      var port = uri.IsDefaultPort ? "" : $":{uri.Port}";
      return $"{scheme}://{uri.Host}{port}/rooms/game";
    }

    // JsonUtility can't parse a top-level array, so we wrap as {"items":[...]}.
    // Malformed input → empty list (JsonUtility throws ArgumentException).
    // Rows with metadata.code missing are dropped silently to match the TS
    // validation loop in packages/client/src/net/matchmake.ts.
    public static List<AvailableRoom> ParseRooms(string json) {
      var output = new List<AvailableRoom>();
      if (string.IsNullOrEmpty(json)) return output;
      AvailableRoomArray wrapped;
      try {
        wrapped = JsonUtility.FromJson<AvailableRoomArray>("{\"items\":" + json + "}");
      } catch (Exception) {
        return output;
      }
      if (wrapped?.items == null) return output;
      foreach (var r in wrapped.items) {
        if (r == null) continue;
        if (r.metadata == null) continue;
        if (string.IsNullOrEmpty(r.metadata.code)) continue;
        output.Add(r);
      }
      return output;
    }

    public static async Task<List<AvailableRoom>> Fetch(
        string wsServerUrl, CancellationToken ct) {
      var url = ToHttpUrl(wsServerUrl);
      using var req = UnityWebRequest.Get(url);
      var op = req.SendWebRequest();
      while (!op.isDone) {
        if (ct.IsCancellationRequested) {
          req.Abort();
          throw new OperationCanceledException();
        }
        await Task.Yield();
      }
      if (req.result != UnityWebRequest.Result.Success) {
        throw new IOException($"matchmake {req.responseCode} {req.error}");
      }
      return ParseRooms(req.downloadHandler.text);
    }
  }
}
