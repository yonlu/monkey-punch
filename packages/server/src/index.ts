import { Server, matchMaker } from "colyseus";
import { listen } from "@colyseus/tools";
import { Encoder } from "@colyseus/schema";
import { GameRoom } from "./GameRoom.js";

// @colyseus/schema's default Encoder.BUFFER_SIZE is 8 KB. M4 combat at the
// `}` debug burst (200–300 enemies) produces ~11.5 KB full-state and
// transiently larger patch-encoded buffers, which spams "buffer overflow"
// warnings every tick. 32 KB gives ~3× headroom over the measured 300-enemy
// peak; bump higher if a future milestone pushes entity count further.
Encoder.BUFFER_SIZE = 32 * 1024;

// `listen()` from @colyseus/tools is cloud-aware: on Colyseus Cloud each PM2
// fork listens on a per-instance Unix socket (/run/colyseus/${port}.sock)
// instead of competing for the same TCP port, which is what makes rolling
// deploys (pm2.scale 1→2→1) work without EADDRINUSE. Locally it falls back
// to TCP on PORT (default 2567), with NODE_APP_INSTANCE-based offset.
listen({
  initializeGameServer: (gameServer: Server) => {
    gameServer.define("game", GameRoom).filterBy(["code"]);
  },
  initializeExpress: (app) => {
    // GET /rooms/:roomName — matchmaker listing for the in-app room browser.
    // Colyseus 0.16's built-in /matchmake/* handler returns 404 for GET; this
    // is a small custom route under a different path so it doesn't get
    // intercepted by attachMatchMakingRoutes (Server.js:192-204).
    //
    // We type req/res structurally rather than pulling in @types/express:
    // this server doesn't depend on it, and @colyseus/tools' typings expose
    // `app` as `express.Express` which collapses to `any` without those types.
    type RouteReq = { params: { roomName: string } };
    type RouteRes = {
      setHeader: (k: string, v: string) => void;
      json: (body: unknown) => void;
      status: (code: number) => RouteRes;
    };
    app.get("/rooms/:roomName", async (req: RouteReq, res: RouteRes) => {
      // Mirror the CORS behavior of Colyseus's POST handler so the client
      // (served on a different origin in dev — vite at :5173) can read it.
      const corsHeaders = matchMaker.controller.DEFAULT_CORS_HEADERS as
        Record<string, string>;
      for (const [k, v] of Object.entries(corsHeaders)) {
        res.setHeader(k, v);
      }
      try {
        const rooms = await matchMaker.query({ name: req.params.roomName });
        res.json(
          rooms.map((r) => ({
            roomId: r.roomId,
            clients: r.clients,
            maxClients: r.maxClients,
            metadata: r.metadata,
          })),
        );
      } catch (err) {
        res.status(500).json({ error: (err as Error).message });
      }
    });
  },
}).catch((err) => {
  console.error("[server] failed to start:", err);
  process.exit(1);
});
