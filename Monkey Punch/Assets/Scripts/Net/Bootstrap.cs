using System;
using System.Threading.Tasks;
using Colyseus;
using MonkeyPunch.Render;
using MonkeyPunch.Wire;
using UnityEngine;
using UnityEngine.SceneManagement;

namespace MonkeyPunch.Net {
  // Wire shape for the server's unicast terrain_data message
  // (packages/shared/src/messages.ts TerrainDataMessage). Public so
  // Bootstrap can capture it before Game-scene scripts are alive — see
  // RegisterTerrainCapture below.
  [Serializable]
  public class TerrainDataMsg {
    public string type;
    public uint seed;
    public int gridSize;
    public double gridSpacing;
    public double[] heights;
    public TerrainStreamer.PropPayload[] props;
  }

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

    // Latest captured terrain_data payload, awaiting consumption by
    // NetworkClient/TerrainStreamer in the Game scene. The server sends
    // terrain_data unicast inside onJoin, which arrives while we're still
    // in the Lobby scene — too early for NetworkClient.Start to have
    // registered its own handler. RegisterTerrainCapture installs an
    // OnMessage handler on the Room the moment we have it, stashes the
    // payload here, and applies it directly if TerrainStreamer is already
    // alive (the rejoin case).
    public TerrainDataMsg PendingTerrainPayload { get; set; }

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

    // Install the terrain_data handler before the message arrives. Must
    // be called by LobbyController immediately after the connect promise
    // resolves, before SceneManager.LoadScene("Game") — the server's
    // unicast `client.send("terrain_data", ...)` in onJoin lands during
    // the WebSocket sync-context pump between Lobby and Game frames, so
    // late registration in NetworkClient.Start misses it.
    public void RegisterTerrainCapture(Room<RoomState> room) {
      if (room == null) return;
      room.OnMessage("terrain_data", (TerrainDataMsg ev) => {
        if (ev == null) return;
        PendingTerrainPayload = ev;
        // Rejoin within the grace window: TerrainStreamer is already up,
        // so apply directly and clear. On the initial join TerrainStreamer
        // isn't alive yet — NetworkClient.Start will consume the cached
        // payload once both sides exist.
        if (TerrainStreamer.Instance != null
            && ev.heights != null && ev.props != null) {
          TerrainStreamer.Instance.BuildFromPayload(
            ev.gridSize, ev.gridSpacing, ev.heights, ev.props, ev.seed);
          PendingTerrainPayload = null;
        }
      });
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
