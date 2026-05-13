# Phase 8.4 — UI Toolkit migration + resolution-aware scaling

**Status:** spec — review-pending.

**Trigger:** existing IMGUI HUD does not scale with screen resolution; on a
34" 3440×1440 ultrawide it is small and hard to read.

**Source code under change:**
- `Monkey Punch/Assets/Scripts/UI/GameUI.cs` (replaces IMGUI rendering)

**Code that does not change (migration boundary):**
- `Monkey Punch/Assets/Scripts/Net/NetworkClient.cs` — callers of
  `GameUI.SetHud / ShowLevelUp / HideLevelUp / ShowRunOver / HideRunOver`
- All schema, server, rules, prediction code

---

## 1. Scope and intent

The presenting problem is a scaling complaint. The fix uses that complaint
as the trigger for the **already-planned** UI Toolkit migration referenced
at the top of `GameUI.cs`:

> Phase 8 polish should re-implement these screens in UI Toolkit with
> authored styles — the GameUI public API (ShowLevelUp / HideLevelUp /
> ShowRunOver / SetHud) is the migration boundary; only the rendering
> implementation needs to change.

Beyond solving the scaling complaint, two design choices are made in this
milestone that change *behavior*, not just visuals:

1. **Level-up becomes non-modal.** The IMGUI implementation pauses
   gameplay perception by unlocking the cursor and showing a centered
   modal. This is wrong for an online co-op game where the server keeps
   simulating regardless. The new bar lives at bottom-center, leaves the
   cursor locked, and is resolved with **keyboard 1/2/3**.
2. **Inventory becomes a grid.** Today weapons + items are a comma-joined
   string (`Weap: Bolt +3, Damascus +1 / Items: ...`). The new design is a
   4×2 weapon grid plus a 4×2 item grid, each slot showing a glyph + level
   label.

Visual aesthetic: **Megabonk-style** — opaque dark panels with gold
borders + hard drop shadows, pixel display font for headline numbers,
white text with hard black drop shadow for over-terrain legibility.

**Out of scope** (explicitly deferred — do not let scope creep pull them in):

- Minimap / compass (no Unity-side implementation exists yet)
- Custom authored pixel icons per weapon/item (using Unicode emoji
  glyphs as placeholders, mirroring the web client's pattern)
- Megabonk-closer custom pixel font (Press Start 2P is the placeholder)
- Settings menu / UI scale slider (no settings UI exists yet)
- Damage-flash overlay (web client has one; not present in IMGUI; out of
  scope for this milestone)

---

## 2. Architecture

### 2.1 Asset layout

```
Monkey Punch/Assets/
  UI/
    GameUI.panelsettings    (new)
    GameUI.uxml              (new)
    GameUI.uss               (new)
  Fonts/
    PressStart2P-Regular.ttf (new — Google Fonts, OFL license)
  Scripts/UI/
    GameUI.cs                (modified — IMGUI deleted, UXML bindings added)
    Names.cs                 (modified — emoji glyph lookup added)
```

### 2.2 PanelSettings configuration (the scaling fix)

| Field                  | Value                       | Why |
|------------------------|-----------------------------|-----|
| Scale Mode             | `Scale With Screen Size`    | Canonical UI Toolkit answer for resolution-aware game UI. |
| Reference Resolution   | `1920 × 1080`               | Industry-standard authoring target. |
| Screen Match           | `Match Width Or Height`     | — |
| Match (0=W, 1=H)       | **`1.0` (height-match)**    | Ultrawide 21:9 keeps text/HP/cards at 1080p-readable size, gaining horizontal room rather than shrinking. 4K / 1440p scale up proportionally. |
| Sort Order             | `0`                         | Single canvas — no overlay competition. |
| Target Display         | `Display 1`                 | Single-display game. |

This single setting change resolves the original complaint.

### 2.3 `GameUI.cs` becomes a thin controller

The IMGUI methods `DrawHud / DrawRunOver / DrawLevelUp / DrawBar` and
`OnGUI` are deleted. The singleton, state structs (`HudState`,
`HudWeaponEntry`, `HudItemEntry`, `LevelUpChoiceDisplay`), cursor-lock
logic, and public API (`ShowLevelUp / HideLevelUp / ShowRunOver /
HideRunOver / SetHud / LevelUpOpen / AnyModalOpen`) all stay.

`AnyModalOpen` (currently `public`, line 103) keeps its name and its
boolean semantics (`levelUpVisible || runOverVisible`). The only
caller today is `RefreshCursorState` itself; the rename of intent is
internal. If any external caller is found during implementation that
relied on `AnyModalOpen` for cursor-related decisions, audit it then.

One behavior change to existing logic in `RefreshCursorState` (line 113):

```csharp
// Before:
if (AnyModalOpen) { /* unlock cursor */ }   // AnyModalOpen = levelUpVisible || runOverVisible

// After:
if (runOverVisible) { /* unlock cursor */ }
// AnyModalOpen still reports both for any caller that cares, but
// the cursor decision is now keyed only to runOverVisible.
```

`AnyModalOpen` semantics stay (some other system may still want to know
"is a UI element foregrounded"), but the cursor-management coupling is
narrowed.

### 2.4 Visual tree (UXML overview)

```
<UXML>
  <VisualElement name="root" class="hud-root">

    <!-- Top-row stats (kills, time-small) -->
    <VisualElement class="hud-toprow">
      <Label class="stat" name="stat-time">⏱ 00:00</Label>
      <Label class="stat" name="stat-kills">💀 0</Label>
    </VisualElement>

    <!-- Top-center large time (Megabonk's prominent display) -->
    <Label class="hud-time" name="hud-time">00:00</Label>

    <!-- Top-right level -->
    <Label class="hud-level" name="hud-level">LV 1</Label>

    <!-- Left HP / XP / inventory -->
    <VisualElement class="hud-leftcol">
      <VisualElement class="hud-hpbar">
        <VisualElement class="fill" name="hp-fill"/>
        <Label name="hp-text">0 / 0</Label>
      </VisualElement>
      <VisualElement class="hud-xpbar">
        <VisualElement class="fill" name="xp-fill"/>
      </VisualElement>
      <VisualElement class="hud-invgrid" name="weapons-grid">
        <!-- 8 slots templated at runtime: GameUI.cs instantiates from a slot template -->
      </VisualElement>
      <VisualElement class="hud-invgrid" name="items-grid">
        <!-- 8 slots, same template -->
      </VisualElement>
    </VisualElement>

    <!-- Bottom-left debug overlay (toggle hotkey, default off) -->
    <VisualElement class="hud-debug hidden" name="debug">
      <Label name="debug-fps">FPS: 0</Label>
      <Label name="debug-ping">PING: 0</Label>
    </VisualElement>

    <!-- Bottom-center level-up bar (hidden by default) -->
    <VisualElement class="lvlup-bar hidden" name="lvlup-bar">
      <VisualElement class="lvlup-prompt">
        <Label class="pulse" name="lvlup-prompt-text">LEVEL UP — PRESS 1/2/3</Label>
        <Label class="timer" name="lvlup-timer">AUTO 10s</Label>
        <Label class="queue hidden" name="lvlup-queue">+1 MORE</Label>
      </VisualElement>
      <VisualElement class="lvlup-cards">
        <!-- 3 cards templated: each has .key, .tag, .icon, .name, .sub -->
      </VisualElement>
    </VisualElement>

    <!-- Run-over modal (hidden by default; stays modal) -->
    <VisualElement class="runover-modal hidden" name="runover">
      <VisualElement class="runover-dimmer"/>
      <VisualElement class="runover-panel">
        <Label class="runover-title" name="runover-title">DEFEAT</Label>
        <Button class="runover-btn" name="runover-restart">RESTART</Button>
      </VisualElement>
    </VisualElement>

  </VisualElement>
</UXML>
```

Slot trees (16 inventory slots + 3 level-up cards) are constructed from
C# at runtime as `VisualElement` instances with their `AddToClassList`
classes set — not via string-concatenated markup. Single visible-tree
UXML file, no template UXMLs. Style is owned by USS; structure is owned
by C#. This avoids the UXML template / `TemplateContainer` boilerplate
for tiny repeating elements.

### 2.5 USS styling

Single `GameUI.uss` colocated with the UXML. Defines:

- Font assignment via `--unity-font-definition: url("Fonts/PressStart2P-Regular.ttf")`
- Color palette tokens at `:root`: `--mp-gold`, `--mp-dark`, `--mp-brown-border`, `--mp-hp-red`, `--mp-xp-blue`, `--mp-item-purple`, `--mp-shadow`
- Hard `text-shadow: 2px 2px 0 var(--mp-shadow)` baseline on all white text
- Bar styling: opaque background, 2px brown border, 4px hard drop shadow
- Inventory slot styling: 36×36, brown border, level label bottom-left in 7px font
- Level-up bar: `bottom: 18px; left: 50%; translate: -50% 0`; `transition: translate 0.15s, opacity 0.15s` for the slide-up/fade-out
- `.hidden` utility: `display: none` (we use display rather than visibility so layout collapses)
- `.downed`: `opacity: 0.4; pointer-events: none`
- `:root` ScaleMode is set on PanelSettings, not USS

### 2.6 Animation specification

| State change           | USS transition                                         |
|------------------------|--------------------------------------------------------|
| Bar appears            | `translateY 60px → 0` + `opacity 0 → 1` over 150ms     |
| Bar resolves           | `opacity 1 → 0` over 150ms, then `display: none`       |
| Run-over modal appears | `opacity 0 → 1` over 200ms                             |

All transitions are USS-driven; no `Coroutine` or `Update()` ticking needed.

---

## 3. Data flow

### 3.1 Per-frame HUD update

`NetworkClient.Update()` already calls `GameUI.Instance.SetHud(hudState)`.
That call now writes into pre-fetched `VisualElement` references stored on
`GameUI` at `Awake`. No allocation, no `Q<>` lookups per frame:

```csharp
// In Awake (once):
hpFill       = root.Q<VisualElement>("hp-fill");
hpText       = root.Q<Label>("hp-text");
hudTime      = root.Q<Label>("hud-time");
hudLevel     = root.Q<Label>("hud-level");
statTime     = root.Q<Label>("stat-time");
statKills    = root.Q<Label>("stat-kills");
xpFill       = root.Q<VisualElement>("xp-fill");
weaponsGrid  = root.Q<VisualElement>("weapons-grid");
itemsGrid    = root.Q<VisualElement>("items-grid");
// ...

// In SetHud (every frame):
hpFill.style.width = new StyleLength(new Length(hpFrac * 100f, LengthUnit.Percent));
hpText.text = $"{hud.Hp} / {hud.MaxHp}";
hudTime.text = FormatTime(hud.ElapsedSeconds);
hudLevel.text = $"LV {hud.Level}";
// inventory grid rebuild only when weapon/item counts change (cheap dirty check)
```

### 3.2 Level-up flow

| Step | Source | Effect |
|------|--------|--------|
| 1 | Server emits `level_up_offered` | NetworkClient.OnLevelUpOffered runs |
| 2 | NetworkClient resolves choice names + icons via `Names.cs` | builds `LevelUpChoiceDisplay[]` |
| 3 | NetworkClient calls `GameUI.ShowLevelUp(choices, OnPicked)` | populates 3 cards, removes `.hidden` from `.lvlup-bar`, enables `LevelUpPick` input action |
| 4 | USS transition runs (translateY + opacity) | bar slides up + fades in over 150ms |
| 5a | Player presses 1/2/3 | InputAction fires → invokes `OnPicked(index)` → NetworkClient sends `level_up_choice` message → GameUI starts fade-out |
| 5b | Or: server's `levelUpDeadline` (ticks) reaches 0 | Server emits `level_up_resolved` → NetworkClient calls `GameUI.HideLevelUp()` → fade-out runs |
| 6 | After fade transition completes | `.lvlup-bar` gets `.hidden`, input action disabled |

**Countdown rendering:** in `Update()`, when bar visible, compute
remaining ticks = `Player.levelUpDeadline - state.tick`, then seconds =
`remaining * SIM_DT_S` (0.05). Write to `#lvlup-timer` label as
`$"AUTO {Mathf.CeilToInt(seconds)}s"`.

**Queue:** `Player.levelUpChoices.Count > 1` → show `#lvlup-queue` with
`"+{count - 1} MORE"`. After a pick, the server sends a fresh
`level_up_offered` for the next queued offer — same flow re-enters at
step 1.

### 3.3 Run-over flow

Unchanged from current IMGUI implementation, only rendered through UXML:

1. Server emits `run_ended` → NetworkClient.OnRunEnded → `GameUI.ShowRunOver(reason, OnRestart)`
2. `.runover-modal` un-hides, dimmer fades in over 200ms, cursor unlocks
3. Player clicks RESTART → callback fires → run-over hides, cursor relocks

### 3.4 Input binding

Add three actions (or one composite action with three bindings) to
`Assets/InputSystem_Actions.inputactions` under the existing "UI" or a
new "LevelUp" map:

- `LevelUpPick1` ← `<Keyboard>/digit1`
- `LevelUpPick2` ← `<Keyboard>/digit2`
- `LevelUpPick3` ← `<Keyboard>/digit3`

`GameUI.cs` subscribes on `ShowLevelUp`, unsubscribes on `HideLevelUp`.
Action map is enabled/disabled rather than relying on per-frame
visibility checks.

### 3.5 Glyph resolution

`Names.cs` gains a parallel emoji table:

```csharp
public static string WeaponGlyph(byte kind) => /* '⚔' / '🏹' / '🌀' / ... */;
public static string ItemGlyph(byte kind)   => /* '🔥' / '⚡' / '❤️' / '🥾' / '🔍' / '🐰' */;
```

The 6 item glyphs are copied directly from the web client's
`LevelUpOverlay.tsx` `ITEM_ICONS` map for visual parity. Weapon glyphs
are chosen per-weapon (decided during implementation, not load-bearing
for this spec).

---

## 4. Edge cases / error handling

| Case | Behavior |
|------|----------|
| Not connected (`hud.Connected == false`) | `.hud-root` gets `.hidden`. Everything off. |
| Run-over fires while level-up bar visible | Run-over modal overlays via higher z-order in UXML. Bar interaction disabled because `state.runEnded` short-circuits the InputAction handler and `Player.levelUpDeadline` no longer ticks. |
| Player downed while bar visible | `.lvlup-bar` gets `.downed` class → cards `opacity: 0.4; pointer-events: none`. Prompt label switches to "REVIVE TO PICK". Auto-pick continues to fire on `levelUpDeadline`. |
| Resolution change at runtime (Alt+Enter, monitor swap, window resize) | `PanelSettings.ScaleWithScreenSize` reflows automatically. No code path needed. |
| Font asset missing or fails to load | UI Toolkit falls back to the engine default font. One `Debug.LogWarning` at `Awake` if `--unity-font-definition` resolves to null. Game ships. |
| `ShowLevelUp` called with `choices == null` or empty | Defensive early-return — no card paint, no bar shown. Server should never send this, but if it does we don't crash. |
| Hot-swapping `GameUI.uxml` in editor at runtime | `UIDocument` re-mounts; `Awake` does not re-run, but the `OnEnable` path re-resolves element references. (Standard UI Toolkit pattern.) |

---

## 5. Testing

### 5.1 Manual editor verification at multiple resolutions

Mandatory checklist before milestone close. Switch Unity Game View to each
resolution and walk through the scenarios:

| Resolution     | Aspect | Notes                                          |
|----------------|--------|------------------------------------------------|
| 1920 × 1080    | 16:9   | Reference. UI should look like the mockups.    |
| 3440 × 1440    | 21:9   | Original complaint resolution. Text legible.   |
| 2560 × 1440    | 16:9   | Common 1440p case. Proportional scale-up.      |
| 1366 ×  768    | 16:9   | Low-end laptop. Confirm no clipping.           |

Pass criteria: HUD elements remain corner-anchored without clipping;
level-up bar stays bottom-centered; HP / level / time numbers read
clearly at all four resolutions; cards do not overflow on 21:9; nothing
gets cropped on 768.

### 5.2 Play-mode smoke test

Single new test file `Monkey Punch/Assets/Tests/Editor/GameUITest.cs` (or
`Tests/Runtime/` if play-mode is preferred):

- `Awake` the GameUI prefab in a fresh scene.
- Call `SetHud(connected=true, hp=70, maxHp=100, xp=35, xpForNextLevel=100, level=4, kills=142, elapsedSeconds=201, weapons=[…], items=[…])`.
- Assert `hud-time` text equals `"03:21"`.
- Assert `hud-level` text equals `"LV 4"`.
- Assert `hp-text` text equals `"70 / 100"`.
- Assert `hp-fill.style.width.value.value` ≈ 70.
- Call `ShowLevelUp(3 choices, _)`, assert `.lvlup-bar` does not have `.hidden`.
- Call `HideLevelUp`, wait one frame, assert `.lvlup-bar` has `.hidden`.

### 5.3 Manual playtest scenarios

After unit tests pass, manual confirmation:

| Scenario | Expected |
|----------|----------|
| Pickup XP gem to threshold | Bar slides up bottom-center over 150ms. Cursor stays locked. Camera continues to follow mouse. |
| Press `1` | Bar fades. Chosen weapon level increments in slot grid. `level_up_resolved` in console. |
| Pick up gems but don't press anything | Countdown ticks down. At 0, auto-pick fires, bar fades. |
| Get downed during bar visible | Cards grey out, prompt switches to "REVIVE TO PICK", countdown continues, auto-pick fires on 0. |
| Pickup multiple gems back-to-back | "+1 MORE" badge appears. After pick, next offer appears (bar can stay up without a fade if next offer arrives mid-fade — acceptable). |
| Die fully | Run-over modal overlays, cursor unlocks, RESTART button works. |
| Alt+Enter to fullscreen, Alt+Enter back | UI reflows automatically. No code path. |

---

## 6. Migration boundary verification (CLAUDE.md compatibility)

This change touches client-side rendering only. Per the project's
architectural rules, that is the safest possible surface:

- **Rule 1** (server is authoritative) — unchanged. Client still only sends inputs.
- **Rule 2** (all synced state in `shared/schema.ts`) — unchanged. We render `Player.levelUpChoices`, `Player.levelUpDeadline`, `Player.items`, `Player.weapons` which already exist.
- **Rule 4** (game logic in `shared/rules.ts`) — unchanged. Auto-pick still fires from `tickLevelUpDeadlines`.
- **Rule 7** (no identity beyond sessionId) — unchanged.
- **Rule 9** (20Hz / 60fps split) — unchanged. UI rendering runs at framerate; `SetHud` reads interpolated state that was already being read.
- **Rule 11** (tick order) — unchanged. Universal invariant `if (state.runEnded) return;` continues to gate every tick function.
- **Rule 12** (combat events server→client, no name-based branching) — preserved. Glyphs are looked up by `kind` (uint8 enum), not name. Style classes are applied by kind/effect enum (`.lvlup-card.item` vs `.lvlup-card.weapon`), never by weapon name.

No schema change. No server change. No `shared/` change. The shared
`Names.cs` gets a new lookup table for glyphs; it's still kind-keyed.

---

## 7. Risks

1. **Press Start 2P doesn't read as "Megabonk-style."** Probable. Acceptance criterion is *readable at ultrawide*, not *visually identical to Megabonk*. Font swap is a follow-up.
2. **UXML/USS hot-reload quirks.** UI Toolkit's domain-reload behavior is occasionally surprising; if `Awake`-cached element references go stale on hot-reload, fall back to resolving in `OnEnable`. Standard pattern, well-documented.
3. **Emoji glyph rendering varies by font.** Press Start 2P has no emoji coverage; emoji will fall back to system emoji font. Visual inconsistency between pixel display and emoji rendering. Accepted as placeholder cost.
4. **Inventory grid swap may surface a missing data path.** Today the IMGUI joins `hud.Weapons` / `hud.Items` into a string. The new grid renders per-slot. Confirm during implementation that `Names.WeaponName(kind)` and `Names.ItemName(kind)` are stable for all 8 weapons + 6 items, and that level rendering matches existing semantics (L5 cap shows "L5 MAX" or just "L5" — pick during impl).
5. **Mouse-click on cards has no fallback.** Keyboard-only means a player with no working number-row keys cannot pick. Auto-pick on timeout is the safety net. Accepted.

---

## 8. Open questions (none load-bearing)

None. All branches resolved during brainstorming. Implementation plan
can proceed.
