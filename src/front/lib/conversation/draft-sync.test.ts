import { describe, expect, it } from "vite-plus/test";
import { DraftSync } from "./draft-sync";

const remote = { text: "別の端末の本文", images: ["image-1"], updatedAt: 200, updatedBy: "other" };
describe("書きかけの同期", () => {
  it.each(["edit", "save", "edit-save"])(
    "GET開始後の%sより前のnullは、現在の未送信を置き換えない",
    (change) => {
      const draft = new DraftSync("this-tab", null);
      draft.edit({ text: "保存する本文", images: ["img"] }, 100);
      const reading = draft.readVersion();
      if (change !== "save") draft.edit({ text: "追記した本文", images: ["img", "img2"] }, 200);
      if (change !== "edit")
        draft.saved(draft.request(), {
          ...draft.content(),
          updatedAt: change === "save" ? 100 : 200,
          updatedBy: "this-tab",
        });
      expect(draft.receive(null, reading)).toEqual({ replaced: false, notice: null });
      expect(draft.content()).toEqual(
        change !== "save"
          ? { text: "追記した本文", images: ["img", "img2"] }
          : { text: "保存する本文", images: ["img"] },
      );
    },
  );
  it("保存済みのあとに開始したGETなら、別タブの削除を適用する", () => {
    const draft = new DraftSync("this-tab", remote);
    const reading = draft.readVersion();
    expect(draft.receive(null, reading)).toEqual({
      replaced: true,
      notice: "別の端末で書いた内容に置き換わりました",
    });
    expect(draft.content()).toEqual({ text: "", images: [] });
  });
  it("保存済みより古い取得結果が遅れて返っても新しい書きかけを残す", () => {
    const draft = new DraftSync("this-tab", remote);
    expect(
      draft.receive({ text: "古い本文", images: [], updatedAt: 100, updatedBy: "other" }),
    ).toEqual({ replaced: false, notice: null });
    expect(draft.content()).toEqual({ text: remote.text, images: remote.images });
  });
  it("保存していない編集が無いときは別のタブの内容に置き換えて知らせる", () => {
    const draft = new DraftSync("this-tab", null);
    expect(draft.receive(remote)).toEqual({
      replaced: true,
      notice: "別の端末で書いた内容に置き換わりました",
    });
    expect(draft.content()).toEqual({ text: "別の端末の本文", images: ["image-1"] });
  });
  it("保存していない編集があるときは本文を残して競合を知らせる", () => {
    const draft = new DraftSync("this-tab", null);
    draft.edit({ text: "手元の編集", images: [] }, 300);
    expect(draft.receive(remote)).toEqual({
      replaced: false,
      notice: "別の端末で書き換えられました",
    });
    expect(draft.content()).toEqual({ text: "手元の編集", images: [] });
  });
  it("保存中に追加で編集した内容は、保存結果が返っても置き換えずに次の保存に残す", () => {
    const draft = new DraftSync("this-tab", null);
    draft.edit({ text: "保存する本文", images: [] }, 100);
    const request = draft.request();
    draft.edit({ text: "保存中の編集", images: [] }, 300);
    draft.saved(request, remote);
    expect(draft.request()).toEqual({
      text: "保存中の編集",
      images: [],
      clientId: "this-tab",
      editedAt: 300,
    });
  });
});
