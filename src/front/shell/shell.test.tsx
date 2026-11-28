import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import { SWRConfig, useSWRConfig } from "swr";
import { errorResponseSchema } from "../../shared/api";
import { App, type ScreenLoader } from "../App";
import type { NavigationPort, StorePort } from "./navigation";
import { BufferController } from "../buffer/controller";
import { createNavigation } from "./navigation";
import { createNotices } from "./notices";
import { Skeleton, Spinner } from "./loading";
import { ServerConnectionGate, createServerStateLoader } from "./ServerConnectionGate";
import { ShellBoundary } from "./ShellBoundary";

const reload = vi.fn();
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  reload.mockClear();
});

function session(children: React.ReactNode) {
  return render(
    <SWRConfig value={{ provider: () => new Map(), dedupingInterval: 0 }}>{children}</SWRConfig>,
  );
}

describe("アプリシェル", () => {
  it("未登録のURLでは主に見つからない表示と戻る・再読み込みが出て、ツリーは使える", () => {
    const navigation = createNavigation({ kind: "not-found" }, reload);
    const controller = new BufferController({
      navigate: (url) => navigation.open({ kind: url === "/" ? "home" : "not-found" }),
    });
    render(<App controller={controller} navigation={navigation} />);
    const main = screen.getByRole("region", { name: "見つかりません" });
    expect(within(main).getByRole("alert")).toHaveTextContent(
      /^開いた対象が見つかりません。一覧から選び直してください。$/,
    );
    fireEvent.click(within(main).getByRole("button", { name: "再読み込み" }));
    expect(reload).toHaveBeenCalledOnce();
    fireEvent.mouseDown(screen.getByRole("region", { name: "sukuna" }));
    expect(controller.snapshot().active).toBe("tree");
    fireEvent.click(within(main).getByRole("button", { name: "一覧へ戻る" }));
    expect(screen.getByRole("region", { name: "一覧" })).toBeInTheDocument();
    expect(screen.queryByRole("region", { name: "見つかりません" })).toBeNull();
  });

  it("APIの偽物が404 not_foundを返すと、主に見つからない表示と戻る・再読み込みが出る", async () => {
    const navigation = createNavigation({ kind: "conversation", id: "missing" }, reload);
    let found = false;
    const api = async () =>
      found
        ? Response.json({})
        : Response.json(
            {
              error: {
                code: "not_found",
                message: "会話がありません。一覧から選び直してください。",
              },
            },
            { status: 404 },
          );
    session(
      <App
        navigation={navigation}
        loadScreen={async () => {
          const response = await api();
          return response.ok
            ? { kind: "ready", title: "会話", content: <p>読み直した会話</p> }
            : { kind: "error", error: errorResponseSchema.parse(await response.json()).error };
        }}
      />,
    );
    const main = await screen.findByRole("region", { name: "見つかりません" });
    expect(within(main).getByRole("alert")).toHaveTextContent(
      /^会話がありません。一覧から選び直してください。$/,
    );
    expect(within(main).getByRole("button", { name: "一覧へ戻る" })).toBeEnabled();
    found = true;
    fireEvent.click(within(main).getByRole("button", { name: "再読み込み" }));
    expect(await screen.findByText("読み直した会話", { exact: true })).toBeInTheDocument();
  });

  it.each([
    ["forbidden", "取得できませんでした。再読み込みしてください。"],
    ["network_error", "サーバーに接続できません。接続を確認してください。"],
  ])("%s は主のウィンドウにAPIの文面と回復操作を出す", async (code, message) => {
    session(
      <App
        loadScreen={async () => ({
          kind: "error",
          error: { code, message },
        })}
      />,
    );
    const main = await screen.findByRole("region", { name: "表示できません" });
    expect(within(main).getByRole("alert").textContent).toBe(message);
    expect(within(main).getByRole("button", { name: "一覧へ戻る" })).toBeEnabled();
    expect(within(main).getByRole("button", { name: "再読み込み" })).toBeEnabled();
  });

  it("画面の取得が通信で失敗すると、主に再読み込みを案内しツリーを残す", async () => {
    session(
      <App
        loadScreen={async () => {
          throw new TypeError("fetch failed");
        }}
      />,
    );
    const main = await screen.findByRole("region", { name: "表示できません" });
    expect(within(main).getByRole("alert")).toHaveTextContent(
      /^取得できませんでした。再読み込みしてください。$/,
    );
    expect(within(main).getByRole("button", { name: "再読み込み" })).toBeEnabled();
    expect(screen.getByRole("region", { name: "sukuna" })).toBeInTheDocument();
  });

  it("切断中も最後の内容を保持し、再接続するとつながらない表示だけが消える", () => {
    let connected = true;
    const listeners = new Set<() => void>();
    const connection = {
      snapshot: () => connected,
      subscribe: (fn: () => void) => {
        listeners.add(fn);
        return () => {
          listeners.delete(fn);
        };
      },
    };
    render(<App connection={connection} navigation={createNavigation({ kind: "home" }, reload)} />);
    expect(screen.getByText("表示する項目はありません。", { exact: true })).toBeInTheDocument();
    act(() => {
      connected = false;
      listeners.forEach((fn) => fn());
    });
    expect(
      screen.getByText("サーバーにつながりません。最後に取得した内容を表示しています。", {
        exact: true,
      }),
    ).toBeInTheDocument();
    expect(screen.getByText("表示する項目はありません。", { exact: true })).toBeInTheDocument();
    expect(screen.getByText("つながりません", { exact: true })).toBeInTheDocument();
    const main = screen.getByRole("region", { name: "一覧" });
    expect(within(main).getByRole("button", { name: "一覧へ戻る" })).toBeEnabled();
    fireEvent.click(within(main).getByRole("button", { name: "再読み込み" }));
    expect(reload).toHaveBeenCalledOnce();
    act(() => {
      connected = true;
      listeners.forEach((fn) => fn());
    });
    expect(
      screen.queryByText("サーバーにつながりません。最後に取得した内容を表示しています。", {
        exact: true,
      }),
    ).toBeNull();
    expect(screen.getByRole("region", { name: "一覧" })).toBeInTheDocument();
    expect(within(main).queryByRole("button", { name: "再読み込み" })).toBeNull();
  });

  it.each([
    ["例外", false],
    ["network_error", false],
    ["例外", true],
    ["network_error", true],
  ] as const)(
    "再取得が%sで失敗しても本文と回復操作を残し、再取得と一覧へ戻るを選べる (接続=%s)",
    async (failure, connectionStatus) => {
      const navigation = createNavigation({ kind: "conversation", id: "cached" }, reload);
      let connected = true;
      let unavailable = false;
      const requests: string[] = [];
      const listeners = new Set<() => void>();
      const connection = {
        snapshot: () => connected,
        subscribe: (listener: () => void) => {
          listeners.add(listener);
          return () => {
            listeners.delete(listener);
          };
        },
      };
      session(
        <App
          navigation={navigation}
          connection={connection}
          loadScreen={async (route) => {
            requests.push(route.kind);
            if (unavailable) {
              if (failure === "例外") throw new TypeError("fetch failed");
              return {
                kind: "error",
                error: {
                  code: "network_error",
                  message: "サーバーに接続できません。接続を確認してください。",
                },
              };
            }
            return {
              kind: "ready",
              title: route.kind === "home" ? "一覧" : "会話",
              content: <p>{route.kind === "home" ? "取得した一覧" : "最後に取得した会話の本文"}</p>,
            };
          }}
        />,
      );
      expect(
        await screen.findByText("最後に取得した会話の本文", { exact: true }),
      ).toBeInTheDocument();
      await act(async () => {
        navigation.open({ kind: "home" });
      });
      expect(await screen.findByText("取得した一覧", { exact: true })).toBeInTheDocument();
      await act(async () => {
        connected = connectionStatus;
        unavailable = true;
        navigation.open({ kind: "conversation", id: "cached" });
      });
      await waitFor(() => expect(requests).toEqual(["conversation", "home", "conversation"]));
      await act(async () => undefined);
      expect(screen.getByText("最後に取得した会話の本文", { exact: true })).toBeInTheDocument();
      const main = screen.getByRole("region", { name: "会話" });
      expect(within(main).getByRole("alert").textContent).toBe(
        failure === "network_error"
          ? "サーバーに接続できません。接続を確認してください。"
          : "取得できませんでした。再読み込みしてください。",
      );
      expect(within(main).getByRole("button", { name: "一覧へ戻る" })).toBeEnabled();
      fireEvent.click(within(main).getByRole("button", { name: "再読み込み" }));
      await waitFor(() =>
        expect(requests).toEqual(["conversation", "home", "conversation", "conversation"]),
      );
      expect(
        within(main).getByText("最後に取得した会話の本文", { exact: true }),
      ).toBeInTheDocument();
      act(() => {
        connected = true;
        unavailable = false;
        listeners.forEach((listener) => listener());
      });
      fireEvent.click(within(main).getByRole("button", { name: "再読み込み" }));
      await waitFor(() => expect(within(main).queryByRole("alert")).toBeNull());
      expect(
        within(main).getByText("最後に取得した会話の本文", { exact: true }),
      ).toBeInTheDocument();
      expect(within(main).queryByRole("button", { name: "再読み込み" })).toBeNull();
      await act(async () => {
        navigation.open({ kind: "home" });
      });
      await act(async () => {
        unavailable = true;
        navigation.open({ kind: "conversation", id: "cached" });
      });
      fireEvent.click(
        await within(screen.getByRole("region", { name: "会話" })).findByRole("button", {
          name: "一覧へ戻る",
        }),
      );
      expect(await screen.findByText("取得した一覧", { exact: true })).toBeInTheDocument();
      expect(navigation.snapshot()).toEqual({ kind: "home" });
    },
  );

  it.each([
    [404, "not_found", "見つかりません"],
    [401, "unauthorized", "表示できません"],
    [403, "forbidden", "表示できません"],
  ] as const)(
    "取得済みの会話がHTTP %i %sになったら、本文を残さず%sを表示する",
    async (status, code, title) => {
      const navigation = createNavigation({ kind: "conversation", id: "cached" }, reload);
      let unavailable = false;
      const api = async () =>
        unavailable
          ? Response.json(
              {
                error: { code, message: "この会話を表示できません。一覧から選び直してください。" },
              },
              { status },
            )
          : Response.json({});
      session(
        <App
          navigation={navigation}
          loadScreen={async (route) => {
            const response = await api();
            if (!response.ok)
              return {
                kind: "error",
                error: errorResponseSchema.parse(await response.json()).error,
              };
            return {
              kind: "ready",
              title: route.kind === "home" ? "一覧" : "会話",
              content: <p>{route.kind === "home" ? "取得した一覧" : "取得済みの会話の本文"}</p>,
            };
          }}
        />,
      );
      expect(await screen.findByText("取得済みの会話の本文", { exact: true })).toBeInTheDocument();
      await act(async () => {
        navigation.open({ kind: "home" });
      });
      expect(await screen.findByText("取得した一覧", { exact: true })).toBeInTheDocument();
      await act(async () => {
        unavailable = true;
        navigation.open({ kind: "conversation", id: "cached" });
      });
      expect(
        await within(await screen.findByRole("region", { name: title })).findByRole("alert"),
      ).toHaveTextContent(/^この会話を表示できません。一覧から選び直してください。$/);
      expect(screen.queryByText("取得済みの会話の本文", { exact: true })).toBeNull();
      expect(screen.getByRole("region", { name: "sukuna" })).toBeInTheDocument();
    },
  );

  it("エラーと通常のお知らせは各最新の1件を保持し、通常は4秒、エラーは画面移動後もEscまで残る", () => {
    vi.useFakeTimers();
    const notices = createNotices({
      schedule: (fn, ms) => {
        const id = setTimeout(fn, ms);
        return () => clearTimeout(id);
      },
    });
    const navigation = createNavigation({ kind: "home" }, reload);
    const controller = new BufferController({ notify: notices.notify });
    render(<App controller={controller} navigation={navigation} notices={notices} />);
    act(() => {
      controller.notify("古いエラー", "error");
      controller.notify("保存できません。再試行してください。", "error");
      controller.notify("古いお知らせ");
      vi.advanceTimersByTime(1000);
      controller.notify("保存しました");
    });
    expect(screen.getByRole("alert")).toHaveTextContent(/^保存できません。再試行してください。$/);
    expect(screen.getByRole("status", { name: "お知らせ" })).toHaveTextContent(/^保存しました$/);
    act(() => {
      vi.advanceTimersByTime(3999);
      navigation.open({ kind: "not-found" });
    });
    expect(screen.getByRole("status", { name: "お知らせ" })).toBeInTheDocument();
    act(() => {
      vi.advanceTimersByTime(1);
    });
    expect(screen.queryByRole("status", { name: "お知らせ" })).toBeNull();
    expect(screen.getByRole("alert", { name: "エラーのお知らせ" })).toHaveTextContent(
      /^保存できません。再試行してください。$/,
    );
    fireEvent.keyDown(screen.getByRole("region", { name: "sukuna" }), { key: "Escape" });
    expect(screen.queryByRole("alert", { name: "エラーのお知らせ" })).toBeNull();
    expect(screen.getByRole("region", { name: "見つかりません" })).toBeInTheDocument();
  });

  it("壊れた主のウィンドウを再読み込みでき、ツリーと右のウィンドウは操作できる", () => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    let broken = true;
    function Content() {
      if (broken) throw new Error("描画失敗");
      return <p>会話の本文</p>;
    }
    const controller = new BufferController();
    render(
      <App
        controller={controller}
        main={<Content />}
        right={
          <button
            type="button"
            onClick={() => {
              broken = false;
            }}
          >
            右から復旧
          </button>
        }
      />,
    );
    const main = screen.getByRole("region", { name: "一覧" });
    expect(within(main).getByRole("alert")).toHaveTextContent(
      /^画面を表示できませんでした。再読み込みしてください。$/,
    );
    fireEvent.mouseDown(screen.getByRole("region", { name: "sukuna" }));
    expect(controller.snapshot().active).toBe("tree");
    fireEvent.click(screen.getByRole("button", { name: "右から復旧" }));
    fireEvent.click(within(main).getByRole("button", { name: "再読み込み" }));
    expect(within(main).getByText("会話の本文", { exact: true })).toBeInTheDocument();
  });

  it("SkeletonとSpinnerは渡されたウィンドウにだけ出る", () => {
    const { rerender } = render(<App main={<Skeleton side="main" />} right={<p>関連情報</p>} />);
    expect(
      within(screen.getByRole("region", { name: "一覧" })).getByRole("status", {
        name: "読み込み中",
      }),
    ).toBeInTheDocument();
    expect(
      within(screen.getByRole("region", { name: "sukuna" })).queryByRole("status", {
        name: "読み込み中",
      }),
    ).toBeNull();
    expect(
      within(screen.getByRole("region", { name: "関連情報" })).queryByRole("status", {
        name: "読み込み中",
      }),
    ).toBeNull();
    rerender(<App right={<Spinner />} />);
    expect(
      within(screen.getByRole("region", { name: "関連情報" })).getByRole("status", {
        name: "操作中",
      }),
    ).toBeInTheDocument();
    expect(
      within(screen.getByRole("region", { name: "一覧" })).queryByRole("status", {
        name: "操作中",
      }),
    ).toBeNull();
    expect(
      within(screen.getByRole("region", { name: "sukuna" })).queryByRole("status", {
        name: "操作中",
      }),
    ).toBeNull();
  });

  it("アプリ全体の描画失敗にも再読み込みを表示する", () => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    function Broken(): React.ReactNode {
      throw new Error("全体の描画失敗");
    }
    render(
      <ShellBoundary onReload={reload}>
        <Broken />
      </ShellBoundary>,
    );
    expect(screen.getByRole("alert")).toHaveTextContent(
      /^画面を表示できませんでした。再読み込みしてください。$/,
    );
    fireEvent.click(screen.getByRole("button", { name: "再読み込み" }));
    expect(reload).toHaveBeenCalled();
  });
});

function ServerRevalidation({
  load,
  navigation,
  controller,
  loadScreen,
  connection,
}: {
  load: () => Promise<true>;
  navigation: NavigationPort;
  controller: BufferController;
  loadScreen: ScreenLoader;
  connection: StorePort<boolean>;
}) {
  const { mutate } = useSWRConfig();
  return (
    <>
      <button type="button" onClick={() => void mutate("/api/me").catch(() => undefined)}>
        サーバーを再確認
      </button>
      <ServerConnectionGate load={load} onReload={reload}>
        {(serverRecovery) => (
          <App
            navigation={navigation}
            controller={controller}
            loadScreen={loadScreen}
            connection={connection}
            serverRecovery={serverRecovery}
          />
        )}
      </ServerConnectionGate>
    </>
  );
}

describe("サーバー接続の確認", () => {
  it.each(["成功", "通信失敗", "503"] as const)(
    "接続の再確認が%sでも本文と入力を保持し、失敗から回復できる",
    async (result) => {
      let revalidating = false;
      let requests = 0;
      const load = createServerStateLoader(async () => {
        requests += 1;
        if (revalidating) {
          if (result === "通信失敗") throw new TypeError("fetch failed");
          if (result === "503") return new Response("unavailable", { status: 503 });
        }
        return Response.json({ login: "dev@example.com", device: "local", build: "test" });
      });
      const navigation = createNavigation({ kind: "conversation", id: "cached" }, reload);
      const controller = new BufferController();
      let connected = true;
      const listeners = new Set<() => void>();
      const connection = {
        snapshot: () => connected,
        subscribe: (listener: () => void) => {
          listeners.add(listener);
          return () => {
            listeners.delete(listener);
          };
        },
      };
      const screenRequests: string[] = [];
      const loadScreen: ScreenLoader = async (route) => {
        screenRequests.push(route.kind);
        return {
          kind: "ready",
          title: route.kind === "home" ? "一覧" : "会話",
          content:
            route.kind === "home" ? (
              <p>取得した一覧</p>
            ) : (
              <>
                <p>最後に取得した会話の本文</p>
                <label>
                  書きかけの入力
                  <input defaultValue="" />
                </label>
              </>
            ),
        };
      };
      session(
        <ServerRevalidation
          load={load}
          navigation={navigation}
          controller={controller}
          loadScreen={loadScreen}
          connection={connection}
        />,
      );
      const input = await screen.findByRole("textbox", { name: "書きかけの入力" });
      const tree = screen.getByRole("region", { name: "sukuna" });
      fireEvent.change(input, { target: { value: "送信前の指示" } });
      await act(async () => {
        revalidating = true;
        fireEvent.click(screen.getByRole("button", { name: "サーバーを再確認" }));
      });
      expect(requests).toBe(2);
      const main = screen.getByRole("region", { name: "会話" });
      expect(screen.getByRole("textbox", { name: "書きかけの入力" })).toBe(input);
      expect(input).toHaveValue("送信前の指示");
      expect(screen.getByRole("region", { name: "sukuna" })).toBe(tree);
      expect(
        within(main).getByText("最後に取得した会話の本文", { exact: true }),
      ).toBeInTheDocument();
      if (result === "成功") {
        expect(within(main).queryByRole("alert")).toBeNull();
        expect(within(main).queryByRole("button", { name: "再読み込み" })).toBeNull();
      } else {
        expect(within(main).getByRole("alert").textContent).toBe(
          "サーバーの状態を確認できませんでした。再読み込みしてください。",
        );
        expect(within(main).getByRole("button", { name: "一覧へ戻る" })).toBeEnabled();
        await act(async () => {
          fireEvent.click(within(main).getByRole("button", { name: "再読み込み" }));
        });
        expect(requests).toBe(3);
        expect(screenRequests).toEqual(["conversation"]);
        expect(reload).not.toHaveBeenCalled();
        expect(screen.getByRole("textbox", { name: "書きかけの入力" })).toBe(input);
        expect(input).toHaveValue("送信前の指示");
        act(() => {
          connected = false;
          listeners.forEach((listener) => listener());
        });
        expect(within(main).getAllByRole("alert")).toHaveLength(1);
        expect(within(main).getAllByRole("button", { name: "再読み込み" })).toHaveLength(1);
        await act(async () => {
          connected = true;
          revalidating = false;
          listeners.forEach((listener) => listener());
          fireEvent.click(within(main).getByRole("button", { name: "再読み込み" }));
        });
        expect(requests).toBe(4);
        expect(within(main).queryByRole("alert")).toBeNull();
        expect(within(main).queryByRole("button", { name: "再読み込み" })).toBeNull();
        expect(screen.getByRole("textbox", { name: "書きかけの入力" })).toBe(input);
        expect(input).toHaveValue("送信前の指示");
        expect(screen.getByRole("region", { name: "sukuna" })).toBe(tree);
        fireEvent.mouseDown(tree);
        expect(controller.snapshot().active).toBe("tree");
        await act(async () => {
          revalidating = true;
          fireEvent.click(screen.getByRole("button", { name: "サーバーを再確認" }));
        });
        await act(async () => {
          fireEvent.click(within(main).getByRole("button", { name: "一覧へ戻る" }));
        });
        expect(navigation.snapshot()).toEqual({ kind: "home" });
        expect(await screen.findByText("取得した一覧", { exact: true })).toBeInTheDocument();
        expect(screen.getByRole("region", { name: "sukuna" })).toBe(tree);
        expect(screenRequests).toEqual(["conversation", "home"]);
        expect(requests).toBe(5);
      }
    },
  );

  it.each(["通信失敗", "サーバーエラー"])(
    "初回接続中の%sでは再読み込みを案内する",
    async (failure) => {
      const load = createServerStateLoader(async () => {
        if (failure === "通信失敗") throw new TypeError("fetch failed");
        return new Response("unavailable", { status: 503 });
      });
      session(
        <ServerConnectionGate load={load} onReload={reload}>
          {(serverRecovery) => <App serverRecovery={serverRecovery} />}
        </ServerConnectionGate>,
      );
      expect(await screen.findByRole("alert")).toHaveTextContent(
        /^サーバーの状態を確認できませんでした。再読み込みしてください。$/,
      );
      fireEvent.click(screen.getByRole("button", { name: "再読み込み" }));
      expect(reload).toHaveBeenCalledOnce();
    },
  );

  it("サーバーの状態を取得できればアプリを開く", async () => {
    const load = createServerStateLoader(async () =>
      Response.json({ login: "dev@example.com", device: "local", build: "test" }),
    );
    session(
      <ServerConnectionGate load={load} onReload={reload}>
        {(serverRecovery) => <App serverRecovery={serverRecovery} />}
      </ServerConnectionGate>,
    );
    expect(await screen.findByRole("region", { name: "一覧" })).toBeInTheDocument();
  });
});
