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
