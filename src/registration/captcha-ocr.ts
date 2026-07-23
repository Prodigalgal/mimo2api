import { fetch } from "undici";

const cleanCandidate = (value: unknown): string => String(value ?? "")
  .split(/\r?\n/, 1)[0]!
  .replace(/[^0-9A-Za-z\u4e00-\u9fff]/g, "")
  .slice(0, 12);

export const captchaCandidates = (values: unknown[]): string[] => {
  const candidates: string[] = [];
  for (const value of values) {
    const candidate = cleanCandidate(value);
    if (candidate.length < 3) continue;
    const variants = /^[0-9A-Za-z]+$/.test(candidate)
      ? [candidate, candidate.toLowerCase(), candidate.toUpperCase()]
      : [candidate];
    for (const variant of variants) if (!candidates.includes(variant)) candidates.push(variant);
  }
  return candidates;
};

export const shouldUseAiFallback = (attempt: number, localRetries: number): boolean => attempt >= localRetries;

export const solveCaptchaLocally = async (dataUrl: string, signal: AbortSignal): Promise<string[]> => {
  const base = String(process.env.MIMO2API_CAPTCHA_OCR_URL ?? "").trim().replace(/\/$/, "");
  if (!base || !dataUrl) return [];
  try {
    const response = await fetch(`${base}/classify`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ image: dataUrl }),
      signal: AbortSignal.any([signal, AbortSignal.timeout(30_000)]),
    });
    if (!response.ok) return [];
    const payload = await response.json() as { candidates?: unknown[]; text?: unknown };
    return captchaCandidates(payload.candidates ?? [payload.text]);
  } catch {
    return [];
  }
};
