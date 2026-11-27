export type ShowNotification = {
  type: "show";
  id: string;
  tag: string;
  sequence: number;
  title: string;
  body: string;
  url: string;
};
export type DismissNotification = { type: "dismiss"; tag: string; ids: readonly string[] };
export type NotificationPushMessage = ShowNotification | DismissNotification;
export type NotificationPush = (message: NotificationPushMessage) => Promise<void>;
