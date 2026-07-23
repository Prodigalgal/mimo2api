from __future__ import annotations

import base64
import binascii
from io import BytesIO
import re
import threading
from typing import Annotated

import ddddocr
from fastapi import FastAPI, HTTPException
from PIL import Image, ImageEnhance, ImageOps
from pydantic import BaseModel, Field


class ClassificationRequest(BaseModel):
    image: Annotated[str, Field(min_length=16, max_length=2_000_000)]


class OcrEngine:
    def __init__(self) -> None:
        self._lock = threading.Lock()
        self._engine = ddddocr.DdddOcr(show_ad=False)

    def classify(self, image: bytes) -> list[str]:
        variants = [image]
        with Image.open(BytesIO(image)) as source:
            grayscale = ImageOps.autocontrast(ImageOps.grayscale(source))
            variants.extend([
                encode_png(grayscale),
                encode_png(ImageEnhance.Contrast(grayscale).enhance(2.0)),
                encode_png(grayscale.point(lambda value: 255 if value > 110 else 0)),
                encode_png(grayscale.point(lambda value: 255 if value > 165 else 0)),
            ])
        results: list[str] = []
        with self._lock:
            for variant in variants:
                raw = self._engine.classification(variant)
                text = re.sub(r"[^0-9A-Za-z]", "", str(raw or ""))[:12]
                if len(text) >= 3 and text not in results:
                    results.append(text)
        return results


def encode_png(image: Image.Image) -> bytes:
    output = BytesIO()
    image.save(output, format="PNG")
    return output.getvalue()


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
    recognized = engine.classify(image)
    candidates = list(dict.fromkeys(
        variant
        for text in recognized
        for variant in (text, text.lower(), text.upper())
    ))
    return {"ok": bool(candidates), "text": recognized[0] if recognized else "", "candidates": candidates}
