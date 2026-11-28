import type { AppToolRegistry } from "./app-tool-registry";
import { ok, type Result } from "neverthrow";
import type { Conversation, ConversationStore } from "../domain/conversation-store";
import type { OpenParams } from "../domain/agent-port";
import type { DeliveryError, InputAcceptance, OperationError, SendInput } from "./runtime";
export type PreparedDelivery = {
  input: SendInput;
  prefix?: string;
  workspace?: { path: string; id: string };
  release?: () => void;
  before?: () => void;
  committed?: () => void;
  rejected?: () => void;
};
type DeliveryPreparer = (
  conversation: Conversation,
  input: SendInput,
  by: "message" | "resume",
  cancelled?: () => boolean,
) => Promise<Result<PreparedDelivery, DeliveryError>>;
type QueuePreparer = (
  conversation: Conversation,
  input: SendInput,
  cancelled: () => boolean,
  queuedIds: readonly string[],
) => Result<PreparedDelivery, DeliveryError>;

export function prepareAcceptance(prepared: PreparedDelivery, acceptance?: InputAcceptance) {
  if (!prepared.before) return acceptance;
  return {
    ...acceptance,
    events: acceptance?.events ?? [],
    workspace: prepared.workspace,
    before: () => {
      acceptance?.before?.();
      prepared.before?.();
    },
  };
}

export class RunOptions {
  private startGuard?: (conversation: Conversation, checkOwner: boolean) => OperationError | null;
  private preparer?: DeliveryPreparer;
  private queuePreparer?: QueuePreparer;
  private providers: ((conversation: Conversation) => string)[] = [];
  private directories: ((conversation: Conversation) => string[])[] = [];
  private guards: ((
    conversation: Conversation,
    input: SendInput,
  ) => Result<void, DeliveryError> | Promise<Result<void, DeliveryError>>)[] = [];
  private store: ConversationStore;
  private tools: AppToolRegistry;
  constructor(store: ConversationStore, tools: AppToolRegistry) {
    this.store = store;
    this.tools = tools;
  }
  registerInstructions(provider: (conversation: Conversation) => string): void {
    this.providers.push(provider);
  }
  registerAdditionalDirectories(provider: (conversation: Conversation) => string[]): void {
    this.directories.push(provider);
  }
  registerDeliveryGuard(
    guard: (
      conversation: Conversation,
      input: SendInput,
    ) => Result<void, DeliveryError> | Promise<Result<void, DeliveryError>>,
  ): void {
    this.guards.push(guard);
  }
  registerDeliveryPreparer(preparer: DeliveryPreparer): void {
    this.preparer = preparer;
  }
  registerQueuePreparer(preparer: QueuePreparer): void {
    this.queuePreparer = preparer;
  }
  prepareQueue(
    conversation: Conversation,
    input: SendInput,
    cancelled: () => boolean,
    queuedIds: readonly string[],
  ) {
    return (
      this.queuePreparer?.(conversation, input, cancelled, queuedIds) ??
      ok<PreparedDelivery>({ input })
    );
  }
  registerStartGuard(
    guard: (conversation: Conversation, checkOwner: boolean) => OperationError | null,
  ): void {
    this.startGuard = guard;
  }
  checkStart(conversation: Conversation, checkOwner: boolean) {
    return this.startGuard?.(conversation, checkOwner) ?? null;
  }
  prepareDelivery(
    conversation: Conversation,
    input: SendInput,
    by: "message" | "resume",
    cancelled?: () => boolean,
  ) {
    return (
      this.preparer?.(conversation, input, by, cancelled) ??
      Promise.resolve(ok<PreparedDelivery>({ input }))
    );
  }
  build(
    conversation: Conversation,
  ): Pick<
    OpenParams,
    "cwd" | "model" | "permissionMode" | "appendSystemPrompt" | "appTools" | "additionalDirectories"
  > {
    const directories = [
      ...new Set(this.directories.flatMap((provider) => provider(conversation))),
    ];
    return {
      ...(directories.length ? { additionalDirectories: directories } : {}),
      cwd: conversation.cwd,
      appTools: this.tools.all(conversation.kind),
      ...this.store.projectOptions(conversation.projectId),
      appendSystemPrompt: this.providers
        .map((provider) => provider(conversation))
        .filter(Boolean)
        .join("\n\n"),
    };
  }
  async allowDelivery(
    conversation: Conversation,
    input: SendInput,
  ): Promise<Result<void, DeliveryError>> {
    for (const guard of this.guards) {
      const result = await guard(conversation, input);
      if (result.isErr()) return result;
    }
    return ok(undefined);
  }
}
