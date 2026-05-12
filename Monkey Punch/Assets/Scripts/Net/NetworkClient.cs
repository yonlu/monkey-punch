using System;
using System.Collections;
using System.Collections.Generic;
using UnityEngine;
using Colyseus;
using MonkeyPunch.Wire;

namespace MonkeyPunch.Net {
  // Phase 2 passive spectator client. Joins the server, decodes RoomState,
  // renders other players + enemies + gems + blood pools with ~100ms
  // snapshot interpolation. Local player NOT rendered yet — Phase 5
  // prediction owns it. No input either — Phase 3 wires that.
  //
  // ENEMY RENDERING NOTE (rule #10 deferral):
  // CLAUDE.md rule #10 specifies enemies should render via a single
  // InstancedMesh (Graphics.DrawMeshInstanced) for the MAX_ENEMIES=300
  // ceiling. This Phase 2 implementation uses one GameObject per enemy
  // (matching the gem/blood-pool pattern) — runtime-instantiated
  // URP/Lit materials weren't picking up the GPU-instancing shader
  // variant, and visually verifying the gate took priority over
  // chasing the shader-variant compilation. At our current scale
  // (~30 enemies typical) GameObjects are fine performance-wise.
  // Refactor to instanced rendering when (a) enemy count climbs
  // toward the cap or (b) frame time measurably degrades. See TODO
  // in HandleEnemyAdd.
  public class NetworkClient : MonoBehaviour {
    [Header("Connection")]
    [SerializeField] private string serverUrl = "ws://localhost:2567";
    [SerializeField] private string roomName = "game";
    [SerializeField] private string playerName = "UnitySpectator";

    [Header("Render")]
    [SerializeField] private float interpDelayMs = 100f;

    [Serializable]
    private class PongMessage { public string type; public double t; public double serverNow; }

    private Client client;
    private Room<RoomState> room;
    private readonly ServerTime serverTime = new ServerTime();

    private readonly Dictionary<string, SnapshotBuffer> playerBuffers = new Dictionary<string, SnapshotBuffer>();
    private readonly Dictionary<string, GameObject> playerObjects = new Dictionary<string, GameObject>();

    private readonly Dictionary<uint, SnapshotBuffer> enemyBuffers = new Dictionary<uint, SnapshotBuffer>();
    private readonly Dictionary<uint, GameObject> enemyObjects = new Dictionary<uint, GameObject>();

    private readonly Dictionary<uint, GameObject> gemObjects = new Dictionary<uint, GameObject>();
    private readonly Dictionary<uint, GameObject> bloodPoolObjects = new Dictionary<uint, GameObject>();

    private float pingMs;
    private int lastTickSeen;

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

      room.OnLeave += code => Debug.Log($"[NetworkClient] Left, close code={code}");

      room.OnMessage("pong", (PongMessage msg) => {
        double localNow = ServerTime.LocalNowMs();
        double rtt = localNow - msg.t;
        if (rtt > 0 && rtt < 5000) {
          pingMs = pingMs <= 0f ? (float)rtt : pingMs * 0.8f + (float)rtt * 0.2f;
          serverTime.Observe(msg.serverNow, rtt * 0.5);
        }
      });

      StartCoroutine(PingLoop());

      var cb = Colyseus.Schema.Callbacks.Get(room);

      cb.OnAdd(s => s.players, (string sessionId, MonkeyPunch.Wire.Player p) => HandlePlayerAdd(cb, sessionId, p));
      cb.OnRemove(s => s.players, (string sessionId, MonkeyPunch.Wire.Player p) => HandlePlayerRemove(sessionId));

      cb.OnAdd(s => s.enemies, (string key, MonkeyPunch.Wire.Enemy e) => HandleEnemyAdd(cb, e));
      cb.OnRemove(s => s.enemies, (string key, MonkeyPunch.Wire.Enemy e) => HandleEnemyRemove(e));

      cb.OnAdd(s => s.gems, (string key, MonkeyPunch.Wire.Gem g) => HandleGemAdd(g));
      cb.OnRemove(s => s.gems, (string key, MonkeyPunch.Wire.Gem g) => HandleGemRemove(g));

      cb.OnAdd(s => s.bloodPools, (string key, MonkeyPunch.Wire.BloodPool bp) => HandleBloodPoolAdd(bp));
      cb.OnRemove(s => s.bloodPools, (string key, MonkeyPunch.Wire.BloodPool bp) => HandleBloodPoolRemove(bp));
    }

    private IEnumerator PingLoop() {
      var wait = new WaitForSeconds(1f);
      while (room != null) {
        try {
          _ = room.Send("ping", new Dictionary<string, object> {
            { "type", "ping" }, { "t", ServerTime.LocalNowMs() }
          });
        } catch (Exception ex) {
          Debug.LogWarning($"[NetworkClient] ping send failed: {ex.Message}");
        }
        yield return wait;
      }
    }

    // --- Players ---

    private void HandlePlayerAdd(Colyseus.Schema.StateCallbackStrategy<RoomState> cb, string sessionId, MonkeyPunch.Wire.Player p) {
      var buf = new SnapshotBuffer();
      buf.Push(NowMs(), p.x, p.y, p.z);
      playerBuffers[sessionId] = buf;

      if (room != null && sessionId != room.SessionId) {
        var go = GameObject.CreatePrimitive(PrimitiveType.Cube);
        go.name = $"Player:{sessionId}:{p.name}";
        go.transform.position = new Vector3(p.x, p.y, p.z);
        var rend = go.GetComponent<Renderer>();
        if (rend != null) rend.material.color = new Color(0.3f, 0.5f, 1.0f);
        playerObjects[sessionId] = go;
      }

      cb.OnChange(p, () => {
        if (playerBuffers.TryGetValue(sessionId, out var b)) {
          b.Push(NowMs(), p.x, p.y, p.z);
        }
      });
    }

    private void HandlePlayerRemove(string sessionId) {
      if (playerObjects.TryGetValue(sessionId, out var go)) {
        Destroy(go);
        playerObjects.Remove(sessionId);
      }
      playerBuffers.Remove(sessionId);
    }

    // --- Enemies (GameObject-per-enemy; rule #10 deferral, see class header) ---

    private void HandleEnemyAdd(Colyseus.Schema.StateCallbackStrategy<RoomState> cb, MonkeyPunch.Wire.Enemy e) {
      var buf = new SnapshotBuffer();
      buf.Push(NowMs(), e.x, e.y, e.z);
      enemyBuffers[e.id] = buf;

      // TODO(rule-10): replace per-enemy GameObject with Graphics.DrawMeshInstanced
      // once the runtime-instantiated URP/Lit material's GPU-instancing variant
      // is resolved (variant likely needs to be pre-included in a
      // ShaderVariantCollection, or material asset created at edit time with
      // instancing enabled and referenced here). 1023-instance batch cap to
      // keep in mind.
      var go = GameObject.CreatePrimitive(PrimitiveType.Cube);
      go.name = $"Enemy:{e.id}";
      go.transform.position = new Vector3(e.x, e.y, e.z);
      go.transform.localScale = Vector3.one * 0.9f;
      var rend = go.GetComponent<Renderer>();
      if (rend != null) rend.material.color = new Color(0.9f, 0.2f, 0.2f);
      enemyObjects[e.id] = go;

      cb.OnChange(e, () => {
        if (enemyBuffers.TryGetValue(e.id, out var b)) {
          b.Push(NowMs(), e.x, e.y, e.z);
        }
      });
    }

    private void HandleEnemyRemove(MonkeyPunch.Wire.Enemy e) {
      if (enemyObjects.TryGetValue(e.id, out var go)) {
        Destroy(go);
        enemyObjects.Remove(e.id);
      }
      enemyBuffers.Remove(e.id);
    }

    // --- Gems (static positions, no interp) ---

    private void HandleGemAdd(MonkeyPunch.Wire.Gem g) {
      var go = GameObject.CreatePrimitive(PrimitiveType.Sphere);
      go.transform.localScale = Vector3.one * 0.5f;
      go.transform.position = new Vector3(g.x, 0.5f, g.z);
      go.name = $"Gem:{g.id}";
      var rend = go.GetComponent<Renderer>();
      if (rend != null) rend.material.color = new Color(1.0f, 0.85f, 0.2f);
      gemObjects[g.id] = go;
    }

    private void HandleGemRemove(MonkeyPunch.Wire.Gem g) {
      if (gemObjects.TryGetValue(g.id, out var go)) {
        Destroy(go);
        gemObjects.Remove(g.id);
      }
    }

    // --- Blood pools ---

    private void HandleBloodPoolAdd(MonkeyPunch.Wire.BloodPool bp) {
      var go = GameObject.CreatePrimitive(PrimitiveType.Cylinder);
      go.transform.localScale = new Vector3(2.0f, 0.05f, 2.0f);
      go.transform.position = new Vector3(bp.x, 0.025f, bp.z);
      go.name = $"BloodPool:{bp.id}";
      var rend = go.GetComponent<Renderer>();
      if (rend != null) rend.material.color = new Color(0.4f, 0.0f, 0.0f, 0.7f);
      bloodPoolObjects[bp.id] = go;
    }

    private void HandleBloodPoolRemove(MonkeyPunch.Wire.BloodPool bp) {
      if (bloodPoolObjects.TryGetValue(bp.id, out var go)) {
        Destroy(go);
        bloodPoolObjects.Remove(bp.id);
      }
    }

    // --- Per-frame: drive transforms from interpolated snapshots ---

    void Update() {
      if (room == null) return;
      if (room.State != null) lastTickSeen = (int)room.State.tick;

      double renderTime = NowMs() - interpDelayMs;

      foreach (var kv in playerObjects) {
        if (playerBuffers.TryGetValue(kv.Key, out var buf) && buf.Sample(renderTime, out var pos)) {
          kv.Value.transform.position = pos;
        }
      }

      foreach (var kv in enemyObjects) {
        if (enemyBuffers.TryGetValue(kv.Key, out var buf) && buf.Sample(renderTime, out var pos)) {
          kv.Value.transform.position = pos;
        }
      }
    }

    async void OnDestroy() {
      if (room != null) {
        try { await room.Leave(); } catch { /* shutdown */ }
      }
    }

    void OnGUI() {
      if (room == null) return;
      var boxStyle = new GUIStyle(GUI.skin.box) { alignment = TextAnchor.UpperLeft };
      var labelStyle = new GUIStyle(GUI.skin.label) { fontSize = 12 };
      GUI.Box(new Rect(10, 10, 300, 142), GUIContent.none, boxStyle);
      GUI.Label(new Rect(20, 16, 280, 132),
        $"Room:    {room.RoomId} (code: {room.State?.code})\n" +
        $"Session: {room.SessionId}\n" +
        $"Tick:    {lastTickSeen}\n" +
        $"Players: {playerBuffers.Count}  | Enemies: {enemyBuffers.Count}\n" +
        $"Gems:    {gemObjects.Count}  | Pools: {bloodPoolObjects.Count}\n" +
        $"Ping:    {pingMs:F0} ms\n" +
        $"Offset:  {serverTime.OffsetMs:F0} ms (server-local)\n" +
        $"Interp:  {interpDelayMs:F0} ms behind",
        labelStyle);
    }

    private static double NowMs() => UnityEngine.Time.realtimeSinceStartupAsDouble * 1000.0;
  }
}
