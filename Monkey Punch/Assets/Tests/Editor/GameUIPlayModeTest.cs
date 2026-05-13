#if UNITY_EDITOR
using System.Collections;
using System.Collections.Generic;
using NUnit.Framework;
using UnityEngine;
using UnityEngine.TestTools;
using UnityEngine.UIElements;
using UnityEditor;
using MonkeyPunch.UI;

namespace MonkeyPunch.Tests.Runtime {
  public class GameUIPlayModeTest {
    private GameObject host;
    private GameUI gameUI;

    [UnitySetUp]
    public IEnumerator SetUp() {
      host = new GameObject("GameUI_test_host");
      var doc = host.AddComponent<UIDocument>();
      // PanelSettings is not required for element-query tests; VTA builds the tree without it.
      doc.visualTreeAsset = AssetDatabase.LoadAssetAtPath<VisualTreeAsset>("Assets/UI/GameUI.uxml");
      Assert.IsNotNull(doc.visualTreeAsset, "VisualTreeAsset not found at Assets/UI/GameUI.uxml.");
      gameUI = host.AddComponent<GameUI>();
      // In EditMode, AddComponent does not call OnEnable automatically.
      // Invoke via reflection to wire element refs without going through SendMessage
      // (SendMessage triggers a ShouldRunBehaviour assertion in EditMode).
      var onEnable = typeof(GameUI).GetMethod("OnEnable",
          System.Reflection.BindingFlags.NonPublic | System.Reflection.BindingFlags.Instance);
      onEnable?.Invoke(gameUI, null);
      yield return null; // allow one editor frame
    }

    [UnityTearDown]
    public IEnumerator TearDown() {
      Object.DestroyImmediate(host);
      yield return null;
    }

    [UnityTest]
    public IEnumerator SetHud_PopulatesAllTextBindings() {
      gameUI.SetHud(new GameUI.HudState {
        Connected      = true,
        Hp             = 70,
        MaxHp          = 100,
        Xp             = 35,
        XpForNextLevel = 100,
        Level          = 4,
        Kills          = 142,
        ElapsedSeconds = 201,
        Weapons        = new List<GameUI.HudWeaponEntry>(),
        Items          = new List<GameUI.HudItemEntry>(),
      });
      yield return null;

      var root = gameUI.GetComponent<UIDocument>().rootVisualElement;
      Assert.AreEqual("03:21",    root.Q<Label>("hud-time").text);
      Assert.AreEqual("LV 4",     root.Q<Label>("hud-level").text);
      Assert.AreEqual("70 / 100", root.Q<Label>("hp-text").text);
      Assert.IsTrue(root.Q<Label>("stat-time").text.Contains("03:21"));
      Assert.IsTrue(root.Q<Label>("stat-kills").text.Contains("142"));
    }

    [UnityTest]
    public IEnumerator SetHud_WithTwoWeapons_RendersTwoSlotsAndSixEmpty() {
      gameUI.SetHud(new GameUI.HudState {
        Connected      = true,
        Hp = 100, MaxHp = 100, Xp = 0, XpForNextLevel = 100, Level = 1, Kills = 0,
        ElapsedSeconds = 0,
        Weapons = new List<GameUI.HudWeaponEntry> {
          new GameUI.HudWeaponEntry { Kind = 0, Level = 3 }, // Bolt L3
          new GameUI.HudWeaponEntry { Kind = 7, Level = 1 }, // Bloody Axe L1
        },
        Items = new List<GameUI.HudItemEntry>(),
      });
      yield return null;

      var grid = gameUI.GetComponent<UIDocument>().rootVisualElement.Q<VisualElement>("weapons-grid");
      Assert.AreEqual(8, grid.childCount);
      Assert.IsFalse(grid[0].ClassListContains("empty"));
      Assert.AreEqual("⚡", grid[0].Q<Label>("glyph").text);
      Assert.AreEqual("L3", grid[0].Q<Label>("lvl").text);
      Assert.IsFalse(grid[1].ClassListContains("empty"));
      Assert.AreEqual("🪓", grid[1].Q<Label>("glyph").text);
      Assert.IsTrue(grid[2].ClassListContains("empty"));
      Assert.IsTrue(grid[7].ClassListContains("empty"));
    }

    [UnityTest]
    public IEnumerator ShowRunOver_RemovesHiddenClassAndSetsTitle() {
      bool restartCalled = false;
      gameUI.ShowRunOver("DEFEAT", () => restartCalled = true);
      yield return new WaitForSeconds(0.05f); // wait for schedule.Execute (16ms) to trigger

      var root = gameUI.GetComponent<UIDocument>().rootVisualElement;
      var modal = root.Q<VisualElement>("runover");
      Assert.IsFalse(modal.ClassListContains("hidden"));
      Assert.AreEqual("DEFEAT", root.Q<Label>("runover-title").text);

      gameUI.HideRunOver();
      yield return new WaitForSeconds(0.25f);
      Assert.IsFalse(restartCalled); // HideRunOver does not invoke the callback
    }

    [UnityTest]
    public IEnumerator ShowLevelUp_WithThreeChoices_RendersThreeCards() {
      var choices = new GameUI.LevelUpChoiceDisplay[] {
        new GameUI.LevelUpChoiceDisplay { Kind = "weapon", Index = 0, Name = "BOLT",    NewLevel = 3 },
        new GameUI.LevelUpChoiceDisplay { Kind = "item",   Index = 0, Name = "IFRIT",   NewLevel = 1 },
        new GameUI.LevelUpChoiceDisplay { Kind = "weapon", Index = 6, Name = "KRONOS",  NewLevel = 1 },
      };
      int picked = -1;
      gameUI.ShowLevelUp(choices, idx => picked = idx);
      yield return null;

      var root = gameUI.GetComponent<UIDocument>().rootVisualElement;
      var bar = root.Q<VisualElement>("lvlup-bar");
      var cards = root.Q<VisualElement>("lvlup-cards");
      Assert.IsFalse(bar.ClassListContains("hidden"));
      Assert.AreEqual(3, cards.childCount);
      Assert.IsTrue(cards[1].ClassListContains("item"));
      Assert.AreEqual("BOLT",   cards[0].Q<Label>("lvlup-card-name").text);
      Assert.AreEqual("IFRIT",  cards[1].Q<Label>("lvlup-card-name").text);
      Assert.AreEqual("KRONOS", cards[2].Q<Label>("lvlup-card-name").text);

      gameUI.HideLevelUp();
      yield return new WaitForSeconds(0.25f); // wait for fade-out (170ms + buffer)
      Assert.IsTrue(bar.ClassListContains("hidden"));
      Assert.AreEqual(-1, picked);
    }

    [UnityTest]
    public IEnumerator SetDownedState_WhenTrue_AppliesDownedClass() {
      var choices = new GameUI.LevelUpChoiceDisplay[] {
        new GameUI.LevelUpChoiceDisplay { Kind = "weapon", Index = 0, Name = "BOLT", NewLevel = 2 },
      };
      gameUI.ShowLevelUp(choices, _ => {});
      yield return null;

      gameUI.SetDownedState(true);
      yield return null;

      var bar = gameUI.GetComponent<UIDocument>().rootVisualElement.Q<VisualElement>("lvlup-bar");
      Assert.IsTrue(bar.ClassListContains("downed"));

      gameUI.SetDownedState(false);
      yield return null;
      Assert.IsFalse(bar.ClassListContains("downed"));
    }
  }
}
#endif
