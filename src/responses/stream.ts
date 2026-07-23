import { asApiError } from "../core/errors.js";
import type { ToolCall, Usage } from "../protocol/types.js";
import type { SseSession } from "../streaming/sse-session.js";
import { functionCallItem, itemId, messageItem, reasoningItem } from "./items.js";
import type { PreparedResponse, ResponsesService } from "./service.js";

export class ResponsesStream {
  #sequence = 0;
  #text = "";
  #reasoning = "";
  #calls: ToolCall[] = [];
  #usage: Usage = { inputTokens: 0, outputTokens: 0, totalTokens: 0 };
  #textId = "";
  #reasoningId = "";
  #output: Array<Record<string, any>> = [];

  constructor(
    private readonly service: ResponsesService,
    private readonly prepared: PreparedResponse,
    private readonly session: SseSession,
  ) {}

  async run(signal: AbortSignal): Promise<void> {
    const created = { ...this.prepared.base, status: "in_progress" };
    this.service.storeProgress(this.prepared, created);
    await this.emit("response.created", { response: { ...created, status: "in_progress" } });
    await this.emit("response.in_progress", { response: created });
    try {
      for await (const event of this.service.events(this.prepared, signal)) {
        if (event.type === "text.delta") await this.textDelta(event.delta);
        else if (event.type === "reasoning.delta") await this.reasoningDelta(event.delta);
        else if (event.type === "tool.calls") await this.toolCalls(event.calls);
        else this.#usage = event.usage;
      }
      await this.finishItems();
      const response = this.service.finalize(this.prepared, {
        text: this.#text,
        reasoning: this.#reasoning,
        toolCalls: this.#calls,
        usage: this.#usage,
      }, this.#output);
      await this.emit("response.completed", { response });
    } catch (error) {
      if (signal.aborted) return;
      const apiError = asApiError(error);
      const failed = {
        ...this.prepared.base,
        status: "failed",
        error: { message: apiError.message, type: "server_error", code: apiError.code },
      };
      this.service.storeProgress(this.prepared, failed, this.#output);
      await this.emit("response.failed", { response: failed });
    }
  }

  private async textDelta(delta: string): Promise<void> {
    if (!this.#textId) {
      this.#textId = itemId("msg");
      const outputIndex = this.#output.length;
      this.#output.push({ id: this.#textId, type: "message", status: "in_progress", role: "assistant", content: [] });
      await this.emit("response.output_item.added", {
        output_index: outputIndex,
        item: this.#output[outputIndex],
      });
      await this.emit("response.content_part.added", {
        item_id: this.#textId,
        output_index: outputIndex,
        content_index: 0,
        part: { type: "output_text", text: "", annotations: [] },
      });
    }
    const outputIndex = this.#output.findIndex((item) => item.id === this.#textId);
    this.#text += delta;
    await this.emit("response.output_text.delta", {
      item_id: this.#textId,
      output_index: outputIndex,
      content_index: 0,
      delta,
      logprobs: [],
    });
  }

  private async reasoningDelta(delta: string): Promise<void> {
    if (!this.#reasoningId) {
      this.#reasoningId = itemId("rs");
      const outputIndex = this.#output.length;
      this.#output.push({ id: this.#reasoningId, type: "reasoning", summary: [] });
      await this.emit("response.output_item.added", {
        output_index: outputIndex,
        item: this.#output[outputIndex],
      });
      await this.emit("response.reasoning_summary_part.added", {
        item_id: this.#reasoningId,
        output_index: outputIndex,
        summary_index: 0,
        part: { type: "summary_text", text: "" },
      });
    }
    const outputIndex = this.#output.findIndex((item) => item.id === this.#reasoningId);
    this.#reasoning += delta;
    await this.emit("response.reasoning_summary_text.delta", {
      item_id: this.#reasoningId,
      output_index: outputIndex,
      summary_index: 0,
      delta,
    });
  }

  private async toolCalls(calls: ToolCall[]): Promise<void> {
    this.#calls.push(...calls);
    for (const call of calls) {
      const outputIndex = this.#output.length;
      const item = functionCallItem(call);
      await this.emit("response.output_item.added", {
        output_index: outputIndex,
        item: { ...item, status: "in_progress", arguments: "" },
      });
      await this.emit("response.function_call_arguments.delta", {
        item_id: item.id,
        output_index: outputIndex,
        delta: item.arguments,
      });
      await this.emit("response.function_call_arguments.done", {
        item_id: item.id,
        output_index: outputIndex,
        arguments: item.arguments,
      });
      this.#output.push(item);
      await this.emit("response.output_item.done", { output_index: outputIndex, item });
    }
  }

  private async finishItems(): Promise<void> {
    if (this.#reasoningId) {
      const outputIndex = this.#output.findIndex((entry) => entry.id === this.#reasoningId);
      const item = reasoningItem(this.#reasoning, this.#reasoningId);
      await this.emit("response.reasoning_summary_text.done", {
        item_id: item.id, output_index: outputIndex, summary_index: 0, text: this.#reasoning,
      });
      await this.emit("response.reasoning_summary_part.done", {
        item_id: item.id, output_index: outputIndex, summary_index: 0, part: item.summary[0],
      });
      this.#output[outputIndex] = item;
      await this.emit("response.output_item.done", { output_index: outputIndex, item });
    }
    if (this.#textId) {
      const outputIndex = this.#output.findIndex((entry) => entry.id === this.#textId);
      const item = messageItem(this.#text, this.#textId);
      await this.emit("response.output_text.done", {
        item_id: item.id, output_index: outputIndex, content_index: 0, text: this.#text, logprobs: [],
      });
      await this.emit("response.content_part.done", {
        item_id: item.id, output_index: outputIndex, content_index: 0, part: item.content[0],
      });
      this.#output[outputIndex] = item;
      await this.emit("response.output_item.done", { output_index: outputIndex, item });
    }
  }

  private async emit(type: string, payload: Record<string, unknown>): Promise<void> {
    await this.session.event(type, { type, sequence_number: this.#sequence++, ...payload });
  }
}
