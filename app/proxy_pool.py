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


def _writable_root() -> Path:
    """Prefer project dir; fall back to /tmp for read-only container FS."""
    candidates = []
    env = os.getenv("MIMO2API_DATA_DIR")
    if env:
        candidates.append(Path(env))
    candidates.append(Path(__file__).resolve().parent.parent)
    candidates.append(Path("/tmp") / "mimo2api")
    candidates.append(Path(os.getenv("TMPDIR") or os.getenv("TEMP") or "/tmp") / "mimo2api")
    for base in candidates:
        try:
            base.mkdir(parents=True, exist_ok=True)
            probe = base / ".write_test"
            probe.write_text("ok", encoding="utf-8")
            probe.unlink(missing_ok=True)
            return base
        except Exception:
            continue
    return Path("/tmp") / "mimo2api"


def _bin_dir() -> Path:
    p = _writable_root() / ".bin"
    p.mkdir(parents=True, exist_ok=True)
    return p


def _config_dir() -> Path:
    p = _writable_root() / ".singbox"
    p.mkdir(parents=True, exist_ok=True)
    return p


_DEFAULT_LISTEN_PORT = 17890


@dataclass
class ProxyPoolSettings:
    enabled: bool = False
    sub_url: str = ""
    # local mixed inbound port for sing-box
    listen_port: int = _DEFAULT_LISTEN_PORT
    # path to sing-box binary; empty = auto find / download
    singbox_path: str = ""
    # rotate outbound every N register attempts (1 = every attempt) — legacy; per-register always random
    rotate_every: int = 1
    # auto refresh subscription seconds (0 = only on start/manual)
    refresh_interval: int = 3600
    # each register: refresh sub + random node; on fail switch node up to N times
    connect_retries: int = 5
    # always re-fetch subscription before each register acquire
    fetch_sub_each_time: bool = True

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
            connect_retries=max(1, min(20, int(self.connect_retries or 5))),
            fetch_sub_each_time=bool(self.fetch_sub_each_time),
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
    # local cache (writable root)
    for name in ("sing-box.exe", "sing-box"):
        p = _bin_dir() / name
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
    bin_dir = _bin_dir()
    url, member = _singbox_download_url()
    print(f"[ProxyPool] downloading sing-box from {url} → {bin_dir}")
    dest_zip = bin_dir / "sing-box-download.bin"
    async with httpx.AsyncClient(timeout=120.0, follow_redirects=True) as client:
        r = await client.get(url)
        if r.status_code >= 400:
            raise ProxyPoolError(
                f"无法下载 sing-box HTTP {r.status_code}。请手动安装并配置 singbox_path / SING_BOX_PATH"
            )
        dest_zip.write_bytes(r.content)

    system = platform.system().lower()
    out_name = "sing-box.exe" if system == "windows" else "sing-box"
    out_path = bin_dir / out_name
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


def _pid_file() -> Path:
    return _config_dir() / "sing-box.pid"


def _kill_pid(pid: int, *, force: bool = False) -> bool:
    """Terminate a process by pid. Returns True if signal/kill was sent or already gone."""
    if pid <= 0:
        return False
    try:
        if platform.system().lower() == "windows":
            # /T kills child tree
            flags = ["/F", "/T", "/PID", str(pid)] if force else ["/T", "/PID", str(pid)]
            subprocess.run(
                ["taskkill", *flags],
                stdout=subprocess.DEVNULL,
                stderr=subprocess.DEVNULL,
                check=False,
            )
            return True
        import signal

        try:
            os.kill(pid, signal.SIGKILL if force else signal.SIGTERM)
        except ProcessLookupError:
            return True
        return True
    except Exception as e:
        print(f"[ProxyPool] kill pid={pid} failed: {e}")
        return False


def _pid_alive(pid: int) -> bool:
    if pid <= 0:
        return False
    try:
        if platform.system().lower() == "windows":
            out = subprocess.run(
                ["tasklist", "/FI", f"PID eq {pid}", "/NH"],
                capture_output=True,
                text=True,
                check=False,
            )
            return str(pid) in (out.stdout or "")
        os.kill(pid, 0)
        return True
    except Exception:
        return False


def _pids_listening_on_port(port: int) -> List[int]:
    """Best-effort find PIDs bound to local TCP port."""
    pids: List[int] = []
    system = platform.system().lower()
    try:
        if system == "windows":
            out = subprocess.run(
                ["netstat", "-ano", "-p", "tcp"],
                capture_output=True,
                text=True,
                check=False,
            )
            for line in (out.stdout or "").splitlines():
                #  TCP    127.0.0.1:17890    ... LISTENING    1234
                if f":{port}" not in line or "LISTENING" not in line.upper():
                    continue
                parts = line.split()
                if not parts:
                    continue
                try:
                    pid = int(parts[-1])
                except Exception:
                    continue
                if pid > 0 and pid not in pids:
                    pids.append(pid)
        else:
            # ss -ltnp 'sport = :17890'
            out = subprocess.run(
                ["ss", "-ltnp", f"sport = :{port}"],
                capture_output=True,
                text=True,
                check=False,
            )
            import re as _re

            for m in _re.finditer(r"pid=(\d+)", out.stdout or ""):
                pid = int(m.group(1))
                if pid not in pids:
                    pids.append(pid)
            if not pids:
                out2 = subprocess.run(
                    ["lsof", f"-iTCP:{port}", "-sTCP:LISTEN", "-t"],
                    capture_output=True,
                    text=True,
                    check=False,
                )
                for line in (out2.stdout or "").splitlines():
                    try:
                        pid = int(line.strip())
                    except Exception:
                        continue
                    if pid not in pids:
                        pids.append(pid)
    except Exception as e:
        print(f"[ProxyPool] port scan failed: {e}")
    return pids


def _pids_matching_singbox_config(config_path: Path) -> List[int]:
    """Find sing-box processes started with our config path (orphans)."""
    pids: List[int] = []
    cfg = str(config_path).replace("\\", "/").lower()
    system = platform.system().lower()
    try:
        if system == "windows":
            # wmic may be unavailable; use powershell
            ps = (
                "Get-CimInstance Win32_Process -Filter \"Name='sing-box.exe'\" | "
                "Select-Object ProcessId,CommandLine | ConvertTo-Json -Compress"
            )
            out = subprocess.run(
                ["powershell", "-NoProfile", "-Command", ps],
                capture_output=True,
                text=True,
                check=False,
                timeout=15,
            )
            raw = (out.stdout or "").strip()
            if not raw:
                return pids
            import json as _json

            data = _json.loads(raw)
            if isinstance(data, dict):
                data = [data]
            for item in data or []:
                cmd = str(item.get("CommandLine") or "").replace("\\", "/").lower()
                pid = int(item.get("ProcessId") or 0)
                if pid > 0 and ("sing-box" in cmd) and (cfg in cmd or "config.json" in cmd):
                    pids.append(pid)
        else:
            out = subprocess.run(
                ["pgrep", "-af", "sing-box"],
                capture_output=True,
                text=True,
                check=False,
            )
            for line in (out.stdout or "").splitlines():
                if "sing-box" not in line:
                    continue
                if str(config_path) not in line and "config.json" not in line:
                    # still reclaim any sing-box run under our config dir
                    if str(_config_dir()) not in line:
                        continue
                try:
                    pid = int(line.split(None, 1)[0])
                except Exception:
                    continue
                pids.append(pid)
    except Exception as e:
        print(f"[ProxyPool] process scan failed: {e}")
    return pids


class SingBoxProxyPool:
    """Manage subscription nodes + one local sing-box process (singleton lifecycle)."""

    def __init__(self) -> None:
        self._lock = threading.RLock()
        self.settings = ProxyPoolSettings()
        self.nodes: List[VlessNode] = []
        self._proc: Optional[subprocess.Popen] = None
        self._config_path = _config_dir() / "config.json"
        self._listen_port = _DEFAULT_LISTEN_PORT
        self._selected_tag: Optional[str] = None
        self._attempt = 0
        self._last_fetch = 0.0
        self._binary = ""
        self._status = "stopped"
        self._last_error = ""
        self._last_used = 0.0
        # reclaim orphans left by previous process crash
        try:
            self.reclaim_all(reason="init")
        except Exception as e:
            print(f"[ProxyPool] init reclaim: {e}")

    def configure(self, settings: ProxyPoolSettings) -> None:
        with self._lock:
            self.settings = settings.normalized()
            self._listen_port = self.settings.listen_port

    def proxy_url(self) -> Optional[str]:
        """HTTP mixed inbound URL for httpx if running."""
        with self._lock:
            if not self.settings.enabled or self._status != "running":
                return None
            return f"http://127.0.0.1:{self._listen_port}"

    def status(self) -> dict:
        with self._lock:
            pid = None
            if self._proc and self._proc.poll() is None:
                pid = self._proc.pid
            return {
                "enabled": self.settings.enabled,
                "status": self._status,
                "listen_port": self._listen_port,
                "proxy_url": self.proxy_url(),
                "pid": pid,
                "node_count": len(self.nodes),
                "selected": self._selected_tag or "",
                "binary": self._binary,
                "last_error": self._last_error,
                "last_fetch": self._last_fetch,
                "last_used": self._last_used,
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
        cfg_dir = _config_dir()
        self._config_path = cfg_dir / "config.json"
        with self._lock:
            nodes = list(self.nodes)
            port = self._listen_port
            tag = selected or self._selected_tag
        cfg = build_singbox_config(nodes, port, tag)
        self._config_path.write_text(json.dumps(cfg, ensure_ascii=False, indent=2), encoding="utf-8")
        return self._config_path

    def _write_pid(self, pid: int) -> None:
        try:
            _pid_file().write_text(str(pid), encoding="utf-8")
        except Exception as e:
            print(f"[ProxyPool] write pid file failed: {e}")

    def _read_pid_file(self) -> Optional[int]:
        try:
            p = _pid_file()
            if not p.exists():
                return None
            return int(p.read_text(encoding="utf-8").strip())
        except Exception:
            return None

    def _clear_pid_file(self) -> None:
        try:
            _pid_file().unlink(missing_ok=True)
        except Exception:
            pass

    def reclaim_all(self, *, reason: str = "", ports: Optional[List[int]] = None) -> dict:
        """Kill tracked process, pid-file process, port holders, and orphan sing-box."""
        killed: List[int] = []
        with self._lock:
            port = self._listen_port
            cfg = self._config_path
            proc = self._proc
            self._proc = None

        # 1) managed Popen
        if proc is not None:
            pid = proc.pid
            try:
                proc.terminate()
                try:
                    proc.wait(timeout=4)
                except subprocess.TimeoutExpired:
                    proc.kill()
                    proc.wait(timeout=3)
            except Exception:
                _kill_pid(pid, force=True)
            killed.append(pid)

        # 2) pid file
        fpid = self._read_pid_file()
        if fpid and _pid_alive(fpid):
            _kill_pid(fpid, force=False)
            time.sleep(0.3)
            if _pid_alive(fpid):
                _kill_pid(fpid, force=True)
            killed.append(fpid)
        self._clear_pid_file()

        # 3) anything listening on our ports (mixed + clash api)
        scan_ports = ports or [port, port + 1]
        for p in scan_ports:
            for pid in _pids_listening_on_port(p):
                if pid not in killed:
                    _kill_pid(pid, force=True)
                    killed.append(pid)

        # 4) orphans matching our config
        for pid in _pids_matching_singbox_config(cfg):
            if pid not in killed and _pid_alive(pid):
                _kill_pid(pid, force=True)
                killed.append(pid)

        # brief wait for OS to release ports
        time.sleep(0.4)
        with self._lock:
            self._status = "stopped"
            self._last_error = ""
        uniq = sorted(set(killed))
        if uniq:
            print(f"[ProxyPool] reclaimed pids={uniq} reason={reason or '-'}")
        return {"killed": uniq, "reason": reason}

    def _stop_proc(self) -> None:
        """Stop managed instance and reclaim leftovers."""
        self.reclaim_all(reason="stop")

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

        # Always reclaim before spawn — never leave multiple sing-box copies
        self.reclaim_all(reason="before-start", ports=[s.listen_port, s.listen_port + 1])
        self._listen_port = _free_port(s.listen_port)

        with self._lock:
            if self.nodes:
                self._selected_tag = random.choice(self.nodes).tag()
        self._write_config(self._selected_tag)

        try:
            # new session so we can kill the process group on Unix
            kwargs: Dict[str, Any] = {
                "stdout": subprocess.DEVNULL,
                "stderr": subprocess.PIPE,
                "cwd": str(_config_dir()),
            }
            if platform.system().lower() != "windows":
                kwargs["start_new_session"] = True  # own process group
            else:
                kwargs["creationflags"] = getattr(subprocess, "CREATE_NEW_PROCESS_GROUP", 0)

            self._proc = subprocess.Popen(
                [self._binary, "run", "-c", str(self._config_path)],
                **kwargs,
            )
        except Exception as e:
            self._status = "error"
            self._last_error = f"启动 sing-box 失败: {e}"
            self.reclaim_all(reason="start-failed")
            raise ProxyPoolError(self._last_error)

        self._write_pid(self._proc.pid)

        ok = False
        for _ in range(40):
            if self._proc.poll() is not None:
                err = ""
                try:
                    err = (self._proc.stderr.read() or b"").decode("utf-8", "replace")[:500]
                except Exception:
                    pass
                self._status = "error"
                self._last_error = f"sing-box 退出: {err or self._proc.returncode}"
                self.reclaim_all(reason="start-exit")
                raise ProxyPoolError(self._last_error)
            try:
                with socket.create_connection(("127.0.0.1", self._listen_port), timeout=0.3):
                    ok = True
                    break
            except OSError:
                await asyncio.sleep(0.15)
        if not ok:
            self._last_error = "sing-box 端口未就绪"
            self.reclaim_all(reason="port-timeout")
            self._status = "error"
            raise ProxyPoolError(self._last_error)
        self._status = "running"
        self._last_error = ""
        self._last_used = time.time()
        print(f"[ProxyPool] started pid={self._proc.pid} port={self._listen_port}")
        return self.status()

    def stop(self) -> dict:
        """Public stop + full reclaim."""
        with self._lock:
            self.reclaim_all(reason="user-stop")
            self._status = "stopped"
        return self.status()

    def shutdown(self) -> dict:
        """App shutdown hook — must not leave orphan sing-box."""
        return self.reclaim_all(reason="app-shutdown")

    def _pick_random_node(self, exclude: Optional[set] = None) -> VlessNode:
        exclude = exclude or set()
        with self._lock:
            pool = [n for n in self.nodes if n.tag() not in exclude]
            if not pool:
                pool = list(self.nodes)
            if not pool:
                raise ProxyPoolError("代理池为空")
            return random.choice(pool)

    async def _wait_local_port(self, timeout: float = 6.0) -> bool:
        deadline = time.time() + timeout
        while time.time() < deadline:
            if self._proc and self._proc.poll() is not None:
                return False
            try:
                with socket.create_connection(("127.0.0.1", self._listen_port), timeout=0.25):
                    return True
            except OSError:
                await asyncio.sleep(0.15)
        return False

    async def _select_node_tag(self, tag: str) -> bool:
        """Switch selector outbound to tag via Clash API; fallback restart."""
        with self._lock:
            self._selected_tag = tag
            name = next((n.name for n in self.nodes if n.tag() == tag), tag)
        api_port = self._listen_port + 1
        switched = False
        try:
            async with httpx.AsyncClient(timeout=4.0) as client:
                # Clash API: PUT /proxies/{selector_group} body {"name": outbound_tag}
                for group in ("select", "SELECT", "GLOBAL"):
                    try:
                        r = await client.put(
                            f"http://127.0.0.1:{api_port}/proxies/{group}",
                            json={"name": tag},
                        )
                        if r.status_code < 400:
                            switched = True
                            break
                    except Exception:
                        continue
        except Exception:
            switched = False

        if not switched:
            self._write_config(tag)
            # full reclaim then single new instance (no multi-copy)
            self.reclaim_all(reason="select-restart", ports=[self._listen_port, self._listen_port + 1])
            binary = self._binary or await ensure_singbox(self.settings.singbox_path)
            self._binary = binary
            kwargs: Dict[str, Any] = {
                "stdout": subprocess.DEVNULL,
                "stderr": subprocess.DEVNULL,
                "cwd": str(_config_dir()),
            }
            if platform.system().lower() != "windows":
                kwargs["start_new_session"] = True
            else:
                kwargs["creationflags"] = getattr(subprocess, "CREATE_NEW_PROCESS_GROUP", 0)
            self._proc = subprocess.Popen(
                [binary, "run", "-c", str(self._config_path)],
                **kwargs,
            )
            self._write_pid(self._proc.pid)
            ok = await self._wait_local_port(8.0)
            self._status = "running" if ok else "error"
            if not ok:
                self._last_error = "切换节点后 sing-box 未就绪"
                self.reclaim_all(reason="select-port-fail")
                return False
        print(f"[ProxyPool] selected {name} ({tag})")
        self._last_used = time.time()
        return True

    async def rotate(self) -> dict:
        """Pick another random node and switch."""
        with self._lock:
            if not self.nodes:
                raise ProxyPoolError("无节点可轮换")
            cur = self._selected_tag
        node = self._pick_random_node(exclude={cur} if cur else set())
        ok = await self._select_node_tag(node.tag())
        if not ok:
            raise ProxyPoolError(self._last_error or "切换节点失败")
        return {**self.status(), "rotated_to": node.name}

    async def probe_proxy(self, proxy_url: Optional[str] = None, timeout: float = 12.0) -> Tuple[bool, str]:
        """Probe egress via local mixed proxy. Returns (ok, detail)."""
        url = proxy_url or self.proxy_url()
        if not url:
            return False, "proxy not running"
        # prefer http:// for mixed inbound (more reliable than socks without socksio)
        http_url = url.replace("socks5://", "http://").replace("socks5h://", "http://")
        try:
            async with httpx.AsyncClient(
                timeout=timeout,
                proxy=http_url,
                follow_redirects=True,
            ) as client:
                # Xiaomi account + generic IP
                try:
                    r = await client.get(
                        "https://account.xiaomi.com/pass/serviceLogin",
                        headers={"User-Agent": "Mozilla/5.0"},
                    )
                    if r.status_code < 500:
                        return True, f"xiaomi HTTP {r.status_code}"
                except Exception as e1:
                    pass
                r2 = await client.get("https://api.ipify.org?format=json")
                if r2.status_code < 400:
                    return True, r2.text[:120]
                return False, f"ipify HTTP {r2.status_code}"
        except TypeError:
            try:
                async with httpx.AsyncClient(
                    timeout=timeout,
                    proxies=http_url,
                    follow_redirects=True,
                ) as client:
                    r2 = await client.get("https://api.ipify.org?format=json")
                    if r2.status_code < 400:
                        return True, r2.text[:120]
                    return False, f"ipify HTTP {r2.status_code}"
            except Exception as e:
                return False, str(e)[:200]
        except Exception as e:
            return False, str(e)[:200]

    async def ensure_for_register(self) -> Optional[str]:
        """Per register: fetch sub (optional), random node, probe, retry other nodes.

        Returns socks/http proxy URL when ready, else raises ProxyPoolError.
        """
        s = self.settings.normalized()
        if not s.enabled or not s.sub_url:
            return None

        # every register: re-fetch subscription when configured
        if s.fetch_sub_each_time or not self.nodes:
            try:
                await self.refresh_nodes()
            except Exception as e:
                print(f"[ProxyPool] refresh fail: {e}")
                if not self.nodes:
                    raise ProxyPoolError(f"拉取代理订阅失败: {e}")
        elif s.refresh_interval > 0 and time.time() - self._last_fetch > s.refresh_interval:
            try:
                await self.refresh_nodes()
            except Exception as e:
                print(f"[ProxyPool] stale refresh fail: {e}")

        if self._status != "running" or not self._proc or self._proc.poll() is not None:
            await self.start()

        tried: set = set()
        last_err = ""
        max_try = min(s.connect_retries, max(1, len(self.nodes)))
        for i in range(max_try):
            node = self._pick_random_node(exclude=tried)
            tried.add(node.tag())
            ok_sel = await self._select_node_tag(node.tag())
            if not ok_sel:
                last_err = self._last_error or "select failed"
                print(f"[ProxyPool] select fail {node.name}: {last_err}")
                continue
            # give selector a moment
            await asyncio.sleep(0.3)
            proxy = self.proxy_url()
            # use http mixed URL for probe/client reliability
            http_proxy = f"http://127.0.0.1:{self._listen_port}"
            ok, detail = await self.probe_proxy(http_proxy)
            if ok:
                print(f"[ProxyPool] register acquire ok node={node.name} detail={detail}")
                self._attempt += 1
                self._last_used = time.time()
                # prefer http:// for httpx (mixed inbound)
                return http_proxy
            last_err = detail
            print(f"[ProxyPool] node unreachable {node.name}: {detail}, try another ({i+1}/{max_try})")

        raise ProxyPoolError(
            f"代理节点均不可用（已试 {len(tried)} 个）: {last_err}"
        )


# global singleton
proxy_pool = SingBoxProxyPool()


def _atexit_cleanup() -> None:
    try:
        proxy_pool.shutdown()
    except Exception as e:
        print(f"[ProxyPool] atexit cleanup: {e}")


import atexit as _atexit

_atexit.register(_atexit_cleanup)
