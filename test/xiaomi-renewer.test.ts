import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { getGlobalDispatcher, MockAgent, setGlobalDispatcher } from "undici";
import { XiaomiTokenRenewer } from "../src/accounts/xiaomi-renewer.js";
import type { MimoAccount, TempMailConfig } from "../src/config/types.js";

const originalDispatcher = getGlobalDispatcher();
let mock: MockAgent;

beforeEach(() => {
  mock = new MockAgent();
  mock.disableNetConnect();
  setGlobalDispatcher(mock);
});

afterEach(async () => {
  await mock.close();
  setGlobalDispatcher(originalDispatcher);
});

const account = (): MimoAccount => ({
  service_token: "old-service-token",
  user_id: "user-1",
  xiaomichatbot_ph: "old-ph",
  is_valid: true,
  login_time: "",
  last_test: "",
  email: "user@example.com",
  password: "password",
  pass_token: "old-pass-token",
  c_user_id: "c-user-1",
  device_id: "device-1",
  auto_renew: true,
  last_renew: "",
  renew_error: "",
  mail_jwt: "mail-jwt",
  region: "US",
});

const tempMail = (): TempMailConfig => ({
  api_base: "https://mail.example.com",
  admin_password: "",
  domain: "example.com",
  site_password: "",
  register_region: "US",
  batch_count: 1,
  success_target: 1,
  concurrent: 1,
  concurrent_interval: 3,
  captcha_retries: 10,
  local_captcha_retries: 3,
  otp_timeout: 120,
  auto_captcha: true,
});

const exchange = (serviceToken: string, ph: string): void => {
  mock.get("https://aistudio.xiaomimimo.com")
    .intercept({ path: "/open-apis/user/info", method: "GET" })
    .reply(200, { loginUrl: "https://account.xiaomi.com/exchange" });
  mock.get("https://account.xiaomi.com")
    .intercept({ path: "/exchange", method: "GET" })
    .reply(302, "", {
      headers: {
        location: "https://aistudio.xiaomimimo.com/open-apis/done",
        "set-cookie": [`xiaomichatbot_serviceToken=${serviceToken}; Path=/`, `xiaomichatbot_ph=${ph}; Path=/`],
      },
    });
};

describe("Xiaomi token renewer", () => {
  it("exchanges a passToken for fresh MiMo service cookies", async () => {
    exchange("fresh-service", "fresh-ph");
    const renewed = await new XiaomiTokenRenewer().renew(account(), AbortSignal.timeout(5_000));
    expect(renewed).toMatchObject({ service_token: "fresh-service", xiaomichatbot_ph: "fresh-ph", is_valid: true });
  });

  it("falls back to password login when the old passToken exchange returns no cookies", async () => {
    const studio = mock.get("https://aistudio.xiaomimimo.com");
    const xiaomi = mock.get("https://account.xiaomi.com");
    studio.intercept({ path: "/open-apis/user/info", method: "GET" }).reply(200, {});
    xiaomi.intercept({ path: "/pass/serviceLogin?sid=xiaomichatbot&_json=true", method: "GET" })
      .reply(200, { location: "https://account.xiaomi.com/stale" });
    xiaomi.intercept({ path: "/stale", method: "GET" }).reply(200, {});

    xiaomi.intercept({ path: "/pass/serviceLogin?sid=xiaomichatbot&_json=true", method: "GET" })
      .reply(200, { _sign: "sign", callback: "https://aistudio.xiaomimimo.com/sts" });
    xiaomi.intercept({ path: "/pass/serviceLoginAuth2", method: "POST" })
      .reply(200, {
        securityStatus: 0,
        location: "https://account.xiaomi.com/auth-end",
        passToken: "new-pass-token",
        userId: "user-1",
        cUserId: "c-user-1",
      });
    xiaomi.intercept({ path: "/auth-end", method: "GET" }).reply(302, "", {
      headers: { location: "https://aistudio.xiaomimimo.com/sts" },
    });
    exchange("fallback-service", "fallback-ph");

    const renewed = await new XiaomiTokenRenewer().renew(account(), AbortSignal.timeout(5_000), tempMail());
    expect(renewed).toMatchObject({
      service_token: "fallback-service",
      xiaomichatbot_ph: "fallback-ph",
      pass_token: "new-pass-token",
      is_valid: true,
    });
  });

  it("reads a newly sent identity OTP from temp mail during password fallback", async () => {
    const studio = mock.get("https://aistudio.xiaomimimo.com");
    const xiaomi = mock.get("https://account.xiaomi.com");
    const mail = mock.get("https://mail.example.com");
    studio.intercept({ path: "/open-apis/user/info", method: "GET" }).reply(200, {});
    xiaomi.intercept({ path: "/pass/serviceLogin?sid=xiaomichatbot&_json=true", method: "GET" })
      .reply(200, { location: "https://account.xiaomi.com/stale" });
    xiaomi.intercept({ path: "/stale", method: "GET" }).reply(200, {});

    xiaomi.intercept({ path: "/pass/serviceLogin?sid=xiaomichatbot&_json=true", method: "GET" })
      .reply(200, { _sign: "sign", callback: "https://aistudio.xiaomimimo.com/sts" });
    xiaomi.intercept({ path: "/pass/serviceLoginAuth2", method: "POST" })
      .reply(200, {
        securityStatus: 16,
        notificationUrl: "https://account.xiaomi.com/identity?context=identity-context",
      });
    xiaomi.intercept({
      path: "/identity/list?sid=xiaomichatbot&supportedMask=0&_locale=zh_CN&context=identity-context",
      method: "GET",
    }).reply(200, { flag: 8 });
    xiaomi.intercept({ path: "/identity/auth/verifyEmail?_flag=8&_json=true", method: "GET" }).reply(200, {});
    mail.intercept({ path: "/api/parsed_mails?limit=30&offset=0", method: "GET" }).reply(200, { results: [] });
    xiaomi.intercept({ path: "/identity/auth/sendEmailTicket", method: "POST" }).reply(200, { code: 0 });
    mail.intercept({ path: "/api/parsed_mails?limit=30&offset=0", method: "GET" }).reply(200, {
      results: [{ id: "new-mail", subject: "Verification code: 123456" }],
    });
    xiaomi.intercept({ path: "/identity/auth/verifyEmail", method: "POST" }).reply(200, {
      code: 0,
      location: "https://account.xiaomi.com/identity-result",
    });
    xiaomi.intercept({ path: "/identity-result", method: "GET" }).reply(302, "", {
      headers: {
        location: "https://aistudio.xiaomimimo.com/sts",
        "set-cookie": [
          "passToken=otp-pass-token; Path=/",
          "userId=user-1; Path=/",
          "cUserId=c-user-1; Path=/",
        ],
      },
    });
    exchange("otp-service", "otp-ph");

    const renewed = await new XiaomiTokenRenewer().renew(account(), AbortSignal.timeout(5_000), tempMail());
    expect(renewed).toMatchObject({
      service_token: "otp-service",
      xiaomichatbot_ph: "otp-ph",
      pass_token: "otp-pass-token",
      is_valid: true,
    });
  });
});
