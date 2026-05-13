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
