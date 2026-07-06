import type { Cv } from "./cv";
import { settleOpenCv } from "./runtime";

type Progress = (loaded: number, total: number | null) => void;

interface FetchedBody {
  ok: boolean;
  status: number;
  headers: { get(name: string): string | null };
  body: ReadableStream<Uint8Array> | null;
  text?: () => Promise<string>;
}

export async function readWithProgress(
  response: FetchedBody,
  onProgress?: Progress,
): Promise<string> {
  if (!response.ok) {
    throw new Error(`opencv fetch failed: HTTP ${response.status}`);
  }
  const header = response.headers.get("Content-Length");
  const total = header ? Number(header) : null;
  if (!response.body) {
    // environments without body streams: no incremental progress
    const text = await (response.text?.() ?? Promise.resolve(""));
    onProgress?.(text.length, total);
    return text;
  }
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let loaded = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    loaded += value.byteLength;
    onProgress?.(loaded, total);
  }
  const merged = new Uint8Array(loaded);
  let offset = 0;
  for (const chunk of chunks) {
    merged.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(merged);
}

// Evaluate the UMD artifact CJS-style in the worker global scope and
// settle it. Same technique as the Node loader; `new Function` keeps
// the sloppy-mode UMD out of our ESM module graph.
export async function loadOpenCvBrowser(
  url: string,
  onProgress?: Progress,
): Promise<Cv> {
  const source = await readWithProgress(await fetch(url), onProgress);
  const moduleShim = { exports: {} as unknown };
  const evaluate = new Function("module", "exports", source);
  evaluate(moduleShim, moduleShim.exports);
  return settleOpenCv(moduleShim.exports);
}
