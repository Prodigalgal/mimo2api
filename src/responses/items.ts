import { randomUUID } from "node:crypto";
import type { ProtocolMessage, ToolCall, Usage } from "../protocol/types.js";
import type { CompactionCodec } from "./compaction.js";

export const canonicalInput = (input: unknown): Array<Record<string, any>> => {
  if (input === undefined || input === null) return [];
  const raw = Array.isArray(input) ? input : [input];
  return raw.flatMap((item) => {
    if (typeof item === "string") {
      return [{ id: itemId("msg"), type: "message", role: "user", content: [{ type: "input_text", text: item }] }];
    }
    if (!item || typeof item !== "object") return [];
    const copy = structuredClone(item) as Record<string, any>;
    copy.type ??= copy.role ? "message" : "input_text";
    copy.id ??= itemId(prefixFor(copy.type));
    if (copy.type === "message" && typeof copy.content === "string") {
      copy.content = [{ type: copy.role === "assistant" ? "output_text" : "input_text", text: copy.content }];
    }
    return [copy];
  });
};

export const expandCompactions = (
  items: Array<Record<string, any>>,
  codec: CompactionCodec,
): Array<Record<string, any>> => items.flatMap((item) => {
  if (item.type !== "compaction") return [item];
  return codec.decode(String(item.encrypted_content ?? ""));
});

export const responseItemsToMessages = (items: Array<Record<string, any>>): ProtocolMessage[] => {
  const messages: ProtocolMessage[] = [];
  for (const item of items) {
    if (item.type === "message") {
      messages.push({
        role: item.role ?? "user",
        content: normalizeContent(item.content),
      });
    } else if (item.type === "function_call") {
      messages.push({
        role: "assistant",
        content: null,
        tool_calls: [{
          id: item.call_id ?? item.id,
          type: "function",
          function: {
            name: item.name ?? "",
            arguments: typeof item.arguments === "string" ? item.arguments : JSON.stringify(item.arguments ?? {}),
          },
        }],
      });
    } else if (item.type === "function_call_output") {
      messages.push({
        role: "tool",
        tool_call_id: item.call_id,
        content: typeof item.output === "string" ? item.output : JSON.stringify(item.output ?? ""),
      });
    } else if (["input_text", "text"].includes(item.type)) {
      messages.push({ role: "user", content: String(item.text ?? "") });
    }
  }
  return messages;
};

export const outputItems = (text: string, reasoning: string, calls: ToolCall[]): Array<Record<string, any>> => {
  const items: Array<Record<string, any>> = [];
  if (reasoning) items.push(reasoningItem(reasoning));
  if (text) items.push(messageItem(text));
  for (const call of calls) items.push(functionCallItem(call));
  return items;
};

export const messageItem = (text: string, id = itemId("msg")) => ({
  id,
  type: "message",
  status: "completed",
  role: "assistant",
  content: [{ type: "output_text", text, annotations: [] }],
});

export const reasoningItem = (text: string, id = itemId("rs")) => ({
  id,
  type: "reasoning",
  summary: [{ type: "summary_text", text }],
});

export const functionCallItem = (call: ToolCall, id = itemId("fc")) => ({
  id,
  type: "function_call",
  call_id: call.id,
  name: call.function.name,
  arguments: call.function.arguments,
  status: "completed",
});

export const responseUsage = (usage: Usage | undefined) => usage ? ({
  input_tokens: usage.inputTokens,
  input_tokens_details: { cached_tokens: 0 },
  output_tokens: usage.outputTokens,
  output_tokens_details: { reasoning_tokens: 0 },
  total_tokens: usage.totalTokens,
}) : null;

export const outputText = (items: Array<Record<string, any>>): string => items
  .filter((item) => item.type === "message")
  .flatMap((item) => item.content ?? [])
  .filter((part) => part.type === "output_text")
  .map((part) => part.text ?? "")
  .join("");

export const itemId = (prefix: string): string => `${prefix}_${randomUUID().replaceAll("-", "").slice(0, 24)}`;

const normalizeContent = (content: unknown): any => {
  if (!Array.isArray(content)) return typeof content === "string" ? content : "";
  return content.map((part) => {
    if (!part || typeof part !== "object") return part;
    const copy = { ...(part as Record<string, any>) };
    if (copy.type === "input_image") copy.image_url = copy.image_url ?? copy.url;
    if (copy.type === "input_file") {
      copy.file = {
        filename: copy.filename,
        file_data: copy.file_data,
        file_url: copy.file_url,
      };
    }
    return copy;
  });
};

const prefixFor = (type: string): string => ({
  message: "msg", function_call: "fc", function_call_output: "fco", compaction: "cmp",
})[type] ?? "item";
