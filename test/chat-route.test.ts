import { mkdtemp, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import Fastify from "fastify";
import { describe, expect, it } from "vitest";
import { ConfigStore } from "../src/config/store.js";
import type { CompletionService } from "../src/protocol/completion.js";
import { chatRoutes } from "../src/routes/chat.js";

describe("Chat Completions route", () => {
  it("returns reasoning and emits the final streaming usage chunk", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "mimo2api-chat-"));
    const file = path.join(directory, "config.json");
    await writeFile(file, JSON.stringify({ api_keys: "sk-test" }));
    const config = await ConfigStore.open(file, path.join(directory, "db.sqlite"));
    const completion = {
      async *events() {
        yield { type: "reasoning.delta", delta: "plan" };
        yield { type: "text.delta", delta: "answer" };
        yield { type: "usage", usage: { inputTokens: 4, outputTokens: 2, totalTokens: 6 } };
      },
    } as unknown as CompletionService;
    const app = Fastify({ logger: false });
    await app.register(chatRoutes(config, completion));
    try {
      const headers = { authorization: "Bearer sk-test", "content-type": "application/json" };
      const payload = { model: "mimo-v2.5-pro", messages: [{ role: "user", content: "hello" }] };
      const regular = await app.inject({ method: "POST", url: "/v1/chat/completions", headers, payload });
      expect(regular.statusCode).toBe(200);
      expect(regular.json().choices[0].message).toMatchObject({ content: "answer", reasoning_content: "plan" });
      expect(regular.json().usage.total_tokens).toBe(6);

      const streaming = await app.inject({
        method: "POST",
        url: "/v1/chat/completions",
        headers,
        payload: { ...payload, stream: true, stream_options: { include_usage: true } },
      });
      expect(streaming.statusCode).toBe(200);
      expect(streaming.payload).toContain('"choices":[]');
      expect(streaming.payload).toContain('"total_tokens":6');
      expect(streaming.payload).toContain("data: [DONE]");
    } finally {
      await app.close();
      config.database.close();
    }
  });
});
