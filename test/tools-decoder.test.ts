import { describe, expect, it } from "vitest";
import { SemanticDecoder } from "../src/protocol/decoder.js";
import { buildToolPrompt, parseToolCalls } from "../src/protocol/tools.js";

const tools = [{
  name: "get_weather",
  description: "Weather",
  parameters: {
    type: "object",
    properties: { city: { type: "string" } },
    required: ["city"],
    additionalProperties: false,
  },
}];

describe("tool protocol", () => {
  it("injects the complete JSON schema", () => {
    const prompt = buildToolPrompt(tools);
    expect(prompt).toContain('"city":{"type":"string"}');
    expect(prompt).toContain('"additionalProperties":false');
  });

  it("parses and validates MiMoML arguments", () => {
    const calls = parseToolCalls(
      '<|MiMoML|tool_calls><|MiMoML|invoke name="get_weather"><|MiMoML|parameter name="city"><![CDATA[Nanjing]]></|MiMoML|parameter></|MiMoML|invoke></|MiMoML|tool_calls>',
      tools,
    );
    expect(JSON.parse(calls[0]!.function.arguments)).toEqual({ city: "Nanjing" });
  });

  it("rejects arguments that violate the declared schema", () => {
    expect(() => parseToolCalls(
      '<|MiMoML|tool_calls><|MiMoML|invoke name="get_weather"><|MiMoML|parameter name="location"><![CDATA[Nanjing]]></|MiMoML|parameter></|MiMoML|invoke></|MiMoML|tool_calls>',
      tools,
    )).toThrow(/arguments/);
  });

  it("decodes reasoning, text and tools across arbitrary chunk boundaries", () => {
    const decoder = new SemanticDecoder(tools, true);
    const chunks = ["<thi", "nk>plan", "ning</thi", "nk><|MiMoML|tool_", "calls><|MiMoML|invoke name=\"get_weather\"><|MiMoML|parameter name=\"city\"><![CDATA[Nanjing]]></|MiMoML|parameter></|MiMoML|invoke></|MiMoML|tool_calls>"];
    const events = chunks.flatMap((chunk) => decoder.push(chunk));
    events.push(...decoder.flush());
    expect(events.filter((event) => event.type === "reasoning.delta").map((event: any) => event.delta).join("")).toBe("planning");
    const call = events.find((event) => event.type === "tool.calls") as any;
    expect(JSON.parse(call.calls[0].function.arguments)).toEqual({ city: "Nanjing" });
  });
});
