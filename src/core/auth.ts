import { createHash, timingSafeEqual } from "node:crypto";
import type { FastifyRequest } from "fastify";
import type { ConfigStore } from "../config/store.js";
import { ApiError } from "./errors.js";

const equal = (left: string, right: string): boolean => {
  const a = Buffer.from(left);
  const b = Buffer.from(right);
  return a.length === b.length && timingSafeEqual(a, b);
};

export const requireApiKey = (config: ConfigStore) => async (request: FastifyRequest): Promise<void> => {
  const key = apiKeyFrom(request);
  if (!config.validateApiKey(key)) throw new ApiError(401, "invalid_api_key", "invalid api key");
};

export const apiKeyFingerprint = (request: FastifyRequest): string => createHash("sha256")
  .update(apiKeyFrom(request) ?? "")
  .digest("hex");

export const requireAdmin = (config: ConfigStore) => async (request: FastifyRequest): Promise<void> => {
  const authorization = request.headers.authorization ?? "";
  if (!authorization.startsWith("Basic ")) throw new ApiError(401, "invalid_admin_auth", "admin authentication required");
  let username = "";
  let password = "";
  try {
    const parts = Buffer.from(authorization.slice(6), "base64").toString("utf8").split(":", 2);
    username = parts[0] ?? "";
    password = parts[1] ?? "";
  } catch {
    throw new ApiError(401, "invalid_admin_auth", "invalid basic authentication");
  }
  if (!equal(username, "admin") || !equal(password, config.snapshot().admin_password)) {
    throw new ApiError(401, "invalid_admin_auth", "incorrect username or password");
  }
};

const apiKeyFrom = (request: FastifyRequest): string | undefined => {
  const authorization = request.headers.authorization;
  const xApiKey = request.headers["x-api-key"];
  return authorization?.replace(/^Bearer\s+/i, "") ?? (Array.isArray(xApiKey) ? xApiKey[0] : xApiKey);
};
