import type { ConfigStore } from "../config/store.js";
import { ApiError } from "../core/errors.js";
import { MimoClient } from "../mimo/client.js";
import { uploadSources } from "../mimo/media.js";
import { SemanticDecoder } from "./decoder.js";
import { prepareMessages } from "./messages.js";
import type { ProtocolMessage, SemanticEvent, ToolDefinition } from "./types.js";
import type { UsageRepository } from "../usage/repository.js";

export interface CompletionRequest {
  model?: string;
  messages: ProtocolMessage[];
  tools?: ToolDefinition[];
  toolChoice?: unknown;
  reasoningEffort?: string;
  thinking?: boolean;
}

export class CompletionService {
  constructor(
    private readonly config: ConfigStore,
    private readonly usage?: UsageRepository,
  ) {}

  async *events(request: CompletionRequest, signal: AbortSignal): AsyncGenerator<SemanticEvent> {
    const account = this.config.nextAccount();
    if (!account) throw new ApiError(503, "no_mimo_account", "no usable MiMo account is configured");
    const model = validateModel(request.model ?? "mimo-v2.5-pro");
    const prepared = prepareMessages(
      request.messages,
      request.tools,
      this.config.snapshot().tools_passthrough,
    );
    const client = new MimoClient(account);
    const media = await uploadSources(client, prepared.media, model, signal);
    const decoder = new SemanticDecoder(prepared.tools, toolChoiceRequired(request.toolChoice));
    let usageSeen = false;
    let finalUsage = { inputTokens: 0, outputTokens: 0, totalTokens: 0 };
    for await (const upstream of client.stream({
      query: prepared.query,
      model,
      thinking: request.thinking ?? shouldThink(request.reasoningEffort),
      media,
    }, signal)) {
      if (upstream.type === "text") {
        for (const event of decoder.push(upstream.text)) yield event;
      } else {
        usageSeen = true;
        finalUsage = {
          inputTokens: upstream.inputTokens,
          outputTokens: upstream.outputTokens,
          totalTokens: upstream.totalTokens,
        };
        yield {
          type: "usage",
          usage: finalUsage,
        };
      }
    }
    for (const event of decoder.flush()) yield event;
    if (usageSeen) this.usage?.record(model, finalUsage);
    if (!usageSeen) yield { type: "usage", usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 } };
  }
}

export const validateModel = (model: string): string => {
  if (/(?:tts|asr|speech|audio|voice(?:clone|design)?)/i.test(model)) {
    throw new ApiError(400, "unsupported_model", `audio model ${model} is not supported`, "model");
  }
  return model;
};

const shouldThink = (effort: string | undefined): boolean => (
  Boolean(effort) && !["none", "minimal"].includes(effort!.toLowerCase())
);

const toolChoiceRequired = (choice: unknown): boolean => {
  if (typeof choice === "string") return ["required", "any"].includes(choice.toLowerCase());
  return Boolean(choice && typeof choice === "object" && (choice as { type?: string }).type === "function");
};
