import { randomUUID } from "node:crypto";
import { lookup as mimeLookup } from "mime-types";
import { fetch } from "undici";
import { ApiError } from "../core/errors.js";
import type { MimoClient, MimoMedia } from "./client.js";

export interface MediaSource {
  kind: "image" | "file";
  data?: string;
  url?: string;
  filename?: string;
  mimeType?: string;
}

const maxUploadBytes = Number(process.env.MIMO2API_MAX_UPLOAD_BYTES ?? 25 * 1024 * 1024);

export async function uploadSources(
  client: MimoClient,
  sources: MediaSource[],
  model: string,
  signal: AbortSignal,
): Promise<MimoMedia[]> {
  const results: MimoMedia[] = [];
  for (const source of deduplicate(sources)) {
    const loaded = await loadSource(source, signal);
    results.push(await uploadResource(client, source.kind, loaded, model, signal));
  }
  return results;
}

const deduplicate = (sources: MediaSource[]): MediaSource[] => {
  const seen = new Set<string>();
  return sources.filter((source) => {
    const key = source.data ?? source.url ?? "";
    if (!key || seen.has(key)) return false;
    seen.add(key);
    return true;
  });
};

async function loadSource(source: MediaSource, signal: AbortSignal): Promise<{
  bytes: Buffer;
  filename: string;
  mimeType: string;
}> {
  if (source.data) {
    const match = /^data:([^;,]+)?(?:;base64)?,(.*)$/s.exec(source.data);
    const encoded = match?.[2] ?? source.data;
    const bytes = Buffer.from(encoded, "base64");
    enforceSize(bytes.length);
    const mimeType = source.mimeType ?? match?.[1] ?? String(mimeLookup(source.filename ?? "") || "application/octet-stream");
    return { bytes, filename: source.filename ?? generatedName(mimeType), mimeType };
  }
  if (!source.url) throw new ApiError(400, "invalid_media", "media source requires data or url");
  const response = await fetch(source.url, { signal, redirect: "follow" });
  if (!response.ok) throw new ApiError(400, "media_download_failed", `failed to download media: HTTP ${response.status}`);
  const length = Number(response.headers.get("content-length") ?? 0);
  if (length) enforceSize(length);
  const bytes = Buffer.from(await response.arrayBuffer());
  enforceSize(bytes.length);
  const mimeType = source.mimeType ?? response.headers.get("content-type")?.split(";")[0] ?? String(mimeLookup(source.url) || "application/octet-stream");
  const filename = source.filename ?? decodeURIComponent(new URL(source.url).pathname.split("/").pop() || generatedName(mimeType));
  return { bytes, filename, mimeType };
}

async function uploadResource(
  client: MimoClient,
  kind: "image" | "file",
  source: { bytes: Buffer; filename: string; mimeType: string },
  model: string,
  signal: AbortSignal,
): Promise<MimoMedia> {
  const ph = client.account.xiaomichatbot_ph;
  const infoUrl = new URL("https://aistudio.xiaomimimo.com/open-apis/resource/genUploadInfo");
  infoUrl.searchParams.set("xiaomichatbot_ph", ph);
  const infoResponse = await fetch(infoUrl, {
    method: "POST",
    headers: client.headers(),
    body: JSON.stringify({
      fileName: source.filename,
    }),
    signal,
  });
  const info = await jsonObject(infoResponse, "genUploadInfo");
  const data = info.data as Record<string, unknown> | undefined;
  if (info.code !== 0 || !data?.uploadUrl || !data.resourceUrl || !data.objectName) {
    throw new ApiError(502, "media_upload_init_failed", "MiMo did not return upload information", undefined, info);
  }

  const uploadResponse = await fetch(String(data.uploadUrl), {
    method: "PUT",
    headers: { "Content-Type": "application/octet-stream" },
    body: source.bytes,
    signal,
  });
  if (!uploadResponse.ok) throw new ApiError(502, "media_upload_failed", `media upload returned HTTP ${uploadResponse.status}`);

  const parsed = await parseResource(client, {
    fileUrl: String(data.resourceUrl),
    objectName: String(data.objectName),
    model,
    xiaomichatbot_ph: ph,
  }, signal);
  return {
    mediaType: kind,
    fileUrl: String(data.resourceUrl),
    compressedVideoUrl: "",
    audioTrackUrl: "",
    name: source.filename,
    size: source.bytes.length,
    status: "completed",
    objectName: String(data.objectName),
    tokenUsage: Number(parsed.tokenUsage ?? 0),
    url: String(parsed.id),
  };
}

async function parseResource(
  client: MimoClient,
  params: Record<string, string>,
  signal: AbortSignal,
): Promise<Record<string, unknown>> {
  const url = new URL("https://aistudio.xiaomimimo.com/open-apis/resource/parse");
  for (const [key, value] of Object.entries(params)) url.searchParams.set(key, value);
  let last: Record<string, any> = {};
  for (let attempt = 0; attempt < 5; attempt += 1) {
    const response = await fetch(url, {
      method: "POST",
      headers: client.headers(),
      body: "{}",
      signal,
    });
    last = await jsonObject(response, "resource/parse");
    const data = last.data as Record<string, unknown> | undefined;
    if (last.code === 0 && data?.id) return data;
    await abortableDelay(2_000, signal);
  }
  throw new ApiError(502, "media_parse_failed", "MiMo could not parse uploaded media", undefined, last);
}

async function jsonObject(
  response: Awaited<ReturnType<typeof fetch>>,
  operation: string,
): Promise<Record<string, any>> {
  const text = await response.text();
  if (!response.ok) throw new ApiError(502, "mimo_upload_error", `${operation} returned HTTP ${response.status}: ${text.slice(0, 500)}`);
  try {
    return JSON.parse(text) as Record<string, any>;
  } catch {
    throw new ApiError(502, "mimo_upload_error", `${operation} returned invalid JSON`);
  }
}

const generatedName = (mimeType: string): string => {
  const extension = mimeType.split("/")[1]?.replace("jpeg", "jpg") || "bin";
  return `${randomUUID().replaceAll("-", "")}.${extension}`;
};

const enforceSize = (size: number): void => {
  if (size <= 0 || size > maxUploadBytes) {
    throw new ApiError(413, "media_too_large", `media must be between 1 and ${maxUploadBytes} bytes`);
  }
};

const abortableDelay = (ms: number, signal: AbortSignal): Promise<void> => new Promise((resolve, reject) => {
  const onAbort = () => {
    clearTimeout(timer);
    reject(signal.reason ?? new DOMException("Aborted", "AbortError"));
  };
  const timer = setTimeout(() => {
    signal.removeEventListener("abort", onAbort);
    resolve();
  }, ms);
  signal.addEventListener("abort", onAbort, { once: true });
});
