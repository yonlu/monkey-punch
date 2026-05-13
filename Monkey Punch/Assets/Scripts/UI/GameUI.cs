using System;
using System.Collections.Generic;
using UnityEngine;
using UnityEngine.UIElements;

namespace MonkeyPunch.UI {
  [RequireComponent(typeof(UIDocument))]
  public class GameUI : MonoBehaviour {
    public static GameUI Instance { get; private set; }

    // ----- HUD state DTOs -----

    public struct HudWeaponEntry { public byte Kind; public byte Level; }
    public struct HudItemEntry   { public byte Kind; public byte Level; }
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
      public List<HudItemEntry>   Items;
    }
    private HudState hud;

    public struct LevelUpChoiceDisplay {
      public string Kind;
      public int    Index;
      public string Name;
      public int    NewLevel;
    }

    // ----- Modal state -----

    private bool levelUpVisible;
    private LevelUpChoiceDisplay[] levelUpChoices;
    private Action<int> onLevelUpClicked;
    public bool LevelUpOpen => levelUpVisible;

    private bool runOverVisible;
    private string runOverReason;
    private Action onRestartClicked;

    public bool AnyModalOpen => levelUpVisible || runOverVisible;

    // ----- UI Toolkit element refs (cached at OnEnable) -----

    private UIDocument doc;
    private VisualElement root;
    private Label statTime;
    private Label statKills;
    private Label hudTime;
    private Label hudLevel;
    private VisualElement hpFill;
    private Label hpText;
    private VisualElement xpFill;
    private VisualElement weaponsGrid;
    private VisualElement itemsGrid;
    private VisualElement lvlupBar;
    private Label lvlupPromptText;
    private Label lvlupTimer;
    private Label lvlupQueue;
    private VisualElement lvlupCards;
    private VisualElement runoverModal;
    private Label runoverTitle;
    private Button runoverRestart;

    // ----- MonoBehaviour lifecycle -----

    void Awake() {
      if (Instance != null && Instance != this) {
        Debug.LogWarning("[GameUI] Multiple instances detected — using the latest.");
      }
      Instance = this;
      doc = GetComponent<UIDocument>();
    }

    void OnEnable() {
      if (doc == null) doc = GetComponent<UIDocument>();
      root = doc.rootVisualElement.Q<VisualElement>("root");
      if (root == null) {
        Debug.LogError("[GameUI] UXML root 'root' not found — check GameUI.uxml is assigned to the UIDocument.");
        return;
      }
      statTime        = root.Q<Label>("stat-time");
      statKills       = root.Q<Label>("stat-kills");
      hudTime         = root.Q<Label>("hud-time");
      hudLevel        = root.Q<Label>("hud-level");
      hpFill          = root.Q<VisualElement>("hp-fill");
      hpText          = root.Q<Label>("hp-text");
      xpFill          = root.Q<VisualElement>("xp-fill");
      weaponsGrid     = root.Q<VisualElement>("weapons-grid");
      itemsGrid       = root.Q<VisualElement>("items-grid");
      lvlupBar        = root.Q<VisualElement>("lvlup-bar");
      lvlupPromptText = root.Q<Label>("lvlup-prompt-text");
      lvlupTimer      = root.Q<Label>("lvlup-timer");
      lvlupQueue      = root.Q<Label>("lvlup-queue");
      lvlupCards      = root.Q<VisualElement>("lvlup-cards");
      runoverModal    = root.Q<VisualElement>("runover");
      runoverTitle    = root.Q<Label>("runover-title");
      runoverRestart  = root.Q<Button>("runover-restart");

      if (runoverRestart != null) {
        runoverRestart.clicked += OnRestartButtonClicked;
      }
    }

    void OnDisable() {
      if (runoverRestart != null) {
        runoverRestart.clicked -= OnRestartButtonClicked;
      }
    }

    // ----- Public API (migration boundary — keep stable for NetworkClient) -----

    public void SetHud(HudState s) {
      hud = s;
      if (root == null) return;
      if (!hud.Connected) {
        root.AddToClassList("hidden");
        return;
      }
      root.RemoveFromClassList("hidden");

      // Top-row stats
      string elapsed = FormatTime(hud.ElapsedSeconds);
      statTime.text  = "⏱ " + elapsed;
      statKills.text = "💀 " + hud.Kills.ToString();

      // Top-center large time
      hudTime.text = elapsed;

      // Top-right level
      hudLevel.text = "LV " + hud.Level.ToString();

      // HP bar
      float hpFrac = hud.MaxHp > 0 ? Mathf.Clamp01((float)hud.Hp / hud.MaxHp) : 0f;
      hpFill.style.width = new StyleLength(new Length(hpFrac * 100f, LengthUnit.Percent));
      hpText.text = hud.Hp.ToString() + " / " + hud.MaxHp.ToString();

      // XP bar
      float xpFrac = hud.XpForNextLevel > 0 ? Mathf.Clamp01((float)hud.Xp / hud.XpForNextLevel) : 0f;
      xpFill.style.width = new StyleLength(new Length(xpFrac * 100f, LengthUnit.Percent));

      // Inventory grids — Task 8 owns this. Leave empty for now.
    }

    public void ShowLevelUp(LevelUpChoiceDisplay[] choices, Action<int> onClick) {
      levelUpChoices = choices;
      onLevelUpClicked = onClick;
      levelUpVisible = true;
      RefreshCursorState();
      // Cards rendered in Task 10.
    }

    public void HideLevelUp() {
      levelUpVisible = false;
      levelUpChoices = null;
      onLevelUpClicked = null;
      RefreshCursorState();
      // Cards cleared in Task 10.
    }

    public void ShowRunOver(string reason, Action onRestart) {
      runOverReason = reason;
      onRestartClicked = onRestart;
      runOverVisible = true;
      RefreshCursorState();
      // UXML class toggled in Task 9.
    }

    public void HideRunOver() {
      runOverVisible = false;
      runOverReason = null;
      onRestartClicked = null;
      RefreshCursorState();
    }

    private void OnRestartButtonClicked() {
      var cb = onRestartClicked;
      HideRunOver();
      cb?.Invoke();
    }

    // ----- Cursor management (narrowed from levelUpVisible || runOverVisible) -----

    private void RefreshCursorState() {
      if (runOverVisible) {
        UnityEngine.Cursor.lockState = CursorLockMode.None;
        UnityEngine.Cursor.visible = true;
      } else {
        UnityEngine.Cursor.lockState = CursorLockMode.Locked;
        UnityEngine.Cursor.visible = false;
      }
    }

    // ----- Pure helper (public for testability) -----

    public static string FormatTime(double seconds) {
      if (seconds < 0) seconds = 0;
      int total = (int)seconds;
      int m = total / 60;
      int s = total % 60;
      return $"{m:00}:{s:00}";
    }
  }
}
