# Landing page redesign — 8bitcn theme + room list — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the bare-bones landing page with an 8-bit themed page that lists available rooms (joinable in-click), keeping the existing join-by-code flow as a secondary affordance.

**Architecture:** First-time introduction of Tailwind v4 + shadcn + 8bitcn into the Vite/React client, scoped to landing UI only. Server gains a single matchmaker-listing metadata extension (`hostName`) — no schema change, no rules change. Client polls `GET /matchmake/game` every 3 s for the room list.

**Tech Stack:** Tailwind CSS v4 (`@tailwindcss/vite`), shadcn CLI, 8bitcn-ui registry components, Press Start 2P (Google Fonts CDN), existing colyseus.js + React.

**Spec:** `docs/superpowers/specs/2026-05-07-landing-page-room-list-design.md`

---

## File Structure

**Created:**
- `packages/client/components.json` — shadcn CLI config (paths + style)
- `packages/client/src/lib/utils.ts` — `cn()` helper (created by shadcn init)
- `packages/client/src/components/ui/8bit/button.tsx` — 8bitcn Button (installed via shadcn add)
- `packages/client/src/components/ui/8bit/card.tsx` — 8bitcn Card
- `packages/client/src/components/ui/8bit/input.tsx` — 8bitcn Input
- `packages/client/src/components/ui/8bit/badge.tsx` — 8bitcn Badge
- `packages/client/src/landing/Landing.tsx` — rewritten landing page
- `packages/client/src/landing/RoomList.tsx` — polled list of rooms
- `packages/client/src/landing/RoomRow.tsx` — single clickable row
- `packages/client/src/landing/useAvailableRooms.ts` — polling hook
- `packages/client/src/net/matchmake.ts` — typed fetcher of `GET /matchmake/game`
- `packages/client/src/net/matchmake.test.ts` — vitest unit tests for fetcher
- `packages/server/test/listingMetadata.test.ts` — integration test for hostName lifecycle

**Modified:**
- `packages/client/package.json` — add `tailwindcss`, `@tailwindcss/vite`, `clsx`, `tailwind-merge`, `class-variance-authority`, `lucide-react`
- `packages/client/vite.config.ts` — add `@tailwindcss/vite` plugin and `@/...` path alias
- `packages/client/tsconfig.json` — add `@/*` path alias
- `packages/client/index.html` — `<link>` for Press Start 2P font
- `packages/client/src/styles.css` — add Tailwind v4 `@import "tailwindcss";` directive (at top, existing rules below remain)
- `packages/client/src/App.tsx` — change Landing import path
- `packages/server/src/GameRoom.ts` — extend `setMetadata` calls in `onCreate`, `onJoin`, `onLeave`

**Deleted:**
- `packages/client/src/Landing.tsx` — replaced by `landing/Landing.tsx`

---

## Phase A — Toolchain (Tailwind + shadcn + 8bitcn)

This phase adds infrastructure with no visible UI change. The verify step is "existing landing page still renders, typecheck passes."

### Task A1: Install Tailwind v4 and shadcn dependencies

**Files:**
- Modify: `packages/client/package.json`

- [ ] **Step 1: Install dependencies**

Run from repo root:

```bash
pnpm add -F @mp/client tailwindcss @tailwindcss/vite
pnpm add -F @mp/client clsx tailwind-merge class-variance-authority lucide-react
```

Expected: pnpm adds entries to `packages/client/package.json` `dependencies`. No build error.

- [ ] **Step 2: Verify install**

```bash
pnpm -F @mp/client typecheck
```

Expected: PASS (no type errors — these libs aren't imported yet).

- [ ] **Step 3: Commit**

```bash
git add packages/client/package.json pnpm-lock.yaml
git commit -m "build(client): add tailwind v4 + shadcn deps"
```

### Task A2: Wire Tailwind into Vite + add `@/...` path alias

**Files:**
- Modify: `packages/client/vite.config.ts`
- Modify: `packages/client/tsconfig.json`
- Modify: `packages/client/src/styles.css`

- [ ] **Step 1: Edit `packages/client/vite.config.ts`**

Replace the contents with:

```ts
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: {
      "@mp/shared": path.resolve(__dirname, "../shared/src/index.ts"),
      "@": path.resolve(__dirname, "src"),
    },
  },
  server: {
    port: 5173,
  },
});
```

- [ ] **Step 2: Edit `packages/client/tsconfig.json`**

Add `"@/*": ["src/*"]` to the existing `paths` block. Final shape:

```json
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": {
    "composite": true,
    "outDir": "dist",
    "rootDir": "src",
    "declaration": true,
    "declarationMap": true,
    "sourceMap": true,
    "jsx": "react-jsx",
    "lib": ["ES2022", "DOM", "DOM.Iterable"],
    "noEmit": false,
    "baseUrl": ".",
    "paths": {
      "@mp/shared": ["../shared/src/index.ts"],
      "@/*": ["src/*"]
    },
    "types": ["vite/client"]
  },
  "references": [{ "path": "../shared" }],
  "include": ["src/**/*"]
}
```

- [ ] **Step 3: Add Tailwind import to `packages/client/src/styles.css`**

Prepend to the file (existing rules stay below):

```css
@import "tailwindcss";
```

The existing `:root`, `.landing`, `.banner` etc. rules remain underneath and continue to apply.

- [ ] **Step 4: Verify dev server boots and existing landing renders**

Run from repo root:

```bash
pnpm dev
```

Expected: server logs `[colyseus] listening on port 2567`, vite logs the local URL. Open `http://localhost:5173`. The existing landing page renders — same name input, create button, code input, join button. No console errors.

Stop the dev server (Ctrl+C).

- [ ] **Step 5: Typecheck**

```bash
pnpm -F @mp/client typecheck
```

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add packages/client/vite.config.ts packages/client/tsconfig.json packages/client/src/styles.css
git commit -m "build(client): wire tailwind v4 vite plugin + @ path alias"
```

### Task A3: Initialize shadcn with `components.json`

**Files:**
- Create: `packages/client/components.json`
- Create: `packages/client/src/lib/utils.ts`

- [ ] **Step 1: Create `packages/client/components.json`**

shadcn v3+'s `init` is interactive. Create the config manually so the plan is reproducible. Write this exact file:

```json
{
  "$schema": "https://ui.shadcn.com/schema.json",
  "style": "new-york",
  "rsc": false,
  "tsx": true,
  "tailwind": {
    "config": "",
    "css": "src/styles.css",
    "baseColor": "neutral",
    "cssVariables": true
  },
  "aliases": {
    "components": "@/components",
    "utils": "@/lib/utils",
    "ui": "@/components/ui",
    "lib": "@/lib",
    "hooks": "@/hooks"
  },
  "iconLibrary": "lucide"
}
```

Notes:
- `tailwind.config` is `""` because Tailwind v4 has no JS config file by default.
- `tailwind.css` points to the existing `styles.css` we just added the `@import "tailwindcss"` directive to.

- [ ] **Step 2: Create `packages/client/src/lib/utils.ts`**

Standard shadcn `cn()` helper. Write:

```ts
import { clsx, type ClassValue } from "clsx";
import { twMerge } from "tailwind-merge";

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}
```

- [ ] **Step 3: Verify typecheck**

```bash
pnpm -F @mp/client typecheck
```

Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add packages/client/components.json packages/client/src/lib/utils.ts
git commit -m "build(client): add shadcn components.json + cn() helper"
```

### Task A4: Install 8bitcn components via shadcn registry

**Files:**
- Create: `packages/client/src/components/ui/8bit/button.tsx`
- Create: `packages/client/src/components/ui/8bit/card.tsx`
- Create: `packages/client/src/components/ui/8bit/input.tsx`
- Create: `packages/client/src/components/ui/8bit/badge.tsx`
- May modify: `packages/client/src/styles.css` (8bitcn may inject CSS variables)
- May modify: `packages/client/components.json`

- [ ] **Step 1: Add the 8bitcn components**

Run from `packages/client/`:

```bash
cd packages/client
pnpm dlx shadcn@latest add @8bitcn/button @8bitcn/card @8bitcn/input @8bitcn/badge --yes
cd ../..
```

Expected: shadcn writes files under `packages/client/src/components/ui/8bit/` (path follows components.json's `ui` alias plus the registry's subfolder convention). It may also install peer shadcn primitives (e.g., `@radix-ui/react-slot`) — let it.

If shadcn complains the install path doesn't exist, create `packages/client/src/components/ui/` first and re-run.

- [ ] **Step 2: Verify the files landed**

```bash
ls packages/client/src/components/ui/8bit/
```

Expected: see `button.tsx`, `card.tsx`, `input.tsx`, `badge.tsx`. (8bitcn's exact filenames — adjust the import paths in later tasks if the naming differs.)

- [ ] **Step 3: Typecheck**

```bash
pnpm -F @mp/client typecheck
```

Expected: PASS. If TS errors come from the 8bitcn components themselves (e.g., missing peer types), install the peer (`pnpm add -F @mp/client <peer>`) and re-run.

- [ ] **Step 4: Verify the existing landing still renders**

```bash
pnpm dev
```

Open `http://localhost:5173`. The existing landing page should look unchanged — neither the new components nor Tailwind utility classes are used yet.

If preflight has visibly broken the existing layout, see the spec's AD2: targeted fix is to inline the affected element's styles. Do not disable preflight.

Stop the dev server.

- [ ] **Step 5: Commit**

```bash
git add packages/client/src/components/ui/ packages/client/package.json pnpm-lock.yaml packages/client/src/styles.css packages/client/components.json
git commit -m "build(client): install 8bitcn button/card/input/badge"
```

### Task A5: Add Press Start 2P font

**Files:**
- Modify: `packages/client/index.html`

- [ ] **Step 1: Add Google Fonts link to `packages/client/index.html`**

Replace the file with:

```html
<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>monkey-punch</title>
    <link rel="preconnect" href="https://fonts.googleapis.com" />
    <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin />
    <link
      href="https://fonts.googleapis.com/css2?family=Press+Start+2P&display=swap"
      rel="stylesheet"
    />
  </head>
  <body>
    <div id="root"></div>
    <script type="module" src="/src/main.tsx"></script>
  </body>
</html>
```

The font is loaded but not applied yet — only the new landing wrapper (Phase D) will use it via a CSS class.

- [ ] **Step 2: Smoke test**

```bash
pnpm dev
```

Open the page; the existing landing should render and a network-tab check should show a request to `fonts.googleapis.com`. Stop the dev server.

- [ ] **Step 3: Commit**

```bash
git add packages/client/index.html
git commit -m "build(client): preload Press Start 2P font for 8bit landing"
```

---

## Phase B — Server: hostName lifecycle on listing metadata

### Task B1: Write integration test for hostName lifecycle

**Files:**
- Create: `packages/server/test/listingMetadata.test.ts`

- [ ] **Step 1: Write the failing test**

Create `packages/server/test/listingMetadata.test.ts` with:

```ts
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Server, matchMaker } from "colyseus";
import { Client } from "colyseus.js";
import { GameRoom } from "../src/GameRoom.js";

const PORT = 2601;

let gameServer: Server;

beforeAll(async () => {
  gameServer = new Server();
  gameServer.define("game", GameRoom).filterBy(["code"]);
  await gameServer.listen(PORT, undefined, undefined);
});

afterAll(async () => {
  await gameServer.gracefullyShutdown(false);
});

async function waitFor(cond: () => boolean, timeoutMs: number): Promise<void> {
  const start = Date.now();
  while (!cond()) {
    if (Date.now() - start > timeoutMs) {
      throw new Error(`waitFor timed out after ${timeoutMs}ms`);
    }
    await new Promise((r) => setTimeout(r, 10));
  }
}

type RoomMetadata = { code: string; hostName: string | null };

async function getRoomMetadata(code: string): Promise<RoomMetadata | undefined> {
  const rooms = await matchMaker.query({ name: "game" });
  const r = rooms.find((r) => r.metadata?.code === code);
  return r?.metadata as RoomMetadata | undefined;
}

describe("integration: GameRoom listing metadata hostName lifecycle", () => {
  it("hostName is null after onCreate (no joiners yet)", async () => {
    const client = new Client(`ws://localhost:${PORT}`);
    const room = await client.create<any>("game", { name: "Alice" });
    await waitFor(() => room.state.code !== "" && room.state.code != null, 1000);
    const code = room.state.code as string;

    // The creating client also onJoins immediately after create, so by the
    // time we observe metadata it should already be Alice. To cover the
    // post-onCreate-pre-onJoin moment, we leave that to a unit-level future
    // test; here we assert the post-first-join steady state.
    await waitFor(async () => (await getRoomMetadata(code))?.hostName === "Alice", 1000);

    const md = await getRoomMetadata(code);
    expect(md?.code).toBe(code);
    expect(md?.hostName).toBe("Alice");

    await room.leave();
  }, 5000);

  it("hostName rotates to next player when host consents to leave", async () => {
    const client = new Client(`ws://localhost:${PORT}`);
    const roomA = await client.create<any>("game", { name: "Alice" });
    await waitFor(() => roomA.state.code !== "" && roomA.state.code != null, 1000);
    const code = roomA.state.code as string;

    const roomB = await client.join<any>("game", { code, name: "Bob" });
    await waitFor(
      () => Array.from(roomA.state.players.keys()).length === 2,
      1000,
    );

    // hostName remains Alice (unchanged on non-host join).
    expect((await getRoomMetadata(code))?.hostName).toBe("Alice");

    // Alice leaves consensually.
    await roomA.leave(true);

    await waitFor(
      async () => (await getRoomMetadata(code))?.hostName === "Bob",
      1000,
    );

    expect((await getRoomMetadata(code))?.hostName).toBe("Bob");

    await roomB.leave();
  }, 5000);

  it("hostName does not change when a non-host leaves", async () => {
    const client = new Client(`ws://localhost:${PORT}`);
    const roomA = await client.create<any>("game", { name: "Alice" });
    await waitFor(() => roomA.state.code !== "" && roomA.state.code != null, 1000);
    const code = roomA.state.code as string;

    const roomB = await client.join<any>("game", { code, name: "Bob" });
    await waitFor(
      () => Array.from(roomA.state.players.keys()).length === 2,
      1000,
    );
    await waitFor(async () => (await getRoomMetadata(code))?.hostName === "Alice", 500);

    // Bob (non-host) leaves.
    await roomB.leave(true);

    // Give the matchmaker a beat to pick up any stray metadata write.
    await new Promise((r) => setTimeout(r, 100));

    expect((await getRoomMetadata(code))?.hostName).toBe("Alice");

    await roomA.leave();
  }, 5000);
});
```

- [ ] **Step 2: Build shared so the server tests can find it**

```bash
pnpm -F @mp/shared build
```

Expected: builds without error. (Server tests import `@mp/shared` via dist/.)

- [ ] **Step 3: Run the test to verify it fails**

```bash
pnpm -F @mp/server test -- listingMetadata
```

Expected: FAIL — both passing-host-name assertions miss because `GameRoom` does not yet write `hostName` to metadata.

- [ ] **Step 4: No commit yet** — test commits with implementation in Task B2.

### Task B2: Implement hostName lifecycle in GameRoom

**Files:**
- Modify: `packages/server/src/GameRoom.ts`

- [ ] **Step 1: Replace the `setMetadata` call in `onCreate`**

In `packages/server/src/GameRoom.ts`, find:

```ts
    this.listing.code = code;
    await this.setMetadata({ code });
```

Replace with:

```ts
    this.listing.code = code;
    await this.setMetadata({ code, hostName: null });
```

- [ ] **Step 2: Set `hostName` on first join**

In the same file, find the `onJoin` method and the line:

```ts
    this.state.players.set(client.sessionId, player);
```

Below it, add:

```ts
    // Listing metadata exposes the host name so the matchmaker's room list
    // shows "hosted by Alice" without needing to expose schema state. First
    // joiner becomes host (onCreate runs before any onJoin — see AD4).
    if ((this.metadata as { hostName?: string | null } | undefined)?.hostName == null) {
      await this.setMetadata({ code: this.state.code, hostName: player.name });
    }
```

Change `onJoin` to `async`:

```ts
override async onJoin(client: Client, options: JoinOptions): Promise<void> {
```

- [ ] **Step 3: Rotate `hostName` on leave**

In `onLeave`, the consented branch currently is:

```ts
    if (consented) {
      this.state.players.delete(client.sessionId);
      this.orbitHitCooldown.evictPlayer(client.sessionId);
      this.contactCooldown.evictPlayer(client.sessionId);
      return;
    }
```

Replace with:

```ts
    if (consented) {
      this.state.players.delete(client.sessionId);
      this.orbitHitCooldown.evictPlayer(client.sessionId);
      this.contactCooldown.evictPlayer(client.sessionId);
      await this.rotateHostIfNeeded(player.name);
      return;
    }
```

And in the post-grace-window branch (the `catch`), find:

```ts
    } catch (err) {
      console.log(
        `[room ${this.state.code}] reconnect grace ended for ${client.sessionId}: ${err === false ? "timeout" : err}`,
      );
      this.state.players.delete(client.sessionId);
      this.orbitHitCooldown.evictPlayer(client.sessionId);
      this.contactCooldown.evictPlayer(client.sessionId);
    }
```

Replace with:

```ts
    } catch (err) {
      console.log(
        `[room ${this.state.code}] reconnect grace ended for ${client.sessionId}: ${err === false ? "timeout" : err}`,
      );
      this.state.players.delete(client.sessionId);
      this.orbitHitCooldown.evictPlayer(client.sessionId);
      this.contactCooldown.evictPlayer(client.sessionId);
      await this.rotateHostIfNeeded(player.name);
    }
```

- [ ] **Step 4: Add the `rotateHostIfNeeded` helper**

Add the following private method to the `GameRoom` class (place above `private tick()`):

```ts
  // If the leaving player was the host, promote the next remaining player
  // (deterministic by MapSchema iteration order — insertion order in
  // Colyseus 0.16). If the room is now empty, hostName becomes null.
  // Cosmetic: the matchmaker listing reflects this; nothing in gameplay
  // depends on it. Safe to call even when the leaver was not the host —
  // it no-ops in that case.
  private async rotateHostIfNeeded(leaverName: string): Promise<void> {
    const md = this.metadata as { code?: string; hostName?: string | null } | undefined;
    if (!md || md.hostName !== leaverName) return;
    const next = this.state.players.values().next();
    const nextName: string | null = next.done ? null : (next.value as { name: string }).name;
    await this.setMetadata({ code: this.state.code, hostName: nextName });
  }
```

- [ ] **Step 5: Run the test**

```bash
pnpm -F @mp/server test -- listingMetadata
```

Expected: all three test cases PASS.

- [ ] **Step 6: Run all server tests to make sure nothing regressed**

```bash
pnpm -F @mp/server test
```

Expected: full server suite PASS.

- [ ] **Step 7: Typecheck**

```bash
pnpm typecheck
```

Expected: PASS across all packages.

- [ ] **Step 8: Commit**

```bash
git add packages/server/src/GameRoom.ts packages/server/test/listingMetadata.test.ts
git commit -m "feat(server): expose hostName on matchmaker listing metadata"
```

---

## Phase C — Client: matchmake fetcher

### Task C1: Write failing test for `matchmakeUrl`

**Files:**
- Create: `packages/client/src/net/matchmake.test.ts`

- [ ] **Step 1: Write the failing test**

Create `packages/client/src/net/matchmake.test.ts` with:

```ts
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { matchmakeUrl, fetchAvailableRooms } from "./matchmake.js";

describe("matchmakeUrl", () => {
  it("converts ws:// to http://", () => {
    expect(matchmakeUrl("ws://localhost:2567")).toBe(
      "http://localhost:2567/matchmake/game",
    );
  });

  it("converts wss:// to https://", () => {
    expect(matchmakeUrl("wss://example.com")).toBe(
      "https://example.com/matchmake/game",
    );
  });

  it("preserves http:// unchanged", () => {
    expect(matchmakeUrl("http://localhost:2567")).toBe(
      "http://localhost:2567/matchmake/game",
    );
  });

  it("preserves https:// unchanged", () => {
    expect(matchmakeUrl("https://example.com")).toBe(
      "https://example.com/matchmake/game",
    );
  });

  it("handles trailing slashes on the base URL", () => {
    expect(matchmakeUrl("ws://localhost:2567/")).toBe(
      "http://localhost:2567/matchmake/game",
    );
  });
});

describe("fetchAvailableRooms", () => {
  const SERVER = "ws://localhost:2567";

  beforeEach(() => {
    vi.stubGlobal("fetch", vi.fn());
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("returns parsed rooms on success", async () => {
    const payload = [
      {
        roomId: "abc",
        clients: 2,
        maxClients: 10,
        metadata: { code: "AB7K", hostName: "Alice" },
      },
    ];
    (fetch as unknown as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      ok: true,
      json: async () => payload,
    });

    const rooms = await fetchAvailableRooms(SERVER);
    expect(rooms).toEqual(payload);
  });

  it("drops rooms missing metadata.code", async () => {
    const payload = [
      { roomId: "good", clients: 1, maxClients: 10, metadata: { code: "AAAA", hostName: null } },
      { roomId: "bad", clients: 1, maxClients: 10, metadata: { hostName: "X" } },
      { roomId: "no-meta", clients: 1, maxClients: 10 },
    ];
    (fetch as unknown as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      ok: true,
      json: async () => payload,
    });

    const rooms = await fetchAvailableRooms(SERVER);
    expect(rooms).toHaveLength(1);
    expect(rooms[0]!.roomId).toBe("good");
  });

  it("normalizes missing hostName to null", async () => {
    const payload = [
      { roomId: "x", clients: 1, maxClients: 10, metadata: { code: "AAAA" } },
    ];
    (fetch as unknown as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      ok: true,
      json: async () => payload,
    });

    const rooms = await fetchAvailableRooms(SERVER);
    expect(rooms[0]!.metadata.hostName).toBeNull();
  });

  it("throws on non-ok response", async () => {
    (fetch as unknown as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      ok: false,
      status: 502,
      statusText: "Bad Gateway",
    });

    await expect(fetchAvailableRooms(SERVER)).rejects.toThrow(/502/);
  });

  it("propagates fetch network errors", async () => {
    (fetch as unknown as ReturnType<typeof vi.fn>).mockRejectedValueOnce(
      new Error("net::ERR_CONNECTION_REFUSED"),
    );

    await expect(fetchAvailableRooms(SERVER)).rejects.toThrow(
      /ERR_CONNECTION_REFUSED/,
    );
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

```bash
pnpm -F @mp/client test -- matchmake
```

Expected: FAIL — `Cannot find module './matchmake.js'` or similar.

- [ ] **Step 3: No commit yet** — implementation follows.

### Task C2: Implement `matchmake.ts`

**Files:**
- Create: `packages/client/src/net/matchmake.ts`

- [ ] **Step 1: Write the implementation**

Create `packages/client/src/net/matchmake.ts` with:

```ts
export type AvailableRoom = {
  roomId: string;
  clients: number;
  maxClients: number;
  metadata: {
    code: string;
    hostName: string | null;
  };
};

// Convert the colyseus.js Client URL (which is ws://... in dev / wss://...
// in prod) into the matchmaker's HTTP listing endpoint. The server speaks
// both on the same host:port; we just swap the protocol.
export function matchmakeUrl(serverUrl: string): string {
  const u = new URL(serverUrl);
  if (u.protocol === "ws:") u.protocol = "http:";
  else if (u.protocol === "wss:") u.protocol = "https:";
  // Strip any trailing slash on the pathname so the join below is clean.
  const base = u.toString().replace(/\/$/, "");
  return `${base}/matchmake/game`;
}

export async function fetchAvailableRooms(
  serverUrl: string,
): Promise<AvailableRoom[]> {
  const res = await fetch(matchmakeUrl(serverUrl));
  if (!res.ok) {
    throw new Error(`matchmake responded ${res.status} ${res.statusText}`);
  }
  const raw = (await res.json()) as Array<{
    roomId?: unknown;
    clients?: unknown;
    maxClients?: unknown;
    metadata?: { code?: unknown; hostName?: unknown };
  }>;

  const rooms: AvailableRoom[] = [];
  for (const r of raw) {
    if (typeof r.roomId !== "string") continue;
    if (typeof r.clients !== "number") continue;
    if (typeof r.maxClients !== "number") continue;
    const code = r.metadata?.code;
    if (typeof code !== "string") continue;
    const hostNameRaw = r.metadata?.hostName;
    const hostName =
      typeof hostNameRaw === "string" ? hostNameRaw : null;
    rooms.push({
      roomId: r.roomId,
      clients: r.clients,
      maxClients: r.maxClients,
      metadata: { code, hostName },
    });
  }
  return rooms;
}
```

- [ ] **Step 2: Run the test**

```bash
pnpm -F @mp/client test -- matchmake
```

Expected: all `matchmakeUrl` and `fetchAvailableRooms` cases PASS.

- [ ] **Step 3: Typecheck**

```bash
pnpm -F @mp/client typecheck
```

Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add packages/client/src/net/matchmake.ts packages/client/src/net/matchmake.test.ts
git commit -m "feat(client): typed matchmake fetcher with ws→http url conversion"
```

### Task C3: Build the `useAvailableRooms` polling hook

**Files:**
- Create: `packages/client/src/landing/useAvailableRooms.ts`

This hook is small (~30 lines). Per the spec, DOM-level tests for it are deferred — manual smoke + the matchmake unit tests cover the important paths.

- [ ] **Step 1: Create the hook**

Create `packages/client/src/landing/useAvailableRooms.ts` with:

```ts
import { useCallback, useEffect, useRef, useState } from "react";
import {
  fetchAvailableRooms,
  type AvailableRoom,
} from "../net/matchmake.js";

const SERVER_URL =
  (import.meta.env.VITE_SERVER_URL as string | undefined) ??
  "ws://localhost:2567";

const DEFAULT_INTERVAL_MS = 3000;

export type UseAvailableRoomsResult = {
  rooms: AvailableRoom[];
  loading: boolean; // true only on initial mount before first poll resolves
  error: Error | null; // most recent poll error; null after a success
  refresh: () => void; // forces an immediate re-poll
};

export function useAvailableRooms(
  intervalMs = DEFAULT_INTERVAL_MS,
): UseAvailableRoomsResult {
  const [rooms, setRooms] = useState<AvailableRoom[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<Error | null>(null);
  // Used by refresh() and by the interval. Captures the latest setters.
  const cancelledRef = useRef(false);

  const poll = useCallback(async () => {
    try {
      const next = await fetchAvailableRooms(SERVER_URL);
      if (cancelledRef.current) return;
      setRooms(next);
      setError(null);
    } catch (err) {
      if (cancelledRef.current) return;
      setError(err instanceof Error ? err : new Error(String(err)));
      // Intentionally do NOT clear `rooms` — keep the last successful list
      // visible across transient errors.
    } finally {
      if (!cancelledRef.current) setLoading(false);
    }
  }, []);

  useEffect(() => {
    cancelledRef.current = false;
    void poll();
    const id = setInterval(() => void poll(), intervalMs);
    return () => {
      cancelledRef.current = true;
      clearInterval(id);
    };
  }, [poll, intervalMs]);

  return { rooms, loading, error, refresh: poll };
}
```

- [ ] **Step 2: Typecheck**

```bash
pnpm -F @mp/client typecheck
```

Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add packages/client/src/landing/useAvailableRooms.ts
git commit -m "feat(client): useAvailableRooms hook polls matchmake every 3s"
```

---

## Phase D — Landing rewrite

### Task D1: Build `RoomRow`

**Files:**
- Create: `packages/client/src/landing/RoomRow.tsx`

- [ ] **Step 1: Write the component**

Create `packages/client/src/landing/RoomRow.tsx` with:

```tsx
import { Card } from "@/components/ui/8bit/card";
import { Badge } from "@/components/ui/8bit/badge";
import { Button } from "@/components/ui/8bit/button";
import type { AvailableRoom } from "../net/matchmake.js";

type Props = {
  room: AvailableRoom;
  canJoin: boolean;       // false when the user has not entered a name
  busy: boolean;          // disables the row while a join is in flight
  onJoin: (code: string) => void;
};

export function RoomRow({ room, canJoin, busy, onJoin }: Props) {
  const isFull = room.clients >= room.maxClients;
  const disabled = isFull || !canJoin || busy;

  return (
    <Card className="flex items-center justify-between p-3 mb-2">
      <div className="flex items-center gap-3">
        <span className="font-bold tracking-widest">
          {room.metadata.code}
        </span>
        <span className="text-sm opacity-80">
          {room.metadata.hostName ?? "—"}
        </span>
      </div>
      <div className="flex items-center gap-3">
        <span className="text-sm tabular-nums">
          {room.clients} / {room.maxClients}
        </span>
        <Badge variant={isFull ? "destructive" : "default"}>
          {isFull ? "Full" : "Joinable"}
        </Badge>
        <Button
          size="sm"
          disabled={disabled}
          onClick={() => onJoin(room.metadata.code)}
          aria-disabled={disabled}
          title={
            isFull
              ? "Room is full"
              : !canJoin
                ? "Enter a display name first"
                : undefined
          }
        >
          Join
        </Button>
      </div>
    </Card>
  );
}
```

Note: 8bitcn's `Badge` may not have a `destructive` variant under that name — adjust to whatever variant 8bitcn ships (`error`, `red`, etc.) when typechecking. The component's API is the same shadcn shape.

- [ ] **Step 2: Typecheck**

```bash
pnpm -F @mp/client typecheck
```

Expected: PASS. If imports or variant names are off, fix them per the actual files installed in Task A4.

### Task D2: Build `RoomList`

**Files:**
- Create: `packages/client/src/landing/RoomList.tsx`

- [ ] **Step 1: Write the component**

Create `packages/client/src/landing/RoomList.tsx` with:

```tsx
import { Card } from "@/components/ui/8bit/card";
import { Button } from "@/components/ui/8bit/button";
import { useAvailableRooms } from "./useAvailableRooms.js";
import { RoomRow } from "./RoomRow.js";

type Props = {
  canJoin: boolean;
  busy: boolean;
  onJoin: (code: string) => void;
};

export function RoomList({ canJoin, busy, onJoin }: Props) {
  const { rooms, loading, error, refresh } = useAvailableRooms();

  return (
    <div className="w-full max-w-xl">
      <div className="flex items-center justify-between mb-2">
        <h2 className="text-lg">Open rooms</h2>
        <div className="flex items-center gap-2">
          {error ? (
            <span className="text-xs opacity-70">couldn't refresh</span>
          ) : null}
          <Button size="sm" variant="ghost" onClick={refresh}>
            Refresh
          </Button>
        </div>
      </div>

      {loading ? (
        <Card className="p-3">Loading rooms…</Card>
      ) : rooms.length === 0 ? (
        <Card className="p-3 opacity-80">
          No rooms yet — click Create to start one.
        </Card>
      ) : (
        rooms.map((room) => (
          <RoomRow
            key={room.roomId}
            room={room}
            canJoin={canJoin}
            busy={busy}
            onJoin={onJoin}
          />
        ))
      )}
    </div>
  );
}
```

- [ ] **Step 2: Typecheck**

```bash
pnpm -F @mp/client typecheck
```

Expected: PASS. Adjust `Button` `variant="ghost"` to whatever 8bitcn supports if it differs.

### Task D3: Build the new `Landing`

**Files:**
- Create: `packages/client/src/landing/Landing.tsx`

- [ ] **Step 1: Write the component**

Create `packages/client/src/landing/Landing.tsx` with:

```tsx
import { useState } from "react";
import type { Room } from "colyseus.js";
import type { RoomState } from "@mp/shared";
import { Card } from "@/components/ui/8bit/card";
import { Input } from "@/components/ui/8bit/input";
import { Button } from "@/components/ui/8bit/button";
import { createRoom, joinRoom } from "../net/client.js";
import { RoomList } from "./RoomList.js";

type Props = {
  onJoined: (room: Room<RoomState>, name: string) => void;
  initialName?: string;
  initialCode?: string;
  banner?: string;
};

export function Landing({
  onJoined,
  initialName = "",
  initialCode = "",
  banner,
}: Props) {
  const [name, setName] = useState(initialName);
  const [code, setCode] = useState(initialCode);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  const trimmedName = name.trim();
  const cleanCode = code.trim().toUpperCase();
  const canCreate = !busy && trimmedName.length > 0;
  const canJoin = canCreate && cleanCode.length === 4;

  const handle = async (action: () => Promise<Room<RoomState>>) => {
    if (busy) return;
    setBusy(true);
    setError("");
    try {
      const room = await action();
      onJoined(room, trimmedName);
    } catch (err) {
      setError((err as Error).message ?? "failed to join");
      setBusy(false);
    }
  };

  return (
    <div
      className="min-h-screen flex flex-col items-center justify-start gap-4 p-6"
      style={{ fontFamily: "'Press Start 2P', system-ui, sans-serif" }}
    >
      <h1 className="text-2xl mt-6">monkey-punch</h1>

      {banner ? (
        <Card className="px-3 py-2 text-sm opacity-90">{banner}</Card>
      ) : null}

      <Card className="w-full max-w-xl p-4 flex flex-col gap-3">
        <label className="flex flex-col gap-1 text-sm">
          Display name
          <Input
            placeholder="display name"
            value={name}
            onChange={(e) => setName(e.target.value)}
            maxLength={24}
          />
        </label>
        <Button
          disabled={!canCreate}
          onClick={() => handle(() => createRoom(trimmedName))}
        >
          Create room
        </Button>
      </Card>

      <RoomList
        canJoin={!busy && trimmedName.length > 0}
        busy={busy}
        onJoin={(c) => handle(() => joinRoom(c, trimmedName))}
      />

      <Card className="w-full max-w-xl p-4 flex flex-col gap-2">
        <div className="text-sm opacity-80">Or join by code</div>
        <div className="flex gap-2">
          <Input
            placeholder="CODE"
            value={code}
            onChange={(e) => setCode(e.target.value.toUpperCase())}
            maxLength={4}
            className="w-28 text-center"
          />
          <Button
            disabled={!canJoin}
            onClick={() => handle(() => joinRoom(cleanCode, trimmedName))}
          >
            Join
          </Button>
        </div>
      </Card>

      <div className="text-xs opacity-70 min-h-4">{error}</div>

      <div
        className="text-[10px] opacity-60 mt-auto"
        style={{ fontFamily: "system-ui, sans-serif" }}
      >
        Character &amp; animations by{" "}
        <a
          href="https://quaternius.com/"
          target="_blank"
          rel="noreferrer"
          className="underline"
        >
          Quaternius
        </a>{" "}
        (CC-BY 3.0)
      </div>
    </div>
  );
}
```

- [ ] **Step 2: Typecheck**

```bash
pnpm -F @mp/client typecheck
```

Expected: PASS.

### Task D4: Switch `App.tsx` to the new Landing and delete the old one

**Files:**
- Modify: `packages/client/src/App.tsx`
- Delete: `packages/client/src/Landing.tsx`

- [ ] **Step 1: Update import in `App.tsx`**

In `packages/client/src/App.tsx`, find:

```ts
import { Landing } from "./Landing.js";
```

Replace with:

```ts
import { Landing } from "./landing/Landing.js";
```

- [ ] **Step 2: Delete the old Landing**

```bash
git rm packages/client/src/Landing.tsx
```

- [ ] **Step 3: Typecheck**

```bash
pnpm typecheck
```

Expected: PASS.

- [ ] **Step 4: Run the client tests**

```bash
pnpm -F @mp/client test
```

Expected: PASS — the existing `serverTime.test.ts` and `prediction.test.ts` continue to pass; new `matchmake.test.ts` passes.

- [ ] **Step 5: Manual smoke test**

```bash
pnpm dev
```

Open `http://localhost:5173`. Verify:

- The new 8bit-styled landing renders with Press Start 2P on the title.
- "No rooms yet" empty card appears initially.
- Enter a name; click "Create room". Game starts (`GameView` mounts with the existing camera, controls, enemies). The room is now joinable.
- Open a second tab on `http://localhost:5173`. The first tab's room appears in the list with code, host name, `1 / 10`, "Joinable" badge.
- Enter a name in tab 2; click the row's "Join" button. Tab 2 joins the same room.
- Watch the count tick to `2 / 10` within ~3 s on tab 1's view (when navigating back).
- Have one tab leave (RunOverPanel → Leave Room). The host name updates within 3 s if the leaver was the host.
- Try the "Or join by code" flow: enter a 4-char code from another tab → still works.

Stop the dev server.

- [ ] **Step 6: Commit**

```bash
git add packages/client/src/App.tsx packages/client/src/landing/
git commit -m "feat(client): 8bit landing page with polled room list"
```

---

## Phase E — Final verification

### Task E1: Whole-repo green build + typecheck + tests

- [ ] **Step 1: Build everything**

```bash
pnpm build
```

Expected: PASS — server, client, and shared all compile.

- [ ] **Step 2: Typecheck**

```bash
pnpm typecheck
```

Expected: PASS.

- [ ] **Step 3: Run all tests**

```bash
pnpm test
```

Expected: PASS — shared, server (including the new `listingMetadata.test.ts`), and client (including the new `matchmake.test.ts`).

- [ ] **Step 4: Final smoke test on a production-style build**

```bash
pnpm -F @mp/client build
pnpm -F @mp/client preview
```

In a separate shell, also run the server:

```bash
pnpm -F @mp/server build
pnpm -F @mp/server start
```

Open the preview URL. Run through the same smoke checklist as Task D4 Step 5. Stop both processes.

- [ ] **Step 5: No commit** — this task only verifies that prior commits compose correctly.

---

## Self-review notes

- **Spec coverage:**
  - AD1 (Tailwind v4 via Vite plugin) → Task A2.
  - AD2 (CSS isolation, preflight on) → Task A2 (`@import "tailwindcss"` in styles.css), verified in A4 Step 4.
  - AD3 (matchmaker metadata, polled, no schema field) → Task B2 (server) + Task C3 (client polling).
  - AD4 (first joiner is host) → Task B2 Step 2 (`onJoin` only sets if `hostName == null`).
  - AD5 (join-by-code stays) → Task D3 (Landing renders the code-input section).
  - AD6 (existing `joinRoom(code, name)`) → Task D3 (`onJoin={(c) => handle(() => joinRoom(c, trimmedName))}`).
  - Server lifecycle (onCreate / onJoin / onLeave consented / onLeave grace) → Tasks B1 (tests) + B2 Steps 1/2/3.
  - `matchmakeUrl` ws→http conversion → Task C2.
  - Boundary filtering (drop missing `metadata.code`, normalize `hostName`) → Task C2.
  - Error retention (keep last list across transient errors) → Task C3.
  - Manual smoke test → Task D4 Step 5 + Task E1 Step 4.

- **Placeholder scan:** none — every step has either a code block, an exact command, or a precise file edit.

- **Type consistency:** `AvailableRoom` is defined in Task C2 and used unchanged in Tasks C3, D1. `RoomMetadata` in B1's test (`{ code: string; hostName: string | null }`) matches the metadata written in B2 Step 1, 2, 4.
