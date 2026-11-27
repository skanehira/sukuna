import { startDatabase } from "../shared/db/startup";

const database = await startDatabase();
if (database.isErr()) {
  console.log(
    JSON.stringify({
      time: new Date().toISOString(),
      level: "error",
      component: "db.migrate",
      message: database.error.message,
    }),
  );
  process.exit(1);
}

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
