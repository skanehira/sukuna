export interface Clock {
  now(): number;
  setTimeout(callback: () => void | Promise<void>, ms: number): () => void;
}
