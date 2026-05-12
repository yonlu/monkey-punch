using System;
using System.Collections;
using System.Collections.Generic;
using UnityEngine;
using MonkeyPunch.Net;

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

    void Awake() { Instance = this; }

    // Called from NetworkClient.OnMessage("fire", ...).
    public void OnFire(int fireId, byte weaponKind, byte weaponLevel,
                       double originX, double originY, double originZ,
                       double dirX, double dirY, double dirZ,
                       double serverFireTimeMs) {
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
