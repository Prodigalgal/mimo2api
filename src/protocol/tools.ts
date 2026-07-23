import { randomUUID } from "node:crypto";
import { Ajv2020, type ErrorObject, type ValidateFunction } from "ajv/dist/2020.js";
import { ApiError } from "../core/errors.js";
import type { FunctionDefinition, ToolCall, ToolDefinition } from "./types.js";

const ajv = new Ajv2020({ allErrors: true, strict: false });

export const normalizeTools = (tools: ToolDefinition[] | undefined): FunctionDefinition[] => (
  (tools ?? []).filter((tool) => tool?.type === "function").map((tool) => {
    const definition = tool.function ?? tool;
    if (!definition.name) throw new ApiError(400, "invalid_tool", "function tool requires a name", "tools");
    return {
      name: definition.name,
      description: definition.description ?? "",
      parameters: definition.parameters ?? { type: "object", properties: {} },
      strict: definition.strict ?? false,
    };
  })
);

export const buildToolPrompt = (tools: FunctionDefinition[], passthrough = false): string => {
  if (tools.length === 0) return "";
  if (passthrough) {
    return `Use the following function tools when needed. Return a structured tool call.\n<tools>${JSON.stringify(tools)}</tools>`;
  }
  const definitions = tools.map((tool) => ({
    name: tool.name,
    description: tool.description ?? "",
    parameters: tool.parameters ?? { type: "object", properties: {} },
  }));
  return [
    "You can call the functions below. The complete JSON Schema for every function is authoritative.",
    `<tools>${JSON.stringify(definitions)}</tools>`,
    "When a function is required, output only this exact format:",
    "<|MiMoML|tool_calls>",
    "<|MiMoML|invoke name=\"FUNCTION_NAME\">",
    "<|MiMoML|parameter name=\"PARAMETER_NAME\"><![CDATA[VALUE]]></|MiMoML|parameter>",
    "</|MiMoML|invoke>",
    "</|MiMoML|tool_calls>",
    "Use the exact property names from parameters. Do not invent or rename arguments.",
  ].join("\n");
};

export const parseToolCalls = (text: string, tools: FunctionDefinition[]): ToolCall[] => {
  const known = new Map(tools.map((tool) => [tool.name.toLowerCase(), tool]));
  const parsed = [
    ...parseMimoMl(text, known),
    ...parseXmlToolCalls(text, known),
    ...parseJsonToolCalls(text, known),
    ...parsePlainToolCalls(text, known),
  ];
  const unique = new Map<string, ToolCall>();
  for (const call of parsed) unique.set(`${call.function.name}:${call.function.arguments}`, call);
  return validateToolCalls([...unique.values()], tools);
};

export const validateToolCalls = (calls: ToolCall[], tools: FunctionDefinition[]): ToolCall[] => {
  const validators = new Map<string, ValidateFunction>();
  for (const tool of tools) validators.set(tool.name, ajv.compile(tool.parameters ?? {}));
  return calls.map((call) => {
    const validate = validators.get(call.function.name);
    if (!validate) throw new ApiError(422, "unknown_tool", `model called unknown tool ${call.function.name}`);
    let args: unknown;
    try {
      args = JSON.parse(call.function.arguments);
    } catch {
      throw new ApiError(422, "invalid_tool_arguments", `tool ${call.function.name} returned invalid JSON arguments`);
    }
    if (!validate(args)) {
      throw new ApiError(422, "invalid_tool_arguments", formatAjvError(call.function.name, validate.errors));
    }
    return { ...call, function: { ...call.function, arguments: JSON.stringify(args) } };
  });
};

const parseMimoMl = (text: string, known: Map<string, FunctionDefinition>): ToolCall[] => {
  const calls: ToolCall[] = [];
  const invoke = /<\|MiMoML\|invoke\s+name=["']([^"']+)["']\s*>([\s\S]*?)<\/\|MiMoML\|invoke>/gi;
  for (const match of text.matchAll(invoke)) {
    const name = resolveName(match[1] ?? "", known);
    if (!name) continue;
    const args: Record<string, unknown> = {};
    const parameter = /<\|MiMoML\|parameter\s+name=["']([^"']+)["']\s*>(?:<!\[CDATA\[)?([\s\S]*?)(?:\]\]>)?<\/\|MiMoML\|parameter>/gi;
    for (const item of (match[2] ?? "").matchAll(parameter)) args[item[1] ?? ""] = autoType((item[2] ?? "").trim());
    calls.push(makeCall(name, args));
  }
  return calls;
};

const parseXmlToolCalls = (text: string, known: Map<string, FunctionDefinition>): ToolCall[] => {
  const calls: ToolCall[] = [];
  const block = /<tool_call>([\s\S]*?)<\/tool_call>/gi;
  for (const match of text.matchAll(block)) {
    const inner = match[1] ?? "";
    const functionMatch = /<function=([\w.-]+)>([\s\S]*?)<\/function>/i.exec(inner);
    const toolNameMatch = /<tool_name>([\s\S]*?)<\/tool_name>/i.exec(inner);
    const name = resolveName(functionMatch?.[1] ?? toolNameMatch?.[1] ?? "", known);
    if (!name) continue;
    const source = functionMatch?.[2] ?? inner;
    const args: Record<string, unknown> = {};
    for (const item of source.matchAll(/<parameter=([\w.-]+)>([\s\S]*?)<\/parameter>/gi)) {
      args[item[1] ?? ""] = autoType((item[2] ?? "").trim());
    }
    if (toolNameMatch) {
      for (const item of source.matchAll(/<([\w.-]+)>([\s\S]*?)<\/\1>/g)) {
        if ((item[1] ?? "").toLowerCase() !== "tool_name") args[item[1] ?? ""] = autoType((item[2] ?? "").trim());
      }
    }
    calls.push(makeCall(name, args));
  }
  return calls;
};

const parseJsonToolCalls = (text: string, known: Map<string, FunctionDefinition>): ToolCall[] => {
  const calls: ToolCall[] = [];
  for (const match of text.matchAll(/<function_calls?>([\s\S]*?)<\/function_calls?>/gi)) {
    const objects = (match[1] ?? "").match(/\{[\s\S]*?\}/g) ?? [];
    for (const raw of objects) {
      try {
        const value = JSON.parse(raw) as { name?: string; arguments?: unknown };
        const name = resolveName(value.name ?? "", known);
        if (name) calls.push(makeCall(name, value.arguments ?? {}));
      } catch { /* ignore malformed candidates */ }
    }
  }
  return calls;
};

const parsePlainToolCalls = (text: string, known: Map<string, FunctionDefinition>): ToolCall[] => {
  const calls: ToolCall[] = [];
  for (const match of text.matchAll(/TOOL_CALL:\s*([\w.-]+)\s*\(([^\n]*)\)/gi)) {
    const name = resolveName(match[1] ?? "", known);
    if (!name) continue;
    const raw = (match[2] ?? "").trim();
    let args: unknown = {};
    try {
      args = raw.startsWith("{") ? JSON.parse(raw) : parseKeyValues(raw);
    } catch { /* validator will report invalid arguments */ }
    calls.push(makeCall(name, args));
  }
  return calls;
};

const parseKeyValues = (value: string): Record<string, unknown> => Object.fromEntries(
  value.split(",").map((part) => part.split("=", 2).map((item) => item.trim())).filter((pair) => pair.length === 2)
    .map(([key, raw]) => [key, autoType(raw ?? "")]),
);

const resolveName = (name: string, known: Map<string, FunctionDefinition>): string | undefined => {
  const normalized = name.trim().toLowerCase();
  const direct = known.get(normalized);
  if (direct) return direct.name;
  const compact = normalized.replaceAll("_", "").replaceAll("-", "");
  return [...known.values()].find((tool) => tool.name.toLowerCase().replaceAll("_", "").replaceAll("-", "") === compact)?.name;
};

const makeCall = (name: string, args: unknown): ToolCall => ({
  id: `call_${randomUUID().replaceAll("-", "").slice(0, 24)}`,
  type: "function",
  function: { name, arguments: JSON.stringify(args ?? {}) },
});

const autoType = (value: string): unknown => {
  const cleaned = value.replace(/^<!\[CDATA\[/, "").replace(/\]\]>$/, "").trim();
  try { return JSON.parse(cleaned); } catch { return cleaned; }
};

const formatAjvError = (name: string, errors: ErrorObject[] | null | undefined): string => {
  const error = errors?.[0];
  return error ? `tool ${name} arguments ${error.instancePath || "/"} ${error.message}` : `tool ${name} arguments do not match its JSON Schema`;
};
