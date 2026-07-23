import { spawn, type ChildProcess } from "node:child_process";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import path from "node:path";
import { randomUUID } from "node:crypto";
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

interface ActiveLease {
  id: string;
  url: string;
  port: number;
  process: ChildProcess;
  directory: string;
  lastError: string;
}

export interface ProxyLease {
  id: string;
  url: string;
}

export class ProxyPool {
  #nodes: VlessNode[] = [];
  #usedNodeTags = new Set<string>();
  #leases = new Map<string, ActiveLease>();
  #reservedPorts = new Set<number>();
  #lastError = "";
  #lastFetch = 0;

  constructor(private config: ProxyPoolConfig) {}

  async configure(config: ProxyPoolConfig): Promise<void> {
    if (config.sub_url !== this.config.sub_url) {
      this.#nodes = [];
      this.#usedNodeTags.clear();
    }
    this.config = config;
    if (!config.enabled) await this.close();
  }

  async refresh(signal: AbortSignal): Promise<VlessNode[]> {
    if (!this.config.sub_url) throw new ApiError(400, "proxy_not_configured", "proxy subscription URL is not configured");
    const response = await fetch(this.config.sub_url, {
      headers: { "User-Agent": "MiMo2API-ProxyPool/3.0" },
      redirect: "follow",
      signal,
    });
    if (!response.ok) throw new ApiError(502, "proxy_subscription_failed", `subscription returned HTTP ${response.status}`);
    const nodes = decodeSubscription(await response.text()).map(parseVless).filter((node): node is VlessNode => Boolean(node));
    if (nodes.length === 0) throw new ApiError(400, "proxy_subscription_empty", "subscription contains no VLESS nodes");
    this.#nodes = nodes;
    const currentTags = new Set(nodes.map((node) => node.tag));
    for (const tag of this.#usedNodeTags) if (!currentTags.has(tag)) this.#usedNodeTags.delete(tag);
    this.#lastFetch = Date.now();
    return nodes;
  }

  async acquireForRegistration(signal: AbortSignal): Promise<ProxyLease | undefined> {
    if (!this.config.enabled) return undefined;
    if (this.config.fetch_sub_each_time || this.#nodes.length === 0) await this.refresh(signal);
    if (this.#nodes.length === 0) throw new ApiError(502, "proxy_registration_unavailable", "proxy pool has no usable nodes");

    const node = chooseProxyNode(this.#nodes, this.#usedNodeTags);
    const id = randomUUID().replaceAll("-", "");
    const port = await this.#reservePort();
    const root = process.env.MIMO2API_DATA_DIR ?? ".";
    const directory = path.resolve(root, ".singbox", id);
    const configFile = path.join(directory, "config.json");
    try {
      await mkdir(directory, { recursive: true });
      await writeFile(configFile, JSON.stringify(singBoxConfig(node, port), null, 2));
    } catch (error) {
      this.#reservedPorts.delete(port);
      await rm(directory, { recursive: true, force: true });
      throw error;
    }

    const binary = this.config.singbox_path || process.env.SING_BOX_PATH || "sing-box";
    const child = spawn(binary, ["run", "-c", configFile], { stdio: ["ignore", "ignore", "pipe"], windowsHide: true });
    const lease: ActiveLease = {
      id,
      url: `http://127.0.0.1:${port}`,
      port,
      process: child,
      directory,
      lastError: "",
    };
    this.#leases.set(id, lease);
    child.stderr?.on("data", (chunk) => {
      lease.lastError = String(chunk).slice(-500);
      this.#lastError = lease.lastError;
    });

    try {
      const spawnError = new Promise<never>((_resolve, reject) => {
        child.once("error", (error) => reject(new ApiError(502, "singbox_start_failed", error.message)));
      });
      await Promise.race([delay(1_000, signal), spawnError]);
      if (child.exitCode !== null) {
        throw new ApiError(502, "singbox_start_failed", lease.lastError || "sing-box exited during startup");
      }
      return { id, url: lease.url };
    } catch (error) {
      await this.release(id);
      throw error;
    }
  }

  async release(id: string | undefined): Promise<void> {
    if (!id) return;
    const lease = this.#leases.get(id);
    if (!lease) return;
    this.#leases.delete(id);
    try {
      if (lease.process.exitCode === null && lease.process.signalCode === null) {
        lease.process.kill("SIGTERM");
        if (!await waitForExit(lease.process, 2_000)) {
          lease.process.kill("SIGKILL");
          await waitForExit(lease.process, 500);
        }
      }
    } finally {
      this.#reservedPorts.delete(lease.port);
      try {
        await rm(lease.directory, { recursive: true, force: true });
      } catch (error) {
        this.#lastError = `proxy lease cleanup failed: ${error instanceof Error ? error.message : String(error)}`;
      }
    }
  }

  async close(): Promise<void> {
    await Promise.allSettled([...this.#leases.keys()].map((id) => this.release(id)));
  }

  async test(signal: AbortSignal): Promise<object> {
    const lease = await this.acquireForRegistration(signal);
    if (!lease) throw new ApiError(400, "proxy_disabled", "proxy pool is disabled");
    let ok = false;
    const dispatcher = new ProxyAgent(lease.url);
    try {
      const response = await fetch("https://api.ipify.org?format=json", {
        dispatcher,
        signal,
      });
      ok = response.ok;
      await response.arrayBuffer();
    } finally {
      try {
        await dispatcher.close();
      } finally {
        await this.release(lease.id);
      }
    }
    return { ok, ...this.status() };
  }

  status(): Record<string, any> {
    return {
      enabled: this.config.enabled,
      status: this.#leases.size > 0 ? "leased" : "idle",
      active_leases: this.#leases.size,
      node_count: this.#nodes.length,
      used_in_cycle: this.#usedNodeTags.size,
      last_error: this.#lastError,
      last_fetch: this.#lastFetch,
      sub_configured: Boolean(this.config.sub_url),
    };
  }

  async #reservePort(): Promise<number> {
    for (let attempt = 0; attempt < 20; attempt += 1) {
      const port = await availablePort();
      if (this.#reservedPorts.has(port)) continue;
      this.#reservedPorts.add(port);
      return port;
    }
    throw new ApiError(503, "proxy_port_unavailable", "could not reserve a local proxy port");
  }
}

export const chooseProxyNode = <T extends { tag: string }>(nodes: T[], used: Set<string>, random = Math.random): T => {
  let available = nodes.filter((node) => !used.has(node.tag));
  if (available.length === 0) {
    used.clear();
    available = [...nodes];
  }
  const selected = available[Math.min(available.length - 1, Math.floor(random() * available.length))]!;
  used.add(selected.tag);
  return selected;
};

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

const singBoxConfig = (node: VlessNode, port: number) => ({
  log: { level: "warn", timestamp: true },
  inbounds: [{ type: "mixed", tag: "mixed-in", listen: "127.0.0.1", listen_port: port }],
  outbounds: [{
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
  }],
  route: { final: node.tag },
});

const availablePort = (): Promise<number> => new Promise((resolve, reject) => {
  const server = createServer();
  server.once("error", reject);
  server.listen(0, "127.0.0.1", () => {
    const address = server.address();
    const port = typeof address === "object" && address ? address.port : 0;
    server.close((error) => error ? reject(error) : resolve(port));
  });
});

const waitForExit = (child: ChildProcess, ms: number): Promise<boolean> => new Promise((resolve) => {
  if (child.exitCode !== null || child.signalCode !== null) return resolve(true);
  const done = () => {
    clearTimeout(timer);
    resolve(true);
  };
  const timer = setTimeout(() => {
    child.removeListener("exit", done);
    resolve(false);
  }, ms);
  timer.unref();
  child.once("exit", done);
});

const delay = (ms: number, signal: AbortSignal) => new Promise<void>((resolve, reject) => {
  if (signal.aborted) return reject(signal.reason);
  const onAbort = () => { clearTimeout(timer); reject(signal.reason); };
  const timer = setTimeout(() => {
    signal.removeEventListener("abort", onAbort);
    resolve();
  }, ms);
  signal.addEventListener("abort", onAbort, { once: true });
});
