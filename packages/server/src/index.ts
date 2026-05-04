import { Server } from "colyseus";
import { GameRoom } from "./GameRoom.js";

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
