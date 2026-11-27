import { BufferController } from "../buffer/controller";
import { browserClipboard } from "../buffer/clipboard";
import { PositionStore } from "../buffer/position-store";
import { openRoute, parseRoute, type Route } from "./routes";
import { z } from "zod";
export function createBrowserController(
  browser: Window,
  open: (route: Route) => void,
): { controller: BufferController; dispose: () => void } {
  const positions = new PositionStore(browser.sessionStorage, {
    schedule: (fn, ms) => {
      const id = browser.setTimeout(fn, ms);
      return () => browser.clearTimeout(id);
    },
  });
  let depth =
    z.object({ sukunaDepth: z.number().int().nonnegative() }).safeParse(browser.history.state).data
      ?.sukunaDepth ?? 0;
  browser.history.replaceState({ sukunaDepth: depth }, "");
  const controller = new BufferController({
    positions,
    url: `${browser.location.pathname}${browser.location.search}`,
    navigate(url) {
      const current = parseRoute(`${browser.location.pathname}${browser.location.search}`);
      const next = parseRoute(url);
      if (current.kind === "issue" && next.kind === "issue" && current.id === next.id)
        browser.history.replaceState({ sukunaDepth: depth }, "", url);
      else {
        depth += 1;
        browser.history.pushState({ sukunaDepth: depth }, "", url);
      }
      display(url);
    },
    back() {
      if (depth === 0) return false;
      browser.history.back();
      return true;
    },
  });
  controller.options.clipboard = browserClipboard(
    browser.document,
    browser.navigator,
    browser.isSecureContext,
    controller.notify,
  );
  const display = (url: string, initial = false) => {
    const route = parseRoute(url);
    controller.changeScreen(url);
    if (!initial) {
      const previous = controller.right.current;
      controller.right.navigate(route.view === "file" ? "file" : route.kind, route.id ?? "");
      controller.positions.setRight(controller.right.state());
      controller.update({});
      if (previous && !controller.right.current && !route.thread) controller.focus("main");
    }
    if (route.thread) controller.openRight({ view: "thread", target: route.thread });
    openRoute(url, open);
  };
  const pop = () => {
    depth =
      z.object({ sukunaDepth: z.number().int().nonnegative() }).safeParse(browser.history.state)
        .data?.sukunaDepth ?? 0;
    display(`${browser.location.pathname}${browser.location.search}`);
  };
  browser.addEventListener("pagehide", positions.flush);
  browser.addEventListener("popstate", pop);
  display(`${browser.location.pathname}${browser.location.search}`, true);
  return {
    controller,
    dispose() {
      browser.removeEventListener("pagehide", positions.flush);
      browser.removeEventListener("popstate", pop);
      positions.flush();
    },
  };
}
