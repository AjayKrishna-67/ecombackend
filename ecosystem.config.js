module.exports = {
  apps: [
    {
      name: "vendure-server",
      script: "./dist/src/index.js", // Path to your built Vendure server file
      exec_mode: "fork", // Enable cluster mode
      instances: "1", // Adjust based on CPU cores
      watch: false, // Disable watching for production
      max_memory_restart: "900M", // Restart if memory exceeds 900MB
      env: { TZ: "UTC" },
    },
    {
      name: "vendure-worker",
      script: "./dist/src/index-worker.js", // Path to your worker file
      exec_mode: "fork", // Enable cluster mode
      instances: "1", // Adjust based on CPU cores
      watch: false, // Disable watching for production
      max_memory_restart: "900M", // Restart if memory exceeds 900MB
      env: { TZ: "UTC" },
    },
  ],
};