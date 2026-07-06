import { describe, expect, test } from "vitest";
import { readWithProgress } from "./load-browser";

function streamOf(chunks: string[]): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  return new ReadableStream({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
      controller.close();
    },
  });
}

describe("readWithProgress", () => {
  test("accumulates text and reports byte progress with total", async () => {
    const response = new Response(streamOf(["ab", "cde"]), {
      headers: { "Content-Length": "5" },
    });
    const events: [number, number | null][] = [];
    const text = await readWithProgress(response, (loaded, total) =>
      events.push([loaded, total]),
    );
    expect(text).toBe("abcde");
    expect(events).toEqual([
      [2, 5],
      [5, 5],
    ]);
  });

  test("reports null total without Content-Length", async () => {
    const response = new Response(streamOf(["xy"]));
    const events: [number, number | null][] = [];
    await readWithProgress(response, (loaded, total) =>
      events.push([loaded, total]),
    );
    expect(events).toEqual([[2, null]]);
  });

  test("reports null total for non-numeric Content-Length", async () => {
    const response = new Response(streamOf(["ab"]), {
      headers: { "Content-Length": "banana" },
    });
    const events: [number, number | null][] = [];
    await readWithProgress(response, (loaded, total) =>
      events.push([loaded, total]),
    );
    expect(events[0][1]).toBe(null);
  });

  test("throws on non-OK responses", async () => {
    const response = new Response("nope", { status: 404 });
    await expect(readWithProgress(response)).rejects.toThrow(/404/);
  });
});
