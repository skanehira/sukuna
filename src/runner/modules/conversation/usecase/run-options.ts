import type { AppToolRegistry } from "./app-tool-registry";
import { ok, type Result } from "neverthrow";
import type { Conversation, ConversationStore } from "../domain/conversation-store";
import type { OpenParams } from "../domain/agent-port";
import type { DeliveryError, SendInput } from "./runtime";
export class RunOptions {
  private providers: ((conversation: Conversation) => string)[] = [];
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
  registerDeliveryGuard(
    guard: (
      conversation: Conversation,
      input: SendInput,
    ) => Result<void, DeliveryError> | Promise<Result<void, DeliveryError>>,
  ): void {
    this.guards.push(guard);
  }
  build(
    conversation: Conversation,
  ): Pick<OpenParams, "cwd" | "model" | "permissionMode" | "appendSystemPrompt" | "appTools"> {
    return {
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
