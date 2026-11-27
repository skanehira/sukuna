import { act, render, screen } from "@testing-library/react";
import { expect, it } from "vite-plus/test";
import { createNotices, Notices } from "./notices";

it("復元を待つ表示は結果と入れ替わり、復元結果は別のお知らせが消えても残る", () => {
  let expire: (() => void) | undefined;
  const notices = createNotices({
    schedule: (next) => {
      expire = next;
      return () => {
        expire = undefined;
      };
    },
  });
  render(<Notices notices={notices} />);
  act(() => notices.notify("復元しています。"));
  expect(screen.getByText("復元しています。")).toBeVisible();
  act(() =>
    notices.replaceInfoWithResult("復元しています。", "バックアップから戻しました。", "info"),
  );
  expect(screen.queryByText("復元しています。")).toBeNull();
  expect(screen.getByRole("status", { name: "操作の結果" })).toHaveTextContent(
    "バックアップから戻しました。",
  );
  act(() => notices.notify("別のお知らせ"));
  act(() => expire?.());
  expect(screen.queryByText("別のお知らせ")).toBeNull();
  expect(screen.getByText("バックアップから戻しました。")).toBeVisible();
  act(() => notices.dismissError());
  expect(screen.queryByText("バックアップから戻しました。")).toBeNull();
});
