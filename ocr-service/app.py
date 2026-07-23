from __future__ import annotations

import base64
import binascii
import re
import threading
from typing import Annotated

import ddddocr
from fastapi import FastAPI, HTTPException
from pydantic import BaseModel, Field


class ClassificationRequest(BaseModel):
    image: Annotated[str, Field(min_length=16, max_length=2_000_000)]


class OcrEngine:
    def __init__(self) -> None:
        self._lock = threading.Lock()
        self._engine = ddddocr.DdddOcr(show_ad=False)

    def classify(self, image: bytes) -> str:
        with self._lock:
            raw = self._engine.classification(image)
        return re.sub(r"[^0-9A-Za-z]", "", str(raw or ""))[:12]


app = FastAPI(title="MiMo2API local captcha OCR", docs_url=None, redoc_url=None)
engine = OcrEngine()


@app.get("/healthz")
def healthz() -> dict[str, bool]:
    return {"ok": True}


@app.post("/classify")
def classify(request: ClassificationRequest) -> dict[str, object]:
    encoded = request.image.partition(",")[2] if request.image.startswith("data:") else request.image
    try:
        image = base64.b64decode(encoded, validate=True)
    except (ValueError, binascii.Error) as error:
        raise HTTPException(status_code=400, detail="invalid base64 image") from error
    if not image:
        raise HTTPException(status_code=400, detail="empty image")
    text = engine.classify(image)
    candidates = list(dict.fromkeys([text, text.lower(), text.upper()])) if text else []
    return {"ok": bool(text), "text": text, "candidates": candidates}
