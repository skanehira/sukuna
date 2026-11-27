import type { BufferController } from "../../buffer/controller";
import type { Conversation } from "../conversation/types";
import type { TimerPort } from "../../buffer/position-store";
import type { ServerMessage } from "../../../shared/ws";
import type { FilesApi } from "./api";

export type FileScope = Pick<Conversation, "id" | "cwd" | "lastSeq"> & {
  threads?: {
    complete: boolean;
    after: ReadonlyMap<string, number | null>;
  };
  observedThrough?: ReadonlyMap<string, number>;
};
export type FileRecovery = { replaySignal: AbortSignal; recheck(): void; reconnected(): void };
export type FileControls = { reload(): void; toggle(): void };
export type TreeControls = {
  reload(): void;
  reveal(path: string | undefined): void;
  folder(open: boolean): void;
};
export type FileViewContext = {
  api: FilesApi;
  controller: BufferController;
  schedule: TimerPort["schedule"];
  readStart(scope: FileScope): FileScope;
  watch(
    scope: FileScope,
    listener: (message: ServerMessage) => void,
    recovery?: FileRecovery,
  ): () => void;
  search(id: string, mode: "content" | "name", query: string): ReturnType<FilesApi["search"]>;
  openFile(id: string, path: string, line: number, column?: number): Promise<void>;
  openChanges(id: string): void;
  openRecord(id: string, seq: number): void;
  reloadTree(id: string): void;
  controlFile(url: string, controls: FileControls): () => void;
  controlTree(id: string, controls: TreeControls): () => void;
  treeFolders(id: string): ReadonlySet<string>;
  rememberFolders(id: string, expanded: ReadonlySet<string>): void;
};
