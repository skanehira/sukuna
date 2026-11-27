import type { AppTool } from "../domain/agent-port";
export class AppToolRegistry {
  private tools = new Map<string, AppTool>();
  register(tool: AppTool): void {
    this.tools.set(tool.name, tool);
  }
  all(): AppTool[] {
    return [...this.tools.values()];
  }
}
