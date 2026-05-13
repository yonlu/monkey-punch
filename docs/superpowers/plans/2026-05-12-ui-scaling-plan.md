# Phase 8.4 — UI Toolkit migration + resolution-aware scaling — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the IMGUI-rendered `GameUI` with a UI Toolkit (UXML + USS) implementation that scales correctly across resolutions (1080p → 4K → 21:9 ultrawide), preserves the existing public C# API as a migration boundary, and switches the level-up flow to a non-modal bottom-center keyboard-driven bar.

**Architecture:** One shared `PanelSettings` asset (`Scale With Screen Size`, ref 1920×1080, match-height=1.0) drives a single `UIDocument` rendering one UXML tree. `GameUI.cs` becomes a thin controller that caches `VisualElement` references at `Awake` and pushes per-frame state into them via `SetHud`. The level-up flow is rewired: cursor stays locked, `Input System` actions on digit-row 1/2/3 trigger picks, server's existing `levelUpDeadline` drives a rendered auto-pick countdown. Run-over remains a centered modal that unlocks the cursor.

**Tech Stack:** Unity 6 (UI Toolkit, Input System), C# 9, NUnit (Unity Test Runner), Press Start 2P TTF (Google Fonts OFL), Colyseus C# SDK 0.17 (unchanged).

**Spec:** `docs/superpowers/specs/2026-05-12-ui-scaling-design.md`

---

## File map

**New assets:**
- `Monkey Punch/Assets/Fonts/PressStart2P-Regular.ttf` — Press Start 2P TTF (Google Fonts)
- `Monkey Punch/Assets/Fonts/PressStart2P-Regular.ttf.meta` — auto-generated
- `Monkey Punch/Assets/UI/GameUI.panelsettings` — Unity PanelSettings asset
- `Monkey Punch/Assets/UI/GameUI.panelsettings.meta` — auto-generated
- `Monkey Punch/Assets/UI/GameUI.uxml` — visual tree
- `Monkey Punch/Assets/UI/GameUI.uxml.meta` — auto-generated
- `Monkey Punch/Assets/UI/GameUI.uss` — style sheet
- `Monkey Punch/Assets/UI/GameUI.uss.meta` — auto-generated

**New tests:**
- `Monkey Punch/Assets/Tests/Editor/GameUITest.cs` — EditMode unit tests for pure functions
- `Monkey Punch/Assets/Tests/Editor/GameUITest.cs.meta` — auto-generated
- `Monkey Punch/Assets/Tests/Runtime/GameUIPlayModeTest.cs` — PlayMode smoke tests
- `Monkey Punch/Assets/Tests/Runtime/GameUIPlayModeTest.cs.meta` — auto-generated
- `Monkey Punch/Assets/Tests/Runtime/MonkeyPunch.Tests.Runtime.asmdef` — assembly definition (if not present)

**Modified files:**
- `Monkey Punch/Assets/Scripts/UI/GameUI.cs` — IMGUI deleted (lines 132–290), UXML bindings added, `RefreshCursorState` narrowed to `runOverVisible`
- `Monkey Punch/Assets/Scripts/UI/Names.cs` — adds `WeaponGlyph(byte)` + `ItemGlyph(byte)` static methods
- `Monkey Punch/Assets/InputSystem_Actions.inputactions` — adds a new map named `LevelUp` with actions `Pick1`, `Pick2`, `Pick3`
- Scene file containing the existing `GameUI` GameObject — receives a new `UIDocument` component referencing `GameUI.uxml` + `GameUI.panelsettings`

**Files explicitly NOT modified:**
- `Monkey Punch/Assets/Scripts/Net/NetworkClient.cs` — the migration boundary; verify with grep at the end
- Any `packages/shared/`, `packages/server/`, `packages/client/` code
- Any schema, rules, prediction, or server code

---

## Task 1: Import the font asset

**Files:**
- Create: `Monkey Punch/Assets/Fonts/PressStart2P-Regular.ttf`

- [ ] **Step 1: Download the font.**

  Open https://fonts.google.com/specimen/Press+Start+2P, click "Download family", extract the ZIP. The file is `PressStart2P-Regular.ttf` (license: OFL).

  Alternative if you have wget/curl:
  ```bash
  mkdir -p "Monkey Punch/Assets/Fonts"
  curl -L -o "Monkey Punch/Assets/Fonts/PressStart2P-Regular.ttf" \
    "https://github.com/google/fonts/raw/main/ofl/pressstart2p/PressStart2P-Regular.ttf"
  ```

- [ ] **Step 2: Place the .ttf at the path.**

  Copy/move the file to `Monkey Punch/Assets/Fonts/PressStart2P-Regular.ttf`. If `Monkey Punch/Assets/Fonts/` doesn't exist, create it.

- [ ] **Step 3: Let Unity import it.**

  Open Unity. Unity auto-imports the .ttf and generates `PressStart2P-Regular.ttf.meta`. In the Project window, click the imported font and confirm in the Inspector that it loaded without warnings.

- [ ] **Step 4: Commit.**

  ```bash
  git add "Monkey Punch/Assets/Fonts/PressStart2P-Regular.ttf" \
          "Monkey Punch/Assets/Fonts/PressStart2P-Regular.ttf.meta"
  git commit -m "chore(phase-8.4): import Press Start 2P font asset"
  ```

---

## Task 2: Create the `PanelSettings` asset (the scaling fix)

**Files:**
- Create: `Monkey Punch/Assets/UI/GameUI.panelsettings`

- [ ] **Step 1: Create the asset in Unity.**

  In Unity, right-click the `Assets/UI/` folder (create if missing) → `Create > UI Toolkit > Panel Settings Asset`. Name it `GameUI`.

- [ ] **Step 2: Configure scaling — the load-bearing settings.**

  Select `GameUI.panelsettings` in the Project window. In the Inspector, set:

  | Field                    | Value                       |
  |--------------------------|-----------------------------|
  | Target Display           | `Display 1`                 |
  | Scale Mode               | `Scale With Screen Size`    |
  | Screen Match Mode        | `Match Width Or Height`     |
  | **Reference Resolution** | **`1920 × 1080`**           |
  | **Match (0=W, 1=H)**     | **`1` (height)**            |
  | Sort Order               | `0`                         |
  | Clear Color              | unchecked (leave default)   |
  | Clear Depth & Stencil    | leave default               |

  These are the only settings that affect scaling behavior. Leave everything else at default.

- [ ] **Step 3: Save the scene and the asset.**

  `File > Save` in Unity.

- [ ] **Step 4: Commit.**

  ```bash
  git add "Monkey Punch/Assets/UI/GameUI.panelsettings" \
          "Monkey Punch/Assets/UI/GameUI.panelsettings.meta"
  git commit -m "chore(phase-8.4): add GameUI PanelSettings (ScaleWithScreenSize ref 1920x1080 match-height)"
  ```

---

## Task 3: Write the UXML visual tree

**Files:**
- Create: `Monkey Punch/Assets/UI/GameUI.uxml`

- [ ] **Step 1: Write the UXML file.**

  Create `Monkey Punch/Assets/UI/GameUI.uxml` with this exact content:

  ```xml
  <ui:UXML xmlns:ui="UnityEngine.UIElements" xmlns:uie="UnityEditor.UIElements"
           xsi="http://www.w3.org/2001/XMLSchema-instance"
           engine="UnityEngine.UIElements" editor="UnityEditor.UIElements"
           noNamespaceSchemaLocation="../../UIElementsSchema/UIElements.xsd"
           editor-extension-mode="False">
    <Style src="project://database/Assets/UI/GameUI.uss"/>

    <ui:VisualElement name="root" class="hud-root hidden" picking-mode="Ignore">

      <!-- Top-left stat row -->
      <ui:VisualElement name="hud-toprow" class="hud-toprow" picking-mode="Ignore">
        <ui:Label name="stat-time"  class="stat" text="⏱ 00:00"/>
        <ui:Label name="stat-kills" class="stat" text="💀 0"/>
      </ui:VisualElement>

      <!-- Top-center large time -->
      <ui:Label name="hud-time" class="hud-time" text="00:00" picking-mode="Ignore"/>

      <!-- Top-right level -->
      <ui:Label name="hud-level" class="hud-level" text="LV 1" picking-mode="Ignore"/>

      <!-- Left column: HP / XP / weapons / items -->
      <ui:VisualElement name="hud-leftcol" class="hud-leftcol" picking-mode="Ignore">
        <ui:VisualElement name="hud-hpbar" class="hud-hpbar">
          <ui:VisualElement name="hp-fill" class="fill hp"/>
          <ui:Label name="hp-text" text="0 / 0"/>
        </ui:VisualElement>
        <ui:VisualElement name="hud-xpbar" class="hud-xpbar">
          <ui:VisualElement name="xp-fill" class="fill xp"/>
        </ui:VisualElement>
        <ui:VisualElement name="weapons-grid" class="hud-invgrid weapons"/>
        <ui:VisualElement name="items-grid"   class="hud-invgrid items"/>
      </ui:VisualElement>

      <!-- Bottom-center level-up bar -->
      <ui:VisualElement name="lvlup-bar" class="lvlup-bar hidden" picking-mode="Ignore">
        <ui:VisualElement name="lvlup-prompt" class="lvlup-prompt">
          <ui:Label name="lvlup-prompt-text" class="pulse" text="LEVEL UP — PRESS 1/2/3"/>
          <ui:Label name="lvlup-timer" class="timer" text="AUTO 10s"/>
          <ui:Label name="lvlup-queue" class="queue hidden" text="+0 MORE"/>
        </ui:VisualElement>
        <ui:VisualElement name="lvlup-cards" class="lvlup-cards"/>
      </ui:VisualElement>

      <!-- Run-over modal (centered, dimmer over the whole screen) -->
      <ui:VisualElement name="runover" class="runover-modal hidden">
        <ui:VisualElement name="runover-dimmer" class="runover-dimmer"/>
        <ui:VisualElement name="runover-panel" class="runover-panel">
          <ui:Label  name="runover-title" class="runover-title" text="DEFEAT"/>
          <ui:Button name="runover-restart" class="runover-btn" text="RESTART"/>
        </ui:VisualElement>
      </ui:VisualElement>

    </ui:VisualElement>
  </ui:UXML>
  ```

  **Why `picking-mode="Ignore"` on most elements:** the HUD does not capture mouse clicks — only the run-over RESTART button and (later) the cards' transient interactions need clicks. Ignored elements pass clicks through to gameplay.

  **Why `class="hud-root hidden"`:** the HUD starts hidden until `SetHud(connected=true)` is called.

- [ ] **Step 2: Verify Unity parses it.**

  Open Unity. Select `GameUI.uxml` in the Project window. The Inspector's "Open in UI Builder" link should be available, and no parse errors should appear in the Console.

- [ ] **Step 3: Commit.**

  ```bash
  git add "Monkey Punch/Assets/UI/GameUI.uxml" "Monkey Punch/Assets/UI/GameUI.uxml.meta"
  git commit -m "chore(phase-8.4): add GameUI UXML visual tree skeleton"
  ```

---

## Task 4: Write the USS stylesheet

**Files:**
- Create: `Monkey Punch/Assets/UI/GameUI.uss`

- [ ] **Step 1: Write the stylesheet.**

  Create `Monkey Punch/Assets/UI/GameUI.uss` with this exact content:

  ```css
  /* ===== Tokens ===== */
  :root {
    --mp-gold:        rgb(255, 216, 96);
    --mp-dark:        rgba(40, 20, 10, 0.92);
    --mp-brown:       rgb(138, 90, 42);
    --mp-brown-deep:  rgb(58, 36, 16);
    --mp-hp-red:      rgb(240, 64, 48);
    --mp-hp-red-deep: rgb(192, 32, 24);
    --mp-xp-blue:     rgb(95, 184, 255);
    --mp-item-purple: rgb(216, 168, 255);
    --mp-shadow:      rgba(0, 0, 0, 0.85);
    --mp-bg-opaque:   rgba(0, 0, 0, 0.85);
  }

  /* ===== Root ===== */
  .hud-root {
    position: absolute;
    left: 0; right: 0; top: 0; bottom: 0;
    -unity-font-definition: url("project://database/Assets/Fonts/PressStart2P-Regular.ttf");
    color: rgb(255, 255, 255);
    -unity-text-outline-color: var(--mp-shadow);
    -unity-text-outline-width: 0;
  }
  .hidden { display: none; }

  /* Shared text shadow: applied via -unity-text-outline (Unity's UI Toolkit
     does not implement CSS text-shadow). The pixel-art "hard shadow" look
     is approximated with a 2px outline. */
  .stat, .hud-time, .hud-level, .hp-text, .runover-title,
  .lvlup-prompt-text, .lvlup-timer, .lvlup-queue,
  .lvlup-card-name, .lvlup-card-tag, .lvlup-card-sub, .lvlup-card-key {
    -unity-text-outline-color: var(--mp-shadow);
    -unity-text-outline-width: 1.5px;
  }

  /* ===== Top row (top-left small stats) ===== */
  .hud-toprow {
    position: absolute;
    top: 12px; left: 12px;
    flex-direction: row;
  }
  .stat {
    font-size: 14px;
    margin-right: 22px;
    color: rgb(255, 255, 255);
  }

  /* ===== Top-center large time ===== */
  .hud-time {
    position: absolute;
    top: 12px; left: 50%; translate: -50% 0;
    font-size: 28px;
  }

  /* ===== Top-right level ===== */
  .hud-level {
    position: absolute;
    top: 12px; right: 18px;
    font-size: 24px;
    letter-spacing: 1px;
  }

  /* ===== Left column ===== */
  .hud-leftcol {
    position: absolute;
    top: 52px; left: 12px;
  }
  .hud-hpbar {
    width: 220px; height: 26px;
    background-color: var(--mp-bg-opaque);
    border-color: rgb(26, 8, 8);
    border-width: 2px;
    flex-shrink: 0;
  }
  .hud-hpbar > .fill.hp {
    height: 100%;
    background-color: var(--mp-hp-red);
    width: 0%;
  }
  .hud-hpbar > Label {
    position: absolute;
    left: 0; right: 0; top: 0; bottom: 0;
    -unity-text-align: middle-center;
    font-size: 11px;
  }
  .hud-xpbar {
    width: 220px; height: 10px;
    margin-top: 4px;
    background-color: var(--mp-bg-opaque);
    border-color: rgb(26, 8, 8);
    border-width: 2px;
  }
  .hud-xpbar > .fill.xp {
    height: 100%;
    background-color: var(--mp-xp-blue);
    width: 0%;
  }

  /* ===== Inventory grid ===== */
  .hud-invgrid {
    margin-top: 8px;
    padding: 4px;
    background-color: rgba(50, 30, 15, 0.65);
    border-color: var(--mp-brown);
    border-width: 2px;
    flex-direction: row;
    flex-wrap: wrap;
    width: 168px;          /* 4 slots * 36 + 4 gaps * 3 */
  }
  .hud-invgrid.items {
    margin-top: 6px;
  }
  .hud-slot {
    width: 36px; height: 36px;
    margin: 1px 2px 1px 0;
    background-color: rgba(20, 10, 5, 0.7);
    border-color: var(--mp-brown-deep);
    border-width: 1px;
    align-items: center;
    justify-content: center;
  }
  .hud-slot.empty {
    background-color: rgba(20, 10, 5, 0.4);
  }
  .hud-slot > .glyph {
    font-size: 18px;
  }
  .hud-slot > .lvl {
    position: absolute;
    bottom: -2px; left: 1px;
    font-size: 9px;
  }

  /* ===== Level-up bar ===== */
  .lvlup-bar {
    position: absolute;
    bottom: 18px; left: 50%; translate: -50% 60px;
    opacity: 0;
    align-items: center;
    transition-property: translate, opacity;
    transition-duration: 150ms;
    transition-timing-function: ease-out;
  }
  .lvlup-bar.shown {
    translate: -50% 0;
    opacity: 1;
  }
  .lvlup-bar.downed {
    opacity: 0.55;
  }
  .lvlup-prompt {
    flex-direction: row;
    align-items: center;
    margin-bottom: 6px;
  }
  .lvlup-prompt-text {
    font-size: 13px;
    color: var(--mp-gold);
    letter-spacing: 2px;
    margin-right: 12px;
  }
  .pulse {
    transition-property: opacity;
    transition-duration: 700ms;
    /* Note: USS doesn't support infinite animations directly via the
       transition shorthand. The pulse effect is applied via C# by
       toggling a `.pulse-dim` class on a 700ms interval if needed.
       For MVP the static gold color is sufficient — leave the
       transition declaration above and skip the toggling. */
  }
  .lvlup-timer {
    font-size: 11px;
    background-color: rgba(0, 0, 0, 0.5);
    padding: 2px 6px;
    margin-right: 10px;
  }
  .lvlup-queue {
    font-size: 11px;
    background-color: var(--mp-hp-red-deep);
    padding: 2px 6px;
    letter-spacing: 1px;
  }
  .lvlup-cards {
    flex-direction: row;
  }
  .lvlup-card {
    width: 140px;
    margin: 0 4px;
    padding: 8px 8px 10px;
    background-color: var(--mp-dark);
    border-color: var(--mp-brown);
    border-width: 3px;
    align-items: center;
  }
  .lvlup-card.item {
    border-color: var(--mp-item-purple);
  }
  .lvlup-card-key {
    position: absolute;
    top: -10px; left: -10px;
    width: 22px; height: 22px;
    background-color: var(--mp-gold);
    color: rgb(42, 26, 8);
    border-color: rgb(0, 0, 0);
    border-width: 2px;
    -unity-text-align: middle-center;
    font-size: 12px;
  }
  .lvlup-card-tag {
    font-size: 8px;
    letter-spacing: 1px;
    opacity: 0.7;
    margin-bottom: 2px;
  }
  .lvlup-card-glyph {
    font-size: 22px;
    margin: 2px 0 6px 0;
  }
  .lvlup-card-name {
    font-size: 12px;
    color: var(--mp-gold);
    letter-spacing: 1px;
  }
  .lvlup-card.item .lvlup-card-name {
    color: var(--mp-item-purple);
  }
  .lvlup-card-sub {
    font-size: 8px;
    margin-top: 6px;
    -unity-text-align: middle-center;
    white-space: normal;
  }
  .lvlup-card.disabled {
    opacity: 0.4;
  }

  /* ===== Run-over modal ===== */
  .runover-modal {
    position: absolute;
    left: 0; right: 0; top: 0; bottom: 0;
    align-items: center;
    justify-content: center;
    transition-property: opacity;
    transition-duration: 200ms;
    opacity: 0;
  }
  .runover-modal.shown {
    opacity: 1;
  }
  .runover-dimmer {
    position: absolute;
    left: 0; right: 0; top: 0; bottom: 0;
    background-color: rgba(0, 0, 0, 0.55);
  }
  .runover-panel {
    background-color: var(--mp-dark);
    border-color: var(--mp-brown);
    border-width: 3px;
    padding: 22px 36px;
    align-items: center;
  }
  .runover-title {
    font-size: 26px;
    color: var(--mp-hp-red);
    letter-spacing: 2px;
    margin-bottom: 16px;
  }
  .runover-btn {
    padding: 8px 24px;
    background-color: var(--mp-gold);
    color: rgb(42, 26, 8);
    border-color: rgb(0, 0, 0);
    border-width: 2px;
    font-size: 13px;
    letter-spacing: 1px;
  }
  ```

- [ ] **Step 2: Verify Unity parses it.**

  In Unity, select `GameUI.uss`. The Inspector should show no parse errors. Open the Console window and confirm no USS warnings.

- [ ] **Step 3: Commit.**

  ```bash
  git add "Monkey Punch/Assets/UI/GameUI.uss" "Monkey Punch/Assets/UI/GameUI.uss.meta"
  git commit -m "chore(phase-8.4): add GameUI USS with Megabonk-style tokens, slide transitions"
  ```

---

## Task 5: Add the `UIDocument` GameObject to the scene

**Files:**
- Modify: the scene file that hosts `GameUI` today (likely `Monkey Punch/Assets/Scenes/SampleScene.unity` — verify in editor)

- [ ] **Step 1: Locate the GameUI host in the scene.**

  Open the main play scene in Unity (the one Phase 7 wired GameUI into). In the Hierarchy, find the GameObject that has the `GameUI.cs` component attached.

- [ ] **Step 2: Add a `UIDocument` component.**

  With that GameObject selected, in the Inspector click `Add Component > UI Toolkit > UI Document`.

  Set:
  - `Panel Settings` = `GameUI.panelsettings` (from Task 2)
  - `Source Asset`   = `GameUI.uxml` (from Task 3)
  - `Sort Order`     = `0`

- [ ] **Step 3: Hit Play (in the editor) and confirm the empty hidden HUD root exists.**

  Press Play in Unity. With nothing else done, the HUD root has the `hidden` class, so nothing should appear visually. Stop play.

- [ ] **Step 4: Commit the scene.**

  ```bash
  git add "Monkey Punch/Assets/Scenes/"
  git commit -m "chore(phase-8.4): attach UIDocument to GameUI host with PanelSettings + UXML"
  ```

  If the scene path differs, adjust the `git add` argument to the actual scene file.

---

## Task 6: Migrate `GameUI.cs` — strip IMGUI, add `UIDocument` field, cache element refs

**Files:**
- Modify: `Monkey Punch/Assets/Scripts/UI/GameUI.cs`
- Test: `Monkey Punch/Assets/Tests/Editor/GameUITest.cs` (new)

- [ ] **Step 1: Write the failing test for `FormatTime`.**

  Create `Monkey Punch/Assets/Tests/Editor/GameUITest.cs`:

  ```csharp
  using NUnit.Framework;
  using MonkeyPunch.UI;

  namespace MonkeyPunch.Tests.Editor {
    public class GameUITest {
      [Test]
      public void FormatTime_Zero_ReturnsZeroPadded() {
        Assert.AreEqual("00:00", GameUI.FormatTime(0.0));
      }

      [Test]
      public void FormatTime_OneMinuteTwentyOneSeconds_FormatsCorrectly() {
        Assert.AreEqual("01:21", GameUI.FormatTime(81.0));
      }

      [Test]
      public void FormatTime_NegativeClampsToZero() {
        Assert.AreEqual("00:00", GameUI.FormatTime(-5.0));
      }
    }
  }
  ```

  Note: `FormatTime` is currently `private static` in `GameUI.cs:292`. We'll promote it to `public static` so it's testable.

- [ ] **Step 2: Run tests to verify they fail.**

  In Unity: `Window > General > Test Runner`. Click "EditMode" tab. The `GameUITest` class should appear — click "Run All" or right-click → Run. Expected: tests FAIL with "FormatTime is inaccessible due to its protection level" (because the test asmdef can't see the private method yet).

  If the test class itself doesn't appear, you need an Editor asmdef. Create `Monkey Punch/Assets/Tests/Editor/MonkeyPunch.Tests.Editor.asmdef` with:

  ```json
  {
    "name": "MonkeyPunch.Tests.Editor",
    "rootNamespace": "MonkeyPunch.Tests.Editor",
    "references": [
      "GUID:27619889b8ba8c24980f49ee34dbb44a",
      "GUID:0acc523941302664db1f4e527237feb3"
    ],
    "includePlatforms": ["Editor"],
    "excludePlatforms": [],
    "allowUnsafeCode": false,
    "overrideReferences": true,
    "precompiledReferences": ["nunit.framework.dll"],
    "autoReferenced": false,
    "defineConstraints": ["UNITY_INCLUDE_TESTS"]
  }
  ```

  Then add a reference to the project asmdef that owns `GameUI.cs`. If `Monkey Punch/Assets/Scripts/MonkeyPunch.asmdef` (or similar) exists, add it to the `references` array as `"MonkeyPunch"`. If no asmdef exists in `Scripts/`, the test asmdef must reference `Assembly-CSharp` instead (remove `overrideReferences` and the GUID refs above; the test will see all default assemblies).

  Simplest config for a project with no Scripts asmdef:

  ```json
  {
    "name": "MonkeyPunch.Tests.Editor",
    "rootNamespace": "MonkeyPunch.Tests.Editor",
    "references": [],
    "includePlatforms": ["Editor"],
    "excludePlatforms": [],
    "allowUnsafeCode": false,
    "autoReferenced": false,
    "precompiledReferences": ["nunit.framework.dll"],
    "defineConstraints": ["UNITY_INCLUDE_TESTS"]
  }
  ```

  Re-run: now the test class should appear and FAIL on the assertion.

- [ ] **Step 3: Refactor `GameUI.cs` — strip IMGUI, add UIDocument field, promote `FormatTime`.**

  Replace the entire content of `Monkey Punch/Assets/Scripts/UI/GameUI.cs` with:

  ```csharp
  using System;
  using System.Collections.Generic;
  using UnityEngine;
  using UnityEngine.UIElements;

  namespace MonkeyPunch.UI {
    // Phase 8.4 (UI Toolkit migration): the IMGUI implementation is
    // gone. Public API (ShowLevelUp / HideLevelUp / ShowRunOver /
    // HideRunOver / SetHud) preserved as the migration boundary;
    // NetworkClient call sites do not change.
    //
    // Cursor management narrowed: only runOverVisible flips the
    // cursor. The level-up bar is non-modal — gameplay continues
    // while it is on screen and the player resolves it with the
    // 1/2/3 keyboard actions wired in Task 11.
    [RequireComponent(typeof(UIDocument))]
    public class GameUI : MonoBehaviour {
      public static GameUI Instance { get; private set; }

      // ----- HUD state DTOs (unchanged shape — NetworkClient still constructs these) -----

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
        public string Kind;    // "weapon" or "item"
        public int    Index;   // index into WEAPON_KINDS or ITEM_KINDS
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

      // Public for any caller that needs to know about modal foregrounding.
      // Cursor management is keyed only to runOverVisible (see RefreshCursorState).
      public bool AnyModalOpen => levelUpVisible || runOverVisible;

      // ----- UI Toolkit element refs (cached at OnEnable) -----

      private UIDocument doc;
      private VisualElement root;
      // Top-row
      private Label statTime;
      private Label statKills;
      private Label hudTime;
      private Label hudLevel;
      // Left col
      private VisualElement hpFill;
      private Label hpText;
      private VisualElement xpFill;
      private VisualElement weaponsGrid;
      private VisualElement itemsGrid;
      // Level-up bar
      private VisualElement lvlupBar;
      private Label lvlupPromptText;
      private Label lvlupTimer;
      private Label lvlupQueue;
      private VisualElement lvlupCards;
      // Run-over
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
        // OnEnable runs after every domain reload too; re-resolve element
        // refs so they stay valid across hot reloads.
        if (doc == null) doc = GetComponent<UIDocument>();
        root = doc.rootVisualElement.Q<VisualElement>("root");
        if (root == null) {
          Debug.LogError("[GameUI] UXML root 'root' not found — check GameUI.uxml is assigned to the UIDocument.");
          return;
        }
        statTime         = root.Q<Label>("stat-time");
        statKills        = root.Q<Label>("stat-kills");
        hudTime          = root.Q<Label>("hud-time");
        hudLevel         = root.Q<Label>("hud-level");
        hpFill           = root.Q<VisualElement>("hp-fill");
        hpText           = root.Q<Label>("hp-text");
        xpFill           = root.Q<VisualElement>("xp-fill");
        weaponsGrid      = root.Q<VisualElement>("weapons-grid");
        itemsGrid        = root.Q<VisualElement>("items-grid");
        lvlupBar         = root.Q<VisualElement>("lvlup-bar");
        lvlupPromptText  = root.Q<Label>("lvlup-prompt-text");
        lvlupTimer       = root.Q<Label>("lvlup-timer");
        lvlupQueue       = root.Q<Label>("lvlup-queue");
        lvlupCards       = root.Q<VisualElement>("lvlup-cards");
        runoverModal     = root.Q<VisualElement>("runover");
        runoverTitle     = root.Q<Label>("runover-title");
        runoverRestart   = root.Q<Button>("runover-restart");

        if (runoverRestart != null) {
          runoverRestart.clicked += OnRestartButtonClicked;
        }
      }

      void OnDisable() {
        if (runoverRestart != null) {
          runoverRestart.clicked -= OnRestartButtonClicked;
        }
      }

      // ----- Public API (migration boundary — keep names + signatures stable) -----

      public void SetHud(HudState s) {
        hud = s;
        if (root == null) return;
        // Visibility
        if (!hud.Connected) {
          root.AddToClassList("hidden");
          return;
        }
        root.RemoveFromClassList("hidden");

        // Wired in Task 7 (HUD bindings). Placeholder no-op for now so
        // the migration commit compiles and the smoke test passes.
      }

      public void ShowLevelUp(LevelUpChoiceDisplay[] choices, Action<int> onClick) {
        levelUpChoices = choices;
        onLevelUpClicked = onClick;
        levelUpVisible = true;
        RefreshCursorState();
        // Wired in Task 10. Placeholder for now.
      }

      public void HideLevelUp() {
        levelUpVisible = false;
        levelUpChoices = null;
        onLevelUpClicked = null;
        RefreshCursorState();
        // Wired in Task 10.
      }

      public void ShowRunOver(string reason, Action onRestart) {
        runOverReason = reason;
        onRestartClicked = onRestart;
        runOverVisible = true;
        RefreshCursorState();
        // Wired in Task 9.
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
          Cursor.lockState = CursorLockMode.None;
          Cursor.visible = true;
        } else {
          Cursor.lockState = CursorLockMode.Locked;
          Cursor.visible = false;
        }
      }

      // ----- Pure helper (promoted to public static for testability) -----

      public static string FormatTime(double seconds) {
        if (seconds < 0) seconds = 0;
        int total = (int)seconds;
        int m = total / 60;
        int s = total % 60;
        return $"{m:00}:{s:00}";
      }
    }
  }
  ```

  This is a wholesale replacement of `GameUI.cs`. The IMGUI code (lines 132–290 of the original) is gone. The struct definitions, modal state, and cursor logic are preserved. `FormatTime` is now `public static`.

- [ ] **Step 4: Run tests to verify they pass.**

  In Unity Test Runner: re-run `GameUITest`. Expected: all 3 tests PASS.

- [ ] **Step 5: Verify the project still compiles.**

  Look at the Unity Console. No compile errors. The `NetworkClient.cs` call sites referenced at line 349 / 367 / 855 / 871 / 882 / 890 still resolve because the API names + struct names are unchanged.

- [ ] **Step 6: Hit Play and confirm no exceptions.**

  Press Play. The HUD root has `hidden` class so nothing visible. Confirm no exceptions in the Console.

- [ ] **Step 7: Commit.**

  ```bash
  git add "Monkey Punch/Assets/Scripts/UI/GameUI.cs" \
          "Monkey Punch/Assets/Tests/Editor/"
  git commit -m "feat(phase-8.4): migrate GameUI to UI Toolkit — strip IMGUI, cache element refs

Public API (ShowLevelUp/HideLevelUp/ShowRunOver/SetHud) preserved.
NetworkClient call sites unchanged. RefreshCursorState narrowed to
runOverVisible only — the level-up bar will be non-modal.

Element bindings stubbed; subsequent tasks wire SetHud, run-over,
and the level-up bar."
  ```

---

## Task 7: Wire `SetHud` → HUD element bindings (HP, XP, time, level, kills, top-row)

**Files:**
- Modify: `Monkey Punch/Assets/Scripts/UI/GameUI.cs`
- Test: `Monkey Punch/Assets/Tests/Runtime/GameUIPlayModeTest.cs` (new)

- [ ] **Step 1: Create the PlayMode test asmdef and file.**

  Create `Monkey Punch/Assets/Tests/Runtime/MonkeyPunch.Tests.Runtime.asmdef`:

  ```json
  {
    "name": "MonkeyPunch.Tests.Runtime",
    "rootNamespace": "MonkeyPunch.Tests.Runtime",
    "references": [],
    "includePlatforms": [],
    "excludePlatforms": [],
    "allowUnsafeCode": false,
    "autoReferenced": false,
    "precompiledReferences": ["nunit.framework.dll"],
    "defineConstraints": ["UNITY_INCLUDE_TESTS"]
  }
  ```

  Create `Monkey Punch/Assets/Tests/Runtime/GameUIPlayModeTest.cs`:

  ```csharp
  using System.Collections;
  using System.Collections.Generic;
  using NUnit.Framework;
  using UnityEngine;
  using UnityEngine.TestTools;
  using UnityEngine.UIElements;
  using MonkeyPunch.UI;

  namespace MonkeyPunch.Tests.Runtime {
    public class GameUIPlayModeTest {
      // The test loads the existing GameUI prefab/scene-object pattern by
      // instantiating a GameObject with a UIDocument that references the
      // production GameUI.uxml + GameUI.panelsettings, then adding the
      // GameUI component. If your scene wiring puts GameUI on a prefab
      // instead, load that prefab here.

      private GameObject host;
      private GameUI gameUI;

      [UnitySetUp]
      public IEnumerator SetUp() {
        host = new GameObject("GameUI_test_host");
        var doc = host.AddComponent<UIDocument>();
        doc.panelSettings = (UnityEngine.UIElements.PanelSettings)
          Resources.LoadAssetAtPath_or_DB("Assets/UI/GameUI.panelsettings");
        doc.visualTreeAsset = (UnityEngine.UIElements.VisualTreeAsset)
          Resources.LoadAssetAtPath_or_DB("Assets/UI/GameUI.uxml");
        gameUI = host.AddComponent<GameUI>();
        yield return null; // let Awake/OnEnable run
      }

      [UnityTearDown]
      public IEnumerator TearDown() {
        Object.Destroy(host);
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
        Assert.AreEqual("03:21",   root.Q<Label>("hud-time").text);
        Assert.AreEqual("LV 4",    root.Q<Label>("hud-level").text);
        Assert.AreEqual("70 / 100", root.Q<Label>("hp-text").text);
        Assert.IsTrue(root.Q<Label>("stat-time").text.Contains("03:21"));
        Assert.IsTrue(root.Q<Label>("stat-kills").text.Contains("142"));
      }
    }
  }
  ```

  **Note on `Resources.LoadAssetAtPath_or_DB`:** that's a placeholder. The two practical asset-loading paths in PlayMode tests are:
  - `UnityEditor.AssetDatabase.LoadAssetAtPath<PanelSettings>("Assets/UI/GameUI.panelsettings")` — works only when the assembly is editor-only
  - For a PlayMode test that needs to run in non-editor builds, move the assets to `Assets/Resources/` and use `Resources.Load<PanelSettings>("GameUI")`

  Since this is a smoke test that only runs in the Unity Editor (it's developer-facing, not a player-facing test), use `AssetDatabase`. The asmdef needs `UnityEditor.dll` reference and the test class must be guarded by `#if UNITY_EDITOR`.

  Replace the body of `GameUIPlayModeTest.cs` with this corrected version:

  ```csharp
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
        doc.panelSettings = AssetDatabase.LoadAssetAtPath<PanelSettings>("Assets/UI/GameUI.panelsettings");
        doc.visualTreeAsset = AssetDatabase.LoadAssetAtPath<VisualTreeAsset>("Assets/UI/GameUI.uxml");
        Assert.IsNotNull(doc.panelSettings, "PanelSettings asset not found.");
        Assert.IsNotNull(doc.visualTreeAsset, "VisualTreeAsset not found.");
        gameUI = host.AddComponent<GameUI>();
        yield return null;
      }

      [UnityTearDown]
      public IEnumerator TearDown() {
        Object.Destroy(host);
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
  ```

  Update the asmdef to include the Editor reference. Edit `MonkeyPunch.Tests.Runtime.asmdef` to add `"includePlatforms": ["Editor"]`:

  ```json
  {
    "name": "MonkeyPunch.Tests.Runtime",
    "rootNamespace": "MonkeyPunch.Tests.Runtime",
    "references": [],
    "includePlatforms": ["Editor"],
    "excludePlatforms": [],
    "allowUnsafeCode": false,
    "autoReferenced": false,
    "precompiledReferences": ["nunit.framework.dll"],
    "defineConstraints": ["UNITY_INCLUDE_TESTS"]
  }
  ```

- [ ] **Step 2: Run the test to verify it fails.**

  In Unity Test Runner, switch to "PlayMode" tab. Run `SetHud_PopulatesAllTextBindings`. Expected: FAIL — text values are still UXML defaults ("00:00" matches actually, "LV 1" not "LV 4", "0 / 0" not "70 / 100").

- [ ] **Step 3: Implement the bindings inside `SetHud`.**

  In `GameUI.cs`, replace the placeholder in `SetHud` with the actual binding logic. Replace the `SetHud` method body:

  ```csharp
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
  ```

- [ ] **Step 4: Re-run the test to verify it passes.**

  In Unity Test Runner: re-run `SetHud_PopulatesAllTextBindings`. Expected: PASS.

- [ ] **Step 5: Commit.**

  ```bash
  git add "Monkey Punch/Assets/Scripts/UI/GameUI.cs" \
          "Monkey Punch/Assets/Tests/Runtime/"
  git commit -m "feat(phase-8.4): wire SetHud bindings — HP/XP bars, time, level, top-row stats"
  ```

---

## Task 8: Inventory grid rendering — weapons + items

**Files:**
- Modify: `Monkey Punch/Assets/Scripts/UI/Names.cs`
- Modify: `Monkey Punch/Assets/Scripts/UI/GameUI.cs`
- Modify: `Monkey Punch/Assets/Tests/Editor/GameUITest.cs`

- [ ] **Step 1: Read the existing `Names.cs` to confirm `WeaponName` + `ItemName` signatures.**

  ```bash
  # Sanity check:
  cat "Monkey Punch/Assets/Scripts/UI/Names.cs"
  ```

  Confirm there is a `public static string WeaponName(byte kind)` and a `public static string ItemName(byte kind)`. If signatures differ, adjust the calls in Step 3 accordingly.

- [ ] **Step 2: Write the failing test for glyph lookup.**

  Add to `Monkey Punch/Assets/Tests/Editor/GameUITest.cs`:

  ```csharp
  [Test]
  public void ItemGlyph_DamageMult_ReturnsFireEmoji() {
    // damage_mult is ItemEffect index 0 in the web client's enum;
    // the byte sent over the wire matches that ordering. Adjust if
    // Unity-side decoding differs.
    Assert.AreEqual("🔥", Names.ItemGlyph(0));
  }

  [Test]
  public void WeaponGlyph_UnknownKind_ReturnsQuestionMark() {
    Assert.AreEqual("?", Names.WeaponGlyph(255));
  }
  ```

  Add `using MonkeyPunch.UI;` at the top if it isn't there already.

- [ ] **Step 3: Run tests to verify they fail.**

  Expected: FAIL — `Names.ItemGlyph` doesn't exist yet.

- [ ] **Step 4: Implement `WeaponGlyph` + `ItemGlyph` in `Names.cs`.**

  Append to `Monkey Punch/Assets/Scripts/UI/Names.cs` (inside the `MonkeyPunch.UI` namespace and the `Names` class):

  ```csharp
  // Item effect → glyph map. Indices match ItemEffect enum order on the
  // shared/items.ts side: 0=damage_mult, 1=cooldown_mult, 2=max_hp_mult,
  // 3=speed_mult, 4=magnet_mult, 5=xp_mult.
  // Mirrors the web client's ITEM_ICONS map in packages/client/src/game/LevelUpOverlay.tsx.
  public static string ItemGlyph(byte kind) {
    switch (kind) {
      case 0: return "🔥";  // Ifrit's Talisman   (damage_mult)
      case 1: return "⚡";  // Wind of Verdure    (cooldown_mult)
      case 2: return "❤";   // Apple of Idun      (max_hp_mult)
      case 3: return "🥾";  // Sleipnir           (speed_mult)
      case 4: return "🔍";  // Magnifier          (magnet_mult)
      case 5: return "🐰";  // Bunny Top Hat      (xp_mult)
      default: return "?";
    }
  }

  // Weapon kind → glyph. Mapped 1:1 with WEAPON_KINDS order in the
  // shared/weapons.ts table. Adjust as that table evolves.
  public static string WeaponGlyph(byte kind) {
    switch (kind) {
      case 0: return "⚡";  // Bolt        (projectile)
      case 1: return "🏹";  // Gakkung Bow (projectile)
      case 2: return "🔱";  // Ahlspiess   (projectile)
      case 3: return "🌀";  // Orbit       (orbit)
      case 4: return "⚔";   // Damascus    (melee_arc)
      case 5: return "🛡";  // Claymore    (melee_arc)
      case 6: return "✨";  // Kronos      (aura)
      case 7: return "🪓";  // Bloody Axe  (boomerang)
      default: return "?";
    }
  }
  ```

  Note the use of `switch` rather than a name lookup — CLAUDE.md rule 12 prohibits name-based dispatch.

- [ ] **Step 5: Re-run tests to verify they pass.**

  Expected: PASS for both new glyph tests.

- [ ] **Step 6: Implement inventory grid rendering in `GameUI.cs`.**

  In `GameUI.cs`, replace the placeholder comment `// Inventory grids — Task 8 owns this. Leave empty for now.` at the bottom of `SetHud` with:

  ```csharp
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
  ```

  (Closing brace of `SetHud` is the line above the `private void` declaration — the existing brace stays.)

  The generic + cast pattern avoids two copies of the loop. The non-generic dispatch on `isWeapon` lives at the bottom so the rest stays DRY.

- [ ] **Step 7: Add a PlayMode test for inventory rendering.**

  Append to `GameUIPlayModeTest.cs`:

  ```csharp
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
  ```

- [ ] **Step 8: Run the PlayMode test, verify it passes.**

  Expected: PASS.

- [ ] **Step 9: Commit.**

  ```bash
  git add "Monkey Punch/Assets/Scripts/UI/Names.cs" \
          "Monkey Punch/Assets/Scripts/UI/GameUI.cs" \
          "Monkey Punch/Assets/Tests/"
  git commit -m "feat(phase-8.4): inventory grid + glyph lookups in Names.cs

Renders 8 weapon slots + 8 item slots populated from HudState. Empty
slots get .empty class. Glyph dispatch is kind-keyed (rule 12 clean).
Web-client item glyph parity (🔥⚡❤🥾🔍🐰)."
  ```

---

## Task 9: Run-over modal — wire `ShowRunOver` / `HideRunOver` to UXML

**Files:**
- Modify: `Monkey Punch/Assets/Scripts/UI/GameUI.cs`
- Test: `Monkey Punch/Assets/Tests/Runtime/GameUIPlayModeTest.cs`

- [ ] **Step 1: Write the failing test.**

  Append to `GameUIPlayModeTest.cs`:

  ```csharp
  [UnityTest]
  public IEnumerator ShowRunOver_RemovesHiddenClassAndSetsTitle() {
    bool restartCalled = false;
    gameUI.ShowRunOver("DEFEAT", () => restartCalled = true);
    yield return null;

    var root = gameUI.GetComponent<UIDocument>().rootVisualElement;
    var modal = root.Q<VisualElement>("runover");
    Assert.IsFalse(modal.ClassListContains("hidden"));
    Assert.AreEqual("DEFEAT", root.Q<Label>("runover-title").text);

    gameUI.HideRunOver();
    yield return null;
    Assert.IsTrue(modal.ClassListContains("hidden"));
    Assert.IsFalse(restartCalled); // HideRunOver does not invoke the callback
  }
  ```

- [ ] **Step 2: Run, verify it fails.**

  Expected: FAIL — `runover-title` text is still "DEFEAT" by accident (UXML default), but `modal.ClassListContains("hidden")` is true (modal is hidden). The first assertion fails because `ShowRunOver` doesn't remove the `hidden` class yet.

- [ ] **Step 3: Wire `ShowRunOver` / `HideRunOver` in `GameUI.cs`.**

  Replace the body of `ShowRunOver` and `HideRunOver`:

  ```csharp
  public void ShowRunOver(string reason, Action onRestart) {
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
  ```

  `schedule.Execute(...).ExecuteLater(ms)` is UI Toolkit's frame-aware delay — it runs the callback after the given milliseconds on the panel's update loop, so it follows the panel's enable state correctly.

- [ ] **Step 4: Re-run the test, verify it passes.**

  Expected: PASS.

- [ ] **Step 5: Commit.**

  ```bash
  git add "Monkey Punch/Assets/Scripts/UI/GameUI.cs" \
          "Monkey Punch/Assets/Tests/Runtime/GameUIPlayModeTest.cs"
  git commit -m "feat(phase-8.4): wire run-over modal to UXML with 200ms fade"
  ```

---

## Task 10: Level-up bar — cards rendering, queue badge, downed state

**Files:**
- Modify: `Monkey Punch/Assets/Scripts/UI/GameUI.cs`
- Test: `Monkey Punch/Assets/Tests/Runtime/GameUIPlayModeTest.cs`

- [ ] **Step 1: Write the failing test.**

  Append to `GameUIPlayModeTest.cs`:

  ```csharp
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
    yield return new WaitForSeconds(0.2f); // wait for fade
    Assert.IsTrue(bar.ClassListContains("hidden"));
    Assert.AreEqual(-1, picked); // HideLevelUp does not invoke callback
  }
  ```

- [ ] **Step 2: Run, verify it fails.**

  Expected: FAIL — `cards.childCount == 0` because `ShowLevelUp` is still the stub.

- [ ] **Step 3: Implement card rendering in `ShowLevelUp` / `HideLevelUp`.**

  Replace `ShowLevelUp`, `HideLevelUp`, and add helper methods in `GameUI.cs`:

  ```csharp
  public void ShowLevelUp(LevelUpChoiceDisplay[] choices, Action<int> onClick) {
    levelUpChoices = choices;
    onLevelUpClicked = onClick;
    levelUpVisible = true;
    RefreshCursorState();
    if (lvlupBar == null) return;

    BuildLevelUpCards(choices);
    lvlupBar.RemoveFromClassList("hidden");
    lvlupBar.schedule.Execute(() => lvlupBar.AddToClassList("shown")).ExecuteLater(16);
  }

  public void HideLevelUp() {
    levelUpVisible = false;
    levelUpChoices = null;
    onLevelUpClicked = null;
    RefreshCursorState();
    if (lvlupBar == null) return;
    lvlupBar.RemoveFromClassList("shown");
    lvlupBar.schedule.Execute(() => lvlupBar.AddToClassList("hidden")).ExecuteLater(170);
  }

  private void BuildLevelUpCards(LevelUpChoiceDisplay[] choices) {
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
          ? Names.ItemGlyph((byte)c.Index)
          : Names.WeaponGlyph((byte)c.Index),
      };
      glyph.AddToClassList("lvlup-card-glyph");
      card.Add(glyph);

      var name = new Label { text = c.Name ?? "?" };
      name.AddToClassList("lvlup-card-name");
      card.Add(name);

      var sub = new Label { text = "LV " + c.NewLevel.ToString() };
      sub.AddToClassList("lvlup-card-sub");
      card.Add(sub);

      lvlupCards.Add(card);
    }

    // Queue badge: "+N MORE" if more than 1 offer pending. The current
    // API receives one offer at a time, so this stays hidden until the
    // caller surfaces a pending count via a separate code path. For
    // MVP, hide it; richer queue rendering is left to a follow-up.
    if (lvlupQueue != null) lvlupQueue.AddToClassList("hidden");
  }
  ```

  Note: dispatch on `c.Kind` here is string-based ("item" vs "weapon"), inherited from the existing `LevelUpChoiceDisplay.Kind` shape. This is **not** a CLAUDE.md rule 12 violation — `Kind` is a discriminator type, not a weapon/item name. The actual glyph + tag lookup is keyed on `Index`, which is the kind enum byte.

- [ ] **Step 4: Re-run the test, verify it passes.**

  Expected: PASS.

- [ ] **Step 5: Add a downed-state test.**

  Append:

  ```csharp
  [UnityTest]
  public IEnumerator SetHud_LevelUpOpenAndDowned_AppliesDownedClass() {
    var choices = new GameUI.LevelUpChoiceDisplay[] {
      new GameUI.LevelUpChoiceDisplay { Kind = "weapon", Index = 0, Name = "BOLT", NewLevel = 2 },
    };
    gameUI.ShowLevelUp(choices, _ => {});
    gameUI.SetHud(new GameUI.HudState {
      Connected = true,
      Hp = 0, MaxHp = 100,
      Weapons = new List<GameUI.HudWeaponEntry>(),
      Items   = new List<GameUI.HudItemEntry>(),
      // Note: HudState doesn't carry a Downed flag today. SetDownedState
      // is the proper public surface (see Step 6).
    });
    gameUI.SetDownedState(true);
    yield return null;

    var bar = gameUI.GetComponent<UIDocument>().rootVisualElement.Q<VisualElement>("lvlup-bar");
    Assert.IsTrue(bar.ClassListContains("downed"));

    gameUI.SetDownedState(false);
    yield return null;
    Assert.IsFalse(bar.ClassListContains("downed"));
  }
  ```

- [ ] **Step 6: Add `SetDownedState` public surface.**

  Add to `GameUI.cs` (next to `SetHud`):

  ```csharp
  /// <summary>
  /// Called by NetworkClient when Player.downed flips. Toggles the
  /// .downed class on the level-up bar so cards grey out. Auto-pick
  /// continues to fire from the server's tickLevelUpDeadlines, so we
  /// don't need to skip the keyboard handler — just give the player
  /// a visual hint that the offer is on a deadline.
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
  ```

  Wiring `SetDownedState` from `NetworkClient` is one line — `GameUI.Instance.SetDownedState(localPlayer.downed)` should be added near the existing `SetHud` call site at `NetworkClient.cs:890`. Add that line:

  ```csharp
  GameUI.Instance.SetHud(s);
  GameUI.Instance.SetDownedState(localPlayer != null && localPlayer.downed);
  ```

- [ ] **Step 7: Re-run the downed test, verify it passes.**

  Expected: PASS.

- [ ] **Step 8: Commit.**

  ```bash
  git add "Monkey Punch/Assets/Scripts/UI/GameUI.cs" \
          "Monkey Punch/Assets/Scripts/Net/NetworkClient.cs" \
          "Monkey Punch/Assets/Tests/Runtime/GameUIPlayModeTest.cs"
  git commit -m "feat(phase-8.4): level-up bar — cards, glyphs, downed state

Cards built from LevelUpChoiceDisplay[]. Item cards get the .item
class. SetDownedState toggles .downed and swaps the prompt text.
Auto-pick deadline rendering follows in Task 12."
  ```

---

## Task 11: Level-up bar — Input System actions for 1/2/3 keys

**Files:**
- Modify: `Monkey Punch/Assets/InputSystem_Actions.inputactions`
- Modify: `Monkey Punch/Assets/Scripts/UI/GameUI.cs`

- [ ] **Step 1: Add a new action map in the Input Actions asset.**

  In Unity, double-click `InputSystem_Actions.inputactions` to open the Input Actions editor.

  Click the `+` button in the "Action Maps" pane. Name the new map `LevelUp`.

  With `LevelUp` selected, click `+` in the "Actions" pane three times, naming them `Pick1`, `Pick2`, `Pick3`. For each:

  | Action  | Type    | Expected Control Type | Binding             |
  |---------|---------|-----------------------|---------------------|
  | `Pick1` | Button  | Button                | `<Keyboard>/1`      |
  | `Pick2` | Button  | Button                | `<Keyboard>/2`      |
  | `Pick3` | Button  | Button                | `<Keyboard>/3`      |

  Save the asset (`Save Asset` button in the editor toolbar).

- [ ] **Step 2: Subscribe to the actions in `GameUI.cs`.**

  Add to `GameUI.cs`:
  - Top of file: `using UnityEngine.InputSystem;`
  - Field block:
    ```csharp
    [Header("Input")]
    [SerializeField] private InputActionAsset inputActions;
    private InputAction pick1, pick2, pick3;
    ```
  - In `OnEnable`, after the element refs are cached:
    ```csharp
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
    ```
  - In `OnDisable`:
    ```csharp
    if (pick1 != null) pick1.performed -= OnPick1;
    if (pick2 != null) pick2.performed -= OnPick2;
    if (pick3 != null) pick3.performed -= OnPick3;
    DisableLevelUpActions();
    ```
  - In `ShowLevelUp`, after `RefreshCursorState()`:
    ```csharp
    EnableLevelUpActions();
    ```
  - In `HideLevelUp`, after `RefreshCursorState()`:
    ```csharp
    DisableLevelUpActions();
    ```
  - New private helpers:
    ```csharp
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
      var cb = onLevelUpClicked;
      HideLevelUp();
      cb?.Invoke(idx);
    }
    ```

- [ ] **Step 3: Assign the InputActionAsset in the Inspector.**

  Open the scene. Select the GameObject hosting the `GameUI` component. In the Inspector, drag `InputSystem_Actions.inputactions` from the Project window into the new `Input Actions` field on the GameUI component.

- [ ] **Step 4: Manual playtest — confirm keyboard pick works.**

  Run the existing dev hotkey that forces a level-up offer (recent commits show damage-self and similar dev keys exist — look in `NetworkClient.cs` or `input.ts`-equivalent for the binding). Trigger a level-up. Confirm:
  - Bar slides up bottom-center.
  - Cursor stays locked. Camera continues to follow mouse.
  - Pressing `1`, `2`, or `3` selects the corresponding card; bar fades out; the chosen weapon/item appears in the inventory grid.

  If keys do nothing: check the Console for "Input action map 'LevelUp' not found", or confirm the InputActionAsset is assigned in the Inspector.

- [ ] **Step 5: Commit.**

  ```bash
  git add "Monkey Punch/Assets/InputSystem_Actions.inputactions" \
          "Monkey Punch/Assets/InputSystem_Actions.inputactions.meta" \
          "Monkey Punch/Assets/Scripts/UI/GameUI.cs" \
          "Monkey Punch/Assets/Scenes/"
  git commit -m "feat(phase-8.4): keyboard 1/2/3 pick for level-up bar via Input System

Adds a LevelUp action map with Pick1/2/3 bindings. GameUI enables
actions on ShowLevelUp, disables on HideLevelUp. Cursor stays
locked — gameplay never pauses."
  ```

---

## Task 12: Level-up countdown + queue rendering

**Files:**
- Modify: `Monkey Punch/Assets/Scripts/UI/GameUI.cs`
- Modify: `Monkey Punch/Assets/Scripts/Net/NetworkClient.cs`

- [ ] **Step 1: Add a `SetLevelUpTimer(double secondsRemaining, int queueCount)` public method.**

  In `GameUI.cs`, add (near `SetDownedState`):

  ```csharp
  /// <summary>
  /// Called by NetworkClient each frame while the level-up bar is open.
  /// `secondsRemaining` is computed from `Player.levelUpDeadline - state.tick`
  /// times SIM_DT_S on the caller side. `queueCount` is the total
  /// pending offers in Player.levelUpChoices; the badge shows +N MORE
  /// when count > 1 (the current offer is the first; the rest are queued).
  /// </summary>
  public void SetLevelUpTimer(double secondsRemaining, int queueCount) {
    if (lvlupTimer == null) return;
    int wholeSeconds = Mathf.CeilToInt((float)Mathf.Max(0f, (float)secondsRemaining));
    lvlupTimer.text = "AUTO " + wholeSeconds.ToString() + "s";

    if (lvlupQueue != null) {
      if (queueCount > 1) {
        lvlupQueue.RemoveFromClassList("hidden");
        lvlupQueue.text = "+" + (queueCount - 1).ToString() + " MORE";
      } else {
        lvlupQueue.AddToClassList("hidden");
      }
    }
  }
  ```

- [ ] **Step 2: Call `SetLevelUpTimer` from `NetworkClient`.**

  Find the level-up offer handler in `NetworkClient.cs` (around line 349) and the per-frame state-push site (around line 855). Add a per-frame timer update near the SetHud call:

  ```csharp
  // After GameUI.Instance.SetHud(s); — Task 10 already added SetDownedState here too.
  if (GameUI.Instance.LevelUpOpen && localPlayer != null && room?.State != null) {
    int deadlineTick = localPlayer.levelUpDeadline;
    int currentTick  = room.State.tick; // adjust field name if RoomState uses a different one
    double secondsRemaining = Math.Max(0, deadlineTick - currentTick) * 0.05; // SIM_DT_S
    int queueCount = localPlayer.levelUpChoices?.Count ?? 0;
    GameUI.Instance.SetLevelUpTimer(secondsRemaining, queueCount);
  }
  ```

  Verify field names by reading the schema: `Player.levelUpDeadline` and `RoomState.tick` must be the actual schema names. Adjust if the project uses different names.

- [ ] **Step 3: Manual playtest — countdown ticks.**

  Trigger a level-up via the dev hotkey. Confirm:
  - "AUTO 10s" (or whatever the default deadline is) counts down each second.
  - At 0, the server auto-picks; the bar fades.

- [ ] **Step 4: Manual playtest — queue badge.**

  Configure XP rewards to be large enough that multiple gems queue level-ups, or call the dev hotkey twice in quick succession. Confirm:
  - "+1 MORE" appears next to the timer.
  - After picking the first offer, the badge disappears and the next offer renders.

- [ ] **Step 5: Commit.**

  ```bash
  git add "Monkey Punch/Assets/Scripts/UI/GameUI.cs" \
          "Monkey Punch/Assets/Scripts/Net/NetworkClient.cs"
  git commit -m "feat(phase-8.4): level-up auto-pick countdown + queue indicator

Renders levelUpDeadline as ticking seconds. Shows +N MORE when
Player.levelUpChoices stacks queued offers."
  ```

---

## Task 13: Resolution verification + manual playtest checklist

**Files:**
- No code changes. This task verifies the spec's testing section is satisfied.

- [ ] **Step 1: Switch Unity Game View to each target resolution.**

  In the Unity Editor, open the Game view tab. Click the resolution dropdown at the top-left of the Game view. Add custom resolutions if needed: 1920×1080, 3440×1440, 2560×1440, 1366×768. For each:

  Walk through these checks and tick each one:
  - [ ] HUD top-left stat row (clock+time, skull+kills) anchored, not clipping.
  - [ ] HUD top-center elapsed time visible, centered, readable size.
  - [ ] HUD top-right level visible, anchored, not clipping.
  - [ ] HUD left HP bar + XP bar + inventory grids visible, anchored, not clipping.
  - [ ] Trigger level-up via dev hotkey. Bar appears bottom-center, all 3 cards visible, key badges readable.
  - [ ] Cards do not overflow horizontally at 1366×768 (smallest target).
  - [ ] At 3440×1440 ultrawide, the bar stays centered (extra horizontal space sits to the sides).
  - [ ] Trigger run-over (e.g., damage-self past 0 HP). Modal centers, button readable.

- [ ] **Step 2: Manual playtest scenarios.**

  Run through each scenario from the spec section 5.3. Tick when verified:
  - [ ] Pickup XP gem → bar slides up bottom-center over ~150ms.
  - [ ] During bar visible: cursor stays locked, camera continues following mouse, can still strafe / shoot.
  - [ ] Press `1` → bar fades, picked weapon level increments in inventory slot, `level_up_resolved` event in Console.
  - [ ] Don't press anything → countdown reaches 0 → server auto-picks → bar fades.
  - [ ] Get downed during bar visible → cards grey, prompt switches to "REVIVE TO PICK", countdown continues, auto-pick fires.
  - [ ] Pickup multiple gems back-to-back → "+1 MORE" badge appears, after pick the next offer renders.
  - [ ] Die fully → run-over modal overlays, cursor unlocks, RESTART button works.
  - [ ] Alt+Enter to fullscreen and back → UI reflows automatically with no exceptions.

- [ ] **Step 3: Verify migration boundary held.**

  ```bash
  # Confirm we changed only what the spec said we'd change in NetworkClient:
  git diff main -- "Monkey Punch/Assets/Scripts/Net/NetworkClient.cs"
  ```

  Expected: only **two** added lines — `GameUI.Instance.SetDownedState(...)` (Task 10) and `GameUI.Instance.SetLevelUpTimer(...)` block (Task 12). No other behavior change.

- [ ] **Step 4: Run all tests one more time.**

  In Unity Test Runner: run EditMode and PlayMode suites. Expected: all green.

- [ ] **Step 5: Final commit if any docs/checklists landed on disk.**

  ```bash
  # If you tracked the checklist in a temp file, delete or commit it.
  # Most likely there's nothing to commit at this step.
  git status
  ```

  If clean: skip the commit. If there are stray test fixtures or notes you want to keep, add them under `docs/superpowers/notes/` and commit.

- [ ] **Step 6: Close the milestone.**

  Append one line to `progress.txt`:

  ```
  [YYYY-MM-DD HH:MM] phase-8.4 UI Toolkit migration + resolution-aware scaling — done. IMGUI HUD replaced with UI Toolkit (UXML + USS + PanelSettings ScaleWithScreenSize match-height=1.0 ref 1920x1080). Megabonk-styled with Press Start 2P + emoji glyph placeholders. Level-up moved to non-modal bottom-center bar driven by 1/2/3 Input System actions; cursor stays locked during pick (RefreshCursorState narrowed to runOverVisible). Inventory grid replaces comma-joined string. Run-over stays a centered modal. Public API unchanged (ShowLevelUp/HideLevelUp/ShowRunOver/SetHud); NetworkClient gained two lines (SetDownedState + SetLevelUpTimer). Tests: 3 EditMode (FormatTime + glyphs), 4 PlayMode (SetHud bindings, inventory grid, run-over modal, level-up cards + downed). Resolution sweep passed at 1920x1080, 3440x1440, 2560x1440, 1366x768.
  ```

  ```bash
  git add progress.txt
  git commit -m "docs(phase-8.4): close UI Toolkit migration milestone"
  ```

---

## Plan self-review

Spec coverage check, by spec section:

- **Section 1 (Scope and intent)** — non-modal level-up + inventory grid + Megabonk styling: Tasks 8, 10, 11 cover.
- **Section 2.1 (Asset layout)** — Tasks 1, 2, 3, 4 create each file.
- **Section 2.2 (PanelSettings configuration — the scaling fix)** — Task 2 sets each row of the table.
- **Section 2.3 (GameUI.cs becomes a thin controller)** — Task 6 strips IMGUI, narrows `RefreshCursorState`.
- **Section 2.4 (Visual tree UXML)** — Task 3 ships the tree with the exact named elements.
- **Section 2.5 (USS styling)** — Task 4 ships tokens, fonts, bars, grid, level-up bar, run-over modal.
- **Section 2.6 (Animation spec — bar slide-up + fade)** — Task 4's `.lvlup-bar` transition + Task 10's `.shown` toggle.
- **Section 3.1 (Per-frame HUD update)** — Task 7's `SetHud` rewrite (cached refs at OnEnable).
- **Section 3.2 (Level-up flow)** — Tasks 10, 11, 12 cover render, input, countdown, queue.
- **Section 3.3 (Run-over flow)** — Task 9.
- **Section 3.4 (Input binding)** — Task 11.
- **Section 3.5 (Glyph resolution)** — Task 8 adds `Names.WeaponGlyph` / `Names.ItemGlyph`.
- **Section 4 (Edge cases)** — covered: not-connected (Task 7 `hidden` toggle), run-over over level-up (z-order in UXML, Task 3), downed (Task 10), resolution change (Task 2 PanelSettings is enough), missing font (Task 4 fallback is automatic), null choices (Task 10 `BuildLevelUpCards` early-returns).
- **Section 5.1 (Manual resolution sweep)** — Task 13 step 1.
- **Section 5.2 (Play-mode smoke test)** — Tasks 7, 8, 9, 10 each add tests; the full set is the spec's smoke surface.
- **Section 5.3 (Playtest scenarios)** — Task 13 step 2.
- **Section 6 (Rule audit)** — covered by code: glyph dispatch on kind enum, no name-based branching.

Placeholder scan: no "TBD", no "implement later", no "similar to Task N". Every code change has the actual code inline.

Type consistency: `HudWeaponEntry` / `HudItemEntry` / `LevelUpChoiceDisplay` / `HudState` shapes are stable across Tasks 6–10. The generic `UpdateInventoryGrid<T>` in Task 8 uses an `object` cast which compiles for both the weapon and item struct cases. `RoomState.tick` field name in Task 12 is flagged for verification — if the schema uses a different name, the executor adjusts.

One known follow-up to flag for the executor:
- In Task 11 the dev hotkey path for forcing a level-up offer isn't named — find it in `NetworkClient.cs` or in input bindings. The recent commit `feat(phase-8.1): orbit camera + camera-relative WASD + damage-self hotkey` suggests damage-self exists; a force-level-up hotkey may or may not. If absent, trigger via real gameplay (kill a few enemies near spawn).

---

## Execution handoff

**Plan complete and saved to `docs/superpowers/plans/2026-05-12-ui-scaling-plan.md`. Two execution options:**

**1. Subagent-Driven (recommended)** — I dispatch a fresh subagent per task, review between tasks, fast iteration.

**2. Inline Execution** — Execute tasks in this session using executing-plans, batch execution with checkpoints.

**Which approach?**
