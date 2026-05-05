import { Server } from "colyseus";
import { Encoder } from "@colyseus/schema";
import { GameRoom } from "./GameRoom.js";

// @colyseus/schema's default Encoder.BUFFER_SIZE is 8 KB. M4 combat at the
// `}` debug burst (200–300 enemies) produces ~11.5 KB full-state and
// transiently larger patch-encoded buffers, which spams "buffer overflow"
// warnings every tick. 32 KB gives ~3× headroom over the measured 300-enemy
// peak; bump higher if a future milestone pushes entity count further.
Encoder.BUFFER_SIZE = 32 * 1024;

const port = Number(process.env.PORT ?? 2567);
const gameServer = new Server();

gameServer
  .define("game", GameRoom)
  .filterBy(["code"]);

gameServer
  .listen(port)
  .then(() => {
    console.log(`[server] listening on ws://localhost:${port}`);
  })
  .catch((err) => {
    console.error("[server] failed to start:", err);
    process.exit(1);
  });
