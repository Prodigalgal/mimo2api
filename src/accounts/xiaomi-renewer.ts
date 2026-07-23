import { createHash, randomUUID } from "node:crypto";
import { fetch, type Headers } from "undici";
import type { MimoAccount } from "../config/types.js";
import type { TempMailConfig } from "../config/types.js";
import { ApiError } from "../core/errors.js";
import { TempMailClient } from "../tempmail/client.js";

const accountBase = "https://account.xiaomi.com";
const studioBase = "https://aistudio.xiaomimimo.com";
const sid = "xiaomichatbot";

export class XiaomiTokenRenewer {
  async renew(account: MimoAccount, signal: AbortSignal, tempMail?: TempMailConfig): Promise<MimoAccount> {
    try {
      return await this.#renewWithPassToken(account, signal);
    } catch (passTokenError) {
      if (!canUseTempMailFallback(account, tempMail)) throw passTokenError;
      try {
        return await this.#renewWithPasswordOtp(account, tempMail!, signal);
      } catch (fallbackError) {
        throw new ApiError(
          502,
          "renewal_all_methods_failed",
          `passToken renewal failed; password and temp-mail OTP fallback also failed: ${errorMessage(fallbackError)}`,
          undefined,
          { pass_token_error: errorMessage(passTokenError), fallback_error: errorMessage(fallbackError) },
        );
      }
    }
  }

  async #renewWithPassToken(account: MimoAccount, signal: AbortSignal): Promise<MimoAccount> {
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

  async #renewWithPasswordOtp(account: MimoAccount, tempMail: TempMailConfig, signal: AbortSignal): Promise<MimoAccount> {
    const deviceId = account.device_id || newDeviceId();
    const cookies = new Map<string, string>([
      ["sdkVersion", "accountsdk-18.8.15"],
      ["deviceId", deviceId],
    ]);
    const login = await fetchJson(`${accountBase}/pass/serviceLogin?sid=${sid}&_json=true`, cookies, {
      headers: requestHeaders(cookies, accountBase),
      signal,
    });
    const passwordHash = createHash("md5").update(account.password).digest("hex").toUpperCase();
    const auth = await fetchJson(`${accountBase}/pass/serviceLoginAuth2`, cookies, {
      method: "POST",
      headers: {
        ...requestHeaders(cookies, `${accountBase}/fe/service/login/password`),
        "Content-Type": "application/x-www-form-urlencoded; charset=UTF-8",
        Origin: accountBase,
        "X-Requested-With": "XMLHttpRequest",
      },
      body: new URLSearchParams({
        bizDeviceType: "",
        needTheme: "false",
        theme: "",
        showActiveX: "false",
        serviceParam: String(login.serviceParam ?? ""),
        callback: String(login.callback ?? `${studioBase}/sts`),
        qs: String(login.qs ?? "%3Fsid%3Dxiaomichatbot%26_json%3Dtrue"),
        sid,
        _sign: String(login._sign ?? ""),
        user: account.email,
        cc: "+86",
        hash: passwordHash,
        _json: "true",
        policyName: "miaccount",
        captCode: "",
      }).toString(),
      signal,
    });

    let passToken = String(auth.passToken ?? "");
    let userId = String(auth.userId ?? account.user_id);
    let cUserId = String(auth.cUserId ?? account.c_user_id);
    if (passToken) cookies.set("passToken", passToken);
    if (userId) cookies.set("userId", userId);
    if (cUserId) cookies.set("cUserId", cUserId);
    const securityStatus = Number(auth.securityStatus ?? 0);
    if (auth.location && securityStatus === 0) {
      try {
        const followed = await followForPassToken(String(auth.location), cookies, signal);
        passToken ||= followed.passToken;
        userId = followed.userId || userId;
        cUserId = followed.cUserId || cUserId;
      } catch (error) {
        if (!passToken) throw error;
      }
    } else {
      const notificationUrl = String(auth.notificationUrl ?? "");
      if (!notificationUrl || securityStatus !== 16) {
        throw new ApiError(502, "renewal_password_login_failed", `Xiaomi password login failed: ${loginDescription(auth)}`);
      }
      const context = new URL(notificationUrl).searchParams.get("context") ?? "";
      if (!context) throw new ApiError(502, "renewal_identity_context_missing", "Xiaomi identity verification did not return context");
      const ref = `${accountBase}/fe/service/identity/verifyEmail?sid=${sid}&context=${encodeURIComponent(context)}&_locale=zh_CN`;
      const identity = await fetchJson(`${accountBase}/identity/list?${new URLSearchParams({
        sid,
        supportedMask: "0",
        _locale: "zh_CN",
        context,
      })}`, cookies, {
        headers: { ...requestHeaders(cookies, notificationUrl), "X-Requested-With": "XMLHttpRequest" },
        signal,
      });
      const flag = String(identity.flag ?? 8);
      await fetchJson(`${accountBase}/identity/auth/verifyEmail?${new URLSearchParams({ _flag: flag, _json: "true" })}`, cookies, {
        headers: { ...requestHeaders(cookies, ref), "X-Requested-With": "XMLHttpRequest" },
        signal,
      });

      const mail = new TempMailClient(tempMail);
      const seenIds = new Set<string>();
      try {
        for (const item of await mail.listMails(account.mail_jwt, signal)) {
          const id = String(item.id ?? item.message_id ?? "");
          if (id) seenIds.add(id);
        }
      } catch { /* only newly received mail is preferred when listing succeeds */ }
      const sent = await fetchJson(`${accountBase}/identity/auth/sendEmailTicket`, cookies, {
        method: "POST",
        headers: {
          ...requestHeaders(cookies, ref),
          "Content-Type": "application/x-www-form-urlencoded; charset=UTF-8",
          Origin: accountBase,
          "X-Requested-With": "XMLHttpRequest",
        },
        body: new URLSearchParams({ _flag: flag, _json: "true" }).toString(),
        signal,
      });
      if (![undefined, null, 0, "0"].includes(sent.code)) {
        throw new ApiError(502, "renewal_otp_send_failed", `sending Xiaomi renewal OTP failed: ${loginDescription(sent)}`);
      }
      const code = await mail.waitForCode(account.mail_jwt, {
        signal,
        timeoutMs: Math.max(30, tempMail.otp_timeout) * 1_000,
        seenIds,
      });
      const verified = await fetchJson(`${accountBase}/identity/auth/verifyEmail`, cookies, {
        method: "POST",
        headers: {
          ...requestHeaders(cookies, ref),
          "Content-Type": "application/x-www-form-urlencoded; charset=UTF-8",
          Origin: accountBase,
          "X-Requested-With": "XMLHttpRequest",
        },
        body: new URLSearchParams({ ticket: code, _json: "true" }).toString(),
        signal,
      });
      if (Number(verified.code ?? -1) !== 0 || !verified.location) {
        throw new ApiError(502, "renewal_otp_verify_failed", `Xiaomi renewal OTP verification failed: ${loginDescription(verified)}`);
      }
      const followed = await followForPassToken(String(verified.location), cookies, signal);
      passToken = followed.passToken;
      userId = followed.userId || userId;
      cUserId = followed.cUserId || cUserId;
    }
    if (!passToken) throw new ApiError(502, "renewal_pass_token_missing", "Xiaomi password login did not return passToken");
    return this.#renewWithPassToken({
      ...account,
      pass_token: passToken,
      user_id: userId,
      c_user_id: cUserId,
      device_id: deviceId,
    }, signal);
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

const fetchJson = async (
  url: string,
  cookies: Map<string, string>,
  init: Parameters<typeof fetch>[1],
): Promise<Record<string, any>> => {
  const response = await fetch(url, { ...init, redirect: "manual" });
  collectCookies(response.headers, cookies);
  const text = await response.text();
  const payload = stripJson(text);
  if (response.status >= 500) {
    throw new ApiError(502, "xiaomi_login_failed", `Xiaomi login returned HTTP ${response.status}: ${loginDescription(payload)}`);
  }
  return payload;
};

const followForPassToken = async (
  start: string,
  cookies: Map<string, string>,
  signal: AbortSignal,
): Promise<{ passToken: string; userId: string; cUserId: string }> => {
  let url = normalizeLocation(start, accountBase);
  for (let redirects = 0; redirects < 20 && url; redirects += 1) {
    const response = await fetch(url, {
      headers: {
        ...requestHeaders(cookies, accountBase),
        Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
      },
      redirect: "manual",
      signal,
    });
    collectCookies(response.headers, cookies);
    const location = response.headers.get("location");
    if (location && isRedirect(response.status)) {
      const next = normalizeLocation(location, url);
      if (next.includes("aistudio.xiaomimimo.com/sts") && cookies.get("passToken")) break;
      url = next;
      continue;
    }
    const payload = stripJson(await response.text());
    url = typeof payload.location === "string" ? normalizeLocation(payload.location, url) : "";
  }
  const passToken = cookies.get("passToken") ?? "";
  if (!passToken) throw new ApiError(502, "renewal_pass_token_missing", "Xiaomi login succeeded without returning passToken");
  return {
    passToken,
    userId: cookies.get("userId") ?? "",
    cUserId: cookies.get("cUserId") ?? "",
  };
};

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

const loginDescription = (value: Record<string, any>): string => String(
  value.desc ?? value.description ?? value.tips ?? value.code ?? "unknown response",
).slice(0, 200);

const canUseTempMailFallback = (account: MimoAccount, config: TempMailConfig | undefined): boolean => Boolean(
  config?.api_base && account.email && account.password && account.mail_jwt,
);

const errorMessage = (error: unknown): string => error instanceof Error ? error.message : String(error);

const normalizeLocation = (location: string, base: string): string => {
  const normalized = location.replace(/^http:\/\/aistudio\.xiaomimimo\.com/, studioBase);
  return new URL(normalized, base).toString();
};

const isRedirect = (status: number): boolean => [301, 302, 303, 307, 308].includes(status);
const newDeviceId = (): string => `wb${createHash("md5").update(`${Date.now()}-${randomUUID()}`).digest("hex").slice(0, 12)}`;
