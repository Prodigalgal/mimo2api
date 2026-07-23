import { describe, expect, it } from "vitest";
import { regionOf, encryptCredentials } from "../src/registration/service.js";
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
});
