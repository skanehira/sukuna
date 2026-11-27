export type LogLevel = "debug" | "info" | "warn" | "error";
export type LogEntry = {
  level: LogLevel;
  component: string;
  message: string;
  conversation_id?: string;
  issue_id?: string;
  error?: unknown;
};
export type Logger = (entry: LogEntry) => void;
export function createLogger(options: {
  now: () => number;
  write: (line: string) => void;
  level: LogLevel;
}): Logger {
  const levels: LogLevel[] = ["debug", "info", "warn", "error"];
  return ({ level, component, message, conversation_id, issue_id, error }) => {
    if (levels.indexOf(level) < levels.indexOf(options.level)) return;
    options.write(
      JSON.stringify({
        time: new Date(options.now()).toISOString(),
        level,
        component,
        message,
        ...(conversation_id === undefined ? {} : { conversation_id }),
        ...(issue_id === undefined ? {} : { issue_id }),
        ...(error === undefined
          ? {}
          : {
              error:
                error instanceof Error
                  ? {
                      name: error.name,
                      message: error.message,
                      ...(level === "debug" ? { stack: error.stack } : {}),
                    }
                  : { name: "Error", message: typeof error === "string" ? error : "不明なエラー" },
            }),
      }),
    );
  };
}
