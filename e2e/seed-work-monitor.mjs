import { mkdirSync, writeFileSync } from "node:fs";
import { request } from "node:http";
import { join } from "node:path";
import Database from "better-sqlite3";

const [home, socketPath, configDir] = process.argv.slice(2);
const id = "e2e-work-monitor";
const sessionId = "e2e-work-monitor-session";
const now = Date.now();
const project = join(home, "shop-api");
const database = new Database(join(home, "data", "sukuna", "sukuna.db"), { fileMustExist: true });
try {
  database
    .prepare(
      "INSERT INTO conversations (id, project_id, kind, cwd, title, session_id) VALUES (?, 'e2e-shop-api', 'chat', ?, '注文 CSV の準備', ?)",
    )
    .run(id, project, sessionId);
} finally {
  database.close();
}

const directory = join(configDir, "timeline", "sessions");
mkdirSync(directory, { recursive: true });
writeFileSync(
  join(directory, sessionId + ".json"),
  JSON.stringify({
    version: 1,
    journal: [
      {
        at: now - 18 * 60_000,
        toolUseId: "prepare-tasks",
        ops: [
          { op: "add", id: "csv", title: "注文 CSV の準備" },
          {
            op: "add",
            id: "encoding",
            parent: "csv",
            title: "文字コードの判定",
            status: "completed",
          },
          {
            op: "add",
            id: "export",
            parent: "csv",
            title: "CSV の書き出し",
            weight: 2,
            status: "in_progress",
            done: [1, 2],
            description: "判定した文字コードで注文データを書き出す。",
            note: "正常系の出力を確認済み。",
          },
          { op: "add", id: "excel", parent: "csv", title: "Excel で表示を確認" },
        ],
      },
      {
        at: now - 3 * 60_000,
        toolUseId: "export-progress",
        ops: [{ op: "update", id: "export", note: "改行を含む商品名を確認中。" }],
      },
    ],
    reports: [
      { at: now - 6 * 60_000, text: "文字コードの判定を始めた。" },
      { at: now - 3 * 60_000, text: "正常系を書き出し、商品名を含む行を確認中。" },
    ],
    comments: [
      {
        at: now - 4 * 60_000,
        taskId: "export",
        text: "商品名に改行がある場合も確認してください。",
      },
    ],
  }),
);

await new Promise((resolve, reject) => {
  const req = request(
    {
      socketPath,
      path: `/conversations/${id}/messages`,
      method: "POST",
      headers: { "content-type": "application/json" },
      timeout: 10_000,
    },
    (res) => {
      let body = "";
      res.setEncoding("utf8");
      res.on("data", (chunk) => {
        body += chunk;
      });
      res.on("end", () => {
        if (res.statusCode < 400) resolve();
        else reject(new Error(`作業中の E2E データを作れませんでした: ${res.statusCode} ${body}`));
      });
    },
  );
  req.on("timeout", () => req.destroy(new Error("E2E の作業開始がタイムアウトしました。")));
  req.on("error", reject);
  req.end(
    JSON.stringify({
      text: "タイムラインの作業を始める",
      images: [],
      origin: "developer",
      interrupt: false,
      client_id: "e2e-timeline-start",
    }),
  );
});
