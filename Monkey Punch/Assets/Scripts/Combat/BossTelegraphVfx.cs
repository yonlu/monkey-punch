using System.Collections.Generic;
using UnityEngine;
using MonkeyPunch.Net;

namespace MonkeyPunch.Combat {
  /// <summary>
  /// M10: ring decal + slam shockwave for boss telegraphed AoE. Reads
  /// ServerTime offset so all clients see the ring fill complete at
  /// the same wall-clock moment as the server fires (mirror of
  /// CombatVfx.cs).
  /// </summary>
  public class BossTelegraphVfx : MonoBehaviour {
    public static BossTelegraphVfx Instance { get; private set; }

    [Tooltip("Material for the telegraph ring. URP/Lit transparent; the " +
             "MonoBehaviour animates _BaseColor (yellow → red) and alpha " +
             "(0.4 → 1.0) over the windup. Optional — null leaves the " +
             "default cylinder material in place.")]
    [SerializeField] private Material ringMaterial;

    [Tooltip("Material for the slam shockwave (on fire). Optional.")]
    [SerializeField] private Material shockwaveMaterial;

    private readonly Dictionary<uint, GameObject> activeRings = new();

    void Awake() {
      if (Instance != null && Instance != this) {
        Destroy(gameObject);
        return;
      }
      Instance = this;
    }

    void OnDestroy() {
      if (Instance == this) Instance = null;
    }

    /// <summary>
    /// Called when boss_telegraph arrives. Instantiates a ring decal at
    /// (originX, +0.02, originZ). Tracks by bossId so a following
    /// boss_aoe_hit can find and replace the right ring.
    /// </summary>
    public void OnTelegraph(uint bossId, float originX, float originZ,
                            float radius, double fireServerTimeMs) {
      // Replace any existing ring for this boss (defensive — shouldn't
      // happen in normal flow because the ability resets fireAt = -1
      // before the next telegraph).
      if (activeRings.TryGetValue(bossId, out var existing) && existing != null) {
        Destroy(existing);
        activeRings.Remove(bossId);
      }

      var ring = GameObject.CreatePrimitive(PrimitiveType.Cylinder);
      ring.transform.localScale = new Vector3(radius * 2f, 0.02f, radius * 2f);
      ring.transform.position = new Vector3(originX, 0.02f, originZ);
      // TODO(art): once a sampled terrain.heightAt is exposed Unity-side,
      // sample it here so the ring sits on uneven ground correctly.
      var renderer = ring.GetComponent<Renderer>();
      if (renderer != null && ringMaterial != null) renderer.material = ringMaterial;
      // Disable collider — pure visual.
      var col = ring.GetComponent<Collider>();
      if (col != null) Destroy(col);

      var timer = ring.AddComponent<TelegraphTimer>();
      timer.fireServerTimeMs = fireServerTimeMs;
      timer.spawnServerTimeMs = NetworkClient.Instance != null
        ? NetworkClient.Instance.ServerNowMs()
        : ServerTime.LocalNowMs();

      activeRings[bossId] = ring;
    }

    /// <summary>
    /// Called when boss_aoe_hit arrives. Destroys the ring; spawns a
    /// shockwave that scales 1.0→1.2 over 200ms and fades.
    /// </summary>
    public void OnAoeHit(uint bossId, float originX, float originZ, float radius) {
      if (activeRings.TryGetValue(bossId, out var ring) && ring != null) {
        Destroy(ring);
        activeRings.Remove(bossId);
      }
      var shock = GameObject.CreatePrimitive(PrimitiveType.Cylinder);
      shock.transform.localScale = new Vector3(radius * 2f, 0.02f, radius * 2f);
      shock.transform.position = new Vector3(originX, 0.05f, originZ);
      var renderer = shock.GetComponent<Renderer>();
      if (renderer != null && shockwaveMaterial != null) renderer.material = shockwaveMaterial;
      var col = shock.GetComponent<Collider>();
      if (col != null) Destroy(col);
      var fade = shock.AddComponent<ShockwaveFade>();
      fade.startScale = radius * 2f;
      fade.endScale = radius * 2.4f;
      fade.lifetimeMs = 200;
    }

    /// <summary>Per-frame fill animation on a telegraph ring.</summary>
    private class TelegraphTimer : MonoBehaviour {
      public double fireServerTimeMs;
      public double spawnServerTimeMs;
      private Renderer rend;
      private Material material;
      void Awake() {
        rend = GetComponent<Renderer>();
        if (rend != null) material = rend.material;
      }
      void Update() {
        if (NetworkClient.Instance == null) return;
        double nowServer = NetworkClient.Instance.ServerNowMs();
        double total = fireServerTimeMs - spawnServerTimeMs;
        if (total <= 0) return;
        double elapsed = nowServer - spawnServerTimeMs;
        float t = Mathf.Clamp01((float)(elapsed / total));
        if (material != null) {
          var c = Color.Lerp(new Color(1f, 0.9f, 0.2f), new Color(1f, 0.15f, 0.1f), t);
          c.a = 0.4f + 0.6f * t;
          material.color = c;
        }
      }
    }

    private class ShockwaveFade : MonoBehaviour {
      public float startScale;
      public float endScale;
      public int lifetimeMs;
      private double startMs;
      private Renderer rend;
      private Material material;
      void Awake() {
        startMs = ServerTime.LocalNowMs();
        rend = GetComponent<Renderer>();
        if (rend != null) material = rend.material;
      }
      void Update() {
        double elapsed = ServerTime.LocalNowMs() - startMs;
        float t = Mathf.Clamp01((float)(elapsed / lifetimeMs));
        float scale = Mathf.Lerp(startScale, endScale, t);
        transform.localScale = new Vector3(scale, 0.02f, scale);
        if (material != null) {
          var c = material.color;
          c.a = 1f - t;
          material.color = c;
        }
        if (t >= 1f) Destroy(gameObject);
      }
    }
  }
}
