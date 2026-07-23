import { describe, expect, it } from "vitest";
import { captchaCandidates, shouldUseAiFallback } from "../src/registration/captcha-ocr.js";

describe("captcha OCR candidates", () => {
  it("cleans and deduplicates local OCR candidates with case variants", () => {
    expect(captchaCandidates(["`aB12`\nignored", "ab12", "x"])).toEqual([
      "aB12",
      "ab12",
      "AB12",
    ]);
  });

  it("keeps the first three rounds local before enabling AI fallback", () => {
    expect(shouldUseAiFallback(1, 3)).toBe(false);
    expect(shouldUseAiFallback(2, 3)).toBe(false);
    expect(shouldUseAiFallback(3, 3)).toBe(true);
  });
});
