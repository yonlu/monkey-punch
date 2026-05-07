import { Server } from "colyseus";
import { listen } from "@colyseus/tools";
import { Encoder } from "@colyseus/schema";
import { GameRoom } from "./GameRoom.js";

// @colyseus/schema's default Encoder.BUFFER_SIZE is 8 KB. M4 combat at the
// `}` debug burst (200–300 enemies) produces ~11.5 KB full-state and
// transiently larger patch-encoded buffers, which spams "buffer overflow"
// warnings every tick. 32 KB gives ~3× headroom over the measured 300-enemy
// peak; bump higher if a future milestone pushes entity count further.
Encoder.BUFFER_SIZE = 32 * 1024;

const gameServer = new Server();

gameServer
  .define("game", GameRoom)
  .filterBy(["code"]);

// `listen()` from @colyseus/tools is cloud-aware: on Colyseus Cloud each PM2
// fork listens on a per-instance Unix socket (/run/colyseus/${port}.sock)
// instead of competing for the same TCP port, which is what makes rolling
// deploys (pm2.scale 1→2→1) work without EADDRINUSE. Locally it falls back
// to TCP on PORT (default 2567), with NODE_APP_INSTANCE-based offset.
listen(gameServer).catch((err) => {
  console.error("[server] failed to start:", err);
  process.exit(1);
});
