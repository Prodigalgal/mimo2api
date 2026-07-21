"""VLESS subscription proxy pool via local sing-box.

Flow:
1. Fetch base64 subscription (vless:// lines)
2. Parse nodes → sing-box outbounds
3. Run sing-box with mixed inbound (HTTP+SOCKS on 127.0.0.1)
4. Registration httpx uses socks5://127.0.0.1:<port>

Config is user-supplied (UI / config.json), not hardcoded.
"""

from __future__ import annotations

import asyncio
import base64
import json
import os
import platform
import random
import shutil
import socket
import subprocess
import sys
import threading
import time
import zipfile
from dataclasses import dataclass, field, asdict
from pathlib import Path
from typing import Any, Dict, List, Optional, Tuple
from urllib.parse import parse_qs, unquote, urlparse

import httpx

# project-local binary cache
_BIN_DIR = Path(__file__).resolve().parent.parent / ".bin"
_CONFIG_DIR = Path(__file__).resolve().parent.parent / ".singbox"
_DEFAULT_LISTEN_PORT = 17890


@dataclass
class ProxyPoolSettings:
    enabled: bool = False
    sub_url: str = ""
    # local mixed inbound port for sing-box
    listen_port: int = _DEFAULT_LISTEN_PORT
    # path to sing-box binary; empty = auto find / download
    singbox_path: str = ""
    # rotate outbound every N register attempts (1 = every attempt)
    rotate_every: int = 1
    # auto refresh subscription seconds (0 = only on start/manual)
    refresh_interval: int = 3600

    def normalized(self) -> "ProxyPoolSettings":
        port = int(self.listen_port or _DEFAULT_LISTEN_PORT)
        port = max(1024, min(65535, port))
        return ProxyPoolSettings(
            enabled=bool(self.enabled),
            sub_url=(self.sub_url or "").strip(),
            listen_port=port,
            singbox_path=(self.singbox_path or "").strip(),
            rotate_every=max(1, min(100, int(self.rotate_every or 1))),
            refresh_interval=max(0, min(86400 * 7, int(self.refresh_interval or 0))),
        )

    def to_dict(self, mask: bool = True) -> dict:
        n = self.normalized()
        d = asdict(n)
        if mask and n.sub_url and "token=" in n.sub_url:
            # mask token query value
            try:
                from urllib.parse import urlparse, parse_qs, urlencode, urlunparse

                u = urlparse(n.sub_url)
                qs = parse_qs(u.query)
                if "token" in qs and qs["token"]:
                    tok = qs["token"][0]
                    if len(tok) > 8:
                        qs["token"] = [tok[:4] + "***" + tok[-4:]]
                    else:
                        qs["token"] = ["***"]
                d["sub_url"] = urlunparse(
                    (u.scheme, u.netloc, u.path, u.params, urlencode({k: v[0] for k, v in qs.items()}), u.fragment)
                )
            except Exception:
                d["sub_url"] = n.sub_url[:20] + "***"
        d["configured"] = bool(n.sub_url)
        return d


@dataclass
class VlessNode:
    name: str
    uuid: str
    server: str
    port: int
    security: str = "tls"
    network: str = "ws"
    host: str = ""
    path: str = "/"
    sni: str = ""
    fp: str = "chrome"
    flow: str = ""
    encryption: str = "none"

    def tag(self) -> str:
        # sing-box tag: ASCII only (CJK isalnum() is True in Python)
        raw = self.name or f"{self.server}:{self.port}"
        safe = "".join(c if ("A" <= c <= "Z") or ("a" <= c <= "z") or ("0" <= c <= "9") or c in "-_." else "_" for c in raw)
        safe = safe.strip("_")[:40] or "node"
        # include server fragment for uniqueness
        host_part = self.server.replace(".", "-")[:20]
        return f"vless-{safe}-{host_part}-{self.port}"


class ProxyPoolError(Exception):
    pass


def _free_port(preferred: int) -> int:
    for p in (preferred, preferred + 1, preferred + 2, 0):
        try:
            with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
                s.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
                s.bind(("127.0.0.1", p))
                return s.getsockname()[1]
        except OSError:
            continue
    return preferred


def parse_vless_uri(uri: str) -> Optional[VlessNode]:
    uri = (uri or "").strip()
    if not uri.startswith("vless://"):
        return None
    try:
        u = urlparse(uri)
        userinfo, hostport = u.netloc.rsplit("@", 1) if "@" in u.netloc else ("", u.netloc)
        uuid = userinfo
        if ":" in hostport:
            host, port_s = hostport.rsplit(":", 1)
            port = int(port_s)
        else:
            host, port = hostport, 443
        qs = {k: v[0] for k, v in parse_qs(u.query).items()}
        name = unquote(u.fragment or f"{host}:{port}")
        return VlessNode(
            name=name,
            uuid=uuid,
            server=host,
            port=port,
            security=qs.get("security") or "tls",
            network=qs.get("type") or qs.get("network") or "tcp",
            host=qs.get("host") or "",
            path=unquote(qs.get("path") or "/"),
            sni=qs.get("sni") or qs.get("host") or "",
            fp=qs.get("fp") or "chrome",
            flow=qs.get("flow") or "",
            encryption=qs.get("encryption") or "none",
        )
    except Exception as e:
        print(f"[ProxyPool] parse vless fail: {e} uri={uri[:80]}")
        return None


def decode_subscription(body: str) -> List[str]:
    text = (body or "").strip()
    if not text:
        return []
    # already plain multi-line links
    if "vless://" in text and not text.startswith("dmxlc3M"):
        lines = [ln.strip() for ln in text.splitlines() if ln.strip()]
        if any(ln.startswith("vless://") for ln in lines):
            return lines
    # base64
    try:
        pad = "=" * ((4 - len(text) % 4) % 4)
        dec = base64.b64decode(text + pad).decode("utf-8", "replace")
        return [ln.strip() for ln in dec.splitlines() if ln.strip()]
    except Exception:
        return [ln.strip() for ln in text.splitlines() if ln.strip()]


async def fetch_subscription(sub_url: str) -> List[VlessNode]:
    sub_url = (sub_url or "").strip()
    if not sub_url:
        raise ProxyPoolError("未配置代理订阅 URL")
    async with httpx.AsyncClient(timeout=45.0, follow_redirects=True) as client:
        r = await client.get(sub_url, headers={"User-Agent": "MiMo2API-ProxyPool/1.0"})
        if r.status_code >= 400:
            raise ProxyPoolError(f"拉取订阅失败 HTTP {r.status_code}")
        lines = decode_subscription(r.text)
    nodes: List[VlessNode] = []
    for ln in lines:
        if not ln.startswith("vless://"):
            continue
        n = parse_vless_uri(ln)
        if n:
            nodes.append(n)
    if not nodes:
        raise ProxyPoolError("订阅中未解析到 VLESS 节点")
    return nodes


def vless_to_outbound(node: VlessNode) -> dict:
    ob: Dict[str, Any] = {
        "type": "vless",
        "tag": node.tag(),
        "server": node.server,
        "server_port": node.port,
        "uuid": node.uuid,
        "packet_encoding": "xudp",
    }
    if node.flow:
        ob["flow"] = node.flow
    if (node.security or "").lower() in ("tls", "reality"):
        tls: Dict[str, Any] = {
            "enabled": True,
            "server_name": node.sni or node.host or node.server,
            "insecure": False,
        }
        if node.fp:
            tls["utls"] = {"enabled": True, "fingerprint": node.fp}
        ob["tls"] = tls
    net = (node.network or "tcp").lower()
    if net == "ws":
        transport: Dict[str, Any] = {
            "type": "ws",
            "path": node.path or "/",
        }
        if node.host:
            transport["headers"] = {"Host": node.host}
        ob["transport"] = transport
    elif net == "grpc":
        ob["transport"] = {"type": "grpc", "service_name": node.path or ""}
    return ob


def build_singbox_config(nodes: List[VlessNode], listen_port: int, selected_tag: Optional[str] = None) -> dict:
    outbounds = [vless_to_outbound(n) for n in nodes]
    tags = [o["tag"] for o in outbounds]
    if not tags:
        raise ProxyPoolError("无可用出站节点")
    # selector default
    default_tag = selected_tag if selected_tag in tags else tags[0]
    outbounds.append(
        {
            "type": "selector",
            "tag": "select",
            "outbounds": tags,
            "default": default_tag,
        }
    )
    outbounds.append({"type": "direct", "tag": "direct"})
    return {
        "log": {"level": "warn", "timestamp": True},
        "inbounds": [
            {
                "type": "mixed",
                "tag": "mixed-in",
                "listen": "127.0.0.1",
                "listen_port": listen_port,
            }
        ],
        "outbounds": outbounds,
        "route": {"final": "select"},
        "experimental": {
            "clash_api": {
                "external_controller": f"127.0.0.1:{listen_port + 1}",
                "secret": "",
            }
        },
    }


def find_singbox(explicit: str = "") -> Optional[str]:
    if explicit and Path(explicit).exists():
        return str(Path(explicit).resolve())
    env = os.getenv("SING_BOX_PATH") or os.getenv("SINGBOX_PATH")
    if env and Path(env).exists():
        return str(Path(env).resolve())
    which = shutil.which("sing-box") or shutil.which("sing-box.exe")
    if which:
        return which
    # local cache
    for name in ("sing-box.exe", "sing-box"):
        p = _BIN_DIR / name
        if p.exists():
            return str(p)
    return None


def _singbox_download_url() -> Tuple[str, str]:
    """Return (url, archive_member_hint)."""
    system = platform.system().lower()
    machine = platform.machine().lower()
    # map arch
    if machine in ("x86_64", "amd64"):
        arch = "amd64"
    elif machine in ("aarch64", "arm64"):
        arch = "arm64"
    else:
        arch = "amd64"
    # pin a recent stable-ish version
    ver = os.getenv("SING_BOX_VERSION", "1.11.7")
    if system == "windows":
        return (
            f"https://github.com/SagerNet/sing-box/releases/download/v{ver}/sing-box-{ver}-windows-{arch}.zip",
            "sing-box.exe",
        )
    if system == "darwin":
        return (
            f"https://github.com/SagerNet/sing-box/releases/download/v{ver}/sing-box-{ver}-darwin-{arch}.tar.gz",
            "sing-box",
        )
    return (
        f"https://github.com/SagerNet/sing-box/releases/download/v{ver}/sing-box-{ver}-linux-{arch}.tar.gz",
        "sing-box",
    )


async def ensure_singbox(explicit: str = "") -> str:
    path = find_singbox(explicit)
    if path:
        return path
    _BIN_DIR.mkdir(parents=True, exist_ok=True)
    url, member = _singbox_download_url()
    print(f"[ProxyPool] downloading sing-box from {url}")
    dest_zip = _BIN_DIR / "sing-box-download.bin"
    async with httpx.AsyncClient(timeout=120.0, follow_redirects=True) as client:
        r = await client.get(url)
        if r.status_code >= 400:
            raise ProxyPoolError(
                f"无法下载 sing-box HTTP {r.status_code}。请手动安装并配置 singbox_path / SING_BOX_PATH"
            )
        dest_zip.write_bytes(r.content)

    system = platform.system().lower()
    out_name = "sing-box.exe" if system == "windows" else "sing-box"
    out_path = _BIN_DIR / out_name
    try:
        if url.endswith(".zip"):
            with zipfile.ZipFile(dest_zip, "r") as zf:
                target = None
                for n in zf.namelist():
                    if n.endswith(member) or n.endswith("sing-box.exe") or n.endswith("/sing-box"):
                        target = n
                        break
                if not target:
                    raise ProxyPoolError("zip 中未找到 sing-box 可执行文件")
                data = zf.read(target)
                out_path.write_bytes(data)
        else:
            import tarfile

            with tarfile.open(dest_zip, "r:gz") as tf:
                target = None
                for m in tf.getmembers():
                    if m.name.endswith(member) or m.name.endswith("/sing-box"):
                        target = m
                        break
                if not target:
                    raise ProxyPoolError("tar 中未找到 sing-box 可执行文件")
                f = tf.extractfile(target)
                if not f:
                    raise ProxyPoolError("无法解压 sing-box")
                out_path.write_bytes(f.read())
        if system != "windows":
            out_path.chmod(0o755)
    finally:
        try:
            dest_zip.unlink(missing_ok=True)
        except Exception:
            pass
    if not out_path.exists():
        raise ProxyPoolError("sing-box 下载/解压失败")
    print(f"[ProxyPool] sing-box ready: {out_path}")
    return str(out_path)


class SingBoxProxyPool:
    """Manage subscription nodes + one local sing-box process."""

    def __init__(self) -> None:
        self._lock = threading.RLock()
        self.settings = ProxyPoolSettings()
        self.nodes: List[VlessNode] = []
        self._proc: Optional[subprocess.Popen] = None
        self._config_path = _CONFIG_DIR / "config.json"
        self._listen_port = _DEFAULT_LISTEN_PORT
        self._selected_tag: Optional[str] = None
        self._attempt = 0
        self._last_fetch = 0.0
        self._binary = ""
        self._status = "stopped"
        self._last_error = ""

    def configure(self, settings: ProxyPoolSettings) -> None:
        with self._lock:
            self.settings = settings.normalized()
            self._listen_port = self.settings.listen_port

    def proxy_url(self) -> Optional[str]:
        """SOCKS5 URL for httpx if running."""
        with self._lock:
            if not self.settings.enabled or self._status != "running":
                return None
            return f"socks5://127.0.0.1:{self._listen_port}"

    def status(self) -> dict:
        with self._lock:
            return {
                "enabled": self.settings.enabled,
                "status": self._status,
                "listen_port": self._listen_port,
                "proxy_url": self.proxy_url(),
                "node_count": len(self.nodes),
                "selected": self._selected_tag or "",
                "binary": self._binary,
                "last_error": self._last_error,
                "last_fetch": self._last_fetch,
                "sub_configured": bool(self.settings.sub_url),
                "nodes": [
                    {"name": n.name, "server": n.server, "port": n.port, "tag": n.tag()}
                    for n in self.nodes[:50]
                ],
            }

    async def refresh_nodes(self) -> List[VlessNode]:
        nodes = await fetch_subscription(self.settings.sub_url)
        with self._lock:
            self.nodes = nodes
            self._last_fetch = time.time()
        return nodes

    def _write_config(self, selected: Optional[str] = None) -> Path:
        _CONFIG_DIR.mkdir(parents=True, exist_ok=True)
        with self._lock:
            nodes = list(self.nodes)
            port = self._listen_port
            tag = selected or self._selected_tag
        cfg = build_singbox_config(nodes, port, tag)
        self._config_path.write_text(json.dumps(cfg, ensure_ascii=False, indent=2), encoding="utf-8")
        return self._config_path

    def _stop_proc(self) -> None:
        proc = self._proc
        self._proc = None
        if not proc:
            return
        try:
            proc.terminate()
            try:
                proc.wait(timeout=5)
            except subprocess.TimeoutExpired:
                proc.kill()
        except Exception:
            try:
                proc.kill()
            except Exception:
                pass
        self._status = "stopped"

    async def start(self) -> dict:
        s = self.settings.normalized()
        if not s.enabled:
            raise ProxyPoolError("代理池未启用")
        if not s.sub_url:
            raise ProxyPoolError("未配置订阅 URL")
        self.configure(s)
        try:
            await self.refresh_nodes()
        except Exception as e:
            self._last_error = str(e)
            raise
        self._binary = await ensure_singbox(s.singbox_path)
        self._listen_port = _free_port(s.listen_port)
        # pick initial node
        with self._lock:
            if self.nodes:
                self._selected_tag = random.choice(self.nodes).tag()
        self._write_config(self._selected_tag)
        self._stop_proc()
        try:
            self._proc = subprocess.Popen(
                [self._binary, "run", "-c", str(self._config_path)],
                stdout=subprocess.DEVNULL,
                stderr=subprocess.PIPE,
                cwd=str(_CONFIG_DIR),
            )
        except Exception as e:
            self._status = "error"
            self._last_error = f"启动 sing-box 失败: {e}"
            raise ProxyPoolError(self._last_error)
        # wait for port
        ok = False
        for _ in range(30):
            if self._proc.poll() is not None:
                err = ""
                try:
                    err = (self._proc.stderr.read() or b"").decode("utf-8", "replace")[:500]
                except Exception:
                    pass
                self._status = "error"
                self._last_error = f"sing-box 退出: {err or self._proc.returncode}"
                raise ProxyPoolError(self._last_error)
            try:
                with socket.create_connection(("127.0.0.1", self._listen_port), timeout=0.3):
                    ok = True
                    break
            except OSError:
                await asyncio.sleep(0.2)
        if not ok:
            self._stop_proc()
            self._status = "error"
            self._last_error = "sing-box 端口未就绪"
            raise ProxyPoolError(self._last_error)
        self._status = "running"
        self._last_error = ""
        return self.status()

    def stop(self) -> dict:
        with self._lock:
            self._stop_proc()
            self._status = "stopped"
        return self.status()

    async def rotate(self) -> dict:
        """Pick another node and reload sing-box."""
        with self._lock:
            if not self.nodes:
                raise ProxyPoolError("无节点可轮换")
            cur = self._selected_tag
            choices = [n for n in self.nodes if n.tag() != cur] or list(self.nodes)
            node = random.choice(choices)
            self._selected_tag = node.tag()
            name = node.name
        # try clash api switch first
        api_port = self._listen_port + 1
        switched = False
        try:
            async with httpx.AsyncClient(timeout=3.0) as client:
                r = await client.put(
                    f"http://127.0.0.1:{api_port}/proxies/select",
                    json={"name": self._selected_tag},
                )
                # clash API path variants
                if r.status_code >= 400:
                    r = await client.put(
                        f"http://127.0.0.1:{api_port}/proxies/select",
                        content=json.dumps({"name": self._selected_tag}),
                    )
                if r.status_code < 400:
                    switched = True
        except Exception:
            switched = False
        if not switched:
            # restart with new default
            if self._status == "running":
                self._write_config(self._selected_tag)
                self._stop_proc()
                self._proc = subprocess.Popen(
                    [self._binary or await ensure_singbox(self.settings.singbox_path), "run", "-c", str(self._config_path)],
                    stdout=subprocess.DEVNULL,
                    stderr=subprocess.DEVNULL,
                    cwd=str(_CONFIG_DIR),
                )
                for _ in range(30):
                    try:
                        with socket.create_connection(("127.0.0.1", self._listen_port), timeout=0.3):
                            self._status = "running"
                            break
                    except OSError:
                        await asyncio.sleep(0.2)
        print(f"[ProxyPool] rotated to {name} ({self._selected_tag})")
        return {**self.status(), "rotated_to": name}

    async def ensure_for_register(self) -> Optional[str]:
        """Return proxy URL if pool enabled; start/refresh as needed."""
        s = self.settings.normalized()
        if not s.enabled or not s.sub_url:
            return None
        # refresh sub if stale
        if not self.nodes or (
            s.refresh_interval > 0 and time.time() - self._last_fetch > s.refresh_interval
        ):
            try:
                await self.refresh_nodes()
            except Exception as e:
                print(f"[ProxyPool] refresh fail: {e}")
                if not self.nodes:
                    raise
        if self._status != "running" or not self._proc or self._proc.poll() is not None:
            await self.start()
        # rotate policy
        self._attempt += 1
        if self._attempt > 1 and (self._attempt - 1) % s.rotate_every == 0:
            try:
                await self.rotate()
            except Exception as e:
                print(f"[ProxyPool] rotate fail: {e}")
        return self.proxy_url()


# global singleton
proxy_pool = SingBoxProxyPool()
