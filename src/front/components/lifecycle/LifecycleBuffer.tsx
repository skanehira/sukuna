import { Buffer, type BufferProps } from "../../buffer/Buffer";
import { useBufferLines } from "./use-lifecycle";

export function LifecycleBuffer({ temporary, ...props }: Omit<BufferProps, "onReady">) {
  const ready = useBufferLines(props.lines);
  return (
    <Buffer
      key={temporary ? "temporary" : "content"}
      {...props}
      temporary={temporary}
      onReady={ready}
    />
  );
}
