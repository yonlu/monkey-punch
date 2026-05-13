# Unity Lobby UI — design

Date: 2026-05-13
Status: spec — approved during brainstorming
Scope: Unity client only (TS client `packages/client/` is deprecated per project memory). No server or `packages/shared/` changes.

## Goal

Replace the Unity client's current "auto-join a hardcoded room on Start" behavior with a proper lobby screen as the boot-time entry point. From the lobby a player can:

- Choose a display name (persisted across sessions).
- See available rooms refreshed automatically.
- Create a new room.
- Join a listed room by clicking its row.
- Join by 4-character code typed manually.

Return-to-lobby is added as a recurring flow: from the in-game Esc pause menu and after a run ends.

## Non-goals

- Accounts, auth, persistence beyond a single `PlayerPrefs` key.
- Server-side changes. `GET /rooms/game` (in `packages/server/src/index.ts:40`) and `metadata.code` filterBy (line 23) already cover everything the lobby needs.
- Continuous-run / in-room rematch flows. Run-end still terminates the room; players return to lobby and create or join a fresh room.
- Backporting the lobby to `packages/client/` (deprecated).

## Architecture overview

Two scenes. A persistent singleton carries the connected `Colyseus.Room` across the scene boundary.

```
Lobby.unity                              Game.unity
┌────────────────────────────┐          ┌──────────────────────────┐
│  UIDocument (LobbyUI.uxml) │          │  NetworkClient           │
│  LobbyController           │          │  CameraFollow             │
│                            │          │  TerrainStreamer          │
│  Bootstrap (DDOL) ─────────┼──────────┼─►  Bootstrap (same obj)   │
│   ├─ Client                │ scene    │   ├─ Room (set by lobby)  │
│   └─ Room (filled on join) │ swap     │   └─ DisplayName          │
└────────────────────────────┘          └──────────────────────────┘
       │                                       ▲
       │ SceneManager.LoadScene("Game") ───────┘
```

**Connection ownership.** The lobby performs the actual `Colyseus.Client.Create` / `Join` handshake. Failures stay in the lobby where they're actionable. On success, the live `Room` is parked on the persistent `Bootstrap` and the scene swaps to `Game`. `NetworkClient.Start` is refactored to adopt `Bootstrap.I.Room` instead of calling `JoinOrCreate` itself.

**Leave / return.** A central `Bootstrap.LeaveAndReturnToLobby(banner)` method calls `Room.Leave()`, nulls the room, stores an optional banner string for the lobby to surface, and loads `Lobby.unity`. Called from (a) the in-game Esc pause menu's confirm-Leave, and (b) the run-over modal's button (replacing the current `CombatVfx.ReloadScene`).

## Components

### `Bootstrap` (new MonoBehaviour, DDOL)

`Monkey Punch/Assets/Scripts/Net/Bootstrap.cs`

Singleton parked on the first lobby load via `DontDestroyOnLoad`. Holds:

- `Colyseus.Client Client` — created from `serverUrl` SerializeField in `Awake`.
- `Room<RoomState> Room` — set by the lobby on a successful connect; cleared on leave.
- `string DisplayName` — set on a successful connect.
- `string PendingBanner` — banner text the next lobby load should surface (e.g., "Run ended"). Lobby reads and clears in `OnEnable`.

Static `Bootstrap.I` accessor. `Awake` guards against duplicates (Lobby scene re-entry destroys the new instance).

### `MatchmakerClient` (new static helper)

`Monkey Punch/Assets/Scripts/Net/MatchmakerClient.cs`

Pure I/O, no Unity lifecycle.

- `string ToHttpUrl(string wsUrl)` — `ws://…` → `http://…`, `wss://…` → `https://…`, strips trailing slash, appends `/rooms/game`. Mirrors `packages/client/src/net/matchmake.ts:matchmakeUrl`.
- `Task<List<AvailableRoom>> Fetch(string wsServerUrl, CancellationToken ct)` — `UnityWebRequest.Get`, parses the response as a wrapped array (`JsonUtility` can't take a top-level array, so we prepend `{"items":` and append `}` before parsing).
- Returned rows with `metadata?.code == null` are dropped silently, matching `fetchAvailableRooms` validation in TS.

Types: `RoomMetadata { code, hostName }`, `AvailableRoom { roomId, clients, maxClients, metadata }`.

### `LobbyController` (new MonoBehaviour)

`Monkey Punch/Assets/Scripts/UI/LobbyController.cs`

Sits on the lobby's `UIDocument` GameObject in `Lobby.unity`.

**State machine.** Two states:

- `Idle` — name/code inputs editable, Create enabled iff `name.Trim() != ""`, Join enabled iff `name.Trim() != "" && code.Length == 4`, rows clickable iff `name.Trim() != ""` and `!row.full`.
- `Connecting` — every interactive control disabled; the clicked button's label is swapped to `"Connecting…"`.

Failure isn't a state — it's a `Connecting → Idle` transition that sets an error banner. The banner is cleared on the next user input event.

**Polling.** On `OnEnable` start a `PollLoop` task that calls `Refresh` then `await Task.Delay(pollIntervalS, ct)`. `pollIntervalS = 5`. `Refresh` is a no-op while `state == Connecting` or `Application.isFocused == false`.

Manual `[↻]` button calls `Refresh` directly, bypassing the timer.

On `OnDisable`: cancel `pollCts` and `connectCts`.

**Connect.** `OnCreateClicked` and `OnJoinCodeClicked` and row clicks all funnel through `TryConnect(Func<Task<Room<RoomState>>> connect, string name)`:

1. Set state `Connecting`.
2. Hide banner. Cancel any in-flight `connectCts`.
3. `await connect()`. On success, store room and name on `Bootstrap`, `PlayerPrefs.SetString("mp.displayName", name)`, `SceneManager.LoadScene("Game")`.
4. On exception, `ShowBanner(FriendlyError(ex), isError: true)` and return to `Idle`.

**`SyncControlsToState()`** — called on every state change and on name/code value-changed events. Single function maps inputs → enabled flags. Factored out as a pure `LobbyControls.Compute(name, code, state)` for testability.

**`FriendlyError(Exception)`** — classifies the exception (Colyseus `MatchMakeException` if available, fallback to substring matching on `ex.Message`) to one of:

- `"That room is full."`
- `"Couldn't find a room with that code."`
- `"Couldn't join: <raw message>"`
- `"Couldn't reach the server. Try again in a moment."` (non-MatchMake exceptions)

Exact code constants are confirmed against the Colyseus C# SDK during implementation; substring fallback is the only fragile bit.

### `LobbyUI.uxml` + `LobbyUI.uss` (new)

`Monkey Punch/Assets/UI/LobbyUI.uxml`
`Monkey Punch/Assets/UI/LobbyUI.uss`

UXML structure (single-column, top-down — Layout A from brainstorming):

```
root.lobby-root
├── Label#title         "MONKEY PUNCH"
├── VisualElement#banner.hidden
│   └── Label#banner-text
├── VisualElement.lobby-card  (name + create)
│   ├── Label.field-label    "DISPLAY NAME"
│   ├── TextField#name-input  (max-length=16)
│   └── Button#create-btn.primary-btn  "CREATE NEW ROOM"
├── VisualElement.lobby-card  (rooms)
│   ├── VisualElement.rooms-header
│   │   ├── Label#rooms-title  "AVAILABLE ROOMS (—)"
│   │   └── Button#refresh-btn.icon-btn  "↻"
│   └── ScrollView#rooms-scroll
│       ├── VisualElement#rooms-list   (populated by controller)
│       └── Label#rooms-empty.hidden   "No rooms yet — be the first to create one"
└── VisualElement.lobby-card  (code-join)
    ├── Label.field-label    "OR JOIN BY CODE"
    └── VisualElement.code-input-row
        ├── TextField#code-input  (max-length=4)
        └── Button#join-code-btn.secondary-btn  "JOIN"
```

**Room row** — built procedurally by `LobbyController.BuildRoomRow(AvailableRoom r)`:

```
.room-row              ← whole row registers ClickEvent
├── .room-host         "yon's room"  or "(no host)" when metadata.hostName is null
├── .room-code         "K7M3"
├── .room-players      "3 / 10"
└── .room-full-badge   "FULL"        (added only when clients == maxClients)
```

Full rows: `row.SetEnabled(false)` + `row.AddToClassList("room-row-full")`. Click handler early-outs on `state == Connecting`, `r.full`, or empty name.

**USS approach.** Reuse `GameUI.uss` color tokens. Duplicate the `--mp-*` custom properties onto `.lobby-root` (USS has no `@import`; `GameUI.uss` uses the same per-root duplication pattern documented in its header). Token drift risk is low since tokens rarely change.

New classes: `.lobby-root .lobby-title .lobby-card .lobby-banner .primary-btn .secondary-btn .icon-btn .rooms-header .rooms-scroll .rooms-list .rooms-empty .room-row .room-row-full .room-host .room-code .room-players .room-full-badge .field-label .code-input-row`.

Reused: `.hidden` (copy from `GameUI.uss`).

Color palette: `--mp-gold` for the title, `--mp-brown` for borders, `--mp-dark` for card backgrounds, `--mp-hp-red` for the error banner border.

### `NetworkClient.cs` — refactor

`Monkey Punch/Assets/Scripts/Net/NetworkClient.cs`

`Start()` no longer calls `client.JoinOrCreate`. Instead:

```csharp
if (Bootstrap.I == null || Bootstrap.I.Room == null) {
  Debug.LogError("[NetworkClient] Entered Game scene without a connected Room.");
  SceneManager.LoadScene("Lobby");
  return;
}
room = Bootstrap.I.Room;
```

Everything else in `Start()` (callback wiring, `OnMessage` handlers, `PingLoop`/`InputLoop`) is unchanged. The `serverUrl`, `roomName`, and `playerName` SerializeFields are deleted — `Bootstrap` owns the URL, name comes from `Bootstrap.I.DisplayName`, room name is implicit.

`OnDestroy` no longer calls `room.Leave()` — `Room` is shared with `Bootstrap`. All leave-paths go through `Bootstrap.LeaveAndReturnToLobby` to avoid double-leave races.

### `GameUI` — pause menu, leave-confirm, room-code pill

`Monkey Punch/Assets/UI/GameUI.uxml` additions:

- `<Label name="hud-code">` top-right, below `hud-level`. Always visible.
- `<VisualElement name="pausemenu" class="pause-modal hidden">` — Resume + Leave Room buttons. Reuses `.runover-dimmer` and `.runover-panel` styles.
- `<VisualElement name="leave-confirm" class="pause-modal hidden">` — Cancel + Leave buttons, only opened from the pause menu.

`Monkey Punch/Assets/Scripts/UI/GameUI.cs` additions:

- `SetRoomCode(string)` — called from `NetworkClient.PushHudState`. Cheap; updates a single Label.
- Esc keybinding (via existing `InputActionAsset`) toggles `pausemenu`. Closes on second Esc.
- `pause-leave.clicked` → show `leave-confirm`. `leave-confirm-btn.clicked` → `Bootstrap.I.LeaveAndReturnToLobby("Left room")`. `leave-cancel.clicked` → hide `leave-confirm` (pause stays open).
- `AnyModalOpen` getter extends to include `pauseVisible || leaveConfirmVisible`. Used by existing cursor management and the debug-keys gate in `NetworkClient.cs`.

`GameUI.uss` additions:

- `.hud-code` — top-right pill, gold text, dark background, brown border, sits below `.hud-level`.
- `.pause-modal` — full-screen overlay container, reuses `.runover-dimmer` + `.runover-panel`.

No new color tokens; reuses `--mp-gold`, `--mp-dark`, `--mp-brown`.

### `CombatVfx.cs` — run-end goes to lobby

`Monkey Punch/Assets/Scripts/Combat/CombatVfx.cs`:

- `OnRunEnded` and `OnPlayerDowned` swap `ReloadScene` for `() => Bootstrap.I?.LeaveAndReturnToLobby("Run ended")` (or `"You were downed"` for the downed case).
- The private `ReloadScene()` method is deleted.
- Run-over modal button text changes from `"RESTART"` to `"BACK TO LOBBY"` (in `GameUI.uxml`).

## Behavior

### Room list refresh

- First fetch fires immediately on `OnEnable`. No skeleton/loading placeholder — empty list renders briefly while the request is in flight (<200ms typical).
- Subsequent fetches every 5 seconds via `Task.Delay`.
- Pause triggers: `state == Connecting`, `Application.isFocused == false`, lobby scene unloads (CancellationToken).
- On a single failed fetch: keep last-known rooms, dim them, show inline `"couldn't refresh — retrying"` indicator. Next successful fetch clears the dimmer.
- Manual `[↻]` button calls `Refresh()` directly. Disabled while a refresh is already in flight.

### Display name

- `PlayerPrefs` key `mp.displayName`. Load in `OnEnable` and prefill the input.
- Save on successful Create/Join only (not on every keystroke).
- 16-char max (`PLAYER_NAME_MAX_LEN` from `packages/shared/src/constants.ts`).
- Trim whitespace before submit.
- Create/Join/row-click all disabled while trimmed name is empty.

### Row click

- One-click joins. No selection state.
- Hover state and active (press) state via `:hover` and `:active` USS selectors.
- Full rows (`clients == maxClients`) are non-interactive (`SetEnabled(false)`), greyed visuals, `FULL` badge shown.
- Code-join always enabled regardless of list state (a 30s grace reconnector may be admitted even when the listing shows the room as full).

### Empty list

- After a successful fetch returning zero rooms: `#rooms-empty` is shown, `#rooms-list` is hidden.
- Both hidden during initial-load and during failed-fetch retries (showing stale last-known data instead).

### Code input

- Auto-uppercase as the user types (`code-input.RegisterValueChangedCallback` writes `value.ToUpperInvariant()` back).
- 4 characters fixed. Join button disabled until length == 4.
- On bad code, server's `filterBy` returns no match; SDK throws; `FriendlyError` maps to `"Couldn't find a room with that code."`.

### Connecting

- Banner cleared.
- All interactive controls disabled. The clicked button's text changes to `"Connecting…"`.
- No cancel button. Connects are <500ms on a healthy server; SDK throws within ~5s on a dead one.
- On success: store, persist name, `SceneManager.LoadScene("Game")`.
- On failure: `FriendlyError` → banner → `Idle`.

### Banner

- Single banner slot at top of the lobby card.
- Sources:
  - Error after a failed Create/Join (red border, error copy).
  - Return-from-game context (`Bootstrap.PendingBanner`, e.g. `"Run ended"`, `"Left room"` — neutral border).
- Persists until the user takes any action (input change, button click, row click). Cleared by `HideBanner()`.

### In-game escape menu

- Esc shows `pausemenu`. Esc again hides it.
- "Resume" hides `pausemenu`.
- "Leave Room" shows `leave-confirm` (`pausemenu` stays open underneath).
- `leave-confirm` "Cancel" closes itself; pause stays open. "Leave" calls `Bootstrap.LeaveAndReturnToLobby("Left room")`.
- Esc while `leave-confirm` is open is treated as Cancel — confirm closes, pause menu stays open.
- Existing modal stack (level-up bar, run-over) takes precedence — Esc is ignored while those modals are visible.

### Run end / downed

- Run-over modal opens with title `"RUN ENDED"` (run terminated by win/loss condition) or `"DOWNED"` (local player HP hit 0 but the run may still be live for co-op teammates).
- Single button labeled `"BACK TO LOBBY"`.
- Click → `Bootstrap.LeaveAndReturnToLobby` with a banner string matching the title: `"Run ended"` or `"You were downed"`.

### Room code in-game

- Top-right pill, below `hud-level`. Format: just the 4 chars (no `CODE:` label) in gold-on-dark with a brown border. Always visible while connected. Updated each frame from `room.State.code`.

## Testing strategy

### Edit-mode unit tests

`Monkey Punch/Assets/Tests/Editor/MatchmakerClientTest.cs`:
- `ToHttpUrl` ws-to-http, wss-to-https, default-port elision, trailing-slash strip.
- `ParseRooms(string json)` — extract a static `ParseRooms` from `Fetch` so it's testable without `UnityWebRequest`:
  - Valid response → expected list.
  - `metadata.hostName == null` row preserved (host name becomes empty string under `JsonUtility`).
  - Malformed row (missing `metadata.code`) → dropped.
  - Empty array → empty list.

`Monkey Punch/Assets/Tests/Editor/LobbyControllerStateTest.cs`:
- `LobbyControls.Compute(name, code, state)` enables matrix:
  - Empty name → Create disabled, Join disabled, rows disabled.
  - Name set, empty code → Create enabled, Join disabled, rows enabled.
  - Name set, 4-char code → all enabled.
  - Name set, partial code → Create enabled, Join disabled.
  - `state == Connecting` → everything disabled regardless.
- `FriendlyError(ex)` classification for each known exception shape.

### Manual smoke verification

Run before claiming the lobby ships.

1. Boot the editor with no server running → lobby shows `"Couldn't reach the server. Try again in a moment."` banner; Create remains disabled because the failure doesn't change input state; no crashes.
2. Start the server. Boot, type a name, hit Create → lands in Game scene with the 4-char code visible top-right.
3. From a second editor / build instance: lobby shows the first client's room with `1 / 10` and the host's display name.
4. Click the row → second client joins; first client's HUD or debug pane shows `2 / 10`.
5. Fill the room to 10/10 via additional code-joins → row goes grey with `FULL` badge; code-join still works for a reconnector with the same sessionId.
6. Esc in-game → pause menu opens. Esc again → closes. "Leave Room" → confirm modal → "Leave" → back to lobby with banner `"Left room"`. Name still prefilled.
7. Drop HP to 0 with `K` debug → run-over modal → "Back to Lobby" → lobby with banner `"Run ended"`.
8. Open a second tab to the lobby while in a room → first tab's room appears within 5s; create a new room from the second tab → first tab's list updates within 5s.
9. Tab-out for 30s → re-focus → poll resumes; no piled-up requests, no errors.

### Out of scope for tests

- USS visual rendering (eyeball in Game view).
- Colyseus SDK behavior (trusted upstream).
- Server's `/rooms/game` route (already covered in `packages/server/`).
- Scene-transition mock test — mocking `Room<RoomState>` exceeds the value; manual smoke covers it.

## Migration notes

- `SampleScene` is renamed to `Game.unity`. Update Build Settings: `Lobby` at index 0, `Game` at index 1. Any `SceneManager.LoadScene("SampleScene")` callsite that may exist gets updated (current grep shows zero such callsites; `CombatVfx.ReloadScene` uses `GetActiveScene().name`, so it would have followed automatically — but the call is deleted anyway).
- `NetworkClient`'s serialized inspector fields `serverUrl`, `roomName`, `playerName` are removed. Anyone with a local scene that has these set loses those values; that's the intent.
- `RUN ENDED` / `DOWNED` modal button label change is visible to anyone running the game; not a functional regression.

## Risk register

- **Colyseus C# SDK exception shape.** `FriendlyError`'s classification relies on either typed exception codes or substring matching. If the SDK version pinned in `Monkey Punch/Packages/manifest.json` doesn't expose typed codes, the fallback substring matching may misclassify obscure errors as the generic `"Couldn't join: <raw message>"`. Acceptable degradation — the raw SDK message is shown verbatim and the user can retry.
- **`JsonUtility` strict-shape parsing.** `JsonUtility` returns default-initialized objects on mismatch rather than throwing. `ParseRooms` validates `metadata?.code` per row and drops malformed entries. If the server ever changes the response shape, the lobby silently shows an empty list rather than crashing — acceptable.
- **Scene-rename churn.** Renaming `SampleScene` to `Game` is a one-time disruption. Any uncommitted local scene work elsewhere in the project would land on a phantom scene path; no current pending work known.

## Out of scope (future work)

- Click-to-copy on the in-game room-code pill.
- "Recently joined" / favorites for codes.
- Room age / "in progress" indicator (would require a server-side metadata addition).
- Cancel button during Connecting.
- Continuous-run / in-room rematch (would require a server-side soft-reset).
- A skip-lobby debug toggle (explicitly declined).
