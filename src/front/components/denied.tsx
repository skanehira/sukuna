import { DENIED_TITLE, deniedMessage, type DeniedReason } from "../../shared/denied";

export function Denied({ reason }: { reason: DeniedReason }) {
  return (
    <div className="border p-8 max-w-[36rem]">
      <p className="font-bold text-lg">{DENIED_TITLE}</p>
      <p className="my-3">{deniedMessage(reason)}</p>
      <button
        type="button"
        className="rounded-md border px-3 py-1 text-[13px] font-medium"
        onClick={() => window.location.reload()}
      >
        再読み込み
      </button>
    </div>
  );
}
