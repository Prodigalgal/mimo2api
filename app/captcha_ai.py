"""AI vision captcha helper (OpenAI-compatible chat completions).

Used as fallback/enhancement when ddddocr fails for Xiaomi image captchas.
Config is user-supplied; do not hardcode API keys in source.
"""

from __future__ import annotations

import base64
import re
from dataclasses import dataclass, asdict
from typing import List, Optional

import httpx


@dataclass
class CaptchaAIConfig:
    enabled: bool = False
    api_base: str = ""
    api_key: str = ""
    model: str = "grok"
    timeout: int = 60

    def normalized(self) -> "CaptchaAIConfig":
        return CaptchaAIConfig(
            enabled=bool(self.enabled),
            api_base=(self.api_base or "").strip().rstrip("/"),
            api_key=(self.api_key or "").strip(),
            model=(self.model or "grok").strip() or "grok",
            timeout=max(15, min(180, int(self.timeout or 60))),
        )

    def is_ready(self) -> bool:
        n = self.normalized()
        return bool(n.enabled and n.api_base and n.api_key)

    def to_dict(self, mask: bool = True) -> dict:
        n = self.normalized()
        d = asdict(n)
        if mask and n.api_key:
            k = n.api_key
            d["api_key"] = (k[:6] + "***" + k[-4:]) if len(k) > 12 else "***"
        d["configured"] = bool(n.api_base and n.api_key)
        return d


_PROMPT_TEXT = (
    "这是小米账号注册用的图片验证码。"
    "可能是扭曲字母数字、中文、或简单字符。"
    "请只输出验证码字符本身，不要空格、不要引号、不要解释。"
    "若看不清，尽量猜测最可能的 3-6 个字符。"
)


def _clean_code(text: str) -> str:
    t = (text or "").strip()
    # take first line / remove common wrappers
    t = t.splitlines()[0].strip() if t else ""
    t = t.strip("`\"' \t")
    # keep CJK + alnum (some captchas are Chinese)
    t = re.sub(r"[^\w\u4e00-\u9fff]", "", t, flags=re.UNICODE)
    return t


async def solve_captcha_with_ai(
    image_bytes: bytes,
    cfg: CaptchaAIConfig,
    *,
    content_type: str = "image/jpeg",
) -> str:
    """Call vision chat completions; return cleaned captcha text or empty."""
    cfg = cfg.normalized()
    if not cfg.is_ready() or not image_bytes:
        return ""
    mime = content_type if content_type.startswith("image/") else "image/jpeg"
    b64 = base64.b64encode(image_bytes).decode("ascii")
    data_url = f"data:{mime};base64,{b64}"
    url = f"{cfg.api_base}/v1/chat/completions"
    payload = {
        "model": cfg.model,
        "messages": [
            {
                "role": "user",
                "content": [
                    {"type": "text", "text": _PROMPT_TEXT},
                    {"type": "image_url", "image_url": {"url": data_url}},
                ],
            }
        ],
        "max_tokens": 32,
        "temperature": 0,
    }
    headers = {
        "Authorization": f"Bearer {cfg.api_key}",
        "Content-Type": "application/json",
    }
    try:
        async with httpx.AsyncClient(timeout=float(cfg.timeout)) as client:
            r = await client.post(url, headers=headers, json=payload)
        if r.status_code >= 400:
            print(f"[CaptchaAI] HTTP {r.status_code}: {r.text[:200]}")
            return ""
        data = r.json()
        content = (
            ((data.get("choices") or [{}])[0].get("message") or {}).get("content")
            or ""
        )
        if isinstance(content, list):
            # some gateways return content parts
            parts = []
            for p in content:
                if isinstance(p, dict) and p.get("type") == "text":
                    parts.append(p.get("text") or "")
                elif isinstance(p, str):
                    parts.append(p)
            content = "".join(parts)
        code = _clean_code(str(content))
        print(f"[CaptchaAI] model={cfg.model} raw={content!r} code={code!r}")
        return code
    except Exception as e:
        print(f"[CaptchaAI] failed: {e}")
        return ""


async def ai_captcha_candidates(
    image_bytes: bytes,
    cfg: CaptchaAIConfig,
    *,
    content_type: str = "image/jpeg",
) -> List[str]:
    code = await solve_captcha_with_ai(image_bytes, cfg, content_type=content_type)
    if not code:
        return []
    out = [code]
    # alnum case variants only
    if re.fullmatch(r"[A-Za-z0-9]+", code):
        for t in (code.lower(), code.upper()):
            if t not in out:
                out.append(t)
    return out
