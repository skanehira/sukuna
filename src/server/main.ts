import { serve } from "@hono/node-server";
import { fileURLToPath } from "node:url";
import { createApp } from "./app";
import { buildId } from "./build-id";
import { attachUpgradeHandler } from "./runtime";

const port = Number(process.env.PORT ?? 4580);
const clientDir = fileURLToPath(new URL("../client", import.meta.url));

const server = serve(
  { fetch: createApp({ clientDir, build: buildId }).fetch, port, hostname: "0.0.0.0" },
  (info) => {
    console.log(
      JSON.stringify({
        time: new Date().toISOString(),
        level: "info",
        component: "server",
        message: `listening on http://${info.address}:${info.port}`,
      }),
    );
  },
);

attachUpgradeHandler(server);
