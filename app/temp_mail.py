"""Cloudflare Temp Email (dreamhunter2333) client.

Config is provided by the user via admin UI / config.json — nothing is hardcoded.
API base example: https://apimail.example.com
Admin auth header: x-admin-auth
Address JWT: Authorization: Bearer <jwt>
"""

from __future__ import annotations

import asyncio
import random
import re
import string
import time
from dataclasses import dataclass
from typing import Any, Dict, List, Optional

import httpx


class TempMailError(Exception):
    def __init__(self, message: str, data: Optional[dict] = None):
        super().__init__(message)
        self.data = data or {}


@dataclass
class TempMailConfig:
    api_base: str = ""
    admin_password: str = ""
    domain: str = ""  # empty = first domain from open_api/settings
    # optional site password if deployment uses x-custom-auth
    site_password: str = ""

    def normalized_base(self) -> str:
        return (self.api_base or "").strip().rstrip("/")

    def is_configured(self) -> bool:
        return bool(self.normalized_base() and self.admin_password)


@dataclass
class TempAddress:
    address: str
    jwt: str
    address_id: Any = None
    password: Optional[str] = None


def _headers(cfg: TempMailConfig, *, admin: bool = False, jwt: str = "") -> Dict[str, str]:
    h: Dict[str, str] = {"Accept": "application/json", "Content-Type": "application/json"}
    if cfg.site_password:
        h["x-custom-auth"] = cfg.site_password
    if admin and cfg.admin_password:
        h["x-admin-auth"] = cfg.admin_password
    if jwt:
        h["Authorization"] = f"Bearer {jwt}"
    return h


async def fetch_open_settings(cfg: TempMailConfig) -> dict:
    base = cfg.normalized_base()
    if not base:
        raise TempMailError("未配置临时邮箱 API 地址")
    async with httpx.AsyncClient(timeout=20.0) as client:
        r = await client.get(f"{base}/open_api/settings", headers=_headers(cfg))
        if r.status_code >= 400:
            raise TempMailError(f"读取邮箱配置失败 HTTP {r.status_code}", {"body": r.text[:300]})
        return r.json()


async def list_domains(cfg: TempMailConfig) -> List[str]:
    settings = await fetch_open_settings(cfg)
    domains = settings.get("domains") or settings.get("defaultDomains") or []
    return [str(d) for d in domains if d]


def _random_local_part(length: int = 10) -> str:
    alphabet = string.ascii_lowercase + string.digits
    # avoid starting with digit
    first = random.choice(string.ascii_lowercase)
    rest = "".join(random.choice(alphabet) for _ in range(max(1, length - 1)))
    return first + rest


async def resolve_domain(
    cfg: TempMailConfig,
    preferred: Optional[str] = None,
    *,
    random_pick: bool = True,
) -> str:
    """Pick a mailbox domain. Prefer API open_api/settings; user domain is optional override only."""
    preferred = (preferred or "").strip()
    domains = await list_domains(cfg)
    if not domains:
        # fall back to configured domain if settings empty
        if (cfg.domain or "").strip():
            return cfg.domain.strip()
        if preferred:
            return preferred
        raise TempMailError("临时邮箱未返回可用域名，请检查 API 地址与管理口令")
    if preferred and preferred in domains:
        return preferred
    # ignore stale/wrong preferred not in list — auto pick
    if random_pick and len(domains) > 1:
        return random.choice(domains)
    return domains[0]


async def create_address(
    cfg: TempMailConfig,
    *,
    name: Optional[str] = None,
    domain: Optional[str] = None,
) -> TempAddress:
    if not cfg.is_configured():
        raise TempMailError("请先在管理面板配置临时邮箱 API 与管理口令")

    base = cfg.normalized_base()
    # Auto-fetch domains from provider; do not require user to type domain
    domain = await resolve_domain(cfg, preferred=domain or cfg.domain, random_pick=True)

    name = (name or _random_local_part()).strip().lower()
    payload = {"name": name, "domain": domain}

    async with httpx.AsyncClient(timeout=30.0) as client:
        r = await client.post(
            f"{base}/admin/new_address",
            headers=_headers(cfg, admin=True),
            json=payload,
        )
        if r.status_code >= 400:
            raise TempMailError(
                f"创建临时邮箱失败 HTTP {r.status_code}: {r.text[:200]}",
                {"status": r.status_code, "body": r.text[:300]},
            )
        data = r.json()

    jwt = data.get("jwt") or ""
    address = data.get("address") or f"{name}@{domain}"
    if not jwt:
        raise TempMailError("创建邮箱成功但未返回 JWT", data if isinstance(data, dict) else {})
    return TempAddress(
        address=address,
        jwt=jwt,
        address_id=data.get("address_id"),
        password=data.get("password"),
    )


async def get_settings(cfg: TempMailConfig, jwt: str) -> dict:
    base = cfg.normalized_base()
    async with httpx.AsyncClient(timeout=20.0) as client:
        r = await client.get(f"{base}/api/settings", headers=_headers(cfg, jwt=jwt))
        if r.status_code >= 400:
            raise TempMailError(f"邮箱 JWT 无效 HTTP {r.status_code}", {"body": r.text[:200]})
        return r.json()


async def list_parsed_mails(
    cfg: TempMailConfig,
    jwt: str,
    *,
    limit: int = 20,
    offset: int = 0,
) -> List[dict]:
    base = cfg.normalized_base()
    async with httpx.AsyncClient(timeout=20.0) as client:
        r = await client.get(
            f"{base}/api/parsed_mails",
            params={"limit": max(1, min(100, limit)), "offset": max(0, offset)},
            headers=_headers(cfg, jwt=jwt),
        )
        if r.status_code == 404:
            # older deployment: fall back to raw mails
            r2 = await client.get(
                f"{base}/api/mails",
                params={"limit": max(1, min(100, limit)), "offset": max(0, offset)},
                headers=_headers(cfg, jwt=jwt),
            )
            if r2.status_code >= 400:
                raise TempMailError(f"读取邮件失败 HTTP {r2.status_code}", {"body": r2.text[:200]})
            data = r2.json()
            return list(data.get("results") or data.get("mails") or [])
        if r.status_code >= 400:
            raise TempMailError(f"读取邮件失败 HTTP {r.status_code}", {"body": r.text[:200]})
        data = r.json()
        return list(data.get("results") or [])


_CODE_RE = re.compile(
    r"(?<![A-Za-z0-9])(\d{4,8})(?![A-Za-z0-9])"
)


def extract_code_from_mail(mail: dict) -> Optional[str]:
    """Extract a 4–8 digit verification code from parsed/raw mail fields."""
    parts = [
        str(mail.get("subject") or ""),
        str(mail.get("text") or ""),
        str(mail.get("html") or ""),
        str(mail.get("raw") or ""),
        str(mail.get("source") or ""),
    ]
    blob = "\n".join(parts)
    # prefer Xiaomi-ish context
    for pattern in (
        r"(?:验证码|verification code|code is|code:|码为|码是)[^\d]{0,20}(\d{4,8})",
        r"(?:安全验证|security)[^\d]{0,40}(\d{4,8})",
    ):
        m = re.search(pattern, blob, re.I)
        if m:
            return m.group(1)
    # fallback: first 6-digit then 4-8 digit
    m6 = re.search(r"(?<![A-Za-z0-9])(\d{6})(?![A-Za-z0-9])", blob)
    if m6:
        return m6.group(1)
    m = _CODE_RE.search(blob)
    return m.group(1) if m else None


async def wait_for_code(
    cfg: TempMailConfig,
    jwt: str,
    *,
    timeout: float = 120.0,
    poll_interval: float = 3.0,
    since_ts: Optional[float] = None,
    seen_ids: Optional[set] = None,
) -> str:
    """Poll inbox until a verification code appears."""
    deadline = time.time() + timeout
    seen = seen_ids if seen_ids is not None else set()
    interval = max(1.0, poll_interval)
    last_err = ""

    while time.time() < deadline:
        try:
            mails = await list_parsed_mails(cfg, jwt, limit=15, offset=0)
            for mail in mails:
                mid = mail.get("id") or mail.get("message_id") or id(mail)
                if mid in seen:
                    continue
                # optionally ignore mails older than since_ts if created_at present
                created = mail.get("created_at") or ""
                code = extract_code_from_mail(mail)
                if code:
                    seen.add(mid)
                    return code
                seen.add(mid)
        except TempMailError as e:
            last_err = str(e)
        await asyncio.sleep(interval)
        interval = min(10.0, interval * 1.2)

    raise TempMailError(
        f"等待邮箱验证码超时（{int(timeout)}s）" + (f": {last_err}" if last_err else "")
    )


async def test_connection(cfg: TempMailConfig) -> Dict[str, Any]:
    """Smoke-test temp mail config: open settings + optional admin create dry-run domains."""
    if not cfg.normalized_base():
        return {"ok": False, "error": "请填写 API 地址"}
    try:
        settings = await fetch_open_settings(cfg)
        domains = settings.get("domains") or settings.get("defaultDomains") or []
        result: Dict[str, Any] = {
            "ok": True,
            "version": settings.get("version"),
            "domains": domains,
            "need_auth": settings.get("needAuth"),
            "enable_user_create": settings.get("enableUserCreateEmail"),
        }
        if cfg.admin_password:
            # auto domain from API list — no need for user-filled domain
            addr = await create_address(cfg, domain=None)
            info = await get_settings(cfg, addr.jwt)
            result["test_address"] = addr.address
            result["auto_domain"] = addr.address.split("@")[-1] if "@" in addr.address else ""
            result["test_jwt_ok"] = bool(info.get("address"))
            result["message"] = (
                f"连接成功，已自动选域并创建测试邮箱 {addr.address}"
                + (f"（可用域名: {', '.join(map(str, domains))}）" if domains else "")
            )
        else:
            result["message"] = "已读取 open_api/settings（未配置管理口令，跳过创建测试）"
        return result
    except Exception as e:
        return {"ok": False, "error": str(e)[:300]}
