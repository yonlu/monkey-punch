# Landing page redesign — 8bitcn theme + room list

**Status:** Design — drafted 2026-05-07. Pending implementation plan.

## Goal

Replace the bare-bones landing page with an 8-bit themed page that lists
the currently-available game rooms so a player can join with a click,
without having to copy and paste a 4-character code from a friend. All
rooms are public today; no privacy semantics change.

The theme is delivered via [8bitcn-ui](https://github.com/TheOrcDev/8bitcn-ui),
a shadcn-registry component pack. This is the first time Tailwind /
shadcn / 8bitcn enter the codebase; that toolchain addition is part of
the work.

## Non-goals

- Re-theming any in-game overlay (HUD, RunOverPanel, LevelUpOverlay,
  minimap, debug HUD, damage numbers). Scope is landing only. The
  in-game UI keeps its current inline-styled, system-font look.
- Deep-link `?code=AB7K` URL parsing. Landing already accepts an
  `initialCode` prop; we are not introducing URL state.
- Lobby pubsub / live room events. Polling is the chosen mechanism.
- Server-side "lobby vs in-progress" distinction. Rooms simulate the
  moment they are created; that does not change.
- Private rooms / join codes that bypass listing. All rooms remain
  public (per the user's note — that is okay for now).
- Migrating any other page to Tailwind. Tailwind is added but its usage
  is scoped to landing components.

## Architectural decisions

These are load-bearing. The implementation plan treats them as fixed.

### AD1. Tailwind v4 via the official Vite plugin, not v3

shadcn's current default is Tailwind v4 with `@tailwindcss/vite`. v4
removes the PostCSS step and ships a single Vite plugin. We follow that
default rather than installing v3 — staying on the supported path
reduces friction with future shadcn registry adds.

### AD2. CSS isolation via the existing inline-styled in-game UI, not preflight-disabled

Tailwind v4's preflight resets `*` styles and is harder to disable than
in v3. The in-game overlays (`PlayerHud`, `RunOverPanel`,
`LevelUpOverlay`, `MinimapCanvas`, `DebugHud`, `Crosshair`) are written
with inline JSX styles or component-local `style={...}` blocks, not
class-based cascading CSS — preflight has nowhere to bite. We enable
preflight globally and verify visually after Tailwind is wired in. If a
specific in-game element regresses, the targeted fix is to inline its
remaining CSS, not to disable preflight.

This decision is binding for this milestone. Future milestones that want
to migrate in-game UI to Tailwind / shadcn / 8bitcn (out of scope here)
inherit a preflight-on baseline.

### AD3. Room list is server-pushed via matchmaker metadata, polled

The Colyseus matchmaker already exposes `GET <serverHttp>/matchmake/game`
returning `RoomAvailable<{ code, hostName }>[]` once we extend the
listing metadata in `GameRoom`. The client polls every 3 s while the
landing page is mounted. No new WebSocket, no `LobbyRoom`, no schema
field. This is consistent with the architectural rule that **all synced
state is in `shared/schema.ts`** — room-listing data is *not* synced
state; it is matchmaker metadata, which is a separate Colyseus
mechanism.

### AD4. Host name is "first joiner", not "creator"

`onCreate` runs before any client joins. The creating client doesn't
have a `Player` yet at that point. Picking the *first joiner* as host
sidesteps the race and keeps `onCreate` free of identity logic. When
the host leaves, the next remaining player becomes host (deterministic
by `MapSchema` iteration order). When the room is empty during a
reconnection grace window, `hostName` is `null` and the row renders a
placeholder — joins are still allowed.

### AD5. "Join by code" stays alongside the list

The list is the primary join mechanism. The code-input field stays as a
secondary affordance for the texted-code flow ("hey here's `AB7K`").
Removing it would lose a working UX for no benefit.

### AD6. Click-to-join uses the existing `joinRoom(code, name)` path

`net/client.ts`'s `joinRoom` already does exactly the right thing: it
calls `colyseusClient.join("game", { code, name })` which the server's
`filterBy(["code"])` matches. The room-row click handler routes through
that function — no new join code path, no `joinById`. The
`waitForCode` helper, the `App.tsx` phase machine, and the
reconnection-token flow are unchanged.

## Server change

Single localized edit in `packages/server/src/GameRoom.ts`. No schema
change, no rules.ts change, no message-union change.

### Listing metadata shape

```ts
type GameRoomMetadata = { code: string; hostName: string | null };
```

The matchmaker's `setMetadata` is the only source of truth for this.
Nothing in `shared/schema.ts` mirrors it.

### Lifecycle

- **`onCreate`**: after `this.listing.code = code`, call
  `this.setMetadata({ code, hostName: null })`. The room is listed
  immediately, but with no host name yet.
- **`onJoin`**: after the new `Player` is added to `state.players`, if
  `this.metadata.hostName == null`, call
  `this.setMetadata({ code, hostName: player.name })`.
- **`onLeave` (consented branch)**: after deleting the player from
  `state.players`, if the leaver was the host, set `hostName` to
  the next remaining player's name (iteration order: `state.players`
  first key) or `null` if the map is now empty. Same `setMetadata` call.
- **`onLeave` (post-grace-window branch)**: same logic as the consented
  branch, after the timeout fires and the player is finally removed.

The "leaver was the host" check is `this.metadata.hostName === player.name`.
If two players share a name, the check is conservative — it may rotate
host when an identically-named non-host leaves. That is acceptable; the
host name is purely cosmetic.

### Why not store `hostName` on `RoomState`

It would work, but it would force any name change (none today, but a
future "rename" feature) to round-trip through the schema and patch out
to all clients every tick the metadata is recomputed. Matchmaker
metadata is the right channel: it's lazy, rate-limited by the
matchmaker, and exactly the data we want clients to see *before* joining
the room.

## Client architecture

New files, all under `packages/client/src/`:

```
components/ui/8bit/        ← shadcn-installed 8bitcn components
  button.tsx, card.tsx, input.tsx, badge.tsx
lib/utils.ts               ← cn() helper installed by shadcn init
landing/
  Landing.tsx              ← rewritten — replaces existing src/Landing.tsx
  RoomList.tsx             ← polled list of available rooms
  RoomRow.tsx              ← single row, click-to-join
  useAvailableRooms.ts     ← hook: poll matchmake, return rooms + state
net/
  matchmake.ts             ← typed fetch of GET /matchmake/game
```

`src/Landing.tsx` is moved into `landing/` and rewritten. `App.tsx` only
needs its import path updated.

### Components

**`Landing.tsx`** composes:

- 8bit `<Card>` wrapping the whole landing UI
- Title `monkey-punch` (Press Start 2P font, applied to a wrapper
  class on this card only — not global)
- Persistent name input (8bit `<Input>`, max 24 chars)
- `<RoomList>` (middle, primary affordance)
- A small "Join by code" section: 8bit `<Input>` (4 chars,
  uppercase) + 8bit `<Button>`
- 8bit `<Button>` "Create new room"
- Inline error region (existing pattern)
- Existing credits link (Quaternius / CC-BY 3.0) preserved

The `onJoined` prop, `initialName`, `initialCode`, `banner` props all
keep their current meaning so `App.tsx` need not change other than the
import path.

**`RoomList.tsx`** uses `useAvailableRooms()` and renders:

- Loading state (initial mount only): "Loading rooms…"
- Empty state: 8bit empty card "No rooms yet — click Create"
- Error state (after at least one successful poll): keep last list,
  show small "couldn't refresh" indicator
- Otherwise: a list of `<RoomRow>` for each room
- Header right-aligned: small "Refresh" 8bit button (manual override
  for impatient users — pollers fire it under the hood)

**`RoomRow.tsx`** displays one room:

- Join code (e.g. `AB7K`) — primary visual
- Host name or `—`
- Player count `3 / 10`
- Status badge: `Joinable` (default) or `Full` (when
  `clients >= maxClients`)
- Whole row is a button. Disabled when `Full` or when `name` is empty
  (with `aria-disabled` + visible reason on hover)
- Click handler calls the existing `joinRoom(code, name)` from
  `net/client.ts`

### Data flow

1. Landing mounts. `useAvailableRooms()` calls
   `fetchAvailableRooms()` immediately, then sets up a `setInterval`
   firing every 3000 ms.
2. `fetchAvailableRooms()` is a `fetch(matchmakeUrl(SERVER_URL))`,
   parsing JSON to `RoomAvailable<{ code: string; hostName: string | null }>[]`.
3. On unmount, the interval is cleared.
4. State returned: `{ rooms, loading, error, refresh }`. Callers use
   `refresh` for the manual button.
5. Clicking a row calls `joinRoom(code, name)`. On success, `onJoined`
   fires (existing `App.tsx` behavior — phase transitions to `playing`).

### `net/matchmake.ts`

```ts
export function matchmakeUrl(serverUrl: string): string {
  const u = new URL(serverUrl);
  if (u.protocol === "ws:") u.protocol = "http:";
  else if (u.protocol === "wss:") u.protocol = "https:";
  return new URL("matchmake/game", u).toString();
}

export type AvailableRoom = {
  roomId: string;
  clients: number;
  maxClients: number;
  metadata: { code: string; hostName: string | null };
};

export async function fetchAvailableRooms(serverUrl: string): Promise<AvailableRoom[]>;
```

Filtering at the boundary: any room whose `metadata.code` is missing or
not a string is dropped (treats unknown listings as unjoinable). Rooms
with `metadata.hostName == null` are kept and rendered as `—`.

### Hook

```ts
export function useAvailableRooms(intervalMs = 3000): {
  rooms: AvailableRoom[];
  loading: boolean;          // true only on initial mount
  error: Error | null;       // last poll error; cleared on next success
  refresh: () => void;       // forces an immediate fetch
};
```

The hook keeps the **last successful** rooms list across transient
errors. `error` is non-null only when the *most recent* poll failed.

## Error handling

- **Matchmake endpoint unreachable** (server down, transient network):
  hook keeps the last list, surfaces a "couldn't refresh" indicator,
  retries on the next 3 s tick.
- **Click-to-join fails** (room filled between poll and click, room
  disposed): caught by the existing landing error region; a fresh poll
  fires within 3 s and removes the stale row.
- **Server returns rooms with no `metadata`** (older deploy mid-rolling-
  upgrade, or matchmake/listing race): the row is hidden — `code` is a
  required field at the boundary.
- **Same-tab spam-click on a row**: row's local `busy` state disables it
  during the in-flight join.
- **Cross-origin in dev** (server `localhost:2567`, client `localhost:5173`):
  Colyseus's matchmake endpoint serves permissive CORS by default; we
  verify once during implementation. If something is off, the fix is
  server-side CORS config, not the client.

## Testing

- **`net/matchmake.ts`** unit-tested with vitest + mocked `fetch`:
  - `matchmakeUrl()`: `ws://` → `http://`, `wss://` → `https://`,
    `http://` and `https://` left alone.
  - `fetchAvailableRooms()`: parses well-formed response, drops rooms
    with missing/invalid `metadata.code`, propagates fetch errors.
- **Server-side `GameRoom` host-name lifecycle** — extend an existing
  integration test (a real Colyseus runtime, not a unit mock) to cover:
  - `metadata.hostName === null` after `onCreate`.
  - `metadata.hostName === <first joiner's name>` after first `onJoin`.
  - `metadata.hostName === <next player>` after consented host leave.
  - `metadata.hostName === null` after the last player leaves.
  - `metadata.hostName` does not change when a non-host leaves.
  This is the load-bearing test — it touches the matchmaker, which is a
  real-runtime path.
- **Hook (`useAvailableRooms`) tests are deferred** unless a DOM testing
  stack (`@testing-library/react` + `jsdom`) is already in place. The
  cost of standing up DOM tests for a 30-line hook outweighs the value
  for this milestone. Manual smoke + the matchmake unit tests cover the
  important paths.
- **No simulation tests change.** This work does not touch `rules.ts`,
  the schema, the message union, or any tick function.

## Workflow notes

- Toolchain addition (Tailwind + shadcn + 8bitcn) gets its own commit
  with a green typecheck and the existing pages still rendering — no
  visual change yet. This makes the diff reviewable.
- Server `GameRoom` change gets its own commit, paired with the
  integration test additions.
- Landing rewrite gets its own commit.
- Each commit follows the chunked-commits preference.

## Open implementation choices (not architectural)

These are decisions to make during the plan, not the design:

- Exact Press Start 2P loading strategy (Google Fonts CDN link vs
  self-host).
- Whether to introduce `clsx` directly or rely on the version pulled in
  by shadcn.
- The visual treatment of the "couldn't refresh" indicator — small text
  vs an 8bit `<Badge>`.
- Refresh button's exact wording ("Refresh" vs "↻").

These don't change the architecture and can be settled in the plan or
during implementation.
