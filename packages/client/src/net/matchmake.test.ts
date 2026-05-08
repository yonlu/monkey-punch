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
