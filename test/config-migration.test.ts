import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ConfigStore } from "../src/config/store.js";

const stores: ConfigStore[] = [];
afterEach(() => stores.splice(0).forEach((store) => store.database.close()));

describe("legacy config migration", () => {
  it("imports accounts, proxy and temp-mail into SQLite without mutating JSON", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "mimo2api-"));
    const configFile = path.join(directory, "config.json");
    const databaseFile = path.join(directory, "mimo.sqlite");
    const legacy = {
      api_keys: "sk-test",
      admin_password: "secret",
      mimo_accounts: [{
        service_token: "service",
        user_id: "123",
        xiaomichatbot_ph: "ph",
        pass_token: "pass",
        mail_jwt: "mail-jwt",
        custom_field: "preserved",
      }],
      temp_mail: { api_base: "https://mail.example", admin_password: "mail-secret" },
      proxy_pool: { enabled: true, sub_url: "https://proxy.example/sub" },
    };
    await writeFile(configFile, JSON.stringify(legacy, null, 2));
    const original = await readFile(configFile, "utf8");

    const store = await ConfigStore.open(configFile, databaseFile);
    stores.push(store);
    const migrated = store.snapshot();
    expect(migrated.api_keys).toBe("sk-test");
    expect(migrated.mimo_accounts[0]).toMatchObject({
      user_id: "123", pass_token: "pass", mail_jwt: "mail-jwt", custom_field: "preserved",
    });
    expect(migrated.temp_mail.api_base).toBe("https://mail.example");
    expect(migrated.proxy_pool.sub_url).toBe("https://proxy.example/sub");
    expect(JSON.parse(store.database.meta("legacy_config_imported") ?? "{}").source).toBe(path.resolve(configFile));
    expect(await readFile(configFile, "utf8")).toBe(original);
  });

  it("leases each due renewal once", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "mimo2api-"));
    const configFile = path.join(directory, "config.json");
    const databaseFile = path.join(directory, "mimo.sqlite");
    await writeFile(configFile, JSON.stringify({
      mimo_accounts: [{ service_token: "s", user_id: "u", xiaomichatbot_ph: "p", pass_token: "pt" }],
    }));
    const store = await ConfigStore.open(configFile, databaseFile);
    stores.push(store);
    store.database.enqueueAllRenewals(60_000);
    const first = store.database.claimRenewal(Date.now() + 120_000, 900_000);
    const duplicate = store.database.claimRenewal(Date.now() + 120_000, 900_000);
    expect(first?.account.user_id).toBe("u");
    expect(duplicate).toBeUndefined();
  });
});
