import { mkdtemp, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ConfigStore } from "../src/config/store.js";
import { ConversationStore } from "../src/sessions/store.js";

const stores: ConfigStore[] = [];
afterEach(() => stores.splice(0).forEach((store) => store.database.close()));

const setup = async (): Promise<{ config: ConfigStore; sessions: ConversationStore }> => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "mimo2api-session-"));
  const configFile = path.join(directory, "config.json");
  await writeFile(configFile, JSON.stringify({
    mimo_accounts: [{
      service_token: "service-token",
      user_id: "user-1",
      xiaomichatbot_ph: "ph-1",
      is_valid: true,
    }],
  }));
  const config = await ConfigStore.open(configFile, path.join(directory, "state.sqlite"));
  stores.push(config);
  return { config, sessions: new ConversationStore(config.database) };
};

describe("conversation session store", () => {
  it("keeps an explicit session on one account and reuses its cached context", async () => {
    const { config, sessions } = await setup();
    const input = { tenant: "tenant-a", sessionId: "chat-42", model: "mimo-v2.5-pro" };
    const first = sessions.resolve(input, config)!;
    sessions.rememberContext(first, "ctx-1", "[USER]\nhello", [{ role: "user", content: "hello" }]);
    const second = sessions.resolve(input, config)!;

    expect(second.account.user_id).toBe(first.account.user_id);
    expect(second.conversationId).toBe(first.conversationId);
    expect(sessions.cachedQuery(second, "ctx-1")).toBe("[USER]\nhello");
  });

  it("marks token-heavy sessions for compaction and rotates their upstream conversation", async () => {
    const { config, sessions } = await setup();
    const input = { tenant: "tenant-a", sessionId: "chat-43", model: "mimo-v2.5-pro" };
    const first = sessions.resolve(input, config)!;
    sessions.rememberContext(first, "ctx-2", "[USER]\nlarge context", [{ role: "user", content: "large context" }]);
    sessions.recordUsage(first, 150_000);
    const pending = sessions.resolve(input, config)!;
    const rotated = sessions.rotateAfterCompaction(pending, "important compacted context");
    const after = sessions.resolve(input, config)!;

    expect(pending.shouldCompact).toBe(true);
    expect(rotated.conversationId).not.toBe(first.conversationId);
    expect(after.promptTokens).toBe(0);
    expect(after.summary).toBe("important compacted context");
  });
});
