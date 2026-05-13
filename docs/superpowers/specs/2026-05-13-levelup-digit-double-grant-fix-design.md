# Level-up digit-key double-grant fix — design

**Status:** approved (brainstorming)
**Branch:** `phase-8.4-ui-scaling`
**Related:** commits `9fc7705` (client-side digit-key suppression), `0b0d154`
(server-authority debug-shortcut gate), `0e6c843`, `dce3bf2`, `5c5b0b3`
(Phase 8.4 sequential level-up work).

## Problem

When the local player levels up and selects a card with digit `1`/`2`/`3`,
the resulting state contains both:

1. The chosen card's weapon or item (correct), AND
2. An unrelated weapon — Orbit (key `1`), Bloody Axe (`2`), Damascus (`3`),
   or Kronos (`4`) — granted by the dev shortcut path (wrong).

The intent is "one card press = one item gained." Two prior fixes have
attacked this surface (`9fc7705` and `0b0d154`); both are insufficient
under the actual frame ordering, so the bug remains visible.

## Root cause

Two competing input paths process the same digit keypress within a single
Unity frame:

- **Path P (picker):** `Monkey Punch/Assets/Scripts/UI/GameUI.cs:135-137`
  binds `pick1/pick2/pick3.performed += OnPick<N>` on the "LevelUp"
  `InputActionMap`. Callbacks fire during `InputSystem.Update`, **before**
  any `MonoBehaviour.Update`.
- **Path D (debug grant):** `Monkey Punch/Assets/Scripts/Net/NetworkClient.cs:715-718`
  polls `Keyboard.current.digit<N>Key.wasPressedThisFrame` inside
  `NetworkClient.Update`, gated by
  `levelUpOwnsDigits = GameUI.Instance.LevelUpOpen`.

`LevelUpOpen` returns `levelUpVisible` (GameUI.cs:55). The teardown order
inside Path P invalidates the gate that Path D relies on:

```
Frame N — digit '1' pressed
  ├─ InputSystem.Update
  │   └─ OnPick1 → PickIndex(0):
  │        HideLevelUp()              // sets levelUpVisible = false
  │        SendLevelUpChoice(0)       // sends level_up_choice idx=0
  └─ NetworkClient.Update
      ├─ kb.digit1Key.wasPressedThisFrame == true   (still true)
      ├─ levelUpOwnsDigits = LevelUpOpen == FALSE   (cleared above)
      └─ DebugGrantWeapon(1) → sends debug_grant_weapon kind=1
```

Server processes both messages in arrival order. `level_up_choice` runs
first and clears `pendingLevelUp`. `debug_grant_weapon`'s server gate
(`if (player.pendingLevelUp) return;`, GameRoom.ts:378) then observes the
post-resolve state and grants the second weapon.

The prior client-side fix (`9fc7705`) reads `LevelUpOpen` after the
racing callback has already torn it down. The prior server-side fix
(`0b0d154`) reads `pendingLevelUp` after the racing client message has
already cleared it. Both checks are correct in isolation; both are
defeated by the actual frame ordering.

## Fix — Option A + A1, no transitional visuals

**Defer the level-up bar teardown to the server's `level_up_resolved`
event.** Synchronously disable further picks so the user can't re-fire,
but do not touch `levelUpVisible` until the server confirms.

This makes `LevelUpOpen` stay `true` for the rest of the frame on which
the pick was sent, which preserves the digit-key gate in
`NetworkClient.Update` for that same frame. `LevelUpOpen` only flips to
`false` when the server's `level_up_resolved` event arrives (≈50–100ms
later), at which point the keyboard's `wasPressedThisFrame` is no longer
true and the gate is moot.

### Changes

**`Monkey Punch/Assets/Scripts/UI/GameUI.cs`**

1. `PickIndex(int idx)` becomes:
   - Reject if `!levelUpVisible || levelUpChoices == null` or idx OOB
     (unchanged).
   - Call `DisableLevelUpActions()` to make subsequent digit presses
     no-ops within the same offer (A1 — first press wins).
   - Invoke `onLevelUpClicked?.Invoke(idx)`.
   - **Do NOT call `HideLevelUp()`.**
   - **Do NOT clear `levelUpVisible`, `levelUpChoices`, or
     `onLevelUpClicked` here** — `HideLevelUp` does that when the
     server's `level_up_resolved` arrives. Keeping `levelUpVisible`
     true for the rest of this frame is the load-bearing change:
     it preserves the `LevelUpOpen` gate that suppresses the digit
     polling in `NetworkClient.Update` later in the same frame.

2. `HideLevelUp()` is unchanged. It is still called from:
   - `NetworkClient` on `level_up_resolved` (NetworkClient.cs:367) —
     **the new authoritative trigger.**
   - `ShowRunOver` (GameUI.cs:365) — run-end pre-empt, fine to keep.

3. Re-entrancy: `ShowLevelUp` already bumps `lvlupGen` and re-enables
   actions, so a back-to-back `level_up_offered` (queued levels)
   correctly re-arms the picker even if `HideLevelUp` was skipped by
   the run-end path or hasn't fired yet.

**No server-side changes.** The existing `pendingLevelUp` gate on
`debug_grant_weapon` (GameRoom.ts:378) remains as defense-in-depth.

### Why A1 (single-press lockout)

If the player taps `1` twice in quick succession before
`level_up_resolved` arrives, A2 (idempotent server rejection) would
generate a redundant `level_up_choice` message that the server's
`!player.pendingLevelUp` guard at GameRoom.ts:325 already rejects. A1
prevents the redundant send by disabling the actions on first press —
strictly more correct, marginally less bandwidth, and avoids any
question about "what does the server do with a second message that
references a now-invalid choice index."

### Why no transitional visuals

The window between press and server confirmation is one server tick
plus RTT (typically 50–100ms), shorter than the existing 16ms
schedule delay used for the bar's CSS `.shown` transition. Adding a
"confirming" intermediate state would draw the eye to a window most
players won't perceive. Ship the lockout; revisit visual feedback only
if QA reports the bar feels unresponsive.

## Non-goals

- No refactor of debug-shortcut digit polling onto the Input System
  (option C). That is a larger change and the targeted fix is sufficient.
- No new server-side timing gate (option D). The root cause is on the
  client; layering more server gates without fixing the client race
  invites the next variant of this bug.
- No change to the auto-pick path (`tickLevelUpDeadlines`,
  rules.ts:2085). The auto-pick still emits `level_up_resolved`, which
  drives `HideLevelUp` on the client — same path as user-initiated picks.

## Test plan

### Unit / rules

No `rules.ts` changes; existing tests cover `resolveLevelUp` and
`tickLevelUpDeadlines` and continue to pass. No new rules test needed.

### Integration

`packages/server/test/levelUpAuthority.test.ts` already verifies the
server gates `debug_grant_weapon` while `pendingLevelUp` is true. That
test is the regression guard for the server side and continues to pass.

### Manual (Unity client)

The race is a frame-ordering bug; integration tests don't cover Unity's
input dispatch. Manual verification is required.

1. Start `pnpm dev` + Unity Editor; join a room.
2. `K K K …` to accelerate to a level-up offer (or `debug_grant_xp` if
   the existing dev path is shorter).
3. Wait for the level-up bar; press `1`. Confirm exactly one inventory
   slot changes (the one matching the chosen card). Repeat for `2`
   and `3` across multiple offers.
4. Press `1` and then `1` again quickly within the same offer; confirm
   only one pick is sent (check NetworkClient console log:
   `[NetworkClient] level_up_choice sent idx=0` should appear once).
5. With two Unity Editor instances joined to the same room, verify
   neither client sees a phantom second grant when the other client
   picks (sanity check that the fix is local to the picking client).

### Verification before claiming done

Per `superpowers:verification-before-completion`, run:

```
pnpm typecheck
pnpm --filter @mp/server test
```

The TS workspace doesn't compile the Unity client; the Unity-side
change is C# and is verified by Unity's editor compile + the manual
steps above.

## Open questions

None — A/A1/no-visual locked in during brainstorming.

## Edge cases considered

- **Server message lost / `level_up_resolved` delayed past deadline.**
  Server auto-pick fires at the deadline, emits `level_up_resolved`
  with `autoPicked=true`, NetworkClient calls `HideLevelUp`. The bar
  closes via the same path. The user's manual pick may or may not have
  been applied depending on which arrived first — but that race is
  pre-existing and out of scope here.

- **User dies mid-pick (downed flips true).** `SetDownedState(true)`
  (GameUI.cs:322) greys the cards but does not hide the bar; the user
  can still pick (server resolves it normally) or auto-pick fires at
  deadline. Unchanged by this fix.

- **Run ends mid-pick.** `ShowRunOver` (GameUI.cs:361) calls
  `HideLevelUp` directly. Unchanged.

- **Back-to-back level-ups (queued).** Server emits a fresh
  `level_up_offered` after the previous resolve; NetworkClient calls
  `ShowLevelUp` again. `ShowLevelUp` re-enables the pick actions and
  re-arms `levelUpChoices` and `onLevelUpClicked`. The PickIndex change
  (not touching state, just calling `DisableLevelUpActions` and
  invoking the callback) does not interfere with this re-arm because
  `ShowLevelUp` overwrites everything PickIndex touched.

- **`HideLevelUp` called from multiple sources in the same frame.**
  Idempotent: `levelUpVisible = false` is a no-op the second time;
  `DisableLevelUpActions` is idempotent; `lvlupGen` bump invalidates
  any in-flight scheduled callbacks via the generation-counter
  pattern documented at GameUI.cs:230-234.
