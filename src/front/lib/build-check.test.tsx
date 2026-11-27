import { act, fireEvent, render, screen } from "@testing-library/react";
import { expect, it, vi } from "vite-plus/test";
import { createNotices, Notices } from "../shell/notices";
import { createBuildCheck } from "./build-check";
import { createRestoreConnection } from "./restore-connection";

const message = "アプリが更新されました。再読み込みすると新しい版になります。";

function setup() {
  const notices = createNotices({
    schedule: (fn, ms) => {
      const timer = setTimeout(fn, ms);
      return () => clearTimeout(timer);
    },
  });
  const fetcher = vi.fn<typeof fetch>();
  const reload = vi.fn();
  const restore = createRestoreConnection({
    fetcher,
    origin: "https://sukuna.test",
    storage: window.sessionStorage,
    reload,
  });
  const check = createBuildCheck({ build: "loaded", show: notices.showUpdate });
  const view = render(
    <div onKeyDown={(event) => event.key === "Escape" && notices.dismissError()}>
      <Notices notices={notices} />
    </div>,
  );
  const connect = async (build: string, headers?: HeadersInit) => {
    fetcher.mockResolvedValueOnce(
      Response.json({ login: "dev@example.com", device: "Mac", build }, { headers }),
    );
    await act(() => restore.verify(new AbortController().signal, check.observe));
  };
  const escape = () => fireEvent.keyDown(view.container.firstElementChild!, { key: "Escape" });
  return { check, fetcher, notices, connect, escape, restore, reload };
}

it("再接続で実行中の画面とサーバーのビルドが異なると、Escまで案内を表示する", async () => {
  const { fetcher, notices, connect, escape } = setup();
  try {
    await connect("loaded");
    expect(screen.queryByText(message)).not.toBeInTheDocument();

    await connect("new");
    expect(fetcher).toHaveBeenLastCalledWith("/api/me", {
      cache: "no-store",
      signal: expect.any(AbortSignal),
    });
    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(screen.getByRole("alert")).toHaveTextContent(message);
    act(() => notices.notify("設定を読み込めませんでした", "error"));
    expect(screen.getByText(message)).toBeVisible();
    act(() => notices.replaceInfoWithResult("", "バックアップから戻しました。", "info"));
    expect(screen.getByRole("status", { name: "操作の結果" })).toHaveTextContent(
      "バックアップから戻しました。",
    );
    expect(screen.getByRole("alert", { name: "アプリの更新" })).toHaveTextContent(message);

    escape();
    await connect("new");
    expect(screen.queryByText(message)).not.toBeInTheDocument();
    await connect("loaded");
    expect(screen.queryByText(message)).not.toBeInTheDocument();
    await connect("new");
    expect(screen.getByRole("alert")).toHaveTextContent(message);

    await connect("loaded");
    expect(screen.getByRole("alert")).toHaveTextContent(message);
  } finally {
    notices.dispose();
  }
});

it("動的チャンクの失敗でも、画面を再読込せずEscで消せる同じ案内を出す", () => {
  const { check, fetcher, notices, escape } = setup();
  const detach = check.watchChunks(window);
  try {
    const failed = new Event("vite:preloadError", { cancelable: true });
    act(() => {
      window.dispatchEvent(failed);
    });
    expect(screen.getByRole("alert")).toHaveTextContent(message);
    expect(failed.defaultPrevented).toBe(false);
    expect(fetcher).not.toHaveBeenCalled();

    escape();
    detach();
    act(() => {
      window.dispatchEvent(new Event("vite:preloadError"));
    });
    expect(screen.queryByText(message)).not.toBeInTheDocument();
  } finally {
    detach();
    notices.dispose();
  }
});

it("接続が閉じたあとに戻った版を案内しない", async () => {
  const { check, fetcher, notices, restore } = setup();
  let sendResponse!: (response: Response) => void;
  const response = new Promise<Response>((resolve) => {
    sendResponse = resolve;
  });
  const connection = new AbortController();
  try {
    fetcher.mockReturnValueOnce(response);
    const pending = restore.verify(connection.signal, check.observe);
    connection.abort();
    sendResponse(Response.json({ login: "dev@example.com", device: "Mac", build: "new" }));
    await act(() => pending);
    expect(screen.queryByText(message)).not.toBeInTheDocument();
  } finally {
    notices.dispose();
  }
});

it("データベースが入れ替わった応答では再読込だけを行い、新しい版を案内しない", async () => {
  const { connect, fetcher, notices, reload } = setup();
  try {
    await connect("loaded");
    await connect("new", {
      "x-sukuna-restore-generation": "replacement",
      "x-sukuna-restore-request": "request",
    });
    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(reload).toHaveBeenCalledExactlyOnceWith("request");
    expect(screen.queryByText(message)).not.toBeInTheDocument();
  } finally {
    notices.dispose();
    window.sessionStorage.clear();
  }
});
