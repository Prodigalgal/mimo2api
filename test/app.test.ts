import { mkdtemp, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { buildApp } from "../src/app.js";

describe("Fastify application", () => {
  it("starts with unique routes and enforces API/admin authentication", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "mimo2api-app-"));
    const configFile = path.join(directory, "config.json");
    await writeFile(configFile, JSON.stringify({ api_keys: "sk-test", admin_password: "admin-test" }));
    const app = await buildApp({
      configFile,
      databaseFile: path.join(directory, "db.sqlite"),
      startScheduler: false,
      logger: false,
    });
    try {
      expect((await app.inject({ method: "GET", url: "/healthz" })).statusCode).toBe(200);
      expect((await app.inject({ method: "GET", url: "/v1/models" })).statusCode).toBe(401);
      expect((await app.inject({
        method: "GET", url: "/v1/models", headers: { authorization: "Bearer sk-test" },
      })).statusCode).toBe(200);
      expect((await app.inject({ method: "GET", url: "/" })).statusCode).toBe(401);
      expect((await app.inject({ method: "GET", url: "/index.html" })).statusCode).toBe(401);
      expect((await app.inject({
        method: "GET",
        url: "/",
        headers: { authorization: `Basic ${Buffer.from("admin:admin-test").toString("base64")}` },
      })).statusCode).toBe(200);
      const admin = await app.inject({
        method: "GET",
        url: "/admin",
        headers: { authorization: `Basic ${Buffer.from("admin:admin-test").toString("base64")}` },
      });
      expect(admin.payload).toContain('data-lucide="eye"');
      expect((await app.inject({ method: "GET", url: "/vendor/lucide/lucide.min.js" })).statusCode).toBe(200);
    } finally {
      await app.close();
    }
  });
});
