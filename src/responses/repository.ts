import type { AppDatabase } from "../db/database.js";

export interface StoredResponse {
  response: Record<string, any>;
  input: Array<Record<string, any>>;
  context: Array<Record<string, any>>;
  sessionId: string;
}

export class ResponseRepository {
  constructor(private readonly database: AppDatabase) {}

  save(record: StoredResponse, ttlSeconds = 7 * 86_400): void {
    const now = Date.now();
    this.database.connection.prepare(`
      INSERT INTO responses(
        id, status, background, session_id, response_json, input_json, context_json,
        created_at, updated_at, expires_at
      ) VALUES (@id, @status, @background, @sessionId, @response, @input, @context, @created, @updated, @expires)
      ON CONFLICT(id) DO UPDATE SET
        status = excluded.status,
        background = excluded.background,
        session_id = excluded.session_id,
        response_json = excluded.response_json,
        input_json = excluded.input_json,
        context_json = excluded.context_json,
        updated_at = excluded.updated_at,
        expires_at = excluded.expires_at
    `).run({
      id: record.response.id,
      status: record.response.status,
      background: record.response.background ? 1 : 0,
      sessionId: record.sessionId,
      response: JSON.stringify(record.response),
      input: JSON.stringify(record.input),
      context: JSON.stringify(record.context),
      created: Number(record.response.created_at ?? Math.floor(now / 1_000)) * 1_000,
      updated: now,
      expires: ttlSeconds > 0 ? now + ttlSeconds * 1_000 : null,
    });
  }

  get(id: string): StoredResponse | undefined {
    const row = this.database.connection.prepare(`
      SELECT response_json, input_json, context_json, session_id FROM responses
      WHERE id = ? AND (expires_at IS NULL OR expires_at > ?)
    `).get(id, Date.now()) as { response_json: string; input_json: string; context_json: string; session_id: string } | undefined;
    if (!row) return undefined;
    return {
      response: JSON.parse(row.response_json),
      input: JSON.parse(row.input_json),
      context: JSON.parse(row.context_json),
      sessionId: row.session_id,
    };
  }

  delete(id: string): boolean {
    return this.database.connection.prepare("DELETE FROM responses WHERE id = ?").run(id).changes === 1;
  }

  cleanup(): number {
    return this.database.connection.prepare("DELETE FROM responses WHERE expires_at IS NOT NULL AND expires_at <= ?").run(Date.now()).changes;
  }
}
