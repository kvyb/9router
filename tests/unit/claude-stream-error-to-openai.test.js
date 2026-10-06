// A Claude `error` SSE event after HTTP 200 (rate_limit_error, overloaded_error)
// must reach an OpenAI-format client as an error frame + [DONE], not a stream
// that ends without finish_reason.
import { describe, it, expect } from "vitest";
import { FORMATS } from "../../open-sse/translator/formats.js";
import { createSSETransformStreamWithLogger } from "../../open-sse/utils/stream.js";

function sseStream(events) {
  const body = events.map((e) => `event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`).join("");
  return new ReadableStream({
    start(c) {
      c.enqueue(new TextEncoder().encode(body));
      c.close();
    },
  });
}

describe("Claude stream error event → OpenAI error frame", () => {
  it.each(["rate_limit_error", "overloaded_error"])("%s", async (type) => {
    const events = [
      { type: "message_start", message: { id: "m", model: "claude", role: "assistant", content: [], usage: { input_tokens: 10, output_tokens: 1 } } },
      { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
      { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "po" } },
      { type: "error", error: { type, message: "Upstream says no" } },
    ];
    const text = await new Response(
      sseStream(events).pipeThrough(createSSETransformStreamWithLogger(FORMATS.CLAUDE, FORMATS.OPENAI, "claude", null, null, "claude")),
    ).text();
    const lines = text.split("\n").filter((l) => l.startsWith("data: "));
    expect(lines.at(-1)).toBe("data: [DONE]");
    expect(JSON.parse(lines.at(-2).slice(6))).toEqual({
      error: { message: `${type}: Upstream says no`, type, code: type },
    });
  });
});
