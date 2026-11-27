import { Buffer } from "../../buffer/Buffer";
import { Frame } from "../../buffer/Frame";
import type { RecapSession, RecapView } from "../../lib/recap/session";
const titles: Record<RecapView, string> = {
  recent: "直近",
  toc: "目次",
  decisions: "決まったこと",
  "recap-search": "検索結果",
};
export function RecapPanel({ recap, view }: { recap: RecapSession; view: string }) {
  if (!(view in titles)) return null;
  return (
    <Frame title={titles[view as RecapView]} side="right">
      <Buffer
        side="right"
        viewName={view}
        lines={recap.lines(view as RecapView)}
        onReady={(handle) => recap.bindRight(view as RecapView, handle)}
      />
    </Frame>
  );
}
