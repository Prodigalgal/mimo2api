import { z } from "zod";

const booleanish = z.union([z.boolean(), z.string()]).transform((value) => {
  if (typeof value === "boolean") return value;
  return !["0", "false", "no", "off"].includes(value.trim().toLowerCase());
});

export const MimoAccountSchema = z.object({
  service_token: z.string().default(""),
  user_id: z.string().default(""),
  xiaomichatbot_ph: z.string().default(""),
  login_time: z.string().default(""),
  last_test: z.string().default(""),
  is_valid: z.boolean().default(false),
  email: z.string().default(""),
  password: z.string().default(""),
  pass_token: z.string().default(""),
  c_user_id: z.string().default(""),
  device_id: z.string().default(""),
  auto_renew: booleanish.default(true),
  last_renew: z.string().default(""),
  renew_error: z.string().default(""),
  mail_jwt: z.string().default(""),
  region: z.string().default(""),
}).passthrough();

export const TempMailSchema = z.object({
  api_base: z.string().default(""),
  admin_password: z.string().default(""),
  domain: z.string().default(""),
  site_password: z.string().default(""),
  register_region: z.string().default("RANDOM"),
  batch_count: z.coerce.number().int().min(1).max(200).default(5),
  success_target: z.coerce.number().int().min(0).max(200).default(3),
  concurrent: z.coerce.number().int().min(1).max(20).default(2),
  concurrent_interval: z.coerce.number().min(0).max(300).default(3),
  captcha_retries: z.coerce.number().int().min(1).max(30).default(10),
  otp_timeout: z.coerce.number().int().min(30).max(600).default(120),
  auto_captcha: booleanish.default(true),
}).passthrough();

export const ProxyPoolSchema = z.object({
  enabled: booleanish.default(false),
  sub_url: z.string().default(""),
  listen_port: z.coerce.number().int().min(1024).max(65535).default(17890),
  singbox_path: z.string().default(""),
  rotate_every: z.coerce.number().int().min(1).max(100).default(1),
  refresh_interval: z.coerce.number().int().min(0).max(604800).default(3600),
  connect_retries: z.coerce.number().int().min(1).max(20).default(5),
  fetch_sub_each_time: booleanish.default(true),
}).passthrough();

export const CaptchaAiSchema = z.object({
  enabled: booleanish.default(false),
  api_base: z.string().default(""),
  api_key: z.string().default(""),
  model: z.string().default(""),
  timeout: z.coerce.number().int().min(15).max(180).default(60),
}).passthrough();

export const AppConfigSchema = z.object({
  api_keys: z.string().default("sk-mimo"),
  admin_password: z.string().default("admin"),
  models: z.array(z.string()).default([]),
  tools_passthrough: z.boolean().default(false),
  mimo_accounts: z.array(MimoAccountSchema).default([]),
  temp_mail: TempMailSchema.prefault({}),
  proxy_pool: ProxyPoolSchema.prefault({}),
  captcha_ai: CaptchaAiSchema.prefault({}),
}).passthrough();

export type MimoAccount = z.infer<typeof MimoAccountSchema>;
export type TempMailConfig = z.infer<typeof TempMailSchema>;
export type ProxyPoolConfig = z.infer<typeof ProxyPoolSchema>;
export type CaptchaAiConfig = z.infer<typeof CaptchaAiSchema>;
export type AppConfig = z.infer<typeof AppConfigSchema>;
