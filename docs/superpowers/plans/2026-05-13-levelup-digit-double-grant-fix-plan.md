# Level-up digit double-grant fix — implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Stop the Unity client from sending both a `level_up_choice` and a `debug_grant_weapon` message on the same digit-key press, so picking a level-up card grants exactly one item.

**Architecture:** Defer the `HideLevelUp` teardown in `GameUI.PickIndex` to the server's `level_up_resolved` event. Synchronously disable the pick `InputAction`s to enforce first-press-wins (A1), but leave `levelUpVisible == true` for the remainder of the frame. This preserves the `LevelUpOpen` gate that `NetworkClient.Update`'s digit-key polling depends on, closing the same-frame race.

**Tech Stack:** Unity 6 (C#, new Input System, UI Toolkit). No TS server changes.

**Spec:** `docs/superpowers/specs/2026-05-13-levelup-digit-double-grant-fix-design.md`

---

## File Structure

Only one file changes. The server-authoritative architecture means the entire fix is local to one method's teardown order.

- **Modify:** `Monkey Punch/Assets/Scripts/UI/GameUI.cs:426-432` — replace the body of `PickIndex(int idx)`.

No new files, no schema changes, no shared/server changes. The existing `NetworkClient.cs:367` already calls `HideLevelUp` on `level_up_resolved`; this plan only stops `PickIndex` from racing that path.

## Testing strategy

Unit-testing Unity's per-frame input dispatch ordering is not practical — the race is between `InputSystem.Update` and `MonoBehaviour.Update`, and reproducing that in EditMode tests requires plumbing that exceeds the cost of the fix.

The verification path is therefore:

1. **Type/encoder safety net:** `pnpm typecheck` + `pnpm --filter @mp/server test`. These don't exercise the Unity client but confirm no inadvertent shared/server breakage.
2. **Unity Editor compile:** open the Unity Editor and confirm a clean recompile of `GameUI.cs`.
3. **Manual smoke test in-Editor:** the steps from the spec's Test Plan §Manual.

This is honest about what's tested. The fix is one ~6-line method body change; the regression risk is bounded.

---

## Task 1: Change `PickIndex` teardown order

**Files:**
- Modify: `Monkey Punch/Assets/Scripts/UI/GameUI.cs:426-432`

- [ ] **Step 1: Replace the body of `PickIndex`.**

Open `Monkey Punch/Assets/Scripts/UI/GameUI.cs`. Replace the existing `PickIndex` method (lines 426-432):

```csharp
    private void PickIndex(int idx) {
      if (!levelUpVisible || levelUpChoices == null) return;
      if (idx < 0 || idx >= levelUpChoices.Length) return;
      var cb = onLevelUpClicked;
      HideLevelUp();
      cb?.Invoke(idx);
    }
```

with:

```csharp
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
```

- [ ] **Step 2: Save and let Unity recompile.**

Switch to the Unity Editor window. Unity will auto-detect the file change and trigger a domain reload. Watch the Console for compile errors.

Expected: no compile errors, no new warnings related to `GameUI.cs`.

If Unity is not currently running, skip this step — the next typecheck/test step does not depend on Unity compile, and the manual smoke test in Task 3 will surface compile errors via the Editor.

- [ ] **Step 3: Run workspace typecheck + server tests.**

Run, from repo root:

```
pnpm typecheck
pnpm --filter @mp/server test
```

Expected:
- `pnpm typecheck`: exits 0. No TS errors. (This rebuilds `@mp/shared`'s `dist/` transitively per the project's stale-dist landmine.)
- `pnpm --filter @mp/server test`: all tests pass, including `levelUpAuthority.test.ts` and `levelUpReconnect.test.ts`.

These don't exercise the Unity client. They are a safety net confirming this change did not inadvertently touch shared schema, messages, or rules. If any test fails, stop — the failure indicates the wrong file was edited or an unrelated regression was introduced.

---

## Task 2: Manual verification in the Unity Editor

**Files:** none (verification only).

This task is the actual proof that the fix works. The race is at the Unity input-dispatch layer; only an in-Editor session can verify it.

- [ ] **Step 1: Boot the dev environment.**

From repo root:

```
pnpm dev
```

Expected: the server starts and listens (Colyseus log line `listening on ws://...:2567` or similar). Leave it running.

Open the Unity Editor for the `Monkey Punch/` project. Open the gameplay scene. Press Play.

Expected: client connects to local server, HUD appears, player cube is controllable.

- [ ] **Step 2: Force a level-up.**

In the running game, press `K` repeatedly to self-damage (or `B` to spawn enemies and farm gems). The fastest path is the dev path: with debug messages allowed, you can also use the existing XP grant — `debug_grant_xp` is not bound to a keyboard shortcut by default, so the practical path is `B` + collect gems, or just play until XP threshold.

Watch for the level-up bar to appear with three cards labeled 1 / 2 / 3.

Expected: bar appears, `[NetworkClient] level_up_offered to <sid> newLevel=N choices=3` in Console.

- [ ] **Step 3: Press `1` once.**

Expected console output, in order:

```
[NetworkClient] level_up_choice sent idx=0
[NetworkClient] level_up_resolved <sid> newLevel=<n> autoPicked=False
```

**Expected NOT to appear:** `[NetworkClient] debug_grant_weapon kind=1`. This is the regression signal — if you see this log line, the fix is not working and the bug is still present.

Visually verify: exactly one inventory slot in the bottom HUD changed (either a new weapon/item appeared, or an existing one's level bumped). No second slot or unexpected level bump elsewhere.

- [ ] **Step 4: Repeat for `2` and `3` across new level-ups.**

Farm to the next level-up. Press `2`. Verify the same: no `debug_grant_weapon kind=6` (Bloody Axe) log line, exactly one inventory change.

Next level-up: press `3`. Verify: no `debug_grant_weapon kind=3` (Damascus) log line, exactly one inventory change.

(Key `4` does not pick a card — it only debug-grants Kronos. Skip it for this fix's verification; it is unaffected.)

- [ ] **Step 5: Spam-press test (A1 lockout).**

Farm to the next level-up. When the bar appears, mash `1` rapidly (5-10 times).

Expected: `[NetworkClient] level_up_choice sent idx=0` appears **exactly once**. Subsequent presses produce no log line because `DisableLevelUpActions()` ran on the first press.

If `level_up_choice sent idx=0` appears more than once, the A1 lockout is broken — investigate `DisableLevelUpActions` and the pick-action Disable semantics.

- [ ] **Step 6: Verify outside-of-level-up digit-key debug grants still work.**

Wait until no level-up bar is showing. Press `1`.

Expected: `[NetworkClient] debug_grant_weapon kind=1` in Console, Orbit weapon appears (or levels up) on the player.

This confirms the fix didn't accidentally suppress the dev shortcut in its intended context.

- [ ] **Step 7: Two-client sanity check (optional but recommended).**

Build the project (`File → Build And Run` in Unity, or use the existing build target) and run a second instance alongside the Editor — or open the Editor in two separate Unity projects pointing at the same `Monkey Punch/` workspace if you have that set up.

Join both to the same room. Force a level-up on client A only. Verify on client B that no phantom inventory change appears for player A beyond the single picked card.

This is a sanity check that the fix is scoped to the picking client and didn't shift state authority.

If two-client setup is not readily available, skip — the single-client verification covers the bug surface.

---

## Task 3: Commit

**Files:** the modified `GameUI.cs` from Task 1.

- [ ] **Step 1: Stage and commit.**

```
git add "Monkey Punch/Assets/Scripts/UI/GameUI.cs"
git commit -m "$(cat <<'EOF'
fix(phase-8.4): defer level-up bar teardown to server resolve event

PickIndex was calling HideLevelUp() synchronously, which cleared
levelUpVisible during the InputSystem.Update callback phase. By the
time NetworkClient.Update ran later in the same frame, its LevelUpOpen
gate had flipped to false, so the digit-key debug-grant poll (which
reads Keyboard.current.wasPressedThisFrame directly) fired alongside
the level_up_choice — producing the chosen weapon AND a debug-granted
one.

Now PickIndex only disables the pick InputActions (first-press-wins
lockout) and invokes the callback. The visual teardown is driven
entirely by NetworkClient's level_up_resolved handler, which was
already wired. levelUpVisible stays true for the remainder of the
frame, keeping the LevelUpOpen gate honest.

Prior fixes 9fc7705 (client-side digit suppression) and 0b0d154
(server-side pendingLevelUp gate) both observed post-teardown /
post-resolve state, so neither closed the race. This change addresses
the root cause: the racing teardown itself.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

Expected: commit succeeds, pre-commit hooks (if any) pass.

If a pre-commit hook fails, fix the underlying issue and create a NEW commit. Do not `--amend` or `--no-verify`.

- [ ] **Step 2: Verify commit lands on the expected branch.**

```
git status
git log --oneline -5
```

Expected:
- Working tree clean for `GameUI.cs` (other files may still be dirty from the snapshot at session start — leave those untouched).
- Current branch is `phase-8.4-ui-scaling`.
- The new commit is at the top of `git log`, with the message above.

---

## Done criteria

- [ ] `GameUI.PickIndex` no longer calls `HideLevelUp`.
- [ ] `pnpm typecheck` passes.
- [ ] `pnpm --filter @mp/server test` passes.
- [ ] Manual: pressing 1/2/3 on a level-up bar produces exactly one inventory change with no `debug_grant_weapon` log line.
- [ ] Manual: pressing 1/2/3/4 outside a level-up bar still debug-grants weapons as before.
- [ ] Commit pushed to `phase-8.4-ui-scaling`.
