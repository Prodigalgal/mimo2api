import type { AppDatabase } from "../db/database.js";
import type { Usage } from "../protocol/types.js";

export class UsageRepository {
  constructor(private readonly database: AppDatabase) {}

  record(model: string, usage: Usage): void {
    const day = new Date().toISOString().slice(0, 10);
    this.database.connection.prepare(`
      INSERT INTO usage_daily(day, model, requests, input_tokens, output_tokens)
      VALUES (?, ?, 1, ?, ?)
      ON CONFLICT(day, model) DO UPDATE SET
        requests = requests + 1,
        input_tokens = input_tokens + excluded.input_tokens,
        output_tokens = output_tokens + excluded.output_tokens
    `).run(day, model, usage.inputTokens, usage.outputTokens);
  }

  summary(): object {
    const rows = this.database.connection.prepare(`
      SELECT day, model, requests, input_tokens, output_tokens FROM usage_daily ORDER BY day DESC, model
    `).all() as Array<Record<string, any>>;
    const periods: Record<string, any> = {};
    for (const row of rows) {
      periods[row.day] ??= { models: {}, total: { requests: 0, input_tokens: 0, output_tokens: 0, total_tokens: 0 } };
      const value = {
        requests: row.requests,
        input_tokens: row.input_tokens,
        output_tokens: row.output_tokens,
        total_tokens: row.input_tokens + row.output_tokens,
      };
      periods[row.day].models[row.model] = value;
      for (const key of Object.keys(value)) periods[row.day].total[key] += value[key as keyof typeof value];
    }
    return { periods };
  }

  clear(): number {
    return this.database.connection.prepare("DELETE FROM usage_daily").run().changes;
  }
}
