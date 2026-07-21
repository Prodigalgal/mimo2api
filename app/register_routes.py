"""Register / temp-mail / batch / renew routes (modular).

Extracted from routes.py to avoid a god-module.
"""

from __future__ import annotations

import asyncio
import uuid
from datetime import datetime as _dt
from typing import Optional

from fastapi import APIRouter, Depends, HTTPException, Request

from .auth import verify_admin
from .config import config_manager, MimoAccount
from .account_service import validate_and_save, mail_cfg_from_settings

router = APIRouter(tags=["register"])

def _mail_cfg_from_settings():
    return mail_cfg_from_settings()



@router.get("/api/temp-mail/config")
async def get_temp_mail_config(username: str = Depends(verify_admin)):
    tm = config_manager.get_temp_mail_settings()
    out = {"ok": True, "temp_mail": tm.to_dict(mask=True), "domains": []}
    # auto-list domains for UI (user need not type domain)
    try:
        from .temp_mail import TempMailConfig, list_domains

        if tm.api_base:
            cfg = TempMailConfig(
                api_base=tm.api_base,
                admin_password=tm.admin_password,
                domain=tm.domain,
                site_password=tm.site_password,
            )
            out["domains"] = await list_domains(cfg)
    except Exception as e:
        out["domains_error"] = str(e)[:120]
    return out


@router.post("/api/temp-mail/config")
async def save_temp_mail_config(request: Request, username: str = Depends(verify_admin)):
    try:
        data = await request.json()
    except Exception:
        raise HTTPException(400, "invalid json")
    if not isinstance(data, dict):
        return {"ok": False, "error": "invalid body"}
    # allow nested or flat
    payload = data.get("temp_mail") if isinstance(data.get("temp_mail"), dict) else data
    # domain optional — clear empty string so create_address auto-picks
    if isinstance(payload, dict) and payload.get("domain") is not None:
        payload["domain"] = str(payload.get("domain") or "").strip()
    tm = config_manager.update_temp_mail(payload)
    domains = []
    try:
        from .temp_mail import TempMailConfig, list_domains

        if tm.api_base and tm.admin_password:
            domains = await list_domains(
                TempMailConfig(
                    api_base=tm.api_base,
                    admin_password=tm.admin_password,
                    site_password=tm.site_password,
                )
            )
    except Exception:
        pass
    return {
        "ok": True,
        "temp_mail": tm.to_dict(mask=True),
        "domains": domains,
        "message": "临时邮箱配置已保存（域名由服务端自动获取）",
    }


@router.get("/api/captcha-ai/config")
async def get_captcha_ai_config(username: str = Depends(verify_admin)):
    ca = config_manager.get_captcha_ai_settings()
    return {"ok": True, "captcha_ai": ca.to_dict(mask=True)}


@router.post("/api/captcha-ai/config")
async def save_captcha_ai_config(request: Request, username: str = Depends(verify_admin)):
    try:
        data = await request.json()
    except Exception:
        raise HTTPException(400, "invalid json")
    if not isinstance(data, dict):
        return {"ok": False, "error": "invalid body"}
    payload = data.get("captcha_ai") if isinstance(data.get("captcha_ai"), dict) else data
    ca = config_manager.update_captcha_ai(payload)
    return {"ok": True, "captcha_ai": ca.to_dict(mask=True), "message": "AI 验证码配置已保存"}


@router.post("/api/captcha-ai/test")
async def test_captcha_ai(request: Request, username: str = Depends(verify_admin)):
    """Quick vision connectivity test (no Xiaomi). Optional body overrides."""
    from .captcha_ai import CaptchaAIConfig, solve_captcha_with_ai
    import base64

    try:
        body = await request.json()
    except Exception:
        body = {}
    if not isinstance(body, dict):
        body = {}
    ca = config_manager.get_captcha_ai_settings()
    api_base = (body.get("api_base") or ca.api_base or "").strip()
    api_key = body.get("api_key") or ca.api_key
    if isinstance(api_key, str) and "***" in api_key:
        api_key = ca.api_key
    model = (body.get("model") or ca.model or "grok").strip()
    cfg = CaptchaAIConfig(
        enabled=True,
        api_base=api_base,
        api_key=str(api_key or ""),
        model=model,
        timeout=int(body.get("timeout") or ca.timeout or 60),
    )
    if not cfg.is_ready():
        return {"ok": False, "error": "请填写 AI API 地址与 Key"}
    # 1x1 png smoke
    png = base64.b64decode(
        "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=="
    )
    try:
        code = await solve_captcha_with_ai(png, cfg)
        return {
            "ok": True,
            "message": "AI 接口可调用（测试图不一定有字符）",
            "sample_reply": code or "(空)",
            "model": cfg.model,
            "api_base": cfg.api_base,
        }
    except Exception as e:
        return {"ok": False, "error": str(e)[:300]}


@router.post("/api/temp-mail/test")
async def test_temp_mail(request: Request, username: str = Depends(verify_admin)):
    """Test connectivity. Optional body overrides (not saved unless save=true)."""
    from .temp_mail import TempMailConfig, test_connection

    overrides = {}
    try:
        body = await request.json()
        if isinstance(body, dict):
            overrides = body.get("temp_mail") if isinstance(body.get("temp_mail"), dict) else body
    except Exception:
        overrides = {}

    tm = config_manager.get_temp_mail_settings()
    api_base = (overrides.get("api_base") if overrides.get("api_base") else tm.api_base) or ""
    admin_password = overrides.get("admin_password")
    if not admin_password or str(admin_password) in ("", "***") or (
        isinstance(admin_password, str) and "***" in admin_password and len(admin_password) <= 8
    ):
        admin_password = tm.admin_password
    site_password = overrides.get("site_password")
    if site_password is None or str(site_password) in ("", "***"):
        site_password = tm.site_password
    domain = overrides.get("domain") if overrides.get("domain") is not None else tm.domain

    cfg = TempMailConfig(
        api_base=str(api_base).strip().rstrip("/"),
        admin_password=str(admin_password or ""),
        domain=str(domain or "").strip(),
        site_password=str(site_password or ""),
    )
    result = await test_connection(cfg)
    if overrides.get("save") and result.get("ok"):
        config_manager.update_temp_mail({
            "api_base": cfg.api_base,
            "admin_password": cfg.admin_password,
            "domain": cfg.domain,
            "site_password": cfg.site_password,
            "register_region": overrides.get("register_region") or tm.register_region,
        })
        result["saved"] = True
    return result


async def _run_one_auto_register(
    *,
    mail_cfg,
    region: str,
    domain: str,
    auto_captcha: bool,
    captcha_retries: int,
    otp_timeout: float,
    password: str = "",
    session_id: str = None,
    icode: str = None,
    on_progress=None,
) -> dict:
    """Single register + save. Used by single and batch endpoints."""
    from .xiaomi_register import auto_register, XiaomiRegisterError
    from .temp_mail import TempMailError

    try:
        result = await auto_register(
            mail_cfg,
            region=region,
            password=password or None,
            icode=icode,
            session_id=session_id,
            otp_timeout=otp_timeout,
            domain=domain or None,
            auto_captcha=bool(auto_captcha),
            captcha_retries=captcha_retries,
            on_progress=on_progress,
        )
    except XiaomiRegisterError as e:
        if on_progress:
            try:
                on_progress("error", str(e), None)
            except Exception:
                pass
        out = {"ok": False, "error": str(e), "code": e.code, "data": e.data}
        if e.data and e.data.get("captcha_image"):
            out["captcha_image"] = e.data["captcha_image"]
            out["need_captcha"] = True
            out["session_id"] = session_id
        return out
    except TempMailError as e:
        if on_progress:
            try:
                on_progress("error", str(e), None)
            except Exception:
                pass
        return {"ok": False, "error": str(e), "data": e.data}
    except Exception as e:
        if on_progress:
            try:
                on_progress("error", str(e)[:200], None)
            except Exception:
                pass
        return {"ok": False, "error": f"自动注册失败: {str(e)[:200]}"}

    if result.get("need_captcha"):
        return result

    if result.get("logged_in") and result.get("tokens"):
        email = result.get("email") or ""
        if on_progress:
            try:
                on_progress("save", "正在保存账号到配置…", email)
            except Exception:
                pass
        tokens = result["tokens"]
        saved = await validate_and_save(
            tokens.get("service_token", ""),
            tokens.get("user_id", ""),
            tokens.get("xiaomichatbot_ph", ""),
            email=result.get("email") or tokens.get("email", ""),
            password=result.get("password", ""),
            pass_token=tokens.get("pass_token", ""),
            c_user_id=tokens.get("c_user_id", ""),
            device_id=tokens.get("device_id", ""),
            auto_renew=True,
            mail_jwt=result.get("mail_jwt", ""),
            region=result.get("region", region),
        )
        result["saved"] = saved
        if not saved.get("ok"):
            result["save_error"] = saved.get("error")
            if on_progress:
                try:
                    on_progress("error", f"保存失败: {saved.get('error')}", email)
                except Exception:
                    pass
        elif on_progress:
            try:
                on_progress("save", f"账号已保存 userId={saved.get('user_id')}", email)
            except Exception:
                pass
    return result


@router.post("/api/account/auto-register")
async def auto_register_account(request: Request, username: str = Depends(verify_admin)):
    """Auto-register Xiaomi account via temp mail (single).

    Body fields optional: region, domain, auto_captcha, captcha_retries, otp_timeout,
    session_id, icode, refresh_captcha.
    Defaults come from saved temp_mail register settings.
    """
    try:
        data = await request.json()
    except Exception:
        data = {}
    if not isinstance(data, dict):
        data = {}

    from .xiaomi_register import refresh_captcha, XiaomiRegisterError

    tm = config_manager.get_temp_mail_settings().normalized()
    mail_cfg = _mail_cfg_from_settings()
    if not mail_cfg.is_configured():
        return {"ok": False, "error": "请先在「临时邮箱」页配置 API 地址与管理口令"}

    region = (data.get("region") or tm.register_region or "US").strip().upper()
    if region in ("CN", "ZH", "CHINA", "PRC"):
        return {"ok": False, "error": "注册地区不能选择中国，请使用 US / SG / JP 或 RANDOM"}
    # RANDOM is resolved per attempt inside start_register

    session_id = (data.get("session_id") or "").strip() or None
    icode = (data.get("icode") or data.get("captcha") or "").strip() or None
    auto_captcha = data.get("auto_captcha", tm.auto_captcha)
    if isinstance(auto_captcha, str):
        auto_captcha = auto_captcha.strip().lower() not in ("0", "false", "no", "off")
    captcha_retries = int(data.get("captcha_retries") or tm.captcha_retries)
    otp_timeout = float(data.get("otp_timeout") or tm.otp_timeout)
    domain = (data.get("domain") or tm.domain or "").strip()

    if session_id and data.get("refresh_captcha"):
        try:
            return await refresh_captcha(session_id)
        except XiaomiRegisterError as e:
            return {"ok": False, "error": str(e), "code": e.code, "data": e.data}

    return await _run_one_auto_register(
        mail_cfg=mail_cfg,
        region=region,
        domain=domain,
        auto_captcha=bool(auto_captcha),
        captcha_retries=captcha_retries,
        otp_timeout=otp_timeout,
        password=(data.get("password") or ""),
        session_id=session_id,
        icode=icode,
    )


def _is_register_success(r: Optional[dict]) -> bool:
    if not r or not r.get("ok"):
        return False
    return bool(r.get("logged_in") or r.get("saved_ok") or r.get("registered"))


# In-memory batch jobs (logs + slots; not persisted)
_BATCH_JOBS: dict = {}
_BATCH_LOG_MAX = 300  # ring buffer cap


def _slim_register_result(r: dict) -> dict:
    slim = {
        k: v
        for k, v in r.items()
        if k not in ("captcha_image", "tokens", "mail_jwt", "data", "login")
    }
    if r.get("tokens"):
        slim["user_id"] = r["tokens"].get("user_id")
    if r.get("saved"):
        slim["saved_ok"] = bool(r["saved"].get("ok"))
    if r.get("region"):
        slim["region"] = r.get("region")
    return slim


def _job_append_log(job: dict, *, attempt: int, stage: str, message: str, email: str = "") -> None:
    import time as _time

    logs = job.setdefault("logs", [])
    entry = {
        "ts": _time.time(),
        "attempt": attempt,
        "email": email or "",
        "stage": stage,
        "message": (message or "")[:300],
    }
    logs.append(entry)
    if len(logs) > _BATCH_LOG_MAX:
        del logs[: len(logs) - _BATCH_LOG_MAX]
    # live slot for this attempt
    slots = job.setdefault("slots", {})
    slots[str(attempt)] = {
        "attempt": attempt,
        "email": email or slots.get(str(attempt), {}).get("email") or "",
        "stage": stage,
        "message": (message or "")[:300],
        "ts": entry["ts"],
        "active": stage not in ("done", "error", "cancelled", "idle"),
    }


def _batch_job_public(job: dict) -> dict:
    slots = job.get("slots") or {}
    # sort active first then by attempt
    slot_list = sorted(
        slots.values(),
        key=lambda s: (0 if s.get("active") else 1, s.get("attempt") or 0),
    )
    return {
        "ok": True,
        "job_id": job["id"],
        "status": job["status"],
        "total": len(job.get("results") or []),
        "max_attempts": job.get("max_attempts"),
        "success": job.get("success", 0),
        "failed": job.get("failed", 0),
        "success_target": job.get("success_target"),
        "stopped_early": job.get("stopped_early", False),
        "cancelled": bool(job.get("cancel")),
        "concurrent": job.get("concurrent"),
        "concurrent_interval": job.get("concurrent_interval"),
        "region": job.get("region"),
        "results": job.get("results") or [],
        "logs": job.get("logs") or [],
        "slots": slot_list,
        "error": job.get("error") or "",
        "message": job.get("message") or "",
        "started_at": job.get("started_at"),
        "finished_at": job.get("finished_at"),
    }


async def _run_batch_job(job_id: str, params: dict) -> None:
    """Background worker: long-running batch registration with live logs."""
    import time as _time

    job = _BATCH_JOBS.get(job_id)
    if not job:
        return

    max_attempts = params["max_attempts"]
    success_target = params["success_target"]
    concurrent = params["concurrent"]
    interval = params["interval"]
    region = params["region"]
    domain = params["domain"]
    captcha_retries = params["captcha_retries"]
    otp_timeout = params["otp_timeout"]
    mail_cfg = params["mail_cfg"]
    target = success_target if success_target > 0 else max_attempts

    sem = asyncio.Semaphore(concurrent)
    results: list = []
    state = {"success": 0, "stop": False}
    lock = asyncio.Lock()

    def _cancelled() -> bool:
        return bool(job.get("cancel")) or state["stop"]

    async def worker(idx: int):
        attempt = idx + 1
        async with sem:
            if _cancelled():
                _job_append_log(job, attempt=attempt, stage="cancelled", message="任务已停止，跳过")
                return

            def on_progress(stage: str, message: str, email: Optional[str] = None):
                if _cancelled() and stage not in ("done", "error", "cancelled"):
                    return
                _job_append_log(
                    job,
                    attempt=attempt,
                    stage=stage,
                    message=message,
                    email=email or "",
                )

            _job_append_log(job, attempt=attempt, stage="start", message=f"开始第 {attempt} 次注册…")
            try:
                r = await _run_one_auto_register(
                    mail_cfg=mail_cfg,
                    region=region,
                    domain=domain,
                    auto_captcha=True,
                    captcha_retries=captcha_retries,
                    otp_timeout=otp_timeout,
                    on_progress=on_progress,
                )
            except Exception as e:
                r = {"ok": False, "error": str(e)[:200]}
                _job_append_log(job, attempt=attempt, stage="error", message=str(e)[:200])

            if _cancelled() and not _is_register_success(r):
                _job_append_log(job, attempt=attempt, stage="cancelled", message="任务停止时未完成")
                return

            slim = _slim_register_result(r)
            slim["attempt"] = attempt
            email = slim.get("email") or ""
            async with lock:
                results.append(slim)
                job["results"] = list(results)
                if _is_register_success(slim):
                    state["success"] += 1
                    _job_append_log(
                        job,
                        attempt=attempt,
                        stage="done",
                        message=f"成功 · userId={slim.get('user_id') or '-'}",
                        email=email,
                    )
                else:
                    _job_append_log(
                        job,
                        attempt=attempt,
                        stage="error",
                        message=slim.get("error") or slim.get("message") or "失败",
                        email=email,
                    )
                job["success"] = state["success"]
                job["failed"] = len(results) - state["success"]
                job["message"] = (
                    f"进行中：成功 {state['success']}"
                    + (f"/{success_target}" if success_target > 0 else "")
                    + f"，已尝试 {len(results)}/{max_attempts}"
                )
                if state["success"] >= target or _cancelled():
                    state["stop"] = True
                    if state["success"] >= target:
                        print(f"[BatchReg] job={job_id} success target {state['success']}/{target}")

    try:
        _job_append_log(
            job,
            attempt=0,
            stage="job",
            message=(
                f"任务启动：目标 {success_target or '不限'} / 最多 {max_attempts} 次 / "
                f"并发 {concurrent} / 间隔 {interval}s / 地区 {region}"
            ),
        )
        tasks = []
        for i in range(max_attempts):
            if _cancelled():
                break
            async with lock:
                if state["stop"] or state["success"] >= target:
                    break
            if i > 0 and interval > 0:
                await asyncio.sleep(interval)
            if _cancelled():
                break
            async with lock:
                if state["stop"] or state["success"] >= target:
                    break
            tasks.append(asyncio.create_task(worker(i)))
        if tasks:
            await asyncio.gather(*tasks)

        ok_n = state["success"]
        attempted = len(results)
        fail_n = attempted - ok_n
        cancelled = bool(job.get("cancel"))
        stopped_early = (not cancelled) and success_target > 0 and ok_n >= success_target and attempted < max_attempts
        job["status"] = "cancelled" if cancelled else "done"
        job["success"] = ok_n
        job["failed"] = fail_n
        job["stopped_early"] = stopped_early
        job["results"] = results
        job["finished_at"] = _time.time()
        # mark remaining slots inactive
        for s in (job.get("slots") or {}).values():
            if s.get("active") and s.get("stage") not in ("done", "error", "cancelled"):
                s["active"] = False
        if cancelled:
            job["message"] = (
                f"任务已停止：成功 {ok_n}"
                + (f"/{success_target}" if success_target > 0 else "")
                + f"，已尝试 {attempted}/{max_attempts}"
            )
            _job_append_log(job, attempt=0, stage="job", message=job["message"])
        else:
            job["message"] = (
                f"批量注册完成：成功 {ok_n}"
                + (f"/{success_target}（目标）" if success_target > 0 else f"/{attempted}")
                + f"，尝试 {attempted}/{max_attempts}"
                + ("，提前结束" if stopped_early else "")
                + f"（并发 {concurrent}，间隔 {interval}s）"
            )
            _job_append_log(job, attempt=0, stage="job", message=job["message"])
        job["ok"] = (not cancelled) and (ok_n >= target if success_target > 0 else fail_n == 0)
        print(f"[BatchReg] job={job_id} done: {job['message']}")
    except Exception as e:
        job["status"] = "error"
        job["error"] = str(e)[:300]
        job["message"] = f"批量注册异常: {str(e)[:200]}"
        job["finished_at"] = _time.time()
        _job_append_log(job, attempt=0, stage="error", message=job["message"])
        print(f"[BatchReg] job={job_id} error: {e}")


@router.post("/api/account/auto-register-batch")
async def auto_register_batch(request: Request, username: str = Depends(verify_admin)):
    """Start batch auto-register as a background job (returns immediately).

    Avoids reverse-proxy 504 on long-running sync batches.
    Poll GET /api/account/auto-register-batch/{job_id} for progress.

    Body (optional, defaults from temp_mail settings):
      batch_count, success_target, concurrent, concurrent_interval,
      region, domain, auto_captcha, captcha_retries, otp_timeout
    """
    import time as _time

    try:
        data = await request.json()
    except Exception:
        data = {}
    if not isinstance(data, dict):
        data = {}

    tm = config_manager.get_temp_mail_settings().normalized()
    mail_cfg = _mail_cfg_from_settings()
    if not mail_cfg.is_configured():
        return {"ok": False, "error": "请先在「临时邮箱」页配置 API 地址与管理口令"}

    region = (data.get("region") or tm.register_region or "US").strip().upper()
    if region in ("CN", "ZH", "CHINA", "PRC"):
        return {"ok": False, "error": "注册地区不能选择中国，请使用 US / SG / JP 或 RANDOM"}

    from .config import _clamp_int, _clamp_float

    max_attempts = _clamp_int(
        data.get("count", data.get("batch_count", tm.batch_count)), tm.batch_count, 1, 50
    )
    success_target = _clamp_int(
        data.get("success_target", tm.success_target), tm.success_target, 0, 50
    )
    if success_target > max_attempts:
        success_target = max_attempts
    concurrent = _clamp_int(data.get("concurrent", tm.concurrent), tm.concurrent, 1, 10)
    interval = _clamp_float(
        data.get("concurrent_interval", tm.concurrent_interval), tm.concurrent_interval, 0.0, 300.0
    )
    auto_captcha = data.get("auto_captcha", tm.auto_captcha)
    if isinstance(auto_captcha, str):
        auto_captcha = auto_captcha.strip().lower() not in ("0", "false", "no", "off")
    captcha_retries = _clamp_int(data.get("captcha_retries", tm.captcha_retries), tm.captcha_retries, 1, 30)
    otp_timeout = float(_clamp_int(data.get("otp_timeout", tm.otp_timeout), tm.otp_timeout, 30, 600))
    domain = (data.get("domain") or tm.domain or "").strip()

    if not auto_captcha:
        return {"ok": False, "error": "批量注册必须开启自动 OCR（auto_captcha=true）"}

    job_id = uuid.uuid4().hex
    job = {
        "id": job_id,
        "status": "running",
        "ok": True,
        "results": [],
        "logs": [],
        "slots": {},
        "cancel": False,
        "success": 0,
        "failed": 0,
        "max_attempts": max_attempts,
        "success_target": success_target,
        "concurrent": concurrent,
        "concurrent_interval": interval,
        "region": region,
        "stopped_early": False,
        "error": "",
        "message": f"批量任务已启动：目标 {success_target or '不限'} / 最多 {max_attempts} 次",
        "started_at": _time.time(),
        "finished_at": None,
    }
    _BATCH_JOBS[job_id] = job
    _job_append_log(
        job,
        attempt=0,
        stage="job",
        message=job["message"],
    )

    # prune old finished jobs (keep last 20); never drop running
    if len(_BATCH_JOBS) > 20:
        finished = sorted(
            [(k, v.get("finished_at") or 0) for k, v in _BATCH_JOBS.items() if v.get("status") != "running"],
            key=lambda x: x[1],
        )
        for k, _ in finished[: max(0, len(_BATCH_JOBS) - 20)]:
            _BATCH_JOBS.pop(k, None)

    params = {
        "max_attempts": max_attempts,
        "success_target": success_target,
        "concurrent": concurrent,
        "interval": interval,
        "region": region,
        "domain": domain,
        "captcha_retries": captcha_retries,
        "otp_timeout": otp_timeout,
        "mail_cfg": mail_cfg,
    }
    asyncio.create_task(_run_batch_job(job_id, params))

    return {
        **_batch_job_public(job),
        "async": True,
        "poll_url": f"/api/account/auto-register-batch/{job_id}",
        "message": job["message"] + "（后台执行，详细日志仅内存保留）",
    }


@router.get("/api/account/auto-register-batch")
async def list_auto_register_batches(username: str = Depends(verify_admin)):
    """List in-memory batch jobs (newest first). For UI resume after tab switch."""
    items = sorted(
        _BATCH_JOBS.values(),
        key=lambda j: j.get("started_at") or 0,
        reverse=True,
    )
    return {
        "ok": True,
        "jobs": [_batch_job_public(j) for j in items[:10]],
        "latest_running": next(
            (j["id"] for j in items if j.get("status") == "running"),
            None,
        ),
    }


@router.get("/api/account/auto-register-batch/{job_id}")
async def get_auto_register_batch(job_id: str, username: str = Depends(verify_admin)):
    """Poll batch registration job status + detailed logs/slots."""
    job = _BATCH_JOBS.get(job_id)
    if not job:
        raise HTTPException(404, "批量任务不存在或已过期（内存任务，重启后清空）")
    pub = _batch_job_public(job)
    pub["ok"] = job.get("status") not in ("error",)
    if job.get("status") in ("done", "cancelled"):
        pub["ok"] = bool(job.get("ok", True)) if job.get("status") == "done" else True
    return pub


@router.post("/api/account/auto-register-batch/{job_id}/stop")
async def stop_auto_register_batch(job_id: str, username: str = Depends(verify_admin)):
    """Request stop; workers exit ASAP. Logs remain until clear/delete."""
    job = _BATCH_JOBS.get(job_id)
    if not job:
        raise HTTPException(404, "批量任务不存在或已过期")
    job["cancel"] = True
    if job.get("status") == "running":
        job["message"] = "正在停止…（当前进行中的步骤结束后不再启动新任务）"
        _job_append_log(job, attempt=0, stage="job", message="用户请求停止任务")
    return _batch_job_public(job)


@router.post("/api/account/auto-register-batch/{job_id}/clear-logs")
async def clear_auto_register_batch_logs(job_id: str, username: str = Depends(verify_admin)):
    """Clear in-memory detailed logs for a job (keep results summary)."""
    job = _BATCH_JOBS.get(job_id)
    if not job:
        raise HTTPException(404, "批量任务不存在或已过期")
    job["logs"] = []
    # keep only active slots briefly or clear inactive
    job["slots"] = {
        k: v for k, v in (job.get("slots") or {}).items() if v.get("active")
    }
    return _batch_job_public(job)


@router.delete("/api/account/auto-register-batch/{job_id}")
async def delete_auto_register_batch(job_id: str, username: str = Depends(verify_admin)):
    """Stop if running and remove job from memory entirely."""
    job = _BATCH_JOBS.get(job_id)
    if not job:
        return {"ok": True, "removed": False}
    job["cancel"] = True
    if job.get("status") != "running":
        _BATCH_JOBS.pop(job_id, None)
        return {"ok": True, "removed": True}
    # still running: mark cancel; cleanup after finish via prune, or force drop after mark
    _BATCH_JOBS.pop(job_id, None)
    return {"ok": True, "removed": True, "message": "已请求停止并从内存移除"}


@router.post("/api/accounts/{idx}/renew")
async def renew_account(idx: int, request: Request, username: str = Depends(verify_admin)):
    """Manually renew one account.

    Query/body:
      allow_password=1  — allow password fallback (may return need_otp)
      auto_temp_mail=1  — if mail_jwt present, auto send+read OTP from temp mail
      session_id + otp_code — complete OTP for manual password renew

    Default for accounts with mail_jwt: auto_temp_mail on (registered via temp mail).
    """
    accounts = config_manager.config.mimo_accounts
    if idx < 0 or idx >= len(accounts):
        raise HTTPException(404, "account not found")

    acc = accounts[idx]
    allow_password = False
    auto_temp_mail = bool(getattr(acc, "mail_jwt", ""))
    session_id = None
    otp_code = None
    try:
        data = await request.json()
        if isinstance(data, dict):
            allow_password = bool(data.get("allow_password") or data.get("use_password"))
            if "auto_temp_mail" in data or "auto_temp_mail_otp" in data:
                auto_temp_mail = bool(data.get("auto_temp_mail") or data.get("auto_temp_mail_otp"))
            session_id = (data.get("session_id") or "").strip() or None
            otp_code = (data.get("otp_code") or data.get("ticket") or "").strip() or None
    except Exception:
        pass
    if request.query_params.get("allow_password") in ("1", "true", "yes"):
        allow_password = True
    if request.query_params.get("auto_temp_mail") in ("0", "false", "no"):
        auto_temp_mail = False
    if request.query_params.get("auto_temp_mail") in ("1", "true", "yes"):
        auto_temp_mail = True

    return await _renew_one_account(
        idx,
        allow_password_fallback=allow_password or auto_temp_mail,
        session_id=session_id,
        otp_code=otp_code,
        auto_temp_mail_otp=auto_temp_mail,
    )


async def _renew_with_temp_mail_otp(acc, session_id: str) -> dict:
    """Send OTP + poll temp mail for NEW code + complete login.

    Requires: acc.email/password/mail_jwt + global temp_mail API config.
    Used for auto-registered accounts after passToken/serviceToken expire.
    """
    from .xiaomi_login import send_pending_email_otp, login_with_password, XiaomiLoginError
    from .temp_mail import wait_for_code, list_parsed_mails, TempMailError

    mail_cfg = _mail_cfg_from_settings()
    if not mail_cfg.is_configured() or not getattr(acc, "mail_jwt", ""):
        return {
            "ok": False,
            "need_otp": True,
            "session_id": session_id,
            "error": "需要邮箱验证码，但未配置临时邮箱或账号缺少 mail_jwt，无法自动取码",
            "auto_otp": False,
        }
    if not acc.email or not acc.password:
        return {
            "ok": False,
            "error": "账号缺少邮箱或密码，无法走 temp-mail 自动重登",
            "auto_otp": False,
        }

    try:
        # Ignore mails already in inbox so we only accept the newly sent OTP
        seen_ids: set = set()
        try:
            for m in await list_parsed_mails(mail_cfg, acc.mail_jwt, limit=30, offset=0):
                mid = m.get("id") or m.get("message_id")
                if mid is not None:
                    seen_ids.add(mid)
        except Exception:
            pass

        await send_pending_email_otp(session_id)
        print(f"[AutoRenew] OTP sent, waiting temp-mail for {acc.email}...")
        code = await wait_for_code(
            mail_cfg,
            acc.mail_jwt,
            timeout=120.0,
            seen_ids=seen_ids,
        )
        print(f"[AutoRenew] got mail code for {acc.email}, completing login...")
        result = await login_with_password(
            acc.email,
            acc.password,
            otp_code=code,
            session_id=session_id,
        )
        if result.get("ok") and result.get("tokens"):
            tokens = result["tokens"]
            saved = await validate_and_save(
                tokens.get("service_token", ""),
                tokens.get("user_id", "") or acc.user_id,
                tokens.get("xiaomichatbot_ph", ""),
                email=acc.email or tokens.get("email", ""),
                password=acc.password,
                pass_token=tokens.get("pass_token", "") or acc.pass_token,
                c_user_id=tokens.get("c_user_id", "") or acc.c_user_id,
                device_id=tokens.get("device_id", "") or acc.device_id,
                auto_renew=True if acc.auto_renew is None else acc.auto_renew,
                mail_jwt=acc.mail_jwt,
                region=acc.region,
            )
            if saved.get("ok"):
                saved["auto_otp"] = True
                saved["via"] = "temp_mail_otp"
            return saved
        return {"ok": False, "error": "验证码登录失败", "data": result, "auto_otp": True}
    except (XiaomiLoginError, TempMailError) as e:
        return {
            "ok": False,
            "error": str(e)[:200],
            "need_otp": True,
            "session_id": session_id,
            "auto_otp": True,
        }
    except Exception as e:
        return {"ok": False, "error": f"自动取码续期失败: {str(e)[:200]}", "session_id": session_id}


async def _renew_one_account(
    idx: int,
    *,
    allow_password_fallback: bool = False,
    session_id: Optional[str] = None,
    otp_code: Optional[str] = None,
    auto_temp_mail_otp: bool = False,
) -> dict:
    """Renew account.

    Default auto path: passToken only.
    When passToken fails and (auto_temp_mail_otp or allow_password_fallback):
      password login; if need_otp and mail_jwt present, auto fetch code from temp mail.
    """
    accounts = config_manager.config.mimo_accounts
    if idx < 0 or idx >= len(accounts):
        return {"ok": False, "error": "account not found"}
    acc = accounts[idx]
    from .xiaomi_login import renew_with_password, login_with_password, XiaomiLoginError

    # Completing a pending OTP for this account's manual renew
    if session_id and otp_code:
        try:
            result = await login_with_password(
                acc.email,
                acc.password,
                otp_code=otp_code,
                session_id=session_id,
            )
        except XiaomiLoginError as e:
            acc.renew_error = str(e)[:200]
            acc.last_renew = _dt.now().strftime("%m-%d %H:%M")
            config_manager.save()
            return {"ok": False, "error": str(e), "need_otp": True, "session_id": session_id}

        if result.get("need_otp"):
            return {"ok": False, **{k: v for k, v in result.items() if k != "ok"}}
        tokens = result.get("tokens") or {}
        return await validate_and_save(
            tokens.get("service_token", ""),
            tokens.get("user_id", "") or acc.user_id,
            tokens.get("xiaomichatbot_ph", ""),
            email=acc.email or tokens.get("email", ""),
            password=acc.password,
            pass_token=tokens.get("pass_token", "") or acc.pass_token,
            c_user_id=tokens.get("c_user_id", "") or acc.c_user_id,
            device_id=tokens.get("device_id", "") or acc.device_id,
            auto_renew=acc.auto_renew,
            mail_jwt=acc.mail_jwt,
            region=acc.region,
        )

    can_password = bool(acc.email and acc.password)
    can_auto_otp = bool(auto_temp_mail_otp and can_password and getattr(acc, "mail_jwt", ""))
    use_password = allow_password_fallback or can_auto_otp

    if not acc.pass_token and not use_password:
        acc.renew_error = "缺少 passToken，自动续期不可用；请手动导入或密码续期"
        acc.last_renew = _dt.now().strftime("%m-%d %H:%M")
        config_manager.save()
        return {
            "ok": False,
            "error": acc.renew_error,
            "need_manual": True,
        }

    try:
        result = await renew_with_password(
            acc.email,
            acc.password,
            device_id=acc.device_id or None,
            pass_token=acc.pass_token,
            user_id=acc.user_id,
            c_user_id=acc.c_user_id,
            allow_password_fallback=use_password,
        )
    except XiaomiLoginError as e:
        acc.is_valid = False
        acc.renew_error = str(e)[:200]
        acc.last_renew = _dt.now().strftime("%m-%d %H:%M")
        config_manager.save()
        return {"ok": False, "error": str(e), "data": e.data, "need_manual": True}

    if result.get("need_otp"):
        otp_sid = result.get("session_id") or ""
        if can_auto_otp and otp_sid:
            auto_res = await _renew_with_temp_mail_otp(acc, otp_sid)
            if auto_res.get("ok"):
                return auto_res
            acc.renew_error = (auto_res.get("error") or "自动取码失败")[:200]
            acc.last_renew = _dt.now().strftime("%m-%d %H:%M")
            config_manager.save()
            return auto_res

        acc.renew_error = "需要邮箱验证码，请点击发送验证码后填写（无 mail_jwt 时不会自动取码）"
        acc.last_renew = _dt.now().strftime("%m-%d %H:%M")
        config_manager.save()
        return {
            "ok": False,
            "need_otp": True,
            "session_id": result.get("session_id"),
            "otp_sent": result.get("otp_sent", False),
            "email": result.get("email") or acc.email,
            "message": result.get("message") or acc.renew_error,
            "user_id": acc.user_id,
            "can_auto_otp": bool(getattr(acc, "mail_jwt", "")),
        }

    tokens = result.get("tokens") or {}
    if not result.get("ok") or not tokens:
        return {"ok": False, "error": "续期失败", "data": result}

    return await validate_and_save(
        tokens.get("service_token", ""),
        tokens.get("user_id", "") or acc.user_id,
        tokens.get("xiaomichatbot_ph", ""),
        email=acc.email or tokens.get("email", ""),
        password=acc.password,
        pass_token=tokens.get("pass_token", "") or acc.pass_token,
        c_user_id=tokens.get("c_user_id", "") or acc.c_user_id,
        device_id=tokens.get("device_id", "") or acc.device_id,
        auto_renew=acc.auto_renew,
        mail_jwt=acc.mail_jwt,
        region=acc.region,
    )


@router.post("/api/accounts/renew-all")
async def renew_all_accounts(username: str = Depends(verify_admin)):
    """Renew all: passToken first; if fail and mail_jwt present, auto password+temp-mail OTP."""
    results = []
    for i, acc in enumerate(list(config_manager.config.mimo_accounts)):
        if not acc.auto_renew:
            results.append({"idx": i, "user_id": acc.user_id, "skipped": True, "reason": "auto_renew off"})
            continue
        if not acc.pass_token and not (acc.email and acc.password and getattr(acc, "mail_jwt", "")):
            results.append({
                "idx": i,
                "user_id": acc.user_id,
                "skipped": True,
                "reason": "no passToken and no mail_jwt password path",
            })
            continue
        r = await _renew_one_account(
            i,
            allow_password_fallback=False,
            auto_temp_mail_otp=True,
        )
        results.append({"idx": i, "user_id": acc.user_id, **r})
    return {"results": results}


@router.delete("/api/accounts/{idx}")
async def delete_account(idx: int, username: str = Depends(verify_admin)):
    accounts = config_manager.config.mimo_accounts
    if idx < 0 or idx >= len(accounts):
        raise HTTPException(404, "account not found")
    removed = accounts.pop(idx)
    config_manager.save()
    return {"ok": True, "removed_user_id": removed.user_id}


@router.post("/api/accounts/{idx}/test")
async def test_account(idx: int, username: str = Depends(verify_admin)):
    """Test account; if auth fails and temp-mail path available, try auto-renew once."""
    accounts = config_manager.config.mimo_accounts
    if idx < 0 or idx >= len(accounts):
        raise HTTPException(404, "account not found")

    from .mimo_client import MimoClient, MimoApiError
    acc = accounts[idx]

    async def _probe():
        client = MimoClient(acc)
        content, _, _ = await client.call_api("hi", False)
        return content

    try:
        content = await _probe()
        acc.is_valid = True
        acc.last_test = _dt.now().strftime("%m-%d %H:%M")
        config_manager.save()
        return {"ok": True, "response": (content or "")[:200]}
    except MimoApiError as e:
        # serviceToken 失效：有 mail_jwt 则自动 passToken/密码+temp-mail 续期后再测
        can_auto = bool(
            getattr(acc, "auto_renew", True)
            and (
                getattr(acc, "pass_token", "")
                or (
                    acc.email
                    and acc.password
                    and getattr(acc, "mail_jwt", "")
                )
            )
        )
        if e.status_code in (401, 403) and can_auto:
            renew = await _renew_one_account(
                idx,
                allow_password_fallback=False,
                auto_temp_mail_otp=True,
            )
            if renew.get("ok"):
                # reload account after save
                acc = config_manager.config.mimo_accounts[idx]
                try:
                    content = await _probe()
                    acc.is_valid = True
                    acc.last_test = _dt.now().strftime("%m-%d %H:%M")
                    config_manager.save()
                    return {
                        "ok": True,
                        "response": (content or "")[:200],
                        "auto_renewed": True,
                        "via": renew.get("via") or "renew",
                    }
                except Exception as e2:
                    acc.is_valid = False
                    config_manager.save()
                    return {
                        "ok": False,
                        "error": f"续期后仍失败: {str(e2)[:120]}",
                        "auto_renewed": True,
                    }
            acc.is_valid = False
            acc.last_test = _dt.now().strftime("%m-%d %H:%M")
            config_manager.save()
            return {
                "ok": False,
                "error": f"HTTP {e.status_code}: {e.response_body[:80]}",
                "renew_error": renew.get("error") or renew.get("message"),
            }
        acc.is_valid = False
        acc.last_test = _dt.now().strftime("%m-%d %H:%M")
        config_manager.save()
        return {"ok": False, "error": f"HTTP {e.status_code}: {e.response_body[:100]}"}
    except Exception as e:
        acc.is_valid = False
        config_manager.save()
        return {"ok": False, "error": str(e)[:200]}


