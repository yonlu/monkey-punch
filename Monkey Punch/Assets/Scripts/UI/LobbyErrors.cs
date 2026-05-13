using System;
using System.IO;

namespace MonkeyPunch.UI {
  // Classifies connect-attempt exceptions into user-facing messages.
  // The Colyseus C# SDK's exception types vary by version; we match on
  // message substrings rather than typed codes to stay resilient.
  // IOException (raised by MatchmakerClient.Fetch and similar network
  // failures) is treated as "server unreachable".
  public static class LobbyErrors {
    public static string Classify(Exception ex) {
      if (ex == null) return "Couldn't reach the server. Try again in a moment.";

      if (ex is IOException) {
        return "Couldn't reach the server. Try again in a moment.";
      }

      var msg = ex.Message ?? string.Empty;
      var lower = msg.ToLowerInvariant();

      if (lower.Contains("locked")) return "That room is full.";
      if (lower.Contains("expired")) return "Couldn't find a room with that code.";
      if (lower.Contains("invalid_criteria")) return "Couldn't find a room with that code.";
      if (lower.Contains("no rooms found")) return "Couldn't find a room with that code.";

      return $"Couldn't join: {msg}";
    }
  }
}
