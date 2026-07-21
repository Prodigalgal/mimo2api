"""Proxy pool (VLESS + sing-box) admin API — modular, no god-file."""

from __future__ import annotations

from fastapi import APIRouter, Depends, HTTPException, Request

from .auth import verify_admin
from .config import config_manager
from .proxy_pool import ProxyPoolSettings, ProxyPoolError, proxy_pool

router = APIRouter(prefix="/api/proxy-pool", tags=["proxy-pool"])


def _apply_settings_from_config() -> None:
    cfg = config_manager.get_proxy_pool_settings()
    proxy_pool.configure(
        ProxyPoolSettings(
            enabled=cfg.enabled,
            sub_url=cfg.sub_url,
            listen_port=cfg.listen_port,
            singbox_path=cfg.singbox_path,
            rotate_every=cfg.rotate_every,
            refresh_interval=cfg.refresh_interval,
            connect_retries=getattr(cfg, "connect_retries", 5),
            fetch_sub_each_time=getattr(cfg, "fetch_sub_each_time", True),
        )
    )


@router.get("/config")
async def get_proxy_config(username: str = Depends(verify_admin)):
    pp = config_manager.get_proxy_pool_settings()
    return {"ok": True, "proxy_pool": pp.to_dict(mask=True), "runtime": proxy_pool.status()}


@router.post("/config")
async def save_proxy_config(request: Request, username: str = Depends(verify_admin)):
    try:
        data = await request.json()
    except Exception:
        raise HTTPException(400, "invalid json")
    if not isinstance(data, dict):
        return {"ok": False, "error": "invalid body"}
    payload = data.get("proxy_pool") if isinstance(data.get("proxy_pool"), dict) else data
    pp = config_manager.update_proxy_pool(payload)
    _apply_settings_from_config()
    # if disabled, stop runtime
    if not pp.enabled:
        try:
            proxy_pool.stop()
        except Exception:
            pass
    return {
        "ok": True,
        "proxy_pool": pp.to_dict(mask=True),
        "runtime": proxy_pool.status(),
        "message": "代理池配置已保存",
    }


@router.get("/status")
async def proxy_status(username: str = Depends(verify_admin)):
    _apply_settings_from_config()
    return {"ok": True, **proxy_pool.status()}


@router.post("/start")
async def proxy_start(username: str = Depends(verify_admin)):
    _apply_settings_from_config()
    try:
        st = await proxy_pool.start()
        return {"ok": True, "message": "sing-box 已启动", **st}
    except ProxyPoolError as e:
        return {"ok": False, "error": str(e), **proxy_pool.status()}
    except Exception as e:
        return {"ok": False, "error": str(e)[:300], **proxy_pool.status()}


@router.post("/stop")
async def proxy_stop(username: str = Depends(verify_admin)):
    st = proxy_pool.stop()
    return {"ok": True, "message": "已停止", **st}


@router.post("/refresh")
async def proxy_refresh(username: str = Depends(verify_admin)):
    _apply_settings_from_config()
    try:
        nodes = await proxy_pool.refresh_nodes()
        return {
            "ok": True,
            "message": f"已刷新 {len(nodes)} 个节点",
            **proxy_pool.status(),
        }
    except Exception as e:
        return {"ok": False, "error": str(e)[:300], **proxy_pool.status()}


@router.post("/rotate")
async def proxy_rotate(username: str = Depends(verify_admin)):
    _apply_settings_from_config()
    try:
        st = await proxy_pool.rotate()
        return {"ok": True, "message": f"已切换节点 {st.get('rotated_to')}", **st}
    except Exception as e:
        return {"ok": False, "error": str(e)[:300], **proxy_pool.status()}


@router.post("/test")
async def proxy_test(username: str = Depends(verify_admin)):
    """Fetch sub + start sing-box + request ip via proxy."""
    import httpx

    _apply_settings_from_config()
    try:
        # acquire like register: random node + probe retries
        try:
            url = await proxy_pool.ensure_for_register()
        except Exception:
            await proxy_pool.start()
            url = proxy_pool.proxy_url()
            if url and url.startswith("socks5://"):
                url = url.replace("socks5://", "http://")
        if not url:
            return {"ok": False, "error": "代理未运行", **proxy_pool.status()}
        if url.startswith("socks5://"):
            url = url.replace("socks5://", "http://")
        ok, detail = await proxy_pool.probe_proxy(url)
        if not ok:
            return {
                "ok": False,
                "error": f"节点探测失败: {detail}",
                "proxy_url": url,
                **proxy_pool.status(),
            }
        async with httpx.AsyncClient(
            timeout=25.0,
            proxy=url,
            follow_redirects=True,
        ) as client:
            # try several IP endpoints
            ip = ""
            for u in (
                "https://api.ipify.org?format=json",
                "https://httpbin.org/ip",
            ):
                try:
                    r = await client.get(u)
                    if r.status_code < 400:
                        ip = r.text[:200]
                        break
                except Exception as e:
                    ip = f"err:{e}"
        return {
            "ok": bool(ip) and not str(ip).startswith("err:"),
            "message": "代理连通测试完成",
            "proxy_url": url,
            "egress": ip,
            **proxy_pool.status(),
        }
    except Exception as e:
        return {"ok": False, "error": str(e)[:300], **proxy_pool.status()}
