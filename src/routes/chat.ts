import { randomUUID } from "node:crypto";
import type { FastifyPluginAsync, FastifyRequest } from "fastify";
import { z } from "zod";
import type { ConfigStore } from "../config/store.js";
import { requireApiKey } from "../core/auth.js";
import { ApiError, asApiError } from "../core/errors.js";
import { CompletionService } from "../protocol/completion.js";
import type { ProtocolMessage, ToolDefinition, Usage } from "../protocol/types.js";
import { collectCompletion } from "../streaming/collect.js";
import { SseSession } from "../streaming/sse-session.js";

const ChatRequestSchema = z.object({
  model: z.string().default("mimo-v2.5-pro"),
  messages: z.array(z.object({
    role: z.enum(["system", "developer", "user", "assistant", "tool"]),
    content: z.any().optional(),
    tool_calls: z.any().optional(),
    tool_call_id: z.string().optional(),
  }).passthrough()).min(1),
  stream: z.boolean().default(false),
  stream_options: z.object({ include_usage: z.boolean().default(false) }).optional(),
  tools: z.array(z.any()).optional(),
  tool_choice: z.any().optional(),
  reasoning_effort: z.string().optional(),
}).passthrough();

export const chatRoutes = (config: ConfigStore, service: CompletionService): FastifyPluginAsync => async (app) => {
  app.addHook("preHandler", requireApiKey(config));

  app.post("/v1/chat/completions", async (request, reply) => {
    const parsed = ChatRequestSchema.safeParse(request.body);
    if (!parsed.success) throw new ApiError(400, "invalid_request", z.prettifyError(parsed.error));
    const body = parsed.data;
    const id = `chatcmpl_${randomUUID().replaceAll("-", "")}`;
    const created = Math.floor(Date.now() / 1_000);
    const completionRequest = {
      model: body.model,
      messages: body.messages as ProtocolMessage[],
      tools: body.tools as ToolDefinition[] | undefined,
      toolChoice: body.tool_choice,
      reasoningEffort: body.reasoning_effort,
    };
    const controller = requestController(request);

    if (!body.stream) {
      const result = await collectCompletion(service, completionRequest, controller.signal);
      reply.header("X-Request-ID", id);
      return {
        id,
        object: "chat.completion",
        created,
        model: body.model,
        choices: [{
          index: 0,
          message: {
            role: "assistant",
            content: result.toolCalls.length > 0 ? null : result.text,
            reasoning: result.reasoning || undefined,
            reasoning_content: result.reasoning || undefined,
            tool_calls: result.toolCalls.length > 0 ? result.toolCalls : undefined,
          },
          finish_reason: result.toolCalls.length > 0 ? "tool_calls" : "stop",
        }],
        usage: chatUsage(result.usage),
      };
    }

    const session = new SseSession(reply, controller, id);
    let usage: Usage = { inputTokens: 0, outputTokens: 0, totalTokens: 0 };
    let finishReason = "stop";
    try {
      await session.data(chunk(id, body.model, created, { role: "assistant", content: "" }));
      for await (const event of service.events(completionRequest, controller.signal)) {
        if (event.type === "text.delta") {
          await session.data(chunk(id, body.model, created, { content: event.delta }));
        } else if (event.type === "reasoning.delta") {
          await session.data(chunk(id, body.model, created, {
            reasoning: event.delta,
            reasoning_content: event.delta,
          }));
        } else if (event.type === "tool.calls") {
          finishReason = "tool_calls";
          await session.data(chunk(id, body.model, created, {
            tool_calls: event.calls.map((call, index) => ({ ...call, index })),
          }));
        } else {
          usage = event.usage;
        }
      }
      await session.data(chunk(id, body.model, created, {}, finishReason));
      if (body.stream_options?.include_usage) {
        await session.data({ id, object: "chat.completion.chunk", created, model: body.model, choices: [], usage: chatUsage(usage) });
      }
      await session.data("[DONE]");
    } catch (error) {
      if (!controller.signal.aborted) {
        await session.data(asApiError(error).toJSON(id));
        await session.data("[DONE]");
      }
    } finally {
      session.end();
    }
  });
};

const requestController = (request: FastifyRequest): AbortController => {
  const controller = new AbortController();
  request.raw.once("aborted", () => controller.abort(new DOMException("Client disconnected", "AbortError")));
  return controller;
};

const chunk = (
  id: string,
  model: string,
  created: number,
  delta: Record<string, unknown>,
  finishReason: string | null = null,
) => ({
  id,
  object: "chat.completion.chunk",
  created,
  model,
  choices: [{ index: 0, delta, finish_reason: finishReason }],
});

const chatUsage = (usage: Usage) => ({
  prompt_tokens: usage.inputTokens,
  completion_tokens: usage.outputTokens,
  total_tokens: usage.totalTokens,
  prompt_tokens_details: { cached_tokens: 0 },
  completion_tokens_details: { reasoning_tokens: 0 },
});
