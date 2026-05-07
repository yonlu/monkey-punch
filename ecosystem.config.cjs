module.exports = {
  apps: [
    {
      name: "monkey-punch",
      // Monorepo: server compiles to packages/server/dist/index.js (not build/).
      script: "packages/server/dist/index.js",
      time: true,
      watch: false,
      // Single fork: server uses `new Server()` (not defineServer + cluster
      // transport), so multiple forks would race to bind the same port.
      instances: 1,
      exec_mode: "fork",
      wait_ready: false,
    },
  ],
};
