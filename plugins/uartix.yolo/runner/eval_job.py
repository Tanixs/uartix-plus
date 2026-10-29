# -*- coding: utf-8 -*-
"""uartix.yolo 的评估 runner（P175-W5，详设 §5.5）。

和训练 runner 同一条设计：**不改用户的 `scripts/validate_viz.py`**，读同一份 yaml 形状的配置，
把结果写进**插件自己的目录** `train_runs/eval/<时间戳>/`——`runs/` 是用户手动跑出来的产物区，
评估结果混进去会让用户分不清哪些是自己 bat 跑的。

一次 `val` 就把三样都拿到：

* 指标表（按 task 出 `(B)` / `(M)` 两列）；
* 引擎自己画的 `confusion_matrix.png` / `BoxPR_curve.png` / `F1_curve.png`；
* **阈值对照表**——从同一次 val 的 PR 曲线里读，不重复跑 N 遍验证集（那是 N 倍的等待，
  而且和这张表本来要回答的问题无关）。

`--errors` 另外跑一遍 predict，把每张图的可视化与裁剪框存下来，并列出路径：
本地工作流里性价比最高的一环就是"错例拿回标注工具补标"。
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
    """和 `scripts/common.py:setup_env` 等价：必须在 import torch 之前。"""
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


def metric_map(box, mask):
    out = {}
    for src, tag in ((box, "B"), (mask, "M")):
        if src is None:
            continue
        out["precision(%s)" % tag] = float(src.mp)
        out["recall(%s)" % tag] = float(src.mr)
        out["map50(%s)" % tag] = float(src.map50)
        out["map50_95(%s)" % tag] = float(src.map)
    return out


def per_class_rows(box, mask, names):
    """逐类指标：类别名 + P/R/mAP50/mAP50-95（框与掩膜各一套）。

    `names` 是 `model.names`（dict[id -> 名字]）；`Metric` 上的 p/r/ap50/ap 都是按类别 id 排的数组。
    分割任务里掩膜指标挂在 `.seg`，不是 `.mask` —— 这里由调用方传对对象。
    """
    rows = {}
    for tag, src in (("B", box), ("M", mask)):
        if src is None:
            continue
        cols = {
            "precision": getattr(src, "p", None),
            "recall": getattr(src, "r", None),
            "map50": getattr(src, "ap50", None),
            "map5095": getattr(src, "ap", None),
        }
        n = max((len(v) for v in cols.values() if v is not None), default=0)
        for c in range(n):
            if isinstance(names, dict):
                name = str(names.get(c, c))
            elif isinstance(names, (list, tuple)) and c < len(names):
                name = str(names[c])
            else:
                name = str(c)
            row = rows.setdefault(c, {"id": c, "name": name})
            for k, arr in cols.items():
                val = None
                if arr is not None and c < len(arr):
                    try:
                        val = round(float(arr[c]), 4)
                    except Exception:  # noqa: BLE001
                        val = None
                row[k + tag] = val
    return [rows[k] for k in sorted(rows)]


def conf_table(results, want):
    """从这一次 val 的 P/R-Confidence 曲线里取若干 conf 点的精确率 / 召回率。

    曲线是 ultralytics 画 `P_curve.png` / `R_curve.png` 用的同一份数据——所以这张表和图不会互相打脸。
    取数走 `curves_results`：`Metric.curves` 在当前版本里恒为空，早期写法因此永远拿不到表。
    """
    try:
        cr = getattr(results, "curves_results", None) or []
        if len(cr) < 4:
            return []
        import numpy as np

        xs = np.asarray(cr[2][0], dtype=float).reshape(-1)
        p = np.asarray(cr[2][1], dtype=float)
        r = np.asarray(cr[3][1], dtype=float)
        if p.ndim == 2:
            p = p.mean(axis=0)
        if r.ndim == 2:
            r = r.mean(axis=0)
    except Exception as e:  # noqa: BLE001
        warn("读不到 P/R 曲线，阈值表跳过：%s" % e)
        return []
    out = []
    for c in want:
        try:
            idx = int(np.argmin(np.abs(xs - c)))
            out.append({"conf": round(float(xs[idx]), 3), "precision": round(float(p[idx]), 4), "recall": round(float(r[idx]), 4)})
        except Exception:  # noqa: BLE001
            continue
    return out


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--config", required=True, help="和训练同一份 yaml 形状（读 dataset / eval / train 三段）")
    ap.add_argument("--weights", default="", help="要评估的 .pt；留空用配置里的 eval.model 或 train.weights")
    ap.add_argument("--data", default="", help="data.yaml；留空用配置里的 eval.data 或 dataset.output_dir")
    ap.add_argument("--out", default="", help="结果目录（面板给的是 train_runs/eval/<时间戳>）")
    ap.add_argument("--conf", type=float, default=0.25)
    ap.add_argument("--errors", action="store_true", help="额外跑一遍 predict，存可视化与裁剪框，列出错例路径")
    ap.add_argument("--max-errors", type=int, default=40, help="错例最多多少张")
    args = ap.parse_args()

    path = os.path.abspath(args.config)
    if not os.path.exists(path):
        die("找不到配置：%s" % path)
    cfg = load_yaml(path)
    setup_env(cfg)

    ev = cfg.get("eval") or {}
    tr = cfg.get("train") or {}
    ds = cfg.get("dataset") or {}
    weights = args.weights or str(ev.get("model") or tr.get("weights") or "")
    data = args.data or str(ev.get("data") or "")
    if not data and ds.get("output_dir"):
        data = os.path.join(str(ds["output_dir"]).replace("\\", "/"), "data.yaml")
    if not weights:
        die("没给要评估的权重：--weights 或配置里的 eval.model")
    if not data or not os.path.exists(data):
        die("没找到 data.yaml：%s" % data)
    imgsz = int(ev.get("imgsz") or tr.get("imgsz") or 640)
    device = str(ev.get("device") if ev.get("device") is not None else (tr.get("device") or 0))
    workers = int(ev.get("workers") if ev.get("workers") is not None else (tr.get("workers") or 0))

    out_dir = os.path.abspath(args.out or os.path.join(os.path.dirname(path), "eval-" + time.strftime("%Y%m%d-%H%M%S")))
    os.makedirs(out_dir, exist_ok=True)

    from ultralytics import YOLO

    info("========== 开始评估 ==========")
    info("权重: %s" % weights)
    info("数据: %s" % data)
    info("输出: %s" % out_dir.replace("\\", "/"))
    model = YOLO(weights)
    task = getattr(model, "task", "") or ""
    r = model.val(data=data, imgsz=imgsz, conf=args.conf, device=device, workers=workers, plots=True, project=out_dir, name="val", exist_ok=True)

    # SegmentMetrics 的掩膜指标在 `.seg`；早期写法读 `.mask`，分割评估因此只报了框指标
    seg = getattr(r, "seg", None)
    mask = seg if seg is not None else getattr(r, "mask", None)
    metrics = metric_map(getattr(r, "box", None), mask)
    table = conf_table(r, [0.10, 0.15, 0.20, 0.25, 0.30, 0.40, 0.50, 0.60, 0.70, 0.80])
    val_dir = os.path.join(out_dir, "val")
    pngs = [f for f in ("confusion_matrix.png", "BoxPR_curve.png", "F1_curve.png", "P_curve.png", "R_curve.png") if os.path.exists(os.path.join(val_dir, f))]

    errors = []
    if args.errors:
        info("========== 错例回收 ==========")
        src = os.path.join(os.path.dirname(data), "images", "val")
        if not os.path.isdir(src):
            warn("找不到验证图目录，跳过错例：%s" % src)
        else:
            pr = model.predict(
                source=src,
                imgsz=imgsz,
                conf=args.conf,
                device=device,
                workers=workers,
                visualize=True,
                save_crop=True,
                project=out_dir,
                name="errors",
                exist_ok=True,
                stream=True,
            )
            for res in pr:
                if len(errors) >= args.max_errors:
                    break
                cls = res.boxes.cls.tolist() if res.boxes is not None else []
                errors.append({"image": str(res.path or "").replace("\\", "/"), "boxes": len(cls), "names": sorted({model.names[int(i)] for i in cls})})
            with open(os.path.join(out_dir, "errors.txt"), "w", encoding="utf-8") as f:
                f.write("\n".join(e["image"] for e in errors))
            info("错例清单: %s" % os.path.join(out_dir, "errors.txt").replace("\\", "/"))

    summary = {
        "ok": True,
        "weights": str(weights).replace("\\", "/"),
        "data": str(data).replace("\\", "/"),
        "task": task,
        "imgsz": imgsz,
        "conf": args.conf,
        "out": out_dir.replace("\\", "/"),
        "metrics": metrics,
        "perClass": per_class_rows(getattr(r, "box", None), mask, getattr(model, "names", {})),
        "confTable": table,
        "plots": pngs,
        "errors": errors,
        "speedMs": float(sum(r.speed.values())) if getattr(r, "speed", None) else None,
    }
    with open(os.path.join(out_dir, "eval.json"), "w", encoding="utf-8") as f:
        json.dump(summary, f, ensure_ascii=False, indent=2)
    # 结果也留一份到 train_runs/ 顶层的清单里，方便和实验列表对齐
    print(json.dumps(summary, ensure_ascii=False), flush=True)
    info("========== 评估完成 ==========")
    for k in sorted(metrics):
        info("%s = %.4f" % (k, metrics[k]))
    info("结果目录: " + out_dir.replace("\\", "/"))


if __name__ == "__main__":
    main()
