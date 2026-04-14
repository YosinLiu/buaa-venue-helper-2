#!/usr/bin/env python3
"""
验证码目标字定位脚本（供 reserve.js 通过 execFile 调用）

用法:
  python3 solve_captcha.py --image /path/captcha.png --targets 字1 字2 字3

输出 JSON（stdout）:
  {"coords": [[x1,y1],[x2,y2],[x3,y3]], "found": [true,false,true], "error": null}
  - coords: 截图像素坐标（与超级鹰同单位，reserve.js 用 x/dpr 转 CSS 像素）
  - found: 每个目标字是否找到
  - 找不到的字对应 coords 元素为 null
"""

import sys
import os
import io
import json
import argparse
import warnings

warnings.filterwarnings("ignore")
os.environ["PADDLE_PDX_DISABLE_MODEL_SOURCE_CHECK"] = "True"

import cv2
import ddddocr
import numpy as np
from PIL import Image
from PIL import ImageOps

# 图片中上部图片区与下部提示区的分界比例
IMG_AREA_RATIO = 0.75
COLOR_FILTER_COLORS = ["red", "blue", "green", "yellow", "orange", "purple", "cyan"]
PROB_AGG_ASSIGN_THRESHOLD = 0.02
_ORT_DLLS_PRELOADED = False


def truthy_env(name):
    return os.environ.get(name, "").strip().lower() in {"1", "true", "yes", "on"}


def ddddocr_use_gpu():
    return truthy_env("DDDDOCR_USE_GPU")


def ddddocr_device_id():
    try:
        return int(os.environ.get("DDDDOCR_DEVICE_ID", "0"))
    except ValueError:
        return 0


def preload_onnxruntime_cuda_dlls():
    global _ORT_DLLS_PRELOADED
    if _ORT_DLLS_PRELOADED or not ddddocr_use_gpu():
        return

    import onnxruntime

    onnxruntime.preload_dlls(directory="")
    _ORT_DLLS_PRELOADED = True


def make_ddddocr(**kwargs):
    kwargs.setdefault("show_ad", False)
    if ddddocr_use_gpu():
        preload_onnxruntime_cuda_dlls()
        kwargs.setdefault("use_gpu", True)
        kwargs.setdefault("device_id", ddddocr_device_id())
    return ddddocr.DdddOcr(**kwargs)


def first_cjk(text):
    for ch in text:
        if "\u4e00" <= ch <= "\u9fff":
            return ch
    return ""


def classify_variants(ocr_cls, pil_crop):
    gray = ImageOps.grayscale(pil_crop)
    variants = [
        pil_crop,
        pil_crop.resize((pil_crop.width * 2, pil_crop.height * 2)),
        gray,
        ImageOps.autocontrast(gray),
        gray.point(lambda p: 255 if p > 160 else 0),
    ]

    labels = []
    for variant in variants:
        buf = io.BytesIO()
        variant.save(buf, format="PNG")
        text = ocr_cls.classification(buf.getvalue()).strip()
        ch = first_cjk(text)
        if ch and ch not in labels:
            labels.append(ch)
    return labels


def pil_to_png_bytes(pil_image):
    buf = io.BytesIO()
    pil_image.save(buf, format="PNG")
    return buf.getvalue()


def official_preprocess_bytes(image_bytes):
    nparr = np.frombuffer(image_bytes, np.uint8)
    img = cv2.imdecode(nparr, cv2.IMREAD_COLOR)
    if img is None:
        return None

    gray = cv2.cvtColor(img, cv2.COLOR_BGR2GRAY)
    _, binary = cv2.threshold(gray, 150, 255, cv2.THRESH_BINARY_INV)
    kernel = np.ones((2, 2), np.uint8)
    opening = cv2.morphologyEx(binary, cv2.MORPH_OPEN, kernel)
    ok, buffer = cv2.imencode(".png", opening)
    if not ok:
        return None
    return io.BytesIO(buffer).getvalue()


def classify_variants_preproc_color(ocr_cls, pil_crop):
    gray = ImageOps.grayscale(pil_crop)
    variants = [
        ("orig", pil_crop),
        ("x2", pil_crop.resize((pil_crop.width * 2, pil_crop.height * 2))),
        ("gray", gray),
        ("auto", ImageOps.autocontrast(gray)),
        ("bin160", gray.point(lambda p: 255 if p > 160 else 0)),
    ]

    best_by_char = {}
    for variant_name, variant in variants:
        bytes_candidates = [(variant_name, pil_to_png_bytes(variant))]
        processed_bytes = official_preprocess_bytes(bytes_candidates[0][1])
        if processed_bytes:
          bytes_candidates.append((f"{variant_name}_prep", processed_bytes))

        for actual_variant_name, variant_bytes in bytes_candidates:
            try:
                result = ocr_cls.classification(variant_bytes, probability=True)
            except Exception:
                continue

            if isinstance(result, dict):
                text = str(result.get("text", "")).strip()
                score = float(result.get("confidence", 0.0) or 0.0)
            else:
                text = str(result).strip()
                score = 0.0

            ch = first_cjk(text)
            if ch and (ch not in best_by_char or score > best_by_char[ch]["score"]):
                best_by_char[ch] = {
                    "score": score,
                    "variant": actual_variant_name,
                    "raw_text": text,
                }

    orig_bytes = pil_to_png_bytes(pil_crop)
    for color in COLOR_FILTER_COLORS:
        try:
            result = ocr_cls.classification(
                orig_bytes,
                probability=True,
                color_filter_colors=[color],
            )
        except Exception:
            continue

        if isinstance(result, dict):
            text = str(result.get("text", "")).strip()
            score = float(result.get("confidence", 0.0) or 0.0)
        else:
            text = str(result).strip()
            score = 0.0

        ch = first_cjk(text)
        if ch and (ch not in best_by_char or score > best_by_char[ch]["score"]):
            best_by_char[ch] = {
                "score": score,
                "variant": f"color_{color}",
                "raw_text": text,
            }

    return list(best_by_char.keys())


def target_raw_scores_from_probability(result, targets):
    charset = result.get("charset", []) if isinstance(result, dict) else []
    probabilities = result.get("probabilities", []) if isinstance(result, dict) else []
    if not charset or not probabilities:
        return {target: 0.0 for target in targets}

    scores = {target: 0.0 for target in targets}
    for target in targets:
        try:
            idx = charset.index(target)
        except ValueError:
            continue
        scores[target] = max(float(step[0][idx]) for step in probabilities)
    return scores


def aggregate_target_scores(
    ocr_cls,
    pil_crop,
    targets,
    include_official_preprocess=False,
    color_filter_colors=None,
):
    gray = ImageOps.grayscale(pil_crop)
    variants = [
        ("orig", pil_crop),
        ("x2", pil_crop.resize((pil_crop.width * 2, pil_crop.height * 2))),
        ("gray", gray),
        ("auto", ImageOps.autocontrast(gray)),
        ("bin160", gray.point(lambda p: 255 if p > 160 else 0)),
    ]

    totals = {target: 0.0 for target in targets}
    best_meta = {
        target: {
            "score": 0.0,
            "variant": "unknown",
            "raw_text": "",
        }
        for target in targets
    }

    def consume_result(result, variant_name):
        raw_text = str(result.get("text", "")).strip() if isinstance(result, dict) else str(result).strip()
        target_scores = target_raw_scores_from_probability(result, targets)
        for target, score in target_scores.items():
            totals[target] += score
            if score > best_meta[target]["score"]:
                best_meta[target] = {
                    "score": score,
                    "variant": variant_name,
                    "raw_text": raw_text,
                }

    for variant_name, variant in variants:
        bytes_candidates = [(variant_name, pil_to_png_bytes(variant))]
        if include_official_preprocess:
            processed_bytes = official_preprocess_bytes(bytes_candidates[0][1])
            if processed_bytes:
                bytes_candidates.append((f"{variant_name}_prep", processed_bytes))

        for actual_variant_name, variant_bytes in bytes_candidates:
            try:
                result = ocr_cls.classification(variant_bytes, probability=True)
            except Exception:
                continue
            consume_result(result, actual_variant_name)

    if color_filter_colors:
        orig_bytes = pil_to_png_bytes(pil_crop)
        for color in color_filter_colors:
            try:
                result = ocr_cls.classification(
                    orig_bytes,
                    probability=True,
                    color_filter_colors=[color],
                )
            except Exception:
                continue
            consume_result(result, f"color_{color}")

    return totals, best_meta


def load_models():
    det = make_ddddocr(det=True, ocr=False)
    ocr_cls = make_ddddocr()
    ocr_targeted_cls = make_ddddocr()
    return det, ocr_cls, ocr_targeted_cls


def match_sequential_regions(targets, regions):
    used = set()
    coords = []
    found = []
    for target in targets:
        exact = [(i, r) for i, r in enumerate(regions)
                 if i not in used and target in r["texts"]]
        partial = [(i, r) for i, r in enumerate(regions)
                   if i not in used and any(target in text for text in r["texts"])]
        cands = exact or partial
        if cands:
            best_i, best_r = cands[0]
            used.add(best_i)
            coords.append([best_r["cx"], best_r["cy"]])
            found.append(True)
        else:
            coords.append(None)
            found.append(False)
    return {"coords": coords, "found": found, "error": None}


def build_probagg_regions(
    targets,
    pil_img,
    upper_boxes,
    ocr_cls,
    include_official_preprocess=False,
    color_filter_colors=None,
    assign_threshold=PROB_AGG_ASSIGN_THRESHOLD,
):
    ocr_cls.set_ranges("".join(dict.fromkeys(targets)))

    box_items = []
    for box in upper_boxes:
        x1, y1, x2, y2 = box
        crop = pil_img.crop(box)
        scores, best_meta = aggregate_target_scores(
            ocr_cls,
            crop,
            targets,
            include_official_preprocess=include_official_preprocess,
            color_filter_colors=color_filter_colors,
        )
        box_items.append(
            {
                "box": box,
                "cx": (x1 + x2) // 2,
                "cy": (y1 + y2) // 2,
                "scores": scores,
                "best_meta": best_meta,
            }
        )

    best_total = -1.0
    best_pick = None

    def dfs(target_idx, used_boxes, total_score, picks):
        nonlocal best_total, best_pick
        if target_idx >= len(targets):
            if total_score > best_total:
                best_total = total_score
                best_pick = list(picks)
            return

        target = targets[target_idx]
        dfs(target_idx + 1, used_boxes, total_score, picks + [(target, None)])

        for box_idx, item in enumerate(box_items):
            if box_idx in used_boxes:
                continue
            score = item["scores"][target]
            if score < assign_threshold:
                continue
            used_boxes.add(box_idx)
            dfs(target_idx + 1, used_boxes, total_score + score, picks + [(target, box_idx)])
            used_boxes.remove(box_idx)

    dfs(0, set(), 0.0, [])

    regions = []
    for target, box_idx in best_pick or []:
        if box_idx is None:
            continue
        item = box_items[box_idx]
        meta = item["best_meta"][target]
        regions.append(
            {
                "text": target,
                "raw_text": meta["raw_text"] or target,
                "score": item["scores"][target],
                "box": item["box"],
                "cx": item["cx"],
                "cy": item["cy"],
                "variant": meta["variant"],
            }
        )
    return regions


def match_probagg_regions(targets, regions):
    coords = []
    found = []
    for target in targets:
        region = next((item for item in regions if item["text"] == target), None)
        if region is None:
            coords.append(None)
            found.append(False)
        else:
            coords.append([region["cx"], region["cy"]])
            found.append(True)
    return {"coords": coords, "found": found, "error": None}


def solve_with_models(
    targets,
    det,
    ocr_cls,
    ocr_targeted_cls=None,
    mode="original",
    image_path=None,
    image_bytes=None,
    image_area_ratio=IMG_AREA_RATIO,
):
    if image_bytes is not None:
        pil_img = Image.open(io.BytesIO(image_bytes))
        img_bytes = image_bytes
    elif image_path:
        pil_img = Image.open(image_path)
        with open(image_path, "rb") as f:
            img_bytes = f.read()
    else:
        raise ValueError("image_path 和 image_bytes 至少要提供一个")

    w, h = pil_img.size
    split_y = int(h * image_area_ratio)

    # 检测上部图片区所有字符框
    upper_boxes = []
    for box in det.detection(img_bytes):
        x1, y1, x2, y2 = box
        cy = (y1 + y2) // 2
        if cy < split_y:
            upper_boxes.append(box)

    if mode in {"original", "preproc_color"}:
        regions = []
        for box in upper_boxes:
            x1, y1, x2, y2 = box
            cy = (y1 + y2) // 2
            pil_crop = pil_img.crop(box)
            texts = classify_variants_preproc_color(ocr_cls, pil_crop) if mode == "preproc_color" else classify_variants(ocr_cls, pil_crop)
            if not texts:
                continue
            regions.append({
                "box": box,
                "texts": texts,
                "text": texts[0],
                "cx": (x1 + x2) // 2,
                "cy": cy,
            })
        return match_sequential_regions(targets, regions)

    if ocr_targeted_cls is None:
        ocr_targeted_cls = make_ddddocr()

    if mode == "original_probagg":
        regions = build_probagg_regions(
            targets,
            pil_img,
            upper_boxes,
            ocr_targeted_cls,
            include_official_preprocess=False,
            color_filter_colors=None,
        )
        return match_probagg_regions(targets, regions)

    if mode == "preproc_color_probagg":
        regions = build_probagg_regions(
            targets,
            pil_img,
            upper_boxes,
            ocr_targeted_cls,
            include_official_preprocess=True,
            color_filter_colors=COLOR_FILTER_COLORS,
        )
        return match_probagg_regions(targets, regions)

    raise ValueError(f"不支持的 mode: {mode}")


def solve(image_path, targets, mode="original", image_area_ratio=IMG_AREA_RATIO):
    det, ocr_cls, ocr_targeted_cls = load_models()
    return solve_with_models(
        targets,
        det,
        ocr_cls,
        ocr_targeted_cls,
        mode=mode,
        image_path=image_path,
        image_area_ratio=image_area_ratio,
    )


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--image", required=True)
    parser.add_argument("--targets", nargs="+", required=True)
    parser.add_argument(
        "--mode",
        choices=["original", "preproc_color", "original_probagg", "preproc_color_probagg"],
        default="original",
    )
    parser.add_argument(
        "--image-area-ratio",
        type=float,
        default=IMG_AREA_RATIO,
        help="只检测图片顶部这个比例的区域；API 原图不含下方提示文字时可设为 1",
    )
    args = parser.parse_args()

    try:
        result = solve(args.image, args.targets, mode=args.mode, image_area_ratio=args.image_area_ratio)
    except Exception as e:
        result = {"coords": [], "found": [], "error": str(e)}

    print(json.dumps(result, ensure_ascii=False))


if __name__ == "__main__":
    main()
