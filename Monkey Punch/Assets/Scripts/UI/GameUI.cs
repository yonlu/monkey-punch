using System;
using System.Collections.Generic;
using UnityEngine;

namespace MonkeyPunch.UI {
  // Phase 7 MVP (Unity migration plan): centralizes the three pieces of
  // UI that close the game loop — level-up overlay, run-over panel,
  // structured HUD with HP/XP/level/weapons/items.
  //
  // Implementation choice: IMGUI rather than UI Toolkit.
  // The migration plan recommends UI Toolkit but the MVP gate is "full
  // game loop is playable end-to-end". IMGUI satisfies that gate with
  // zero asset setup (no PanelSettings, no UXML, no USS). Phase 8 polish
  // should re-implement these screens in UI Toolkit with authored styles
  // — the GameUI public API (ShowLevelUp / HideLevelUp / ShowRunOver /
  // SetHud) is the migration boundary; only the rendering implementation
  // needs to change.
  //
  // Singleton (matches CombatVfx / TerrainStreamer). NetworkClient
  // pushes HUD state per frame and posts level-up + run-over events.
  //
  // Coplay MCP screenshots can't capture IMGUI/Overlay canvases — for
  // visual verification, look at the Unity Editor directly.
  public class GameUI : MonoBehaviour {
    public static GameUI Instance { get; private set; }

    [Header("Layout")]
    [SerializeField] private float cardWidth = 220f;
    [SerializeField] private float cardHeight = 180f;
    [SerializeField] private float cardGap = 16f;

    // ----- HUD state (pushed by NetworkClient each frame) -----

    public struct HudWeaponEntry {
      public byte Kind;
      public byte Level;
    }
    public struct HudItemEntry {
      public byte Kind;
      public byte Level;
    }
    public struct HudState {
      public bool Connected;
      public int Hp;
      public int MaxHp;
      public uint Xp;
      public int XpForNextLevel;
      public byte Level;
      public uint Kills;
      public double ElapsedSeconds;
      public List<HudWeaponEntry> Weapons;
      public List<HudItemEntry> Items;
    }
    private HudState hud;

    public void SetHud(HudState s) { hud = s; }

    // ----- Level-up overlay -----

    public struct LevelUpChoiceDisplay {
      public string Kind;          // "weapon" or "item"
      public int Index;            // index into WEAPON_KINDS or ITEM_KINDS
      public string Name;          // resolved display name
      public int NewLevel;         // level the pick would advance to
    }
    private bool levelUpVisible;
    private LevelUpChoiceDisplay[] levelUpChoices;
    private Action<int> onLevelUpClicked;

    public void ShowLevelUp(LevelUpChoiceDisplay[] choices, Action<int> onClick) {
      levelUpChoices = choices;
      onLevelUpClicked = onClick;
      levelUpVisible = true;
    }
    public void HideLevelUp() {
      levelUpVisible = false;
      levelUpChoices = null;
      onLevelUpClicked = null;
    }
    public bool LevelUpOpen => levelUpVisible;

    // ----- Run-over panel -----

    private bool runOverVisible;
    private string runOverReason;
    private Action onRestartClicked;

    public void ShowRunOver(string reason, Action onRestart) {
      runOverReason = reason;
      onRestartClicked = onRestart;
      runOverVisible = true;
    }
    public void HideRunOver() {
      runOverVisible = false;
      runOverReason = null;
      onRestartClicked = null;
    }

    // ----- MonoBehaviour -----

    void Awake() {
      if (Instance != null && Instance != this) {
        Debug.LogWarning("[GameUI] Multiple instances detected — using the latest.");
      }
      Instance = this;
    }

    void OnGUI() {
      DrawHud();
      if (runOverVisible) DrawRunOver();
      // Level-up renders last so it overlays everything including run-over.
      // (Won't happen simultaneously in normal flow but the priority is clear.)
      if (levelUpVisible) DrawLevelUp();
    }

    // ----- Drawing -----

    private void DrawHud() {
      if (!hud.Connected) return;

      var box = new GUIStyle(GUI.skin.box) { alignment = TextAnchor.UpperLeft };
      var label = new GUIStyle(GUI.skin.label) { fontSize = 13, richText = true };

      // Top-left vitals panel.
      float panelW = 240f;
      float panelH = 132f;
      GUI.Box(new Rect(Screen.width - panelW - 12f, 12f, panelW, panelH), GUIContent.none, box);

      var x0 = Screen.width - panelW - 4f;
      float y = 18f;

      // HP bar.
      float hpFrac = hud.MaxHp > 0 ? Mathf.Clamp01((float)hud.Hp / hud.MaxHp) : 0f;
      DrawBar(new Rect(x0, y, panelW - 16f, 18f), hpFrac, new Color(0.85f, 0.15f, 0.15f, 0.9f),
              $"HP {hud.Hp} / {hud.MaxHp}");
      y += 22f;

      // XP bar.
      float xpFrac = hud.XpForNextLevel > 0 ? Mathf.Clamp01((float)hud.Xp / hud.XpForNextLevel) : 0f;
      DrawBar(new Rect(x0, y, panelW - 16f, 14f), xpFrac, new Color(0.20f, 0.50f, 0.95f, 0.9f),
              $"XP {hud.Xp} / {hud.XpForNextLevel}  (Lv {hud.Level})");
      y += 18f;

      GUI.Label(new Rect(x0, y, panelW - 16f, 18f),
        $"Kills: {hud.Kills}   Time: {FormatTime(hud.ElapsedSeconds)}", label);
      y += 20f;

      // Weapons + items lines.
      string weaponsLine = "Weap: " + JoinKinded(hud.Weapons, true);
      string itemsLine   = "Items: " + JoinKinded(hud.Items,   false);
      GUI.Label(new Rect(x0, y, panelW - 16f, 18f), weaponsLine, label);
      y += 18f;
      GUI.Label(new Rect(x0, y, panelW - 16f, 18f), itemsLine, label);
    }

    private string JoinKinded(List<HudWeaponEntry> entries, bool weapons) {
      if (entries == null || entries.Count == 0) return "(none)";
      var sb = new System.Text.StringBuilder();
      for (int i = 0; i < entries.Count; i++) {
        if (i > 0) sb.Append(", ");
        sb.Append(Names.WeaponName(entries[i].Kind));
        sb.Append(" +"); sb.Append(entries[i].Level);
      }
      return sb.ToString();
    }
    private string JoinKinded(List<HudItemEntry> entries, bool _) {
      if (entries == null || entries.Count == 0) return "(none)";
      var sb = new System.Text.StringBuilder();
      for (int i = 0; i < entries.Count; i++) {
        if (i > 0) sb.Append(", ");
        sb.Append(Names.ItemName(entries[i].Kind));
        sb.Append(" +"); sb.Append(entries[i].Level);
      }
      return sb.ToString();
    }

    private static void DrawBar(Rect rect, float frac, Color fillColor, string label) {
      var bgColor = new Color(0f, 0f, 0f, 0.4f);
      var prev = GUI.color;
      GUI.color = bgColor;
      GUI.DrawTexture(rect, Texture2D.whiteTexture);
      GUI.color = fillColor;
      GUI.DrawTexture(new Rect(rect.x, rect.y, rect.width * frac, rect.height), Texture2D.whiteTexture);
      GUI.color = prev;
      var labelStyle = new GUIStyle(GUI.skin.label) {
        alignment = TextAnchor.MiddleCenter,
        fontStyle = FontStyle.Bold,
      };
      GUI.Label(rect, label, labelStyle);
    }

    private void DrawRunOver() {
      float w = 360f, h = 160f;
      var rect = new Rect((Screen.width - w) * 0.5f, (Screen.height - h) * 0.5f, w, h);
      var darken = GUI.color;
      GUI.color = new Color(0f, 0f, 0f, 0.55f);
      GUI.DrawTexture(new Rect(0, 0, Screen.width, Screen.height), Texture2D.whiteTexture);
      GUI.color = darken;
      GUI.Box(rect, GUIContent.none);
      var titleStyle = new GUIStyle(GUI.skin.label) {
        alignment = TextAnchor.MiddleCenter,
        fontSize = 28,
        fontStyle = FontStyle.Bold,
      };
      GUI.Label(new Rect(rect.x, rect.y + 12f, w, 40f), runOverReason ?? "Run Ended", titleStyle);
      var btnStyle = new GUIStyle(GUI.skin.button) { fontSize = 16 };
      if (GUI.Button(new Rect(rect.x + (w - 180f) * 0.5f, rect.y + 90f, 180f, 40f), "Restart", btnStyle)) {
        var cb = onRestartClicked;
        HideRunOver();
        cb?.Invoke();
      }
    }

    private void DrawLevelUp() {
      if (levelUpChoices == null || levelUpChoices.Length == 0) return;
      // Dim background so the player notices the modal.
      var prev = GUI.color;
      GUI.color = new Color(0f, 0f, 0f, 0.55f);
      GUI.DrawTexture(new Rect(0, 0, Screen.width, Screen.height), Texture2D.whiteTexture);
      GUI.color = prev;

      var titleStyle = new GUIStyle(GUI.skin.label) {
        alignment = TextAnchor.MiddleCenter,
        fontSize = 26,
        fontStyle = FontStyle.Bold,
      };
      GUI.Label(new Rect(0, 60f, Screen.width, 40f), "Level Up! Choose one:", titleStyle);

      int n = levelUpChoices.Length;
      float totalW = n * cardWidth + (n - 1) * cardGap;
      float x = (Screen.width - totalW) * 0.5f;
      float y = (Screen.height - cardHeight) * 0.5f;

      var cardBoxStyle = new GUIStyle(GUI.skin.box);
      var nameStyle = new GUIStyle(GUI.skin.label) {
        alignment = TextAnchor.MiddleCenter,
        fontSize = 18,
        fontStyle = FontStyle.Bold,
        wordWrap = true,
      };
      var subStyle = new GUIStyle(GUI.skin.label) {
        alignment = TextAnchor.MiddleCenter,
        fontSize = 13,
      };
      var pickStyle = new GUIStyle(GUI.skin.button) {
        fontSize = 16,
        fontStyle = FontStyle.Bold,
      };

      for (int i = 0; i < n; i++) {
        var c = levelUpChoices[i];
        var rect = new Rect(x + i * (cardWidth + cardGap), y, cardWidth, cardHeight);
        GUI.Box(rect, GUIContent.none, cardBoxStyle);
        GUI.Label(new Rect(rect.x + 8f, rect.y + 12f, rect.width - 16f, 50f), c.Name, nameStyle);
        string kindLine = c.Kind == "weapon" ? "Weapon" : "Item";
        GUI.Label(new Rect(rect.x + 8f, rect.y + 64f, rect.width - 16f, 24f),
                  $"{kindLine}  →  Level {c.NewLevel}", subStyle);
        if (GUI.Button(new Rect(rect.x + 16f, rect.y + cardHeight - 50f, cardWidth - 32f, 36f),
                       "Pick", pickStyle)) {
          int picked = i;
          var cb = onLevelUpClicked;
          HideLevelUp();
          cb?.Invoke(picked);
        }
      }
    }

    private static string FormatTime(double seconds) {
      if (seconds < 0) seconds = 0;
      int total = (int)seconds;
      int m = total / 60;
      int s = total % 60;
      return $"{m:00}:{s:00}";
    }
  }
}
