import type { BufferController } from "./buffer/controller";
import { Buffer } from "./buffer/Buffer";
import { Frame } from "./buffer/Frame";
import { Layout } from "./buffer/Layout";
import type { LineInfo } from "./buffer/line";

const empty: LineInfo[] = [];
const initial: LineInfo[] = [{ kind: "note", text: "表示する項目はありません。" }];

export function App({ controller }: { controller?: BufferController } = {}) {
  return (
    <Layout
      controller={controller}
      tree={
        <Frame title="sukuna" side="tree">
          <Buffer side="tree" lines={empty} onReady={() => undefined} />
        </Frame>
      }
      main={
        <Frame title="一覧" side="main" active>
          <Buffer side="main" lines={initial} onReady={() => undefined} />
        </Frame>
      }
    />
  );
}
