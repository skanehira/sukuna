import type { ConversationKind } from "../domain/conversation-store";
import type { AppTool } from "../domain/agent-port";
export class AppToolRegistry {
  private tools = new Map<string, { tool: AppTool; kinds?: ConversationKind[] }>();
  register(tool: AppTool, kinds?: ConversationKind[]): void {
    this.tools.set(tool.name, { tool, kinds });
  }
  all(kind?: ConversationKind): AppTool[] {
    return [...this.tools.values()]
      .filter(
        (entry) => kind === undefined || entry.kinds === undefined || entry.kinds.includes(kind),
      )
      .map((entry) => entry.tool);
  }
}
