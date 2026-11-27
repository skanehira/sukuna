export type Route = {
  kind: string;
  id?: string;
  view?: string;
  thread?: string;
  query?: string;
  entry?: string;
};
export function requestsConversationTail(route: Route): boolean {
  return (
    route.kind === "conversation" &&
    !route.view &&
    new URLSearchParams(route.query).get("tail") === "1"
  );
}

export function parseRoute(url: string): Route {
  const [path, query] = url.split("?");
  const parts = path.split("/").filter(Boolean).map(decodeURIComponent);
  const params = new URLSearchParams(query);
  const kinds: Record<string, string> = {
    projects: "project",
    conversations: "conversation",
    issues: "issue",
  };
  if (parts.length === 0) return { kind: "home" };
  if (kinds[parts[0]] && parts[1]) {
    return {
      kind: kinds[parts[0]],
      id: parts[1],
      ...(parts[2] ? { view: parts[2] } : {}),
      ...(params.get("thread") ? { thread: params.get("thread")! } : {}),
      ...(params.size > (params.has("thread") ? 1 : 0)
        ? {
            query: [...params]
              .filter(([key]) => key !== "thread")
              .map(([key, value]) => `${encodeURIComponent(key)}=${encodeURIComponent(value)}`)
              .join("&"),
          }
        : {}),
    };
  }
  if (parts.length === 1 && parts[0] === "convs") return { kind: "convs" };
  if (parts.length === 1 && parts[0] === "search")
    return { kind: "search", query: params.toString() };
  if (["help", "settings", "usage"].includes(parts[0])) return { kind: parts[0] };
  return { kind: "not-found" };
}
export function routeUrl(route: Route): string {
  if (route.kind === "home") return "/";
  const kinds: Record<string, string> = {
    project: "projects",
    conversation: "conversations",
    issue: "issues",
  };
  const path = kinds[route.kind]
    ? `/${kinds[route.kind]}/${encodeURIComponent(route.id ?? "")}${route.view ? `/${route.view}` : ""}`
    : `/${route.kind}`;
  const params = new URLSearchParams(route.query);
  if (route.thread) params.set("thread", route.thread);
  return `${path}${params.size ? `?${params}` : ""}`;
}
export function screenKey(route: Route): string {
  return route.entry === undefined ? routeUrl(route) : `${routeUrl(route)}:${route.entry}`;
}
export function openRoute(url: string, open: (route: Route) => void, entry?: string): void {
  open({ ...parseRoute(url), ...(entry !== undefined ? { entry } : {}) });
}
