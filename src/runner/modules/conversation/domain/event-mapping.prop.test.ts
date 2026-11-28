import { fc, test } from "@fast-check/vitest";
import { expect } from "vite-plus/test";
import { toolResultEvents } from "./event-mapping";

test.prop([fc.array(fc.boolean(), { maxLength: 25, size: "max" }), fc.nat({ max: 5 })])(
  "ツールの結果の画像は、先頭の 20 枚のうち書けた画像の ID を順に残し、残りをすべて保存できなかった数に数える",
  (writable, omittedImages) => {
    const images = writable.map((_, index) => ({
      mediaType: "image/png",
      data: Buffer.from(String(index)),
    }));
    const [event] = toolResultEvents(
      {
        kind: "tool_result",
        uuid: "r",
        toolUseId: "t",
        isError: false,
        content: "",
        images,
        omittedImages,
        diff: null,
        parentToolUseId: null,
      },
      (image) => (writable[Number(image.data.toString())] ? `id-${image.data.toString()}` : null),
    );
    const saved = writable.flatMap((ok, index) =>
      ok && index < 20 ? [{ id: `id-${index}`, media_type: "image/png" }] : [],
    );
    const omitted = writable.length - saved.length + omittedImages;
    expect(event?.payload).toEqual({
      tool_use_id: "t",
      is_error: false,
      content: "",
      truncated: false,
      bytes: 0,
      ...(saved.length ? { images: saved } : {}),
      ...(omitted ? { omitted_images: omitted } : {}),
    });
  },
);
