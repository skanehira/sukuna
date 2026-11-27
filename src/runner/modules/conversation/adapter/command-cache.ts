type Command = { name: string; description: string };
export class CommandCache {
  private conversations = new Map<string, Command[]>();
  private projects = new Map<string, Command[]>();
  remember(conversationId: string, projectId: string, commands: Command[]): void {
    this.conversations.set(conversationId, commands);
    this.projects.set(projectId, commands);
  }
  read(conversationId: string, projectId: string): Command[] {
    return this.conversations.get(conversationId) ?? this.projects.get(projectId) ?? [];
  }
}
