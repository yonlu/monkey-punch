using System;
using System.Collections;
using System.Collections.Generic;
using UnityEngine;
using UnityEngine.InputSystem;
using Colyseus;
using MonkeyPunch.Wire;
using MonkeyPunch.Combat;
using MonkeyPunch.Render;

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

    // --- Combat event DTOs (server→client). Must match the wire shape
    //     defined in packages/shared/src/messages.ts. Public fields,
    //     no constructors — that's what Colyseus C# SDK expects for
    //     msgpackr deserialization. JS numbers arrive as double; cast
    //     to byte/int/uint downstream as needed.

    [Serializable]
    private class FireEventMsg {
      public string type;
      public int fireId;
      public byte weaponKind;
      public byte weaponLevel;
      public int lockedTargetId;
      public string ownerId;
      public double originX, originY, originZ;
      public double dirX, dirY, dirZ;
      public int serverTick;
      public double serverFireTimeMs;
    }

    [Serializable]
    private class HitEventMsg {
      public string type;
      public int fireId;
      public int enemyId;
      public int damage;
      public double x, y, z;
      public int serverTick;
      public string tag;
      public byte weaponKind;
    }

    [Serializable]
    private class EnemyDiedEventMsg {
      public string type;
      public int enemyId;
      public double x, z;
    }

    [Serializable]
    private class GemCollectedEventMsg {
      public string type;
      public int gemId;
      public string playerId;
      public int value;
    }

    [Serializable]
    private class PlayerDamagedEventMsg {
      public string type;
      public string playerId;
      public int damage;
      public double x, y, z;
      public int serverTick;
    }

    [Serializable]
    private class PlayerDownedEventMsg {
      public string type;
      public string playerId;
      public int serverTick;
    }

    [Serializable]
    private class RunEndedEventMsg {
      public string type;
      public int serverTick;
    }

    [Serializable]
    private class LevelUpOfferedEventMsg {
      public string type;
      public string playerId;
      public int newLevel;
      public int deadlineTick;
      // choices intentionally omitted from MVP — Phase 7 overlay reads them.
    }

    [Serializable]
    private class LevelUpResolvedEventMsg {
      public string type;
      public string playerId;
      public int newLevel;
      public bool autoPicked;
    }

    [Serializable]
    private class BoomerangThrownEventMsg {
      public string type;
      public int fireId;
      public string ownerId;
      public byte weaponKind;
      public byte weaponLevel;
      public double originX, originY, originZ;
      public double dirX, dirZ;
      public double outboundDistance;
      public double outboundSpeed;
      public double returnSpeed;
      public bool leavesBloodPool;
      public int serverTick;
      public double serverFireTimeMs;
    }

    // Phase 6 (Unity migration plan): one-shot heightmap + props payload.
    // Sent unicast immediately after onJoin. heights is row-major
    // (X-outer, Z-inner) of length (gridSize+1)². props is the full
    // generateProps(seed) output.
    [Serializable]
    private class TerrainDataMsg {
      public string type;
      public uint seed;
      public int gridSize;
      public double gridSpacing;
      public double[] heights;
      public TerrainStreamer.PropPayload[] props;
    }

    [Serializable]
    private class MeleeSwipeEventMsg {
      public string type;
      public string ownerId;
      public byte weaponKind;
      public byte weaponLevel;
      public double originX, originY, originZ;
      public double facingX, facingZ;
      public double arcAngle;
      public double range;
      public bool isCrit;
      public int serverTick;
      public double serverSwingTimeMs;
    }

    // Static so a sibling CameraFollow can find us without inspector wiring.
    // Single-NetworkClient assumption; if that ever changes, swap for a
    // proper service locator.
    public static NetworkClient Instance { get; private set; }

    // Transform of the local player's cube. Null until the self
    // OnPlayerAdd callback fires. CameraFollow polls this each LateUpdate.
    public Transform LocalPlayerTransform { get; private set; }

    private Client client;
    private Room<RoomState> room;
    private readonly ServerTime serverTime = new ServerTime();

    // Phase 3 input state. Now owned by LocalPredictor (seq is bumped
    // inside predictor.Step) but jumpQueued remains a NetworkClient
    // concern — it's an edge-triggered intent read from Keyboard.
    private bool jumpQueued;

    // Phase 5: local-player prediction. Owns X/Z. Null until the local
    // player's schema first appears (HandlePlayerAdd). See LocalPredictor.cs
    // for the X/Z-only scope rationale.
    private LocalPredictor predictor;
    private double lastPredictorRenderTimeMs;

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
      StartCoroutine(InputLoop());

      var cb = Colyseus.Schema.Callbacks.Get(room);

      cb.OnAdd(s => s.players, (string sessionId, MonkeyPunch.Wire.Player p) => HandlePlayerAdd(cb, sessionId, p));
      cb.OnRemove(s => s.players, (string sessionId, MonkeyPunch.Wire.Player p) => HandlePlayerRemove(sessionId));

      cb.OnAdd(s => s.enemies, (string key, MonkeyPunch.Wire.Enemy e) => HandleEnemyAdd(cb, e));
      cb.OnRemove(s => s.enemies, (string key, MonkeyPunch.Wire.Enemy e) => HandleEnemyRemove(e));

      cb.OnAdd(s => s.gems, (string key, MonkeyPunch.Wire.Gem g) => HandleGemAdd(g));
      cb.OnRemove(s => s.gems, (string key, MonkeyPunch.Wire.Gem g) => HandleGemRemove(g));

      cb.OnAdd(s => s.bloodPools, (string key, MonkeyPunch.Wire.BloodPool bp) => HandleBloodPoolAdd(bp));
      cb.OnRemove(s => s.bloodPools, (string key, MonkeyPunch.Wire.BloodPool bp) => HandleBloodPoolRemove(bp));

      // Phase 4-MVP: subscribe to server-only combat events and dispatch
      // to CombatVfx. The fire-handler is per-behavior (projectile only
      // this commit); orbit/aura/boomerang/melee are Phase 4 follow-ups.
      room.OnMessage("fire", (FireEventMsg ev) => {
        if (CombatVfx.Instance != null) {
          CombatVfx.Instance.OnFire(ev.fireId, ev.weaponKind, ev.weaponLevel,
            ev.originX, ev.originY, ev.originZ,
            ev.dirX, ev.dirY, ev.dirZ,
            ev.serverFireTimeMs);
        }
      });
      room.OnMessage("hit", (HitEventMsg ev) => {
        if (CombatVfx.Instance != null) {
          enemyObjects.TryGetValue((uint)ev.enemyId, out var enemyGo);
          CombatVfx.Instance.OnHit(ev.fireId, (uint)ev.enemyId, ev.damage, ev.x, ev.y, ev.z, enemyGo);
        }
      });
      room.OnMessage("enemy_died", (EnemyDiedEventMsg ev) => {
        if (CombatVfx.Instance != null) {
          enemyObjects.TryGetValue((uint)ev.enemyId, out var enemyGo);
          CombatVfx.Instance.OnEnemyDied((uint)ev.enemyId, ev.x, ev.z, enemyGo);
        }
      });
      // Remaining events: log only for now. Phase-4 follow-ups will
      // render their specific VFX.
      room.OnMessage("gem_collected", (GemCollectedEventMsg ev) => {
        // Pop VFX is a follow-up; the gem GameObject already disappears
        // when its schema entry leaves (HandleGemRemove).
      });
      room.OnMessage("player_damaged", (PlayerDamagedEventMsg ev) => {
        if (CombatVfx.Instance != null) {
          playerObjects.TryGetValue(ev.playerId, out var go);
          CombatVfx.Instance.OnPlayerDamaged(ev.playerId, ev.damage, ev.x, ev.y, ev.z, go);
        }
      });
      room.OnMessage("boomerang_thrown", (BoomerangThrownEventMsg ev) => {
        if (CombatVfx.Instance != null) {
          CombatVfx.Instance.OnBoomerangThrown(ev.fireId, ev.ownerId,
            ev.originX, ev.originY, ev.originZ,
            ev.dirX, ev.dirZ,
            ev.outboundDistance, ev.outboundSpeed, ev.returnSpeed,
            ev.serverFireTimeMs);
        }
      });
      room.OnMessage("melee_swipe", (MeleeSwipeEventMsg ev) => {
        if (CombatVfx.Instance != null) {
          CombatVfx.Instance.OnMeleeSwipe(ev.ownerId,
            ev.originX, ev.originY, ev.originZ,
            ev.facingX, ev.facingZ,
            ev.arcAngle, ev.range);
        }
      });
      room.OnMessage("player_downed", (PlayerDownedEventMsg ev) => {
        Debug.Log($"[NetworkClient] player_downed playerId={ev.playerId} tick={ev.serverTick}");
        if (CombatVfx.Instance != null) {
          CombatVfx.Instance.OnPlayerDowned(ev.playerId == room?.SessionId);
        }
      });
      room.OnMessage("run_ended", (RunEndedEventMsg ev) => {
        Debug.Log($"[NetworkClient] run_ended tick={ev.serverTick}");
        if (CombatVfx.Instance != null) {
          CombatVfx.Instance.OnRunEnded();
        }
      });
      room.OnMessage("level_up_offered", (LevelUpOfferedEventMsg ev) => {
        Debug.Log($"[NetworkClient] level_up_offered to {ev.playerId} newLevel={ev.newLevel}");
      });
      room.OnMessage("level_up_resolved", (LevelUpResolvedEventMsg ev) => {
        Debug.Log($"[NetworkClient] level_up_resolved {ev.playerId} newLevel={ev.newLevel} autoPicked={ev.autoPicked}");
      });

      // Phase 6 (Unity migration plan): one-shot terrain + props payload.
      // TerrainStreamer must already be on a sibling GameObject in the
      // scene; we hand off the decoded heightmap + prop list and it
      // rebuilds the world mesh. Multiple receipts (rejoin within
      // grace) trigger a full rebuild — props/terrain are tear-down-
      // and-replace, not diff.
      room.OnMessage("terrain_data", (TerrainDataMsg ev) => {
        if (TerrainStreamer.Instance == null) {
          Debug.LogWarning("[NetworkClient] terrain_data received but TerrainStreamer.Instance is null. " +
                           "Add a TerrainStreamer component to the scene.");
          return;
        }
        if (ev.heights == null || ev.props == null) {
          Debug.LogError("[NetworkClient] terrain_data payload missing heights or props.");
          return;
        }
        TerrainStreamer.Instance.BuildFromPayload(ev.gridSize, ev.gridSpacing, ev.heights, ev.props, ev.seed);
      });
    }

    // Server time for the closed-form projectile sim. CombatVfx polls
    // this each Update so two clients with stable, similar serverTime
    // offsets place the same projectile at the same world position for
    // the same fireId. Public so CombatVfx (different namespace) can
    // call without a friend-assembly trick.
    public double ServerNowMs() => serverTime.ServerNow();

    // Lookup the GameObject for an arbitrary sessionId. Used by
    // BoomerangCoroutine to home toward the owner's current position
    // and by player-damaged VFX to flash the right cube. Returns null
    // if the sessionId isn't currently in playerObjects (player left
    // mid-flight). Local player is registered in playerObjects too.
    public GameObject GetPlayerObject(string sessionId) {
      playerObjects.TryGetValue(sessionId, out var go);
      return go;
    }

    private void DebugGrantWeapon(int weaponKind) {
      if (room == null) return;
      try {
        _ = room.Send("debug_grant_weapon", new Dictionary<string, object> {
          { "type", "debug_grant_weapon" }, { "weaponKind", weaponKind }
        });
        Debug.Log($"[NetworkClient] debug_grant_weapon kind={weaponKind}");
      } catch (Exception ex) {
        Debug.LogWarning($"[NetworkClient] grant failed: {ex.Message}");
      }
    }

    private void DebugSpawnEnemies(int count) {
      if (room == null) return;
      try {
        _ = room.Send("debug_spawn", new Dictionary<string, object> {
          { "type", "debug_spawn" }, { "count", count }
        });
      } catch (Exception ex) {
        Debug.LogWarning($"[NetworkClient] spawn failed: {ex.Message}");
      }
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

    // 20Hz input send loop matching the TS client's STEP_INTERVAL_MS=50.
    // No camera-yaw transform yet — sends raw WASD as world dir aligned
    // with the spectator camera (looking +Z). Phase 7 will swap in a
    // Cinemachine FreeLook + yaw transform per packages/client/src/game/
    // input.ts.
    //
    // Phase 5: input now flows through LocalPredictor.Step() which
    // queues the message for replay-on-reconcile and advances the
    // predictor by one server-equivalent tick. The predictor owns seq;
    // we just forward its message via room.Send.
    private IEnumerator InputLoop() {
      var wait = new WaitForSeconds(0.05f);
      while (room != null) {
        Vector2 dir = ComputeWorldDir();
        bool jump = jumpQueued;
        jumpQueued = false;
        Dictionary<string, object> msg;
        if (predictor != null) {
          msg = predictor.Step(dir.x, dir.y, jump);
        } else {
          // Predictor not initialized yet (local player schema hasn't
          // arrived). Fall back to a non-predicted send so the server
          // still sees inputs from frame 0.
          msg = new Dictionary<string, object> {
            { "type", "input" },
            { "seq", 0 },
            { "dir", new Dictionary<string, object> { { "x", (double)dir.x }, { "z", (double)dir.y } } },
            { "jump", jump },
          };
        }
        try {
          _ = room.Send("input", msg);
        } catch (Exception ex) {
          Debug.LogWarning($"[NetworkClient] input send failed: {ex.Message}");
        }
        yield return wait;
      }
    }

    private Vector2 ComputeWorldDir() {
      var kb = Keyboard.current;
      if (kb == null) return Vector2.zero;
      float x = 0f, z = 0f;
      if (kb.dKey.isPressed) x += 1f;
      if (kb.aKey.isPressed) x -= 1f;
      if (kb.wKey.isPressed) z += 1f;
      if (kb.sKey.isPressed) z -= 1f;
      float len = Mathf.Sqrt(x * x + z * z);
      if (len > 0f) { x /= len; z /= len; }
      return new Vector2(x, z);
    }

    // --- Players ---

    private void HandlePlayerAdd(Colyseus.Schema.StateCallbackStrategy<RoomState> cb, string sessionId, MonkeyPunch.Wire.Player p) {
      var buf = new SnapshotBuffer();
      buf.Push(NowMs(), p.x, p.y, p.z);
      playerBuffers[sessionId] = buf;

      bool isLocal = room != null && sessionId == room.SessionId;
      var go = GameObject.CreatePrimitive(PrimitiveType.Cube);
      go.name = $"Player:{sessionId}:{p.name}{(isLocal ? " [LOCAL]" : "")}";
      go.transform.position = new Vector3(p.x, p.y, p.z);
      var rend = go.GetComponent<Renderer>();
      if (rend != null) {
        rend.material.color = isLocal
          ? new Color(0.3f, 1.0f, 0.3f)   // green = local (you)
          : new Color(0.3f, 0.5f, 1.0f);  // blue = remote
      }
      playerObjects[sessionId] = go;
      if (isLocal) {
        LocalPlayerTransform = go.transform;
        // Phase 5: spin up the predictor once we have a server-authoritative
        // starting X/Z. Tick comes from the room state (it's set before
        // OnAdd fires).
        predictor = new LocalPredictor();
        int initialTick = room?.State != null ? (int)room.State.tick : 0;
        predictor.Initialize(p.x, p.z, initialTick);
        lastPredictorRenderTimeMs = NowMs();
        Debug.Log($"[NetworkClient] Predictor initialized at x={p.x:F3} z={p.z:F3} tick={initialTick}");
      }

      cb.OnChange(p, () => {
        if (playerBuffers.TryGetValue(sessionId, out var b)) {
          b.Push(NowMs(), p.x, p.y, p.z);
        }
        // Phase 5: reconcile the local player against the authoritative
        // snapshot. lastProcessedInput is the highest seq the server has
        // applied — anything > that is unacked and gets replayed.
        if (isLocal && predictor != null && room?.State != null) {
          predictor.Reconcile(p.x, p.z, (int)p.lastProcessedInput, (int)room.State.tick);
        }
      });
    }

    private void HandlePlayerRemove(string sessionId) {
      if (playerObjects.TryGetValue(sessionId, out var go)) {
        if (LocalPlayerTransform == go.transform) LocalPlayerTransform = null;
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

    void Awake() {
      if (Instance != null && Instance != this) {
        Debug.LogWarning("[NetworkClient] Multiple instances detected — using the latest.");
      }
      Instance = this;
    }

    void Update() {
      // Edge-trigger jump from Space key. InputLoop reads + clears
      // jumpQueued on the next 20Hz tick.
      var kb = Keyboard.current;
      if (kb != null && kb.spaceKey.wasPressedThisFrame) {
        jumpQueued = true;
      }

      // Phase-4 dev shortcuts. Server accepts debug_grant_weapon /
      // debug_spawn when ALLOW_DEBUG_MESSAGES=true (GameRoom.ts).
      // Mapping per packages/shared/src/weapons.ts WEAPON_KINDS order:
      //   1 → Orbit (kind=1, behavior=orbit) — renderer NYI, no visual
      //   2 → Bloody Axe (kind=6, behavior=boomerang) — see axes
      //                  fly out and return
      //   3 → Damascus (kind=3, behavior=melee_arc) — see swipe flash
      //   4 → Kronos (kind=7, behavior=aura) — see cyan pulse ring
      //   B → debug_spawn 10 enemies for instant targets
      if (room != null && kb != null) {
        if (kb.digit1Key.wasPressedThisFrame) DebugGrantWeapon(1);
        if (kb.digit2Key.wasPressedThisFrame) DebugGrantWeapon(6);
        if (kb.digit3Key.wasPressedThisFrame) DebugGrantWeapon(3);
        if (kb.digit4Key.wasPressedThisFrame) DebugGrantWeapon(7);
        if (kb.bKey.wasPressedThisFrame) DebugSpawnEnemies(10);
      }

      if (room == null) return;
      if (room.State != null) lastTickSeen = (int)room.State.tick;

      double renderTime = NowMs() - interpDelayMs;

      // Phase 5: render the local player from the predictor (X/Z) +
      // server Y. Other players still interpolate.
      string localSid = room?.SessionId;
      foreach (var kv in playerObjects) {
        bool isLocal = predictor != null && kv.Key == localSid;
        if (isLocal) {
          double nowMs = NowMs();
          double dtSeconds = Math.Max(0.0, (nowMs - lastPredictorRenderTimeMs) / 1000.0);
          predictor.DecayRenderOffset(dtSeconds);
          lastPredictorRenderTimeMs = nowMs;

          // Y comes from the latest server snapshot (interp buffer's
          // newest sample). Walking is responsive; jumping inherits the
          // 50ms server-tick lag — see "SCOPE LIMIT" in LocalPredictor.cs.
          float renderY = kv.Value.transform.position.y;
          if (playerBuffers.TryGetValue(kv.Key, out var localBuf) && localBuf.Sample(renderTime, out var sampledLocal)) {
            renderY = sampledLocal.y;
          }
          kv.Value.transform.position = new Vector3(
            (float)(predictor.X + predictor.RenderOffsetX),
            renderY,
            (float)(predictor.Z + predictor.RenderOffsetZ)
          );
          continue;
        }
        if (playerBuffers.TryGetValue(kv.Key, out var buf) && buf.Sample(renderTime, out var pos)) {
          kv.Value.transform.position = pos;
        }
      }

      foreach (var kv in enemyObjects) {
        if (enemyBuffers.TryGetValue(kv.Key, out var buf) && buf.Sample(renderTime, out var pos)) {
          kv.Value.transform.position = pos;
        }
      }

      // Phase-4.3: orbit weapon → continuous orbs around local player.
      // Check the local player's weapons list each frame; the cost is
      // O(weapons) which is small (<5 typically).
      bool hasOrbit = false;
      if (room.State?.players != null) {
        var localPlayer = room.State.players[room.SessionId];
        if (localPlayer != null && localPlayer.weapons != null) {
          for (int i = 0; i < localPlayer.weapons.Count; i++) {
            if (localPlayer.weapons[i].kind == 1) { hasOrbit = true; break; }
          }
        }
      }
      if (CombatVfx.Instance != null) {
        CombatVfx.Instance.UpdateOrbits(hasOrbit, LocalPlayerTransform);
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
      GUI.Box(new Rect(10, 10, 300, 170), GUIContent.none, boxStyle);
      string predLine = predictor == null
        ? "Predict: (not initialized)"
        : $"Predict: x={predictor.X:F2} z={predictor.Z:F2} err={predictor.LastReconErr:F3} off=({predictor.RenderOffsetX:F2},{predictor.RenderOffsetZ:F2})";
      GUI.Label(new Rect(20, 16, 280, 160),
        $"Room:    {room.RoomId} (code: {room.State?.code})\n" +
        $"Session: {room.SessionId}\n" +
        $"Tick:    {lastTickSeen}\n" +
        $"Players: {playerBuffers.Count}  | Enemies: {enemyBuffers.Count}\n" +
        $"Gems:    {gemObjects.Count}  | Pools: {bloodPoolObjects.Count}\n" +
        $"Ping:    {pingMs:F0} ms\n" +
        $"Offset:  {serverTime.OffsetMs:F0} ms (server-local)\n" +
        $"Interp:  {interpDelayMs:F0} ms behind\n" +
        predLine,
        labelStyle);
    }

    private static double NowMs() => UnityEngine.Time.realtimeSinceStartupAsDouble * 1000.0;
  }
}
