# -*- coding: utf-8 -*-
"""uartix.yolo 自带的通用训练 runner（P175-W1，详设 §4.4）。

为什么不改工作区的 `scripts/train.py`：那份脚本是用户手动流水线的一部分（`03_train.bat`
调它），红线是一个字节都不改。它把 `model.train(...)` 的参数逐个硬编码，只认那 20 个键，
面板这次要能设 40 多个参数 —— 所以插件带一个"什么都透传"的 runner。

**两边吃同一份 yaml**，这是"面板能点的命令行也跑得起来"的唯一保证：

    python <插件>/runner/train_job.py --config D:/YOLO-Workspace/train_runs/exp.yaml   # 面板
    python D:/YOLO-Workspace/scripts/train.py --config D:/YOLO-Workspace/train_runs/exp.yaml   # 手动（基准那 20 键）

`--dry-run` 只解析不 import torch：既给自动测试当判据（新参数到底透传了没有），
也是面板上"开跑前先看这次会用哪些参数"的实现。
"""
import argparse
import json
import os
import sys

# 工作区 config.yaml 的 `train:` 段用的是**项目词汇**，ultralytics 用的是**引擎词汇**。
# 只在这一处做翻译，其余键名一律原样透传 —— 面板、yaml、手动脚本三者看到的是同一个名字。
ALIAS = {"weights": "model"}
# 被 ALIAS 吃掉、不该再往下传的键
CONSUMED = set(ALIAS)


def load_yaml(path):
    """读 yaml。pyyaml 不在时退到 ultralytics 自带的加载器（它是 ultralytics 的硬依赖）。"""
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


def info(msg):
    print("[信息] " + str(msg), flush=True)


def warn(msg):
    print("[警告] " + str(msg), flush=True)


def die(msg):
    print("[错误] " + str(msg), flush=True)
    sys.exit(1)


def setup_env(cfg):
    """和 `scripts/common.py:setup_env` 等价：必须在 import torch 之前调用。"""
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


def allowed_keys():
    """引擎当前真的认识的参数名。探测失败就返回 None —— 那时**全量透传**并说明，
    因为"面板写了、引擎不认"最坏的后果是 ultralytics 自己报 unknown argument，
    比面板悄悄把参数丢掉要好。"""
    try:
        from ultralytics.cfg import DEFAULT_CFG_DICT

        return set(DEFAULT_CFG_DICT) | {"data", "model", "task"}
    except Exception as e:  # noqa: BLE001
        warn("读不到 ultralytics 的参数表（%s）：本次把 train: 段的键全部透传" % e)
        return None


def resolve(cfg):
    """config.yaml 形状 → (`model.train(**overrides)` 的参数, 被丢掉的键)。"""
    d = cfg.get("dataset") or {}
    t = dict(cfg.get("train") or {})
    if not t:
        die("这份配置里没有 train: 段：%s" % cfg.get("__path__"))

    out_dir = str(d.get("output_dir") or "").replace("\\", "/")
    data = str(t.get("data") or "").replace("\\", "/")
    if not data:
        if not out_dir:
            die("既没有 train.data，也没有 dataset.output_dir：不知道该用哪个数据集")
        data = out_dir.rstrip("/") + "/data.yaml"

    allow = allowed_keys()
    overrides = {}
    dropped = []
    for k, v in t.items():
        if k == "data":
            continue
        key = ALIAS.get(k, k)
        if k in CONSUMED and key in overrides:
            continue  # 同时写了 weights 和 model：以 model 为准
        if allow is None or key in allow:
            overrides[key] = v
        else:
            dropped.append(k)
    overrides["data"] = data
    if not overrides.get("model"):
        die("没给权重：train.weights / train.model 至少要有一个（面板「基础 → 预训练权重」）")
    return overrides, dropped, data


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--config", required=True)
    ap.add_argument("--dry-run", action="store_true", help="只解析并打印 JSON，不 import torch、不开训")
    ap.add_argument("--root", default="", help="工作区根，只为把「手动怎么跑同一次」这句话说明白；可省")
    args = ap.parse_args()

    path = os.path.abspath(args.config)
    if not os.path.exists(path):
        die("找不到配置：%s" % path)
    cfg = load_yaml(path)
    cfg["__path__"] = path
    cfg["__root__"] = os.path.abspath(args.root) if args.root else ""
    setup_env(cfg)

    overrides, dropped, data = resolve(cfg)
    try:
        import ultralytics

        version = ultralytics.__version__
    except Exception as e:  # noqa: BLE001
        version = ""
        if not args.dry_run:
            die("import ultralytics 失败：%s" % e)

    if args.dry_run:
        # 让 ultralytics 自己的配置机制认一遍：`accepted` 才是"参数真的会生效"的证据，
        # 而不是"我们的过滤器说它认识"。echo 是归一化之后的值——它和 args.yaml 同源。
        engine = {"accepted": None, "error": "", "echo": {}}
        if version:
            try:
                from ultralytics.cfg import get_cfg

                got = get_cfg(overrides=dict(overrides))
                engine = {"accepted": True, "error": "", "echo": {k: getattr(got, k, None) for k in sorted(overrides)}}
            except Exception as e:  # noqa: BLE001
                engine = {"accepted": False, "error": str(e)[:300], "echo": {}}
        print(
            json.dumps(
                {
                    "ok": True,
                    "dry_run": True,
                    "config": path.replace("\\", "/"),
                    "ultralytics": version,
                    "data": data,
                    "data_exists": os.path.exists(data),
                    "model": str(overrides.get("model") or "").replace("\\", "/"),
                    "overrides": overrides,
                    "engine": engine,
                    "dropped": sorted(dropped),
                },
                ensure_ascii=False,
                default=str,
            ),
            flush=True,
        )
        return

    if not os.path.exists(data):
        die("没有找到数据集，先在数据页构建，或双击 02_build_dataset.bat。\n缺少文件: " + data)

    from ultralytics import YOLO

    info("========== 开始训练 ==========")
    info("配置: %s" % path.replace("\\", "/"))
    info("权重: %s" % overrides.get("model"))
    info("数据: %s" % data)
    info(
        "轮次 epochs=%s  分辨率 imgsz=%s  批大小 batch=%s  线程 workers=%s  设备 device=%s"
        % (overrides.get("epochs"), overrides.get("imgsz"), overrides.get("batch"), overrides.get("workers"), overrides.get("device"))
    )
    info("输出目录: %s/%s" % (str(overrides.get("project") or "runs").rstrip("/"), overrides.get("name") or ""))
    info("透传 %d 个参数: %s" % (len(overrides), ", ".join(sorted(overrides))))
    if dropped:
        warn("这些键当前引擎不认，已忽略（不是报错，但也不会生效）: %s" % ", ".join(sorted(dropped)))
    ws = str(cfg.get("__root__") or "").replace("\\", "/")
    if ws:
        info("想手动跑同一份配置：%s/scripts/train.py --config %s" % (ws, path.replace("\\", "/")))

    model = YOLO(str(overrides["model"]))
    model.train(**overrides)

    save_dir = str(model.trainer.save_dir)
    best = os.path.join(save_dir, "weights", "best.pt")
    print("", flush=True)
    info("========== 训练完成 ==========")
    info("最优模型: " + best.replace("\\", "/"))
    info("本次真实参数（复现与对比都读它）: " + os.path.join(save_dir, "args.yaml").replace("\\", "/"))
    info("建议把 best.pt 复制到 models\\delivered\\ 中作为交付版本（面板「部署」页有按钮）。")


if __name__ == "__main__":
    main()
