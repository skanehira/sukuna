import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vite-plus/test";
import { parseDecisionFile } from "./decision-file";

const repo = fileURLToPath(new URL("../../../", import.meta.url));
type WriterProcess = {
  process: ChildProcessWithoutNullStreams;
  exited: Promise<number | null>;
  next(event: string): Promise<Record<string, unknown>>;
};
const script = `
import { createServer } from 'vite';
import * as fs from 'node:fs';
import { join } from 'node:path';
const input = JSON.parse(process.argv[1]);
const server = await createServer({configFile:false, root:process.cwd(), server:{middlewareMode:true, ws:false, watch:null}, appType:'custom', optimizeDeps:{entries:[]}});
const publish = (message) => console.log(JSON.stringify(message));
try {
  const { createDecisionFileStore } = await server.ssrLoadModule('/src/shared/recap/decision-file-store.ts');
  const { parseDecisionFile, replaceDecisionItems } = await server.ssrLoadModule('/src/shared/recap/decision-file.ts');
  const { createDecisionFileLock } = await server.ssrLoadModule('/src/shared/recap/decision-file-lock.ts');
  const io = {
    read: path => { try { return fs.readFileSync(path,'utf8'); } catch(error) { if(error.code==='ENOENT') return null; throw error; } },
    directory: path => { if(!fs.statSync(path).isDirectory()) throw new Error('directory'); },
    write: (path, content) => { fs.mkdirSync(join(path,'..'),{recursive:true}); fs.writeFileSync(path,content,{flag:'wx'}); },
    rename: (from,to) => {
      if(input.hold) { publish({event:'beforeRename'}); fs.readFileSync(0); }
      fs.renameSync(from,to);
    },
    remove: path => fs.rmSync(path,{force:true}),
    temporary: path => path+'.'+process.pid+'.tmp',
  };
  const lock = createDecisionFileLock({ directory: join(input.root,'locks'), timeoutMs: input.timeout ?? 5000 });
  const store = createDecisionFileStore(io,lock);
  publish({event:'started'});
  const result = store.update(input.root,input.conversation,'test', content => replaceDecisionItems(content,[...parseDecisionFile(content),{id:input.id,kind:'decision',text:input.id,reason:null,seq:null,changedTo:null}]),input.baseHash);
  publish(result.isOk() ? {event:'result',ok:true,items:result.value.items} : {event:'result',ok:false,error:result.error});
} finally { await server.close(); }
`;

describe("決まったことの複数プロセスの保存", () => {
  let root: string;
  const children: WriterProcess[] = [];
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "sukuna-decisions-process-"));
  });
  afterEach(async () => {
    for (const child of children.splice(0)) {
      if (child.process.exitCode === null && child.process.signalCode === null)
        child.process.kill("SIGKILL");
      await child.exited;
    }
    rmSync(root, { recursive: true, force: true });
  });
  function writer(input: {
    conversation: string;
    id: string;
    hold?: boolean;
    timeout?: number;
    baseHash?: string;
  }): WriterProcess {
    const process = spawn(
      globalThis.process.execPath,
      ["--input-type=module", "-e", script, JSON.stringify({ root, ...input })],
      { cwd: repo, stdio: ["pipe", "pipe", "pipe"] },
    );
    let stderr = "";
    process.stderr.on("data", (data: Buffer) => {
      stderr += data.toString();
    });
    const messages: Record<string, unknown>[] = [];
    const listeners = new Set<() => void>();
    const lines = createInterface({ input: process.stdout });
    lines.on("line", (line) => {
      if (line.startsWith("{")) {
        messages.push(JSON.parse(line));
        for (const listener of listeners) listener();
      }
    });
    const exited = new Promise<number | null>((resolve) => process.once("exit", resolve));
    const next = (event: string): Promise<Record<string, unknown>> =>
      new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          listeners.delete(receive);
          reject(new Error(`process ${event} timed out: ${stderr}`));
        }, 5000);
        function receive() {
          const index = messages.findIndex((message) => message.event === event);
          if (index === -1) return;
          clearTimeout(timer);
          listeners.delete(receive);
          resolve(messages.splice(index, 1)[0]);
        }
        listeners.add(receive);
        receive();
      });
    const child = { process, exited, next };
    children.push(child);
    return child;
  }
  function initial() {
    mkdirSync(join(root, "docs/decisions"), { recursive: true });
    const source = "手書きの文\n";
    writeFileSync(join(root, "docs/decisions/c.md"), source);
    return createHash("sha256").update(source).digest("hex");
  }
  it("確認後から置換前も同じファイルを排他し、別会話の保存は通す", async () => {
    initial();
    const first = writer({ conversation: "c", id: "D1", hold: true });
    await first.next("beforeRename");
    const contender = writer({ conversation: "c", id: "D2", timeout: 0 });
    expect(await contender.next("result")).toEqual({
      event: "result",
      ok: false,
      error: {
        code: "conflict",
        message:
          "決まったことのファイルを別のプロセスが保存しています。少し待ってから、もう一度保存してください。",
      },
    });
    const independent = writer({ conversation: "other", id: "D3", timeout: 0 });
    expect(await independent.next("result")).toEqual({
      event: "result",
      ok: true,
      items: [{ id: "D3", kind: "decision", text: "D3", reason: null, seq: null, changedTo: null }],
    });
    first.process.stdin.end();
    expect(await first.next("result")).toEqual({
      event: "result",
      ok: true,
      items: [{ id: "D1", kind: "decision", text: "D1", reason: null, seq: null, changedTo: null }],
    });
    const retry = writer({ conversation: "c", id: "D2" });
    expect(await retry.next("result")).toEqual({
      event: "result",
      ok: true,
      items: [
        { id: "D1", kind: "decision", text: "D1", reason: null, seq: null, changedTo: null },
        { id: "D2", kind: "decision", text: "D2", reason: null, seq: null, changedTo: null },
      ],
    });
    const content = readFileSync(join(root, "docs/decisions/c.md"), "utf8");
    expect(content).toBe(
      '<!-- sukuna-decisions:v2 -->\n手書きの文\n- [決定] D1: "D1"\n- [決定] D2: "D2"\n',
    );
  });
  it.each([false, true])(
    "排他待ち後の baseHash 有無 %s は新しい内容へ当て直すか競合にする",
    async (useBase) => {
      const baseHash = initial();
      const first = writer({ conversation: "c", id: "D1", hold: true });
      await first.next("beforeRename");
      const second = writer({ conversation: "c", id: "D2", ...(useBase ? { baseHash } : {}) });
      await second.next("started");
      first.process.stdin.end();
      await first.next("result");
      const result = await second.next("result");
      if (useBase)
        expect(result).toEqual({
          event: "result",
          ok: false,
          error: {
            code: "conflict",
            message: "決まったことのファイルが変わりました。読み直して、もう一度保存してください。",
          },
        });
      else
        expect(result).toEqual({
          event: "result",
          ok: true,
          items: [
            { id: "D1", kind: "decision", text: "D1", reason: null, seq: null, changedTo: null },
            { id: "D2", kind: "decision", text: "D2", reason: null, seq: null, changedTo: null },
          ],
        });
      expect(parseDecisionFile(readFileSync(join(root, "docs/decisions/c.md"), "utf8"))).toEqual(
        useBase
          ? [{ id: "D1", kind: "decision", text: "D1", reason: null, seq: null, changedTo: null }]
          : [
              { id: "D1", kind: "decision", text: "D1", reason: null, seq: null, changedTo: null },
              { id: "D2", kind: "decision", text: "D2", reason: null, seq: null, changedTo: null },
            ],
      );
    },
  );
  it("書き手が強制終了しても OS が排他を解放して次の保存が通る", async () => {
    initial();
    const first = writer({ conversation: "c", id: "D1", hold: true });
    await first.next("beforeRename");
    first.process.kill("SIGKILL");
    await first.exited;
    const next = writer({ conversation: "c", id: "D2", timeout: 0 });
    expect(await next.next("result")).toEqual({
      event: "result",
      ok: true,
      items: [{ id: "D2", kind: "decision", text: "D2", reason: null, seq: null, changedTo: null }],
    });
    expect(readFileSync(join(root, "docs/decisions/c.md"), "utf8")).toBe(
      '<!-- sukuna-decisions:v2 -->\n手書きの文\n- [決定] D2: "D2"\n',
    );
  });
});
