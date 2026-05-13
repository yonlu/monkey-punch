using System;
using System.Collections.Generic;
using UnityEngine;
using UnityEngine.InputSystem;
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

    // ----- Input -----

    [Header("Input")]
    [SerializeField] private InputActionAsset inputActions;
    private InputAction pick1, pick2, pick3;

    [Header("Style")]
    // The UXML `<Style src=...>` reference does not reliably attach the
    // stylesheet at runtime in Unity 6 (panel.styleSheets.count came back
    // 0 even though the .uss asset loaded fine). We attach manually in
    // OnEnable. Assign GameUI.uss here in the Inspector.
    [SerializeField] private StyleSheet hudStyleSheet;

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
      root = doc.rootVisualElement?.Q<VisualElement>("root");
      if (root == null) {
        Debug.LogError("[GameUI] UXML root 'root' not found — check GameUI.uxml is assigned to the UIDocument.");
        return;
      }
      if (hudStyleSheet != null && !root.styleSheets.Contains(hudStyleSheet)) {
        root.styleSheets.Add(hudStyleSheet);
      } else if (hudStyleSheet == null) {
        Debug.LogWarning("[GameUI] hudStyleSheet not assigned — assign Assets/UI/GameUI.uss on the GameUI component.");
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

      if (inputActions != null) {
        var map = inputActions.FindActionMap("LevelUp", throwIfNotFound: false);
        if (map != null) {
          pick1 = map.FindAction("Pick1");
          pick2 = map.FindAction("Pick2");
          pick3 = map.FindAction("Pick3");
          if (pick1 != null) pick1.performed += OnPick1;
          if (pick2 != null) pick2.performed += OnPick2;
          if (pick3 != null) pick3.performed += OnPick3;
        } else {
          Debug.LogWarning("[GameUI] Input action map 'LevelUp' not found.");
        }
      }
    }

    void OnDisable() {
      if (pick1 != null) pick1.performed -= OnPick1;
      if (pick2 != null) pick2.performed -= OnPick2;
      if (pick3 != null) pick3.performed -= OnPick3;
      DisableLevelUpActions();

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

      // Inventory grids
      UpdateInventoryGrid(weaponsGrid, hud.Weapons, isWeapon: true);
      UpdateInventoryGrid(itemsGrid,   hud.Items,   isWeapon: false);
    }

    private void UpdateInventoryGrid<T>(VisualElement grid, List<T> entries, bool isWeapon) where T : struct {
      if (grid == null) return;

      const int SlotCount = 8;
      while (grid.childCount < SlotCount) {
        var slot = new VisualElement();
        slot.AddToClassList("hud-slot");
        var glyph = new Label { name = "glyph" };
        glyph.AddToClassList("glyph");
        var lvl = new Label { name = "lvl" };
        lvl.AddToClassList("lvl");
        slot.Add(glyph);
        slot.Add(lvl);
        grid.Add(slot);
      }

      for (int i = 0; i < SlotCount; i++) {
        var slot = grid[i];
        var glyph = slot.Q<Label>("glyph");
        var lvl = slot.Q<Label>("lvl");
        if (entries != null && i < entries.Count) {
          slot.RemoveFromClassList("empty");
          if (isWeapon) {
            var e = (HudWeaponEntry)(object)entries[i];
            glyph.text = Names.WeaponGlyph(e.Kind);
            lvl.text = "L" + e.Level.ToString();
          } else {
            var e = (HudItemEntry)(object)entries[i];
            glyph.text = Names.ItemGlyph(e.Kind);
            lvl.text = "L" + e.Level.ToString();
          }
        } else {
          slot.AddToClassList("empty");
          glyph.text = "";
          lvl.text = "";
        }
      }
    }

    // Generation counter pattern: every Show/Hide bumps this. Each
    // scheduled deferred class toggle captures the gen at schedule time
    // and no-ops if a newer Show/Hide has run since. More bulletproof
    // than IVisualElementScheduledItem.Pause() — that has a race window
    // where an already-queued callback can still fire.
    private int lvlupGen = 0;

    public void ShowLevelUp(LevelUpChoiceDisplay[] choices, Action<int> onClick) {
      int gen = ++lvlupGen;
      levelUpChoices = choices;
      onLevelUpClicked = onClick;
      levelUpVisible = true;
      RefreshCursorState();
      EnableLevelUpActions();
      if (lvlupBar == null) return;

      BuildLevelUpCards(choices);
      lvlupBar.RemoveFromClassList("hidden");
      lvlupBar.schedule.Execute(() => {
        if (gen != lvlupGen) return;
        lvlupBar.AddToClassList("shown");
      }).ExecuteLater(16);
    }

    public void HideLevelUp() {
      int gen = ++lvlupGen;
      levelUpVisible = false;
      levelUpChoices = null;
      onLevelUpClicked = null;
      RefreshCursorState();
      DisableLevelUpActions();
      if (lvlupBar == null) return;
      lvlupBar.RemoveFromClassList("shown");
      lvlupBar.schedule.Execute(() => {
        if (gen != lvlupGen) return;
        lvlupBar.AddToClassList("hidden");
      }).ExecuteLater(170);
    }

    private void BuildLevelUpCards(LevelUpChoiceDisplay[] choices) {
      if (lvlupCards == null) return;
      lvlupCards.Clear();
      if (choices == null) return;
      for (int i = 0; i < choices.Length; i++) {
        var c = choices[i];
        var card = new VisualElement();
        card.AddToClassList("lvlup-card");
        if (c.Kind == "item") card.AddToClassList("item");

        var keyBadge = new Label { text = (i + 1).ToString() };
        keyBadge.AddToClassList("lvlup-card-key");
        card.Add(keyBadge);

        var tag = new Label { text = c.Kind == "item" ? "ITEM" : "WEAPON" };
        tag.AddToClassList("lvlup-card-tag");
        card.Add(tag);

        var glyph = new Label {
          text = c.Kind == "item"
            ? Names.ItemGlyph(c.Index)
            : Names.WeaponGlyph(c.Index),
        };
        glyph.AddToClassList("lvlup-card-glyph");
        card.Add(glyph);

        var name = new Label { name = "lvlup-card-name", text = c.Name ?? "?" };
        name.AddToClassList("lvlup-card-name");
        card.Add(name);

        var desc = new Label {
          text = c.Kind == "item"
            ? Names.ItemDescription(c.Index)
            : Names.WeaponDescription(c.Index),
        };
        desc.AddToClassList("lvlup-card-desc");
        card.Add(desc);

        var sub = new Label { text = "LV " + c.NewLevel.ToString() };
        sub.AddToClassList("lvlup-card-sub");
        card.Add(sub);

        lvlupCards.Add(card);
      }

      if (lvlupQueue != null) lvlupQueue.AddToClassList("hidden");
    }

    /// <summary>
    /// Called by NetworkClient when Player.downed flips. Toggles the
    /// .downed class on the level-up bar so cards grey out. Auto-pick
    /// continues to fire from the server's tickLevelUpDeadlines.
    /// </summary>
    public void SetDownedState(bool downed) {
      if (lvlupBar == null) return;
      if (downed) {
        lvlupBar.AddToClassList("downed");
        if (lvlupPromptText != null) lvlupPromptText.text = "REVIVE TO PICK";
      } else {
        lvlupBar.RemoveFromClassList("downed");
        if (lvlupPromptText != null) lvlupPromptText.text = "LEVEL UP — PRESS 1/2/3";
      }
    }

    /// <summary>
    /// Called by NetworkClient each frame while the level-up bar is open.
    /// `secondsRemaining` is computed from Player.levelUpDeadlineTick minus
    /// the current tick times SIM_DT_S on the caller side. `queueCount`
    /// is the total pending offers in Player.levelUpChoices; the badge
    /// shows +N MORE when count > 1.
    /// </summary>
    public void SetLevelUpTimer(double secondsRemaining, int queueCount) {
      if (lvlupTimer == null) return;
      int wholeSeconds = Mathf.CeilToInt((float)Mathf.Max(0f, (float)secondsRemaining));
      lvlupTimer.text = "AUTO " + wholeSeconds.ToString() + "s";

      // queueCount is the number of *additional pending offers beyond the
      // one currently shown* — not the number of choice cards in the
      // current offer. The server doesn't expose that figure today, so
      // NetworkClient passes 0 and the badge stays hidden. Each new offer
      // arrives as its own level_up_offered event and is shown in
      // sequence with a fresh deadline.
      if (lvlupQueue != null) {
        if (queueCount > 0) {
          lvlupQueue.RemoveFromClassList("hidden");
          lvlupQueue.text = "+" + queueCount.ToString() + " MORE";
        } else {
          lvlupQueue.AddToClassList("hidden");
        }
      }
    }

    public void ShowRunOver(string reason, Action onRestart) {
      // Hide the level-up bar first so 1/2/3 inputs are disabled and the
      // bar doesn't linger underneath the run-over modal. Server will
      // also reject any stale level_up_choice via the runEnded guard.
      if (levelUpVisible) HideLevelUp();
      runOverReason = reason;
      onRestartClicked = onRestart;
      runOverVisible = true;
      RefreshCursorState();
      if (runoverModal != null) {
        if (runoverTitle != null) runoverTitle.text = string.IsNullOrEmpty(reason) ? "RUN ENDED" : reason;
        runoverModal.RemoveFromClassList("hidden");
        // Trigger opacity transition on next frame by adding .shown after layout pass.
        runoverModal.schedule.Execute(() => runoverModal.AddToClassList("shown")).ExecuteLater(16);
      }
    }

    public void HideRunOver() {
      runOverVisible = false;
      runOverReason = null;
      onRestartClicked = null;
      RefreshCursorState();
      if (runoverModal != null) {
        runoverModal.RemoveFromClassList("shown");
        // After fade-out, add hidden to collapse layout.
        runoverModal.schedule.Execute(() => runoverModal.AddToClassList("hidden")).ExecuteLater(220);
      }
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

    // ----- Input helpers -----

    private void EnableLevelUpActions() {
      pick1?.Enable();
      pick2?.Enable();
      pick3?.Enable();
    }

    private void DisableLevelUpActions() {
      pick1?.Disable();
      pick2?.Disable();
      pick3?.Disable();
    }

    private void OnPick1(InputAction.CallbackContext _) => PickIndex(0);
    private void OnPick2(InputAction.CallbackContext _) => PickIndex(1);
    private void OnPick3(InputAction.CallbackContext _) => PickIndex(2);

    private void PickIndex(int idx) {
      if (!levelUpVisible || levelUpChoices == null) return;
      if (idx < 0 || idx >= levelUpChoices.Length) return;
      // Do NOT HideLevelUp here. Teardown is deferred to NetworkClient's
      // level_up_resolved handler. Reason: InputAction callbacks fire in
      // InputSystem.Update (before script Update), and the digit-key debug
      // grants in NetworkClient.Update poll Keyboard.current directly,
      // gated by GameUI.LevelUpOpen. If we cleared levelUpVisible here,
      // that gate would already be false by the time NetworkClient.Update
      // ran on the same frame — letting wasPressedThisFrame fire a
      // DebugGrantWeapon for the same key the user just used to pick a
      // card. Keeping levelUpVisible == true until the server confirms
      // closes the race. See spec
      // docs/superpowers/specs/2026-05-13-levelup-digit-double-grant-fix-design.md.
      DisableLevelUpActions();
      onLevelUpClicked?.Invoke(idx);
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
