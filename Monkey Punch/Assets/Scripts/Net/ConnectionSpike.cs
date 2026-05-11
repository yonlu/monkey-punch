using System.Collections.Generic;
using UnityEngine;
using Colyseus;
using MonkeyPunch.Wire;

namespace MonkeyPunch.Net {
  // Phase 1 connection spike. Joins the running Colyseus server, decodes
  // RoomState, and logs every player/enemy schema callback. Gate: adding
  // a 2nd browser tab should print +player and ~player position updates
  // in Unity's console.
  public class ConnectionSpike : MonoBehaviour {
    [SerializeField] private string serverUrl = "ws://localhost:2567";
    [SerializeField] private string roomName = "game";
    [SerializeField] private string playerName = "UnitySpike";

    private Client client;
    private Room<RoomState> room;

    async void Start() {
      Debug.Log($"[ConnectionSpike] Connecting to {serverUrl} as {playerName}");
      client = new Client(serverUrl);

      var options = new Dictionary<string, object> { { "name", playerName } };
      try {
        room = await client.JoinOrCreate<RoomState>(roomName, options);
      } catch (System.Exception ex) {
        Debug.LogError($"[ConnectionSpike] JoinOrCreate failed: {ex.Message}\n{ex}");
        return;
      }

      Debug.Log($"[ConnectionSpike] Joined room id={room.RoomId} session={room.SessionId} code={room.State?.code}");

      room.OnLeave += (int code) => {
        Debug.Log($"[ConnectionSpike] Left room, close code={code}");
      };

      var callbacks = Colyseus.Schema.Callbacks.Get(room);

      callbacks.OnAdd(state => state.players, (string key, Player player) => {
        Debug.Log($"[ConnectionSpike] +player {key} name={player.name} pos=({player.x:F2},{player.y:F2},{player.z:F2})");
        callbacks.OnChange(player, () => {
          Debug.Log($"[ConnectionSpike] ~player {key} pos=({player.x:F2},{player.y:F2},{player.z:F2}) hp={player.hp}/{player.maxHp} level={player.level}");
        });
      });

      callbacks.OnRemove(state => state.players, (string key, Player player) => {
        Debug.Log($"[ConnectionSpike] -player {key}");
      });

      callbacks.OnAdd(state => state.enemies, (string key, Enemy enemy) => {
        Debug.Log($"[ConnectionSpike] +enemy {key} kind={enemy.kind} pos=({enemy.x:F2},{enemy.y:F2},{enemy.z:F2}) hp={enemy.hp}");
      });

      callbacks.OnRemove(state => state.enemies, (string key, Enemy enemy) => {
        Debug.Log($"[ConnectionSpike] -enemy {key}");
      });
    }

    async void OnDestroy() {
      if (room != null) {
        try { await room.Leave(); } catch { /* ignore on shutdown */ }
      }
    }
  }
}
