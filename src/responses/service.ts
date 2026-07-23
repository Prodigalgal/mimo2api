import { randomUUID } from "node:crypto";
import { Ajv2020 } from "ajv/dist/2020.js";
import type { ConfigStore } from "../config/store.js";
import { ApiError, asApiError } from "../core/errors.js";
import type { CompletionRequest, CompletionService } from "../protocol/completion.js";
import type { SemanticEvent, ToolCall, ToolDefinition, Usage } from "../protocol/types.js";
import { collectCompletion, type CompletionResult } from "../streaming/collect.js";
import { CompactionCodec } from "./compaction.js";
import {
  canonicalInput,
  expandCompactions,
  itemId,
  outputItems,
  outputText,
  responseItemsToMessages,
  responseUsage,
} from "./items.js";
import type { ResponseRepository } from "./repository.js";

const ajv = new Ajv2020({ strict: false, allErrors: true });

export interface ResponseBody extends Record<string, any> {
  model?: string;
  input?: unknown;
  instructions?: string;
  tools?: ToolDefinition[];
  tool_choice?: unknown;
  reasoning?: { effort?: string };
  text?: { format?: Record<string, any> };
  stream?: boolean;
  background?: boolean;
  store?: boolean;
  previous_response_id?: string;
}

export interface PreparedResponse {
  id: string;
  body: ResponseBody;
  input: Array<Record<string, any>>;
  resolved: Array<Record<string, any>>;
  completion: CompletionRequest;
  base: Record<string, any>;
}

export class ResponsesService {
  readonly codec: CompactionCodec;
  readonly #active = new Map<string, { controller: AbortController; task: Promise<void> }>();

  constructor(
    private readonly config: ConfigStore,
    private readonly completions: CompletionService,
    private readonly repository: ResponseRepository,
  ) {
    const seed = process.env.MIMO2API_COMPACTION_KEY || this.config.snapshot().api_keys;
    this.codec = new CompactionCodec(seed);
  }

  prepare(body: ResponseBody, id = responseId()): PreparedResponse {
    const input = canonicalInput(body.input);
    let previousContext: Array<Record<string, any>> = [];
    if (body.previous_response_id) {
      const previous = this.repository.get(body.previous_response_id);
      if (!previous) throw new ApiError(404, "previous_response_not_found", `response ${body.previous_response_id} not found`);
      previousContext = previous.context;
    }
    const resolved = [...previousContext, ...expandCompactions(input, this.codec)];
    if (resolved.length === 0) throw new ApiError(400, "missing_input", "input is required", "input");
    const messages = responseItemsToMessages(resolved);
    if (body.instructions) messages.unshift({ role: "system", content: body.instructions });
    const completion: CompletionRequest = {
      model: body.model ?? "mimo-v2.5-pro",
      messages,
      tools: body.tools,
      toolChoice: body.tool_choice,
      reasoningEffort: body.reasoning?.effort,
    };
    return { id, body, input, resolved, completion, base: this.base(id, body, "in_progress") };
  }

  events(prepared: PreparedResponse, signal: AbortSignal): AsyncGenerator<SemanticEvent> {
    return this.completions.events(prepared.completion, signal);
  }

  async execute(body: ResponseBody, signal: AbortSignal, id?: string): Promise<Record<string, any>> {
    const prepared = this.prepare(body, id);
    const result = await collectCompletion(this.completions, prepared.completion, signal);
    return this.finalize(prepared, result);
  }

  finalize(
    prepared: PreparedResponse,
    result: CompletionResult,
    outputOverride?: Array<Record<string, any>>,
  ): Record<string, any> {
    const normalizedText = normalizeStructuredText(result.text, prepared.body.text);
    const output = outputOverride ?? outputItems(normalizedText, result.reasoning, result.toolCalls);
    if (outputOverride && normalizedText !== result.text) {
      const part = output.find((item) => item.type === "message")?.content?.find((item: any) => item.type === "output_text");
      if (part) part.text = normalizedText;
    }
    const response = {
      ...prepared.base,
      status: "completed",
      output,
      output_text: outputText(output),
      usage: responseUsage(result.usage),
    };
    if (prepared.body.store !== false) {
      this.repository.save({ response, input: prepared.input, context: [...prepared.resolved, ...output] });
    }
    return response;
  }

  storeProgress(prepared: PreparedResponse, response: Record<string, any>, contextOutput: Array<Record<string, any>> = []): void {
    if (prepared.body.store === false) return;
    this.repository.save({
      response,
      input: prepared.input,
      context: [...prepared.resolved, ...contextOutput],
    });
  }

  startBackground(body: ResponseBody): Record<string, any> {
    if (body.store === false) throw new ApiError(400, "invalid_background_store", "background responses require store=true");
    const prepared = this.prepare({ ...body, background: true, store: true });
    const queued = { ...prepared.base, status: "queued" };
    this.storeProgress(prepared, queued);
    const controller = new AbortController();
    const task = this.#runBackground(prepared, controller);
    this.#active.set(prepared.id, { controller, task });
    return queued;
  }

  cancel(id: string): Record<string, any> {
    const stored = this.repository.get(id);
    if (!stored) throw new ApiError(404, "response_not_found", `response ${id} not found`);
    if (!stored.response.background) throw new ApiError(400, "response_not_cancellable", "only background responses can be cancelled");
    if (["completed", "failed", "cancelled", "incomplete"].includes(stored.response.status)) return stored.response;
    this.#active.get(id)?.controller.abort(new DOMException("Cancelled", "AbortError"));
    const cancelled = { ...stored.response, status: "cancelled", completed_at: Math.floor(Date.now() / 1_000) };
    this.repository.save({ ...stored, response: cancelled });
    return cancelled;
  }

  get(id: string) {
    return this.repository.get(id);
  }

  delete(id: string): boolean {
    this.#active.get(id)?.controller.abort(new DOMException("Deleted", "AbortError"));
    return this.repository.delete(id);
  }

  async stop(): Promise<void> {
    const active = [...this.#active.values()];
    for (const item of active) item.controller.abort(new DOMException("Service stopped", "AbortError"));
    await Promise.allSettled(active.map((item) => item.task));
  }

  async compact(body: ResponseBody, signal: AbortSignal): Promise<Record<string, any>> {
    const prepared = this.prepare({ ...body, tools: [], tool_choice: "none", store: false });
    prepared.completion.messages.unshift({
      role: "system",
      content: "Compact this conversation for continuation. Preserve requirements, decisions, identifiers, tool results, unresolved tasks, and essential facts. Return only the compacted context.",
    });
    const result = await collectCompletion(this.completions, prepared.completion, signal);
    if (!result.text.trim()) throw new ApiError(502, "compaction_failed", "compaction model returned no text");
    const compacted = canonicalInput([{
      type: "message",
      role: "system",
      content: [{ type: "input_text", text: `Compacted conversation context:\n${result.text.trim()}` }],
    }]);
    return {
      id: responseId(),
      object: "response.compaction",
      created_at: Math.floor(Date.now() / 1_000),
      output: [{ id: itemId("cmp"), type: "compaction", encrypted_content: this.codec.encode(compacted) }],
      usage: responseUsage(result.usage),
    };
  }

  countTokens(body: ResponseBody): number {
    const prepared = this.prepare(body);
    const serialized = JSON.stringify({
      input: prepared.resolved,
      instructions: body.instructions ?? "",
      tools: body.tools ?? [],
    });
    return Math.max(1, Math.ceil([...serialized].length / 4));
  }

  base(id: string, body: ResponseBody, status: string): Record<string, any> {
    return {
      id,
      object: "response",
      created_at: Math.floor(Date.now() / 1_000),
      status,
      background: body.background === true,
      error: null,
      incomplete_details: null,
      instructions: body.instructions ?? null,
      max_output_tokens: body.max_output_tokens ?? null,
      model: body.model ?? "mimo-v2.5-pro",
      output: [],
      output_text: "",
      parallel_tool_calls: body.parallel_tool_calls ?? true,
      previous_response_id: body.previous_response_id ?? null,
      reasoning: body.reasoning ?? {},
      store: body.store !== false,
      temperature: body.temperature ?? null,
      text: body.text ?? { format: { type: "text" } },
      tool_choice: body.tool_choice ?? "auto",
      tools: body.tools ?? [],
      top_p: body.top_p ?? null,
      truncation: body.truncation ?? "disabled",
      usage: null,
      user: body.user ?? null,
      metadata: body.metadata ?? {},
    };
  }

  async #runBackground(prepared: PreparedResponse, controller: AbortController): Promise<void> {
    try {
      const inProgress = { ...prepared.base, status: "in_progress" };
      this.storeProgress(prepared, inProgress);
      const result = await collectCompletion(this.completions, prepared.completion, controller.signal);
      this.finalize(prepared, result);
    } catch (error) {
      if (controller.signal.aborted && this.repository.get(prepared.id)?.response.status === "cancelled") return;
      const apiError = asApiError(error);
      const failed = {
        ...prepared.base,
        status: "failed",
        error: { message: apiError.message, type: "server_error", code: apiError.code },
      };
      this.storeProgress(prepared, failed);
    } finally {
      this.#active.delete(prepared.id);
    }
  }
}

export const responseId = (): string => `resp_${randomUUID().replaceAll("-", "")}`;

const normalizeStructuredText = (text: string, config: ResponseBody["text"]): string => {
  const format = config?.format;
  if (!format || !["json_object", "json_schema"].includes(format.type)) return text;
  const candidate = text.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "");
  let value: unknown;
  try { value = JSON.parse(candidate); }
  catch (error) { throw new ApiError(422, "invalid_response_format", `model output is not valid JSON: ${error}`); }
  const schema = format.schema ?? format.json_schema?.schema;
  if (format.type === "json_schema" && schema) {
    const validate = ajv.compile(schema);
    if (!validate(value)) throw new ApiError(422, "invalid_response_format", `model JSON does not match text.format schema: ${ajv.errorsText(validate.errors)}`);
  }
  return JSON.stringify(value);
};
