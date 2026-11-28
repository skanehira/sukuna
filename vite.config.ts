import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import devServer from "@hono/vite-dev-server";
import { execSync } from "node:child_process";
import { defineConfig } from "vite-plus";
import type { Plugin } from "vite";
import {
  allowsRequestAuthority,
  restrictNetworkAccess,
  serverHostnames,
} from "./src/server/network-access";

type RuntimeModule = Pick<
  typeof import("./src/server/runtime"),
  "initializeRuntime" | "createRuntimeUpgradeHandler" | "getPtySessions"
>;

function webSocketUpgrade(): Plugin {
  let hostnames: ReadonlySet<string> = new Set();
  let closeTerminals: (() => Promise<void>) | undefined;
  return {
    name: "sukuna:ws-upgrade",
    async config(_config, { command }) {
      if (command !== "serve") return;
      hostnames = await serverHostnames();
      return { server: { allowedHosts: Array.from(hostnames) } };
    },
    async configureServer(server) {
      const httpServer = server.httpServer;
      if (httpServer === null) return;
      restrictNetworkAccess(httpServer);
      server.middlewares.use((request, response, next) => {
        if (allowsRequestAuthority(request.headers.host, hostnames)) return next();
        response.writeHead(403).end("Forbidden");
      });
      const runtime = (await server.ssrLoadModule("/src/server/runtime.ts")) as RuntimeModule;
      const initialized = await runtime.initializeRuntime();
      if (initialized.isErr()) throw new Error(initialized.error.message);
      const handleUpgrade = runtime.createRuntimeUpgradeHandler({ hostnames });
      httpServer.on("upgrade", handleUpgrade);
      const terminals = runtime.getPtySessions();
      const interrupt = () => {
        void server.close().then(
          () => process.exit(130),
          (error: unknown) => {
            server.config.logger.error(String(error));
            process.exit(1);
          },
        );
      };
      process.on("SIGINT", interrupt);
      closeTerminals = async () => {
        httpServer.off("upgrade", handleUpgrade);
        try {
          await terminals.close();
        } finally {
          process.off("SIGINT", interrupt);
        }
      };
    },
    closeServer() {
      return closeTerminals?.();
    },
  };
}

const isTest = Boolean(process.env.VITEST);

function createBuildId(): string {
  const now = new Date();
  const date = `${now.getFullYear()}${String(now.getMonth() + 1).padStart(2, "0")}${String(now.getDate()).padStart(2, "0")}`;
  let revision: string;
  try {
    revision = execSync("git rev-parse --short HEAD", { encoding: "utf8" }).trim();
  } catch {
    revision = "unknown";
  }
  return `${date}-${revision}`;
}

const buildId = createBuildId();

export default defineConfig({
  define: {
    __SUKUNA_BUILD_ID__: JSON.stringify(buildId),
  },

  plugins: [
    react(),
    tailwindcss(),
    !isTest && webSocketUpgrade(),
    !isTest &&
      devServer({
        entry: "src/server/dev.ts",
        exclude: [/^(?!\/api(\/|$)).*/],
        injectClientScript: false,
      }),
  ],

  environments: {
    client: {
      build: { outDir: "dist/client" },
    },
    server: {
      consumer: "server",
      resolve: { external: ["node-pty"] },
      input: "src/server/main.ts",
      build: { outDir: "dist/server" },
    },
    installer: {
      consumer: "server",
      input: "src/server/install.ts",
      build: { outDir: "dist/server", emptyOutDir: false },
    },
    runner: {
      consumer: "server",
      input: "src/runner/main.ts",
      build: { outDir: "dist/runner" },
    },
  },

  builder: {},

  fmt: {
    ignorePatterns: ["docs/**"],
  },

  lint: {
    options: {
      typeAware: true,
      typeCheck: true,
    },
    rules: {
      "no-restricted-imports": [
        "error",
        {
          paths: [
            {
              name: "react",
              importNames: ["useEffect"],
              message:
                "useEffect は誤用が多いため禁止。どうしても必要な場合は該当行に oxlint-disable コメントを付けて理由を明記する。",
            },
          ],
        },
      ],
    },
    overrides: [
      {
        files: ["src/front/**"],
        rules: {
          "no-restricted-imports": [
            "error",
            {
              paths: [
                {
                  name: "react",
                  importNames: ["useEffect"],
                  message:
                    "useEffect は誤用が多いため禁止。どうしても必要な場合は該当行に oxlint-disable コメントを付けて理由を明記する。",
                },
              ],
              patterns: [
                {
                  group: ["**/server/**", "**/runner/**"],
                  message:
                    "境界違反: src/front は src/server と src/runner を import できない。通信は HTTP と WebSocket で行い、共有する型は src/shared に置く。",
                },
              ],
            },
          ],
        },
      },
      {
        files: ["src/**/domain/**"],
        rules: {
          "no-restricted-imports": [
            "error",
            {
              patterns: [
                {
                  group: [
                    "**/adapter/**",
                    "**/adapters/**",
                    "**/infrastructure/**",
                    "**/infra/**",
                    "**/presentation/**",
                    "**/middleware/**",
                    "**/routes/**",
                    "**/db/**",
                    "**/usecase/**",
                    "**/usecases/**",
                    "**/application/**",
                    "**/front/**",
                    "**/server/**",
                    "**/runner/**",
                  ],
                  message:
                    "Clean Architecture 違反: domain 層は外側のレイヤに依存できない。domain に Port (interface) を定義し、外側に Adapter 実装を置いて DI で繋ぐ。",
                },
                {
                  group: [
                    "hono",
                    "hono/*",
                    "@hono/*",
                    "drizzle-orm",
                    "drizzle-orm/*",
                    "better-sqlite3",
                    "ws",
                    "react",
                    "react/*",
                    "react-dom",
                    "react-dom/*",
                    "react-router",
                    "react-router/*",
                    "swr",
                    "swr/*",
                  ],
                  message:
                    "Clean Architecture 違反: domain 層はフレームワーク・IO ライブラリに依存できない。IO は関数注入 (DI) で外側から渡す。",
                },
              ],
            },
          ],
        },
      },
      {
        files: ["src/**/usecase/**", "src/**/usecases/**", "src/**/application/**"],
        rules: {
          "no-restricted-imports": [
            "error",
            {
              patterns: [
                {
                  group: [
                    "**/adapter/**",
                    "**/adapters/**",
                    "**/infrastructure/**",
                    "**/infra/**",
                    "**/presentation/**",
                    "**/middleware/**",
                    "**/routes/**",
                    "**/db/**",
                    "**/front/**",
                    "**/server/**",
                    "**/runner/**",
                  ],
                  message:
                    "Clean Architecture 違反: usecase 層は外側のレイヤに依存できない。domain の Port (interface) を介して DI で受け取る。",
                },
                {
                  group: [
                    "hono",
                    "hono/*",
                    "@hono/*",
                    "drizzle-orm",
                    "drizzle-orm/*",
                    "better-sqlite3",
                    "ws",
                    "react",
                    "react/*",
                    "react-dom",
                    "react-dom/*",
                    "react-router",
                    "react-router/*",
                    "swr",
                    "swr/*",
                  ],
                  message:
                    "Clean Architecture 違反: usecase 層はフレームワーク・IO ライブラリに依存できない。IO は関数注入 (DI) で外側から渡す。",
                },
              ],
            },
          ],
        },
      },
    ],
  },

  test: {
    projects: [
      {
        extends: true,
        test: {
          name: "front",
          environment: "jsdom",
          globals: true,
          setupFiles: ["./src/test/setup.ts", "./src/test/fast-check.ts"],
          include: ["src/front/**/*.test.{ts,tsx}"],
        },
      },
      {
        extends: true,
        test: {
          name: "server",
          environment: "node",
          globals: true,
          setupFiles: ["./src/test/fast-check.ts"],
          include: [
            "src/server/**/*.test.ts",
            "src/runner/**/*.test.ts",
            "src/shared/**/*.test.ts",
            "scripts/**/*.test.ts",
          ],
        },
      },
    ],
  },
});
