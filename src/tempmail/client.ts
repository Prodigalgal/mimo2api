import { fetch } from "undici";
import type { TempMailConfig } from "../config/types.js";
import { ApiError } from "../core/errors.js";

export interface TempMailAddress {
  address: string;
  jwt: string;
  addressId?: string | number;
}

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

  async createAddress(signal: AbortSignal): Promise<TempMailAddress> {
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
    const result = await readJson(response, "temp-mail create address");
    const address = String(result.address ?? `${name}@${domain}`);
    const jwt = String(result.jwt ?? "");
    if (!jwt) throw new ApiError(502, "temp_mail_missing_jwt", "temp-mail create address did not return a JWT");
    return { address, jwt, addressId: result.address_id as string | number | undefined };
  }

  async listDomains(signal: AbortSignal): Promise<string[]> {
    const settings = await this.settings(signal);
    const values = settings.domains ?? settings.defaultDomains ?? [];
    return Array.isArray(values) ? values.map(String).filter(Boolean) : [];
  }

  async listMails(jwt: string, signal: AbortSignal): Promise<Array<Record<string, any>>> {
    const base = this.base();
    const headers = { ...this.headers(), Authorization: `Bearer ${jwt}` };
    let response = await fetch(`${base}/api/parsed_mails?limit=30&offset=0`, { headers, signal });
    if (response.status === 404) response = await fetch(`${base}/api/mails?limit=30&offset=0`, { headers, signal });
    const result = await readJson(response, "temp-mail list mails");
    const values = result.results ?? result.mails ?? [];
    return Array.isArray(values) ? values.filter((item): item is Record<string, any> => Boolean(item && typeof item === "object")) : [];
  }

  async waitForCode(jwt: string, options: {
    signal: AbortSignal;
    timeoutMs: number;
    seenIds?: Set<string>;
    onPoll?: () => void;
  }): Promise<string> {
    const deadline = Date.now() + options.timeoutMs;
    const seen = options.seenIds ?? new Set<string>();
    let waitMs = 2_000;
    let lastError = "";
    while (Date.now() < deadline) {
      if (options.signal.aborted) throw options.signal.reason;
      try {
        for (const mail of await this.listMails(jwt, options.signal)) {
          const id = String(mail.id ?? mail.message_id ?? "");
          if (id && seen.has(id)) continue;
          if (id) seen.add(id);
          const code = extractVerificationCode(mail);
          if (code) return code;
        }
      } catch (error) {
        if (options.signal.aborted) throw error;
        lastError = error instanceof Error ? error.message : String(error);
      }
      options.onPoll?.();
      await delay(Math.min(waitMs, Math.max(1, deadline - Date.now())), options.signal);
      waitMs = Math.min(10_000, Math.round(waitMs * 1.35));
    }
    throw new ApiError(504, "temp_mail_code_timeout", `waiting for email verification code timed out${lastError ? `: ${lastError}` : ""}`);
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

export const extractVerificationCode = (mail: Record<string, any>): string | undefined => {
  const text = [mail.subject, mail.text, mail.html, mail.raw, mail.source].map((value) => String(value ?? "")).join("\n");
  const contextual = /(?:verification code|code is|code:|验证码|码为|码是)[^\d]{0,24}(\d{4,8})/i.exec(text);
  if (contextual?.[1]) return contextual[1];
  return /(?<![A-Za-z0-9])(\d{6})(?![A-Za-z0-9])/.exec(text)?.[1]
    ?? /(?<![A-Za-z0-9])(\d{4,8})(?![A-Za-z0-9])/.exec(text)?.[1];
};

const delay = (ms: number, signal: AbortSignal): Promise<void> => new Promise((resolve, reject) => {
  const timer = setTimeout(() => {
    signal.removeEventListener("abort", abort);
    resolve();
  }, ms);
  const abort = () => {
    clearTimeout(timer);
    reject(signal.reason ?? new DOMException("Aborted", "AbortError"));
  };
  signal.addEventListener("abort", abort, { once: true });
});
