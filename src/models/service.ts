import { fetch } from "undici";
import type { ConfigStore } from "../config/store.js";

const defaultModels = ["mimo-v2.5-pro"];
const excluded = /(?:tts|asr|speech|audio|voice(?:clone|design)?)/i;

export class ModelService {
  #models: string[] = defaultModels;

  constructor(private readonly config: ConfigStore) {
    const configured = this.config.snapshot().models.filter((model) => !excluded.test(model));
    if (configured.length > 0) this.#models = configured;
  }

  list(): string[] {
    return [...this.#models];
  }

  async refresh(): Promise<string[]> {
    if (this.config.snapshot().models.length > 0) return this.list();
    try {
      const response = await fetch("https://aistudio.xiaomimimo.com/open-apis/bot/config", {
        headers: { "User-Agent": "Mozilla/5.0" },
        signal: AbortSignal.timeout(10_000),
      });
      if (!response.ok) return this.list();
      const payload = await response.json() as { data?: { modelConfigList?: Array<{ model?: string }> } };
      const discovered = (payload.data?.modelConfigList ?? [])
        .map((item) => item.model ?? "")
        .filter((model) => model && !excluded.test(model));
      if (discovered.length > 0) this.#models = [...new Set(discovered)];
    } catch { /* retain last known models */ }
    return this.list();
  }
}
