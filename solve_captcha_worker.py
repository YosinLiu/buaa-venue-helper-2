#!/usr/bin/env python3

import base64
import json
import sys

from solve_captcha import load_models, solve_with_models


def send(payload):
    sys.stdout.write(json.dumps(payload, ensure_ascii=False) + "\n")
    sys.stdout.flush()


def main():
    det, ocr_cls, ocr_targeted_cls = load_models()
    send({"type": "ready"})

    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue

        request_id = None
        try:
            payload = json.loads(line)
            request_id = payload.get("id")
            image_base64 = payload.get("image_base64")
            targets = payload.get("targets") or []
            mode = payload.get("mode") or "original"

            if not image_base64:
                raise ValueError("缺少 image_base64")
            if not isinstance(targets, list) or not targets:
                raise ValueError("缺少 targets")

            image_bytes = base64.b64decode(image_base64)
            result = solve_with_models(
                targets,
                det,
                ocr_cls,
                ocr_targeted_cls,
                mode=mode,
                image_bytes=image_bytes,
            )
            send({"id": request_id, **result})
        except Exception as exc:
            send({"id": request_id, "coords": [], "found": [], "error": str(exc)})


if __name__ == "__main__":
    main()
