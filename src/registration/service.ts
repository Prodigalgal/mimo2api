import { constants, createCipheriv, createHash, createPublicKey, publicEncrypt, randomUUID } from "node:crypto";
import { fetch, ProxyAgent, type Headers, type RequestInit } from "undici";
import { XiaomiTokenRenewer } from "../accounts/xiaomi-renewer.js";
import { AccountValidator } from "../accounts/account-validator.js";
import type { ConfigStore } from "../config/store.js";
import { MimoAccountSchema, type CaptchaAiConfig, type MimoAccount } from "../config/types.js";
import { ApiError } from "../core/errors.js";
import type { ProxyPool } from "../proxy/pool.js";
import { TempMailClient } from "../tempmail/client.js";
import { captchaCandidates, shouldUseAiFallback, solveCaptchaLocally } from "./captcha-ocr.js";

const ACCOUNT = "https://account.xiaomi.com";
const AISTUDIO = "https://aistudio.xiaomimimo.com";
const SID = "xiaomichatbot";
const CAPTCHA_ERRORS = new Set([87001, 70014, 1200212]);
const REGIONS = ["US", "SG", "JP", "HK", "TW", "GB", "DE", "FR", "IT", "ES", "NL", "AU", "CA", "KR", "IN", "ID", "TH", "MY", "PH", "VN", "BR", "MX"];
const RSA_PUBLIC_KEY_DER = "MIGfMA0GCSqGSIb3DQEBAQUAA4GNADCBiQKBgQCYEVrK/4Mahiv0pUJgTybx4J9P5dUT/Y0PuwMbk+gMU+jrZnBiXGv6/hCH1avIhoBcE535F8nJQQN3UavZdFkYidsoXuEnat3+eVTp3FslyhRwIBDF09v4vDhRtxFOT+R7uH7h/mzmyA2/+lfIMWGIrffXprYizbV76+YQKhoqFQIDAQAB";
const AES_IV = Buffer.from("0102030405060708");
const AES_CHARS = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789!@#$%^&*";
const USER_AGENT = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/150 Safari/537.36";

interface Session {
  id: string;
  email: string;
  password: string;
  region: string;
  deviceId: string;
  encryptedEmail: string;
  encryptedPassword: string;
  eui: string;
  mailJwt: string;
  cookies: Map<string, string>;
  createdAt: number;
  captchaImage: string;
  captchaContentType: string;
  proxyUrl?: string;
  ticketSent: boolean;
}

interface JobLog {
  at: number;
  attempt: number;
  stage: string;
  message: string;
  email: string;
}

interface JobResult {
  attempt: number;
  ok: boolean;
  registered: boolean;
  saved: boolean;
  email: string;
  user_id?: string;
  error?: string;
}

interface RegistrationJob {
  id: string;
  status: "running" | "stopping" | "done" | "cancelled" | "error";
  controller: AbortController;
  startedAt: number;
  finishedAt?: number;
  requested: number;
  target: number;
  concurrency: number;
  intervalSeconds: number;
  region: string;
  success: number;
  failed: number;
  stoppedEarly: boolean;
  message: string;
  logs: JobLog[];
  results: JobResult[];
}

export interface RegistrationRequest {
  region?: string;
  domain?: string;
  password?: string;
  captcha?: string;
  session_id?: string;
  batch_count?: number;
  success_target?: number;
  concurrent?: number;
  concurrent_interval?: number;
  captcha_retries?: number;
  local_captcha_retries?: number;
  otp_timeout?: number;
}

export class RegistrationService {
  #sessions = new Map<string, Session>();
  #jobs = new Map<string, RegistrationJob>();
  #renewer = new XiaomiTokenRenewer();

  constructor(
    private readonly config: ConfigStore,
    private readonly proxy: ProxyPool,
    private readonly validator = new AccountValidator(),
  ) {}

  status(): object {
    const captcha = this.config.snapshot().captcha_ai;
    return {
      pending_sessions: this.#sessions.size,
      active_jobs: [...this.#jobs.values()].filter((job) => ["running", "stopping"].includes(job.status)).length,
      captcha_ai_ready: captcha.enabled && Boolean(captcha.api_base && captcha.api_key),
      max_concurrency: maximumConcurrency(),
    };
  }

  async begin(input: RegistrationRequest, signal: AbortSignal): Promise<object> {
    this.#pruneSessions();
    const settings = this.settings(input);
    const password = settings.password || randomPassword();
    const mail = new TempMailClient(this.config.snapshot().temp_mail);
    const address = await mail.createAddress(signal);
    const encrypted = encryptCredentials(address.address, password);
    const session: Session = {
      id: randomUUID().replaceAll("-", ""),
      email: address.address,
      password,
      region: settings.region,
      deviceId: deviceId(),
      encryptedEmail: encrypted.encrypted.email,
      encryptedPassword: encrypted.encrypted.password,
      eui: encrypted.eui,
      mailJwt: address.jwt,
      cookies: new Map(),
      createdAt: Date.now(),
      captchaImage: "",
      captchaContentType: "image/jpeg",
      proxyUrl: await this.proxy.prepareForRegistration(signal),
      ticketSent: false,
    };
    await this.#refreshCaptcha(session, signal);
    this.#sessions.set(session.id, session);
    return sessionPublic(session);
  }

  async refresh(sessionId: string, signal: AbortSignal): Promise<object> {
    const session = this.session(sessionId);
    await this.#refreshCaptcha(session, signal);
    return sessionPublic(session);
  }

  async submit(input: RegistrationRequest, signal: AbortSignal, onProgress?: Progress): Promise<object> {
    const session = this.session(input.session_id);
    const captcha = String(input.captcha ?? "").trim();
    if (!captcha) throw new ApiError(400, "captcha_required", "image captcha is required");
    onProgress?.("captcha", "正在提交图片验证码", session.email);
    const ticket = await this.#sendTicket(session, captcha, signal);
    const code = numberCode(ticket.code);
    if (code !== 0 && ticket.code !== undefined && ticket.code !== "0") {
      if (CAPTCHA_ERRORS.has(code)) {
        await this.#refreshCaptcha(session, signal);
        return { ...sessionPublic(session), ok: false, need_captcha: true, error: "图片验证码错误，请重试", captcha_type: "image_code" };
      }
      throw passportError(ticket, "sending registration email failed");
    }
    session.ticketSent = true;
    onProgress?.("mail", "注册邮件已发送，等待邮箱验证码", session.email);
    return this.#finish(session, input, signal, onProgress);
  }

  async startBatch(input: RegistrationRequest): Promise<object> {
    const settings = this.settings(input);
    const captcha = this.config.snapshot().captcha_ai;
    if (!(captcha.enabled && captcha.api_base && captcha.api_key)) {
      throw new ApiError(400, "captcha_ai_not_configured", "batch registration requires a configured image captcha AI service");
    }
    const running = [...this.#jobs.values()].find((job) => ["running", "stopping"].includes(job.status));
    if (running) throw new ApiError(409, "registration_job_running", `registration job ${running.id} is already running`);
    const job: RegistrationJob = {
      id: randomUUID().replaceAll("-", ""),
      status: "running",
      controller: new AbortController(),
      startedAt: Date.now(),
      requested: settings.batchCount,
      target: settings.successTarget,
      concurrency: settings.concurrency,
      intervalSeconds: settings.intervalSeconds,
      region: settings.region,
      success: 0,
      failed: 0,
      stoppedEarly: false,
      message: "批量注册已启动",
      logs: [],
      results: [],
    };
    this.#jobs.set(job.id, job);
    this.log(job, 0, "job", `任务启动：最多 ${job.requested} 次，目标 ${job.target || "不限"}，并发 ${job.concurrency}`);
    void this.runBatch(job, settings);
    return this.jobPublic(job);
  }

  job(id: string): object {
    const job = this.#jobs.get(id);
    if (!job) throw new ApiError(404, "registration_job_not_found", "registration job not found");
    return this.jobPublic(job);
  }

  listJobs(): object {
    return { ok: true, jobs: [...this.#jobs.values()].sort((a, b) => b.startedAt - a.startedAt).slice(0, 10).map((job) => this.jobPublic(job)) };
  }

  stopJob(id: string): object {
    const job = this.#jobs.get(id);
    if (!job) throw new ApiError(404, "registration_job_not_found", "registration job not found");
    if (job.status === "running") {
      job.status = "stopping";
      job.message = "正在停止，当前网络请求已取消";
      this.log(job, 0, "job", job.message);
      job.controller.abort(new DOMException("Registration stopped", "AbortError"));
    }
    return this.jobPublic(job);
  }

  stop(): void {
    for (const job of this.#jobs.values()) {
      if (job.status === "running") {
        job.status = "stopping";
        job.controller.abort(new DOMException("Service stopping", "AbortError"));
      }
    }
    this.#sessions.clear();
  }

  private async runBatch(job: RegistrationJob, settings: Settings): Promise<void> {
    const workers = Array.from({ length: job.concurrency }, (_, index) => this.runWorker(job, settings, index));
    try {
      await Promise.all(workers);
      job.status = job.controller.signal.aborted ? "cancelled" : "done";
      job.stoppedEarly = !job.controller.signal.aborted && job.target > 0 && job.success >= job.target && job.results.length < job.requested;
      job.message = job.status === "cancelled"
        ? `任务已停止：成功 ${job.success}，失败 ${job.failed}`
        : `任务完成：成功 ${job.success}，失败 ${job.failed}${job.stoppedEarly ? "，达到目标提前结束" : ""}`;
      this.log(job, 0, "job", job.message);
    } catch (error) {
      if (job.controller.signal.aborted) {
        job.status = "cancelled";
        job.message = `任务已停止：成功 ${job.success}，失败 ${job.failed}`;
        this.log(job, 0, "job", job.message);
      } else {
        job.status = "error";
        job.message = `批量注册异常：${messageOf(error)}`;
        this.log(job, 0, "error", job.message);
      }
    } finally {
      job.finishedAt = Date.now();
    }
  }

  private async runWorker(job: RegistrationJob, settings: Settings, worker: number): Promise<void> {
    for (let attempt = worker + 1; attempt <= job.requested; attempt += job.concurrency) {
      if (job.controller.signal.aborted || this.targetReached(job)) return;
      if (attempt > 1) await delay(settings.intervalSeconds * 1_000, job.controller.signal);
      if (job.controller.signal.aborted || this.targetReached(job)) return;
      const progress: Progress = (stage, message, email = "") => this.log(job, attempt, stage, message, email);
      progress("start", `开始第 ${attempt} 次注册`);
      let result: JobResult;
      try {
        const completed = await this.autoAttempt(settings, job.controller.signal, progress);
        result = { attempt, ok: completed.saved, registered: completed.registered, saved: completed.saved, email: completed.email, user_id: completed.userId, error: completed.error };
      } catch (error) {
        if (job.controller.signal.aborted) return;
        result = { attempt, ok: false, registered: false, saved: false, email: "", error: messageOf(error) };
      }
      job.results.push(result);
      if (result.ok) {
        job.success += 1;
        progress("done", `账号已入池${result.user_id ? ` · userId=${result.user_id}` : ""}`, result.email);
      } else {
        job.failed += 1;
        progress("error", result.error || "注册失败", result.email);
      }
      job.message = `进行中：成功 ${job.success}${job.target ? `/${job.target}` : ""}，已尝试 ${job.results.length}/${job.requested}`;
    }
  }

  private async autoAttempt(settings: Settings, signal: AbortSignal, onProgress: Progress): Promise<Completion> {
    const started = await this.begin({ region: settings.region, domain: settings.domain, password: settings.password }, signal) as ReturnType<typeof sessionPublic>;
    const session = this.session(started.session_id);
    const captchaConfig = this.config.snapshot().captcha_ai;
    for (let attempt = 1; attempt <= settings.captchaRetries; attempt += 1) {
      const localOnly = !shouldUseAiFallback(attempt, settings.localCaptchaRetries);
      onProgress(
        "captcha_ocr",
        `本地 OCR 识别图片验证码（本地优先 ${Math.min(attempt, settings.localCaptchaRetries)}/${settings.localCaptchaRetries}，总计 ${attempt}/${settings.captchaRetries}）`,
        session.email,
      );
      const localCandidates = await solveCaptchaLocally(session.captchaImage, signal);
      const localResult = await this.#tryCaptchaCandidates(
        session,
        localCandidates,
        settings.otpTimeout,
        signal,
        onProgress,
      );
      if (localResult) return localResult;

      if (!localOnly) {
        onProgress("captcha_ai", "多轮本地 OCR 未通过，使用 OpenAI-compatible 视觉模型兜底", session.email);
        const aiResult = await this.#tryCaptchaCandidates(
          session,
          captchaCandidates([await solveCaptchaWithAi(session.captchaImage, captchaConfig, signal)]),
          settings.otpTimeout,
          signal,
          onProgress,
        );
        if (aiResult) return aiResult;
      }

      await this.#refreshCaptcha(session, signal);
      onProgress("captcha", localOnly ? "本地 OCR 候选未通过，已刷新图片继续本地识别" : "验证码候选均不匹配，已刷新图片", session.email);
    }
    throw new ApiError(422, "captcha_retry_exhausted", "image captcha retries exhausted");
  }

  async #tryCaptchaCandidates(
    session: Session,
    candidates: string[],
    otpTimeout: number,
    signal: AbortSignal,
    onProgress: Progress,
  ): Promise<Completion | undefined> {
    for (const candidate of candidates) {
      const ticket = await this.#sendTicket(session, candidate, signal);
      const code = numberCode(ticket.code);
      if (code === 0 || ticket.code === undefined || ticket.code === "0") {
        session.ticketSent = true;
        onProgress("mail", "图片验证码通过，等待注册邮件", session.email);
        return completion(await this.#finish(session, { otp_timeout: otpTimeout }, signal, onProgress));
      }
      if (!CAPTCHA_ERRORS.has(code)) throw passportError(ticket, "sending registration email failed");
    }
    return undefined;
  }

  async #refreshCaptcha(session: Session, signal: AbortSignal): Promise<void> {
    const url = new URL(`${ACCOUNT}/pass/getCode`);
    url.searchParams.set("icodeType", "register");
    url.searchParams.set("_", String(Date.now()));
    const response = await this.requestBytes(session, url, {
      headers: this.headers(session, { Referer: `${ACCOUNT}/fe/service/register`, Accept: "image/avif,image/webp,image/apng,image/*,*/*;q=0.8" }),
    }, signal);
    if (response.status !== 200 || response.body.length === 0) throw new ApiError(502, "captcha_fetch_failed", `captcha image returned HTTP ${response.status}`);
    session.captchaContentType = response.headers.get("content-type") || "image/jpeg";
    session.captchaImage = `data:${imageMime(session.captchaContentType)};base64,${response.body.toString("base64")}`;
  }

  async #sendTicket(session: Session, captcha: string, signal: AbortSignal): Promise<Record<string, any>> {
    return this.requestJson(session, `${ACCOUNT}/pass/sendEmailRegTicket`, {
      method: "POST",
      headers: this.headers(session, registrationHeaders(session.eui)),
      body: form({
        email: session.encryptedEmail,
        password: session.encryptedPassword,
        region: session.region,
        sid: SID,
        icode: captcha,
        _json: "true",
      }),
    }, signal);
  }

  async #finish(session: Session, input: RegistrationRequest, signal: AbortSignal, onProgress?: Progress): Promise<object> {
    const mail = new TempMailClient(this.config.snapshot().temp_mail);
    const seen = new Set<string>();
    try { for (const item of await mail.listMails(session.mailJwt, signal)) seen.add(String(item.id ?? item.message_id ?? "")); } catch { /* new code can still be read */ }
    const timeout = clamp(input.otp_timeout, 30, 600, this.config.snapshot().temp_mail.otp_timeout) * 1_000;
    const code = await mail.waitForCode(session.mailJwt, { signal, timeoutMs: timeout, seenIds: seen, onPoll: () => onProgress?.("mail", "等待注册验证码邮件", session.email) });
    onProgress?.("verify", "收到注册邮箱验证码，正在校验", session.email);
    const verified = await this.requestJson(session, `${ACCOUNT}/pass/verifyEmailRegTicket`, {
      method: "POST",
      headers: this.headers(session, registrationHeaders(session.eui)),
      body: form({
        ticket: code,
        region: session.region,
        email: session.encryptedEmail,
        env: "web",
        qs: "%3Fsid%3Dxiaomichatbot%26_json%3Dtrue",
        isAcceptLicense: "true",
        sid: SID,
        password: session.encryptedPassword,
        policyName: "globalmiaccount",
        callback: `${AISTUDIO}/sts`,
        deviceFingerprint: createHash("md5").update(`${session.deviceId}-${Date.now()}`).digest("hex"),
        _json: "true",
      }),
    }, signal);
    const verifyCode = numberCode(verified.code);
    if (verifyCode !== 0 && verified.code !== undefined && verified.code !== "0") throw passportError(verified, "email verification failed");
    const passToken = String(verified.passToken ?? session.cookies.get("passToken") ?? "");
    const userId = String(verified.userId ?? session.cookies.get("userId") ?? "");
    const cUserId = String(verified.cUserId ?? session.cookies.get("cUserId") ?? "");
    if (!passToken) {
      this.#sessions.delete(session.id);
      return { ok: true, registered: true, saved: false, email: session.email, message: "账号已注册，但未获得 passToken，未写入账号池" };
    }
    onProgress?.("login", "正在换取 MiMo 服务凭据", session.email);
    const account = await this.#renewer.renew(MimoAccountSchema.parse({
      email: session.email,
      password: session.password,
      pass_token: passToken,
      user_id: userId,
      c_user_id: cUserId,
      device_id: session.deviceId,
      mail_jwt: session.mailJwt,
      region: session.region,
      auto_renew: true,
    }), signal);
    const checked = await this.validator.validate(account, signal);
    const saved = await this.saveAccount(checked);
    this.#sessions.delete(session.id);
    return { ok: true, registered: true, saved: !saved.duplicate, duplicate: saved.duplicate, email: checked.email, user_id: checked.user_id, region: checked.region };
  }

  private async saveAccount(account: MimoAccount): Promise<{ duplicate: boolean }> {
    const accounts = this.config.snapshot().mimo_accounts;
    const duplicate = accounts.some((item) => item.user_id === account.user_id || (item.email && item.email === account.email));
    if (!duplicate) await this.config.replaceAccounts([...accounts, account]);
    return { duplicate };
  }

  private async requestJson(session: Session, url: string, init: RequestInit, signal: AbortSignal): Promise<Record<string, any>> {
    const response = await this.request(session, url, init, signal);
    return parseJson(response.body);
  }

  private async requestBytes(session: Session, url: URL, init: RequestInit, signal: AbortSignal): Promise<{ status: number; body: Buffer; headers: Headers }> {
    const dispatcher = session.proxyUrl ? new ProxyAgent(session.proxyUrl) : undefined;
    try {
      const response = await fetch(url, { ...init, redirect: "manual", signal, dispatcher });
      mergeCookies(response.headers, session.cookies);
      return { status: response.status, body: Buffer.from(await response.arrayBuffer()), headers: response.headers };
    } finally {
      await dispatcher?.close();
    }
  }

  private async request(session: Session, url: string, init: RequestInit, signal: AbortSignal): Promise<{ status: number; body: string; headers: Headers }> {
    const dispatcher = session.proxyUrl ? new ProxyAgent(session.proxyUrl) : undefined;
    try {
      const response = await fetch(url, { ...init, redirect: "manual", signal, dispatcher });
      mergeCookies(response.headers, session.cookies);
      return { status: response.status, body: await response.text(), headers: response.headers };
    } finally {
      await dispatcher?.close();
    }
  }

  private headers(session: Session, extra: Record<string, string> = {}): Record<string, string> {
    return {
      "User-Agent": USER_AGENT,
      Accept: "application/json, text/plain, */*",
      "Accept-Language": "en-US,en;q=0.9",
      Cookie: [...session.cookies].map(([name, value]) => `${name}=${value}`).join("; "),
      ...extra,
    };
  }

  private settings(input: RegistrationRequest): Settings {
    const config = this.config.snapshot().temp_mail;
    const region = regionOf(input.region ?? config.register_region);
    const batchCount = clamp(input.batch_count, 1, 200, config.batch_count);
    const target = clamp(input.success_target, 0, 200, config.success_target);
    return {
      region,
      domain: String(input.domain ?? config.domain ?? "").trim(),
      password: input.password ?? "",
      batchCount: Math.max(batchCount, target),
      successTarget: target,
      concurrency: Math.min(clamp(input.concurrent, 1, 20, config.concurrent), maximumConcurrency(), this.config.snapshot().proxy_pool.enabled ? 1 : Number.MAX_SAFE_INTEGER),
      intervalSeconds: Math.max(2, clamp(input.concurrent_interval, 0, 300, config.concurrent_interval)),
      captchaRetries: clamp(input.captcha_retries, 1, 30, config.captcha_retries),
      localCaptchaRetries: Math.min(
        clamp(input.local_captcha_retries, 1, 30, config.local_captcha_retries),
        clamp(input.captcha_retries, 1, 30, config.captcha_retries),
      ),
      otpTimeout: clamp(input.otp_timeout, 30, 600, config.otp_timeout),
    };
  }

  private targetReached(job: RegistrationJob): boolean {
    return job.target > 0 && job.success >= job.target;
  }

  private session(id: string | undefined): Session {
    const session = id ? this.#sessions.get(id) : undefined;
    if (!session) throw new ApiError(404, "registration_session_not_found", "registration session expired; start again");
    return session;
  }

  private log(job: RegistrationJob, attempt: number, stage: string, message: string, email = ""): void {
    job.logs.push({ at: Date.now(), attempt, stage, message: message.slice(0, 300), email });
    if (job.logs.length > 300) job.logs.splice(0, job.logs.length - 300);
  }

  private jobPublic(job: RegistrationJob): object {
    return {
      ok: job.status !== "error",
      job_id: job.id,
      status: job.status,
      requested: job.requested,
      success_target: job.target,
      success: job.success,
      failed: job.failed,
      concurrent: job.concurrency,
      interval_seconds: job.intervalSeconds,
      region: job.region,
      stopped_early: job.stoppedEarly,
      message: job.message,
      started_at: job.startedAt,
      finished_at: job.finishedAt ?? null,
      results: job.results,
      logs: job.logs,
    };
  }

  #pruneSessions(): void {
    const cutoff = Date.now() - 30 * 60_000;
    for (const [id, session] of this.#sessions) if (session.createdAt < cutoff) this.#sessions.delete(id);
  }
}

type Progress = (stage: string, message: string, email?: string) => void;

interface Settings {
  region: string;
  domain: string;
  password: string;
  batchCount: number;
  successTarget: number;
  concurrency: number;
  intervalSeconds: number;
  captchaRetries: number;
  localCaptchaRetries: number;
  otpTimeout: number;
}

interface Completion {
  registered: boolean;
  saved: boolean;
  email: string;
  userId?: string;
  error?: string;
}

const completion = (result: Record<string, any>): Completion => ({
  registered: Boolean(result.registered),
  saved: Boolean(result.saved),
  email: String(result.email ?? ""),
  userId: result.user_id ? String(result.user_id) : undefined,
  error: result.error ? String(result.error) : undefined,
});

const sessionPublic = (session: Session) => ({
  ok: true,
  need_captcha: true,
  session_id: session.id,
  email: session.email,
  region: session.region,
  captcha_image: session.captchaImage,
  message: "临时邮箱已创建，请输入图片验证码继续",
});

const registrationHeaders = (eui: string) => ({
  "Content-Type": "application/x-www-form-urlencoded; charset=UTF-8",
  Origin: ACCOUNT,
  Referer: `${ACCOUNT}/fe/service/register`,
  "X-Requested-With": "XMLHttpRequest",
  EUI: eui,
});

const form = (values: Record<string, string>): string => new URLSearchParams(values).toString();

const parseJson = (value: string): Record<string, any> => {
  try { return JSON.parse(value.startsWith("&&&START&&&") ? value.slice(11) : value) as Record<string, any>; }
  catch { return { _raw: value.slice(0, 300) }; }
};

const mergeCookies = (headers: Headers, cookies: Map<string, string>): void => {
  const values = typeof headers.getSetCookie === "function" ? headers.getSetCookie() : [headers.get("set-cookie") ?? ""];
  for (const header of values) {
    const match = /^\s*([^=\s]+)=((?:"(?:\\.|[^"\\])*")|[^;]*)/.exec(header);
    if (!match?.[1]) continue;
    const value = (match[2] ?? "").replace(/^"|"$/g, "");
    if (!value || value === "EXPIRED") cookies.delete(match[1]);
    else cookies.set(match[1], value);
  }
};

const encryptCredentials = (email: string, password: string): { encrypted: Record<"email" | "password", string>; eui: string } => {
  const key = Buffer.from(Array.from({ length: 16 }, () => AES_CHARS[Math.floor(Math.random() * AES_CHARS.length)]).join(""));
  const encrypted = Object.fromEntries([email, password].map((value, index) => {
    const cipher = createCipheriv("aes-128-cbc", key, AES_IV);
    return [["email", "password"][index]!, Buffer.concat([cipher.update(value, "utf8"), cipher.final()]).toString("base64")];
  })) as Record<"email" | "password", string>;
  const publicKey = createPublicKey({ key: Buffer.from(RSA_PUBLIC_KEY_DER, "base64"), format: "der", type: "spki" });
  const wrapped = publicEncrypt({ key: publicKey, padding: constants.RSA_PKCS1_PADDING }, Buffer.from(key.toString("base64"))).toString("base64");
  return { encrypted, eui: `${wrapped}.${Buffer.from("email,password").toString("base64")}` };
};

const solveCaptchaWithAi = async (dataUrl: string, config: CaptchaAiConfig, signal: AbortSignal): Promise<string> => {
  const base = config.api_base.trim().replace(/\/$/, "");
  if (!(config.enabled && base && config.api_key && config.model && dataUrl)) return "";
  const response = await fetch(`${base}/v1/chat/completions`, {
    method: "POST",
    signal,
    headers: { Authorization: `Bearer ${config.api_key}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      model: config.model,
      temperature: 0,
      max_tokens: 32,
      messages: [{ role: "user", content: [
        { type: "text", text: "这是小米账号注册用的图片验证码，通常是扭曲的字母或数字。只输出验证码字符，不要空格、引号或解释；若不清晰，请猜测最可能的 3-6 个字符。" },
        { type: "image_url", image_url: { url: dataUrl } },
      ] }],
    }),
  });
  if (!response.ok) return "";
  const payload = await response.json() as any;
  const content = payload?.choices?.[0]?.message?.content;
  const text = Array.isArray(content) ? content.map((part) => typeof part === "string" ? part : part?.text ?? "").join("") : String(content ?? "");
  return text.split(/\r?\n/, 1)[0]!.replace(/[^0-9A-Za-z\u4e00-\u9fff]/g, "").slice(0, 12);
};

const passportError = (payload: Record<string, any>, fallback: string): ApiError => {
  const code = numberCode(payload.code);
  const message = String(payload.desc ?? payload.description ?? payload.reason ?? fallback);
  const type = CAPTCHA_ERRORS.has(code) ? "image_code" : detectCaptcha(payload);
  const suffix = type === "image_code" ? "" : ` [${type}]`;
  return new ApiError(422, "registration_failed", `${message}${suffix}`);
};

const detectCaptcha = (payload: Record<string, any>): string => {
  const text = JSON.stringify(payload).toLowerCase();
  if (text.includes("recaptcha")) return "recaptcha";
  if (text.includes("slide") || text.includes("滑块") || text.includes("geetest")) return "slide";
  if (text.includes("click") || text.includes("grid") || text.includes("点选")) return "click";
  if (text.includes("denied") || text.includes("拒绝") || text.includes("risk")) return "risk_control";
  return "unknown";
};

const numberCode = (value: unknown): number => Number.isFinite(Number(value)) ? Number(value) : -1;
const imageMime = (contentType: string): string => contentType.includes("png") ? "image/png" : contentType.includes("gif") ? "image/gif" : "image/jpeg";
const deviceId = (): string => `wb${createHash("md5").update(`${Date.now()}-${randomUUID()}`).digest("hex").slice(0, 12)}`;
const randomPassword = (): string => {
  const chars = "abcdefghijkmnopqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789!@#$%&*";
  return `Aa1!${Array.from({ length: 8 }, () => chars[Math.floor(Math.random() * chars.length)]).join("")}`;
};
const regionOf = (value: string | undefined): string => {
  const region = String(value ?? "RANDOM").trim().toUpperCase();
  if (["CN", "ZH", "CHINA", "PRC"].includes(region)) throw new ApiError(400, "invalid_registration_region", "registration region cannot be China; choose US, SG, JP or RANDOM");
  return ["", "RANDOM", "AUTO", "*"].includes(region) ? REGIONS[Math.floor(Math.random() * REGIONS.length)]! : region;
};
const clamp = (value: unknown, minimum: number, maximum: number, fallback: number): number => {
  const parsed = Number(value ?? fallback);
  return Math.min(maximum, Math.max(minimum, Number.isFinite(parsed) ? parsed : fallback));
};
const maximumConcurrency = (): number => clamp(process.env.MIMO2API_REGISTER_MAX_CONCURRENCY, 1, 3, 1);
const delay = (milliseconds: number, signal: AbortSignal): Promise<void> => new Promise((resolve, reject) => {
  const timer = setTimeout(() => { signal.removeEventListener("abort", abort); resolve(); }, milliseconds);
  const abort = () => { clearTimeout(timer); reject(signal.reason ?? new DOMException("Aborted", "AbortError")); };
  signal.addEventListener("abort", abort, { once: true });
});
const messageOf = (error: unknown): string => error instanceof Error ? error.message.slice(0, 300) : String(error).slice(0, 300);

export { encryptCredentials, regionOf };
