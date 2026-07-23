import { spawn, type ChildProcess } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fetch, ProxyAgent } from "undici";
import type { ProxyPoolConfig } from "../config/types.js";
import { ApiError } from "../core/errors.js";

interface VlessNode {
  name: string;
  uuid: string;
  server: string;
  port: number;
  security: string;
  network: string;
  host: string;
  path: string;
  sni: string;
  fingerprint: string;
  flow: string;
  tag: string;
}

export class ProxyPool {
  #nodes: VlessNode[] = [];
  #selected = 0;
  #process?: ChildProcess;
  #lastError = "";
  #lastFetch = 0;

  constructor(private config: ProxyPoolConfig) {}

  configure(config: ProxyPoolConfig): void {
    this.config = config;
    if (!config.enabled) this.stop();
  }

  async refresh(signal: AbortSignal): Promise<VlessNode[]> {
    if (!this.config.sub_url) throw new ApiError(400, "proxy_not_configured", "proxy subscription URL is not configured");
    const response = await fetch(this.config.sub_url, {
      headers: { "User-Agent": "MiMo2API-ProxyPool/3.0" },
      redirect: "follow",
      signal,
    });
    if (!response.ok) throw new ApiError(502, "proxy_subscription_failed", `subscription returned HTTP ${response.status}`);
    this.#nodes = decodeSubscription(await response.text()).map(parseVless).filter((node): node is VlessNode => Boolean(node));
    this.#lastFetch = Date.now();
    if (this.#nodes.length === 0) throw new ApiError(400, "proxy_subscription_empty", "subscription contains no VLESS nodes");
    return this.#nodes;
  }

  async start(signal: AbortSignal): Promise<object> {
    if (!this.config.enabled) throw new ApiError(400, "proxy_disabled", "proxy pool is disabled");
    if (this.#nodes.length === 0) await this.refresh(signal);
    this.stop();
    const root = process.env.MIMO2API_DATA_DIR ?? ".";
    const directory = path.resolve(root, ".singbox");
    await mkdir(directory, { recursive: true });
    const configFile = path.join(directory, "config.json");
    await writeFile(configFile, JSON.stringify(singBoxConfig(this.#nodes, this.config.listen_port, this.#selected), null, 2));
    const binary = this.config.singbox_path || process.env.SING_BOX_PATH || "sing-box";
    this.#process = spawn(binary, ["run", "-c", configFile], { stdio: ["ignore", "ignore", "pipe"], windowsHide: true });
    const spawnError = new Promise<never>((_resolve, reject) => {
      this.#process?.once("error", (error) => reject(new ApiError(502, "singbox_start_failed", error.message)));
    });
    this.#process.stderr?.on("data", (chunk) => { this.#lastError = String(chunk).slice(-500); });
    await Promise.race([delay(1_000, signal), spawnError]);
    if (this.#process.exitCode !== null) throw new ApiError(502, "singbox_start_failed", this.#lastError || "sing-box exited during startup");
    return this.status();
  }

  stop(): object {
    if (this.#process && this.#process.exitCode === null) this.#process.kill("SIGTERM");
    this.#process = undefined;
    return this.status();
  }

  async rotate(signal: AbortSignal): Promise<object> {
    if (this.#nodes.length === 0) await this.refresh(signal);
    this.#selected = (this.#selected + 1) % this.#nodes.length;
    return this.start(signal);
  }

  async test(signal: AbortSignal): Promise<object> {
    if (!this.#process || this.#process.exitCode !== null) await this.start(signal);
    const proxyUrl = `http://127.0.0.1:${this.config.listen_port}`;
    const response = await fetch("https://api.ipify.org?format=json", {
      dispatcher: new ProxyAgent(proxyUrl),
      signal,
    });
    return { ok: response.ok, proxy_url: proxyUrl, egress: (await response.text()).slice(0, 200), ...this.status() };
  }

  status(): Record<string, any> {
    const running = Boolean(this.#process && this.#process.exitCode === null);
    return {
      enabled: this.config.enabled,
      status: running ? "running" : "stopped",
      listen_port: this.config.listen_port,
      proxy_url: running ? `http://127.0.0.1:${this.config.listen_port}` : null,
      pid: running ? this.#process?.pid : null,
      node_count: this.#nodes.length,
      selected: this.#nodes[this.#selected]?.tag ?? "",
      last_error: this.#lastError,
      last_fetch: this.#lastFetch,
      sub_configured: Boolean(this.config.sub_url),
      nodes: this.#nodes.slice(0, 50).map(({ name, server, port, tag }) => ({ name, server, port, tag })),
    };
  }
}

export const decodeSubscription = (body: string): string[] => {
  const text = body.trim();
  if (text.includes("vless://")) return text.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  try { return Buffer.from(text, "base64").toString("utf8").split(/\r?\n/).map((line) => line.trim()).filter(Boolean); }
  catch { return []; }
};

const parseVless = (value: string): VlessNode | undefined => {
  if (!value.startsWith("vless://")) return undefined;
  try {
    const url = new URL(value);
    const query = url.searchParams;
    const name = decodeURIComponent(url.hash.slice(1) || `${url.hostname}:${url.port || 443}`);
    return {
      name,
      uuid: decodeURIComponent(url.username),
      server: url.hostname,
      port: Number(url.port || 443),
      security: query.get("security") || "tls",
      network: query.get("type") || query.get("network") || "tcp",
      host: query.get("host") || "",
      path: decodeURIComponent(query.get("path") || "/"),
      sni: query.get("sni") || query.get("host") || url.hostname,
      fingerprint: query.get("fp") || "chrome",
      flow: query.get("flow") || "",
      tag: `vless-${Buffer.from(`${name}-${url.hostname}-${url.port}`).toString("base64url").slice(0, 30)}`,
    };
  } catch { return undefined; }
};

const singBoxConfig = (nodes: VlessNode[], port: number, selected: number) => {
  const outbounds = nodes.map((node) => ({
    type: "vless",
    tag: node.tag,
    server: node.server,
    server_port: node.port,
    uuid: node.uuid,
    flow: node.flow || undefined,
    packet_encoding: "xudp",
    tls: ["tls", "reality"].includes(node.security) ? {
      enabled: true,
      server_name: node.sni,
      insecure: false,
      utls: { enabled: true, fingerprint: node.fingerprint },
    } : undefined,
    transport: node.network === "ws" ? {
      type: "ws", path: node.path, headers: node.host ? { Host: node.host } : undefined,
    } : undefined,
  }));
  return {
    log: { level: "warn", timestamp: true },
    inbounds: [{ type: "mixed", tag: "mixed-in", listen: "127.0.0.1", listen_port: port }],
    outbounds: [
      ...outbounds,
      { type: "selector", tag: "select", outbounds: outbounds.map((item) => item.tag), default: outbounds[selected]?.tag },
      { type: "direct", tag: "direct" },
    ],
    route: { final: "select" },
  };
};

const delay = (ms: number, signal: AbortSignal) => new Promise<void>((resolve, reject) => {
  const onAbort = () => { clearTimeout(timer); reject(signal.reason); };
  const timer = setTimeout(() => {
    signal.removeEventListener("abort", onAbort);
    resolve();
  }, ms);
  signal.addEventListener("abort", onAbort, { once: true });
});
