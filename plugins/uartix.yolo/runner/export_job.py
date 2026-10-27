# -*- coding: utf-8 -*-
"""uartix.yolo 的导出 runner（P175-W6，详设 §5.6）。

还是那条裁定：**不动用户的 `scripts/export_onnx.py` 与 `05_export_onnx.bat`**。
它们只会导 onnx；这里要的是格式矩阵 + `quantize/dynamic/opset/simplify` +
导出后的**体积与一次真实速度**，所以插件自带一个。

两个刻意的选择：

* **不做 `half`**。它在 8.4 里已经被 `quantize` 取代（实测默认表里已经没有 `half` 这个键），
  留着只会让人以为"半精度"是个开关。
* **速度是自己测的，不是引擎报的**。导出后拿导出的那个文件跑一遍 predict 计时——
  端侧真正关心的是"这个文件在这台机器上多少毫秒"，而 `model.export()` 的返回值里没有这个数。
"""
import argparse
import json
import os
import sys
import time


def info(msg):
    print("[信息] " + str(msg), flush=True)


def warn(msg):
    print("[警告] " + str(msg), flush=True)


def die(msg):
    print("[错误] " + str(msg), flush=True)
    sys.exit(1)


def load_yaml(path):
    try:
        import yaml
    except ImportError:
        try:
            from ultralytics.utils import YAML

            return YAML.load(path) or {}
        except Exception as e:  # noqa: BLE001
            die("读不了 %s：没有 pyyaml（%s）" % (path, e))
    with open(path, encoding="utf-8") as f:
        return yaml.safe_load(f) or {}


def setup_env(cfg):
    os.environ["OPENBLAS_NUM_THREADS"] = "1"
    os.environ["KMP_DUPLICATE_LIB_OK"] = "TRUE"
    os.environ["CUDA_MODULE_LOADING"] = "LAZY"
    e = (cfg or {}).get("env") or {}
    proxy = str(e.get("proxy") or "")
    if bool(e.get("proxy_enable", True)) and proxy:
        os.environ["HTTP_PROXY"] = proxy
        os.environ["HTTPS_PROXY"] = proxy
    try:
        sys.stdout.reconfigure(encoding="utf-8")
        sys.stderr.reconfigure(encoding="utf-8")
    except Exception:  # noqa: BLE001
        pass


def sample_sources(data_yaml, n):
    """从数据集的 val 目录里取 n 张图当测速样本。取不到就返回空（测速跳过，不编数字）。"""
    base = os.path.dirname(os.path.abspath(data_yaml)) if data_yaml else ""
    for split in ("val", "train"):
        d = os.path.join(base, "images", split)
        if not os.path.isdir(d):
            continue
        try:
            files = sorted(f for f in os.listdir(d) if f.lower().endswith((".jpg", ".jpeg", ".png")))
        except OSError:
            continue
        if not files:
            continue
        step = max(1, len(files) // max(1, n))
        return [os.path.join(d, f) for f in files[::step][:n]]
    return []


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--weights", required=True)
    ap.add_argument("--format", default="onnx")
    ap.add_argument("--config", default="", help="工作区形状的 yaml：读 env 代理与 export 段的默认值")
    ap.add_argument("--data", default="", help="数据集 data.yaml，测速取样用")
    ap.add_argument("--imgsz", type=int, default=0)
    ap.add_argument("--dynamic", action="store_true")
    ap.add_argument("--simplify", dest="simplify", action="store_true", default=True)
    ap.add_argument("--no-simplify", dest="simplify", action="store_false")
    ap.add_argument("--opset", type=int, default=0)
    ap.add_argument("--quantize", default="", help="16/8/fp16/w8a16…（取代旧的 half/int8）")
    ap.add_argument("--nms", action="store_true", help="把 NMS 融进导出的图（接需要 NMS 的端侧栈时才要）")
    ap.add_argument("--out", default="", help="导出目录（面板给的是 train_runs/export/<时间戳>）")
    ap.add_argument("--warmup", type=int, default=3)
    ap.add_argument("--rounds", type=int, default=10)
    args = ap.parse_args()

    cfg = {}
    if args.config and os.path.exists(args.config):
        cfg = load_yaml(args.config)
    setup_env(cfg)

    ex = cfg.get("export") or {}
    tr = cfg.get("train") or {}
    fmt = (args.format or str(ex.get("format") or "onnx")).strip().lower()
    imgsz = args.imgsz or int(ex.get("imgsz") or tr.get("imgsz") or 640)
    weights = args.weights
    if not os.path.exists(weights):
        die("找不到要导出的权重：%s" % weights)

    out_dir = os.path.abspath(args.out or os.path.dirname(weights))
    os.makedirs(out_dir, exist_ok=True)
    # 引擎默认把产物写在权重旁边；导出目录不是权重目录时，导完搬过来，别把用户的工作区弄乱
    from ultralytics import YOLO

    kw = {"imgsz": imgsz, "dynamic": bool(args.dynamic), "simplify": bool(args.simplify)}
    if args.opset:
        kw["opset"] = args.opset
    if args.quantize:
        kw["quantize"] = args.quantize
    if args.nms:
        # 端到端模型（YOLO26）默认输出免后处理；要接"需要 NMS 的旧端侧栈"时才显式把 NMS 融进图里
        kw["nms"] = True
    info("========== 开始导出 ==========")
    info("权重: %s" % weights)
    info("格式: %s  imgsz=%d  dynamic=%s  simplify=%s  opset=%s  quantize=%s" % (fmt, imgsz, args.dynamic, args.simplify, args.opset or "默认", args.quantize or "无"))
    model = YOLO(weights)
    task = getattr(model, "task", "") or ""
    t0 = time.time()
    produced = model.export(format=fmt, **kw)
    took = round(time.time() - t0, 1)
    produced = str(produced or "")
    if not produced or not os.path.exists(produced):
        die("导出没产出文件（format=%s）" % fmt)
    if os.path.dirname(os.path.abspath(produced)) != out_dir:
        target = os.path.join(out_dir, os.path.basename(produced))
        try:
            os.replace(produced, target)
            produced = target
        except OSError as e:
            warn("产物搬不进导出目录，留在原处：%s" % e)
    produced = produced.replace("\\", "/")
    size = os.path.getsize(produced)
    info("产物: %s（%.1f MB）· 耗时 %.1fs" % (produced, size / 1048576.0, took))

    speed = {"ok": False, "msPerImage": None, "fps": None, "images": 0, "error": ""}
    samples = sample_sources(args.data, max(1, args.rounds))
    if not samples:
        speed["error"] = "取不到测速样本（没给 --data 或数据集里没有图）"
    else:
        try:
            # 显式带上 task：导出的文件（onnx/engine 等）里没有元数据，ultralytics 会猜，
            # 猜错时先打一行 WARNING 再按 detect 解析分割输出 —— 测的是同一个网络，但用户看到的
            # 第一句警告会让人怀疑这个数是不是测错了。源模型的 task 我们是知道的，就别让它猜。
            m2 = YOLO(produced, task=task or None) if task else YOLO(produced)
            for s in samples[: args.warmup]:
                m2.predict(source=s, imgsz=imgsz, verbose=False)
            t1 = time.time()
            for s in samples:
                m2.predict(source=s, imgsz=imgsz, verbose=False)
            ms = (time.time() - t1) * 1000.0 / len(samples)
            speed = {"ok": True, "msPerImage": round(ms, 2), "fps": round(1000.0 / ms, 2) if ms > 0 else None, "images": len(samples), "error": ""}
            info("测速: %.2f ms/图（%d 张，含预处理与后处理）" % (ms, len(samples)))
        except Exception as e:  # noqa: BLE001
            speed["error"] = str(e)[:200]
            warn("测速失败（导出本身已成功）：%s" % speed["error"])

    summary = {
        "ok": True,
        "weights": weights.replace("\\", "/"),
        "format": fmt,
        "file": produced,
        "bytes": size,
        "task": task,
        "imgsz": imgsz,
        "dynamic": bool(args.dynamic),
        "simplify": bool(args.simplify),
        "opset": args.opset or None,
        "quantize": args.quantize or None,
        "exportSec": took,
        "speed": speed,
        "out": out_dir.replace("\\", "/"),
    }
    with open(os.path.join(out_dir, "export.json"), "w", encoding="utf-8") as f:
        json.dump(summary, f, ensure_ascii=False, indent=2)
    print(json.dumps(summary, ensure_ascii=False), flush=True)
    info("========== 导出完成 ==========")


if __name__ == "__main__":
    main()
