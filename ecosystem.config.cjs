const os = require("os");

module.exports = {
  apps: [
    {
      name: "monkey-punch",
      // Monorepo: server compiles to packages/server/dist/index.js (not build/).
      script: "packages/server/dist/index.js",
      time: true,
      watch: false,
      instances: os.cpus().length,
      exec_mode: "fork",
      wait_ready: false,
    },
  ],
};
