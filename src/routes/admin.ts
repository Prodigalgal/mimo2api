import type { FastifyPluginAsync, FastifyRequest } from "fastify";
import type { ConfigStore } from "../config/store.js";
import { MimoAccountSchema, type AppConfig } from "../config/types.js";
import { requireAdmin } from "../core/auth.js";
import { ApiError } from "../core/errors.js";
import { MimoClient } from "../mimo/client.js";
import type { ProxyPool } from "../proxy/pool.js";
import type { ResponseRepository } from "../responses/repository.js";
import type { RenewalScheduler } from "../accounts/renewal-scheduler.js";
import { TempMailClient } from "../tempmail/client.js";
import type { UsageRepository } from "../usage/repository.js";

interface AdminServices {
  renewals: RenewalScheduler;
  proxy: ProxyPool;
  responses: ResponseRepository;
  usage: UsageRepository;
}

export const adminRoutes = (config: ConfigStore, services: AdminServices): FastifyPluginAsync => async (app) => {
  app.addHook("preHandler", requireAdmin(config));

  app.get("/api/config", async () => config.publicView());
  app.post("/api/config", async (request) => {
    const patch = (request.body ?? {}) as Partial<AppConfig>;
    if (!patch || typeof patch !== "object") throw new ApiError(400, "invalid_config", "invalid config body");
    const updated = await config.update(preserveMaskedSecrets(config.snapshot(), patch));
    services.proxy.configure(updated.proxy_pool);
    return { ok: true, config: config.publicView() };
  });

  app.get("/api/accounts", async () => ({ accounts: config.publicView().mimo_accounts }));
  app.post<{ Params: { index: string } }>("/api/accounts/:index/test", async (request) => {
    const account = accountAt(config, request.params.index);
    const client = new MimoClient(account);
    let content = "";
    for await (const event of client.stream({ query: "hi", model: "mimo-v2.5-pro", thinking: false }, AbortSignal.timeout(120_000))) {
      if (event.type === "text") content += event.text;
    }
    return { ok: true, content: content.slice(0, 200) };
  });
  app.post<{ Params: { index: string } }>("/api/accounts/:index/renew", async (request) => (
    services.renewals.renewIndex(parseIndex(request.params.index))
  ));
  app.post("/api/accounts/renew-all", async () => {
    const spreadMs = Math.max(60_000, Number(process.env.MIMO2API_RENEW_MANUAL_SPREAD_SECONDS ?? 900) * 1_000);
    const queued = config.database.enqueueAllRenewals(spreadMs);
    return { ok: true, queued, spread_seconds: Math.floor(spreadMs / 1_000), scheduler: services.renewals.status() };
  });
  app.get("/api/accounts/renew-status", async () => services.renewals.status());
  app.delete<{ Params: { index: string } }>("/api/accounts/:index", async (request) => {
    const index = parseIndex(request.params.index);
    const accounts = config.snapshot().mimo_accounts;
    const removed = accounts[index];
    if (!removed) throw new ApiError(404, "account_not_found", "account not found");
    accounts.splice(index, 1);
    await config.replaceAccounts(accounts);
    return { ok: true, removed_user_id: removed.user_id };
  });

  app.post("/api/account/import-cookie", async (request) => {
    const body = request.body as { cookie?: string };
    const account = parseCookie(body?.cookie ?? "");
    const accounts = config.snapshot().mimo_accounts;
    accounts.push(account);
    await config.replaceAccounts(accounts);
    return { ok: true, account: config.publicView().mimo_accounts.at(-1) };
  });
  app.post("/api/account/import-curl", async (request) => {
    const body = request.body as { curl?: string };
    const match = /(?:-b|--cookie)\s+(?:'([^']+)'|"([^"]+)")/i.exec(body?.curl ?? "");
    if (!match) throw new ApiError(400, "invalid_curl", "cURL does not contain a Cookie argument");
    const account = parseCookie(match[1] ?? match[2] ?? "");
    const accounts = config.snapshot().mimo_accounts;
    accounts.push(account);
    await config.replaceAccounts(accounts);
    return { ok: true, account: config.publicView().mimo_accounts.at(-1) };
  });

  app.get("/api/temp-mail/config", async () => ({ ok: true, temp_mail: config.snapshot().temp_mail }));
  app.post("/api/temp-mail/config", async (request) => {
    const updated = await config.update({ temp_mail: request.body as AppConfig["temp_mail"] });
    return { ok: true, temp_mail: updated.temp_mail };
  });
  app.post("/api/temp-mail/test", async (request) => (
    new TempMailClient(config.snapshot().temp_mail).test(requestController(request).signal)
  ));

  app.get("/api/proxy-pool/config", async () => ({
    ok: true, proxy_pool: config.snapshot().proxy_pool, runtime: services.proxy.status(),
  }));
  app.post("/api/proxy-pool/config", async (request) => {
    const body = request.body as Record<string, any>;
    const updated = await config.update({ proxy_pool: body.proxy_pool ?? body });
    services.proxy.configure(updated.proxy_pool);
    return { ok: true, proxy_pool: updated.proxy_pool, runtime: services.proxy.status() };
  });
  app.get("/api/proxy-pool/status", async () => ({ ok: true, ...services.proxy.status() }));
  app.post("/api/proxy-pool/refresh", async (request) => ({
    ok: true, nodes: (await services.proxy.refresh(requestController(request).signal)).length, ...services.proxy.status(),
  }));
  app.post("/api/proxy-pool/start", async (request) => ({ ok: true, ...await services.proxy.start(requestController(request).signal) }));
  app.post("/api/proxy-pool/stop", async () => ({ ok: true, ...services.proxy.stop() }));
  app.post("/api/proxy-pool/reclaim", async () => ({ ok: true, ...services.proxy.stop() }));
  app.post("/api/proxy-pool/rotate", async (request) => ({ ok: true, ...await services.proxy.rotate(requestController(request).signal) }));
  app.post("/api/proxy-pool/test", async (request) => services.proxy.test(requestController(request).signal));

  app.get("/api/usage", async () => services.usage.summary());
  app.delete("/api/usage", async () => ({ ok: true, deleted: services.usage.clear() }));
  app.post("/api/cleanup", async () => ({ ok: true, responses_deleted: services.responses.cleanup() }));
};

const accountAt = (config: ConfigStore, value: string) => {
  const account = config.snapshot().mimo_accounts[parseIndex(value)];
  if (!account) throw new ApiError(404, "account_not_found", "account not found");
  return account;
};

const parseIndex = (value: string): number => {
  const index = Number(value);
  if (!Number.isInteger(index) || index < 0) throw new ApiError(400, "invalid_account_index", "invalid account index");
  return index;
};

const parseCookie = (cookie: string) => {
  const values = Object.fromEntries(cookie.split(";").flatMap((part) => {
    const value = part.trim();
    const separator = value.indexOf("=");
    return separator > 0 ? [[value.slice(0, separator), value.slice(separator + 1)]] : [];
  }));
  const account = MimoAccountSchema.parse({
    service_token: String(values.serviceToken ?? "").replace(/^"|"$/g, ""),
    user_id: values.userId ?? "",
    xiaomichatbot_ph: String(values.xiaomichatbot_ph ?? "").replace(/^"|"$/g, ""),
  });
  if (!account.service_token || !account.user_id || !account.xiaomichatbot_ph) {
    throw new ApiError(400, "invalid_cookie", "cookie requires serviceToken, userId and xiaomichatbot_ph");
  }
  return account;
};

const requestController = (request: FastifyRequest) => {
  const controller = new AbortController();
  request.raw.once("aborted", () => controller.abort(new DOMException("Client disconnected", "AbortError")));
  return controller;
};

const preserveMaskedSecrets = (current: AppConfig, patch: Partial<AppConfig>): Partial<AppConfig> => {
  const copy = structuredClone(patch);
  if (copy.temp_mail?.admin_password?.includes("***")) copy.temp_mail.admin_password = current.temp_mail.admin_password;
  if (copy.temp_mail?.site_password?.includes("***")) copy.temp_mail.site_password = current.temp_mail.site_password;
  if (copy.proxy_pool?.sub_url?.includes("***")) copy.proxy_pool.sub_url = current.proxy_pool.sub_url;
  return copy;
};
