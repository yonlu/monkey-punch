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
      // CameraFollow.Awake (Game scene) locks the cursor for mouselook.
      // When we land here from a Game→Lobby bounce (NetworkClient's guard
      // or LeaveAndReturnToLobby) the lock survives the scene swap, so
      // UI Toolkit pointer clicks never reach the lobby buttons even
      // though keyboard nav still works. Unlock unconditionally on entry.
      UnityEngine.Cursor.lockState = CursorLockMode.None;
      UnityEngine.Cursor.visible = true;

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
        // Register the terrain_data capture handler BEFORE LoadScene.
        // The server unicast-sends terrain_data inside onJoin; the
        // message lands during the WS sync-context pump before Game
        // scene's NetworkClient.Start can register its own handler.
        // See Bootstrap.RegisterTerrainCapture.
        Bootstrap.I.RegisterTerrainCapture(room);
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
