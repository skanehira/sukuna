type AutoStage = "triage" | "design" | "impl";

export function createFlowGate(deps: {
  globallyPaused(): boolean;
  settings(projectId: string): { flowPaused: boolean; autoStages: AutoStage[] } | undefined;
}) {
  return (projectId: string, stage: AutoStage, by: "flow" | "developer" = "flow") => {
    if (by === "developer") return true;
    const settings = deps.settings(projectId);
    return Boolean(
      settings &&
      !deps.globallyPaused() &&
      !settings.flowPaused &&
      settings.autoStages.includes(stage),
    );
  };
}
