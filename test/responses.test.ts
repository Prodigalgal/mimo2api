import { mkdtemp, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ConfigStore } from "../src/config/store.js";
import type { CompletionService } from "../src/protocol/completion.js";
import type { SemanticEvent } from "../src/protocol/types.js";
import { ResponseRepository } from "../src/responses/repository.js";
import { ResponsesService } from "../src/responses/service.js";
import { ResponsesStream } from "../src/responses/stream.js";
import type { SseSession } from "../src/streaming/sse-session.js";

const stores: ConfigStore[] = [];
afterEach(() => stores.splice(0).forEach((store) => store.database.close()));

const setup = async (events: SemanticEvent[]) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "mimo2api-"));
  const file = path.join(directory, "config.json");
  await writeFile(file, JSON.stringify({ api_keys: "sk-test" }));
  const config = await ConfigStore.open(file, path.join(directory, "db.sqlite"));
  stores.push(config);
  const completion = {
    async *events() { for (const event of events) yield event; },
  } as unknown as CompletionService;
  const repository = new ResponseRepository(config.database);
  return { service: new ResponsesService(config, completion, repository), repository };
};

describe("Responses API service", () => {
  it("stores a response and resolves previous_response_id context", async () => {
    const { service } = await setup([
      { type: "reasoning.delta", delta: "plan" },
      { type: "text.delta", delta: "answer" },
      { type: "usage", usage: { inputTokens: 5, outputTokens: 2, totalTokens: 7 } },
    ]);
    const first = await service.execute({ input: "first", model: "mimo-v2.5-pro" }, new AbortController().signal);
    expect(first.output_text).toBe("answer");
    expect(first.usage.total_tokens).toBe(7);
    const prepared = service.prepare({ input: "second", previous_response_id: first.id });
    expect(prepared.resolved.length).toBeGreaterThan(1);
  });

  it("emits typed SSE events with monotonic sequence numbers and final usage", async () => {
    const { service } = await setup([
      { type: "reasoning.delta", delta: "plan" },
      { type: "text.delta", delta: "answer" },
      { type: "usage", usage: { inputTokens: 5, outputTokens: 2, totalTokens: 7 } },
    ]);
    const captured: Array<{ type: string; value: any }> = [];
    const session = { async event(type: string, value: any) { captured.push({ type, value }); } } as unknown as SseSession;
    const prepared = service.prepare({ input: "hello", stream: true, store: false });
    await new ResponsesStream(service, prepared, session).run(new AbortController().signal);
    expect(captured[0]?.type).toBe("response.created");
    expect(captured.at(-1)?.type).toBe("response.completed");
    expect(captured.map((item) => item.value.sequence_number)).toEqual(captured.map((_, index) => index));
    expect(captured.at(-1)?.value.response.usage.total_tokens).toBe(7);
  });

  it("round-trips compacted input items", async () => {
    const { service } = await setup([
      { type: "text.delta", delta: "requirements and decisions" },
      { type: "usage", usage: { inputTokens: 10, outputTokens: 3, totalTokens: 13 } },
    ]);
    const compacted = await service.compact({ input: "long history" }, new AbortController().signal);
    const prepared = service.prepare({ input: compacted.output });
    expect(prepared.resolved[0]?.content[0]?.text).toContain("requirements and decisions");
  });
});
