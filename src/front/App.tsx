import { useState, useSyncExternalStore, type ReactNode } from "react";
import useSWR, { SWRConfig } from "swr";
import {
  BufferController,
  BufferControllerContext,
  ScreenOpeningContext,
} from "./buffer/controller";
import { Buffer } from "./buffer/Buffer";
import { Frame } from "./buffer/Frame";
import { Layout } from "./buffer/Layout";
import type { LineInfo } from "./buffer/line";
import { requestsConversationTail, routeUrl, type Route } from "./lib/routes";
import type { NavigationPort, StorePort } from "./shell/navigation";
import { createNavigation } from "./shell/navigation";
import { Notices, type NoticePort } from "./shell/notices";
import { ShellBoundary, WindowError } from "./shell/ShellBoundary";
import { Skeleton } from "./shell/loading";
import type { IdentityRecovery } from "./shell/AuthenticationGuard";
import type { RightView } from "./buffer/right-window";

const empty: LineInfo[] = [];
const initial: LineInfo[] = [{ kind: "note", text: "表示する項目はありません。" }];
const online: StorePort<boolean> = { snapshot: () => true, subscribe: () => () => undefined };
const missing = {
  code: "not_found",
  message: "開いた対象が見つかりません。一覧から選び直してください。",
};

export type ReadyScreen = {
  kind: "ready";
  title: string;
  content: ReactNode;
  fullWindow?: boolean;
};
export type ScreenContent =
  | ReadyScreen
  | { kind: "error"; error: { code: string; message: string }; cached?: ReadyScreen };
export type ScreenLoader = (route: Route) => Promise<ScreenContent>;

const openingCache = { provider: () => new Map() };
class ScreenNetworkError extends Error {
  readonly cached: ReadyScreen | undefined;
  constructor(message: string, cached?: ReadyScreen) {
    super(message);
    this.cached = cached;
  }
}

type AppProps = {
  controller?: BufferController;
  navigation?: NavigationPort;
  connection?: StorePort<boolean>;
  notices?: NoticePort;
  identityRecovery?: IdentityRecovery;
  loadScreen?: ScreenLoader;
  main?: ReactNode;
  right?: ReactNode;
  renderRight?: (view: RightView) => ReactNode;
  renderTree?: (route: Route) => ReactNode;
};

export function App({
  controller: supplied,
  navigation: suppliedNavigation,
  connection = online,
  notices,
  loadScreen,
  identityRecovery,
  main,
  right,
  renderRight,
  renderTree,
}: AppProps = {}) {
  const [localNavigation] = useState(() => createNavigation({ kind: "home" }, () => undefined));
  const navigation = suppliedNavigation ?? localNavigation;
  const [local] = useState(() => new BufferController({ navigate: navigation.navigate }));
  const controller = supplied ?? local;
  const route = useSyncExternalStore(navigation.subscribe, navigation.snapshot);
  const opening = controller.screenOpening();
  const connected = useSyncExternalStore(connection.subscribe, connection.snapshot);
  const screen = (
    <MainWindow
      route={route}
      connected={connected}
      loadScreen={loadScreen}
      identityRecovery={identityRecovery}
      main={main}
      onHome={() => {
        void navigation.navigate("/");
      }}
      onReload={navigation.reload}
    />
  );
  return (
    <div
      className="relative h-full"
      onKeyDownCapture={(event) => {
        if (event.key === "Escape") notices?.dismissError();
      }}
    >
      <Layout
        controller={controller}
        disconnected={!connected}
        notices={notices ? <Notices notices={notices} /> : undefined}
        renderRight={renderRight}
        tree={
          <ShellBoundary>
            {renderTree ? (
              renderTree(route)
            ) : (
              <Frame title="sukuna" side="tree">
                <Buffer side="tree" lines={empty} onReady={() => undefined} />
              </Frame>
            )}
          </ShellBoundary>
        }
        main={
          <>
            <div className="min-h-0 flex flex-1 flex-col">
              <ShellBoundary key={`${routeUrl(route)}:${opening}`}>
                <ScreenOpeningContext value={opening}>
                  {requestsConversationTail(route) ? (
                    <SWRConfig value={openingCache}>{screen}</SWRConfig>
                  ) : (
                    screen
                  )}
                </ScreenOpeningContext>
              </ShellBoundary>
            </div>
          </>
        }
        right={
          right === undefined ? undefined : (
            <Frame title="関連情報" side="right">
              <ShellBoundary>{right}</ShellBoundary>
            </Frame>
          )
        }
      />
    </div>
  );
}

function MainWindow({
  route,
  connected,
  loadScreen,
  identityRecovery,
  main,
  onHome,
  onReload,
}: {
  route: Route;
  connected: boolean;
  identityRecovery?: IdentityRecovery;
  loadScreen?: ScreenLoader;
  main?: ReactNode;
  onHome: () => void;
  onReload: () => void;
}) {
  const {
    data: loaded,
    error,
    isLoading,
    mutate,
  } = useSWR(
    loadScreen ? ["screen", routeUrl(route)] : null,
    async () => {
      const result = await loadScreen!(route);
      if (result.kind === "error" && result.error.code === "network_error")
        throw new ScreenNetworkError(result.error.message, result.cached);
      return result;
    },
    { shouldRetryOnError: false },
  );
  const data = loaded ?? (error instanceof ScreenNetworkError ? error.cached : undefined);
  const networkFailure = error
    ? {
        code: "network_error",
        message:
          error instanceof ScreenNetworkError
            ? error.message
            : "取得できませんでした。再読み込みしてください。",
      }
    : undefined;
  const failure =
    networkFailure && data?.kind !== "ready"
      ? networkFailure
      : data?.kind === "error"
        ? data.error
        : !loadScreen && route.kind !== "home"
          ? missing
          : undefined;
  const recovery =
    !failure && (!connected || networkFailure !== undefined || identityRecovery !== undefined);
  const reload = () => {
    if (identityRecovery) identityRecovery.onReload();
    else if (loadScreen) void mutate().catch(() => undefined);
    else onReload();
  };
  const recoveryNode = recovery ? (
    <div className="shrink-0 border-t border-line bg-ground">
      <WindowError
        message={
          identityRecovery?.message ??
          networkFailure?.message ??
          "サーバーにつながりません。最後に取得した内容を表示しています。"
        }
        onHome={onHome}
        onReload={reload}
      />
    </div>
  ) : null;
  const title = failure
    ? failure.code === "not_found"
      ? "見つかりません"
      : "表示できません"
    : data?.kind === "ready"
      ? data.title
      : "一覧";
  if (!failure && data?.kind === "ready" && data.fullWindow)
    return (
      <>
        {data.content}
        {recoveryNode}
      </>
    );
  return (
    <Frame title={title} side="main" active>
      <ShellBoundary key={routeUrl(route)}>
        {failure ? (
          <WindowError
            message={identityRecovery?.message ?? failure.message}
            onHome={onHome}
            onReload={reload}
          />
        ) : isLoading ? (
          requestsConversationTail(route) ? (
            <BufferControllerContext.Provider value={null}>
              <Skeleton side="main" />
            </BufferControllerContext.Provider>
          ) : (
            <Skeleton side="main" />
          )
        ) : (
          <div className="flex min-h-0 flex-1 flex-col">
            {main ??
              (data?.kind === "ready" ? (
                data.content
              ) : (
                <Buffer side="main" lines={initial} onReady={() => undefined} />
              ))}
          </div>
        )}
        {recoveryNode}
      </ShellBoundary>
    </Frame>
  );
}
