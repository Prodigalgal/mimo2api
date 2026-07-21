"""Shared account save/mail helpers (no HTTP routes).

Keeps routes.py / register_routes.py free of duplicated account persistence logic.
"""

from __future__ import annotations

from datetime import datetime as _dt
from typing import Optional

from .config import config_manager, MimoAccount


def mail_cfg_from_settings():
    from .temp_mail import TempMailConfig

    tm = config_manager.get_temp_mail_settings()
    return TempMailConfig(
        api_base=tm.api_base,
        admin_password=tm.admin_password,
        domain=tm.domain,
        site_password=tm.site_password,
    )


async def validate_and_save(
    service_token: str,
    user_id: str,
    xiaomichatbot_ph: str,
    *,
    email: str = "",
    password: str = "",
    pass_token: str = "",
    c_user_id: str = "",
    device_id: str = "",
    auto_renew: bool = True,
    skip_live_check: bool = False,
    mail_jwt: str = "",
    region: str = "",
):
    from .mimo_client import MimoClient, MimoApiError

    now = _dt.now().strftime("%m-%d %H:%M")
    content = ""

    if not skip_live_check:
        account = MimoAccount(
            service_token=service_token,
            user_id=user_id,
            xiaomichatbot_ph=xiaomichatbot_ph,
        )
        client = MimoClient(account)
        try:
            content, _, _ = await client.call_api("hi", False, model="mimo-v2.5-pro")
        except MimoApiError as e:
            if e.status_code in (401, 403):
                return {
                    "ok": False,
                    "error": f"验证失败 (HTTP {e.status_code}): {e.response_body[:100]}",
                }
            content = e.response_body[:100]
        except Exception as e:
            return {"ok": False, "error": f"验证失败: {str(e)[:100]}"}

    prev = None
    for acc in config_manager.config.mimo_accounts:
        if acc.user_id == user_id:
            prev = acc
            break

    new_acc = MimoAccount(
        service_token=service_token,
        user_id=user_id,
        xiaomichatbot_ph=xiaomichatbot_ph,
        login_time=now,
        is_valid=True,
        email=email or (prev.email if prev else ""),
        password=password or (prev.password if prev else ""),
        pass_token=pass_token or (prev.pass_token if prev else ""),
        c_user_id=c_user_id or (prev.c_user_id if prev else ""),
        device_id=device_id or (prev.device_id if prev else ""),
        auto_renew=auto_renew
        if prev is None
        else (auto_renew if email or password or pass_token else prev.auto_renew),
        last_renew=now
        if (pass_token or password or email)
        else (prev.last_renew if prev else ""),
        last_test=now if content else (prev.last_test if prev else ""),
        renew_error="",
        mail_jwt=mail_jwt or (prev.mail_jwt if prev else ""),
        region=region or (prev.region if prev else ""),
    )

    if prev is not None:
        for i, acc in enumerate(config_manager.config.mimo_accounts):
            if acc.user_id == user_id:
                config_manager.config.mimo_accounts[i] = new_acc
                break
    else:
        config_manager.config.mimo_accounts.append(new_acc)
    config_manager.save()
    return {
        "ok": True,
        "user_id": user_id,
        "response": (content or "saved")[:100],
        "email": new_acc.email,
        "has_mail_jwt": bool(new_acc.mail_jwt),
    }


# legacy alias used by older code
_validate_and_save = validate_and_save
_mail_cfg_from_settings = mail_cfg_from_settings
