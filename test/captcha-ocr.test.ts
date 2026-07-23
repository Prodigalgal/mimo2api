import { describe, expect, it } from "vitest";
import { captchaCandidates } from "../src/registration/captcha-ocr.js";

describe("captcha OCR candidates", () => {
  it("cleans and deduplicates local OCR candidates with case variants", () => {
    expect(captchaCandidates(["`aB12`\nignored", "ab12", "x"])).toEqual([
      "aB12",
      "ab12",
      "AB12",
    ]);
  });
});
