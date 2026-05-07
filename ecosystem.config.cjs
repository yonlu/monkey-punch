module.exports = {
  apps: [
    {
      name: "monkey-punch",
      // Monorepo: server compiles to packages/server/dist/index.js (not build/).
      script: "packages/server/dist/index.js",
      time: true,
      watch: false,
      instances: 1,
      exec_mode: "fork",
      // listen() from @colyseus/tools emits process.send("ready") once the
      // socket is bound; PM2 only swaps traffic to a new fork after that
      // signal, which is what enables zero-downtime rolling deploys on
      // Colyseus Cloud (pm2.scale 1→2→1).
      wait_ready: true,
    },
  ],
};
