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
  }
}
#endif
