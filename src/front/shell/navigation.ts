import { parseRoute, type Route } from "../lib/routes";

export type StorePort<T> = {
  snapshot: () => T;
  subscribe: (listener: () => void) => () => void;
};

export type NavigationPort = StorePort<Route> & {
  reload: () => void;
  navigate: (url: string) => void | Promise<void>;
};

export function createNavigation(
  initial: Route,
  reload: () => void,
  navigate?: (url: string) => void | Promise<void>,
) {
  let route = initial;
  const listeners = new Set<() => void>();
  return {
    snapshot: () => route,
    subscribe: (listener: () => void) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    open: (next: Route) => {
      route = next;
      listeners.forEach((listener) => listener());
    },
    navigate: (url: string) => {
      if (navigate) return navigate(url);
      route = parseRoute(url);
      listeners.forEach((listener) => listener());
    },
    reload,
  };
}
