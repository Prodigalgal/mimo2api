"""Xiaomi miverify / passport captcha type classification.

Based on miverify VERIFY_TYPE enums and passport API error payloads.
"""

from __future__ import annotations

from dataclasses import dataclass, asdict
from enum import Enum
from typing import Any, Dict, Optional


class CaptchaKind(str, Enum):
    """High-level captcha categories we care about."""

    IMAGE_CODE = "image_code"  # /pass/getCode 字符图
    SLIDE = "slide"  # 滑块
    CLICK = "click"  # 点选（含九宫格点物体）
    CLICK_WORD = "click_word"  # 点选文字
    CLICK_ICON = "click_icon"  # 点选图标
    GRID = "grid"  # 九宫格类
    RECAPTCHA = "recaptcha"  # Google reCAPTCHA
    RECAPTCHA_INVISIBLE = "recaptcha_invisible"
    SPACE = "space"
    VOICE = "voice"
    REJECT = "reject"  # 直接拒绝 / 风控
    UNKNOWN = "unknown"
    NONE = "none"  # 成功 / 无验证


# miverify VERIFY_TYPE numeric map (from captcha frontend)
_MIVERIFY_NUM = {
    1: CaptchaKind.SLIDE,
    2: CaptchaKind.CLICK,
    3: CaptchaKind.IMAGE_CODE,
    4: CaptchaKind.RECAPTCHA,
    5: CaptchaKind.RECAPTCHA_INVISIBLE,
    6: CaptchaKind.CLICK_WORD,
    7: CaptchaKind.CLICK_ICON,
    8: CaptchaKind.SPACE,
    10: CaptchaKind.VOICE,
}


@dataclass
class CaptchaDiagnosis:
    kind: CaptchaKind
    code: Optional[int] = None
    reason: str = ""
    desc: str = ""
    raw_type: str = ""
    captcha_url: str = ""
    solvable_auto: bool = False  # can current pipeline auto-solve?
    label_zh: str = ""

    def to_dict(self) -> dict:
        d = asdict(self)
        d["kind"] = self.kind.value
        return d


_KIND_LABEL = {
    CaptchaKind.IMAGE_CODE: "图片字符验证码",
    CaptchaKind.SLIDE: "滑块拼图",
    CaptchaKind.CLICK: "点选验证（可能含九宫格）",
    CaptchaKind.CLICK_WORD: "点选文字",
    CaptchaKind.CLICK_ICON: "点选图标/物体（如红绿灯/公交车）",
    CaptchaKind.GRID: "九宫格点选",
    CaptchaKind.RECAPTCHA: "Google reCAPTCHA",
    CaptchaKind.RECAPTCHA_INVISIBLE: "Google 隐形 reCAPTCHA",
    CaptchaKind.SPACE: "空间/轨迹验证",
    CaptchaKind.VOICE: "语音验证",
    CaptchaKind.REJECT: "风控直接拒绝",
    CaptchaKind.UNKNOWN: "未知验证类型",
    CaptchaKind.NONE: "无需验证",
}

# kinds we can try with image OCR / AI vision today
_AUTO_SOLVABLE = {CaptchaKind.IMAGE_CODE}


def label_of(kind: CaptchaKind) -> str:
    return _KIND_LABEL.get(kind, kind.value)


def diagnose_passport_response(data: Optional[dict]) -> CaptchaDiagnosis:
    """Classify captcha / risk from Xiaomi passport JSON (sendEmailRegTicket etc.)."""
    if not data:
        return CaptchaDiagnosis(
            kind=CaptchaKind.UNKNOWN,
            label_zh=label_of(CaptchaKind.UNKNOWN),
        )

    code = data.get("code")
    try:
        code_i = int(code) if code is not None and str(code).lstrip("-").isdigit() else None
    except Exception:
        code_i = None

    reason = str(data.get("reason") or "")
    desc = str(data.get("desc") or data.get("description") or "")
    raw_type = str(data.get("type") or "")
    captcha_url = str(data.get("captchaUrl") or data.get("info") or "")
    blob = f"{reason} {desc} {raw_type} {captcha_url} {data}".lower()

    # success
    if code_i in (0, None) and data.get("result") in (None, "ok", "success"):
        if data.get("result") == "ok" or code_i == 0:
            return CaptchaDiagnosis(
                kind=CaptchaKind.NONE,
                code=code_i,
                reason=reason,
                desc=desc,
                solvable_auto=True,
                label_zh=label_of(CaptchaKind.NONE),
            )

    kind = CaptchaKind.UNKNOWN

    # image captcha (getCode)
    if (
        "getcode" in captcha_url.lower()
        or "icodetype=register" in captcha_url.lower()
        or reason in ("CAPTCHA_VERIFY_ERROR",)
        or code_i in (87001, 70014, 1200212)
    ):
        kind = CaptchaKind.IMAGE_CODE

    # miverify numeric type
    for key in ("verifyType", "verify_type", "captchaType", "captcha_type", "vType"):
        if key in data and data[key] is not None:
            try:
                n = int(data[key])
                if n in _MIVERIFY_NUM:
                    kind = _MIVERIFY_NUM[n]
            except Exception:
                pass
            s = str(data[key]).upper()
            for name, k in (
                ("SLIDE", CaptchaKind.SLIDE),
                ("CLICK_WORD", CaptchaKind.CLICK_WORD),
                ("CLICK_ICON", CaptchaKind.CLICK_ICON),
                ("CLICK", CaptchaKind.CLICK),
                ("RECAPTCHA_INVISIBLE", CaptchaKind.RECAPTCHA_INVISIBLE),
                ("RECAPTCHA", CaptchaKind.RECAPTCHA),
                ("GRID", CaptchaKind.GRID),
                ("SPACE", CaptchaKind.SPACE),
                ("VOICE", CaptchaKind.VOICE),
                ("CAPTCHA", CaptchaKind.IMAGE_CODE),
            ):
                if name in s:
                    kind = k
                    break

    # string heuristics
    if "recaptcha" in blob or "google.com/recaptcha" in blob:
        kind = CaptchaKind.RECAPTCHA_INVISIBLE if "invisible" in blob else CaptchaKind.RECAPTCHA
    elif any(x in blob for x in ("slide", "滑块", "geetest", "gt=")):
        kind = CaptchaKind.SLIDE
    elif any(x in blob for x in ("九宫", "grid", "click_icon", "click icon", "点选", "红绿灯", "公交车")):
        if "word" in blob or "文字" in blob:
            kind = CaptchaKind.CLICK_WORD
        elif "icon" in blob or "图标" in blob:
            kind = CaptchaKind.CLICK_ICON
        else:
            kind = CaptchaKind.GRID if "九宫" in blob or "grid" in blob else CaptchaKind.CLICK
    elif any(x in blob for x in ("请求被拒绝", "access denied", "forbidden", "频率", "too many", "risk")):
        if kind == CaptchaKind.UNKNOWN:
            kind = CaptchaKind.REJECT
    elif code_i in (10017, 70016, 401, 403) and "验证" not in desc:
        kind = CaptchaKind.REJECT

    # Chinese passport short messages
    if desc in ("请求被拒绝", "访问被拒绝") or reason in ("REQUEST_DENIED", "FORBIDDEN"):
        kind = CaptchaKind.REJECT

    return CaptchaDiagnosis(
        kind=kind,
        code=code_i,
        reason=reason,
        desc=desc,
        raw_type=raw_type,
        captcha_url=captcha_url,
        solvable_auto=kind in _AUTO_SOLVABLE,
        label_zh=label_of(kind),
    )


def human_error(diag: CaptchaDiagnosis) -> str:
    """User-facing error with type + next-step hint."""
    base = diag.desc or diag.reason or "验证失败"
    kind = diag.kind
    if kind == CaptchaKind.IMAGE_CODE:
        return f"[{diag.label_zh}] {base}（可自动 OCR/AI 重试）"
    if kind in (
        CaptchaKind.SLIDE,
        CaptchaKind.CLICK,
        CaptchaKind.CLICK_WORD,
        CaptchaKind.CLICK_ICON,
        CaptchaKind.GRID,
    ):
        return (
            f"[{diag.label_zh}] {base} — 当前自动注册仅支持图片字符码，"
            f"已升级为人机交互题，请换代理 IP 或降低频率后重试"
        )
    if kind in (CaptchaKind.RECAPTCHA, CaptchaKind.RECAPTCHA_INVISIBLE):
        return (
            f"[{diag.label_zh}] {base} — 风控要求 Google reCAPTCHA，"
            f"纯 API 暂无法自动完成，请换出口 IP"
        )
    if kind == CaptchaKind.REJECT:
        return f"[{diag.label_zh}] {base} — 可能 IP/设备被限流，建议启用代理池并拉长间隔"
    return f"[{diag.label_zh}] {base}"
