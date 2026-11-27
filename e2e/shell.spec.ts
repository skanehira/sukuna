import { expect, test } from "@playwright/test";
import { capture } from "./evidence";

test("存在しない会話とissueから一覧へ戻る", async ({ page }) => {
  for (const path of ["/conversations/missing-conversation", "/issues/missing-issue"]) {
    await page.goto(path);
    const main = page.getByRole("region", { name: "見つかりません" });
    await expect(main.getByRole("alert")).toBeVisible();
    await expect(page.getByRole("region", { name: "sukuna" })).toBeVisible();
    await capture(
      page,
      path.startsWith("/conversations")
        ? "存在しない会話を開いた状態"
        : "存在しないissueを開いた状態",
    );
    await main.getByRole("button", { name: "一覧へ戻る" }).click();
    await expect(page).toHaveURL("/");
    await expect(page.getByRole("region", { name: "一覧" })).toBeVisible();
    await expect(main).toHaveCount(0);
    await capture(page, "一覧へ戻った状態");
  }
});
