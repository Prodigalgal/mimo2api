import { once } from "node:events";
import type { FastifyReply } from "fastify";

export class SseSession {
  #heartbeat: NodeJS.Timeout;
  #closed = false;

  constructor(
    private readonly reply: FastifyReply,
    readonly controller: AbortController,
    requestId: string,
  ) {
    reply.hijack();
    reply.raw.writeHead(200, {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
      "X-Request-ID": requestId,
    });
    reply.raw.on("close", () => {
      this.#closed = true;
      clearInterval(this.#heartbeat);
      if (!reply.raw.writableEnded) controller.abort(new DOMException("Client disconnected", "AbortError"));
    });
    reply.raw.write(": connected\n\n");
    this.#heartbeat = setInterval(() => {
      if (!this.#closed && !reply.raw.writableEnded && !reply.raw.writableNeedDrain) {
        reply.raw.write(": ping\n\n");
      }
    }, Number(process.env.MIMO2API_SSE_HEARTBEAT_MS ?? 10_000));
    this.#heartbeat.unref();
  }

  async data(value: unknown): Promise<void> {
    const payload = typeof value === "string" ? value : JSON.stringify(value);
    await this.#write(`data: ${payload}\n\n`);
  }

  async event(type: string, value: Record<string, unknown>): Promise<void> {
    await this.#write(`event: ${type}\ndata: ${JSON.stringify(value)}\n\n`);
  }

  end(): void {
    if (this.#closed) return;
    this.#closed = true;
    clearInterval(this.#heartbeat);
    this.reply.raw.end();
  }

  async #write(chunk: string): Promise<void> {
    if (this.#closed || this.reply.raw.writableEnded || this.controller.signal.aborted) return;
    if (!this.reply.raw.write(chunk)) {
      await Promise.race([once(this.reply.raw, "drain"), once(this.reply.raw, "close")]);
    }
  }
}
