const keepAlive = setInterval(() => {}, 60_000);

function shutdown(signal: NodeJS.Signals): void {
  clearInterval(keepAlive);
  console.log(
    JSON.stringify({
      time: new Date().toISOString(),
      level: "info",
      component: "runner",
      message: `received ${signal}`,
    }),
  );
  process.exit(0);
}

process.once("SIGTERM", shutdown);
process.once("SIGINT", shutdown);

console.log(
  JSON.stringify({
    time: new Date().toISOString(),
    level: "info",
    component: "runner",
    message: "started",
  }),
);
