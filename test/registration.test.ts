import { describe, expect, it } from "vitest";
import { regionOf, encryptCredentials, RegistrationService } from "../src/registration/service.js";
import { extractVerificationCode } from "../src/tempmail/client.js";

describe("registration helpers", () => {
  it("rejects China and resolves random registration regions", () => {
    expect(() => regionOf("CN")).toThrow("cannot be China");
    expect(regionOf("RANDOM")).toMatch(/^[A-Z]{2}$/);
  });

  it("creates Xiaomi-compatible encrypted field and EUI shapes", () => {
    const value = encryptCredentials("person@example.test", "Aa1!register");
    expect(value.encrypted.email).toMatch(/^[A-Za-z0-9+/]+={0,2}$/);
    expect(value.encrypted.password).toMatch(/^[A-Za-z0-9+/]+={0,2}$/);
    expect(value.eui.split(".")).toHaveLength(2);
  });

  it("extracts contextual and fallback verification codes", () => {
    expect(extractVerificationCode({ subject: "Verification code: 123456" })).toBe("123456");
    expect(extractVerificationCode({ text: "Your number is 8342." })).toBe("8342");
  });

  it("reports stopping immediately and settles an aborted inter-attempt delay as cancelled", async () => {
    const config = {
      snapshot: () => ({
        captcha_ai: { enabled: true, api_base: "https://vision.test", api_key: "key", model: "grok" },
        proxy_pool: { enabled: false },
        temp_mail: {
          register_region: "US",
          domain: "",
          batch_count: 2,
          success_target: 0,
          concurrent: 1,
          concurrent_interval: 30,
          captcha_retries: 10,
          local_captcha_retries: 3,
          otp_timeout: 120,
        },
      }),
    };
    const service = new RegistrationService(config as never, {} as never);
    (service as any).autoAttempt = async () => ({
      registered: false,
      saved: false,
      email: "",
      error: "expected test failure",
    });

    const started = await service.startBatch({ batch_count: 2, success_target: 0, concurrent_interval: 30 }) as any;
    await waitFor(() => (service.job(started.job_id) as any).failed === 1);
    expect((service.stopJob(started.job_id) as any).status).toBe("stopping");
    await waitFor(() => (service.job(started.job_id) as any).status === "cancelled");
    expect((service.job(started.job_id) as any).message).toContain("任务已停止");
  });
});

const waitFor = async (predicate: () => boolean): Promise<void> => {
  const deadline = Date.now() + 2_000;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error("condition was not reached");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
};
