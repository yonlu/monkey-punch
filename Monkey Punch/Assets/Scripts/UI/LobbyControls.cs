namespace MonkeyPunch.UI {
  public enum LobbyState {
    Idle,
    Connecting,
  }

  public struct LobbyControlState {
    public bool CreateEnabled;
    public bool JoinByCodeEnabled;
    public bool RowClickEnabled;
  }

  // Pure derivation of which lobby controls are enabled. Factored out of
  // LobbyController so it can be exercised by edit-mode tests without
  // instantiating a UIDocument.
  public static class LobbyControls {
    public const int JoinCodeLength = 4;

    public static LobbyControlState Compute(string name, string code, LobbyState state) {
      if (state == LobbyState.Connecting) return default;

      bool hasName = !string.IsNullOrWhiteSpace(name);
      bool hasCode = code != null && code.Length == JoinCodeLength;

      return new LobbyControlState {
        CreateEnabled      = hasName,
        JoinByCodeEnabled  = hasName && hasCode,
        RowClickEnabled    = hasName,
      };
    }
  }
}
