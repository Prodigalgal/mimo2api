export interface FunctionDefinition {
  name: string;
  description?: string;
  parameters?: Record<string, unknown>;
  strict?: boolean;
}

export interface ToolDefinition {
  type: "function";
  function?: FunctionDefinition;
  name?: string;
  description?: string;
  parameters?: Record<string, unknown>;
  strict?: boolean;
}

export interface ToolCall {
  id: string;
  type: "function";
  function: { name: string; arguments: string };
}

export interface MessageContentPart {
  type: string;
  text?: string;
  image_url?: string | { url?: string };
  file?: { filename?: string; file_data?: string; data?: string; file_url?: string };
  filename?: string;
  file_data?: string;
  file_url?: string;
  [key: string]: unknown;
}

export interface ProtocolMessage {
  role: "system" | "developer" | "user" | "assistant" | "tool";
  content?: string | MessageContentPart[] | null;
  tool_calls?: ToolCall[];
  tool_call_id?: string;
}

export interface Usage {
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
}

export type SemanticEvent =
  | { type: "text.delta"; delta: string }
  | { type: "reasoning.delta"; delta: string }
  | { type: "tool.calls"; calls: ToolCall[] }
  | { type: "usage"; usage: Usage };
