# Unity Lobby UI Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a boot-time lobby in the Unity client where a player chooses a name, sees a refreshing room list, creates or joins a room, and re-enters the lobby on leave/run-end.

**Architecture:** Two scenes (`Lobby.unity`, `Game.unity`) with a `Bootstrap` singleton (`DontDestroyOnLoad`) carrying the connected `Colyseus.Room` across the scene boundary. The lobby owns the connect handshake so failures stay in the lobby; `NetworkClient.Start` is refactored to adopt the room instead of calling `JoinOrCreate`.

**Tech Stack:** Unity 6 with UI Toolkit (UXML/USS), Colyseus C# SDK (`io.colyseus.sdk` from upstream Git), `UnityWebRequest` for HTTP, `JsonUtility` for parsing, Unity Test Framework 1.6 for edit-mode unit tests.

**Spec:** [`docs/superpowers/specs/2026-05-13-unity-lobby-ui-design.md`](../specs/2026-05-13-unity-lobby-ui-design.md) (commit `52b9d94`).

---

## File Structure

### New files

| Path | Responsibility |
|---|---|
| `Monkey Punch/Assets/Scripts/Net/Bootstrap.cs` | Persistent singleton holding `Colyseus.Client`, current `Room<RoomState>`, display name, and `PendingBanner`. Centralizes `LeaveAndReturnToLobby`. |
| `Monkey Punch/Assets/Scripts/Net/MatchmakerClient.cs` | Static helper: `ToHttpUrl`, `ParseRooms(string json)`, async `Fetch(serverUrl, ct)`. Pure I/O. |
| `Monkey Punch/Assets/Scripts/UI/LobbyControls.cs` | Pure helper computing button-enabled state from `(name, code, state)`. Factored out for testability. |
| `Monkey Punch/Assets/Scripts/UI/LobbyErrors.cs` | Pure helper classifying exceptions to user-facing strings. |
| `Monkey Punch/Assets/Scripts/UI/LobbyController.cs` | MonoBehaviour. Wires UIDocument to logic. Owns polling, connect attempts, banner. |
| `Monkey Punch/Assets/UI/LobbyUI.uxml` | Lobby UI structure (single-column Layout A). |
| `Monkey Punch/Assets/UI/LobbyUI.uss` | Lobby styles. Reuses GameUI color tokens (duplicated onto `.lobby-root`). |
| `Monkey Punch/Assets/Scenes/Lobby.unity` | New scene. UIDocument + LobbyController + Bootstrap. |
| `Monkey Punch/Assets/Tests/Editor/MatchmakerClientTest.cs` | NUnit tests for `ToHttpUrl` and `ParseRooms`. |
| `Monkey Punch/Assets/Tests/Editor/LobbyControlsTest.cs` | NUnit tests for `LobbyControls.Compute`. |
| `Monkey Punch/Assets/Tests/Editor/LobbyErrorsTest.cs` | NUnit tests for `LobbyErrors.Classify`. |

### Modified files

| Path | Change |
|---|---|
| `Monkey Punch/Assets/Scripts/Net/NetworkClient.cs` | `Start()` adopts `Bootstrap.I.Room` instead of `JoinOrCreate`. Remove `serverUrl/roomName/playerName` SerializeFields. Remove `OnDestroy` `room.Leave()`. Add `GameUI.Instance.SetRoomCode(...)` call inside `PushHudState`. |
| `Monkey Punch/Assets/Scripts/UI/GameUI.cs` | Add `SetRoomCode(string)`, Esc pause keybinding, pause/leave-confirm modal handling, `AnyModalOpen` extension. |
| `Monkey Punch/Assets/UI/GameUI.uxml` | Add `#hud-code` label, `#pausemenu` modal, `#leave-confirm` modal. Change run-over button text from `RESTART` to `BACK TO LOBBY`. |
| `Monkey Punch/Assets/UI/GameUI.uss` | Add `.hud-code` and `.pause-modal` styles. |
| `Monkey Punch/Assets/Scripts/Combat/CombatVfx.cs` | `OnRunEnded` / `OnPlayerDowned` callbacks call `Bootstrap.I.LeaveAndReturnToLobby(...)` instead of `ReloadScene`. Delete `ReloadScene`. |
| `Monkey Punch/Assets/Scenes/SampleScene.unity` | Rename to `Game.unity` (Unity editor rename so the `.meta` file's GUID is preserved and `EditorBuildSettings.asset` updates automatically). |
| `Monkey Punch/ProjectSettings/EditorBuildSettings.asset` | Add `Lobby.unity` at index 0; `Game.unity` at index 1. |

---

## Task 1: `Bootstrap` singleton

**Files:**
- Create: `Monkey Punch/Assets/Scripts/Net/Bootstrap.cs`

No unit test — this is a thin Unity-lifecycle singleton; behavior is covered by the manual smoke checklist at the end. Adding a unit test would require mocking `SceneManager` and provides little value.

- [ ] **Step 1: Create `Bootstrap.cs`**

Path: `Monkey Punch/Assets/Scripts/Net/Bootstrap.cs`

```csharp
using System;
using System.Threading.Tasks;
using Colyseus;
using MonkeyPunch.Wire;
using UnityEngine;
using UnityEngine.SceneManagement;

namespace MonkeyPunch.Net {
  // DontDestroyOnLoad singleton parked on the first lobby load. Holds the
  // Colyseus client + the current Room across the Lobby→Game→Lobby scene
  // boundary. Lobby fills `Room` on a successful connect; LeaveAndReturnToLobby
  // releases it. NetworkClient.Start adopts `Room` instead of calling
  // JoinOrCreate itself.
  public class Bootstrap : MonoBehaviour {
    public static Bootstrap I { get; private set; }

    [SerializeField] private string serverUrl = "ws://localhost:2567";
    public string ServerUrl => serverUrl;

    public Client Client { get; private set; }
    public Room<RoomState> Room { get; set; }
    public string DisplayName { get; set; }

    // Set by LeaveAndReturnToLobby; the next LobbyController.OnEnable
    // reads & clears it to surface context (e.g. "Run ended").
    public string PendingBanner { get; set; }

    void Awake() {
      if (I != null && I != this) {
        // Re-entering the Lobby scene instantiates a second Bootstrap
        // alongside the persistent one. Destroy the newcomer; the
        // persistent one already holds the live Client + Room.
        Destroy(gameObject);
        return;
      }
      I = this;
      DontDestroyOnLoad(gameObject);
      Client = new Client(serverUrl);
    }

    public async void LeaveAndReturnToLobby(string banner = null) {
      if (Room != null) {
        try { await Room.Leave(); }
        catch (Exception ex) {
          Debug.LogWarning($"[Bootstrap] Room.Leave failed (already gone?): {ex.Message}");
        }
        Room = null;
      }
      DisplayName = null;
      PendingBanner = banner;
      SceneManager.LoadScene("Lobby");
    }
  }
}
```

- [ ] **Step 2: Verify it compiles**

In Unity, wait for domain reload after saving. Open `Window > General > Console`. Expected: no compile errors. The class won't be instantiated yet (no scene references it) — that's fine.

- [ ] **Step 3: Commit**

```bash
git add "Monkey Punch/Assets/Scripts/Net/Bootstrap.cs"
git commit -m "feat(lobby): add Bootstrap singleton for cross-scene Room handoff"
```

---

## Task 2: `MatchmakerClient` — pure helpers + tests

**Files:**
- Create: `Monkey Punch/Assets/Scripts/Net/MatchmakerClient.cs`
- Test: `Monkey Punch/Assets/Tests/Editor/MatchmakerClientTest.cs`

TDD order: tests first.

- [ ] **Step 1: Write the failing test**

Path: `Monkey Punch/Assets/Tests/Editor/MatchmakerClientTest.cs`

```csharp
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
```

- [ ] **Step 2: Run the test to verify it fails**

In Unity: `Window > General > Test Runner > EditMode > Run All`. Expected: every test fails with `MatchmakerClient does not contain a definition for…` or similar — the class doesn't exist yet.

- [ ] **Step 3: Implement `MatchmakerClient`**

Path: `Monkey Punch/Assets/Scripts/Net/MatchmakerClient.cs`

```csharp
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
```

- [ ] **Step 4: Run the tests to verify they pass**

In Unity Test Runner: `Run All` under EditMode. Expected: all 7 tests pass.

- [ ] **Step 5: Commit**

```bash
git add "Monkey Punch/Assets/Scripts/Net/MatchmakerClient.cs" \
        "Monkey Punch/Assets/Tests/Editor/MatchmakerClientTest.cs"
git commit -m "feat(lobby): add MatchmakerClient with ParseRooms + ToHttpUrl tests"
```

---

## Task 3: `LobbyControls` — state-helper + tests

**Files:**
- Create: `Monkey Punch/Assets/Scripts/UI/LobbyControls.cs`
- Test: `Monkey Punch/Assets/Tests/Editor/LobbyControlsTest.cs`

- [ ] **Step 1: Write the failing test**

Path: `Monkey Punch/Assets/Tests/Editor/LobbyControlsTest.cs`

```csharp
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
```

- [ ] **Step 2: Run the tests to verify they fail**

Unity Test Runner: `Run All`. Expected: all 6 `LobbyControlsTest` cases fail with "could not be resolved".

- [ ] **Step 3: Implement `LobbyControls`**

Path: `Monkey Punch/Assets/Scripts/UI/LobbyControls.cs`

```csharp
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
```

- [ ] **Step 4: Run the tests to verify they pass**

Unity Test Runner: `Run All`. Expected: 13 tests pass (7 from Task 2 + 6 new).

- [ ] **Step 5: Commit**

```bash
git add "Monkey Punch/Assets/Scripts/UI/LobbyControls.cs" \
        "Monkey Punch/Assets/Tests/Editor/LobbyControlsTest.cs"
git commit -m "feat(lobby): add LobbyControls.Compute state-helper + tests"
```

---

## Task 4: `LobbyErrors` — exception classifier + tests

**Files:**
- Create: `Monkey Punch/Assets/Scripts/UI/LobbyErrors.cs`
- Test: `Monkey Punch/Assets/Tests/Editor/LobbyErrorsTest.cs`

- [ ] **Step 1: Write the failing test**

Path: `Monkey Punch/Assets/Tests/Editor/LobbyErrorsTest.cs`

```csharp
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
```

- [ ] **Step 2: Run the tests to verify they fail**

Unity Test Runner: `Run All`. Expected: 6 `LobbyErrorsTest` cases fail.

- [ ] **Step 3: Implement `LobbyErrors`**

Path: `Monkey Punch/Assets/Scripts/UI/LobbyErrors.cs`

```csharp
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
```

- [ ] **Step 4: Run the tests to verify they pass**

Unity Test Runner: `Run All`. Expected: 19 tests pass total.

- [ ] **Step 5: Commit**

```bash
git add "Monkey Punch/Assets/Scripts/UI/LobbyErrors.cs" \
        "Monkey Punch/Assets/Tests/Editor/LobbyErrorsTest.cs"
git commit -m "feat(lobby): add LobbyErrors exception classifier + tests"
```

---

## Task 5: `LobbyUI.uxml` + `LobbyUI.uss`

**Files:**
- Create: `Monkey Punch/Assets/UI/LobbyUI.uxml`
- Create: `Monkey Punch/Assets/UI/LobbyUI.uss`

No unit tests — this is declarative UI. Verified via UI Toolkit's UI Builder preview and during Task 6's controller wiring.

- [ ] **Step 1: Create the UXML**

Path: `Monkey Punch/Assets/UI/LobbyUI.uxml`

```xml
<ui:UXML xmlns:ui="UnityEngine.UIElements" xmlns:uie="UnityEditor.UIElements"
         xsi="http://www.w3.org/2001/XMLSchema-instance"
         engine="UnityEngine.UIElements" editor="UnityEditor.UIElements"
         noNamespaceSchemaLocation="../../UIElementsSchema/UIElements.xsd"
         editor-extension-mode="False">
  <Style src="project://database/Assets/UI/LobbyUI.uss"/>

  <ui:VisualElement name="root" class="lobby-root">

    <ui:Label name="title" class="lobby-title" text="MONKEY PUNCH"/>

    <ui:VisualElement name="banner" class="lobby-banner hidden">
      <ui:Label name="banner-text" class="banner-text" text=""/>
    </ui:VisualElement>

    <ui:VisualElement class="lobby-card">
      <ui:Label class="field-label" text="DISPLAY NAME"/>
      <ui:TextField name="name-input" max-length="16"/>
      <ui:Button name="create-btn" class="primary-btn" text="CREATE NEW ROOM"/>
    </ui:VisualElement>

    <ui:VisualElement class="lobby-card">
      <ui:VisualElement class="rooms-header">
        <ui:Label name="rooms-title" class="section-title" text="AVAILABLE ROOMS (—)"/>
        <ui:Button name="refresh-btn" class="icon-btn" text="↻"/>
      </ui:VisualElement>
      <ui:ScrollView name="rooms-scroll" class="rooms-scroll">
        <ui:VisualElement name="rooms-list" class="rooms-list"/>
        <ui:Label name="rooms-empty" class="rooms-empty hidden"
                  text="No rooms yet — be the first to create one"/>
      </ui:ScrollView>
    </ui:VisualElement>

    <ui:VisualElement class="lobby-card">
      <ui:Label class="field-label" text="OR JOIN BY CODE"/>
      <ui:VisualElement class="code-input-row">
        <ui:TextField name="code-input" max-length="4"/>
        <ui:Button name="join-code-btn" class="secondary-btn" text="JOIN"/>
      </ui:VisualElement>
    </ui:VisualElement>

  </ui:VisualElement>
</ui:UXML>
```

- [ ] **Step 2: Create the USS**

Path: `Monkey Punch/Assets/UI/LobbyUI.uss`

```css
/* Color tokens duplicated from GameUI.uss because USS has no @import.
   If these drift, copy from GameUI.uss — single source of truth lives
   there. */
.lobby-root {
  --mp-gold:        rgb(255, 216, 96);
  --mp-dark:        rgba(40, 20, 10, 0.92);
  --mp-brown:       rgb(138, 90, 42);
  --mp-brown-deep:  rgb(58, 36, 16);
  --mp-hp-red:      rgb(240, 64, 48);
  --mp-shadow:      rgba(0, 0, 0, 0.85);

  position: absolute;
  left: 0; right: 0; top: 0; bottom: 0;

  -unity-font-definition: url("project://database/Assets/Fonts/PressStart2P-Regular.ttf");
  color: rgb(255, 255, 255);

  align-items: center;
  padding-top: 40px;
  padding-bottom: 24px;
  background-color: rgb(20, 12, 6);
}
.hidden { display: none; }

/* ----- Title ----- */
.lobby-title {
  font-size: 36px;
  color: var(--mp-gold);
  -unity-text-outline-color: var(--mp-shadow);
  -unity-text-outline-width: 2px;
  letter-spacing: 4px;
  margin-bottom: 18px;
}

/* ----- Banner (errors AND context messages) ----- */
.lobby-banner {
  width: 600px;
  max-width: 90%;
  padding: 10px 14px;
  margin-bottom: 12px;
  background-color: var(--mp-dark);
  border-width: 2px;
  border-color: var(--mp-brown);
}
.lobby-banner.error {
  border-color: var(--mp-hp-red);
}
.banner-text {
  font-size: 12px;
  white-space: normal;
}

/* ----- Cards ----- */
.lobby-card {
  width: 600px;
  max-width: 90%;
  padding: 14px;
  margin-bottom: 12px;
  background-color: var(--mp-dark);
  border-width: 2px;
  border-color: var(--mp-brown);
}

.field-label {
  font-size: 10px;
  color: var(--mp-gold);
  letter-spacing: 1px;
  margin-bottom: 6px;
}

.section-title {
  font-size: 12px;
  color: var(--mp-gold);
  letter-spacing: 1px;
}

/* ----- Inputs ----- */
TextField {
  font-size: 14px;
  margin-bottom: 8px;
}
TextField > * > .unity-text-element {
  color: rgb(255, 255, 255);
}

/* ----- Buttons ----- */
.primary-btn {
  height: 36px;
  font-size: 13px;
  background-color: rgb(60, 100, 50);
  border-color: rgb(120, 180, 100);
  border-width: 2px;
  color: rgb(255, 255, 255);
  letter-spacing: 1px;
}
.primary-btn:hover { background-color: rgb(80, 130, 60); }
.primary-btn:active { background-color: rgb(50, 85, 40); }
.primary-btn:disabled {
  background-color: rgb(60, 50, 40);
  border-color: rgb(90, 70, 50);
  color: rgb(160, 150, 140);
}

.secondary-btn {
  height: 30px;
  padding: 0 14px;
  font-size: 12px;
  background-color: var(--mp-brown-deep);
  border-color: var(--mp-brown);
  border-width: 2px;
  color: rgb(255, 255, 255);
  letter-spacing: 1px;
}
.secondary-btn:hover { background-color: var(--mp-brown); }
.secondary-btn:disabled { color: rgb(140, 130, 120); }

.icon-btn {
  width: 32px;
  height: 24px;
  padding: 0;
  font-size: 14px;
  background-color: var(--mp-brown-deep);
  border-color: var(--mp-brown);
  border-width: 2px;
  color: rgb(255, 255, 255);
}
.icon-btn:hover { background-color: var(--mp-brown); }

/* ----- Rooms section ----- */
.rooms-header {
  flex-direction: row;
  justify-content: space-between;
  align-items: center;
  margin-bottom: 8px;
}
.rooms-scroll {
  max-height: 240px;
}
.rooms-empty {
  font-size: 11px;
  color: rgb(180, 165, 150);
  -unity-font-style: italic;
  padding: 14px;
  -unity-text-align: middle-center;
}

/* ----- Room row ----- */
.room-row {
  flex-direction: row;
  align-items: center;
  padding: 8px 10px;
  margin-bottom: 4px;
  background-color: rgb(28, 18, 10);
  border-width: 1px;
  border-color: var(--mp-brown);
  border-radius: 0;
}
.room-row:hover {
  background-color: rgb(40, 28, 16);
}
.room-row:active {
  background-color: rgb(24, 14, 8);
}
.room-row-full {
  opacity: 0.45;
}
.room-host {
  flex-grow: 1;
  font-size: 12px;
}
.room-code {
  width: 70px;
  font-size: 12px;
  color: var(--mp-gold);
  letter-spacing: 1px;
}
.room-players {
  width: 60px;
  font-size: 12px;
  -unity-text-align: middle-right;
}
.room-full-badge {
  width: 50px;
  font-size: 10px;
  color: var(--mp-hp-red);
  -unity-text-align: middle-right;
}

/* ----- Code-input row ----- */
.code-input-row {
  flex-direction: row;
  align-items: center;
}
.code-input-row > TextField {
  width: 100px;
  margin-right: 8px;
  margin-bottom: 0;
}
```

- [ ] **Step 3: Verify they load**

In Unity: with `LobbyUI.uxml` selected in the Project window, open the `Inspector` and click "Open in UI Builder". Confirm the UXML parses and the USS attaches without errors (UI Builder console at the bottom should be empty). The preview shows the title, three cards, and the empty rooms section — no live data yet.

- [ ] **Step 4: Commit**

```bash
git add "Monkey Punch/Assets/UI/LobbyUI.uxml" "Monkey Punch/Assets/UI/LobbyUI.uss"
git commit -m "feat(lobby): add LobbyUI.uxml + LobbyUI.uss (Layout A)"
```

---

## Task 6: `LobbyController` — wire UI to logic

**Files:**
- Create: `Monkey Punch/Assets/Scripts/UI/LobbyController.cs`

This is the biggest file. No unit test for the controller itself — the pure logic it delegates to (`LobbyControls`, `LobbyErrors`, `MatchmakerClient.ParseRooms`) is covered in Tasks 2–4. The async I/O + UIDocument wiring is validated in the manual smoke at Task 14.

- [ ] **Step 1: Create `LobbyController.cs`**

Path: `Monkey Punch/Assets/Scripts/UI/LobbyController.cs`

```csharp
using System;
using System.Collections.Generic;
using System.Threading;
using System.Threading.Tasks;
using Colyseus;
using MonkeyPunch.Net;
using MonkeyPunch.Wire;
using UnityEngine;
using UnityEngine.SceneManagement;
using UnityEngine.UIElements;

namespace MonkeyPunch.UI {
  [RequireComponent(typeof(UIDocument))]
  public class LobbyController : MonoBehaviour {
    [Header("Polling")]
    [SerializeField] private float pollIntervalS = 5f;
    private const string DisplayNamePrefsKey = "mp.displayName";

    private UIDocument doc;
    private VisualElement root;
    private TextField nameInput;
    private TextField codeInput;
    private Button createBtn;
    private Button joinCodeBtn;
    private Button refreshBtn;
    private VisualElement bannerEl;
    private Label bannerText;
    private Label roomsTitle;
    private VisualElement roomsList;
    private Label roomsEmpty;

    private LobbyState state = LobbyState.Idle;
    private CancellationTokenSource pollCts;
    private CancellationTokenSource connectCts;
    private bool manualRefreshInFlight;
    private List<MatchmakerClient.AvailableRoom> lastRooms = new();

    void OnEnable() {
      doc = GetComponent<UIDocument>();
      root = doc.rootVisualElement;

      nameInput   = root.Q<TextField>("name-input");
      codeInput   = root.Q<TextField>("code-input");
      createBtn   = root.Q<Button>("create-btn");
      joinCodeBtn = root.Q<Button>("join-code-btn");
      refreshBtn  = root.Q<Button>("refresh-btn");
      bannerEl    = root.Q<VisualElement>("banner");
      bannerText  = root.Q<Label>("banner-text");
      roomsTitle  = root.Q<Label>("rooms-title");
      roomsList   = root.Q<VisualElement>("rooms-list");
      roomsEmpty  = root.Q<Label>("rooms-empty");

      // Prefill name from PlayerPrefs
      nameInput.value = PlayerPrefs.GetString(DisplayNamePrefsKey, "");

      // Auto-uppercase code as the user types
      codeInput.RegisterValueChangedCallback(evt => {
        var upper = (evt.newValue ?? "").ToUpperInvariant();
        if (upper != evt.newValue) {
          codeInput.SetValueWithoutNotify(upper);
        }
        SyncControlsToState();
        HideBannerIfError();
      });
      nameInput.RegisterValueChangedCallback(_ => {
        SyncControlsToState();
        HideBannerIfError();
      });

      createBtn.clicked   += OnCreateClicked;
      joinCodeBtn.clicked += OnJoinCodeClicked;
      refreshBtn.clicked  += OnRefreshClicked;

      // Surface any banner left by Bootstrap.LeaveAndReturnToLobby
      if (Bootstrap.I != null && !string.IsNullOrEmpty(Bootstrap.I.PendingBanner)) {
        ShowBanner(Bootstrap.I.PendingBanner, isError: false);
        Bootstrap.I.PendingBanner = null;
      }

      SyncControlsToState();
      pollCts = new CancellationTokenSource();
      _ = PollLoop(pollCts.Token);
    }

    void OnDisable() {
      createBtn.clicked   -= OnCreateClicked;
      joinCodeBtn.clicked -= OnJoinCodeClicked;
      refreshBtn.clicked  -= OnRefreshClicked;
      pollCts?.Cancel();
      connectCts?.Cancel();
    }

    // ----- Polling -----

    private async Task PollLoop(CancellationToken ct) {
      // First fetch fires immediately.
      while (!ct.IsCancellationRequested) {
        await Refresh(ct);
        try { await Task.Delay(TimeSpan.FromSeconds(pollIntervalS), ct); }
        catch (OperationCanceledException) { break; }
      }
    }

    private async Task Refresh(CancellationToken ct) {
      if (state == LobbyState.Connecting) return;
      if (!Application.isFocused) return;
      if (Bootstrap.I == null) return;
      try {
        var rooms = await MatchmakerClient.Fetch(Bootstrap.I.ServerUrl, ct);
        if (ct.IsCancellationRequested) return;
        lastRooms = rooms;
        RenderRooms(rooms, stale: false);
      } catch (OperationCanceledException) { /* expected */ }
      catch (Exception ex) {
        RenderRooms(lastRooms, stale: true);
        Debug.LogWarning($"[Lobby] refresh failed: {ex.Message}");
      }
    }

    private async void OnRefreshClicked() {
      if (manualRefreshInFlight) return;
      manualRefreshInFlight = true;
      var ct = pollCts?.Token ?? CancellationToken.None;
      try { await Refresh(ct); }
      finally { manualRefreshInFlight = false; }
    }

    // ----- Rendering -----

    private void RenderRooms(List<MatchmakerClient.AvailableRoom> rooms, bool stale) {
      string countStr = stale ? "—" : rooms.Count.ToString();
      string suffix   = stale ? "  ·  couldn't refresh — retrying" : "";
      roomsTitle.text = $"AVAILABLE ROOMS ({countStr}){suffix}";
      roomsList.Clear();

      if (rooms.Count == 0 && !stale) {
        roomsList.AddToClassList("hidden");
        roomsEmpty.RemoveFromClassList("hidden");
        return;
      }
      roomsList.RemoveFromClassList("hidden");
      roomsEmpty.AddToClassList("hidden");

      foreach (var r in rooms) {
        roomsList.Add(BuildRoomRow(r));
      }
      if (stale) {
        roomsList.style.opacity = 0.5f;
      } else {
        roomsList.style.opacity = 1f;
      }
    }

    private VisualElement BuildRoomRow(MatchmakerClient.AvailableRoom r) {
      var row = new VisualElement();
      row.AddToClassList("room-row");
      bool full = r.clients >= r.maxClients;
      if (full) {
        row.AddToClassList("room-row-full");
        row.SetEnabled(false);
      }

      var host = new Label(string.IsNullOrEmpty(r.metadata.hostName)
                            ? "(no host)" : r.metadata.hostName);
      host.AddToClassList("room-host");
      var code = new Label(r.metadata.code);
      code.AddToClassList("room-code");
      var players = new Label($"{r.clients} / {r.maxClients}");
      players.AddToClassList("room-players");
      var fullBadge = new Label(full ? "FULL" : "");
      fullBadge.AddToClassList("room-full-badge");

      row.Add(host); row.Add(code); row.Add(players); row.Add(fullBadge);

      row.RegisterCallback<ClickEvent>(_ => OnRowClicked(r));
      return row;
    }

    private void OnRowClicked(MatchmakerClient.AvailableRoom r) {
      var s = LobbyControls.Compute(nameInput.value, codeInput.value, state);
      if (!s.RowClickEnabled) return;
      if (r.clients >= r.maxClients) return;
      codeInput.SetValueWithoutNotify(r.metadata.code);
      var name = nameInput.value.Trim();
      _ = TryConnect(() => Bootstrap.I.Client.Join<RoomState>("game",
        new Dictionary<string, object> {
          { "name", name }, { "code", r.metadata.code }
        }), name);
    }

    // ----- Connect -----

    private async void OnCreateClicked() {
      var name = nameInput.value.Trim();
      var s = LobbyControls.Compute(name, codeInput.value, state);
      if (!s.CreateEnabled) return;
      await TryConnect(() => Bootstrap.I.Client.Create<RoomState>("game",
        new Dictionary<string, object> { { "name", name } }), name, createBtn);
    }

    private async void OnJoinCodeClicked() {
      var name = nameInput.value.Trim();
      var code = (codeInput.value ?? "").Trim().ToUpperInvariant();
      var s = LobbyControls.Compute(name, code, state);
      if (!s.JoinByCodeEnabled) return;
      await TryConnect(() => Bootstrap.I.Client.Join<RoomState>("game",
        new Dictionary<string, object> { { "name", name }, { "code", code } }),
        name, joinCodeBtn);
    }

    private async Task TryConnect(
        Func<Task<Room<RoomState>>> connect, string name, Button busyBtn = null) {
      if (state == LobbyState.Connecting) return;
      if (Bootstrap.I == null) {
        ShowBanner("Internal error: Bootstrap missing. Restart the app.", isError: true);
        return;
      }
      SetState(LobbyState.Connecting);
      HideBanner();
      string originalLabel = busyBtn?.text;
      if (busyBtn != null) busyBtn.text = "CONNECTING…";

      connectCts?.Cancel();
      connectCts = new CancellationTokenSource();
      try {
        var room = await connect();
        Bootstrap.I.Room = room;
        Bootstrap.I.DisplayName = name;
        PlayerPrefs.SetString(DisplayNamePrefsKey, name);
        PlayerPrefs.Save();
        SceneManager.LoadScene("Game");
        // Don't restore button label or state — we're switching scenes.
      } catch (Exception ex) {
        ShowBanner(LobbyErrors.Classify(ex), isError: true);
        SetState(LobbyState.Idle);
        if (busyBtn != null && originalLabel != null) busyBtn.text = originalLabel;
      }
    }

    // ----- State sync -----

    private void SetState(LobbyState next) {
      state = next;
      SyncControlsToState();
    }

    private void SyncControlsToState() {
      var s = LobbyControls.Compute(
        nameInput?.value, codeInput?.value, state);
      createBtn.SetEnabled(s.CreateEnabled);
      joinCodeBtn.SetEnabled(s.JoinByCodeEnabled);
      // Refresh is disabled during Connecting (the spec calls for full
      // disable-and-wait). The Refresh() method also early-outs on
      // Connecting as a belt-and-suspenders guard.
      refreshBtn.SetEnabled(state != LobbyState.Connecting);
      nameInput.SetEnabled(state != LobbyState.Connecting);
      codeInput.SetEnabled(state != LobbyState.Connecting);
      // Row clickability is gated inside OnRowClicked via LobbyControls;
      // no per-row SetEnabled needed each frame (full rows are SetEnabled
      // false at row-build time).
    }

    // ----- Banner -----

    private void ShowBanner(string text, bool isError) {
      bannerText.text = text;
      bannerEl.RemoveFromClassList("hidden");
      if (isError) bannerEl.AddToClassList("error");
      else bannerEl.RemoveFromClassList("error");
    }

    private void HideBanner() {
      bannerEl.AddToClassList("hidden");
      bannerEl.RemoveFromClassList("error");
    }

    private void HideBannerIfError() {
      if (bannerEl.ClassListContains("error")) HideBanner();
    }
  }
}
```

- [ ] **Step 2: Verify it compiles**

In Unity Console: no compile errors after domain reload. Expected references resolved: `Colyseus`, `MonkeyPunch.Net.Bootstrap`, `MonkeyPunch.Net.MatchmakerClient`, `MonkeyPunch.Wire.RoomState`.

- [ ] **Step 3: Commit**

```bash
git add "Monkey Punch/Assets/Scripts/UI/LobbyController.cs"
git commit -m "feat(lobby): add LobbyController (UI wiring, polling, connect)"
```

---

## Task 7: Assemble the `Lobby.unity` scene

**Files:**
- Create: `Monkey Punch/Assets/Scenes/Lobby.unity`

Pure Unity-editor work — no source edits. The scene is checked in as a YAML asset.

- [ ] **Step 1: Create the scene**

In Unity:

1. `File > New Scene > Basic (Built-in)`. Then `File > Save As…` and save to `Assets/Scenes/Lobby.unity`.
2. In the Hierarchy, **delete the default Directional Light** (no 3D content; lobby is pure UI). Keep the Main Camera.
3. Select Main Camera. In the Inspector:
   - `Clear Flags` → `Solid Color`. `Background` → RGB `(20, 12, 6)` (matches the lobby USS background).
   - Disable `Audio Listener`? Optional; harmless either way.
4. `GameObject > Create Empty`, rename to `Bootstrap`. Attach the `Bootstrap` component (drag `Bootstrap.cs` onto it). Leave `Server URL` at the default `ws://localhost:2567`.
5. `GameObject > UI Toolkit > UI Document`. Name it `LobbyUI`. In the Inspector, set `Source Asset` to `Assets/UI/LobbyUI.uxml`.
6. With `LobbyUI` selected, attach the `LobbyController` component (drag `LobbyController.cs` onto it).
7. Save the scene (`Ctrl+S`).

- [ ] **Step 2: Verify it opens**

Double-click `Assets/Scenes/Lobby.unity` in the Project window. Confirm:
- Game view shows the lobby chrome (title, three cards, empty rooms section).
- Hierarchy shows `Main Camera`, `Bootstrap`, `LobbyUI`.
- Console has no errors.

(The lobby won't function correctly yet — there's no server in Build Settings and `SceneManager.LoadScene("Game")` will fail. That's covered by Tasks 8–9.)

- [ ] **Step 3: Commit**

```bash
git add "Monkey Punch/Assets/Scenes/Lobby.unity" \
        "Monkey Punch/Assets/Scenes/Lobby.unity.meta"
git commit -m "feat(lobby): add Lobby.unity scene (Bootstrap + UIDocument + Controller)"
```

---

## Task 8: Rename `SampleScene.unity` → `Game.unity`

**Files:**
- Modify (rename): `Monkey Punch/Assets/Scenes/SampleScene.unity` → `Game.unity`
- Modify (auto): `Monkey Punch/ProjectSettings/EditorBuildSettings.asset` (path string only; GUID preserved)

Rename **inside Unity** so the `.meta` file is renamed atomically and `EditorBuildSettings.asset` updates its path string automatically. Renaming outside Unity (e.g., `mv` in PowerShell) can leave the meta file dangling.

- [ ] **Step 1: Rename the scene**

In the Unity Project window:

1. Navigate to `Assets/Scenes/`.
2. Right-click `SampleScene` → `Rename` → type `Game` → press Enter.
3. Unity will reimport. The Console should show no errors.

- [ ] **Step 2: Verify the rename**

```bash
ls "Monkey Punch/Assets/Scenes/"
```

Expected output includes: `Game.unity`, `Game.unity.meta`, `Lobby.unity`, `Lobby.unity.meta`. No `SampleScene*` files remain.

```bash
grep -F "Game.unity" "Monkey Punch/ProjectSettings/EditorBuildSettings.asset"
```

Expected: at least one line with `path: Assets/Scenes/Game.unity`. (If Unity didn't auto-update the build settings, fix manually in Task 9.)

- [ ] **Step 3: Commit**

```bash
git add -A "Monkey Punch/Assets/Scenes/" "Monkey Punch/ProjectSettings/EditorBuildSettings.asset"
git commit -m "refactor(scene): rename SampleScene to Game"
```

---

## Task 9: Build Settings — Lobby at 0, Game at 1

**Files:**
- Modify: `Monkey Punch/ProjectSettings/EditorBuildSettings.asset`

Unity loads the scene at build index 0 by default when the player starts. We need `Lobby.unity` at index 0 and `Game.unity` at index 1.

- [ ] **Step 1: Update Build Settings**

In Unity:

1. `File > Build Profiles` (Unity 6) — or `File > Build Settings` on older versions. Open the "Scene List" section.
2. Drag `Assets/Scenes/Lobby.unity` from the Project window into the scene list. It should appear with an index.
3. Reorder so `Lobby` is at index 0 and `Game` is at index 1. Both checkboxes enabled.
4. Close the dialog. The settings persist to `ProjectSettings/EditorBuildSettings.asset`.

- [ ] **Step 2: Verify**

```bash
cat "Monkey Punch/ProjectSettings/EditorBuildSettings.asset"
```

Expected: `m_Scenes:` block with two entries, `Lobby.unity` first and `Game.unity` second, both `enabled: 1`.

- [ ] **Step 3: Commit**

```bash
git add "Monkey Punch/ProjectSettings/EditorBuildSettings.asset"
git commit -m "build(scenes): add Lobby at index 0, Game at index 1"
```

---

## Task 10: Refactor `NetworkClient.Start` to adopt `Bootstrap.I.Room`

**Files:**
- Modify: `Monkey Punch/Assets/Scripts/Net/NetworkClient.cs`

No new unit tests — the refactor is verified by the manual smoke that the game scene still works end-to-end after coming from the lobby. The existing `LocomotionParamsTest`, `PredictorGoldenTest`, and `GameUITest` continue to pass.

- [ ] **Step 1: Edit `NetworkClient.cs`**

Replace the SerializeField block and the top of `Start()`:

Find (around line 30–42):
```csharp
    [Header("Connection")]
    [SerializeField] private string serverUrl = "ws://localhost:2567";
    [SerializeField] private string roomName = "game";
    [SerializeField] private string playerName = "UnitySpectator";
```

Replace with:
```csharp
    // Connection metadata now lives on Bootstrap (DDOL singleton). The
    // lobby fills Bootstrap.I.Room before LoadScene("Game") and we adopt
    // it here in Start.
```

Find (around line 249–260):
```csharp
    async void Start() {
      Debug.Log($"[NetworkClient] Connecting to {serverUrl} as {playerName}");
      client = new Client(serverUrl);

      var options = new Dictionary<string, object> { { "name", playerName } };
      try {
        room = await client.JoinOrCreate<RoomState>(roomName, options);
      } catch (Exception ex) {
        Debug.LogError($"[NetworkClient] JoinOrCreate failed: {ex.Message}\n{ex}");
        return;
      }

      Debug.Log($"[NetworkClient] Joined room id={room.RoomId} session={room.SessionId}");
```

Replace with:
```csharp
    void Start() {
      if (Bootstrap.I == null || Bootstrap.I.Room == null) {
        Debug.LogError("[NetworkClient] Entered Game scene without a connected Room. " +
                       "Game must be loaded from Lobby. Returning to Lobby.");
        SceneManager.LoadScene("Lobby");
        return;
      }
      room = Bootstrap.I.Room;
      Debug.Log($"[NetworkClient] Adopted room id={room.RoomId} session={room.SessionId}");
```

Note the method signature changes from `async void Start()` → `void Start()` (no async/await needed now).

Find (around line 946–950):
```csharp
    async void OnDestroy() {
      if (room != null) {
        try { await room.Leave(); } catch { /* shutdown */ }
      }
    }
```

Replace with:
```csharp
    void OnDestroy() {
      // Room is shared with Bootstrap (DDOL); leaving here would break
      // the back-to-lobby flow. Centralized leave lives in
      // Bootstrap.LeaveAndReturnToLobby.
    }
```

Add to the using block at the top of the file:
```csharp
using UnityEngine.SceneManagement;
```

- [ ] **Step 2: Verify it compiles + existing tests still pass**

In Unity: domain reload completes with no errors. Run `Window > General > Test Runner > EditMode > Run All`. Expected: all tests pass (including the lobby ones from Tasks 2–4).

- [ ] **Step 3: Commit**

```bash
git add "Monkey Punch/Assets/Scripts/Net/NetworkClient.cs"
git commit -m "refactor(net): NetworkClient adopts Bootstrap.I.Room instead of JoinOrCreate"
```

---

## Task 11: Room-code HUD pill

**Files:**
- Modify: `Monkey Punch/Assets/UI/GameUI.uxml`
- Modify: `Monkey Punch/Assets/UI/GameUI.uss`
- Modify: `Monkey Punch/Assets/Scripts/UI/GameUI.cs`
- Modify: `Monkey Punch/Assets/Scripts/Net/NetworkClient.cs` (call site only)

- [ ] **Step 1: Add the Label to `GameUI.uxml`**

Open `Monkey Punch/Assets/UI/GameUI.uxml`. Find the `<!-- Top-right level -->` comment (around line 19–20):

```xml
    <!-- Top-right level -->
    <ui:Label name="hud-level" class="hud-level" text="LV 1" picking-mode="Ignore"/>
```

Insert immediately after the `hud-level` label:

```xml
    <!-- Top-right room code (below the level label) -->
    <ui:Label name="hud-code" class="hud-code" text="" picking-mode="Ignore"/>
```

- [ ] **Step 2: Add USS for `.hud-code`**

Open `Monkey Punch/Assets/UI/GameUI.uss`. Append at the end of the file:

```css
/* ===== Top-right room code pill ===== */
.hud-code {
  position: absolute;
  top: 44px;
  right: 18px;
  font-size: 14px;
  color: var(--mp-gold);
  background-color: var(--mp-dark);
  border-width: 2px;
  border-color: var(--mp-brown);
  padding: 4px 8px;
  letter-spacing: 1px;
}
```

- [ ] **Step 3: Add `SetRoomCode` to `GameUI.cs`**

Open `Monkey Punch/Assets/Scripts/UI/GameUI.cs`. In the "UI Toolkit element refs" section (around line 65–80), add:

```csharp
    private Label hudCode;
```

In the `OnEnable` method where other refs are cached (look for `root.Q<Label>("hud-level")` or similar pattern), add:

```csharp
      hudCode = root.Q<Label>("hud-code");
```

Add a new public method near `SetHud` (search for `public void SetHud`):

```csharp
    public void SetRoomCode(string code) {
      if (hudCode == null) return;
      hudCode.text = string.IsNullOrEmpty(code) ? "" : code;
    }
```

- [ ] **Step 4: Wire the call from `NetworkClient.PushHudState`**

Open `Monkey Punch/Assets/Scripts/Net/NetworkClient.cs`. Find `PushHudState` (around line 885). After the `GameUI.Instance.SetHud(s);` line, add:

```csharp
      GameUI.Instance.SetRoomCode(room.State?.code);
```

- [ ] **Step 5: Manual smoke**

(Requires the server running. Pre-Task-14 smoke; defer if not yet wired.)

1. Boot the server: `pnpm dev` in another terminal.
2. Press Play in Unity from `Lobby.unity`.
3. Type any name, click Create.
4. Verify: Game scene loads, the 4-char room code appears top-right below the level label.

- [ ] **Step 6: Commit**

```bash
git add "Monkey Punch/Assets/UI/GameUI.uxml" \
        "Monkey Punch/Assets/UI/GameUI.uss" \
        "Monkey Punch/Assets/Scripts/UI/GameUI.cs" \
        "Monkey Punch/Assets/Scripts/Net/NetworkClient.cs"
git commit -m "feat(hud): add in-game room-code pill (top-right)"
```

---

## Task 12: Pause menu + leave-confirm in `GameUI`

**Files:**
- Modify: `Monkey Punch/Assets/UI/GameUI.uxml`
- Modify: `Monkey Punch/Assets/UI/GameUI.uss`
- Modify: `Monkey Punch/Assets/Scripts/UI/GameUI.cs`

- [ ] **Step 1: Add the two modals to `GameUI.uxml`**

Open `Monkey Punch/Assets/UI/GameUI.uxml`. Find the closing `</ui:VisualElement>` of the `root` element (last line before `</ui:UXML>`). Insert **before** it, after the `runover` block:

```xml
    <!-- Pause menu (Esc-toggled) -->
    <ui:VisualElement name="pausemenu" class="runover-modal pause-modal hidden">
      <ui:VisualElement class="runover-dimmer"/>
      <ui:VisualElement class="runover-panel">
        <ui:Label class="runover-title" text="PAUSED"/>
        <ui:Button name="pause-resume" class="runover-btn" text="RESUME"/>
        <ui:Button name="pause-leave"  class="runover-btn" text="LEAVE ROOM"/>
      </ui:VisualElement>
    </ui:VisualElement>

    <!-- Leave confirmation (only opened from the pause menu) -->
    <ui:VisualElement name="leave-confirm" class="runover-modal pause-modal hidden">
      <ui:VisualElement class="runover-dimmer"/>
      <ui:VisualElement class="runover-panel">
        <ui:Label class="runover-title" text="LEAVE ROOM?"/>
        <ui:Button name="leave-cancel"      class="runover-btn" text="CANCEL"/>
        <ui:Button name="leave-confirm-btn" class="runover-btn" text="LEAVE"/>
      </ui:VisualElement>
    </ui:VisualElement>
```

Note we reuse `.runover-modal` for the dimmer-and-panel base layout; `.pause-modal` is added in case we ever want pause-specific overrides.

- [ ] **Step 2: Add minimal USS**

Open `Monkey Punch/Assets/UI/GameUI.uss`. Append at the end:

```css
/* ===== Pause / leave-confirm modals =====
   Reuses .runover-modal positioning + .runover-dimmer/.runover-panel
   visuals. No overrides needed today; .pause-modal exists as a hook
   for future per-modal tweaks. */
.pause-modal {
  /* intentionally empty */
}
```

- [ ] **Step 3: Wire `GameUI.cs`**

Open `Monkey Punch/Assets/Scripts/UI/GameUI.cs`.

Add to the element-refs region:

```csharp
    private VisualElement pauseMenuEl;
    private VisualElement leaveConfirmEl;
    private Button pauseResume;
    private Button pauseLeave;
    private Button leaveCancel;
    private Button leaveConfirmBtn;
    private bool pauseVisible;
    private bool leaveConfirmVisible;
```

In `OnEnable` element-caching block, add:

```csharp
      pauseMenuEl      = root.Q<VisualElement>("pausemenu");
      leaveConfirmEl   = root.Q<VisualElement>("leave-confirm");
      pauseResume      = root.Q<Button>("pause-resume");
      pauseLeave       = root.Q<Button>("pause-leave");
      leaveCancel      = root.Q<Button>("leave-cancel");
      leaveConfirmBtn  = root.Q<Button>("leave-confirm-btn");

      if (pauseResume     != null) pauseResume.clicked     += HidePauseMenu;
      if (pauseLeave      != null) pauseLeave.clicked      += ShowLeaveConfirm;
      if (leaveCancel     != null) leaveCancel.clicked     += HideLeaveConfirm;
      if (leaveConfirmBtn != null) leaveConfirmBtn.clicked += OnConfirmLeave;
```

In `OnDisable` add matching `-= …` lines.

Add methods:

```csharp
    private void ShowPauseMenu() {
      pauseVisible = true;
      pauseMenuEl?.RemoveFromClassList("hidden");
    }
    private void HidePauseMenu() {
      pauseVisible = false;
      pauseMenuEl?.AddToClassList("hidden");
    }
    private void ShowLeaveConfirm() {
      leaveConfirmVisible = true;
      leaveConfirmEl?.RemoveFromClassList("hidden");
    }
    private void HideLeaveConfirm() {
      leaveConfirmVisible = false;
      leaveConfirmEl?.AddToClassList("hidden");
    }
    private void OnConfirmLeave() {
      HideLeaveConfirm();
      HidePauseMenu();
      MonkeyPunch.Net.Bootstrap.I?.LeaveAndReturnToLobby("Left room");
    }
```

Update `AnyModalOpen` getter (around line 61):

```csharp
    public bool AnyModalOpen =>
      levelUpVisible || runOverVisible || pauseVisible || leaveConfirmVisible;
```

Add Esc handling in `Update` (or `OnGUI` — search for existing Update method on `GameUI`; if there isn't one, add one):

```csharp
    // GameUI.cs already imports UnityEngine.InputSystem at the top of
    // the file, so Keyboard.current resolves without qualification.
    void Update() {
      var kb = Keyboard.current;
      if (kb == null) return;
      if (kb.escapeKey.wasPressedThisFrame) {
        // Esc precedence: level-up bar and run-over modal block pause.
        if (levelUpVisible || runOverVisible) return;
        if (leaveConfirmVisible) { HideLeaveConfirm(); return; }
        if (pauseVisible) { HidePauseMenu(); return; }
        ShowPauseMenu();
      }
    }
```

If `GameUI.cs` already has an `Update()` method, merge the Esc check into the existing one rather than adding a duplicate.

- [ ] **Step 4: Verify compiles**

Unity Console: no errors after domain reload.

- [ ] **Step 5: Manual smoke**

(Defer to Task 14 if server not yet running.)

1. Boot from Lobby, Create, land in Game.
2. Press Esc → pause menu appears.
3. Click `RESUME` or press Esc → pause closes.
4. Press Esc → pause re-opens. Click `LEAVE ROOM` → leave-confirm modal appears.
5. Click `CANCEL` (or press Esc) → leave-confirm closes, pause stays open.
6. Click `LEAVE ROOM` again → confirm → click `LEAVE` → lobby loads, banner shows "Left room", name still prefilled.

- [ ] **Step 6: Commit**

```bash
git add "Monkey Punch/Assets/UI/GameUI.uxml" \
        "Monkey Punch/Assets/UI/GameUI.uss" \
        "Monkey Punch/Assets/Scripts/UI/GameUI.cs"
git commit -m "feat(hud): add Esc pause menu + leave-confirm modal"
```

---

## Task 13: Run-end goes to lobby

**Files:**
- Modify: `Monkey Punch/Assets/Scripts/Combat/CombatVfx.cs`
- Modify: `Monkey Punch/Assets/UI/GameUI.uxml`

- [ ] **Step 1: Update `CombatVfx.cs`**

Open `Monkey Punch/Assets/Scripts/Combat/CombatVfx.cs`.

Find `OnPlayerDowned` (around line 346):

```csharp
    public void OnPlayerDowned(bool isLocal) {
      if (isLocal) {
        localPlayerDowned = true;
        if (GameUI.Instance != null) {
          GameUI.Instance.ShowRunOver("DOWNED", ReloadScene);
        }
      }
    }
```

Replace `ReloadScene` with the inline lambda:

```csharp
    public void OnPlayerDowned(bool isLocal) {
      if (isLocal) {
        localPlayerDowned = true;
        if (GameUI.Instance != null) {
          GameUI.Instance.ShowRunOver("DOWNED", () =>
            MonkeyPunch.Net.Bootstrap.I?.LeaveAndReturnToLobby("You were downed"));
        }
      }
    }
```

Find `OnRunEnded` (around line 358):

```csharp
    public void OnRunEnded() {
      runEnded = true;
      if (GameUI.Instance != null) {
        GameUI.Instance.ShowRunOver("RUN ENDED", ReloadScene);
      }
    }
```

Replace with:

```csharp
    public void OnRunEnded() {
      runEnded = true;
      if (GameUI.Instance != null) {
        GameUI.Instance.ShowRunOver("RUN ENDED", () =>
          MonkeyPunch.Net.Bootstrap.I?.LeaveAndReturnToLobby("Run ended"));
      }
    }
```

Delete the now-unused `ReloadScene` method (around line 369–377):

```csharp
    private static void ReloadScene() {
      var s = SceneManager.GetActiveScene();
      SceneManager.LoadScene(s.name);
    }
```

If `using UnityEngine.SceneManagement;` is now unreferenced in the file, remove it.

- [ ] **Step 2: Update run-over button label**

Open `Monkey Punch/Assets/UI/GameUI.uxml`. Find:

```xml
        <ui:Button name="runover-restart" class="runover-btn" text="RESTART"/>
```

Replace with:

```xml
        <ui:Button name="runover-restart" class="runover-btn" text="BACK TO LOBBY"/>
```

(The element name stays `runover-restart` to avoid touching `GameUI.cs`'s ref-caching. The label text is purely cosmetic.)

- [ ] **Step 3: Verify compiles**

Unity Console: no errors.

- [ ] **Step 4: Manual smoke**

(Defer to Task 14 if server not running.)

1. Boot from Lobby, Create, land in Game.
2. Press `K` repeatedly (debug self-damage) until HP hits 0.
3. Run-over modal shows "DOWNED" with `BACK TO LOBBY` button.
4. Click → returns to Lobby with banner "You were downed".

- [ ] **Step 5: Commit**

```bash
git add "Monkey Punch/Assets/Scripts/Combat/CombatVfx.cs" \
        "Monkey Punch/Assets/UI/GameUI.uxml"
git commit -m "feat(combat): run-end / downed return to lobby instead of reloading scene"
```

---

## Task 14: Manual smoke verification

**Files:** none (verification only)

Run through the spec's verification checklist end-to-end. Fix anything that breaks; commit any polish fixes separately.

- [ ] **Step 1: Server-down baseline**

1. Make sure the dev server is **not** running.
2. In Unity, open `Lobby.unity` and press Play.
3. Type a name, hit Create.
4. Expected: error banner appears with `"Couldn't reach the server. Try again in a moment."` No crash. Lobby returns to `Idle`; button label restored.

- [ ] **Step 2: Create / Join from two clients**

1. Run `pnpm dev` in the repo root.
2. Build the Unity client to a standalone player: `File > Build And Run` (Windows). Save to `build/MonkeyPunch.exe`.
3. Launch the standalone build. Type "yon", hit Create. Land in Game with the code visible top-right.
4. In the Unity editor, press Play in `Lobby.unity`. The list should show `yon`'s room with `1 / 10` within ≤5 seconds.
5. Click the row. The editor instance joins; standalone HUD updates to `2 / 10` (visible via debug pane bottom-right).

- [ ] **Step 3: Code-join + Full room**

1. From a third instance (run a second standalone build), enter "alex" → Create. Code displayed.
2. From the editor instance (still in lobby): type alex's code into the code field, hit Join.
3. Fill alex's room to 10/10 via repeated builds or by spawning extra clients. The row goes grey with `FULL` and is non-interactive.

- [ ] **Step 4: Pause + Leave**

1. From an in-game client, press Esc → pause menu opens.
2. Click `LEAVE ROOM` → confirm → `LEAVE`. Lobby loads with banner `"Left room"`; name still prefilled.

- [ ] **Step 5: Run-end**

1. From an in-game client, press `K` until HP hits 0.
2. Modal shows `DOWNED` + `BACK TO LOBBY`. Click → lobby with banner `"You were downed"`.

- [ ] **Step 6: Refresh cadence**

1. Two lobby instances open. Create a room in #1. Within 5 seconds it appears in #2's list without user action.
2. Click the manual `↻` button in #2 — list refreshes immediately.

- [ ] **Step 7: Focus pause**

1. With a lobby open, tab to another window for ~30 seconds.
2. Tab back. Console should not show a pile-up of failed requests. The list re-fetches once on focus regain (next poll tick).

- [ ] **Step 8: Commit any polish fixes**

If any smoke step revealed a bug:

```bash
git add <files>
git commit -m "fix(lobby): <one-line description of what was wrong>"
```

Otherwise, no commit needed.

---

## Spec coverage map

Mapping each spec section to the task(s) that implement it.

| Spec section | Implemented by |
|---|---|
| **Goal / Non-goals** | (scope) |
| **Architecture overview** | Tasks 1, 7, 8, 9, 10 |
| **Components → Bootstrap** | Task 1 |
| **Components → MatchmakerClient** | Task 2 |
| **Components → LobbyController** | Tasks 3, 4, 6 (controls/errors helpers, then controller) |
| **Components → LobbyUI.uxml + LobbyUI.uss** | Task 5 |
| **Components → NetworkClient refactor** | Task 10 |
| **Components → GameUI (pause + code pill)** | Tasks 11, 12 |
| **Components → CombatVfx run-end → lobby** | Task 13 |
| **Behavior → Room list refresh** | Task 6 (polling loop, manual refresh, focus pause, fail-dim) |
| **Behavior → Display name persistence** | Task 6 (PlayerPrefs `mp.displayName`) |
| **Behavior → Row click** | Task 6 (OnRowClicked) |
| **Behavior → Empty list** | Task 6 (RenderRooms) |
| **Behavior → Code input** | Task 6 (RegisterValueChangedCallback auto-upper) |
| **Behavior → Connecting** | Task 6 (TryConnect, button-label swap) |
| **Behavior → Banner** | Task 6 (ShowBanner / HideBanner / HideBannerIfError) |
| **Behavior → In-game escape menu** | Task 12 |
| **Behavior → Run end / downed** | Task 13 |
| **Behavior → Room code in-game** | Task 11 |
| **Testing strategy → MatchmakerClient unit tests** | Task 2 |
| **Testing strategy → LobbyControllerStateTest (LobbyControls)** | Task 3 |
| **Testing strategy → FriendlyError tests (LobbyErrors)** | Task 4 |
| **Testing strategy → Manual smoke** | Task 14 |
| **Migration → SampleScene → Game rename** | Task 8 |
| **Migration → NetworkClient SerializeFields removed** | Task 10 |
| **Migration → RUN ENDED button label change** | Task 13 |
| **Risk → Colyseus exception shape** | Task 4 (LobbyErrors uses substring matching) |
| **Risk → JsonUtility strict-shape** | Task 2 (ParseRooms validates + drops malformed rows) |
| **Risk → Scene-rename churn** | Task 8 (rename inside Unity for atomic .meta handling) |
