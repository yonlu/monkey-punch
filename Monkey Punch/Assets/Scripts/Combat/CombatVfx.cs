using System;
using System.Collections;
using System.Collections.Generic;
using UnityEngine;
using MonkeyPunch.Net;
using MonkeyPunch.UI;
using UnityEngine.SceneManagement;

namespace MonkeyPunch.Combat {
  // Phase 4-MVP visual response to server combat events. NetworkClient
  // calls into this class when a fire/hit/enemy_died/etc. message
  // arrives. We OWN the visual lifecycle (closed-form projectile sim,
  // hit flash, damage-number TextMesh) but never decide outcomes —
  // server is authoritative per CLAUDE.md rule 12.
  //
  // Currently MVP-scoped:
  //   - Projectile-behavior fire (Magic Missile/Bolt) — closed-form
  //     position = origin + dir * speed * elapsed, despawn on hit or
  //     after lifetime+grace
  //   - Hit flash — material color briefly modulated white on target
  //     enemy GameObject (looked up via NetworkClient)
  //   - Damage number — TextMesh quad that rises and fades over ~1s
  //   - Enemy death — simple destroy + brief burst
  //
  // Deferred to Phase-4 follow-ups:
  //   - Orbit-behavior renderer (Mjolnir)
  //   - Aura-behavior renderer
  //   - Boomerang renderer (Bloody Axe)
  //   - Melee swipe renderer
  //   - Player damaged/downed VFX
  //   - Level-up overlay (rolls into Phase 7 UI Toolkit)
  public class CombatVfx : MonoBehaviour {
    public static CombatVfx Instance { get; private set; }

    [Header("Projectile defaults — MVP")]
    [Tooltip("Fallback projectile speed (units/sec) when weapon table lookup is absent.")]
    [SerializeField] private float defaultProjectileSpeed = 22f;
    [Tooltip("Fallback projectile lifetime (seconds) — small grace added before despawn.")]
    [SerializeField] private float defaultProjectileLifetime = 1.2f;
    [Tooltip("Render-time offset behind server time, matching snapshot interp.")]
    [SerializeField] private float interpDelayMs = 100f;

    private class ProjectileInstance {
      public GameObject Go;
      public double OriginX, OriginY, OriginZ;
      public double DirX, DirY, DirZ;
      public double ServerFireTimeMs;
      public float Speed;
      public float Lifetime;
    }

    private readonly Dictionary<int, ProjectileInstance> projectiles = new Dictionary<int, ProjectileInstance>();
    private readonly List<GameObject> orbitOrbs = new List<GameObject>();
    private bool runEnded;
    private bool localPlayerDowned;

    // weaponKind → behavior table mirroring WEAPON_KINDS order in
    // packages/shared/src/weapons.ts. Used to dispatch OnFire to the
    // right per-behavior renderer. NOT a full WeaponDef table —
    // per-weapon stats (speed/lifetime/damage) still use the defaults
    // above. Adding a new weapon means appending a row here AND in
    // weapons.ts on the server. Indices:
    //   0 Bolt        projectile
    //   1 Orbit       orbit
    //   2 Gakkung Bow projectile
    //   3 Damascus    melee_arc (own event path: OnMeleeSwipe)
    //   4 Claymore    melee_arc
    //   5 Ahlspiess   projectile
    //   6 Bloody Axe  boomerang (own event path: OnBoomerangThrown)
    //   7 Kronos      aura
    private static readonly Dictionary<byte, string> WeaponBehavior = new Dictionary<byte, string> {
      { 0, "projectile" }, { 1, "orbit" }, { 2, "projectile" },
      { 3, "melee_arc" }, { 4, "melee_arc" }, { 5, "projectile" },
      { 6, "boomerang" }, { 7, "aura" },
    };

    void Awake() { Instance = this; }

    // Called from NetworkClient.OnMessage("fire", ...).
    public void OnFire(int fireId, byte weaponKind, byte weaponLevel,
                       double originX, double originY, double originZ,
                       double dirX, double dirY, double dirZ,
                       double serverFireTimeMs) {
      // Dispatch on weapon behavior. Aura → expanding pulse at origin.
      // Orbit → no per-fire VFX (orbit is continuous, NOT YET RENDERED —
      // Phase 4.3 follow-up). Default → projectile (handles Bolt /
      // Gakkung / Ahlspiess and any unrecognized weaponKind).
      if (WeaponBehavior.TryGetValue(weaponKind, out var behavior)) {
        if (behavior == "aura") {
          OnAuraPulse(originX, originY, originZ);
          return;
        }
        if (behavior == "orbit") {
          // No-op — orbit rendering belongs to a continuous Update loop
          // walking state.players[local].weapons (deferred to Phase 4.3).
          return;
        }
      }

      // Projectile fallthrough.
      // Defensive: replace if a fireId collides (shouldn't on a well-
      // behaved server, but cheap to handle).
      if (projectiles.TryGetValue(fireId, out var existing) && existing.Go != null) {
        Destroy(existing.Go);
      }

      var go = GameObject.CreatePrimitive(PrimitiveType.Sphere);
      go.transform.localScale = Vector3.one * 0.3f;
      go.transform.position = new Vector3((float)originX, (float)originY, (float)originZ);
      // Strip the collider — visuals only, no physics interaction.
      var col = go.GetComponent<Collider>();
      if (col != null) Destroy(col);
      go.name = $"Projectile:{fireId}";
      var rend = go.GetComponent<Renderer>();
      if (rend != null) rend.material.color = new Color(1.0f, 0.85f, 0.2f);

      projectiles[fireId] = new ProjectileInstance {
        Go = go,
        OriginX = originX, OriginY = originY, OriginZ = originZ,
        DirX = dirX, DirY = dirY, DirZ = dirZ,
        ServerFireTimeMs = serverFireTimeMs,
        Speed = defaultProjectileSpeed,
        Lifetime = defaultProjectileLifetime,
      };
    }

    // Called from NetworkClient.OnMessage("hit", ...).
    public void OnHit(int fireId, uint enemyId, int damage, double x, double y, double z, GameObject enemyGo) {
      // Despawn the projectile that landed (if we have it).
      if (projectiles.TryGetValue(fireId, out var p)) {
        if (p.Go != null) Destroy(p.Go);
        projectiles.Remove(fireId);
      }

      // Flash the target enemy briefly.
      if (enemyGo != null) {
        StartCoroutine(FlashCoroutine(enemyGo, new Color(1f, 1f, 1f), 0.08f));
      }

      // Spawn floating damage number.
      SpawnDamageNumber(damage, new Vector3((float)x, (float)y + 1.0f, (float)z));
    }

    // Aura pulse: expanding sphere centered on origin, fades over ~0.5s.
    // Kronos triggers this via a fire event on each pulse tick.
    private void OnAuraPulse(double originX, double originY, double originZ) {
      var go = GameObject.CreatePrimitive(PrimitiveType.Sphere);
      go.transform.localScale = Vector3.one * 0.3f;
      go.transform.position = new Vector3((float)originX, (float)originY + 0.5f, (float)originZ);
      var col = go.GetComponent<Collider>();
      if (col != null) Destroy(col);
      go.name = "AuraPulse";
      var rend = go.GetComponent<Renderer>();
      if (rend != null) rend.material.color = new Color(0.3f, 0.9f, 0.9f, 0.6f);
      StartCoroutine(BurstCoroutine(go, 0.5f, 8f));
    }

    // Called from NetworkClient.OnMessage("boomerang_thrown", ...).
    // Boomerang travels in 3 phases (outbound → brief stop → return).
    // The owner's interpolated position is needed for the return phase
    // (the axe homes back to wherever the owner is RIGHT NOW), so we
    // poll NetworkClient for the owner Transform each frame.
    public void OnBoomerangThrown(int fireId, string ownerId,
                                  double originX, double originY, double originZ,
                                  double dirX, double dirZ,
                                  double outboundDistance, double outboundSpeed, double returnSpeed,
                                  double serverFireTimeMs) {
      var go = GameObject.CreatePrimitive(PrimitiveType.Cylinder);
      go.transform.localScale = new Vector3(0.15f, 0.5f, 0.15f);
      go.transform.position = new Vector3((float)originX, (float)originY, (float)originZ);
      var col = go.GetComponent<Collider>();
      if (col != null) Destroy(col);
      go.name = $"Boomerang:{fireId}";
      var rend = go.GetComponent<Renderer>();
      if (rend != null) rend.material.color = new Color(0.5f, 0.25f, 0.1f);  // bronze/wood
      StartCoroutine(BoomerangCoroutine(go, ownerId,
        originX, originY, originZ, dirX, dirZ,
        outboundDistance, outboundSpeed, returnSpeed, serverFireTimeMs));
    }

    private IEnumerator BoomerangCoroutine(GameObject go, string ownerId,
                                           double ox, double oy, double oz,
                                           double dx, double dz,
                                           double outboundDistance, double outboundSpeed, double returnSpeed,
                                           double serverFireTimeMs) {
      // Outbound: travel `outboundDistance` units along (dx,dz) at outboundSpeed.
      // Stop: 1 tick (~50ms).
      // Return: travel toward owner's current position at returnSpeed until close.
      double outboundDurMs = (outboundDistance / outboundSpeed) * 1000.0;
      double stopDurMs = 50.0;
      while (go != null) {
        double serverNow = NetworkClient.Instance != null ? NetworkClient.Instance.ServerNowMs() : NowMs();
        double elapsedMs = serverNow - serverFireTimeMs;
        Vector3 pos;
        if (elapsedMs <= outboundDurMs) {
          double tSec = elapsedMs / 1000.0;
          pos = new Vector3(
            (float)(ox + dx * outboundSpeed * tSec),
            (float)oy,
            (float)(oz + dz * outboundSpeed * tSec)
          );
        } else if (elapsedMs <= outboundDurMs + stopDurMs) {
          pos = new Vector3(
            (float)(ox + dx * outboundDistance),
            (float)oy,
            (float)(oz + dz * outboundDistance)
          );
        } else {
          // Return phase: home toward owner. If owner isn't ours, fall
          // back to the throw origin so the boomerang still feels coherent.
          Vector3 ownerPos = LookupPlayerPosition(ownerId, new Vector3((float)ox, (float)oy, (float)oz));
          Vector3 returnStart = new Vector3(
            (float)(ox + dx * outboundDistance),
            (float)oy,
            (float)(oz + dz * outboundDistance)
          );
          double returnElapsedMs = elapsedMs - outboundDurMs - stopDurMs;
          double returnDurMs = (Vector3.Distance(returnStart, ownerPos) / returnSpeed) * 1000.0;
          if (returnDurMs <= 0) { Destroy(go); yield break; }
          float u = (float)Mathf.Clamp01((float)(returnElapsedMs / returnDurMs));
          pos = Vector3.Lerp(returnStart, ownerPos, u);
          if (u >= 1f) { Destroy(go); yield break; }
        }
        go.transform.position = pos;
        // Spin for visual flair.
        go.transform.Rotate(0f, 720f * UnityEngine.Time.deltaTime, 0f);
        yield return null;
      }
    }

    // Called from NetworkClient.OnMessage("melee_swipe", ...).
    // Brief arc flash (200ms) at the attacker's facing direction.
    public void OnMeleeSwipe(string ownerId,
                             double originX, double originY, double originZ,
                             double facingX, double facingZ,
                             double arcAngle, double range) {
      var go = GameObject.CreatePrimitive(PrimitiveType.Quad);
      go.transform.localScale = new Vector3((float)range * 1.5f, (float)range * 1.5f, 1f);
      go.transform.position = new Vector3((float)originX + (float)facingX * (float)range * 0.5f,
                                          (float)originY + 0.5f,
                                          (float)originZ + (float)facingZ * (float)range * 0.5f);
      // Lay the quad flat on the ground, facing up.
      go.transform.rotation = Quaternion.Euler(90f, 0f, 0f);
      var col = go.GetComponent<Collider>();
      if (col != null) Destroy(col);
      go.name = $"MeleeSwipe:{ownerId}";
      var rend = go.GetComponent<Renderer>();
      if (rend != null) rend.material.color = new Color(1f, 0.9f, 0.5f, 0.7f);
      StartCoroutine(FadeAndDestroyCoroutine(go, 0.2f));
    }

    // Called from NetworkClient.OnMessage("player_damaged", ...).
    // Red flash on the player GameObject + damage number above them.
    public void OnPlayerDamaged(string playerId, int damage,
                                double x, double y, double z,
                                GameObject playerGo) {
      if (playerGo != null) {
        StartCoroutine(FlashCoroutine(playerGo, new Color(1f, 0.2f, 0.2f), 0.15f));
      }
      SpawnDamageNumber(damage, new Vector3((float)x, (float)y + 1.5f, (float)z));
    }

    private Vector3 LookupPlayerPosition(string sessionId, Vector3 fallback) {
      // CombatVfx doesn't own player GameObjects; lookup goes through
      // NetworkClient via a public method. Avoids tight coupling and
      // works whether the player is local or remote.
      if (NetworkClient.Instance == null) return fallback;
      var go = NetworkClient.Instance.GetPlayerObject(sessionId);
      return go != null ? go.transform.position : fallback;
    }

    private IEnumerator FadeAndDestroyCoroutine(GameObject go, float duration) {
      if (go == null) yield break;
      var rend = go.GetComponent<Renderer>();
      Color startColor = rend != null ? rend.material.color : Color.white;
      float t = 0f;
      while (t < duration && go != null) {
        float u = t / duration;
        if (rend != null && rend.material != null) {
          var c = startColor;
          c.a = 1f - u;
          rend.material.color = c;
        }
        t += UnityEngine.Time.deltaTime;
        yield return null;
      }
      if (go != null) Destroy(go);
    }

    // Called from NetworkClient.OnMessage("enemy_died", ...).
    public void OnEnemyDied(uint enemyId, double x, double z, GameObject enemyGo) {
      // Simple kill burst — small expanding sphere that fades. The enemy
      // GameObject itself is destroyed by NetworkClient.HandleEnemyRemove
      // when the schema's MapSchema entry leaves; we just add a flash.
      var burst = GameObject.CreatePrimitive(PrimitiveType.Sphere);
      burst.transform.localScale = Vector3.one * 0.5f;
      burst.transform.position = new Vector3((float)x, 1.0f, (float)z);
      var col = burst.GetComponent<Collider>();
      if (col != null) Destroy(col);
      burst.name = $"DeathBurst:{enemyId}";
      var rend = burst.GetComponent<Renderer>();
      if (rend != null) rend.material.color = new Color(1f, 0.4f, 0.2f);
      StartCoroutine(BurstCoroutine(burst, 0.4f, 3.5f));
    }

    private double NowMs() => UnityEngine.Time.realtimeSinceStartupAsDouble * 1000.0;

    // Phase-4.3 continuous orbit rendering. Reads the local player's
    // weapons each frame; if any have behavior=orbit, renders 3 orbs
    // circling the local-player cube. Uses wall-clock angular phase
    // (NOT state.tick) for simplicity — visually correct but
    // cross-client orb positions may differ by a few degrees. Server
    // tick-based would be bit-deterministic per CLAUDE.md rule 12;
    // upgrade if cross-client orb alignment becomes user-visible.
    public void UpdateOrbits(bool hasOrbitWeapon, Transform localTransform) {
      if (!hasOrbitWeapon || localTransform == null) {
        if (orbitOrbs.Count > 0) {
          foreach (var go in orbitOrbs) if (go != null) Destroy(go);
          orbitOrbs.Clear();
        }
        return;
      }
      const int OrbCount = 3;
      const float Radius = 2.0f;
      const float AngSpeed = Mathf.PI * 1.4f; // ~0.7 revs/sec
      while (orbitOrbs.Count < OrbCount) {
        var go = GameObject.CreatePrimitive(PrimitiveType.Sphere);
        go.transform.localScale = Vector3.one * 0.4f;
        var col = go.GetComponent<Collider>();
        if (col != null) Destroy(col);
        go.name = $"OrbitOrb:{orbitOrbs.Count}";
        var rend = go.GetComponent<Renderer>();
        if (rend != null) rend.material.color = new Color(0.5f, 0.7f, 1.0f);
        orbitOrbs.Add(go);
      }
      float baseAngle = (float)(Time.realtimeSinceStartupAsDouble * AngSpeed);
      for (int i = 0; i < orbitOrbs.Count; i++) {
        var go = orbitOrbs[i];
        if (go == null) continue;
        float angle = baseAngle + i * (Mathf.PI * 2f / OrbCount);
        go.transform.position = localTransform.position + new Vector3(
          Mathf.Cos(angle) * Radius, 1.0f, Mathf.Sin(angle) * Radius);
      }
    }

    public void OnPlayerDowned(bool isLocal) {
      if (isLocal) {
        localPlayerDowned = true;
        // Show the modal immediately — the run isn't necessarily over
        // (in co-op a teammate could still be standing) but the local
        // player can't act either way until the next run starts.
        if (GameUI.Instance != null) {
          GameUI.Instance.ShowRunOver("DOWNED", ReloadScene);
        }
      }
    }

    public void OnRunEnded() {
      runEnded = true;
      // Replaces the previous CombatVfx-owned IMGUI overlay. GameUI's
      // ShowRunOver renders the modal with a Restart button; clicking it
      // reloads the active scene, which re-runs NetworkClient.Start() and
      // joins a fresh room.
      if (GameUI.Instance != null) {
        GameUI.Instance.ShowRunOver("RUN ENDED", ReloadScene);
      }
    }

    private static void ReloadScene() {
      // Use scene NAME rather than buildIndex — buildIndex is -1 when
      // the scene isn't listed in Build Settings (which it isn't until
      // a real build is configured). Loading by name works in-editor
      // and in built players alike provided the scene asset is
      // discoverable.
      var s = SceneManager.GetActiveScene();
      SceneManager.LoadScene(s.name);
    }

    void Update() {
      // Closed-form projectile integration. Per AD1/AD2 we use server
      // time (via NetworkClient.Instance.ServerTimeOffsetMs) so two
      // clients with stable, similar offsets compute identical
      // projectile positions for the same fireId. Phase-4-MVP uses
      // Time.realtimeSinceStartupAsDouble + serverTimeOffsetMs from
      // NetworkClient via a temporary public accessor; clean wiring
      // is a Phase-4 follow-up.
      double serverNow = (NetworkClient.Instance != null)
        ? NetworkClient.Instance.ServerNowMs()
        : NowMs();
      double renderTime = serverNow - interpDelayMs;

      var toRemove = new List<int>();
      foreach (var kv in projectiles) {
        var p = kv.Value;
        double elapsedSec = (renderTime - p.ServerFireTimeMs) / 1000.0;
        if (elapsedSec >= p.Lifetime + 0.5) {
          if (p.Go != null) Destroy(p.Go);
          toRemove.Add(kv.Key);
          continue;
        }
        double t = elapsedSec > 0 ? elapsedSec : 0;
        if (p.Go != null) {
          p.Go.transform.position = new Vector3(
            (float)(p.OriginX + p.DirX * p.Speed * t),
            (float)(p.OriginY + p.DirY * p.Speed * t),
            (float)(p.OriginZ + p.DirZ * p.Speed * t)
          );
        }
      }
      foreach (var id in toRemove) projectiles.Remove(id);
    }

    private IEnumerator FlashCoroutine(GameObject go, Color flashColor, float duration) {
      if (go == null) yield break;
      var rend = go.GetComponent<Renderer>();
      if (rend == null) yield break;
      Color original = rend.material.color;
      rend.material.color = flashColor;
      yield return new WaitForSeconds(duration);
      // GameObject may have been destroyed mid-flash (enemy died, schema removed).
      if (rend != null && rend.material != null) {
        rend.material.color = original;
      }
    }

    private IEnumerator BurstCoroutine(GameObject go, float duration, float endScale) {
      if (go == null) yield break;
      float t = 0f;
      Vector3 startScale = go.transform.localScale;
      var rend = go.GetComponent<Renderer>();
      Color startColor = rend != null ? rend.material.color : Color.white;
      while (t < duration && go != null) {
        float u = t / duration;
        go.transform.localScale = Vector3.Lerp(startScale, startScale * endScale, u);
        if (rend != null && rend.material != null) {
          var c = startColor;
          c.a = 1f - u;
          rend.material.color = c;
        }
        t += UnityEngine.Time.deltaTime;
        yield return null;
      }
      if (go != null) Destroy(go);
    }

    private void SpawnDamageNumber(int damage, Vector3 worldPos) {
      var go = new GameObject($"DamageNumber:{damage}");
      go.transform.position = worldPos;
      var tm = go.AddComponent<TextMesh>();
      tm.text = damage.ToString();
      tm.fontSize = 64;
      tm.characterSize = 0.1f;
      tm.anchor = TextAnchor.MiddleCenter;
      tm.alignment = TextAlignment.Center;
      tm.color = new Color(1f, 0.9f, 0.3f);
      // Billboard via the MeshRenderer's sortingOrder; we orient toward
      // the main camera each frame in the coroutine.
      StartCoroutine(DamageNumberCoroutine(go, 1.0f, 1.5f));
    }

    private IEnumerator DamageNumberCoroutine(GameObject go, float duration, float rise) {
      if (go == null) yield break;
      Vector3 start = go.transform.position;
      var tm = go.GetComponent<TextMesh>();
      var cam = Camera.main;
      float t = 0f;
      while (t < duration && go != null) {
        float u = t / duration;
        go.transform.position = start + Vector3.up * (rise * u);
        if (cam != null) {
          // Face the camera so the number is always readable.
          go.transform.rotation = Quaternion.LookRotation(
            go.transform.position - cam.transform.position
          );
        }
        if (tm != null) {
          var c = tm.color;
          c.a = 1f - u;
          tm.color = c;
        }
        t += UnityEngine.Time.deltaTime;
        yield return null;
      }
      if (go != null) Destroy(go);
    }
  }
}
