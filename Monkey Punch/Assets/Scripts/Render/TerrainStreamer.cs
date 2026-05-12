using System;
using System.Collections.Generic;
using UnityEngine;
using UnityEngine.Rendering;

namespace MonkeyPunch.Render {
  // Phase 6 (Unity migration plan): receives the server's one-shot
  // terrain_data message and builds the world from it. Heightmap → Mesh
  // (single MeshFilter/MeshRenderer pair). Props → child GameObjects
  // colored by kind.
  //
  // Why streaming, not local generation: the migration plan defers
  // porting alea + simplex-noise bit-identically to C# (Phase 6 §
  // "Recommended approach: avoid the port entirely"). Server is the
  // only place terrainHeight runs; clients receive sampled values and
  // (for the Unity client) bilinear-interpolate at render only. Player
  // Y is always authoritative from the server, so terrain visual
  // resolution doesn't affect gameplay correctness.
  //
  // Singleton pattern matches CombatVfx — NetworkClient grabs Instance
  // on receipt of terrain_data and hands off the payload. Single
  // TerrainStreamer per scene assumption.
  public class TerrainStreamer : MonoBehaviour {
    public static TerrainStreamer Instance { get; private set; }

    [Header("Materials")]
    [Tooltip("Optional terrain material. Falls back to default URP/Lit if null.")]
    [SerializeField] private Material terrainMaterial;

    [Tooltip("Optional material for trees (prop kind 0).")]
    [SerializeField] private Material treeMaterial;
    [Tooltip("Optional material for rocks (prop kind 1).")]
    [SerializeField] private Material rockMaterial;
    [Tooltip("Optional material for bushes (prop kind 2).")]
    [SerializeField] private Material bushMaterial;

    [Header("Debug")]
    [SerializeField] private bool logBuildStats = true;

    // Built / replaced on every terrain_data receipt. Reconnects within
    // the server's grace window will fire terrain_data again with the
    // same payload — we tear down and rebuild rather than diff.
    private GameObject terrainGo;
    private GameObject propsParent;

    void Awake() {
      if (Instance != null && Instance != this) {
        Debug.LogWarning("[TerrainStreamer] Multiple instances detected — using the latest.");
      }
      Instance = this;
    }

    public void BuildFromPayload(int gridSize, double gridSpacing, double[] heights, IList<PropPayload> props, uint seed) {
      // Destroy any previous terrain / props (idempotent across rejoins).
      if (terrainGo != null) Destroy(terrainGo);
      if (propsParent != null) Destroy(propsParent);

      BuildTerrainMesh(gridSize, gridSpacing, heights);
      BuildProps(props);

      if (logBuildStats) {
        Debug.Log($"[TerrainStreamer] Built terrain: seed={seed} gridSize={gridSize} " +
                  $"spacing={gridSpacing:F2}m heights={heights.Length} props={props.Count}");
      }
    }

    // ----- Heightmap → Mesh -----

    private void BuildTerrainMesh(int gridSize, double gridSpacing, double[] heights) {
      int vertCount = gridSize + 1;
      if (heights.Length != vertCount * vertCount) {
        Debug.LogError($"[TerrainStreamer] heights.Length={heights.Length} but expected {vertCount * vertCount} for gridSize={gridSize}");
        return;
      }
      double half = (gridSize * gridSpacing) * 0.5;

      var vertices = new Vector3[vertCount * vertCount];
      // X-outer / Z-inner, matching the server's iteration order in
      // GameRoom.buildTerrainPayload. Swap the loops and rows/cols will
      // mirror.
      for (int ix = 0; ix < vertCount; ix++) {
        double x = -half + ix * gridSpacing;
        for (int iz = 0; iz < vertCount; iz++) {
          double z = -half + iz * gridSpacing;
          double y = heights[ix * vertCount + iz];
          vertices[ix * vertCount + iz] = new Vector3((float)x, (float)y, (float)z);
        }
      }

      // Each grid cell → 2 triangles, 6 indices. UInt32 index buffer
      // keeps us safe past the 65k-vertex limit even if gridSize bumps
      // in the future.
      var triangles = new int[gridSize * gridSize * 6];
      int t = 0;
      for (int ix = 0; ix < gridSize; ix++) {
        for (int iz = 0; iz < gridSize; iz++) {
          int a = ix * vertCount + iz;             // (ix,   iz)
          int b = ix * vertCount + (iz + 1);       // (ix,   iz+1)
          int c = (ix + 1) * vertCount + iz;       // (ix+1, iz)
          int d = (ix + 1) * vertCount + (iz + 1); // (ix+1, iz+1)
          // CCW from above (+Y looking -Y) → front face up.
          triangles[t++] = a;
          triangles[t++] = b;
          triangles[t++] = c;
          triangles[t++] = c;
          triangles[t++] = b;
          triangles[t++] = d;
        }
      }

      var mesh = new Mesh {
        name = "StreamedTerrain",
        indexFormat = IndexFormat.UInt32,
      };
      mesh.vertices = vertices;
      mesh.triangles = triangles;
      mesh.RecalculateNormals();
      mesh.RecalculateBounds();

      terrainGo = new GameObject("StreamedTerrain");
      var mf = terrainGo.AddComponent<MeshFilter>();
      mf.sharedMesh = mesh;
      var mr = terrainGo.AddComponent<MeshRenderer>();
      mr.material = terrainMaterial != null
        ? terrainMaterial
        : new Material(Shader.Find("Universal Render Pipeline/Lit")) { color = new Color(0.30f, 0.55f, 0.20f) };
    }

    // ----- Props → primitive GameObjects -----

    private void BuildProps(IList<PropPayload> props) {
      propsParent = new GameObject("StreamedProps");
      for (int i = 0; i < props.Count; i++) {
        var p = props[i];
        GameObject go;
        Color fallbackColor;
        Material mat;
        switch (p.kind) {
          case 0: // tree
            go = GameObject.CreatePrimitive(PrimitiveType.Cylinder);
            go.transform.localScale = new Vector3(0.8f, 2.0f, 0.8f); // tall + narrow
            fallbackColor = new Color(0.20f, 0.45f, 0.15f);
            mat = treeMaterial;
            break;
          case 1: // rock
            go = GameObject.CreatePrimitive(PrimitiveType.Sphere);
            go.transform.localScale = Vector3.one * 1.2f;
            fallbackColor = new Color(0.42f, 0.40f, 0.36f);
            mat = rockMaterial;
            break;
          case 2: // bush
            go = GameObject.CreatePrimitive(PrimitiveType.Cube);
            go.transform.localScale = new Vector3(1.0f, 0.6f, 1.0f);
            fallbackColor = new Color(0.30f, 0.55f, 0.22f);
            mat = bushMaterial;
            break;
          default:
            go = GameObject.CreatePrimitive(PrimitiveType.Cube);
            fallbackColor = Color.magenta;
            mat = null;
            break;
        }
        go.name = $"Prop[{i}]:kind{p.kind}";
        go.transform.SetParent(propsParent.transform, worldPositionStays: false);
        // Each primitive's origin is at its center — lift Y by half the
        // scaled mesh height so the base sits on the terrain. Cylinder /
        // Sphere / Cube native heights are 2 / 1 / 1 respectively.
        float baseHalfHeight = p.kind == 0 ? go.transform.localScale.y      // cylinder height = 2 * localScale.y
                                : p.kind == 1 ? go.transform.localScale.y * 0.5f
                                : go.transform.localScale.y * 0.5f;
        go.transform.position = new Vector3((float)p.x, (float)p.y + baseHalfHeight, (float)p.z);
        go.transform.rotation = Quaternion.Euler(0f, (float)(p.rotation * Mathf.Rad2Deg), 0f);
        // Uniform scale on top of the per-kind base scale.
        go.transform.localScale = go.transform.localScale * (float)p.scale;
        var rend = go.GetComponent<Renderer>();
        if (rend != null) {
          rend.material = mat != null ? mat : new Material(Shader.Find("Universal Render Pipeline/Lit")) { color = fallbackColor };
        }
      }
    }

    // DTO matching the server's terrain_data wire shape (Prop array
    // entry in packages/shared/src/messages.ts TerrainDataMessage).
    [Serializable]
    public class PropPayload {
      public int kind;
      public double x;
      public double y;
      public double z;
      public double rotation;
      public double scale;
    }
  }
}
