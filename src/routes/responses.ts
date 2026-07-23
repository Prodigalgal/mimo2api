import type { FastifyPluginAsync, FastifyRequest } from "fastify";
import { z } from "zod";
import type { ConfigStore } from "../config/store.js";
import { requireApiKey } from "../core/auth.js";
import { ApiError } from "../core/errors.js";
import { SseSession } from "../streaming/sse-session.js";
import { ResponsesStream } from "../responses/stream.js";
import type { ResponseBody, ResponsesService } from "../responses/service.js";

const ResponseSchema = z.object({
  model: z.string().default("mimo-v2.5-pro"),
  input: z.any().optional(),
  instructions: z.string().optional(),
  stream: z.boolean().default(false),
  background: z.boolean().default(false),
  store: z.boolean().default(true),
  previous_response_id: z.string().optional(),
  tools: z.array(z.any()).optional(),
  tool_choice: z.any().optional(),
  reasoning: z.record(z.string(), z.any()).optional(),
  text: z.record(z.string(), z.any()).optional(),
}).passthrough();

export const responseRoutes = (config: ConfigStore, service: ResponsesService): FastifyPluginAsync => async (app) => {
  app.addHook("preHandler", requireApiKey(config));

  app.post("/v1/responses", async (request, reply) => {
    const body = parseBody(request.body);
    if (body.background && body.stream) {
      throw new ApiError(400, "invalid_background_stream", "background responses cannot use stream=true");
    }
    if (body.background) return service.startBackground(body);
    const controller = requestController(request);
    if (!body.stream) {
      const response = await service.execute(body, controller.signal);
      reply.header("X-Request-ID", response.id);
      return response;
    }
    const prepared = service.prepare(body);
    const session = new SseSession(reply, controller, prepared.id);
    try {
      await new ResponsesStream(service, prepared, session).run(controller.signal);
    } finally {
      session.end();
    }
  });

  app.post("/v1/responses/input_tokens", async (request) => ({
    object: "response.input_tokens",
    input_tokens: service.countTokens(parseBody(request.body)),
  }));

  app.post("/v1/responses/compact", async (request) => (
    service.compact(parseBody(request.body), requestController(request).signal)
  ));

  app.post<{ Params: { responseId: string } }>("/v1/responses/:responseId/compact", async (request) => {
    const stored = service.get(request.params.responseId);
    if (!stored) throw new ApiError(404, "response_not_found", `response ${request.params.responseId} not found`);
    const body = parseBody(request.body ?? {});
    return service.compact({ ...body, input: stored.context, previous_response_id: undefined }, requestController(request).signal);
  });

  app.post<{ Params: { responseId: string } }>("/v1/responses/:responseId/cancel", async (request) => (
    service.cancel(request.params.responseId)
  ));

  app.get<{ Params: { responseId: string } }>("/v1/responses/:responseId", async (request) => {
    const stored = service.get(request.params.responseId);
    if (!stored) throw new ApiError(404, "response_not_found", `response ${request.params.responseId} not found`);
    return stored.response;
  });

  app.get<{
    Params: { responseId: string };
    Querystring: { after?: string; before?: string; limit?: string; order?: string };
  }>("/v1/responses/:responseId/input_items", async (request) => {
    const stored = service.get(request.params.responseId);
    if (!stored) throw new ApiError(404, "response_not_found", `response ${request.params.responseId} not found`);
    const order = request.query.order ?? "desc";
    if (!["asc", "desc"].includes(order)) throw new ApiError(400, "invalid_order", "order must be asc or desc");
    const limit = Math.max(1, Math.min(100, Number(request.query.limit ?? 20)));
    let items = order === "desc" ? [...stored.input].reverse() : [...stored.input];
    items = pageAfter(items, request.query.after, true);
    items = pageAfter(items, request.query.before, false);
    const page = items.slice(0, limit);
    return {
      object: "list",
      data: page,
      first_id: page[0]?.id ?? null,
      last_id: page.at(-1)?.id ?? null,
      has_more: items.length > limit,
    };
  });

  app.delete<{ Params: { responseId: string } }>("/v1/responses/:responseId", async (request) => {
    if (!service.delete(request.params.responseId)) {
      throw new ApiError(404, "response_not_found", `response ${request.params.responseId} not found`);
    }
    return { id: request.params.responseId, object: "response", deleted: true };
  });
};

const parseBody = (value: unknown): ResponseBody => {
  const parsed = ResponseSchema.safeParse(value);
  if (!parsed.success) throw new ApiError(400, "invalid_request", z.prettifyError(parsed.error));
  return parsed.data;
};

const requestController = (request: FastifyRequest): AbortController => {
  const controller = new AbortController();
  request.raw.once("aborted", () => controller.abort(new DOMException("Client disconnected", "AbortError")));
  return controller;
};

const pageAfter = (items: Array<Record<string, any>>, id: string | undefined, after: boolean) => {
  if (!id) return items;
  const index = items.findIndex((item) => item.id === id);
  if (index < 0) return [];
  return after ? items.slice(index + 1) : items.slice(0, index);
};
