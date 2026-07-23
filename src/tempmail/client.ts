import { fetch } from "undici";
import type { TempMailConfig } from "../config/types.js";
import { ApiError } from "../core/errors.js";

export class TempMailClient {
  constructor(private readonly config: TempMailConfig) {}

  async settings(signal: AbortSignal): Promise<Record<string, any>> {
    const base = this.base();
    const response = await fetch(`${base}/open_api/settings`, {
      headers: this.headers(),
      signal,
    });
    return readJson(response, "temp-mail settings");
  }

  async createAddress(signal: AbortSignal): Promise<Record<string, any>> {
    const settings = await this.settings(signal);
    const domains = settings.domains ?? settings.defaultDomains ?? [];
    const domain = this.config.domain && domains.includes(this.config.domain)
      ? this.config.domain
      : domains[Math.floor(Math.random() * Math.max(1, domains.length))];
    if (!domain) throw new ApiError(502, "temp_mail_no_domain", "temp-mail service returned no domains");
    const name = `mimo${Math.random().toString(36).slice(2, 12)}`;
    const response = await fetch(`${this.base()}/admin/new_address`, {
      method: "POST",
      headers: this.headers(true),
      body: JSON.stringify({ name, domain }),
      signal,
    });
    return readJson(response, "temp-mail create address");
  }

  async test(signal: AbortSignal): Promise<object> {
    const settings = await this.settings(signal);
    const result: Record<string, any> = {
      ok: true,
      version: settings.version,
      domains: settings.domains ?? settings.defaultDomains ?? [],
      need_auth: settings.needAuth,
    };
    if (this.config.admin_password) {
      const address = await this.createAddress(signal);
      result.test_address = address.address;
      result.test_jwt_ok = Boolean(address.jwt);
    }
    return result;
  }

  private base(): string {
    const value = this.config.api_base.trim().replace(/\/$/, "");
    if (!value) throw new ApiError(400, "temp_mail_not_configured", "temp-mail API base is not configured");
    return value;
  }

  private headers(admin = false): Record<string, string> {
    const headers: Record<string, string> = { Accept: "application/json", "Content-Type": "application/json" };
    if (this.config.site_password) headers["x-custom-auth"] = this.config.site_password;
    if (admin && this.config.admin_password) headers["x-admin-auth"] = this.config.admin_password;
    return headers;
  }
}

const readJson = async (
  response: Awaited<ReturnType<typeof fetch>>,
  operation: string,
): Promise<Record<string, any>> => {
  const text = await response.text();
  if (!response.ok) throw new ApiError(502, "temp_mail_error", `${operation} returned HTTP ${response.status}: ${text.slice(0, 300)}`);
  try { return JSON.parse(text); }
  catch { throw new ApiError(502, "temp_mail_error", `${operation} returned invalid JSON`); }
};
