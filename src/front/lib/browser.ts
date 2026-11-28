import { BufferController } from "../buffer/controller";
import { browserClipboard } from "../buffer/clipboard";
import { isThreadRight } from "../buffer/right-window";
import { PositionStore } from "../buffer/position-store";
import { openRoute, parseRoute, type Route } from "./routes";
import { z } from "zod";
const historyState = z.object({
  sukunaDepth: z.number().int().nonnegative(),
  sukunaEntry: z.string().optional(),
});
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
  const initial = historyState.safeParse(browser.history.state).data;
  let depth = initial?.sukunaDepth ?? 0;
  const stateFor = (entry?: string) => ({
    sukunaDepth: depth,
    ...(entry === undefined ? {} : { sukunaEntry: entry }),
  });
  browser.history.replaceState(stateFor(initial?.sukunaEntry), "");
  const controller = new BufferController({
    positions,
    url: `${browser.location.pathname}${browser.location.search}`,
    entry: initial?.sukunaEntry,
    navigate(url, entry, replace) {
      const current = parseRoute(`${browser.location.pathname}${browser.location.search}`);
      const next = parseRoute(url);
      if (
        replace ||
        (current.kind === "issue" &&
          next.kind === "issue" &&
          current.id === next.id &&
          current.view !== "edit" &&
          next.view !== "edit")
      )
        browser.history.replaceState(stateFor(entry), "", url);
      else {
        depth += 1;
        browser.history.pushState(stateFor(entry), "", url);
      }
      display(url, entry);
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
  const display = (url: string, entry?: string, initial = false) => {
    const route = parseRoute(url);
    const destination = route.kind === "conversation" && route.view ? route.view : route.kind;
    const storedRight = controller.right.state();
    const restoringThread =
      (storedRight.current !== null && isThreadRight(storedRight.current)) ||
      storedRight.stack.some(isThreadRight);
    if (!initial || restoringThread || ["grep", "files", "changes"].includes(destination)) {
      const previous = controller.right.current;
      controller.right.navigate(destination, route.id ?? "");
      controller.positions.setRight(controller.right.state());
      controller.update({});
      if (previous && !controller.right.current && !route.thread) {
        if (controller.snapshot().active === "right") {
          controller.positions.setActive("main");
          controller.update({ active: "main" });
        }
        controller.focus("main");
      }
    }
    if (route.kind === "conversation" && route.id && route.thread) {
      const current = controller.right.current;
      if (
        !(
          current &&
          isThreadRight(current) &&
          current.target === route.thread &&
          current.parent === route.id
        )
      )
        controller.openRight({ view: "thread", target: route.thread, parent: route.id });
    }
    openRoute(url, open, entry);
  };
  const pop = () => {
    const state = historyState.safeParse(browser.history.state).data;
    depth = state?.sukunaDepth ?? 0;
    const url = `${browser.location.pathname}${browser.location.search}`;
    controller.changeScreen(url, state?.sukunaEntry, true);
    display(url, state?.sukunaEntry);
  };
  browser.addEventListener("pagehide", positions.flush);
  browser.addEventListener("popstate", pop);
  display(`${browser.location.pathname}${browser.location.search}`, initial?.sukunaEntry, true);
  return {
    controller,
    dispose() {
      browser.removeEventListener("pagehide", positions.flush);
      browser.removeEventListener("popstate", pop);
      positions.flush();
    },
  };
}
