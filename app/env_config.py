"""Apply environment variable overrides onto a Config instance.

Avoid importing config_manager (prevents circular import with config.py).
"""

from __future__ import annotations

import os
from typing import Any, Optional


def _env(name: str, default: Optional[str] = None) -> Optional[str]:
    v = os.getenv(name)
    if v is None:
        return default
    v = v.strip()
    return v if v != "" else default


def _env_bool(name: str, default: bool) -> bool:
    v = os.getenv(name)
    if v is None or str(v).strip() == "":
        return default
    return str(v).strip().lower() not in ("0", "false", "no", "off")


def _clamp_int(val: Any, default: int, lo: int, hi: int) -> int:
    try:
        n = int(val)
    except Exception:
        return default
    return max(lo, min(hi, n))


def _clamp_float(val: Any, default: float, lo: float, hi: float) -> float:
    try:
        n = float(val)
    except Exception:
        return default
    return max(lo, min(hi, n))


def apply_env_overrides(config: Any) -> Any:
    """Mutate Config (or compatible) with env overrides. Env wins over file."""
    if _env("MIMO2API_API_KEYS") is not None:
        config.api_keys = _env("MIMO2API_API_KEYS") or config.api_keys
    if _env("MIMO2API_ADMIN_PASSWORD") is not None:
        config.admin_password = _env("MIMO2API_ADMIN_PASSWORD") or config.admin_password
    if os.getenv("MIMO2API_TOOLS_PASSTHROUGH") is not None:
        config.tools_passthrough = _env_bool(
            "MIMO2API_TOOLS_PASSTHROUGH", bool(getattr(config, "tools_passthrough", False))
        )

    tm = getattr(config, "temp_mail", None)
    if tm is not None:
        if _env("MIMO2API_TEMP_MAIL_API_BASE") is not None:
            tm.api_base = _env("MIMO2API_TEMP_MAIL_API_BASE") or ""
        if _env("MIMO2API_TEMP_MAIL_ADMIN_PASSWORD") is not None:
            tm.admin_password = _env("MIMO2API_TEMP_MAIL_ADMIN_PASSWORD") or ""
        if _env("MIMO2API_TEMP_MAIL_SITE_PASSWORD") is not None:
            tm.site_password = _env("MIMO2API_TEMP_MAIL_SITE_PASSWORD") or ""
        if _env("MIMO2API_TEMP_MAIL_DOMAIN") is not None:
            tm.domain = _env("MIMO2API_TEMP_MAIL_DOMAIN") or ""
        if os.getenv("MIMO2API_TEMP_MAIL_REGISTER_REGION") is not None:
            tm.register_region = (
                _env("MIMO2API_TEMP_MAIL_REGISTER_REGION") or tm.register_region
            )
        if os.getenv("MIMO2API_REGISTER_BATCH_COUNT") is not None:
            tm.batch_count = _clamp_int(
                os.getenv("MIMO2API_REGISTER_BATCH_COUNT"), tm.batch_count, 1, 50
            )
        if os.getenv("MIMO2API_REGISTER_SUCCESS_TARGET") is not None:
            tm.success_target = _clamp_int(
                os.getenv("MIMO2API_REGISTER_SUCCESS_TARGET"), tm.success_target, 0, 50
            )
        if os.getenv("MIMO2API_REGISTER_CONCURRENT") is not None:
            tm.concurrent = _clamp_int(
                os.getenv("MIMO2API_REGISTER_CONCURRENT"), tm.concurrent, 1, 10
            )
        if os.getenv("MIMO2API_REGISTER_INTERVAL") is not None:
            tm.concurrent_interval = _clamp_float(
                os.getenv("MIMO2API_REGISTER_INTERVAL"), tm.concurrent_interval, 0.0, 300.0
            )
        if os.getenv("MIMO2API_REGISTER_CAPTCHA_RETRIES") is not None:
            tm.captcha_retries = _clamp_int(
                os.getenv("MIMO2API_REGISTER_CAPTCHA_RETRIES"), tm.captcha_retries, 1, 30
            )
        if os.getenv("MIMO2API_REGISTER_OTP_TIMEOUT") is not None:
            tm.otp_timeout = _clamp_int(
                os.getenv("MIMO2API_REGISTER_OTP_TIMEOUT"), tm.otp_timeout, 30, 600
            )
        if os.getenv("MIMO2API_REGISTER_AUTO_CAPTCHA") is not None:
            tm.auto_captcha = _env_bool("MIMO2API_REGISTER_AUTO_CAPTCHA", tm.auto_captcha)
        if hasattr(tm, "normalized"):
            config.temp_mail = tm.normalized()

    pp = getattr(config, "proxy_pool", None)
    if pp is not None:
        if os.getenv("MIMO2API_PROXY_ENABLED") is not None:
            pp.enabled = _env_bool("MIMO2API_PROXY_ENABLED", pp.enabled)
        if _env("MIMO2API_PROXY_SUB_URL") is not None:
            pp.sub_url = _env("MIMO2API_PROXY_SUB_URL") or ""
        if os.getenv("MIMO2API_PROXY_LISTEN_PORT") is not None:
            pp.listen_port = _clamp_int(
                os.getenv("MIMO2API_PROXY_LISTEN_PORT"), pp.listen_port, 1024, 65535
            )
        if _env("MIMO2API_PROXY_SINGBOX_PATH") is not None:
            pp.singbox_path = _env("MIMO2API_PROXY_SINGBOX_PATH") or ""
        if os.getenv("MIMO2API_PROXY_CONNECT_RETRIES") is not None:
            pp.connect_retries = _clamp_int(
                os.getenv("MIMO2API_PROXY_CONNECT_RETRIES"),
                getattr(pp, "connect_retries", 5),
                1,
                20,
            )
        if os.getenv("MIMO2API_PROXY_FETCH_SUB_EACH_TIME") is not None:
            pp.fetch_sub_each_time = _env_bool(
                "MIMO2API_PROXY_FETCH_SUB_EACH_TIME",
                getattr(pp, "fetch_sub_each_time", True),
            )
        if os.getenv("MIMO2API_PROXY_REFRESH_INTERVAL") is not None:
            pp.refresh_interval = _clamp_int(
                os.getenv("MIMO2API_PROXY_REFRESH_INTERVAL"),
                pp.refresh_interval,
                0,
                604800,
            )
        if hasattr(pp, "normalized"):
            config.proxy_pool = pp.normalized()

    ca = getattr(config, "captcha_ai", None)
    if ca is not None:
        if os.getenv("MIMO2API_CAPTCHA_AI_ENABLED") is not None:
            ca.enabled = _env_bool("MIMO2API_CAPTCHA_AI_ENABLED", ca.enabled)
        if _env("MIMO2API_CAPTCHA_AI_API_BASE") is not None:
            ca.api_base = _env("MIMO2API_CAPTCHA_AI_API_BASE") or ""
        if _env("MIMO2API_CAPTCHA_AI_API_KEY") is not None:
            ca.api_key = _env("MIMO2API_CAPTCHA_AI_API_KEY") or ""
        if _env("MIMO2API_CAPTCHA_AI_MODEL") is not None:
            ca.model = _env("MIMO2API_CAPTCHA_AI_MODEL") or ca.model
        if os.getenv("MIMO2API_CAPTCHA_AI_TIMEOUT") is not None:
            ca.timeout = _clamp_int(
                os.getenv("MIMO2API_CAPTCHA_AI_TIMEOUT"), ca.timeout, 15, 180
            )
        if hasattr(ca, "normalized"):
            config.captcha_ai = ca.normalized()

    return config
