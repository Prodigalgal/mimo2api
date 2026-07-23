import { createHash, randomUUID } from "node:crypto";
import { fetch, type Headers } from "undici";
import type { MimoAccount } from "../config/types.js";
import { ApiError } from "../core/errors.js";

const accountBase = "https://account.xiaomi.com";
const studioBase = "https://aistudio.xiaomimimo.com";
const sid = "xiaomichatbot";

export class XiaomiTokenRenewer {
  async renew(account: MimoAccount, signal: AbortSignal): Promise<MimoAccount> {
    if (!account.pass_token) throw new ApiError(400, "missing_pass_token", "account has no passToken");
    const deviceId = account.device_id || newDeviceId();
    const cookies = new Map<string, string>([
      ["sdkVersion", "accountsdk-18.8.15"],
      ["deviceId", deviceId],
      ["passToken", account.pass_token],
      ["userId", account.user_id],
      ["cUserId", account.c_user_id],
    ].filter((entry) => entry[1]) as Array<[string, string]>);

    let start = await this.#loginUrl(cookies, signal);
    let serviceToken = "";
    let ph = "";
    let userId = account.user_id;
    let passToken = account.pass_token;
    let cUserId = account.c_user_id;

    for (let redirects = 0; redirects < 15 && start; redirects += 1) {
      const response = await fetch(start, {
        headers: requestHeaders(cookies, studioBase),
        redirect: "manual",
        signal,
      });
      collectCookies(response.headers, cookies);
      serviceToken = cookies.get("serviceToken") ?? serviceToken;
      ph = cookies.get("xiaomichatbot_ph") ?? ph;
      userId = cookies.get("userId") ?? userId;
      passToken = cookies.get("passToken") ?? passToken;
      cUserId = cookies.get("cUserId") ?? cUserId;

      const location = response.headers.get("location");
      if (location && isRedirect(response.status)) {
        start = normalizeLocation(location, start);
        if (serviceToken && ph && start.includes("open-apis")) break;
        continue;
      }
      const payload = stripJson(await response.text());
      start = typeof payload.location === "string" ? normalizeLocation(payload.location, start) : "";
    }

    if (!serviceToken || !ph) {
      throw new ApiError(502, "renewal_exchange_failed", "passToken exchange did not return MiMo service cookies");
    }
    return {
      ...account,
      service_token: serviceToken,
      user_id: userId,
      xiaomichatbot_ph: ph,
      pass_token: passToken,
      c_user_id: cUserId,
      device_id: deviceId,
      last_renew: new Date().toISOString(),
      renew_error: "",
      is_valid: true,
    };
  }

  async #loginUrl(cookies: Map<string, string>, signal: AbortSignal): Promise<string> {
    const info = await fetch(`${studioBase}/open-apis/user/info`, {
      headers: requestHeaders(cookies, studioBase),
      redirect: "manual",
      signal,
    });
    collectCookies(info.headers, cookies);
    try {
      const payload = await info.json() as { loginUrl?: string };
      if (payload.loginUrl) return payload.loginUrl;
    } catch { /* use serviceLogin fallback */ }

    const url = new URL(`${accountBase}/pass/serviceLogin`);
    url.searchParams.set("sid", sid);
    url.searchParams.set("_json", "true");
    const response = await fetch(url, {
      headers: requestHeaders(cookies, accountBase),
      redirect: "manual",
      signal,
    });
    collectCookies(response.headers, cookies);
    const payload = stripJson(await response.text());
    if (typeof payload.location !== "string") {
      throw new ApiError(502, "renewal_login_url_failed", "could not obtain Xiaomi login URL");
    }
    return payload.location;
  }
}

const requestHeaders = (cookies: Map<string, string>, referer: string): Record<string, string> => ({
  Accept: "application/json, text/plain, */*",
  "Accept-Language": "zh-CN,zh;q=0.9",
  "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/150 Safari/537.36",
  Referer: `${referer}/`,
  Cookie: [...cookies].map(([name, value]) => `${name}=${value}`).join("; "),
});

const collectCookies = (headers: Headers, jar: Map<string, string>): void => {
  const values = typeof headers.getSetCookie === "function"
    ? headers.getSetCookie()
    : [headers.get("set-cookie") ?? ""].filter(Boolean);
  for (const value of values) {
    const match = /^\s*([^=\s]+)=("(?:\\.|[^"\\])*"|[^;]*)/.exec(value);
    if (!match?.[1]) continue;
    const cookie = (match[2] ?? "").replace(/^"|"$/g, "");
    if (cookie && cookie !== "EXPIRED") jar.set(match[1], cookie);
  }
};

const stripJson = (text: string): Record<string, unknown> => {
  try { return JSON.parse(text.startsWith("&&&START&&&") ? text.slice(11) : text); }
  catch { return {}; }
};

const normalizeLocation = (location: string, base: string): string => {
  const normalized = location.replace(/^http:\/\/aistudio\.xiaomimimo\.com/, studioBase);
  return new URL(normalized, base).toString();
};

const isRedirect = (status: number): boolean => [301, 302, 303, 307, 308].includes(status);
const newDeviceId = (): string => `wb${createHash("md5").update(`${Date.now()}-${randomUUID()}`).digest("hex").slice(0, 12)}`;
