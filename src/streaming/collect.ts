import type { CompletionService, CompletionRequest } from "../protocol/completion.js";
import type { ToolCall, Usage } from "../protocol/types.js";

export interface CompletionResult {
  text: string;
  reasoning: string;
  toolCalls: ToolCall[];
  usage: Usage;
}

export const collectCompletion = async (
  service: CompletionService,
  request: CompletionRequest,
  signal: AbortSignal,
): Promise<CompletionResult> => {
  let text = "";
  let reasoning = "";
  let toolCalls: ToolCall[] = [];
  let usage: Usage = { inputTokens: 0, outputTokens: 0, totalTokens: 0 };
  for await (const event of service.events(request, signal)) {
    if (event.type === "text.delta") text += event.delta;
    else if (event.type === "reasoning.delta") reasoning += event.delta;
    else if (event.type === "tool.calls") toolCalls = [...toolCalls, ...event.calls];
    else usage = event.usage;
  }
  return { text, reasoning, toolCalls, usage };
};
