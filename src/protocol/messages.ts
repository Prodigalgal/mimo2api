import type { MediaSource } from "../mimo/media.js";
import { ApiError } from "../core/errors.js";
import { buildToolPrompt, normalizeTools } from "./tools.js";
import type { MessageContentPart, ProtocolMessage, ToolDefinition } from "./types.js";

export interface PreparedMessages {
  query: string;
  media: MediaSource[];
  tools: ReturnType<typeof normalizeTools>;
}

export const prepareMessages = (
  messages: ProtocolMessage[],
  toolDefinitions: ToolDefinition[] | undefined,
  passthrough: boolean,
): PreparedMessages => {
  const tools = normalizeTools(toolDefinitions);
  const media: MediaSource[] = [];
  const system: string[] = [];
  const conversation: string[] = [];

  for (const message of messages) {
    const text = contentText(message.content, media);
    if (message.role === "system" || message.role === "developer") {
      if (text) system.push(text);
      continue;
    }
    if (message.tool_calls?.length) {
      conversation.push(`[ASSISTANT]\n${message.tool_calls.map((call) => `TOOL_CALL: ${call.function.name}(${call.function.arguments})`).join("\n")}`);
      continue;
    }
    if (message.role === "tool") {
      conversation.push(`[TOOL ${message.tool_call_id ?? ""}]\n${text}`);
      continue;
    }
    conversation.push(`[${message.role.toUpperCase()}]\n${text}`);
  }

  const toolPrompt = buildToolPrompt(tools, passthrough);
  const blocks = [system.join("\n\n"), toolPrompt, conversation.join("\n\n")].filter(Boolean);
  return { query: blocks.join("\n\n"), media, tools };
};

const contentText = (content: ProtocolMessage["content"], media: MediaSource[]): string => {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  const text: string[] = [];
  for (const part of content) {
    if (!part || typeof part !== "object") continue;
    if (["text", "input_text", "output_text"].includes(part.type) && typeof part.text === "string") {
      text.push(part.text);
    } else {
      const source = mediaFromPart(part);
      if (source) media.push(source);
    }
  }
  return text.join("\n");
};

const mediaFromPart = (part: MessageContentPart): MediaSource | undefined => {
  if (["image_url", "input_image"].includes(part.type)) {
    const image = part.image_url;
    const value = typeof image === "string" ? image : image?.url;
    if (!value) throw new ApiError(400, "invalid_media", "image content part requires image_url");
    return value.startsWith("data:")
      ? { kind: "image", data: value }
      : { kind: "image", url: value };
  }
  if (["file", "input_file"].includes(part.type)) {
    const file = part.file ?? part;
    const data = String(file.file_data ?? "");
    const url = String(file.file_url ?? "");
    if (!data && !url) throw new ApiError(400, "unsupported_file_reference", "file content part requires file_data or file_url; file_id is not supported");
    return {
      kind: "file",
      data: data || undefined,
      url: url || undefined,
      filename: String(file.filename ?? "file.bin"),
    };
  }
  return undefined;
};
