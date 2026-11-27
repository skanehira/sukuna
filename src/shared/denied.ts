export type DeniedReason = "identity" | "unavailable";

export const DENIED_TITLE = "このアプリは使えません";

export const DENIED_IDENTITY_MESSAGE =
  "Tailscale の本人として確認できませんでした。自分のアカウントで Tailscale につないでから、再読み込みしてください。";

export const DENIED_UNAVAILABLE_MESSAGE =
  "Tailscale に問い合わせできませんでした。Mac Studio の Tailscale が動いているかを確かめてから、再読み込みしてください。";

export function deniedMessage(reason: DeniedReason): string {
  return reason === "unavailable" ? DENIED_UNAVAILABLE_MESSAGE : DENIED_IDENTITY_MESSAGE;
}
