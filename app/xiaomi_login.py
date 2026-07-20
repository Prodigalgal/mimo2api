"""Xiaomi / MiMo pure-API login and token refresh.

Flow (no browser):
1. serviceLogin + serviceLoginAuth2 (email + MD5(password))
2. Optional identity email OTP when securityStatus=16
3. Exchange passToken for aistudio serviceToken via signed STS callback

Auto-renew uses passToken only (never password, never mail code).
Mail OTP is never auto-sent: user must click send, then submit the code.
"""

from __future__ import annotations

import hashlib
import re
import time
import uuid
from dataclasses import dataclass, field, asdict
from typing import Any, Dict, List, Optional, Tuple
from urllib.parse import parse_qs, urlparse

import httpx

SID = "xiaomichatbot"
AISTUDIO = "https://aistudio.xiaomimimo.com"
ACCOUNT = "https://account.xiaomi.com"
UA = (
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
    "AppleWebKit/537.36 (KHTML, like Gecko) "
    "Chrome/150.0.0.0 Safari/537.36"
)

# In-memory pending OTP sessions (import flow). Key = session_id.
_PENDING: Dict[str, "PendingLogin"] = {}


class XiaomiLoginError(Exception):
    def __init__(self, message: str, code: Optional[int] = None, data: Optional[dict] = None):
        super().__init__(message)
        self.code = code
        self.data = data or {}


@dataclass
class MiMoTokens:
    service_token: str
    user_id: str
    xiaomichatbot_ph: str
    pass_token: str = ""
    c_user_id: str = ""
    device_id: str = ""
    email: str = ""

    def to_dict(self) -> dict:
        return asdict(self)


@dataclass
class PendingLogin:
    session_id: str
    email: str
    password: str
    device_id: str
    context: str
    ref: str
    notif: str
    cookies: List[dict] = field(default_factory=list)
    created_at: float = field(default_factory=time.time)
    otp_sent: bool = False
    flag: int = 8

    def to_public(self) -> dict:
        if self.otp_sent:
            msg = "验证码已发送，请查收安全邮箱并填写 6 位验证码（不会自动重试发码）"
        else:
            msg = "需要邮箱二次验证。请点击「发送验证码」，收到后再填写提交（系统不会自动发码）"
        return {
            "session_id": self.session_id,
            "email": self.email,
            "need_otp": True,
            "otp_channel": "email",
            "otp_sent": self.otp_sent,
            "message": msg,
        }


def _strip_json(text: str) -> dict:
    import json as _json

    if not text:
        return {}
    if text.startswith("&&&START&&&"):
        text = text[11:]
    try:
        return _json.loads(text)
    except Exception:
        return {"_raw": text[:500]}


def _parse_set_cookie(header: str) -> Optional[Tuple[str, str]]:
    """Parse one Set-Cookie header (supports Version=1 quoted values)."""
    pattern = r'\s*([^=\s]+)=("(?:\\.|[^"\\])*"|[^;]*)'
    m = re.match(pattern, header)
    if not m:
        return None
    name, val = m.group(1), m.group(2)
    if len(val) >= 2 and val[0] == '"' and val[-1] == '"':
        val = val[1:-1]
    if val in ("", "EXPIRED"):
        return None
    return name, val


def _new_device_id() -> str:
    return "wb" + hashlib.md5(f"{time.time()}-{uuid.uuid4()}".encode()).hexdigest()[:12]


def _password_hash(password: str) -> str:
    return hashlib.md5(password.encode("utf-8")).hexdigest().upper()


def _client(device_id: str, cookies: Optional[List[dict]] = None) -> httpx.AsyncClient:
    c = httpx.AsyncClient(
        follow_redirects=False,
        timeout=30.0,
        headers={
            "User-Agent": UA,
            "Accept-Language": "zh-CN,zh;q=0.9",
            "Accept": "application/json, text/plain, */*",
        },
    )
    for domain in ("xiaomi.com", "account.xiaomi.com", "mi.com"):
        c.cookies.set("sdkVersion", "accountsdk-18.8.15", domain=domain)
        c.cookies.set("deviceId", device_id, domain=domain)
    if cookies:
        for item in cookies:
            try:
                domain = (item.get("domain") or "account.xiaomi.com").lstrip(".")
                c.cookies.set(
                    item["name"],
                    item["value"],
                    domain=domain,
                    path=item.get("path") or "/",
                )
            except Exception:
                pass
    return c


def _dump_cookies(client: httpx.AsyncClient) -> List[dict]:
    out = []
    for cookie in client.cookies.jar:
        out.append(
            {
                "name": cookie.name,
                "value": cookie.value,
                "domain": cookie.domain or "",
                "path": cookie.path or "/",
            }
        )
    return out


def _set_account_cookies(
    client: httpx.AsyncClient,
    *,
    device_id: str,
    pass_token: str = "",
    user_id: str = "",
    c_user_id: str = "",
) -> None:
    for domain in ("xiaomi.com", "account.xiaomi.com"):
        client.cookies.set("sdkVersion", "accountsdk-18.8.15", domain=domain)
        client.cookies.set("deviceId", device_id, domain=domain)
        if pass_token:
            client.cookies.set("passToken", pass_token, domain=domain)
        if user_id:
            client.cookies.set("userId", user_id, domain=domain)
        if c_user_id:
            client.cookies.set("cUserId", c_user_id, domain=domain)


async def _auth2(client: httpx.AsyncClient, email: str, password: str) -> dict:
    r = await client.get(f"{ACCOUNT}/pass/serviceLogin", params={"sid": SID, "_json": "true"})
    data = _strip_json(r.text)
    if not data.get("_sign") and data.get("code") not in (0, 70016):
        # 70016 = not logged in, still provides _sign
        pass
    sign = data.get("_sign")
    if not sign and data.get("location") and data.get("userId"):
        # already logged in via cookies
        return data

    fields = {
        "bizDeviceType": "",
        "needTheme": "false",
        "theme": "",
        "showActiveX": "false",
        "serviceParam": data.get("serviceParam") or "",
        "callback": data.get("callback") or f"{AISTUDIO}/sts",
        "qs": data.get("qs") or "%3Fsid%3Dxiaomichatbot%26_json%3Dtrue",
        "sid": SID,
        "_sign": sign or "",
        "user": email,
        "cc": "+86",
        "hash": _password_hash(password),
        "_json": "true",
        "policyName": "miaccount",
        "captCode": "",
    }
    r2 = await client.post(
        f"{ACCOUNT}/pass/serviceLoginAuth2",
        data=fields,
        headers={
            "Content-Type": "application/x-www-form-urlencoded; charset=UTF-8",
            "Origin": ACCOUNT,
            "Referer": f"{ACCOUNT}/fe/service/login/password",
            "X-Requested-With": "XMLHttpRequest",
        },
    )
    return _strip_json(r2.text)


async def _prepare_email_identity(
    client: httpx.AsyncClient, notification_url: str
) -> Tuple[str, str, str, int]:
    """Prepare identity session for email OTP. Does NOT send the mail code."""
    qs = parse_qs(urlparse(notification_url).query)
    context = (qs.get("context") or [""])[0]
    if not context:
        raise XiaomiLoginError("identity context missing", data={"notificationUrl": notification_url})

    ref = f"{ACCOUNT}/fe/service/identity/verifyEmail?sid={SID}&context={context}&_locale=zh_CN"
    r_list = await client.get(
        f"{ACCOUNT}/identity/list",
        params={"sid": SID, "supportedMask": 0, "_locale": "zh_CN", "context": context},
        headers={"Referer": notification_url, "X-Requested-With": "XMLHttpRequest"},
    )
    j_list = _strip_json(r_list.text)
    flag = int(j_list.get("flag") or 8)

    await client.get(
        f"{ACCOUNT}/identity/auth/verifyEmail",
        params={"_flag": flag, "_json": "true"},
        headers={"Referer": ref, "X-Requested-With": "XMLHttpRequest"},
    )
    return context, ref, notification_url, flag


async def _send_email_ticket(client: httpx.AsyncClient, ref: str, flag: int = 8) -> dict:
    """Explicitly send email OTP. Only call on user action."""
    r_send = await client.post(
        f"{ACCOUNT}/identity/auth/sendEmailTicket",
        data={"_flag": str(flag), "_json": "true"},
        headers={
            "Referer": ref,
            "X-Requested-With": "XMLHttpRequest",
            "Content-Type": "application/x-www-form-urlencoded; charset=UTF-8",
            "Origin": ACCOUNT,
        },
    )
    j_send = _strip_json(r_send.text)
    if j_send.get("code") not in (0, "0", None):
        raise XiaomiLoginError(
            f"发送邮箱验证码失败: {j_send.get('desc') or j_send.get('description') or j_send}",
            code=j_send.get("code"),
            data=j_send,
        )
    return j_send


def _prune_pending() -> None:
    now = time.time()
    for k, v in list(_PENDING.items()):
        if now - v.created_at > 1800:
            _PENDING.pop(k, None)


async def _verify_email_otp(client: httpx.AsyncClient, ref: str, ticket: str) -> str:
    r = await client.post(
        f"{ACCOUNT}/identity/auth/verifyEmail",
        data={"ticket": ticket.strip(), "_json": "true"},
        headers={
            "Referer": ref,
            "X-Requested-With": "XMLHttpRequest",
            "Content-Type": "application/x-www-form-urlencoded; charset=UTF-8",
            "Origin": ACCOUNT,
        },
    )
    j = _strip_json(r.text)
    if j.get("code") != 0 or not j.get("location"):
        raise XiaomiLoginError(
            f"验证码错误或已过期: {j.get('tips') or j.get('desc') or j}",
            code=j.get("code"),
            data=j,
        )
    return j["location"]


async def _follow_for_pass_token(client: httpx.AsyncClient, start_url: str) -> Tuple[str, str, str]:
    """Follow identity/result and Auth2/end redirects; collect passToken/userId/cUserId."""
    url = start_url
    pass_token = ""
    user_id = ""
    c_user_id = ""
    for _ in range(20):
        if not url:
            break
        if url.startswith("/"):
            url = ACCOUNT + url
        r = await client.get(
            url,
            headers={
                "Referer": f"{ACCOUNT}/",
                "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
            },
        )
        for k, v in r.headers.multi_items():
            if k.lower() != "set-cookie":
                continue
            parsed = _parse_set_cookie(v)
            if not parsed:
                continue
            name, val = parsed
            if name == "passToken":
                pass_token = val
                for domain in ("account.xiaomi.com", "xiaomi.com"):
                    client.cookies.set("passToken", val, domain=domain)
            elif name == "userId":
                user_id = val
                for domain in ("account.xiaomi.com", "xiaomi.com"):
                    client.cookies.set("userId", val, domain=domain)
            elif name == "cUserId":
                c_user_id = val
                for domain in ("account.xiaomi.com", "xiaomi.com"):
                    client.cookies.set("cUserId", val, domain=domain)

        loc = r.headers.get("location")
        body = r.text or ""
        if r.status_code in (301, 302, 303, 307, 308) and loc:
            # Auth2/end may redirect to aistudio STS without sign → 401; stop if we have passToken
            if "aistudio.xiaomimimo.com/sts" in loc and pass_token:
                break
            url = loc
            continue
        j = _strip_json(body)
        if isinstance(j, dict) and j.get("location"):
            url = j["location"]
            continue
        break

    if not pass_token:
        # maybe already set via cookies after password login without identity
        for cookie in client.cookies.jar:
            if cookie.name == "passToken" and cookie.value:
                pass_token = cookie.value
            if cookie.name == "userId" and cookie.value:
                user_id = cookie.value
            if cookie.name == "cUserId" and cookie.value:
                c_user_id = cookie.value

    if not pass_token:
        raise XiaomiLoginError("登录成功但未拿到 passToken")
    return pass_token, user_id, c_user_id


async def _exchange_aistudio_tokens(
    client: httpx.AsyncClient,
    *,
    device_id: str,
    pass_token: str,
    user_id: str = "",
    c_user_id: str = "",
) -> Tuple[str, str, str]:
    """Use passToken + signed STS callback to get serviceToken / userId / xiaomichatbot_ph."""
    _set_account_cookies(
        client,
        device_id=device_id,
        pass_token=pass_token,
        user_id=user_id,
        c_user_id=c_user_id,
    )

    # Discover signed login URL (callback includes sign + followup)
    r_info = await client.get(f"{AISTUDIO}/open-apis/user/info")
    login_url = None
    try:
        j_info = r_info.json()
        login_url = j_info.get("loginUrl")
    except Exception:
        j_info = {}

    if not login_url:
        # fallback: serviceLogin default (may 401 on STS)
        r_sl = await client.get(
            f"{ACCOUNT}/pass/serviceLogin",
            params={"sid": SID, "_json": "true"},
        )
        j_sl = _strip_json(r_sl.text)
        if j_sl.get("location"):
            login_url = None
            start = j_sl["location"]
        else:
            raise XiaomiLoginError("无法获取 aistudio 登录地址", data=j_info or j_sl)
    else:
        start = login_url

    url = start
    service_token = ""
    ph = ""
    uid = user_id
    for _ in range(15):
        if not url:
            break
        r = await client.get(url, headers={"Referer": f"{AISTUDIO}/"})
        for k, v in r.headers.multi_items():
            if k.lower() != "set-cookie":
                continue
            parsed = _parse_set_cookie(v)
            if not parsed:
                continue
            name, val = parsed
            if name == "serviceToken":
                service_token = val
            elif name == "xiaomichatbot_ph":
                ph = val
            elif name == "userId":
                uid = val
            elif name == "passToken":
                pass_token = val
            elif name == "cUserId":
                c_user_id = val

        loc = r.headers.get("location")
        body = r.text or ""
        if r.status_code in (301, 302, 303, 307, 308) and loc:
            if loc.startswith("http://aistudio.xiaomimimo.com"):
                loc = "https://" + loc[len("http://") :]
            # stop after STS cookies collected
            if service_token and ph and "open-apis" in loc:
                break
            url = loc
            continue
        j = _strip_json(body)
        if isinstance(j, dict) and j.get("location"):
            url = j["location"]
            continue
        break

    if not service_token or not ph:
        raise XiaomiLoginError(
            "passToken 换取 aistudio serviceToken 失败（STS 未下发 cookie）",
            data={"user_id": uid, "has_service_token": bool(service_token), "has_ph": bool(ph)},
        )
    return service_token, uid or user_id, ph


async def _tokens_from_pass(
    client: httpx.AsyncClient,
    *,
    email: str,
    device_id: str,
    pass_token: str,
    user_id: str = "",
    c_user_id: str = "",
) -> MiMoTokens:
    st, uid, ph = await _exchange_aistudio_tokens(
        client,
        device_id=device_id,
        pass_token=pass_token,
        user_id=user_id,
        c_user_id=c_user_id,
    )
    return MiMoTokens(
        service_token=st,
        user_id=uid,
        xiaomichatbot_ph=ph,
        pass_token=pass_token,
        c_user_id=c_user_id,
        device_id=device_id,
        email=email,
    )


async def login_with_password(
    email: str,
    password: str,
    *,
    otp_code: Optional[str] = None,
    session_id: Optional[str] = None,
    device_id: Optional[str] = None,
) -> Dict[str, Any]:
    """Login with Xiaomi email+password.

    OTP is never auto-sent. When identity verification is required:
      {"ok": False, "need_otp": True, "otp_sent": False, "session_id": ...}
    User must call send_pending_email_otp(session_id), then resubmit with otp_code.
    """
    email = (email or "").strip()
    password = password or ""

    # Complete pending OTP (user-submitted code only; no auto-resend)
    if session_id and otp_code:
        pending = _PENDING.get(session_id)
        if not pending:
            raise XiaomiLoginError("验证码会话已过期，请重新导入")
        if not pending.otp_sent:
            raise XiaomiLoginError("请先点击「发送验证码」再提交邮箱验证码")
        client = _client(pending.device_id, pending.cookies)
        try:
            loc = await _verify_email_otp(client, pending.ref, otp_code)
            pass_token, user_id, c_user_id = await _follow_for_pass_token(client, loc)
            tokens = await _tokens_from_pass(
                client,
                email=pending.email,
                device_id=pending.device_id,
                pass_token=pass_token,
                user_id=user_id,
                c_user_id=c_user_id,
            )
            _PENDING.pop(session_id, None)
            return {"ok": True, "tokens": tokens.to_dict()}
        finally:
            await client.aclose()

    if not email or not password:
        raise XiaomiLoginError("邮箱和密码不能为空")

    device_id = device_id or _new_device_id()
    client = _client(device_id)
    try:
        j2 = await _auth2(client, email, password)

        # Already have location (no identity challenge)
        if j2.get("location") and int(j2.get("securityStatus") or 0) == 0:
            pass_token = j2.get("passToken") or ""
            user_id = str(j2.get("userId") or "")
            c_user_id = j2.get("cUserId") or ""
            if not pass_token:
                pass_token, user_id, c_user_id = await _follow_for_pass_token(client, j2["location"])
            else:
                try:
                    await _follow_for_pass_token(client, j2["location"])
                except XiaomiLoginError:
                    pass
            tokens = await _tokens_from_pass(
                client,
                email=email,
                device_id=device_id,
                pass_token=pass_token,
                user_id=user_id,
                c_user_id=c_user_id,
            )
            return {"ok": True, "tokens": tokens.to_dict()}

        # Identity required — prepare session only; do NOT send mail code
        if j2.get("notificationUrl") or int(j2.get("securityStatus") or 0) == 16:
            notif = j2.get("notificationUrl")
            if not notif:
                raise XiaomiLoginError("需要安全验证但未返回 notificationUrl", data=j2)

            context, ref, notif, flag = await _prepare_email_identity(client, notif)
            sid = uuid.uuid4().hex
            _PENDING[sid] = PendingLogin(
                session_id=sid,
                email=email,
                password=password,
                device_id=device_id,
                context=context,
                ref=ref,
                notif=notif,
                cookies=_dump_cookies(client),
                otp_sent=False,
                flag=flag,
            )
            _prune_pending()
            return {"ok": False, **_PENDING[sid].to_public()}

        raise XiaomiLoginError(
            f"登录失败: {j2.get('desc') or j2.get('description') or j2}",
            code=j2.get("code"),
            data=j2,
        )
    finally:
        await client.aclose()


async def send_pending_email_otp(session_id: str) -> Dict[str, Any]:
    """User-triggered: send email OTP for a pending identity session. No auto-retry."""
    session_id = (session_id or "").strip()
    pending = _PENDING.get(session_id)
    if not pending:
        raise XiaomiLoginError("验证码会话已过期，请重新导入")
    if pending.otp_sent:
        # Do not auto-resend; user must re-import to get a new session if they need another code
        return {
            "ok": True,
            "otp_sent": True,
            "session_id": session_id,
            "email": pending.email,
            "message": "本会话已发送过验证码，不会自动重发。请使用已收到的验证码；若过期请重新导入账号再点发送。",
            "already_sent": True,
        }

    client = _client(pending.device_id, pending.cookies)
    try:
        await _send_email_ticket(client, pending.ref, pending.flag)
        pending.cookies = _dump_cookies(client)
        pending.otp_sent = True
        _PENDING[session_id] = pending
        return {
            "ok": True,
            "otp_sent": True,
            "session_id": session_id,
            "email": pending.email,
            "message": "验证码已发送，请查收安全邮箱后填写提交",
            "already_sent": False,
        }
    finally:
        await client.aclose()


async def renew_with_pass_token(
    *,
    email: str = "",
    pass_token: str,
    user_id: str = "",
    c_user_id: str = "",
    device_id: Optional[str] = None,
) -> MiMoTokens:
    """Renew aistudio cookies using long-lived passToken only (never OTP / never password)."""
    if not pass_token:
        raise XiaomiLoginError("缺少 passToken，无法自动续期")
    device_id = device_id or _new_device_id()
    client = _client(device_id)
    try:
        return await _tokens_from_pass(
            client,
            email=email,
            device_id=device_id,
            pass_token=pass_token,
            user_id=user_id,
            c_user_id=c_user_id,
        )
    finally:
        await client.aclose()


async def renew_with_password(
    email: str,
    password: str,
    *,
    device_id: Optional[str] = None,
    pass_token: str = "",
    user_id: str = "",
    c_user_id: str = "",
    allow_password_fallback: bool = False,
) -> Dict[str, Any]:
    """Renew tokens.

    Default (auto-renew): passToken only. Never password, never mail code.
    Manual (allow_password_fallback=True): passToken first; if fail, password login
    may return need_otp for user to click-send + fill code (no auto-send).
    """
    if pass_token:
        try:
            tokens = await renew_with_pass_token(
                email=email,
                pass_token=pass_token,
                user_id=user_id,
                c_user_id=c_user_id,
                device_id=device_id,
            )
            return {"ok": True, "tokens": tokens.to_dict()}
        except XiaomiLoginError as e:
            if not allow_password_fallback:
                raise XiaomiLoginError(
                    f"passToken 续期失败（自动续期不会改用密码/不会发验证码）: {e}",
                    code=e.code,
                    data=e.data,
                ) from e

    if not allow_password_fallback:
        raise XiaomiLoginError("自动续期仅使用 passToken；缺少或失效时请用户在面板手动续期/导入")

    if not email or not password:
        raise XiaomiLoginError("passToken 失效，且无邮箱密码可供手动续期")

    result = await login_with_password(email, password, device_id=device_id)
    if result.get("ok") and result.get("tokens"):
        return result
    if result.get("need_otp"):
        # Hand off to user — do not send code, do not retry
        return result
    raise XiaomiLoginError("手动密码续期失败", data=result)


async def validate_mimo_tokens(service_token: str, user_id: str, xiaomichatbot_ph: str) -> bool:
    """Lightweight validation: call chat with a known model; auth errors → False."""
    from .mimo_client import MimoClient, MimoApiError
    from .config import MimoAccount

    account = MimoAccount(
        service_token=service_token,
        user_id=user_id,
        xiaomichatbot_ph=xiaomichatbot_ph,
    )
    client = MimoClient(account)
    try:
        # use a widely available model id; model-name errors still mean auth OK
        await client.call_api("hi", False, model="mimo-v2.5-pro")
        return True
    except MimoApiError as e:
        if e.status_code in (401, 403):
            return False
        # 200 with business error or other → treat as reachable/auth ok
        return e.status_code == 200 or e.status_code < 500
    except Exception:
        return False
