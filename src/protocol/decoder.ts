import { ApiError } from "../core/errors.js";
import { parseToolCalls } from "./tools.js";
import type { FunctionDefinition, SemanticEvent } from "./types.js";

const thinkOpen = "<think>";
const thinkClose = "</think>";
const toolStarts = ["<|MiMoML|tool_calls>", "<tool_call>", "<function_call>", "<function_calls>", "TOOL_CALL:"];

export class SemanticDecoder {
  #buffer = "";
  #capture = "";
  #reasoning = false;
  #capturingTool = false;
  #sawText = false;
  #sawTool = false;

  constructor(
    private readonly tools: FunctionDefinition[],
    private readonly toolRequired: boolean,
  ) {}

  push(chunk: string): SemanticEvent[] {
    if (this.#capturingTool) {
      this.#capture += chunk;
      return this.#finishToolIfComplete(false);
    }
    this.#buffer += chunk.replaceAll("\0", "");
    return this.#drain(false);
  }

  flush(): SemanticEvent[] {
    const events = this.#capturingTool ? this.#finishToolIfComplete(true) : this.#drain(true);
    if (this.#capturingTool) {
      throw new ApiError(422, "tool_call_generation_failed", "model returned an incomplete tool call");
    }
    if (this.toolRequired && !this.#sawTool) {
      throw new ApiError(422, "tool_call_generation_failed", "model did not return a required tool call");
    }
    if (!this.#sawText && !this.#sawTool) {
      throw new ApiError(502, "empty_model_response", "model returned neither content nor a tool call");
    }
    return events;
  }

  #drain(flush: boolean): SemanticEvent[] {
    const events: SemanticEvent[] = [];
    while (this.#buffer) {
      const controls = this.#reasoning
        ? [thinkClose]
        : [thinkOpen, ...(this.tools.length > 0 ? toolStarts : [])];
      const hit = earliest(this.#buffer, controls);
      if (!hit) {
        const hold = flush ? 0 : partialSuffixLength(this.#buffer, controls);
        const value = hold ? this.#buffer.slice(0, -hold) : this.#buffer;
        this.#buffer = hold ? this.#buffer.slice(-hold) : "";
        this.#emitText(value, events);
        break;
      }
      this.#emitText(this.#buffer.slice(0, hit.index), events);
      this.#buffer = this.#buffer.slice(hit.index + hit.token.length);
      if (hit.token === thinkOpen) this.#reasoning = true;
      else if (hit.token === thinkClose) this.#reasoning = false;
      else {
        this.#capturingTool = true;
        this.#capture = hit.token + this.#buffer;
        this.#buffer = "";
        events.push(...this.#finishToolIfComplete(false));
        break;
      }
    }
    return events;
  }

  #emitText(value: string, events: SemanticEvent[]): void {
    if (!value) return;
    if (this.#reasoning) events.push({ type: "reasoning.delta", delta: value });
    else {
      this.#sawText ||= Boolean(value.trim());
      events.push({ type: "text.delta", delta: value });
    }
  }

  #finishToolIfComplete(flush: boolean): SemanticEvent[] {
    if (!flush && !toolCaptureComplete(this.#capture)) return [];
    const calls = parseToolCalls(this.#capture, this.tools);
    if (calls.length === 0) {
      if (flush || toolCaptureComplete(this.#capture)) {
        throw new ApiError(422, "tool_call_generation_failed", "model emitted tool syntax that could not be parsed");
      }
      return [];
    }
    this.#capturingTool = false;
    this.#capture = "";
    this.#sawTool = true;
    return [{ type: "tool.calls", calls }];
  }
}

const earliest = (text: string, tokens: string[]): { token: string; index: number } | undefined => {
  let result: { token: string; index: number } | undefined;
  for (const token of tokens) {
    const index = text.indexOf(token);
    if (index >= 0 && (!result || index < result.index)) result = { token, index };
  }
  return result;
};

const partialSuffixLength = (text: string, tokens: string[]): number => {
  const max = Math.min(text.length, Math.max(...tokens.map((token) => token.length)) - 1);
  for (let length = max; length > 0; length -= 1) {
    const suffix = text.slice(-length);
    if (tokens.some((token) => token.startsWith(suffix))) return length;
  }
  return 0;
};

const toolCaptureComplete = (text: string): boolean => {
  if (text.startsWith("<|MiMoML|tool_calls>")) return text.includes("</|MiMoML|tool_calls>");
  if (text.startsWith("<tool_call>")) return text.includes("</tool_call>");
  if (text.startsWith("<function_calls>")) return text.includes("</function_calls>");
  if (text.startsWith("<function_call>")) return text.includes("</function_call>");
  return text.startsWith("TOOL_CALL:") && (text.includes("\n") || /\)\s*$/.test(text));
};
