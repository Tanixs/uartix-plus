/**
 * YOLO 训练工作台 · 插件侧（uartix.yolo）
 *
 * ## 它是什么
 *
 * 把工作区里**已经跑通过**的那套脚本（`scripts/build_dataset.py` / `train.py`）包成一个面板：
 * 参数在面板里改，插件生成一份「本次运行」的 config.yaml，起 python 子进程，把 stdout 逐行
 * 解析成进度与日志推给界面。
 *
 * ## 四个刻意的决定
 *
 * 1. **不重新实现训练**。工作区里那套脚本跑出过 mAP50 = 0.995，重写等于用新 bug 换旧逻辑。
 *    插件只做三件它们不做的事：参数集中、进度可视化、失败能看见原因。
 *
 * 2. **不覆盖工作区的 config.yaml**。那份文件是用户自己的唯一真相（README 第 13 行写着
 *    "唯一需要修改的文件"）。插件把合并结果写到 `train_runs/<实验名>-<时间>.yaml`，
 *    原文件只读。想恢复默认就删 `.uartix/yolo/config.json`。
 *
 * 3. **进度只解析脚本真的会打印的东西**。`build_dataset.py` 的 `[信息] 合计 N 个样本`、
 *    `[信息] 划分完成: 训练集 X 张 / 验证集 Y 张`，以及 ultralytics 的 `  12/300  ...` 行。
 *    不去猜"大概到哪了"——猜出来的进度条比没有更糟。
 *
 * 4. **新参数走插件自带的 runner，不改用户的 `scripts/train.py`**（P175-W1）。那份脚本把
 *    `model.train(...)` 的参数逐个硬编码、只认 20 个键；面板现在能设 40 多个，改它就越了
 *    "手动流水线一个字不动"的红线。所以 `runner/train_job.py` 在插件包里，读**同一份 yaml**
 *    并把引擎认识的键全部透传。手动那条路仍然成立：同一份 yaml 交给 `scripts/train.py`
 *    跑得出基准那 20 个键——面板的日志里两条命令都打出来，用户愿意用哪条都用哪条。
 *
 * ## 参数为什么不写死
 *
 * 面板上那张参数表来自 `probeParams()`：让当前那套 ultralytics 自己吐 `DEFAULT_CFG_DICT`。
 * 手抄的表一定会过期——本机实测 `half` 已经没了、`mratio` 改叫 `mask_ratio`，
 * 而过期的表表现为"面板能填、引擎不认"或者"引擎有、面板没入口"。包里没这个键 ⇒ 不渲染。
 *
 * ## 关于权限边界（写给后来的人）
 *
 * 本插件起的 python 子进程**不受** `--allow-fs-write` 约束：Node 的权限模型不传递给子进程。
 * 所以这条链上"写是牢笼"只对插件自己的 `ctx.fs` 成立，子进程那一段是**知情**（批准卡上写着
 * "运行 python"）。这一点在 P174 详设 §10 里就是明写的，别在这里偷偷加一层假护栏。
 */

import fs from "node:fs";
import http from "node:http";
import https from "node:https";
import net from "node:net";
import { createHash } from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";

const PANEL = "train";
/** 插件包自己的目录：runner 跟着包走，不写死任何用户机器上的绝对路径。 */
const PKG_DIR = path.dirname(fileURLToPath(import.meta.url));
/** 插件自带的通用训练 runner（P175-W1）：新参数从这里透传给 ultralytics。 */
const RUNNER = "runner/train_job.py";
/** 插件自己的状态目录（相对工作区）。只放本次运行的配置与快照。 */
const STATE_DIR = ".uartix/yolo";
/**
 * 第三层：每次实验的完整 yaml 快照（详设 §4.1）。
 * 单独一个目录、不塞进 `runs/`——`runs/` 是 ultralytics 的产物区，混进去会让用户
 * 分不清哪些是自己 bat 跑出来的。
 */
const RUNS_DIR = "train_runs";
/**
 * 标注投料口（用户自己标，面板只登记不生产）。
 * 里面放 X-AnyLabeling 导出的目录，一个子目录 = 一批素材；面板只数列数、永不写永不删。
 */
const INTAKE_DIR = "annotations";
/**
 * 起 python 必带的环境。两条都是端到端试用真撞出来的，不是防御性摆设：
 * - `PYTHONIOENCODING/PYTHONUTF8`：Windows 上 python 的 stdout 默认走控制台代码页（这台是 cp936），
 *   而插件按 UTF-8 解 —— 中文类别名会变成 `Բ` 这种"看着像字"的垃圾，且不报错。
 * - `YOLO_AUTOINSTALL=false`：ultralytics 缺依赖时默认**自己 pip install**。导出后测速那条路
 *   真触发了 `onnxruntime-gpu` 的自动安装。装东西是用户的事（详设 §3 红线 C 的同一口径），
 *   所以让它缺什么就明确失败，别替用户改环境。
 */
const PY_ENV = { PYTHONIOENCODING: "utf-8", PYTHONUTF8: "1", YOLO_AUTOINSTALL: "false" };
/** 内存里保留多少行日志。界面上限一致，超出丢最旧的。 */
const LOG_KEEP = 4000;

/** P177-A：资产索引、run 记录、路径偏好（都在已有写权限目录内）。 */
const CATALOG_FILE = `${RUNS_DIR}/catalog.json`;
const RUN_META_DIR = `${RUNS_DIR}/runs`;
const PREFS_FILE = `${STATE_DIR}/prefs.json`;
const TRASH_DIR = `${STATE_DIR}/trash`;
const RECENT_MAX = 12;
const RECENT_FIELDS = ["weights", "data", "output_dir", "sources", "calib", "deploy"];
const PLUGIN_VERSION = (() => {
  try {
    return String(JSON.parse(fs.readFileSync(path.join(PKG_DIR, "plugin.json"), "utf8")).version || "");
  } catch {
    return "";
  }
})();

/**
 * 内置默认 = 这台机器上验证过的一套（来自工作区的 config.yaml + README 第四节）。
 * **路径类默认值是空的**：谁的标注目录都不一样，猜一个只会让第一次运行失败在一个莫名其妙的地方。
 */
const DEFAULTS = {
  env: { proxy_enable: true, proxy: "http://127.0.0.1:7897" },
  dataset: {
    sources: [],
    output_dir: "datasets/123lmages_seg",
    val_ratio: 0.15,
    seed: 42,
    classes: ["1", "2", "3"],
    label_map: {},
  },
  train: {
    weights: "models/yolo11n-seg.pt",
    epochs: 300,
    imgsz: 640,
    batch: 16,
    // 本机 16G 内存：多进程加载器会把内存撑爆（README 第六节第 1 条），必须 0
    workers: 0,
    patience: 100,
    device: "0",
    name: "yolo11n_seg_640",
    project: "runs",
    optimizer: "auto",
    cos_lr: true,
    close_mosaic: 20,
    degrees: 10.0,
    // 数字识别禁止镜像（README 第四节：永远别改）
    fliplr: 0.0,
    flipud: 0.0,
    copy_paste: 0.2,
    mixup: 0.0,
    cache: "disk",
    seed: 42,
    save_period: 25,
  },
  // 评估段的默认值：`imgsz/conf/device/workers` 与训练保持一致的读法，
  // `model` / `data` **故意留空**——评估哪枚权重、哪个数据集必须是人点的，不猜。
  eval: { imgsz: 640, conf: 0.25, device: "0", workers: 0 },
};

/* ============================ 参数面（P175-W1，详设 §4.2 / §5.3） ============================ */

/**
 * 参数的**展示元数据**。这一层只回答"怎么摆、怎么说明"，**不回答"有没有这个键"**——
 * 有没有由 `probeParams()` 从当前那套 ultralytics 里读（本机实测 111 键）。
 *
 * 为什么不在这里写一份完整参数表：`half` 已经没了、`mratio` 改叫 `mask_ratio`、
 * `quantize` 是新加的——手抄的表一定会过期，而过期的表现是"面板能填、引擎不认"，
 * 或者反过来"引擎有、面板没有"。包里没这个键 ⇒ 这一项直接不渲染（见 `specFromProbe`）。
 *
 * **刻意不暴露**（别以后手滑加回来）：`box/cls/dfl/pose/kobj/rle/angle` 这些损失权重
 * （26 的 `dfl` 对模型根本无效，`reg_max=1`）、`nms/end2end`（架构决定，不是用户开关）、
 * `save_dir`（由 project+name 推）、`multi_scale/rect/single_cls`、`overlap_mask/mask_ratio`、
 * `distill_model`、`verbose`。`half/int8` 一律不做——已被 `quantize` 取代，那是导出页的事。
 */
const PARAM_META = [
  {
    id: "base",
    title: "基础",
    items: [
      { key: "weights", label: "预训练权重", kind: "text", wide: true, always: true, hint: "yolo11*/yolo26* 的 .pt；相对路径按工作区算" },
      { key: "data", label: "数据集 data.yaml", kind: "text", wide: true, hint: "留空 = 用数据页输出目录里的那份" },
      { key: "epochs", label: "轮次 epochs", kind: "int", min: 1, hint: "训练多少遍" },
      { key: "time", label: "时长上限 time", kind: "num", hint: "按小时封顶；留空 = 只看 epochs" },
      { key: "imgsz", label: "分辨率 imgsz", kind: "int", min: 32, step: 32, hint: "部署端相机是多少就填多少" },
      { key: "batch", label: "批大小 batch", kind: "num", hint: "整数；-1 = 自动挑（AutoBatch）；0.7 = 按显存比例。显存不够就减半" },
      { key: "workers", label: "加载进程 workers", kind: "int", min: 0, hint: "这台 16G 内存保持 0，多进程会把内存撑爆" },
      { key: "patience", label: "早停 patience", kind: "int", min: 1, hint: "连续多少轮没提升就停" },
      { key: "device", label: "设备 device", kind: "text", hint: "0 = 第一块 GPU；cpu = 用 CPU" },
      { key: "name", label: "实验名 name", kind: "text", hint: "产物落在 runs/<name>/" },
      { key: "project", label: "输出总目录 project", kind: "text", wide: true },
      { key: "exist_ok", label: "同名目录继续写 exist_ok", kind: "bool", hint: "开了会往同一个 runs/<name> 里覆盖" },
    ],
  },
  {
    id: "optimizer",
    title: "优化器与学习率",
    items: [
      {
        key: "optimizer",
        label: "优化器",
        kind: "select",
        options: ["auto", "SGD", "MuSGD", "Adam", "AdamW", "NAdam", "RAdam", "RMSProp", "Adamax"],
        hint: "MuSGD 是 YOLO26 的官方配方（要包版本 ≥ 8.4）",
      },
      { key: "lr0", label: "初始学习率 lr0", kind: "num", step: "any", hint: "SGD≈1e-2，Adam/AdamW≈1e-3" },
      { key: "lrf", label: "末端比例 lrf", kind: "num", step: "any", hint: "最终学习率 = lr0 × lrf" },
      { key: "momentum", label: "动量 momentum", kind: "num", step: "any" },
      { key: "weight_decay", label: "权重衰减", kind: "num", step: "any" },
      { key: "warmup_epochs", label: "预热轮数", kind: "num", step: "any" },
      { key: "warmup_momentum", label: "预热动量", kind: "num", step: "any" },
      { key: "warmup_bias_lr", label: "预热 bias lr", kind: "num", step: "any" },
      { key: "cos_lr", label: "余弦学习率 cos_lr", kind: "bool", hint: "长训练更稳" },
    ],
  },
  {
    id: "augment",
    title: "数据增强",
    items: [
      { key: "hsv_h", label: "色相 hsv_h", kind: "frac" },
      { key: "hsv_s", label: "饱和度 hsv_s", kind: "frac" },
      { key: "hsv_v", label: "明度 hsv_v", kind: "frac" },
      { key: "degrees", label: "旋转角度 degrees", kind: "num", hint: "现场拍摄有小倾斜，10 度够用" },
      { key: "translate", label: "平移 translate", kind: "frac" },
      { key: "scale", label: "缩放 scale", kind: "num", step: "any" },
      { key: "shear", label: "剪切 shear", kind: "num" },
      { key: "perspective", label: "透视 perspective", kind: "frac", hint: "数字任务别开大" },
      { key: "flipud", label: "上下翻转 flipud", kind: "frac", warn: "数字/文字识别必须为 0：翻了字就不认识了" },
      { key: "fliplr", label: "左右镜像 fliplr", kind: "frac", warn: "数字/文字识别必须为 0：镜像后字就反了" },
      { key: "bgr", label: "BGR 互换 bgr", kind: "frac" },
      { key: "mosaic", label: "马赛克 mosaic", kind: "frac" },
      { key: "mixup", label: "mixup", kind: "frac" },
      { key: "cutmix", label: "cutmix", kind: "frac" },
      { key: "copy_paste", label: "复制粘贴 copy_paste", kind: "frac", hint: "分割专用增强" },
      { key: "copy_paste_mode", label: "复制粘贴策略", kind: "select", options: ["flip", "mixup"] },
      { key: "close_mosaic", label: "收尾关 mosaic", kind: "int", hint: "最后 N 轮关掉马赛克，稳定收敛；0 = 一直开" },
      { key: "erasing", label: "随机擦除 erasing", kind: "num", step: "any", hint: "数字任务慎用：擦到笔画就漏检" },
      { key: "auto_augment", label: "分类增强策略", kind: "select", options: ["randaugment", "autoaugment", "augmix"], hint: "只对分类任务生效" },
    ],
  },
  {
    id: "finetune",
    title: "微调与迁移",
    items: [
      { key: "freeze", label: "冻结前 N 层 freeze", kind: "int", min: 0, hint: "0 = 全开；数据少、只想换类别时冻前面几层更稳" },
      { key: "pretrained", label: "用预训练权重 pretrained", kind: "bool", hint: "关掉 = 只拿结构从头训（一般不关）" },
      { key: "fraction", label: "只用一部分数据 fraction", kind: "frac", hint: "快速试参数填 0.2，正式训填 1.0" },
    ],
  },
  {
    id: "perf",
    title: "性能与复现",
    items: [
      { key: "cache", label: "图片缓存 cache", kind: "select", options: ["false", "ram", "disk"], hint: "ram 最快但吃内存；这台机器建议 disk 或 false" },
      { key: "amp", label: "混合精度 amp", kind: "bool", hint: "关掉会明显变慢，一般不动" },
      { key: "seed", label: "随机种子 seed", kind: "int", hint: "和工作区配置对齐，固定后每次划分一致" },
      { key: "deterministic", label: "确定性算子 deterministic", kind: "bool", hint: "可复现但更慢" },
      { key: "val", label: "训练时验证 val", kind: "bool", hint: "关掉就没有 mAP 曲线了" },
      { key: "split", label: "评估用哪个 split", kind: "select", options: ["val", "test", "train"] },
      { key: "save", label: "存权重 save", kind: "bool" },
      { key: "save_period", label: "每 N 轮存检查点", kind: "int", hint: "-1 = 只存 best/last" },
      { key: "plots", label: "出图 plots", kind: "bool", hint: "混淆矩阵 / PR 曲线 / train_batch 都靠它" },
    ],
  },
];

/**
 * 参数帮助（P176-B2）：每个引擎键的一句话说明、范围、影响与相关参数。
 *
 * 为什么放在插件而不是 panel.html：参数表本来就是这个文件产出的，
 * 帮助文本跟着它走才能保证「键在、说明就在」。面板只负责把它摆成 tooltip。
 * `one` 控制在 40 字以内；`related` 里的键必须真实存在（面板会过滤一遍）。
 */
const PARAM_HELP = {
  weights: { one: "从哪枚 .pt 开始训；分割任务必须用 -seg 权重。", range: "官方名或任意 .pt 路径", impact: "决定任务类型与收敛速度", related: ["data", "epochs"] },
  data: { one: "data.yaml 的路径；留空就用数据页构建出来的那份。", range: "yaml 路径", impact: "类别与 train/val 划分", related: ["epochs", "imgsz"] },
  epochs: { one: "总共训练多少轮；早停会先于它结束。", range: "≥ 1 的整数", impact: "欠拟合 / 过拟合 / 训练时长", related: ["patience", "time"] },
  time: { one: "按小时封顶，到点就停。", range: "小时；留空 = 只看轮次", impact: "训练时长", related: ["epochs"] },
  imgsz: { one: "输入边长；部署相机是多少就填多少。", range: "32 的倍数", impact: "小目标与推理速度", related: ["batch"] },
  batch: { one: "每步送进显存的图片数。", range: "整数；-1 = 自动；0.7 = 显存比例", impact: "显存 / 稳定性 / 速度", related: ["workers", "cache"] },
  workers: { one: "后台读图的进程数；太少会让 GPU 等数据。", range: "≥ 0 的整数", impact: "GPU 利用率 / 内存", related: ["cache", "batch"] },
  patience: { one: "连续多少轮没提升就早停。", range: "≥ 1 的整数", impact: "训练时长", related: ["epochs"] },
  device: { one: "0 = 第一块 GPU，cpu = 用 CPU。", range: "0 / 1 / cpu", impact: "训练速度", related: ["batch"] },
  name: { one: "实验名，产物落在 runs/<name>/。", range: "字母数字与 - _", impact: "产物目录命名", related: ["project"] },
  project: { one: "所有 run 的父目录。", range: "目录路径", impact: "产物位置", related: ["name"] },
  exist_ok: { one: "同名目录已存在时继续写，不报错。", range: "开 / 关", impact: "旧结果是否被覆盖", related: ["name"] },

  optimizer: { one: "auto 让引擎按模型挑；YOLO26 可用 MuSGD。", range: "auto / SGD / MuSGD / Adam / AdamW…", impact: "收敛速度与稳定性", related: ["lr0", "cos_lr"] },
  lr0: { one: "训练起点的步长，太大震荡、太小收敛慢。", range: "SGD 约 1e-2；AdamW 约 1e-3", impact: "收敛速度与稳定性", related: ["optimizer", "lrf"] },
  lrf: { one: "最终学习率 = lr0 × lrf。", range: "0~1", impact: "末期精细程度", related: ["lr0"] },
  momentum: { one: "历史梯度占多大比重，影响更新惯性。", range: "0~1", impact: "稳定性", related: ["weight_decay"] },
  weight_decay: { one: "抑制权重变大，轻量正则。", range: "≥ 0", impact: "过拟合", related: ["momentum", "lr0"] },
  warmup_epochs: { one: "前几轮把学习率慢慢升上来。", range: "≥ 0 的轮数", impact: "初期稳定性", related: ["warmup_momentum", "warmup_bias_lr"] },
  warmup_momentum: { one: "预热期的动量。", range: "0~1", impact: "初期稳定性", related: ["warmup_epochs"] },
  warmup_bias_lr: { one: "预热期 bias 的学习率。", range: "≥ 0", impact: "初期稳定性", related: ["warmup_epochs"] },
  cos_lr: { one: "学习率按余弦曲线降到末端。", range: "开 / 关", impact: "长训练的末期稳定性", related: ["lr0"] },

  hsv_h: { one: "随机微调色相，模拟不同颜色。", range: "0~1", impact: "颜色泛化", related: ["hsv_s", "hsv_v"] },
  hsv_s: { one: "随机微调饱和度。", range: "0~1", impact: "光照与颜色泛化", related: ["hsv_h", "hsv_v"] },
  hsv_v: { one: "随机微调明暗。", range: "0~1", impact: "光照泛化", related: ["hsv_h", "hsv_s"] },
  degrees: { one: "随机旋转角度；现场有倾斜就开一点。", range: "0~180 度", impact: "倾斜鲁棒性", related: ["shear", "perspective"] },
  translate: { one: "随机平移画面。", range: "0~1", impact: "位置泛化", related: ["scale"] },
  scale: { one: "随机放大缩小目标。", range: "≥ 0", impact: "尺度泛化", related: ["translate", "mosaic"] },
  shear: { one: "斜切变形，模拟拍摄角度偏移。", range: "0~180 度", impact: "视角泛化", related: ["degrees"] },
  perspective: { one: "透视变形；数字/文字任务慎用。", range: "0~0.001", impact: "视角泛化", related: ["degrees"] },
  flipud: { one: "上下翻转；数字/文字被翻反就认不出。", range: "0~1", impact: "数字任务必须为 0", related: ["fliplr"] },
  fliplr: { one: "左右镜像；数字/文字会反过来。", range: "0~1", impact: "数字任务必须为 0", related: ["flipud"] },
  bgr: { one: "随机互换 RGB/BGR 通道。", range: "0~1", impact: "颜色通道鲁棒性", related: ["hsv_h"] },
  mosaic: { one: "四张图拼成一张，增加小目标与上下文。", range: "0~1", impact: "小目标与上下文", related: ["close_mosaic", "mixup"] },
  mixup: { one: "两张图半透明叠加。", range: "0~1", impact: "正则化", related: ["cutmix"] },
  cutmix: { one: "把另一张图的一块贴过来。", range: "0~1", impact: "正则化", related: ["mixup"] },
  copy_paste: { one: "把实例复制粘贴到别处，分割专用。", range: "0~1", impact: "小目标与遮挡", related: ["copy_paste_mode"] },
  copy_paste_mode: { one: "复制粘贴时用 flip 还是 mixup 合成。", range: "flip / mixup", impact: "合成方式", related: ["copy_paste"] },
  close_mosaic: { one: "最后 N 轮关掉马赛克，让模型稳定收敛。", range: "≥ 0 的轮数", impact: "末期稳定性", related: ["mosaic"] },
  erasing: { one: "随机擦掉一块；数字可能被擦掉笔画。", range: "0~1", impact: "数字任务慎用", related: ["hsv_v"] },
  auto_augment: { one: "分类任务的自动增强策略，检测/分割不生效。", range: "randaugment / autoaugment / augmix", impact: "仅分类任务", related: [] },

  freeze: { one: "冻结前 N 层不更新；数据少时更稳。", range: "≥ 0 的层数", impact: "小数据稳定性", related: ["pretrained", "fraction"] },
  pretrained: { one: "从预训练权重开始；关掉就从随机初始化训。", range: "开 / 关", impact: "收敛速度", related: ["weights"] },
  fraction: { one: "只用一部分数据训练。", range: "0~1", impact: "快速试参数", related: ["epochs"] },

  cache: { one: "把图片缓存到内存或磁盘，减少重复读盘。", range: "false / ram / disk", impact: "速度与内存", related: ["workers", "batch"] },
  amp: { one: "混合精度训练，省显存、提速。", range: "开 / 关", impact: "速度与显存", related: ["batch"] },
  seed: { one: "固定数据划分与增强的随机性。", range: "整数", impact: "可复现", related: ["deterministic"] },
  deterministic: { one: "用确定性算子，结果可复现但更慢。", range: "开 / 关", impact: "速度与可复现", related: ["seed"] },
  val: { one: "训练过程中跑验证；关掉就没有 mAP 曲线。", range: "开 / 关", impact: "能否看到指标", related: ["split", "plots"] },
  split: { one: "训练中验证用哪个 split。", range: "val / test / train", impact: "指标口径", related: ["val"] },
  save: { one: "保存 best/last 权重。", range: "开 / 关", impact: "产物", related: ["save_period"] },
  save_period: { one: "每 N 轮额外存一个检查点。", range: "≥ 1；-1 = 只存 best/last", impact: "磁盘占用", related: ["save"] },
  plots: { one: "输出混淆矩阵、PR 曲线与 train_batch 图。", range: "开 / 关", impact: "可解释性", related: ["val"] },
};

/** 探测当前那套 ultralytics 的参数真相。**只 import cfg，不 import torch**（实测约 6 秒，所以不塞进每次刷新）。 */
const PROBE_PY = [
  "import json",
  "import ultralytics",
  "from ultralytics.cfg import DEFAULT_CFG_DICT as D",
  "from ultralytics.cfg import CFG_INT_KEYS, CFG_FLOAT_KEYS, CFG_BOOL_KEYS, CFG_STR_KEYS, CFG_FRACTION_KEYS",
  "t = {}",
  "for src, kind in ((CFG_INT_KEYS,'int'), (CFG_FLOAT_KEYS,'float'), (CFG_BOOL_KEYS,'bool'), (CFG_STR_KEYS,'str'), (CFG_FRACTION_KEYS,'frac')):",
  "    for k in src:",
  "        t.setdefault(k, kind)",
  "o = {'ultralytics': ultralytics.__version__, 'keys': {k: [t.get(k, ''), D[k]] for k in D}}",
  "print(json.dumps(o, ensure_ascii=True, default=str))",
].join("\n");

/** 探测失败时的兜底：只摆"工作区配置里本来就有的那几个键"，并明确告诉用户降级了。 */
const MINIMAL_KEYS = Object.keys(DEFAULTS.train);

let paramProbe = { pyKey: "", done: false, busy: null, ultralytics: "", keys: {}, degraded: false, error: "", source: "" };

/**
 * 元数据 × 探测结果 → 面板能直接渲染的分组。
 * `buildParamSpec(probe)` 是纯函数（测试就是打这里进），运行时用的是同一份逻辑。
 */
function buildParamSpec(probe) {
  const known = (probe && probe.keys) || {};
  const groups = PARAM_META.map((g) => ({
    id: g.id,
    title: g.title,
    items: g.items
      .filter((it) => it.always || (probe && probe.degraded ? MINIMAL_KEYS.includes(it.key) : it.key in known))
      .map((it) => {
        const hit = known[it.key];
        return {
          key: it.key,
          label: it.label,
          kind: it.kind,
          hint: it.hint || "",
          help: PARAM_HELP[it.key] || null,
          warn: it.warn || "",
          wide: !!it.wide,
          options: it.options || null,
          step: it.step !== undefined ? it.step : it.kind === "frac" ? 0.01 : it.kind === "int" ? 1 : "any",
          min: it.min !== undefined ? it.min : it.kind === "frac" ? 0 : null,
          max: it.kind === "frac" ? 1 : it.max !== undefined ? it.max : null,
          // 引擎自己的默认值：面板拿它显示"包里有这一项、值是这么来的"
          engineDefault: hit ? hit[1] : null,
          // 引擎报的类型（int/float/bool/str/frac；多态键与 `weights` 这种工作区词汇是空串）
          type: hit && hit[0] ? hit[0] : "",
        };
      }),
  })).filter((g) => g.items.length);
  return {
    groups,
    count: groups.reduce((n, g) => n + g.items.length, 0),
    // 只有真的探过一次才叫 ready；`specNow()` 在未探时给出空表 + ready:false，面板据此显示"正在读参数表"
    ready: true,
    ultralytics: (probe && probe.ultralytics) || "",
    keyCount: Object.keys(known).length,
    degraded: !!(probe && probe.degraded),
    error: (probe && probe.error) || "",
    source: (probe && probe.source) || "",
  };
}

const specNow = () => (paramProbe.done ? buildParamSpec(paramProbe) : { groups: [], count: 0, ready: false, degraded: false, ultralytics: "", keyCount: 0, error: "", source: "" });

/**
 * 拉参数表。6 秒的子进程，所以：**同一套 python 只探一次**，`state()` 只回缓存，
 * 面板挂载后单独调 `params()` 把它填上——否则每次刷新都卡一下午。
 */
async function probeParams(force) {
  const py = await detectPython();
  const key = `${py.path}|${py.version}`;
  if (!force && paramProbe.done && paramProbe.pyKey === key) return specNow();
  if (paramProbe.busy) return await paramProbe.busy;
  if (!py.ok) {
    paramProbe = {
      pyKey: key,
      done: true,
      busy: null,
      ultralytics: "",
      keys: {},
      degraded: true,
      error: `没有可用的 python（${py.source}：${py.path}）：${py.error}`,
      source: "",
    };
    return specNow();
  }
  paramProbe.busy = (async () => {
    const r = await runOnce(py.path, ["-c", PROBE_PY], 40000);
    if (r.code !== 0) {
      return { ultralytics: "", keys: {}, degraded: true, error: (r.err || r.out || "读不到 ultralytics 的参数表").slice(-300), source: py.source };
    }
    try {
      const v = JSON.parse(r.out.trim().split(/\r?\n/).pop());
      if (!v || !v.keys) throw new Error("输出里没有 keys");
      return { ultralytics: String(v.ultralytics || ""), keys: v.keys, degraded: false, error: "", source: py.source };
    } catch (e) {
      return { ultralytics: "", keys: {}, degraded: true, error: `参数表解析失败：${(e && e.message) || e}`, source: py.source };
    }
  })();
  const got = await paramProbe.busy;
  paramProbe = { pyKey: key, done: true, busy: null, ...got };
  return specNow();
}

/* ============================ 基础设施 ============================ */

let ctx = null;
/** 工作区根（`$WS`）。空串说明用户没在插件面板里登记，所有操作直接给出人话错误。 */
let root = "";

const jobs = new Map();
let seq = 0;
let active = null;

function needWorkspace() {
  if (!root) throw new Error("还没登记工作区根：点面板上的「选择工作区…」，或在 设置 → 插件 顶部选一个目录（就是含 config.yaml 的那个）");
  return root;
}

/**
 * 一次性探针：当前这个插件进程**真的**能写清单里声明的那些目录吗？
 * 读操作不受权限模型限制，所以"绑定改了但没重启"时面板看着好好的，一按构建/训练才炸——
 * 那条 Node 原话（Access to this API has been restricted）没人看得懂，干脆在首屏就说清楚。
 */
let cageProbe = null;
function probeCage() {
  if (cageProbe || !root) return cageProbe;
  const dirs = ["train_runs", "annotations", "datasets", "logs", "models", "runs", ".uartix"];
  const denied = [];
  for (const d of dirs) {
    const p = path.join(root, d);
    const existed = fs.existsSync(p);
    try {
      fs.mkdirSync(p, { recursive: true });
      const f = path.join(p, ".uartix-write-probe");
      fs.writeFileSync(f, "ok");
      fs.rmSync(f, { force: true });
      // 探针不许留下痕迹：目录是它建的、而且空了，就收回去（非空说明本来就有东西，留着）
      if (!existed) {
        try {
          fs.rmdirSync(p);
        } catch {
          /* 非空：本来就有文件，别动 */
        }
      }
    } catch {
      denied.push(d);
    }
  }
  cageProbe = { ok: denied.length === 0, denied };
  return cageProbe;
}
/** Node 权限模型的原话（"Access to this API has been restricted…"）没人看得懂：翻成"重启应用"。 */
function explainCage(e, what) {
  const msg = String((e && e.message) || e);
  if (/Access to this API has been restricted|ERR_ACCESS_DENIED/.test(msg)) {
    return new Error(
      what + "：当前插件进程没有这个位置的写权限。常见原因是刚改过工作区绑定、或刚更新过插件——" +
        "这两样都要重启一次应用才生效（读操作不受影响，所以看着像好的）。",
    );
  }
  return e;
}

/** 相对路径按工作区解析；绝对路径原样（统一成正斜杠：脚本那边到处 .replace("\\","/")）。 */
function abs(p) {
  const s = String(p == null ? "" : p);
  if (!s) return "";
  return (path.isAbsolute(s) ? s : path.join(needWorkspace(), s)).replace(/\\/g, "/");
}

function readJson(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return fallback;
  }
}

function isObj(v) {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/* ============================ P177-A 资产地基 ============================ */

function canWrite() {
  return !!root && probeCage().ok;
}

/** catalog/prefs/run 记录都走这一条：临时文件 + rename，Windows 上 rename 失败就退回复制。 */
function writeJsonAtomic(file, obj) {
  if (!canWrite()) return false;
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const tmp = file + ".tmp";
    fs.writeFileSync(tmp, JSON.stringify(obj, null, 2), "utf8");
    try {
      fs.renameSync(tmp, file);
    } catch {
      fs.copyFileSync(tmp, file);
      fs.rmSync(tmp, { force: true });
    }
    return true;
  } catch {
    return false;
  }
}

const fileHashCache = new Map();
function sha256File(file) {
  try {
    const st = fs.statSync(file);
    const key = `${file}|${st.size}|${st.mtimeMs}`;
    const hit = fileHashCache.get(key);
    if (hit) return hit;
    const h = createHash("sha256").update(fs.readFileSync(file)).digest("hex");
    fileHashCache.set(key, h);
    return h;
  } catch {
    return "";
  }
}

/** 目录体积/文件数/最新 mtime；只 stat，不读内容。 */
function walkStats(dir) {
  let bytes = 0;
  let files = 0;
  let newest = 0;
  const walk = (d) => {
    let ents;
    try {
      ents = fs.readdirSync(d, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of ents) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) {
        walk(p);
        continue;
      }
      try {
        const st = fs.statSync(p);
        bytes += st.size;
        files += 1;
        if (st.mtimeMs > newest) newest = st.mtimeMs;
      } catch {
        /* 文件刚被删 */
      }
    }
  };
  walk(dir);
  return { bytes, files, newest };
}

/** 数据集里的非标准附加物（origin / origin_json_backup / zip / 嵌套 images…）。 */
function datasetExtras(dir) {
  const allowed = new Set(["images", "labels", "data.yaml"]);
  const out = [];
  let ents;
  try {
    ents = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const e of ents) {
    if (allowed.has(e.name)) continue;
    const p = path.join(dir, e.name);
    const st = walkStats(p);
    out.push({ name: e.name, kind: e.isDirectory() ? "dir" : "file", bytes: st.bytes, files: st.files });
  }
  return out;
}

/**
 * 数据集快速指纹：data.yaml + 类别 + 划分 + 图片/标签总字节 + 最新 mtime。
 * 不读 44GB 内容；内容变了 mtime/字节通常会变。完整哈希是后续“冻结”动作的事。
 */
function datasetFingerprintFor(dirIn, dsIn) {
  const dir = abs(dirIn || DEFAULTS.dataset.output_dir);
  const ds = dsIn || scanDataset(dir);
  const img = walkStats(path.join(dir, "images"));
  const lab = walkStats(path.join(dir, "labels"));
  let yaml = "";
  try {
    yaml = fs.readFileSync(path.join(dir, "data.yaml"), "utf8");
  } catch {
    /* 没 data.yaml 也给它一个指纹，状态会标 incomplete */
  }
  const raw = JSON.stringify({
    yaml,
    classes: ds.classes || [],
    train: ds.trainCount || 0,
    val: ds.valCount || 0,
    imgBytes: img.bytes,
    labBytes: lab.bytes,
    newest: Math.max(img.newest, lab.newest),
  });
  return createHash("sha256").update(raw).digest("hex");
}

/* ---- run 记录（train_runs/runs/<run>.json） ---- */

function safeRunName(name) {
  return String(name == null ? "" : name)
    .replace(/[^\w.-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80);
}
function runMetaFile(name) {
  return abs(`${RUN_META_DIR}/${safeRunName(name)}.json`);
}
function readRunMeta(name) {
  if (!name) return null;
  const v = readJson(runMetaFile(name), null);
  return isObj(v) ? v : null;
}
function writeRunMeta(name, patch) {
  if (!name || !canWrite()) return null;
  const file = runMetaFile(name);
  const prev = readJson(file, null);
  const next = {
    schemaVersion: 1,
    run: String(name),
    ...(isObj(prev) ? prev : {}),
    ...(isObj(patch) ? patch : {}),
    updatedAt: new Date().toISOString(),
  };
  writeJsonAtomic(file, next);
  catalogCache.at = 0;
  return next;
}

/** 插件重启时，把没有活进程的 running 记录标成 interrupted（只在可写时落盘）。 */
function reconcileRunMeta() {
  if (!root || !canWrite()) return;
  let names = [];
  try {
    names = fs.readdirSync(abs(RUN_META_DIR)).filter((f) => f.endsWith(".json"));
  } catch {
    return;
  }
  for (const f of names) {
    const meta = readJson(path.join(abs(RUN_META_DIR), f), null);
    if (!isObj(meta) || meta.status !== "running") continue;
    const run = String(meta.run || path.basename(f, ".json"));
    const alive = [...jobs.values()].some((j) => j.runName === run && j.state === "running");
    if (alive) continue;
    writeRunMeta(run, {
      status: "interrupted",
      finishedAt: Date.now(),
      reason: "插件重启时这个任务已经不在（没有活进程）",
      artifacts: meta.artifacts || {},
    });
  }
}

const STATUS_LABEL = {
  running: "运行中",
  succeeded: "完成",
  stopped: "已停止",
  failed: "失败",
  interrupted: "中断",
  external: "外部 run",
  incomplete: "不完整",
};

/**
 * run 状态：插件自己启动的看 sidecar；手动 run 只做“外部/不完整”推断，不冒充中断。
 * profile 来自 runProfile；meta 来自 train_runs/runs/<run>.json。
 */
function runStatusOf(name, profile, meta) {
  const p = profile || {};
  const m = meta || readRunMeta(name);
  const managed = !!m;
  if (m && m.status) {
    let status = String(m.status);
    let why = String(m.reason || "");
    if (status === "running") {
      const alive = [...jobs.values()].some((j) => j.runName === name && j.state === "running");
      if (!alive) {
        status = "interrupted";
        why = why || "插件重启时这个任务已经不在（没有活进程）";
      }
    }
    return { status, label: STATUS_LABEL[status] || status, why, managed };
  }
  if (!p.hasResultsCsv) return { status: "incomplete", label: STATUS_LABEL.incomplete, why: "没有 results.csv（引擎没写出训练记录）", managed: false };
  if (!p.hasBest && !p.hasLast) return { status: "incomplete", label: STATUS_LABEL.incomplete, why: "没有 best.pt / last.pt（权重没落盘）", managed: false };
  const early = Number(p.argsEpochs) > 0 && Number(p.epochs) > 0 && Number(p.epochs) < Number(p.argsEpochs);
  return {
    status: "external",
    label: STATUS_LABEL.external,
    why: early
      ? `外部 run：配置 ${p.argsEpochs} 轮，实际 ${p.epochs} 轮（可能早停/中断，面板没有它的结束记录）`
      : "外部 run：面板没有它的启动/结束记录（可能是手动流水线跑的）",
    managed: false,
  };
}

/* ---- 路径偏好 ---- */

function readPrefs() {
  const raw = readJson(abs(PREFS_FILE), null);
  const recent = {};
  for (const f of RECENT_FIELDS) {
    const arr = raw && raw.recent && Array.isArray(raw.recent[f]) ? raw.recent[f] : [];
    recent[f] = arr
      .filter((x) => isObj(x) && typeof x.path === "string" && x.path.trim())
      .map((x) => ({ ...x, path: x.path.replace(/\\/g, "/"), exists: !!x.exists }))
      .slice(0, RECENT_MAX);
  }
  return {
    schemaVersion: 1,
    recent,
    ...(isObj(raw) && raw.pinned ? { pinned: raw.pinned } : {}),
    // 回收站保留策略：0 = 不自动清理（默认）。只影响"按策略清理"按钮，插件从不自己定时删。
    trashKeepDays: Math.max(0, Number(raw && raw.trashKeepDays) || 0),
    // P178：用哪份插件环境、装在哪、老用户是否优先用自建环境
    runtime: {
      selected: String((raw && raw.runtime && raw.runtime.selected) || ""),
      location: String((raw && raw.runtime && raw.runtime.location) || "workspace"),
      autoPreferPluginEnv: !(raw && raw.runtime && raw.runtime.autoPreferPluginEnv === false),
    },
  };
}

function savePrefs(prefs) {
  return writeJsonAtomic(abs(PREFS_FILE), prefs);
}

/** 记一条最近路径；同一个解析后路径只留最新一条。 */
function rememberPath(field, value, source) {
  const f = String(field || "");
  const v = String(value == null ? "" : value).trim().replace(/\\/g, "/");
  if (!RECENT_FIELDS.includes(f) || !v || !canWrite()) return;
  const prefs = readPrefs();
  const key = abs(v).toLowerCase();
  const old = prefs.recent[f] || [];
  const rest = old.filter((x) => abs(String(x.path || "")).toLowerCase() !== key);
  rest.unshift({ path: v, at: Date.now(), source: String(source || ""), exists: fs.existsSync(abs(v)) });
  prefs.recent[f] = rest.slice(0, RECENT_MAX);
  savePrefs(prefs);
}

function rememberConfigPaths(eff) {
  if (!isObj(eff)) return;
  const train = isObj(eff.train) ? eff.train : {};
  const ds = isObj(eff.dataset) ? eff.dataset : {};
  rememberPath("weights", train.weights, "config");
  rememberPath("data", train.data || (ds.output_dir ? path.join(abs(ds.output_dir), "data.yaml") : ""), "config");
  rememberPath("output_dir", ds.output_dir, "config");
  for (const s of ds.sources || []) rememberPath("sources", s, "config");
}

/* ---- 资产索引 ---- */

/* ---- P177-B 回收站 / 审计 / 引用检查 ---- */

const AUDIT_FILE = `${STATE_DIR}/audit.jsonl`;

function insidePath(parent, child) {
  const p = path.resolve(String(parent || "")).toLowerCase();
  const c = path.resolve(String(child || "")).toLowerCase();
  return !!p && (c === p || c.startsWith(p + path.sep));
}

function ensureInside(parent, child, what) {
  if (!insidePath(parent, child)) throw new Error(`${what}不在允许的目录里：${child}`);
}

function pathBytes(target) {
  try {
    const st = fs.statSync(target);
    if (st.isDirectory()) return walkStats(target);
    return { bytes: st.size, files: 1, newest: st.mtimeMs };
  } catch {
    return { bytes: 0, files: 0, newest: 0 };
  }
}

function auditLog(entry) {
  if (!canWrite()) return;
  try {
    fs.mkdirSync(abs(STATE_DIR), { recursive: true });
    fs.appendFileSync(abs(AUDIT_FILE), JSON.stringify({ at: new Date().toISOString(), ...entry }) + "\n", "utf8");
  } catch {
    /* 审计写不动不挡动作本身 */
  }
}

function readAudit(limit) {
  let text = "";
  try {
    text = fs.readFileSync(abs(AUDIT_FILE), "utf8");
  } catch {
    return [];
  }
  return text
    .split(/\r?\n/)
    .filter(Boolean)
    .slice(-Math.max(1, limit || 40))
    .map((l) => {
      try {
        return JSON.parse(l);
      } catch {
        return null;
      }
    })
    .filter(Boolean)
    .reverse();
}

/**
 * 把目标移进回收站：同盘 rename；跨盘/被占用时退化为复制后删除。
 * `.uartix/yolo/trash/<stamp>/<kind>/<id>/payload` 是原件，`.trash.json` 是账。
 */
function moveToTrash(target, meta) {
  if (!canWrite()) throw new Error("当前是只读模式：能看资产，不能删除");
  const full = path.resolve(String(target || ""));
  const ws = path.resolve(root);
  ensureInside(ws, full, "要回收的东西");
  if (!fs.existsSync(full)) throw new Error(`文件已经不在：${full}`);
  const stamp = new Date().toISOString().replace(/[-:TZ.]/g, "").slice(0, 14) + "-" + Math.random().toString(36).slice(2, 6);
  const kind = String(meta.kind || "file").replace(/[^\w.-]+/g, "-");
  const id = String(meta.id || path.basename(full)).replace(/[^\w.-]+/g, "-").slice(0, 80) || "item";
  const entryDir = path.join(abs(TRASH_DIR), stamp, kind, id);
  const dest = path.join(entryDir, "payload");
  const st = pathBytes(full);
  fs.mkdirSync(entryDir, { recursive: true });
  try {
    fs.renameSync(full, dest);
  } catch {
    // 跨盘或文件被占用：复制后删除。32G 数据集通常同盘，走不到这里。
    fs.cpSync(full, dest, { recursive: true, force: true });
    fs.rmSync(full, { recursive: true, force: true });
  }
  const record = {
    schemaVersion: 1,
    id: `${stamp}-${kind}-${id}`,
    kind,
    target: id,
    name: String(meta.name || path.basename(full)),
    originalPath: full.replace(/\\/g, "/"),
    bytes: st.bytes,
    files: st.files,
    refs: isObj(meta.refs) ? meta.refs : {},
    reason: String(meta.reason || ""),
    cascade: !!meta.cascade,
    deletedAt: new Date().toISOString(),
    restoredAt: "",
    entryDir: entryDir.replace(/\\/g, "/"),
    payload: dest.replace(/\\/g, "/"),
  };
  writeJsonAtomic(path.join(entryDir, ".trash.json"), record);
  auditLog({ action: "trash", kind: record.kind, id: record.id, path: record.originalPath, bytes: record.bytes, cascade: record.cascade });
  return record;
}

/** 按保留策略清理回收站：**只在你点按钮时执行**，插件从不自己定时删。 */
function purgeOldTrash(keepDays, confirm) {
  if (!canWrite()) throw new Error("当前是只读模式：不能永久删除");
  if (String(confirm || "") !== "清理过期") throw new Error("永久删除要二次确认：确认文本必须是「清理过期」");
  const days = Math.max(0, Number(keepDays) || 0);
  if (!days) throw new Error("保留策略是「不自动清理」：先把天数设成 30 或 90，再点清理");
  const cut = Date.now() - days * 86400000;
  const old = listTrash().filter((e) => e.at && e.at < cut);
  let bytes = 0;
  for (const e of old) {
    try {
      fs.rmSync(abs(e.dir), { recursive: true, force: true });
      bytes += Number(e.bytes) || 0;
      auditLog({ action: "purge", kind: e.kind, id: e.id, path: e.originalPath, bytes: e.bytes, reason: `超过 ${days} 天` });
    } catch {
      /* 一条失败继续下一条 */
    }
  }
  return { ok: true, purged: old.length, bytes, keepDays: days };
}

function listTrash() {
  const base = abs(TRASH_DIR);
  const out = [];
  const walk = (d, depth) => {
    if (depth > 4) return;
    let ents = [];
    try {
      ents = fs.readdirSync(d, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of ents) {
      const p = path.join(d, e.name);
      if (e.isFile() && e.name === ".trash.json") {
        const meta = readJson(p, null);
        if (isObj(meta)) {
          const st = pathBytes(p.replace(/\.trash\.json$/i, "") + path.sep + "payload");
          out.push({
            ...meta,
            dir: String(meta.entryDir || path.dirname(p)).replace(/\\/g, "/"),
            bytes: Number(meta.bytes) || st.bytes,
            files: Number(meta.files) || st.files,
            at: Date.parse(meta.deletedAt) || 0,
          });
        }
        continue;
      }
      if (e.isDirectory()) walk(p, depth + 1);
    }
  };
  walk(base, 0);
  return out.sort((a, b) => b.at - a.at);
}

function restoreTrash(entryId) {
  if (!canWrite()) throw new Error("当前是只读模式：能看回收站，不能恢复");
  const entry = listTrash().find((x) => x.id === String(entryId || "") || x.dir === String(entryId || ""));
  if (!entry) throw new Error(`回收站里没有这一条：${entryId}`);
  const payload = abs(entry.payload);
  const dest = abs(entry.originalPath);
  if (!fs.existsSync(payload)) throw new Error("回收站里的原件已经不在，恢复不了");
  if (fs.existsSync(dest)) throw new Error(`原路径还被占用：${entry.originalPath}。先把它挪开或改名，再恢复。`);
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  try {
    fs.renameSync(payload, dest);
  } catch {
    fs.cpSync(payload, dest, { recursive: true, force: true });
    fs.rmSync(payload, { recursive: true, force: true });
  }
  const entryDir = path.dirname(payload);
  try {
    fs.rmSync(entryDir, { recursive: true, force: true });
  } catch {
    /* 账留下也不影响恢复结果 */
  }
  auditLog({ action: "restore", kind: entry.kind, id: entry.id, path: entry.originalPath, bytes: entry.bytes });
  return { ok: true, restored: entry.originalPath, kind: entry.kind };
}

function purgeTrash(entryId) {
  if (!canWrite()) throw new Error("当前是只读模式：不能永久删除");
  const entry = listTrash().find((x) => x.id === String(entryId || "") || x.dir === String(entryId || ""));
  if (!entry) throw new Error(`回收站里没有这一条：${entryId}`);
  fs.rmSync(abs(entry.dir), { recursive: true, force: true });
  auditLog({ action: "purge", kind: entry.kind, id: entry.id, path: entry.originalPath, bytes: entry.bytes });
  return { ok: true, purged: entry.id, bytes: entry.bytes };
}

function purgeAllTrash(confirm) {
  if (!canWrite()) throw new Error("当前是只读模式：不能清空回收站");
  if (String(confirm || "") !== "清空") throw new Error("永久删除要二次确认：确认文本必须是「清空」");
  const all = listTrash();
  let bytes = 0;
  for (const e of all) {
    try {
      fs.rmSync(abs(e.dir), { recursive: true, force: true });
      bytes += Number(e.bytes) || 0;
      auditLog({ action: "purge", kind: e.kind, id: e.id, path: e.originalPath, bytes: e.bytes });
    } catch {
      /* 一条失败继续清下一条 */
    }
  }
  return { ok: true, purged: all.length, bytes };
}

/** 外部部署缓存只读统计：只 stat，不碰一个字节。 */
let externalCacheCache = { at: 0, value: null };
function externalCacheStats() {
  if (!root) return null;
  if (externalCacheCache.value && Date.now() - externalCacheCache.at < 10000) return externalCacheCache.value;
  const tool = scanDeployTool();
  if (!tool.bound) return { bound: false, dir: "", items: [], bytes: 0, cleanList: [] };
  const items = [];
  for (const name of ["work", "calib", "out", "deploy"]) {
    const p = path.join(tool.dir, name);
    const st = pathBytes(p);
    if (st.bytes || fs.existsSync(p)) items.push({ name, path: p.replace(/\\/g, "/"), bytes: st.bytes, files: st.files });
  }
  const bytes = items.reduce((n, x) => n + x.bytes, 0);
  const cleanList = items.map((x) => `# 手工清理（插件不执行）：${x.path}  ${(x.bytes / 1024 / 1024).toFixed(1)} MB`);
  const value = { bound: true, dir: tool.dir, items, bytes, cleanList, readOnly: true };
  externalCacheCache = { at: Date.now(), value };
  return value;
}

/**
 * 清理建议只读：每条都带证据（谁引用它、为什么建议），默认不勾选任何危险项。
 * “早停”只作为 info 提示，不放进默认清理清单。
 */
function cleanupSuggestions(catalog, projectIn) {
  const out = [];
  const project = abs(projectIn || DEFAULTS.train.project);
  const models = Object.values(catalog.models || {});
  for (const m of models) {
    if (!Array.isArray(m.paths) || m.paths.length < 2) continue;
    const preferred =
      m.paths.find((p) => !/object-object/i.test(p) && /\/delivered\//i.test(p)) ||
      m.paths.find((p) => !/object-object/i.test(p)) ||
      m.paths[0];
    for (const p of m.paths) {
      if (p === preferred) continue;
      const st = pathBytes(p);
      out.push({
        kind: "model",
        id: m.id,
        name: path.basename(p),
        path: p,
        bytes: st.bytes,
        reason: `同 SHA256 重复副本；保留 ${path.basename(preferred)}`,
        refs: m.refs || {},
        risk: "safe",
        preset: false,
      });
    }
  }
  for (const r of Object.values(catalog.runs || {})) {
    const args = Number(r.argsEpochs) || 0;
    const done = Number(r.epochs) || 0;
    if (args >= 20 && done > 0 && done <= args * 0.5 && (r.status === "external" || r.status === "incomplete" || r.status === "interrupted" || r.status === "failed")) {
      out.push({
        kind: "run",
        id: r.id,
        name: r.name,
        path: r.dir,
        bytes: r.bytes,
        reason: `只跑了 ${done}/${args} 轮（远少于配置）；不是插件启动的记录，不能断言中断`,
        refs: { deployments: r.deploymentIds || [] },
        risk: "warn",
        preset: false,
      });
    } else if (r.status === "external" && args >= 20 && done > args * 0.5 && done < args && r.hasBest) {
      out.push({
        kind: "run",
        id: r.id,
        name: r.name,
        path: r.dir,
        bytes: r.bytes,
        reason: `${done}/${args} 轮，有 best.pt——可能是早停，不是失败；确认不需要再回收`,
        refs: { deployments: r.deploymentIds || [] },
        risk: "info",
        preset: false,
      });
    }
  }
  let runNames = [];
  try {
    runNames = fs.readdirSync(project, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name);
  } catch {
    runNames = [];
  }
  for (const name of runNames) {
    if (catalog.runs && catalog.runs[name]) continue;
    const d = path.join(project, name);
    if (fs.existsSync(path.join(d, "weights", "best.pt")) || fs.existsSync(path.join(d, "results.csv"))) continue;
    const st = walkStats(d);
    out.push({
      kind: "dir",
      id: name,
      name,
      path: d.replace(/\\/g, "/"),
      bytes: st.bytes,
      reason: "不是训练 run（没有 results.csv / 权重），只是占目录",
      refs: {},
      risk: "safe",
      preset: false,
    });
  }
  for (const ds of Object.values(catalog.datasets || {})) {
    for (const x of ds.extras || []) {
      if (!["origin", "origin_json_backup"].includes(x.name) && !/\.zip$/i.test(x.name)) continue;
      out.push({
        kind: "extra",
        id: `${ds.id}::${x.name}`,
        datasetId: ds.id,
        name: x.name,
        path: path.join(ds.dir, x.name).replace(/\\/g, "/"),
        bytes: x.bytes,
        reason: "数据集的 legacy extras：原始素材应在 annotations/，YOLO 标准结构里不该有它",
        refs: { dataset: ds.id },
        risk: "info",
        preset: false,
      });
    }
  }
  const evals = scanEvals(50);
  const exports = scanExports(50);
  const runBest = new Set(Object.values(catalog.runs || {}).map((r) => String(r.best || "").replace(/\\/g, "/").toLowerCase()).filter(Boolean));
  const runWeights = new Set(Object.values(catalog.runs || {}).map((r) => String(r.argsWeights || "").replace(/\\/g, "/").toLowerCase()).filter(Boolean));
  const matchW = (w) => {
    const k = String(w || "").replace(/\\/g, "/").toLowerCase();
    return !!k && (runBest.has(k) || runWeights.has(k));
  };
  for (const e of evals) {
    if (matchW(e.weights)) continue;
    out.push({
      kind: "eval",
      id: e.name,
      name: e.name,
      path: e.dir,
      bytes: pathBytes(e.dir).bytes,
      reason: "评估结果找不到源 run（orphan）；不是当前任何 run 的权重",
      refs: {},
      risk: "info",
      preset: false,
    });
  }
  for (const e of exports) {
    if (matchW(e.weights)) continue;
    out.push({
      kind: "export",
      id: e.name,
      name: e.name,
      path: e.dir,
      bytes: pathBytes(e.dir).bytes,
      reason: "导出结果找不到源 run（orphan）",
      refs: {},
      risk: "info",
      preset: false,
    });
  }
  return out;
}

/** 把一条清理项变成可执行的动作；引用图在这里生效。 */
function planItem(catalog, item, cascade, actions, blocked) {
  const add = (kind, id, target, bytes, refs, reason, isCascade) => {
    const key = path.resolve(target).toLowerCase();
    if (actions.some((a) => path.resolve(a.path).toLowerCase() === key)) return;
    actions.push({ kind, id, path: target.replace(/\\/g, "/"), bytes: Number(bytes) || 0, refs: refs || {}, reason: String(reason || ""), cascade: !!isCascade });
  };
  const block = (why) => blocked.push({ kind: item.kind, id: item.id || item.name || "", path: item.path || "", why: String(why) });
  const kind = String(item.kind || "");
  if (kind === "model") {
    const p = abs(item.path || "");
    ensureInside(abs("models"), p, "模型副本");
    if (!fs.existsSync(p)) return block("文件已经不在");
    const m = Object.values(catalog.models || {}).find((x) => (x.paths || []).some((q) => path.resolve(q).toLowerCase() === path.resolve(p).toLowerCase()));
    if (!m) return block("资产台账里没有这枚模型；刷新一次再试");
    const refs = m.refs || {};
    const other = (m.paths || []).filter((q) => path.resolve(q).toLowerCase() !== path.resolve(p).toLowerCase());
    if (!other.length && ((refs.runs || []).length || (refs.deployments || []).length) && !cascade) {
      return block(`这是唯一副本，仍被 ${(refs.runs || []).join("、") || "run"} / ${(refs.deployments || []).join("、") || "部署包"} 引用；勾选连带或先换掉引用`);
    }
    add("model", m.id, p, pathBytes(p).bytes, refs, item.reason || "模型副本", false);
    if (cascade && !other.length) {
      for (const rid of refs.runs || []) {
        const r = catalog.runs && catalog.runs[rid];
        if (r) planItem(catalog, { kind: "run", id: rid, reason: "被模型引用，连带回收" }, true, actions, blocked);
      }
      for (const did of refs.deployments || []) {
        const d = catalog.deployments && catalog.deployments[did];
        if (d) add("deployment", did, d.dir, d.bytes, {}, "被模型引用，连带回收", true);
      }
    }
    return;
  }
  if (kind === "run") {
    const r = catalog.runs && catalog.runs[item.id];
    if (!r) return block("台账里没有这个 run；刷新一次再试");
    if ((r.deploymentIds || []).length && !cascade) return block(`仍被部署包引用：${r.deploymentIds.join("、")}；勾选连带或先删部署包`);
    add("run", r.id, r.dir, r.bytes, { deployments: r.deploymentIds || [], datasetId: r.datasetId || "" }, item.reason || "训练产物", false);
    if (cascade) for (const did of r.deploymentIds || []) {
      const d = catalog.deployments && catalog.deployments[did];
      if (d) add("deployment", did, d.dir, d.bytes, {}, "被 run 引用，连带回收", true);
    }
    return;
  }
  if (kind === "dataset") {
    const ds = catalog.datasets && catalog.datasets[item.id];
    if (!ds) return block("台账里没有这个数据集；刷新一次再试");
    if ((ds.runIds || []).length && !cascade) return block(`仍被 ${ds.runIds.length} 个 run 引用：${ds.runIds.join("、")}；勾选连带或先删 run`);
    add("dataset", ds.id, ds.dir, ds.bytes, { runs: ds.runIds || [] }, item.reason || "数据集", false);
    if (cascade) for (const rid of ds.runIds || []) {
      const r = catalog.runs && catalog.runs[rid];
      if (r) planItem(catalog, { kind: "run", id: rid, reason: "被数据集引用，连带回收" }, true, actions, blocked);
    }
    return;
  }
  if (kind === "deployment") {
    const d = catalog.deployments && catalog.deployments[item.id];
    if (!d) return block("台账里没有这个部署包");
    add("deployment", d.id, d.dir, d.bytes, {}, item.reason || "部署包副本（外部产物不动）", false);
    return;
  }
  if (kind === "extra") {
    const ds = catalog.datasets && catalog.datasets[item.datasetId];
    if (!ds) return block("数据集不在台账里");
    const name = String(item.name || "");
    if (!(ds.extras || []).some((x) => x.name === name)) return block("这个额外目录已经不在数据集里");
    const target = path.join(ds.dir, name);
    ensureInside(ds.dir, target, "数据集额外目录");
    add("extra", item.id || `${ds.id}::${name}`, target, pathBytes(target).bytes, { dataset: ds.id }, item.reason || "数据集额外目录", false);
    return;
  }
  if (kind === "eval" || kind === "export") {
    const base = abs(`${RUNS_DIR}/${kind === "eval" ? "eval" : "export"}`);
    const p = abs(item.path || "");
    ensureInside(base, p, kind === "eval" ? "评估结果" : "导出结果");
    if (!fs.existsSync(p)) return block("目录已经不在");
    add(kind, item.id || path.basename(p), p, pathBytes(p).bytes, {}, item.reason || "孤儿结果", false);
    return;
  }
  if (kind === "dir") {
    const base = abs(DEFAULTS.train.project);
    const p = abs(item.path || "");
    ensureInside(base, p, "runs 目录");
    if (!fs.existsSync(p)) return block("目录已经不在");
    add("dir", item.id || path.basename(p), p, pathBytes(p).bytes, {}, item.reason || "非 run 目录", false);
    return;
  }
  block(`不认识的清理类型：${kind || "(空)"}`);
}

function cleanupPlan(catalog, items, cascade) {
  const actions = [];
  const blocked = [];
  for (const it of Array.isArray(items) ? items : []) planItem(catalog, isObj(it) ? it : {}, !!cascade, actions, blocked);
  // 先删孩子再删父目录：路径更深的排前面
  actions.sort((a, b) => b.path.split("/").length - a.path.split("/").length || a.path.localeCompare(b.path));
  return { ok: blocked.length === 0, actions, blocked, totalBytes: actions.reduce((n, a) => n + a.bytes, 0) };
}


function listDeploymentBundles() {
  const base = abs(`${RUNS_DIR}/deploy`);
  const out = [];
  let names = [];
  try {
    names = fs.readdirSync(base, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name);
  } catch {
    return out;
  }
  for (const n of names) {
    const d = path.join(base, n);
    const meta = readJson(path.join(d, "deployment.json"), null);
    const st = walkStats(d);
    out.push({
      id: isObj(meta) && meta.id ? String(meta.id) : n,
      name: n,
      dir: d.replace(/\\/g, "/"),
      bytes: st.bytes,
      files: st.files,
      ...(isObj(meta) ? meta : {}),
    });
  }
  return out.sort((a, b) => String(b.createdAt || "").localeCompare(String(a.createdAt || "")));
}

let catalogCache = { at: 0, value: null };

/**
 * 资产索引：文件系统是真相，catalog 只是索引。它可在任意时刻重建；
 * 只读模式只返回内存结果，不写盘。
 */
async function catalogBuild(force) {
  if (!root) return { schemaVersion: 1, updatedAt: new Date().toISOString(), datasets: {}, runs: {}, models: {}, deployments: {}, trash: [], storage: {}, readOnly: true };
  if (!force && catalogCache.value && Date.now() - catalogCache.at < 10000) return catalogCache.value;
  const { effective } = await effectiveConfig();
  const project = effective.train.project;

  const datasets = {};
  const datasetByDir = {};
  for (const d of scanDatasetDirs()) {
    const ds = scanDataset(d.dir);
    const st = walkStats(d.dir);
    const fp = datasetFingerprintFor(d.dir, ds);
    const id = `ds-${String(d.name || "dataset").replace(/[^\w.-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40) || "dataset"}-${fp.slice(0, 8)}`;
    const entry = {
      id,
      name: String(d.name || path.basename(d.dir)),
      dir: d.dir,
      dataYaml: d.dataYaml,
      classes: ds.classes || [],
      splits: { train: ds.trainCount || 0, val: ds.valCount || 0 },
      bytes: st.bytes,
      files: st.files,
      fingerprint: fp,
      extras: datasetExtras(d.dir),
      runIds: [],
      status: ds.exists && (ds.trainCount || ds.valCount) ? "ready" : "incomplete",
      updatedAt: st.newest,
    };
    datasets[id] = entry;
    datasetByDir[d.dir.toLowerCase()] = id;
  }

  const runs = {};
  for (const r of scanRuns(project)) {
    const p = runProfile(project, r.name);
    const meta = readRunMeta(r.name);
    const status = runStatusOf(r.name, p, meta);
    const st = walkStats(p.dir);
    const dataPath = String(p.argsData ? abs(p.argsData) : "").replace(/\\/g, "/");
    const dsDir = dataPath ? path.dirname(dataPath).replace(/\\/g, "/").toLowerCase() : "";
    const datasetId = datasetByDir[dsDir] || "";
    runs[r.name] = {
      id: r.name,
      name: r.name,
      dir: p.dir,
      status: status.status,
      statusLabel: status.label,
      statusWhy: status.why,
      managed: status.managed,
      epochs: p.epochs,
      argsEpochs: p.argsEpochs,
      bestEpoch: p.bestEpoch,
      hasBest: p.hasBest,
      hasLast: p.hasLast,
      bytes: st.bytes,
      files: st.files,
      datasetId,
      datasetName: datasetId ? datasets[datasetId].name : "",
      dataPath,
      argsWeights: String(p.argsWeights || ""),
      best: p.best,
      bestSha: p.best ? sha256File(p.best) : "",
      last: p.last,
      finishedAt: p.finishedAt,
      startedAt: p.startedAt,
      mAP50M: p.mAP50M,
      mAP5095M: p.mAP5095M,
      note: p.note,
      snapshot: meta && meta.snapshot ? String(meta.snapshot) : "",
      log: meta && meta.log ? String(meta.log) : "",
      deploymentIds: [],
    };
    if (datasetId) datasets[datasetId].runIds.push(r.name);
  }

  const models = {};
  const modelByPath = {};
  const modelBySha = {};
  for (const f of scanModels(200)) {
    const sha = sha256File(f.file);
    const key = sha || `path:${f.file}`;
    const origin = /\/models\/delivered\//i.test(f.file) ? "delivered" : /\/models\/pretrained\//i.test(f.file) ? "downloaded" : "local";
    if (!models[key]) {
      const facts = factsFor(f);
      models[key] = {
        id: `mdl-${(sha || key).slice(0, 8)}`,
        sha256: sha,
        bytes: f.bytes,
        paths: [],
        task: (facts && facts.task) || f.task || "",
        family: f.family || "",
        scale: f.scale || "",
        nc: facts && facts.nc != null ? facts.nc : null,
        names: [],
        origin,
        sourceRun: "",
        license: "",
        refs: { runs: [], deployments: [] },
        verifiedAt: 0,
      };
    }
    const m = models[key];
    if (!m.paths.includes(f.file)) m.paths.push(f.file);
    if (!m.bytes) m.bytes = f.bytes;
    modelByPath[f.file.toLowerCase()] = key;
  }
  for (const r of Object.values(runs)) {
    if (r.bestSha && models[r.bestSha]) {
      models[r.bestSha].refs.runs.push(r.id);
      if (!models[r.bestSha].sourceRun) models[r.bestSha].sourceRun = r.id;
    }
    const argsWeights = String(r.argsWeights ? abs(r.argsWeights) : "").replace(/\\/g, "/").toLowerCase();
    if (argsWeights && modelByPath[argsWeights]) {
      const k = modelByPath[argsWeights];
      if (!models[k].refs.runs.includes(r.id)) models[k].refs.runs.push(r.id);
    }
  }

  const deployments = {};
  for (const d of listDeploymentBundles()) {
    deployments[d.id] = d;
    if (d.modelId && models[d.modelId]) models[d.modelId].refs.deployments.push(d.id);
    if (d.runId && runs[d.runId]) runs[d.runId].deploymentIds.push(d.id);
  }

  const trash = listTrash();
  const external = externalCacheStats();
  const sum = (arr, k) => arr.reduce((n, x) => n + (Number(x[k]) || 0), 0);
  const storage = {
    datasets: sum(Object.values(datasets), "bytes"),
    runs: sum(Object.values(runs), "bytes"),
    models: sum(Object.values(models), "bytes"),
    deployments: sum(Object.values(deployments), "bytes"),
    trash: sum(trash, "bytes"),
    external: external ? Number(external.bytes) || 0 : 0,
    freeBytes: 0,
    totalBytes: 0,
  };
  try {
    const s = fs.statfsSync(root);
    storage.freeBytes = Number(s.bavail) * Number(s.bsize) || 0;
    storage.totalBytes = Number(s.blocks) * Number(s.bsize) || 0;
  } catch {
    /* Windows 上有些文件系统不支持 statfs；留 0，界面不显示 */
  }
  const catalog = {
    schemaVersion: 1,
    updatedAt: new Date().toISOString(),
    datasets,
    runs,
    models,
    deployments,
    trash,
    storage,
    external,
    audit: readAudit(30),
    retention: { keepDays: readPrefs().trashKeepDays || 0 },
    readOnly: !canWrite(),
  };
  catalog.suggestions = cleanupSuggestions(catalog, project);
  if (canWrite()) {
    const prev = readJson(abs(CATALOG_FILE), null);
    const a = prev ? JSON.stringify({ ...prev, updatedAt: "" }) : "";
    const b = JSON.stringify({ ...catalog, updatedAt: "" });
    if (force || a !== b) writeJsonAtomic(abs(CATALOG_FILE), catalog);
  }
  catalogCache = { at: Date.now(), value: catalog };
  return catalog;
}

/** 深合并（只合对象，数组整体替换：类别表不该被"合并"成两倍长）。 */
function merge(base, over) {
  if (!isObj(over)) return base;
  const out = { ...(isObj(base) ? base : {}) };
  for (const [k, v] of Object.entries(over)) {
    if (v === undefined) continue;
    out[k] = isObj(v) && isObj(out[k]) ? merge(out[k], v) : v;
  }
  return out;
}

const overridesPath = () => (root ? abs(`${STATE_DIR}/config.json`) : "");
/** 面板覆盖。没有工作区时返回空对象——**读路径不该抛错**，否则连"还没选工作区"都显示不出来。 */
const readOverrides = () => (root ? readJson(overridesPath(), {}) : {});

/* ============================ 配置：三层 ============================ */

let baseCache = { mtime: 0, value: null, error: "", source: "" };

/**
 * YAML 子集解析：**只在 python 那条路走不通时兜底**。
 *
 * 为什么需要它：读 config.yaml 的正路是让工作区自己的 python `yaml.safe_load` 一遍（权威、无歧义），
 * 但那要求那个环境装了 pyyaml——用户换环境、或用系统 python 试跑时经常没有。没有就整份设置读不出来，
 * 面板只能显示内置默认值，而默认值里的标注路径是空的：看起来像"插件坏了"。
 *
 * 所以留一条兜底：只认这份配置真的用到的形状——两层嵌套、标量、字符串列表、内联 `{}` / `[]`、注释。
 * **解析结果会被复核**（必须有 dataset 或 train 段），不合形状就当失败，绝不拿半份数据当真。
 */
function parseSimpleYaml(text) {
  const lines = String(text).split(/\r?\n/);
  const out = {};
  const stack = [{ indent: -1, obj: out }];
  // 下一个"有内容"的行（跳过空行与整行注释），用于判断 `key:` 后面跟的是列表还是对象
  const nextMeaningful = (i) => {
    for (let k = i + 1; k < lines.length; k++) {
      const t = lines[k].trim();
      if (!t || t.startsWith("#")) continue;
      const ind = lines[k].length - lines[k].trimStart().length;
      return { text: t, indent: ind };
    }
    return null;
  };
  const scalar = (v) => {
    const s = v.trim();
    if (s === "{}") return {};
    if (s === "[]") return [];
    // 行内列表（`classes: ['1', '2', '3']`）：工作区那份 config.yaml 真的这么写，
    // 兜底解析器不认的话类别表会变成一个字符串——表现是"面板里类别没了"
    const inline = /^\[(.*)\]$/.exec(s);
    if (inline) {
      const body = inline[1].trim();
      return body ? body.split(",").map((x) => scalar(x)) : [];
    }
    if (s === "true") return true;
    if (s === "false") return false;
    if (s === "null" || s === "~") return null;
    if (/^-?\d+(\.\d+)?$/.test(s)) return Number(s);
    const q = /^"(.*)"$/s.exec(s) || /^'(.*)'$/s.exec(s);
    if (q) return q[1].replace(/\\"/g, '"');
    const hash = s.indexOf(" #");
    return hash >= 0 ? s.slice(0, hash).trim() : s;
  };

  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i];
    const t = raw.trim();
    if (!t || t.startsWith("#")) continue;
    const indent = raw.length - raw.trimStart().length;

    const item = /^-\s+(.*)$/.exec(t);
    if (item) {
      const parent = stack[stack.length - 1];
      if (Array.isArray(parent.obj)) parent.obj.push(scalar(item[1]));
      continue;
    }
    const m = /^([A-Za-z0-9_."'-]+)\s*:\s*(.*)$/.exec(t);
    if (!m) continue;
    const key = m[1].replace(/^["']|["']$/g, "");
    const rest = m[2].trim();

    while (stack.length > 1 && indent <= stack[stack.length - 1].indent) stack.pop();
    const cur = stack[stack.length - 1].obj;
    if (rest === "") {
      const nx = nextMeaningful(i);
      const isList = nx && nx.indent > indent && nx.text.startsWith("- ");
      const child = isList ? [] : {};
      cur[key] = child;
      stack.push({ indent, obj: child });
    } else {
      cur[key] = scalar(rest);
    }
  }
  return out;
}

/**
 * 读工作区的 `config.yaml` 当基准。
 *
 * **用工作区自己的 python 读**（`yaml.safe_load` → JSON），而不是在 JS 里手写一个 YAML 子集解析器：
 * 后者在用户改了两行缩进之后就会静默读错，而"读错"的表现是"参数没生效"——最难查的那种。
 * 代价是一次 ~0.5s 的子进程；按 mtime 缓存，改文件才重读。
 */
async function readBaseConfig() {
  const file = abs("config.yaml");
  let mtime = 0;
  try {
    mtime = fs.statSync(file).mtimeMs;
  } catch {
    return { value: null, error: "", source: "", missing: true };
  }
  if (baseCache.mtime === mtime && (baseCache.value || baseCache.error)) {
    return { value: baseCache.value, error: baseCache.error, source: baseCache.source };
  }

  // 1) 正路：让工作区的 python `yaml.safe_load` 一遍（权威）
  const py = await detectPython();
  if (py.ok) {
    const code =
      "import json,sys,yaml;json.dump(yaml.safe_load(open(sys.argv[1],encoding='utf-8')) or {},sys.stdout,ensure_ascii=True)";
    const r = await runOnce(py.path, ["-c", code, file], 15000);
    if (r.code === 0) {
      try {
        const v = JSON.parse(r.out);
        if (isObj(v)) {
          baseCache = { mtime, value: v, error: "", source: "python" };
          return { value: v, error: "", source: "python" };
        }
      } catch {
        /* 落到兜底 */
      }
    }
  }

  // 2) 兜底：子集解析（pyyaml 不在时的唯一出路）
  try {
    const v = parseSimpleYaml(fs.readFileSync(file, "utf8"));
    if (!isObj(v) || (!("dataset" in v) && !("train" in v))) throw new Error("没有 dataset / train 段");
    baseCache = { mtime, value: v, error: "", source: "fallback" };
    return { value: v, error: "", source: "fallback" };
  } catch (e) {
    const err = `config.yaml 读不动（python 与内置解析器都失败：${(e && e.message) || e}）`;
    baseCache = { mtime, value: null, error: err, source: "" };
    return { value: null, error: err, source: "" };
  }
}

/** 三层合并：内置默认 → 工作区 config.yaml → 面板覆盖（`.uartix/yolo/config.json`）。 */
async function effectiveConfig() {
  const over = readOverrides();
  const base = await readBaseConfig();
  const merged = merge(merge(DEFAULTS, base.value || {}), over);
  // 路径字段统一成绝对路径：脚本会 chdir 到自己那层，相对路径会指错地方
  const out = merge({}, merged);
  out.dataset = { ...(out.dataset || {}) };
  out.train = { ...(out.train || {}) };
  out.dataset.output_dir = abs(out.dataset.output_dir || DEFAULTS.dataset.output_dir);
  out.train.project = abs(out.train.project || DEFAULTS.train.project);
  return { effective: out, overrides: over, baseFound: !!base.value, baseError: base.error, baseSource: base.source };
}

/* ============================ python 探测 ============================ */

let pyCache = { path: "", ok: false, version: "", source: "", error: "" };

/**
 * 找 python：**先用工作区 `_env.bat` 里那一条**。
 *
 * 那行路径是用户自己维护的（README 第六节第 4 条："换了 Python 环境：只改 _env.bat 里那一行"），
 * 插件跟着它走就不会出现"面板说 python 在这、训练脚本却在另一个环境"这种事。
 */
/* ============================ 环境自举（P178） ============================ */

/**
 * 一个"从没装过 Python"的用户也能开训：插件自己装一份私有环境。
 *
 * 版本全部钉死（2026-10-30 核对过镜像上确实存在这些文件）：
 * - CPython 3.12.16（python-build-standalone 20261026）
 * - torch 2.12.0 / torchvision 0.27.0（cu126 / cu130 / cpu 三档）
 * - ultralytics 8.4.128（回退 8.4.121 / 8.4.102）
 * 选 2.12.0 而不是更新的 2.14.x：阿里云 cu126 目录最高只有 2.12.0，且 2.12 已稳定半年。
 */
const ENV_DIR = `${STATE_DIR}/envs`;
const ENV_SPEC = { python: "3.12.16", torch: "2.12.0", torchvision: "0.27.0", ultralytics: "8.4.128", ultraFallbacks: ["8.4.121", "8.4.102"] };
const ENV_MIRRORS = {
  uv: [
    "https://mirrors.ustc.edu.cn/github-release/astral-sh/uv/LatestRelease",
    "https://mirror.nju.edu.cn/github-release/astral-sh/uv/LatestRelease",
    "https://github.com/astral-sh/uv/releases/download",
  ],
  python: [
    "https://mirrors.ustc.edu.cn/github-release/astral-sh/python-build-standalone",
    "https://mirror.nju.edu.cn/github-release/astral-sh/python-build-standalone",
    "https://github.com/astral-sh/python-build-standalone/releases/download",
  ],
  torch: {
    cu126: ["https://mirrors.aliyun.com/pytorch-wheels/cu126", "https://mirrors.nju.edu.cn/pytorch/whl/cu126", "https://download.pytorch.org/whl/cu126"],
    cu130: ["https://mirrors.aliyun.com/pytorch-wheels/cu130", "https://mirrors.nju.edu.cn/pytorch/whl/cu130", "https://download.pytorch.org/whl/cu130"],
    cpu: ["https://download.pytorch.org/whl/cpu"],
  },
  pypi: ["https://pypi.tuna.tsinghua.edu.cn/simple", "https://mirrors.aliyun.com/pypi/simple", "https://pypi.org/simple"],
};

/** 旧卡（Pascal / Volta）在 CUDA 13 上跑不了：名字里认得出就强制 cu126。 */
function needsLegacyCuda(nameIn) {
  return /\b(GTX\s*10[5-8]0|GTX\s*10[2-4]0|P100|P40|P4\b|V100|Tesla\s*V)/i.test(String(nameIn || ""));
}

/**
 * 驱动 + 卡名 → 画像。纯函数：测试直接钉这张表。
 * 没卡 / 驱动读不出 / 驱动 < 525.60 → CPU（并说明原因，不吓唬用户）。
 */
function recommendEnvProfile(gpuName, driverText) {
  const name = String(gpuName || "").trim();
  if (!name) return { kind: "cpu", variant: "cpu", why: "没有检测到 NVIDIA 显卡，用 CPU 版" };
  const v = parseFloat(String(driverText || "").replace(/[^\d.]/g, ""));
  if (!isFinite(v) || v <= 0) return { kind: "cpu", variant: "cpu", why: "读不到显卡驱动版本，先按 CPU 版装" };
  if (v < 525.6) return { kind: "cpu", variant: "cpu", why: `驱动 ${driverText} 低于 525.60，GPU 版跑不起来（建议先更新驱动）` };
  if (needsLegacyCuda(name)) return { kind: "gpu", variant: "cu126", why: `${name} 属于 Pascal/Volta，CUDA 13 不支持，用 CUDA 12.6` };
  if (v >= 580.88) return { kind: "gpu", variant: "cu130", why: `驱动 ${driverText} 支持 CUDA 13.0` };
  return { kind: "gpu", variant: "cu126", why: `驱动 ${driverText} 支持到 CUDA 12.6` };
}

/** 安装器命令（纯函数）：把"用哪个源、装哪一档"变成可逐字比对的 argv。 */
function buildEnvCommands(opt) {
  const o = opt || {};
  const uvExe = String(o.uvExe || "uv");
  const envRoot = String(o.envRoot || "");
  const venv = path.join(envRoot, "venv");
  const py = path.join(venv, "Scripts", "python.exe");
  const variant = String(o.variant || "cpu");
  const src = o.sources || {};
  const torchSrc = String(src.torch || (ENV_MIRRORS.torch[variant] || [])[0] || "");
  const pypi = String(src.pypi || ENV_MIRRORS.pypi[0]);
  const pythonMirror = String(src.python || ENV_MIRRORS.python[0]);
  const isCpu = variant === "cpu";
  const torchArgs = ["pip", "install", "--python", py, `torch==${ENV_SPEC.torch}${isCpu ? "" : "+" + variant}`];
  if (!isCpu) torchArgs.push(`torchvision==${ENV_SPEC.torchvision}+${variant}`, "--find-links", torchSrc);
  else torchArgs.push(`torchvision==${ENV_SPEC.torchvision}`);
  torchArgs.push("--index-url", pypi);
  return {
    venv: {
      cmd: uvExe,
      args: ["venv", "--python", ENV_SPEC.python, "--python-preference", "only-managed", venv],
      env: { UV_PYTHON_INSTALL_DIR: path.join(envRoot, "python"), UV_PYTHON_INSTALL_MIRROR: pythonMirror, UV_CACHE_DIR: path.join(envRoot, "..", "cache") },
    },
    torch: { cmd: uvExe, args: torchArgs, env: { UV_CACHE_DIR: path.join(envRoot, "..", "cache") } },
    ultralytics: {
      cmd: uvExe,
      args: ["pip", "install", "--python", py, `ultralytics==${ENV_SPEC.ultralytics}`, "--index-url", pypi],
      env: { UV_CACHE_DIR: path.join(envRoot, "..", "cache") },
    },
    python: py,
  };
}

/** 读一份 env.json；坏文件当不存在，不炸整个面板。 */
function readEnvMeta(dir) {
  const j = readJson(path.join(dir, "env.json"), null);
  return isObj(j) && j.id ? j : null;
}

function envList() {
  const base = abs(ENV_DIR);
  let names = [];
  try {
    names = fs.readdirSync(base, { withFileTypes: true }).filter((e) => e.isDirectory() && !["cache", "uv"].includes(e.name)).map((e) => e.name);
  } catch {
    return [];
  }
  const out = [];
  for (const n of names) {
    const dir = path.join(base, n);
    const meta = readEnvMeta(dir);
    if (!meta) continue;
    out.push({ ...meta, dir: dir.replace(/\\/g, "/"), bytes: Number(meta.diskBytes) || 0, exists: fs.existsSync(path.join(dir, "venv", "Scripts", "python.exe")) });
  }
  return out.sort((a, b) => String(b.createdAt || "").localeCompare(String(a.createdAt || "")));
}

/** 选中的插件环境：prefs 指定优先；否则取第一份 ready 的。 */
function selectedEnv() {
  const prefs = readPrefs();
  const all = envList();
  const want = String((prefs.runtime && prefs.runtime.selected) || "");
  const hit = all.find((e) => e.id === want && e.status === "ready" && e.exists);
  if (hit) return hit;
  return all.find((e) => e.status === "ready" && e.exists) || null;
}

/** 探测一张 NVIDIA 卡：没有 nvidia-smi 就返回 null（不是错误）。 */
async function envNvidia() {
  const r = await runOnce("nvidia-smi", ["--query-gpu=name,driver_version,memory.total", "--format=csv,noheader,nounits"], 8000);
  if (r.code !== 0) return null;
  const line = String(r.out || "").split(/\r?\n/).map((x) => x.trim()).filter(Boolean)[0] || "";
  if (!line) return null;
  const parts = line.split(",").map((x) => x.trim());
  return { name: parts[0] || "", driver: parts[1] || "", vramMiB: Number(parts[2]) || 0 };
}

function envDisk() {
  try {
    const st = fs.statfsSync(root || ".");
    return { free: Number(st.bavail) * Number(st.bsize) || 0, total: Number(st.blocks) * Number(st.bsize) || 0 };
  } catch {
    return { free: 0, total: 0 };
  }
}

/** 面板要的全部环境事实：一张卡、一个推荐、已有环境、镜像健康、当前任务。 */
async function envState() {
  const nv = await envNvidia();
  const rec = recommendEnvProfile(nv && nv.name, nv && nv.driver);
  const envs = envList();
  const sel = selectedEnv();
  const prefs = readPrefs();
  const py = await detectPython();
  return {
    ok: true,
    platform: process.platform,
    gpu: nv,
    recommended: rec,
    disk: envDisk(),
    spec: ENV_SPEC,
    envs,
    selected: sel ? sel.id : "",
    current: py,
    usingPluginEnv: !!(sel && py.path && py.path.toLowerCase() === String(sel.python && sel.python.exe || "").toLowerCase()),
    installLocation: String((prefs.runtime && prefs.runtime.location) || "workspace"),
    locationOptions: [
      { id: "workspace", label: "工作区内（随工作区删除，多工作区各一份）" },
      { id: "appdata", label: "用户数据目录（多工作区共用，省磁盘）" },
    ],
    active: active && active.kind === "env" ? snapshot(active) : null,
    readOnly: !canWrite(),
  };
}

/* ---------------- P178：下载器 / 镜像 / 安装器 ---------------- */

/** 小文件下载（uv.zip）：跟随重定向、Range 续传、.part 原子落盘。没有 Python 时也能用。 */
function httpsDownload(url, dest, opt) {
  const o = opt || {};
  // 只给测试用的口子：`insecure` + 回环地址才允许走明文 http / 自签证书，
  // 和 `runner/download_job.py --insecure` 同一口径（生产路径从不传它）。
  const loop = (u) => {
    try {
      const h = new URL(u).hostname;
      return h === "127.0.0.1" || h === "localhost" || h === "::1";
    } catch {
      return false;
    }
  };
  const pickMod = (u) => (o.insecure && loop(u) ? (/^http:\/\//i.test(u) ? http : https) : https);
  const tlsOpt = (u) => (o.insecure && loop(u) ? { rejectUnauthorized: false } : {});
  return new Promise((resolve, reject) => {
    const part = dest + ".part";
    const have = fs.existsSync(part) ? fs.statSync(part).size : 0;
    const go = (u, depth) => {
      if (depth > 5) return reject(new Error("重定向次数过多"));
      const req = pickMod(u).request(
        u,
        { method: "GET", ...tlsOpt(u), headers: { "User-Agent": "uartix-yolo/0.7", ...(have ? { Range: `bytes=${have}-` } : {}) } },
        (res) => {
          const code = res.statusCode || 0;
          if ([301, 302, 303, 307, 308].includes(code) && res.headers.location) {
            res.resume();
            return go(new URL(String(res.headers.location), u).toString(), depth + 1);
          }
          if (code === 404) { res.resume(); return reject(new Error(`404：${u}`)); }
          if (code >= 400) { res.resume(); return reject(new Error(`HTTP ${code}：${u}`)); }
          const total = Number(res.headers["content-length"] || 0) + (code === 206 ? have : 0);
          const f = fs.createWriteStream(part, { flags: code === 206 ? "a" : "w" });
          let done = code === 206 ? have : 0;
          let aborted = false;
          let settled = false;
          // 断流是这个下载器最容易踩的坑：对端把连接掐了，`res` 只会发 `aborted`/`error`，
          // 不会发 `end` —— 没有这一条，promise 永远不落，用户看到的是"进度条不动"。
          const fail = (err) => {
            if (settled) return;
            settled = true;
            try { f.destroy(); } catch { /* 还没开出来 */ }
            reject(err);
          };
          res.on("data", (d) => {
            done += d.length;
            if (o.onProgress) o.onProgress(done, total);
            if (o.cancelled && o.cancelled()) req.destroy(new Error("已取消"));
          });
          res.on("aborted", () => {
            aborted = true;
            fail(new Error(`下载中断（已收 ${done}/${total || "?"} 字节；保留 .part，下次从断点续）`));
          });
          res.on("error", (e) => fail(new Error(`下载中断：${(e && e.message) || e}（已收 ${done}/${total || "?"} 字节）`)));
          res.pipe(f);
          f.on("finish", () => f.close(() => {
            if (settled) return;
            // 长度对不上就不许改名：半截 uv.zip 会让 Expand-Archive 报"压缩包损坏"，
            // 用户看到的是"插件坏了"，而不是"网断了再试一次"。留着 .part 下次续传。
            if (aborted || (total && done !== total)) {
              settled = true;
              return reject(new Error(`下载不完整：${done}/${total || "?"} 字节（保留 .part，下次从断点续）`));
            }
            try {
              fs.renameSync(part, dest);
            } catch (e) {
              settled = true;
              return reject(e);
            }
            settled = true;
            resolve({ bytes: done, total });
          }));
          f.on("error", (e) => fail(e));
        },
      );
      // 连接层面的错（DNS / 拒绝连接 / 超时）：promise 已经落过的再 reject 是空操作
      req.on("error", reject);
      req.setTimeout(30000, () => req.destroy(new Error("下载超时（30 秒没有数据）")));
      req.end();
    };
    go(url, 0);
  });
}

/** HEAD 探测一个 URL（镜像健康检查）：只关心"能不能拿到"，不下载正文。 */
function headOk(url, timeoutMs) {
  return new Promise((resolve) => {
    const t0 = Date.now();
    const go = (u, depth) => {
      if (depth > 4) return resolve({ ok: false, ms: Date.now() - t0 });
      const req = https.request(u, { method: "HEAD", headers: { "User-Agent": "uartix-yolo/0.7" }, timeout: timeoutMs || 4000 }, (res) => {
        const code = res.statusCode || 0;
        if ([301, 302, 303, 307, 308].includes(code) && res.headers.location) {
          res.resume();
          return go(new URL(String(res.headers.location), u).toString(), depth + 1);
        }
        res.resume();
        resolve({ ok: code >= 200 && code < 400, ms: Date.now() - t0 });
      });
      req.on("timeout", () => req.destroy(new Error("timeout")));
      req.on("error", () => resolve({ ok: false, ms: Date.now() - t0 }));
      req.end();
    };
    go(url, 0);
  });
}

/** 安装期间的一条命令：成功 resolve，失败 reject（带最后两行输出）。 */
function runEnvStep(job, spec, label) {
  return new Promise((resolve, reject) => {
    const tail = [];
    const child = ctx.process.spawn({
      cmd: spec.cmd,
      args: spec.args,
      cwd: root,
      env: { ...PY_ENV, ...(job.envProxy || {}), ...(spec.env || {}), PYTHONUNBUFFERED: "1" },
      onStdout: (l) => {
        pushLine(job, l, "out");
        tail.push(l);
        if (tail.length > 4) tail.shift();
      },
      onStderr: (l) => {
        pushLine(job, l, "err");
        tail.push(l);
        if (tail.length > 4) tail.shift();
      },
      onExit: (code) => {
        if (code === 0) resolve();
        else reject(new Error(`${label}失败（退出码 ${code}）：${tail.filter(Boolean).slice(-2).join(" / ").slice(0, 300)}`));
      },
      onError: (e) => reject(new Error(`${label}起不来：${(e && e.message) || e}`)),
    });
    job.child = child;
    job.pid = child.pid || 0;
  });
}

/**
 * 代理探活：配置里开着代理、但代理没起来（Clash 关了 / 换了端口）是最常见的坑。
 * 连不上就**不**把代理塞给 uv —— 否则每一次下载都会先撞一遍死端口，比直连还慢。
 */
function proxyAlive(proxyUrl) {
  return new Promise((resolve) => {
    let host = "";
    let port = 0;
    try {
      const u = new URL(String(proxyUrl));
      host = u.hostname;
      port = Number(u.port) || (u.protocol === "https:" ? 443 : 80);
    } catch {
      return resolve(false);
    }
    if (!host || !port) return resolve(false);
    const s = net.connect({ host, port });
    let done = false;
    const fin = (ok) => {
      if (done) return;
      done = true;
      try {
        s.destroy();
      } catch {
        /* 已经关了 */
      }
      resolve(ok);
    };
    s.setTimeout(800, () => fin(false));
    s.on("connect", () => fin(true));
    s.on("error", () => fin(false));
  });
}

/** 解压 uv.zip（Windows 自带 Expand-Archive，不额外装东西）。 */async function unzipUv(job, zipPath, outDir) {
  const q = (s) => "'" + String(s).replace(/'/g, "''") + "'";
  await runEnvStep(
    job,
    {
      cmd: "powershell",
      args: ["-NoProfile", "-ExecutionPolicy", "Bypass", "-Command", `Expand-Archive -LiteralPath ${q(zipPath)} -DestinationPath ${q(outDir)} -Force`],
    },
    "解压 uv",
  );
}

/** 下载 uv.exe：按镜像顺序试，成功即停。 */
async function ensureUv(job) {
  const uvDir = abs(`${ENV_DIR}/uv`);
  const uvExe = path.join(uvDir, "uv.exe");
  if (fs.existsSync(uvExe)) {
    const r = await runOnce(uvExe, ["--version"], 10000);
    if (r.code === 0) return { uvExe, version: (r.out || "").trim() };
  }
  fs.mkdirSync(uvDir, { recursive: true });
  const zip = path.join(uvDir, "uv.zip");
  const tried = [];
  for (const base of ENV_MIRRORS.uv) {
    const url = `${base.replace(/\/+$/, "")}/uv-x86_64-pc-windows-msvc.zip`;
    job.progress.detail = `下载安装器（${new URL(url).host}）`;
    try {
      await httpsDownload(url, zip, {
        onProgress: (done, total) => {
          job.progress.phase = "uv";
          job.progress.detail = `下载安装器 ${fmtBytes(done)}${total ? " / " + fmtBytes(total) : ""}`;
          job.progress.percent = total ? Math.min(5, Math.round((done / total) * 5)) : 1;
        },
        cancelled: () => job.stopped,
      });
      await unzipUv(job, zip, uvDir);
      if (!fs.existsSync(uvExe)) {
        const found = [];
        for (const e of fs.readdirSync(uvDir, { withFileTypes: true })) {
          if (e.isFile() && e.name.toLowerCase() === "uv.exe") found.push(path.join(uvDir, e.name));
          if (e.isDirectory()) {
            const p = path.join(uvDir, e.name, "uv.exe");
            if (fs.existsSync(p)) found.push(p);
          }
        }
        if (found.length) fs.copyFileSync(found[0], uvExe);
      }
      if (!fs.existsSync(uvExe)) throw new Error("解压后没有 uv.exe");
      const v = await runOnce(uvExe, ["--version"], 10000);
      if (v.code !== 0) throw new Error("uv.exe 起不来");
      job.envSources = { ...(job.envSources || {}), uv: new URL(url).host };
      pushLine(job, `[环境] 安装器就绪：${(v.out || "").trim()}（${new URL(url).host}）`, "sys");
      return { uvExe, version: (v.out || "").trim() };
    } catch (e) {
      tried.push(`${new URL(url).host}: ${(e && e.message) || e}`);
      pushLine(job, `[环境] 这个源不行，换下一个：${tried[tried.length - 1].slice(0, 200)}`, "err");
    }
  }
  throw new Error(`安装器下载失败（试过 ${tried.length} 个源）：\n${tried.join("\n")}`);
}

function envIdFor(kind, variant) {
  return kind === "cpu" ? "cpu-py312" : `gpu-${variant}-py312`;
}

/**
 * 装一份私有环境。**必须由用户点按钮触发**；失败保留缓存，可续装。
 * v1 位置只支持工作区（`$WS/.uartix/yolo/envs`）——`$LOCALAPPDATA` 不在插件写权限内，
 * 要支持它需要宿主新增一枚写目录，另开。
 */
async function envInstall(req) {
  needWorkspace();
  if (!canWrite()) throw new Error("当前是只读模式：能看环境，不能安装");
  if (active) throw new Error(`已经有一个任务在跑（${active.label}）：先停掉它`);
  const o = isObj(req) ? req : {};
  const nv = await envNvidia();
  const rec = recommendEnvProfile(nv && nv.name, nv && nv.driver);
  const variant = String(o.variant || (rec.kind === "gpu" ? rec.variant : "cpu"));
  if (!["cu126", "cu130", "cpu"].includes(variant)) throw new Error(`不支持的画像：${variant}`);
  // 位置暂时只有工作区（`$LOCALAPPDATA` 不在插件写权限里）。用户传了别的就直说，不悄悄落到工作区。
  const where = String(o.location || "workspace");
  if (where !== "workspace") throw new Error("这一版只能装在工作区内（$WS/.uartix/yolo/envs）；装到用户数据目录需要先给插件新增一枚写目录");
  const kind = variant === "cpu" ? "cpu" : "gpu";
  const id = envIdFor(kind, variant);
  const envRoot = abs(`${ENV_DIR}/${id}`);
  const need = kind === "gpu" ? 6 * 1024 * 1024 * 1024 : 2.5 * 1024 * 1024 * 1024;
  const free = envDisk().free;
  if (free && free < need) {
    throw new Error(`磁盘不够：${variant} 至少需要 ${fmtBytes(need)}，当前可用 ${fmtBytes(free)}。先到资产页清理，或换到空间更大的盘。`);
  }

  const job = newJob("env", `安装环境 ${variant}`);
  job.envTarget = { id, variant, kind, envRoot: envRoot.replace(/\\/g, "/") };
  jobs.set(job.id, job);
  active = job;
  const step = (phase, pct, detail) => {
    job.progress.phase = phase;
    job.progress.percent = pct;
    job.progress.detail = detail;
    emitJob(job);
  };

  let code = 1;
  try {
    // 配置里开了代理就先用它，但**先探活**：代理没起来时把 uv 指向死端口，
    // 每个镜像都会"连得上但没响应"，比直连更难排查。
    try {
      const { effective } = await effectiveConfig();
      const cfgProxy = effective.env && effective.env.proxy_enable ? String(effective.env.proxy || "") : "";
      if (cfgProxy) {
        if (await proxyAlive(cfgProxy)) {
          job.envProxy = { HTTPS_PROXY: cfgProxy, HTTP_PROXY: cfgProxy, ALL_PROXY: cfgProxy };
          pushLine(job, `[环境] 走配置里的代理 ${cfgProxy}`, "sys");
        } else {
          pushLine(job, `[环境] 配置里开着代理 ${cfgProxy}，但连不上：这次直连镜像`, "err");
        }
      }
    } catch {
      /* 读不到配置就直连：安装不该被一个坏 config.yaml 挡住 */
    }
    fs.mkdirSync(envRoot, { recursive: true });
    writeJsonAtomic(path.join(envRoot, "env.json"), {
      schemaVersion: 1,
      id,
      kind,
      label: kind === "gpu" ? `GPU · CUDA ${variant === "cu130" ? "13.0" : "12.6"} · Python 3.12` : "CPU · Python 3.12",
      status: "installing",
      createdAt: new Date().toISOString(),
      gpu: nv || null,
      spec: ENV_SPEC,
      sources: {},
    });

    step("uv", 1, "准备安装器（uv）");
    const uv = await ensureUv(job);

    step("python", 8, `安装 Python ${ENV_SPEC.python}`);
    const cmds = buildEnvCommands({ uvExe: uv.uvExe, envRoot, variant, sources: {} });
    let venvOk = false;
    let lastErr = "";
    for (let i = 0; i < ENV_MIRRORS.python.length && !venvOk; i++) {
      const c = buildEnvCommands({ uvExe: uv.uvExe, envRoot, variant, sources: { python: ENV_MIRRORS.python[i] } });
      try {
        await runEnvStep(job, c.venv, "装 Python");
        venvOk = true;
        job.envSources = { ...(job.envSources || {}), python: new URL(ENV_MIRRORS.python[i]).host };
      } catch (e) {
        lastErr = (e && e.message) || String(e);
        pushLine(job, `[环境] Python 源 ${new URL(ENV_MIRRORS.python[i]).host} 失败：${lastErr.slice(0, 160)}`, "err");
      }
    }
    if (!venvOk) throw new Error(`Python 装不上（试过 ${ENV_MIRRORS.python.length} 个源）：${lastErr}`);

    step("torch", 25, `安装 torch ${ENV_SPEC.torch}${kind === "gpu" ? "+" + variant : ""}（体积大，耐心等）`);
    // CPU 版没有 `-f` 可换：torch 直接从 PyPI 拿（Windows 上 PyPI 的 torch 就是 CPU 构建），
    // 所以"换源"要换的是 **PyPI 镜像**，而不是那张只有一条的 torch 目录表。
    const torchBases = kind === "cpu" ? ENV_MIRRORS.pypi : ENV_MIRRORS.torch[variant] || [];
    let torchOk = false;
    lastErr = "";
    for (const base of torchBases) {
      const c = buildEnvCommands({ uvExe: uv.uvExe, envRoot, variant, sources: kind === "cpu" ? { pypi: base } : { torch: base } });
      try {
        await runEnvStep(job, c.torch, "装 torch");
        torchOk = true;
        job.envSources = { ...(job.envSources || {}), torch: new URL(base).host };
        break;
      } catch (e) {
        lastErr = (e && e.message) || String(e);
        pushLine(job, `[环境] torch 源 ${new URL(base).host} 失败，换下一个：${lastErr.slice(0, 160)}`, "err");
      }
    }
    if (!torchOk) throw new Error(`torch 装不上（试过 ${torchBases.length} 个源）：${lastErr}`);

    step("ultralytics", 80, `安装 ultralytics ${ENV_SPEC.ultralytics}`);
    let ultraOk = false;
    lastErr = "";
    for (const ver of [ENV_SPEC.ultralytics, ...ENV_SPEC.ultraFallbacks]) {
      for (const pypi of ENV_MIRRORS.pypi) {
        const c = buildEnvCommands({ uvExe: uv.uvExe, envRoot, variant, sources: { pypi } });
        const spec = { ...c.ultralytics, args: c.ultralytics.args.map((x) => (x === `ultralytics==${ENV_SPEC.ultralytics}` ? `ultralytics==${ver}` : x)) };
        try {
          await runEnvStep(job, spec, "装 ultralytics");
          ultraOk = true;
          job.envSources = { ...(job.envSources || {}), pypi: new URL(pypi).host };
          job.envUltra = ver;
          break;
        } catch (e) {
          lastErr = (e && e.message) || String(e);
        }
      }
      if (ultraOk) break;
    }
    if (!ultraOk) throw new Error(`ultralytics 装不上：${lastErr}`);

    step("probe", 92, "自检（import torch / CUDA / 版本）");
    const code =
      "import json,torch,ultralytics\n" +
      "print(json.dumps({'torch':torch.__version__,'cuda':bool(torch.cuda.is_available()),'device':(torch.cuda.get_device_name(0) if torch.cuda.is_available() else ''),'ultralytics':ultralytics.__version__},ensure_ascii=True))\n";
    const py = cmds.python;
    const pr = await runOnce(py, ["-c", code], 120000);
    if (pr.code !== 0) throw new Error(`自检失败：${(pr.err || pr.out || "").slice(-300)}`);
    let probe = null;
    try {
      probe = JSON.parse(String(pr.out || "").trim().split(/\r?\n/).pop());
    } catch {
      throw new Error("自检输出读不懂：" + String(pr.out || "").slice(-200));
    }
    if (kind === "gpu" && !probe.cuda) {
      throw new Error("装的是 GPU 版，但 torch.cuda.is_available() = false。多半是驱动太旧或显卡不在 CUDA 支持列表：先更新驱动，或改用 CPU 版。");
    }

    const meta = {
      schemaVersion: 1,
      id,
      kind,
      label: kind === "gpu" ? `GPU · CUDA ${variant === "cu130" ? "13.0" : "12.6"} · Python 3.12` : "CPU · Python 3.12",
      status: "ready",
      createdAt: job.startedAt ? new Date(job.startedAt).toISOString() : new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      python: { version: ENV_SPEC.python, exe: py.replace(/\\/g, "/") },
      installer: { uv: uv.version, uvExe: uv.uvExe.replace(/\\/g, "/") },
      packages: { torch: probe.torch, torchvision: ENV_SPEC.torchvision, ultralytics: probe.ultralytics || job.envUltra },
      gpu: nv || null,
      probe: { ...probe, checkedAt: new Date().toISOString() },
      sources: job.envSources || {},
      diskBytes: walkStats(envRoot).bytes,
      location: "workspace",
    };
    writeJsonAtomic(path.join(envRoot, "env.json"), meta);
    const prefs = readPrefs();
    prefs.runtime = { ...(prefs.runtime || {}), selected: id, location: "workspace" };
    savePrefs(prefs);
    pyCache = { path: py, ok: true, version: `Python ${ENV_SPEC.python}`, source: `plugin-env:${id}`, error: "" };
    job.progress.phase = "done";
    job.progress.percent = 100;
    job.progress.detail = `${meta.label} 装好了：torch ${probe.torch} / ultralytics ${probe.ultralytics}`;
    code = 0;
    try { ctx.panels.emit(PANEL, "env", { id, meta }); } catch { /* 面板没开 */ }
    return { ok: true, id, meta };
  } catch (e) {
    const msg = (e && e.message) || String(e);
    try {
      writeJsonAtomic(path.join(envRoot, "env.json"), {
        schemaVersion: 1,
        id,
        kind,
        label: kind === "gpu" ? `GPU · ${variant}` : "CPU",
        status: job.stopped ? "cancelled" : "broken",
        createdAt: new Date().toISOString(),
        error: msg.slice(0, 500),
        gpu: nv || null,
        spec: ENV_SPEC,
      });
    } catch {
      /* 目录都写不了就算了，错误已经抛给调用方 */
    }
    throw e;
  } finally {
    // 终态必须走 finishJob：否则这条 env 任务会在 jobs 里永远显示「运行中」，
    // 面板顶上的任务卡和 `state.jobs` 都会一直挂着一个不动的进度条。
    try {
      finishJob(job, code);
    } catch {
      /* 日志收尾失败不挡返回值 */
    }
    if (active === job) active = null;
  }
}

async function envSetDefault(req) {
  needWorkspace();
  if (!canWrite()) throw new Error("当前是只读模式：不能改默认环境");
  const o = isObj(req) ? req : {};
  const id = String(o.id || "");
  if (id) {
    const hit = envList().find((e) => e.id === id && e.status === "ready" && e.exists);
    if (!hit) throw new Error(`没有这份可用的环境：${id}`);
  }
  const prefs = readPrefs();
  prefs.runtime = { ...(prefs.runtime || {}), selected: id, autoPreferPluginEnv: true };
  savePrefs(prefs);
  pyCache = { path: "", ok: false, version: "", source: "", error: "" };
  return { ok: true, selected: id, state: await envState() };
}

async function envRemove(req) {
  needWorkspace();
  if (!canWrite()) throw new Error("当前是只读模式：不能删除环境");
  const o = isObj(req) ? req : {};
  const id = String(o.id || "");
  const hit = envList().find((e) => e.id === id);
  if (!hit) throw new Error(`没有这份环境：${id}`);
  if (active) throw new Error("有任务在跑：先停掉再删环境");
  const prefs = readPrefs();
  if (prefs.runtime && prefs.runtime.selected === id) {
    prefs.runtime.selected = "";
    savePrefs(prefs);
  }
  const rec = moveToTrash(hit.dir, { kind: "env", id, name: hit.label || id, reason: "用户删除插件环境" });
  pyCache = { path: "", ok: false, version: "", source: "", error: "" };
  catalogCache = { at: 0, value: null };
  return { ok: true, trashed: rec.id, state: await envState() };
}

async function detectPython() {
  const over = readOverrides();
  const forced = over && over.env && over.env.python;
  if (forced) {
    const r = await probePython(String(forced), "config.env.python");
    pyCache = r;
    return r;
  }
  // P178：插件自建环境优先于 _env.bat / PATH（用户显式指定仍然最大）
  const sel = selectedEnv();
  if (sel) {
    const exe = String((sel.python && sel.python.exe) || path.join(abs(sel.dir), "venv", "Scripts", "python.exe"));
    if (fs.existsSync(exe)) {
      const r = await probePython(exe, `plugin-env:${sel.id}`);
      if (r.ok) {
        pyCache = r;
        return r;
      }
    }
  }
  const fromBat = readEnvBat();
  if (fromBat) {
    const r = await probePython(fromBat, "_env.bat");
    if (r.ok) {
      pyCache = r;
      return r;
    }
  }
  const r = await probePython("python", "PATH");
  if (!r.ok && pyCache.ok) return pyCache; // 探测失败但之前有过可用的：别把好的丢掉
  pyCache = r;
  return r;
}

/** 从 `_env.bat` 里抠 `set "PYTHON_EXE=..."`。读不到就返回空串（不报错：那是可选优化）。 */
function readEnvBat() {
  try {
    const t = fs.readFileSync(abs("_env.bat"), "utf8");
    const m = /set\s+"?PYTHON_EXE=([^"\r\n]+)"?/i.exec(t);
    return m ? m[1].trim() : "";
  } catch {
    return "";
  }
}

async function probePython(p, source) {
  const r = await runOnce(p, ["--version"], 10000);
  if (r.code === 0) {
    return { path: p, ok: true, version: (r.out || r.err || "").trim(), source, error: "" };
  }
  return { path: p, ok: false, version: "", source, error: (r.err || r.out || "启动失败").trim().slice(0, 200) };
}

/**
 * 跑一条命令并收集输出（一次性，不是 job）。
 *
 * 用 `ctx.process.spawn` 而不是自己 `spawn`：宿主的 disposer 会 `killAll`，
 * 走同一个口子才能保证"插件被杀时子孙一起走"。
 */
function runOnce(cmd, args, timeoutMs) {
  return new Promise((resolve) => {
    let out = "";
    let err = "";
    let done = false;
    let child = null;
    let timer = 0;
    const finish = (code) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      resolve({ code, out: out.trim(), err: err.trim() });
    };
    timer = setTimeout(() => {
      try {
        if (child) child.kill();
      } catch {
        /* 已经退出 */
      }
      finish(-1); // -1 = 我们主动掐的（超时），和"进程自己失败"分开
    }, timeoutMs || 15000);
    try {
      child = ctx.process.spawn({
        cmd,
        args,
        cwd: root || undefined,
        // 探针一律按 UTF-8 收：Windows 上 python 的 stdout 默认走控制台代码页（这台是 cp936），
        // 而这里按 UTF-8 解 —— 中文类别名会被解成 `Բ` / `` 这种"看着像字"的垃圾，
        // 更糟的是它**不报错**：config.yaml 里 `classes: ['圆','方']` 变成乱码后照样写进快照，
        // 构建数据集 exit 0、标注框 0 个。端到端跑真数据集才照得出来（P175 试用发现的）。
        env: { ...PY_ENV, },
        onStdout: (l) => {
          if (out.length < 64 * 1024) out += l + "\n";
        },
        onStderr: (l) => {
          if (err.length < 16 * 1024) err += l + "\n";
        },
        onExit: (code) => finish(code),
        onError: (e) => {
          err += String((e && e.message) || e);
          finish(-1);
        },
      });
    } catch (e) {
      err = String((e && e.message) || e);
      finish(-1);
    }
  });
}

/* ============================ 模型代际与任务（P175-W2，详设 §1.3 / §1.4 / §5.1） ============================ */

/**
 * 模型代际：**只做 YOLO11 与 YOLO26**。
 *
 * 它们是同一个 `ultralytics` 包里的两代模型，不是两套环境——所以这里没有"环境切换"这种概念，
 * 只有"这次用哪一枚权重"。范围裁定与理由记在详设 §1.2，界面上不解释历史包袱。
 */
const MODEL_FAMILIES = [
  { id: "yolo11", label: "YOLO11", scales: ["n", "s", "m", "l", "x"], tasks: ["detect", "segment"] },
  { id: "yolo26", label: "YOLO26", scales: ["n", "s", "m", "l", "x"], tasks: ["detect", "segment"] },
];
const TASKS = ["detect", "segment"];

/** 官方可下载名（`-seg` 才是分割）。首次真用才会走网络下载。 */
function officialModels() {
  const out = [];
  for (const fam of MODEL_FAMILIES) {
    for (const sc of fam.scales) {
      out.push({ name: `${fam.id}${sc}.pt`, family: fam.id, scale: sc, task: "detect", label: `${fam.label} ${sc}（检测）` });
      out.push({ name: `${fam.id}${sc}-seg.pt`, family: fam.id, scale: sc, task: "segment", label: `${fam.label} ${sc}（分割）` });
    }
  }
  return out;
}

/**
 * 从文件名推断代际与任务（ultralytics 自己也按这套命名约定推）。
 * **读不出就返回 known:false**——不猜：猜错的形态是"拿 detect 权重跑 segment"，
 * 而引擎会拒绝，用户只会以为是面板的锅。
 */
function inferWeights(file) {
  const base = path.basename(String(file == null ? "" : file)).toLowerCase();
  const m = /^yolo(11|26)([nsmlx])(-seg)?\.pt$/.exec(base);
  if (!m) return { name: base || "(没填)", family: null, scale: null, task: null, known: false };
  return { name: base, family: `yolo${m[1]}`, scale: m[2], task: m[3] ? "segment" : "detect", known: true };
}

/** 任务与权重的匹配判断（详设 §1.3 的那张表落到代码上的样子）。 */
function taskMismatch(task, facts) {
  const t = String(task || "").trim();
  const wt = String((facts && facts.task) || "").trim();
  if (!t || !wt) return { ok: true, known: false, why: "" };
  if (t === wt) return { ok: true, known: true, why: "" };
  return {
    ok: false,
    known: true,
    why: `这枚权重是 **${wt}** 的（${(facts && facts.source) || "读自权重"}），却要按 **${t}** 训：ultralytics 会直接拒绝。换一枚 ${t} 的权重，或把任务改成 ${wt}。`,
  };
}

/**
 * 续训守卫（详设 §1.5）：`resume` 只认 `last.pt`。
 * `best.pt` 里没有 optimizer/scaler/EMA/epoch，给它会**静默退化**成"从头训但接着计数"。
 */
function resumeGuard(v) {
  const s = String(v == null ? "" : v).trim();
  if (!s || s === "false") return { ok: true, off: true };
  if (/^\s*true\s*$/i.test(s)) return { ok: false, why: "resume 填 true 会让引擎从**当前工作目录**的 runs/**/last.pt 里挑一个——面板不能替你猜是哪一个。请把 last.pt 的完整路径填进来。" };
  if (/best\.pt$/i.test(s)) return { ok: false, why: "resume 只能指向 last.pt：best.pt 没有优化器/轮次状态，续训会静默退化。" };
  if (!/last\.pt$/i.test(s)) return { ok: false, why: "resume 要填训练产物里的 last.pt（或留空表示不续训）。" };
  return { ok: true, off: false, path: s };
}

/**
 * 标签形状 → 任务建议（详设 §1.4）。
 *
 * 判据是官方 `data/utils.py` 里真的在用的那一条：**每行 token 数**。
 * `5` = 框；`1 + 2N (N≥3)` = 多边形；`9` 是 `1+8`，**既可能是 4 点多边形也可能是 OBB**——
 * 所以 9 单独计一类，只报出来、不替用户决定（obb 不在范围内）。
 * 混合（同一份数据里既有框又有多边形）必须报：detect 遇混合会**静默丢弃 segments**。
 */
function labelShape(rows) {
  let boxes = 0;
  let polys = 0;
  let quads = 0;
  let bad = 0;
  for (const line of rows) {
    const t = String(line).trim();
    if (!t) continue;
    const n = t.split(/\s+/).length;
    if (n === 5) boxes++;
    else if (n === 9) quads++;
    else if (n > 6 && (n - 1) % 2 === 0) polys++;
    else bad++;
  }
  const shaped = boxes + polys + quads;
  const tally = [
    { task: "detect", n: boxes },
    { task: "segment", n: polys + quads },
  ].sort((a, b) => b.n - a.n);
  const top = tally[0];
  const mixed = boxes > 0 && polys + quads > 0 && Math.min(boxes, polys + quads) / Math.max(1, shaped) > 0.02;
  return {
    task: shaped ? top.task : "",
    confidence: shaped ? Number((top.n / shaped).toFixed(3)) : 0,
    boxes,
    polys,
    quads,
    bad,
    shaped,
    mixed,
    // 9-token 占大头时，"多边形"与"OBB"分不开：只能报出来让用户看，不许悄悄按 segment 训
    obbSuspect: quads > 0 && quads >= boxes && quads >= polys,
  };
}

/** 扫 `labels/` 目录下的 .txt（train/val 都算），按固定步长抽样——同一个目录每次给出同一个结果。 */
function sampleLabelFiles(dir, want) {
  const out = [];
  const root = path.join(dir, "labels");
  const walk = (d, depth) => {
    if (depth > 3 || out.length >= 4000) return;
    let ents;
    try {
      ents = fs.readdirSync(d, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of ents) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p, depth + 1);
      else if (e.name.endsWith(".txt")) out.push(p);
    }
  };
  walk(root, 0);
  const n = want || 200;
  if (out.length <= n) return out;
  const stride = out.length / n;
  const picked = [];
  for (let i = 0; i < n; i++) picked.push(out[Math.floor(i * stride)]);
  return picked;
}

/** 任务自动识别：只出**建议 + 依据 + 置信度**，落不落配置由用户点（红线 D）。 */
function detectTask(dirIn) {
  const dir = abs(dirIn || DEFAULTS.dataset.output_dir);
  const files = sampleLabelFiles(dir, 200);
  const rows = [];
  for (const f of files) {
    try {
      rows.push(...fs.readFileSync(f, "utf8").split(/\r?\n/));
    } catch {
      /* 少一个文件不影响建议 */
    }
    if (rows.length > 20000) break;
  }
  const shape = labelShape(rows);
  return {
    dir,
    files: files.length,
    lines: rows.filter((l) => String(l).trim()).length,
    ...shape,
    note: shape.shaped ? "这是建议，点了才会写进配置" : "还没找到标签文件（数据集没构建？）",
  };
}

/** 盘上的权重（**只列不读内容**：读内容要 import torch，那是 `modelLibrary()` 那颗按钮的事）。 */
function scanModels(limit) {
  if (!root) return [];
  const found = [];
  const walk = (d, depth) => {
    if (depth > 2 || found.length >= (limit || 60)) return;
    let ents;
    try {
      ents = fs.readdirSync(d, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of ents) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) {
        if (e.name === ".versions" || e.name === "node_modules") continue;
        walk(p, depth + 1);
        continue;
      }
      if (!e.name.endsWith(".pt")) continue;
      let st;
      try {
        st = fs.statSync(p);
      } catch {
        continue;
      }
      found.push({ file: p.replace(/\\/g, "/"), bytes: st.size, mtime: st.mtimeMs, ...inferWeights(e.name) });
    }
  };
  walk(abs("models"), 0);
  found.sort((a, b) => b.mtime - a.mtime);
  return found;
}

const modelFacts = new Map();
/** 一枚权重的"已知事实"：读过权重就用权重说的，否则用文件名推断的，再不行就是 null（不猜）。 */
function factsFor(f) {
  const g = modelFacts.get(`${f.file}|${f.mtime}`);
  if (g && g.ok) return { task: g.task, nc: g.nc, version: g.version, imgsz: g.imgsz, optimizer: g.optimizer, source: "读自权重" };
  return f.known ? { task: f.task, source: "按文件名推断" } : null;
}
/** 读权重内嵌的 task / nc / 训练它的包版本。要 import torch（实测 ~10 秒），所以单独一个按钮、按 mtime 缓存。 */
async function modelLibrary(force) {
  const files = scanModels();
  if (!files.length) return { ok: true, items: [], probed: 0, error: "" };
  const need = files.filter((f) => force || !modelFacts.has(`${f.file}|${f.mtime}`));
  let err = "";
  if (need.length) {
    const py = await detectPython();
    if (!py.ok) return { ok: false, items: files, probed: 0, error: `没有可用的 python：${py.error}` };
    const code =
      "import json,sys\n" +
      "from ultralytics import YOLO\n" +
      "out=[]\n" +
      "for f in json.loads(sys.argv[1]):\n" +
      " try:\n" +
      "  m=YOLO(f); ck=getattr(m,'ckpt',None) or {}; ta=(ck.get('train_args') or {})\n" +
      "  out.append({'file':f,'ok':True,'task':m.task,'nc':getattr(m,'nc',None),'version':ck.get('version') or ta.get('version') or '','imgsz':ta.get('imgsz'),'optimizer':ta.get('optimizer')})\n" +
      " except Exception as e:\n" +
      "  out.append({'file':f,'ok':False,'error':str(e)[:180]})\n" +
      "print(json.dumps(out,ensure_ascii=True))\n";
    const r = await runOnce(py.path, ["-c", code, JSON.stringify(need.map((f) => f.file))], 180000);
    if (r.code !== 0) err = (r.err || r.out || "读权重失败").slice(-300);
    else {
      try {
        const got = JSON.parse(r.out.trim().split(/\r?\n/).pop());
        const byFile = {};
        for (const g of got) byFile[String(g.file).replace(/\\/g, "/")] = g;
        for (const f of need) {
          const g = byFile[f.file] || byFile[abs(f.file)] || { ok: false, error: "探测没返回这一项" };
          modelFacts.set(`${f.file}|${f.mtime}`, g);
        }
      } catch (e) {
        err = `探测输出读不出来：${(e && e.message) || e}`;
      }
    }
  }
  const items = files.map((f) => {
    const g = modelFacts.get(`${f.file}|${f.mtime}`);
    return { ...f, facts: factsFor(f), probeError: g && !g.ok ? g.error : "", familyKnown: f.known };
  });
  return { ok: !err, items, probed: need.length, error: err };
}

/** 当前权重该按哪个任务训：读得出来就用读出来的，读不出来用文件名，再不行留空（不猜）。 */
function weightsTaskFacts(weights) {
  const files = scanModels(80);
  const want = abs(weights || "").toLowerCase();
  const hit = files.find((f) => f.file.toLowerCase() === want.toLowerCase());
  if (hit) {
    const g = modelFacts.get(`${hit.file}|${hit.mtime}`);
    if (g && g.ok) return { task: g.task, source: "读自权重" };
    if (hit.known) return { task: hit.task, source: "按文件名推断" };
    return { task: "", source: "" };
  }
  const inf = inferWeights(weights);
  return inf.known ? { task: inf.task, source: "按文件名推断" } : { task: "", source: "" };
}

/**
 * 任务这一块的完整判断（面板一次拿到）：选了哪个、权重是什么、搭不搭、
 * 标签看起来像什么（建议，不自动落盘）、续训填得对不对。
 */
function taskBlock(eff) {
  const weights = (eff.train && (eff.train.weights || eff.train.model)) || "";
  const facts = weightsTaskFacts(weights);
  const chosen = String((eff.train && eff.train.task) || facts.task || "").trim();
  return {
    weights: String(weights || ""),
    chosen,
    facts,
    mismatch: taskMismatch(chosen, facts),
    suggest: detectTask(eff.dataset && eff.dataset.output_dir),
    resume: resumeGuard(eff.train && eff.train.resume),
  };
}

/* ============================ 工作区扫描 ============================ */

function countFiles(dir) {
  try {
    return fs.readdirSync(dir).filter((f) => /\.(jpg|jpeg|png|bmp)$/i.test(f)).length;
  } catch {
    return 0;
  }
}

/**
 * 数据集状态：以 `data.yaml` 为准（没有它 train.py 会直接 die）。
 *
 * 入参必须是**合并之后**的输出目录——只看面板覆盖会让"工作区 config.yaml 里配了数据集"
 * 的用户看到一个空面板（第一版就是这么写的，被测试当场抓住）。
 */
function scanDataset(dirIn) {
  const out = abs(dirIn || DEFAULTS.dataset.output_dir);
  const dataYaml = path.join(out, "data.yaml");
  const exists = fs.existsSync(dataYaml);
  let classes = [];
  if (exists) {
    try {
      const t = fs.readFileSync(dataYaml, "utf8");
      const m = /names:\s*([\s\S]*)$/.exec(t);
      if (m) {
        classes = m[1]
          .split(/\r?\n/)
          .map((l) => /^\s*\d+:\s*'?([^'\r\n]+)'?\s*$/.exec(l))
          .filter(Boolean)
          .map((x) => x[1].trim());
      }
    } catch {
      /* 读不动就当没有类别表，不影响训练 */
    }
  }
  return {
    dir: out,
    dataYaml,
    exists,
    trainCount: countFiles(path.join(out, "images/train")),
    valCount: countFiles(path.join(out, "images/val")),
    classes,
  };
}

/** 秒数 → 人能读的时长。0 / 缺失返回空串，界面自己决定显示成「—」。 */
function fmtDuration(sec) {
  var n = Math.round(Number(sec) || 0);
  if (n <= 0) return "";
  var h = Math.floor(n / 3600);
  var m = Math.floor((n % 3600) / 60);
  var s = n % 60;
  if (h) return h + "h " + String(m).padStart(2, "0") + "m";
  if (m) return m + "m " + String(s).padStart(2, "0") + "s";
  return s + "s";
}

/** 字节 → 人能读的体积（面板另有一份；插件侧日志/进度也用同一套口径）。 */
function fmtBytes(bytes) {
  const v = Number(bytes) || 0;
  if (v < 1024) return `${v} B`;
  if (v < 1024 * 1024) return `${(v / 1024).toFixed(1)} KB`;
  if (v < 1024 * 1024 * 1024) return `${(v / 1024 / 1024).toFixed(1)} MB`;
  return `${(v / 1024 / 1024 / 1024).toFixed(2)} GB`;
}

/** 训练记录：`<project>/<name>/results.csv` 的最后一行就是这一轮的最新指标。 */
function scanRuns(project) {
  const dir = project || abs(DEFAULTS.train.project);
  let names = [];
  try {
    names = fs
      .readdirSync(dir, { withFileTypes: true })
      .filter((e) => e.isDirectory())
      .map((e) => e.name);
  } catch {
    return [];
  }
  const runs = [];
  for (const name of names) {
    const d = path.join(dir, name);
    const best = path.join(d, "weights/best.pt");
    const csv = path.join(d, "results.csv");
    if (!fs.existsSync(csv)) continue;
    let epochs = 0;
    let last = null;
    let header = null;
    try {
      const lines = fs.readFileSync(csv, "utf8").trim().split(/\r?\n/);
      header = lines[0].split(",").map((s) => s.trim());
      const tail = lines[lines.length - 1].split(",").map((s) => s.trim());
      last = {};
      header.forEach((k, i) => {
        last[k] = tail[i];
      });
      epochs = lines.length - 1;
    } catch {
      continue;
    }
    let mtime = 0;
    try {
      mtime = fs.statSync(csv).mtimeMs;
    } catch {
      /* ignore */
    }
    // ultralytics 的 results.csv 有一列累计秒数 `time`；老记录没有这一列就留空。
    const elapsed = last ? Number(last.time) : 0;
    const durationSec = Number.isFinite(elapsed) && elapsed > 0 ? elapsed : 0;
    runs.push({
      name,
      dir: d.replace(/\\/g, "/"),
      epochs,
      hasBest: fs.existsSync(best),
      best: best.replace(/\\/g, "/"),
      mtime,
      durationSec,
      durationText: fmtDuration(durationSec),
      // CSV 的 mtime 就是最后一次写入的时刻；有累计时长时一并给出起点，界面拿去做 tooltip。
      finishedAt: mtime,
      startedAt: durationSec > 0 && mtime > 0 ? Math.round(mtime - durationSec * 1000) : 0,
      metrics: last
        ? {
            mAP50M: last["metrics/mAP50(M)"] || last["metrics/mAP50(B)"] || "",
            mAP5095M: last["metrics/mAP50-95(M)"] || last["metrics/mAP50-95(B)"] || "",
            precision: last["metrics/precision(M)"] || last["metrics/precision(B)"] || "",
            recall: last["metrics/recall(M)"] || last["metrics/recall(B)"] || "",
          }
        : null,
    });
  }
  runs.sort((a, b) => b.mtime - a.mtime);
  return runs;
}

/**
 * 投料口盘点：`$WS/annotations/`（详设之外的用户裁定——**标注用户自己来，面板只登记一个放数据的目录**）。
 *
 * 这一条**只数不写**：不建目录、不搬文件、不改文件名，一个字节都不碰。
 * 目录不存在就老实说"还没有"，「建一个」是用户点出来的按钮，不是插件的自作主张。
 * 计数有上限（一个标注文件夹可能上万张），超了就报 `truncated`，宁可少报也不要把面板卡住。
 */
const IMAGE_RE = /\.(jpg|jpeg|png|bmp)$/i;
function scanIntake() {
  const out = { dir: "", exists: false, subdirs: [], loose: { images: 0, json: 0, other: 0 }, truncated: false };
  if (!root) return out;
  out.dir = abs(INTAKE_DIR);
  let ents;
  try {
    ents = fs.readdirSync(out.dir, { withFileTypes: true });
  } catch {
    return out; // 没有 = 没有，不是错误
  }
  out.exists = true;
  const count = (d, depth, acc) => {
    let list;
    try {
      list = fs.readdirSync(d, { withFileTypes: true });
    } catch {
      return acc;
    }
    for (const e of list) {
      if (acc.n > 20000) {
        out.truncated = true;
        return;
      }
      const p = path.join(d, e.name);
      if (e.isDirectory()) {
        if (depth < 2) count(p, depth + 1, acc);
        continue;
      }
      acc.n++;
      if (IMAGE_RE.test(e.name)) acc.images++;
      else if (/\.json$/i.test(e.name)) acc.json++;
      else acc.other++;
    }
  };
  for (const e of ents) {
    const p = path.join(out.dir, e.name);
    if (!e.isDirectory()) {
      const acc = { n: 0, images: 0, json: 0, other: 0 };
      count(p, 0, acc);
      out.loose.images += acc.images;
      out.loose.json += acc.json;
      out.loose.other += acc.n - acc.images - acc.json;
      continue;
    }
    const acc = { n: 0, images: 0, json: 0, other: 0 };
    count(p, 0, acc);
    let mtime = 0;
    try {
      mtime = fs.statSync(p).mtimeMs;
    } catch {
      /* 只影响排序 */
    }
    out.subdirs.push({ name: e.name, path: p.replace(/\\/g, "/"), images: acc.images, json: acc.json, other: acc.n - acc.images - acc.json, mtime });
  }
  out.subdirs.sort((a, b) => b.mtime - a.mtime);
  return out;
}

/** 建投料口目录（用户点一下才建；里面放什么、怎么标，全是用户的事）。 */
function ensureIntake() {
  const dir = abs(INTAKE_DIR);
  fs.mkdirSync(dir, { recursive: true });
  return { dir, created: true, intake: scanIntake() };
}

/**
 * 素材来源怎么定（用户裁定："标注我自己在 X-AnyLabeling 里做，你给我留一个文件夹放数据，
 * 后面分离数据集的按钮直接从这个文件夹取"）。
 *
 * 优先级：`config.yaml` / 面板里显式写了 `sources` → 照它（那是用户自己的选择，不擅自改）；
 * 没写 → **自动取投料口 `annotations/` 下的每一个批次目录**（目录里有图或 json 才算一批，
 * 空目录不算，免得刚建好就报"找不到样本"）。`from` 会一路带到日志与界面上，
 * 因为"这次到底从哪儿读的数据"这种事不许靠猜。
 */
function resolveDatasetSources(effective, intakeIn) {
  const declared = (effective.dataset && effective.dataset.sources) || [];
  if (declared.length) return { sources: declared, from: "config" };
  const a = intakeIn || scanIntake();
  if (!a.exists) return { sources: [], from: "none" };
  const hits = (a.subdirs || []).filter((s) => s.images > 0 || s.json > 0).map((s) => s.path);
  if (hits.length) return { sources: hits, from: "intake" };
  if (a.loose.images > 0) return { sources: [a.dir], from: "intake" };
  return { sources: [], from: "intake-empty" };
}

/** 面板上「开跑前先看」：拿当前设置写一份**临时**预览快照，让 runner 用 --dry-run 解析一遍。 */
async function precheck(overrides) {
  needWorkspace();
  const { effective } = await effectiveConfig();
  const merged = merge(effective, dropNulls({}, overrides || {}));
  merged.dataset.output_dir = abs(merged.dataset.output_dir);
  merged.train.project = abs(merged.train.project);
  const py = await detectPython();
  if (!py.ok) return { ok: false, error: `找不到可用的 python：${py.error}` };
  const runner = path.join(PKG_DIR, "runner", "train_job.py").replace(/\\/g, "/");
  if (!fs.existsSync(runner)) return { ok: false, error: `插件包里没有 ${RUNNER}` };
  // 预览快照写在插件自己的状态目录里，**不进 train_runs/**：那一次都没开训，不该留下一份"实验"
  const preview = abs(`${STATE_DIR}/preview.yaml`);
  fs.mkdirSync(path.dirname(preview), { recursive: true });
  fs.writeFileSync(preview, dumpConfig(merged), "utf8");
  const run = await runOnce(py.path, [runner, "--config", preview, "--root", root, "--dry-run"], 90000);
  if (run.code !== 0) return { ok: false, error: (run.err || run.out || "解析失败").slice(-600) };
  try {
    const v = JSON.parse(run.out.trim().split(/\r?\n/).pop());
    return { ok: true, ...v, error: "" };
  } catch (e) {
    return { ok: false, error: `预览输出读不出来：${(e && e.message) || e}｜${(run.out || "").slice(-300)}` };
  }
}

/** `train_runs/` 里已有的实验快照（只读列出，供"这次是覆盖还是新建"与 W7 的复现用）。 */
function scanTrainRuns(limit) {
  if (!root) return [];
  const dir = abs(RUNS_DIR);
  let names = [];
  try {
    names = fs.readdirSync(dir).filter((f) => /\.yaml$/i.test(f));
  } catch {
    return [];
  }
  const items = names
    .map((f) => {
      const p = path.join(dir, f);
      let st;
      try {
        st = fs.statSync(p);
      } catch {
        return null;
      }
      return { name: f.replace(/\.yaml$/i, ""), file: p.replace(/\\/g, "/"), bytes: st.size, mtime: st.mtimeMs };
    })
    .filter(Boolean)
    .sort((a, b) => b.mtime - a.mtime);
  return items.slice(0, limit || 12);
}

/* ============================ 生成 config.yaml ============================ */

/**
 * YAML 输出。**只输出脚本真的会读的那几个键**，不试图做一个通用序列化器。
 *
 * 字符串一律双引号 + 转义反斜杠：YAML 双引号标量里 `\Y` 是非法转义，
 * 而 Windows 路径全是反斜杠——不转义的话用户会在日志里看到一句
 * "invalid escape sequence"，然后以为是插件坏了。
 */
function yq(s) {
  return '"' + String(s).replace(/\\/g, "/").replace(/"/g, '\\"') + '"';
}

/**
 * 面板送回来的值按元数据整形。
 *
 * 为什么要在写盘前做这件事：输入框里永远是字符串。`epochs: "300"` 侥幸能被引擎兜住，
 * 但 `time: ""`（用户没填）会把"不限时长"变成"时长是空串"，而 `cache: "false"` 会被
 * 当成一个非空字符串——**这类错都不报错，只是参数没生效**，是最难查的那一类。
 */
function coerceTrain(t) {
  const kinds = {};
  for (const g of PARAM_META) for (const it of g.items) kinds[it.key] = it.kind;
  const out = {};
  for (const [k, v] of Object.entries(t || {})) {
    const kind = kinds[k];
    if ((kind === "int" || kind === "num" || kind === "frac") && (v === "" || v === null)) continue; // 空 = 不传，交给引擎默认
    if ((kind === "int" || kind === "num" || kind === "frac") && typeof v === "string" && v.trim() !== "" && !isNaN(Number(v))) {
      out[k] = Number(v);
      continue;
    }
    // 下拉里 "false"/"true" 是字符串写法（`cache: False` 才是 YAML 布尔）；勾选框同理，别让字符串 "false" 变成真值
    if ((kind === "select" || kind === "bool") && (v === "false" || v === "true")) {
      out[k] = v === "true";
      continue;
    }
    out[k] = v;
  }
  return out;
}

function dumpConfig(c) {
  const L = [];
  const kv = (k, v, ind) => {
    const pad = " ".repeat(ind);
    if (typeof v === "boolean") L.push(`${pad}${k}: ${v ? "true" : "false"}`);
    else if (typeof v === "number" && Number.isFinite(v)) L.push(`${pad}${k}: ${v}`);
    else if (v === null || v === undefined) L.push(`${pad}${k}: null`);
    else L.push(`${pad}${k}: ${yq(v)}`);
  };
  const list = (k, arr, ind) => {
    const pad = " ".repeat(ind);
    if (!arr || !arr.length) {
      L.push(`${pad}${k}: []`);
      return;
    }
    L.push(`${pad}${k}:`);
    for (const it of arr) L.push(`${pad}  - ${typeof it === "number" ? it : yq(it)}`);
  };
  const emit = (k, v, ind) => {
    if (Array.isArray(v)) return list(k, v, ind);
    if (isObj(v)) {
      const entries = Object.entries(v);
      if (!entries.length) {
        L.push(`${" ".repeat(ind)}${k}: {}`);
        return;
      }
      L.push(`${" ".repeat(ind)}${k}:`);
      for (const [kk, vv] of entries) kv(kk, vv, ind + 2);
      return;
    }
    kv(k, v, ind);
  };

  L.push("env:");
  kv("proxy_enable", !!c.env.proxy_enable, 2);
  kv("proxy", c.env.proxy || "", 2);

  L.push("dataset:");
  list("sources", c.dataset.sources || [], 2);
  kv("output_dir", c.dataset.output_dir, 2);
  kv("val_ratio", Number(c.dataset.val_ratio), 2);
  kv("seed", Number(c.dataset.seed), 2);
  list("classes", c.dataset.classes || [], 2);
  emit("label_map", c.dataset.label_map || {}, 2);

  // 第三层快照的关键：**train 段整体透传**，不是逐个点名。
  // 用户的 `scripts/train.py` 只读它认识的那 20 个键（多余的键它看都不看，不报错），
  // 插件 runner 把剩下的也交给引擎——同一份文件，两边都成立。
  L.push("train:");
  const t = coerceTrain(c.train);
  for (const [k, v] of Object.entries(t)) emit(k, v, 2);
  // 快照是"整份配置的镜像"，不只是面板能改的那几项：工作区 config.yaml 里有 eval / export 段，
  // 就原样带过去——这样用户拿同一份文件去跑自己的 04 / 05 那两个 .bat 也成立。
  if (isObj(c.eval)) {
    L.push("eval:");
    for (const [k, v] of Object.entries(c.eval)) emit(k, v, 2);
  }
  if (isObj(c.export)) {
    L.push("export:");
    for (const [k, v] of Object.entries(c.export)) emit(k, v, 2);
  }
  return L.join("\n") + "\n";
}

/** 本次实验的 yaml 快照落点：`train_runs/<实验名>-<时间>.yaml`（详设 §4.1 第 3 层）。 */
function snapshotPathFor(kind, name, at) {
  const stem = (String(name || kind).replace(/[^\w.-]+/g, "-").replace(/^-+|-+$/g, "") || kind).slice(0, 60);
  const d = new Date(at || Date.now());
  const p = (n) => String(n).padStart(2, "0");
  const stamp = `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
  return abs(`${RUNS_DIR}/${kind === "train" ? `${stem}-${stamp}` : `${kind}-${stem}-${stamp}`}.yaml`);
}

/* ============================ job ============================ */

function newJob(kind, label) {
  const id = `j${++seq}-${Date.now().toString(36)}`;
  fs.mkdirSync(abs(RUNS_DIR), { recursive: true }); // 唯一写入点（详设 §6：只新增，不碰既有文件）
  fs.mkdirSync(abs("logs"), { recursive: true }); // 日志落 `$WS/logs/`（和用户既有习惯一致）
  return {
    id,
    kind,
    label,
    dir: abs(RUNS_DIR),
    state: "running",
    startedAt: Date.now(),
    endedAt: 0,
    code: null,
    stopped: false,
    pid: 0,
    lines: [],
    total: 0,
    progress: { phase: "", percent: 0, epoch: 0, epochs: 0, step: "", detail: "" },
    logPath: abs(`logs/yolo-${id}.log`),
  };
}

function snapshot(j) {
  if (!j) return null;
  return {
    id: j.id,
    kind: j.kind,
    label: j.label,
    state: j.state,
    startedAt: j.startedAt,
    endedAt: j.endedAt,
    code: j.code,
    pid: j.pid,
    progress: { ...j.progress },
    logPath: j.logPath,
    // 本次实验的 yaml 快照：面板上「复制这条命令 / 在资源管理器打开」都指它（W7 用它做复现）
    configPath: j.configPath || "",
    // 「退出码 0 但结果不对」那类提醒（构建出来 0 个标注框）：状态还是成功，但不能让它悄悄过去
    warning: j.warning || "",
    total: j.lines.length,
  };
}

let flushTimer = 0;
let pendingLines = [];

function pushLine(j, text, stream) {
  const line = String(text).replace(/\r$/, "");
  j.lines.push(line);
  if (j.lines.length > LOG_KEEP) j.lines.splice(0, j.lines.length - LOG_KEEP);
  pendingLines.push({ id: j.id, text: line, stream, at: Date.now() });
  if (pendingLines.length > 400) flushLog();
  else if (!flushTimer) flushTimer = setTimeout(flushLog, 120);
  try {
    fs.appendFileSync(j.logPath, line + "\n");
  } catch {
    /* 日志文件写不动不影响训练，内存里还有一份 */
  }
  parseProgress(j, line);
}

/** 日志按 120ms 一批推：ultralytics 一秒能吐几十行，一行一条 JSONL 会把宿主喂撑。 */
function flushLog() {
  flushTimer = 0;
  if (!pendingLines.length) return;
  const batch = pendingLines;
  pendingLines = [];
  try {
    ctx.panels.emit(PANEL, "log", { lines: batch });
  } catch {
    /* 面板没开就算了，日志还在内存与文件里 */
  }
  if (active) {
    try {
      ctx.panels.emit(PANEL, "job", snapshot(active));
    } catch {
      /* 同上 */
    }
  }
}

/**
 * 进度解析。只认脚本真的会打印的几种行——见文件头第 3 条。
 */
function parseProgress(j, line) {
  const p = j.progress;
  let changed = false;

  // 数据集：阶段推进 + 两个确定的数量
  if (j.kind === "dataset") {
    let m = /素材文件夹\s+(.+?)\s*:\s*(\d+)\s*个样本/.exec(line);
    if (m) {
      p.phase = "collect";
      p.detail = `读标注：${m[2]} 个样本`;
      changed = true;
    } else if ((m = /合计\s+(\d+)\s*个样本/.exec(line))) {
      p.phase = "collect";
      p.detail = `合计 ${m[1]} 个样本`;
      j.total = Number(m[1]) || j.total;
      changed = true;
    } else if ((m = /划分完成:\s*训练集\s*(\d+)\s*张\s*\/\s*验证集\s*(\d+)\s*张/.exec(line))) {
      p.phase = "split";
      p.detail = `训练 ${m[1]} / 验证 ${m[2]}`;
      changed = true;
    } else if (/清理旧文件\/缓存/.test(line)) {
      p.phase = "clean";
      p.detail = line.replace(/^\[[^\]]+\]\s*/, "");
      changed = true;
    } else if (/数据集构建完成/.test(line)) {
      p.phase = "done";
      p.percent = 100;
      changed = true;
    } else if (/^\s*\[\s*错误\s*\]|^\[错误\]/.test(line)) {
      p.phase = "error";
      changed = true;
    }
    // 转换写盘那一段没有逐条输出 ⇒ 只要还没完成，就把它标成"进行中"，不编百分比
    if (p.phase === "split" || p.phase === "clean") {
      p.percent = Math.max(p.percent, 45);
    } else if (p.phase === "done") {
      p.percent = 100;
    } else if (p.phase === "collect") {
      p.percent = Math.max(p.percent, 10);
    }
    if (changed) emitJob(j);
    return;
  }

  // 部署（deploy.ps1）：STEP 段落 + [OK] + Done
  if (/^\s*={4,}\s*/.test(line)) {
    p.phase = "deploy";
    p.stepName = line.replace(/[=\s]/g, "").slice(0, 40);
    p.detail = p.stepName;
    emitJob(j);
    return;
  }
  if (/\[OK\]/.test(line)) {
    p.done = Math.min((p.done || 0) + 1, 20);
    emitJob(j);
    return;
  }

  // 训练：ultralytics 每个 epoch 一行 "  12/300  3.2G  ..."
  let m = /^\s*(\d{1,4})\/(\d{1,4})\s+\S/.exec(line);
  if (m) {
    const e = Number(m[1]);
    const n = Number(m[2]);
    p.epoch = e;
    p.epochs = n;
    p.phase = "train";
    p.percent = n > 0 ? Math.min(99, Math.round((e / n) * 100)) : 0;
    p.detail = `第 ${e}/${n} 轮`;
    emitJob(j);
    return;
  }
  if (/开始训练/.test(line)) {
    p.phase = "start";
    p.detail = "正在加载模型与数据（前 2 分钟在准备数据属正常）";
    emitJob(j);
    return;
  }
  if (/训练完成/.test(line)) {
    p.phase = "done";
    p.percent = 100;
    emitJob(j);
    return;
  }
  if (/Traceback|CUDA out of memory|RuntimeError|FileNotFoundError/.test(line)) {
    p.phase = "error";
    p.detail = line.slice(0, 200);
    emitJob(j);
  }
}

function emitJob(j) {
  try {
    ctx.panels.emit(PANEL, "job", snapshot(j));
  } catch {
    /* 面板没开 */
  }
}

function finishJob(j, code) {
  if (j.state !== "running") return;
  j.state = code === 0 ? "succeeded" : "failed";
  j.code = code;
  j.endedAt = Date.now();
  // 提醒要在**任何一次事件发出之前**算好：`flushLog` 也会推一份 job 快照，
  // 先算就不会出现"前一份说成功、后一份才补提醒"的闪回。
  if (code === 0 && j.kind === "dataset") j.warning = datasetWarning(j.lines);
  if (j.stopped) {
    // 用户自己按的停止不是"失败"：进度条与措辞都要跟出错分开，否则看一眼就以为训练炸了
    j.progress.phase = "stopped";
    j.progress.detail = "你停掉的（不是出错）";
  } else if (j.state === "failed" && j.progress.phase !== "error") {
    j.progress.phase = "error";
    j.progress.detail = `进程退出码 ${code}（往上翻日志看最后一行 [错误]）`;
  }
  flushLog();
  pushLine(j, `[工作台] 进程结束，退出码 ${code}`, "sys");
  if (j.stopped) pushLine(j, "[工作台] 已按你的要求停止，产物停在最后一次写盘的位置", "sys");
  if (j.warning) pushLine(j, `[工作台] 提醒：${j.warning}`, "err");
  // 终态必须**自己发一次**：`flushLog` 只在"这一批确实有待发行"时才会顺带推 job 事件，
  // 而子进程的输出刚好在 120ms 的批之间被冲完时，批里是空的 —— 表现是面板永远停在"运行中"，
  // 只有下一次任务开始才解冻。这个竞态在满载的测试机上会被反复抓到。
  emitJob(j);
  if (code === 0) {
    lastFailure = null; // 成功一次就把上一次的失败结论清掉：留着会让用户以为还在失败
  } else {
    lastFailure = classifyFailure(j.lines);
    // "你停掉的"不配当一条失败归类来念（上面已经单独说过一次了，advice 还是空的）
    if (lastFailure && lastFailure.kind !== "unknown" && lastFailure.kind !== "stopped") {
      pushLine(j, `[工作台] 失败归类：${lastFailure.label} —— ${lastFailure.advice}`, "sys");
    }
  }
  if (j.kind === "eval") {
    // 评估结果落在 `train_runs/eval/<ts>/eval.json`：读回来推给面板，指标表 / 阈值表 / 图 / 错例一次到位
    const result = code === 0 ? readEvalResult(j.evalOut) : null;
    try {
      ctx.panels.emit(PANEL, "eval", { job: snapshot(j), result });
    } catch {
      /* 面板没开就算了，结果文件在盘上 */
    }
  }
  if (j.kind === "export") {
    const result = code === 0 ? readExportResult(j.exportOut) : null;
    try {
      ctx.panels.emit(PANEL, "export", { job: snapshot(j), result });
    } catch {
      /* 同上 */
    }
  }
  if (j.kind === "train" && j.runName) {
    const runDir = path.join(abs(j.project || DEFAULTS.train.project), j.runName);
    const has = (rel) => fs.existsSync(path.join(runDir, rel));
    writeRunMeta(j.runName, {
      status: j.stopped ? "stopped" : code === 0 ? "succeeded" : "failed",
      finishedAt: j.endedAt,
      exitCode: code,
      reason: j.stopped ? "你按的停止" : code === 0 ? "" : (lastFailure && lastFailure.label) || "",
      artifacts: {
        best: has("weights/best.pt"),
        last: has("weights/last.pt"),
        resultsCsv: has("results.csv"),
        argsYaml: has("args.yaml"),
      },
      datasetFingerprint: j.datasetFingerprint || "",
      log: j.logPath,
      snapshot: j.configPath || "",
    });
  }
  if (active === j) active = null;
}

/**
 * 起一个 job：写本次实验的 yaml 快照（`train_runs/`）→ spawn → 逐行喂给 pushLine。
 *
 * 训练走**插件自带的 runner**，数据集构建继续走工作区自己的 `scripts/build_dataset.py`。
 * 为什么训练要换：用户那份 `train.py` 把参数逐个硬编码，只认 20 个键，面板新增的
 * `lr0 / mosaic / freeze` 它根本不会读；而红线又不许改他的脚本（详设 §4.4 裁定①）。
 * 两边吃的是**同一份 yaml**，所以手动仍然复现得起来——日志里把两条命令都打出来。
 */
async function startJob(kind, overrides) {
  needWorkspace();
  if (active) throw new Error(`已经有一个任务在跑（${active.label}）：先停掉它再开始新的`);
  const { effective } = await effectiveConfig();
  // null 在这里的含义是"这一项不要了"（面板清空输入框时送回来的就是它），不能让 `weights: null` 落到 yaml 里
  const merged = merge(effective, dropNulls({}, overrides || {}));
  merged.dataset.output_dir = abs(merged.dataset.output_dir);
  merged.train.project = abs(merged.train.project);

  const py = await detectPython();
  if (!py.ok) throw new Error(`找不到可用的 python（试过 ${py.source}：${py.path}）：${py.error}`);

  if (kind === "train") {
    // 开跑前拦两道（详设 §1.3 / §1.5）：任务与权重不搭、续训指错文件。
    // 这两条引擎自己也会拒，但拒在 30 秒之后的一行 traceback 里，不如现在说人话。
    const block = taskBlock(merged);
    if (!block.mismatch.ok) throw new Error(block.mismatch.why);
    if (!block.resume.ok) throw new Error(block.resume.why);
    // P177-E 磁盘守卫：按同类 run 的实测体积 × 1.5 预估。宁可现在说一句，也不要跑到一半盘满。
    const disk = await diskGuard();
    if (!disk.ok) throw new Error(disk.note);
  }

  const runner = kind === "train" ? path.join(PKG_DIR, "runner", "train_job.py").replace(/\\/g, "/") : abs("scripts/build_dataset.py");
  if (!fs.existsSync(runner)) {
    throw new Error(
      kind === "train"
        ? `插件包里没有 ${RUNNER}：这份插件装得不完整，重装一次（runner 是插件自带的，不在工作区里）`
        : `工作区里没有 ${runner}：这个面板要配合 YOLO-Workspace 的 scripts/ 使用`,
    );
  }

  const label = kind === "dataset" ? "构建数据集" : `训练 ${merged.train.name}`;
  let job;
  try {
    job = newJob(kind, label);
  } catch (e) {
    throw explainCage(e, "建任务目录（train_runs）失败");
  }
  if (kind === "dataset") {
    // 没显式写 sources 就从投料口自动取——用户裁定的那条"分离数据集直接读这个文件夹"
    const resolved = resolveDatasetSources(merged);
    merged.dataset.sources = resolved.sources;
    job.sourcesFrom = resolved.from;
  }

  const confPath = snapshotPathFor(kind, kind === "train" ? merged.train.name : path.basename(merged.dataset.output_dir || "ds"), job.startedAt);
  try {
    fs.writeFileSync(confPath, dumpConfig(merged), "utf8");
  } catch (e) {
    throw explainCage(e, "写本次实验的快照失败（" + confPath + "）");
  }

  job.configPath = confPath;
  job.project = String(merged.train.project || "");
  job.dataPath = String(merged.train.data || path.join(merged.dataset.output_dir || "", "data.yaml")).replace(/\\/g, "/");
  job.datasetFingerprint = datasetFingerprintFor(merged.dataset.output_dir);
  if (kind === "train") {
    job.runName = String(merged.train.name || "");
    writeRunMeta(job.runName, {
      status: "running",
      jobId: job.id,
      startedAt: job.startedAt,
      snapshot: confPath,
      log: job.logPath,
      dataPath: job.dataPath,
      datasetFingerprint: job.datasetFingerprint,
      pluginVersion: PLUGIN_VERSION,
      appVersion: "",
    });
  }
  rememberPath("weights", merged.train.weights, "train");
  rememberPath("data", job.dataPath, "train");
  rememberPath("output_dir", merged.dataset.output_dir, kind);
  for (const src of merged.dataset.sources || []) rememberPath("sources", src, kind);
  jobs.set(job.id, job);
  active = job;

  pushLine(job, `[工作台] python: ${py.path}（${py.source}）`, "sys");
  pushLine(job, `[工作台] 本次实验快照: ${confPath}`, "sys");
  if (kind === "dataset") {
    const n = (merged.dataset.sources || []).length;
    const from = job.sourcesFrom;
    pushLine(
      job,
      `[工作台] 素材来源: ${from === "intake" ? `投料口 annotations/ 自动取的 ${n} 批` : from === "config" ? `配置里显式写的 ${n} 个目录` : from === "intake-empty" ? "投料口是空的：把 X-AnyLabeling 导出的文件夹放进 annotations/ 再试" : "（没填，且投料口还不存在）"}`,
      "sys",
    );
  }
  pushLine(job, `[工作台] 命令: "${py.path}" "${runner}" --config "${confPath}"`, "sys");
  if (kind === "train") {
    pushLine(job, `[工作台] 手动等价（吃同一份快照，但只认它自己那 20 个键）: "${py.path}" "${abs("scripts/train.py")}" --config "${confPath}"`, "sys");
  }

  try {
    const child = ctx.process.spawn({
      cmd: py.path,
      args: kind === "train" ? [runner, "--config", confPath, "--root", root] : [runner, "--config", confPath],
      cwd: root,
      env: {
        ...PY_ENV,
        
        OPENBLAS_NUM_THREADS: "1",
        KMP_DUPLICATE_LIB_OK: "TRUE",
        CUDA_MODULE_LOADING: "LAZY",
      },
      onStdout: (l) => pushLine(job, l, "out"),
      onStderr: (l) => pushLine(job, l, "err"),
      onExit: (code) => finishJob(job, code),
      onError: (e) => {
        pushLine(job, `[工作台] 起进程失败：${(e && e.message) || e}`, "sys");
        finishJob(job, -1);
      },
    });
    job.pid = child.pid || 0;
    job.child = child; // stop() 要用它：直接 kill 能带走整棵子树由宿主负责（taskkill /T）
  } catch (e) {
    pushLine(job, `[工作台] 起进程失败：${(e && e.message) || e}`, "sys");
    finishJob(job, -1);
    throw e;
  }
  return snapshot(job);
}

/** 覆盖层里 `null` = 删掉这个键（面板上的输入框被清空时送回来的就是 null）。 */
function dropNulls(base, patch) {
  const out = merge(base, patch);
  for (const [sec, val] of Object.entries(patch || {})) {
    if (!isObj(val) || !isObj(out[sec])) continue;
    for (const [k, v] of Object.entries(val)) if (v === null) delete out[sec][k];
  }
  return out;
}

/**
 * 覆盖层只存"与基准不同的那些键"（详设 §4.1）。
 *
 * 参数面从 8 个涨到 40 多个以后，这条从"整洁"变成了**正确性**：不剪的话，用户每保存一次
 * 就把整张表抄进 config.json，以后他改工作区的 `config.yaml`，面板的覆盖会永远压在它上面——
 * 表现是"我明明改了配置，怎么没生效"。
 */
function pruneToBase(next, base) {
  const out = {};
  for (const [sec, val] of Object.entries(next || {})) {
    if (!isObj(val)) {
      out[sec] = val;
      continue;
    }
    const b = isObj(base[sec]) ? base[sec] : {};
    const keep = {};
    for (const [k, v] of Object.entries(val)) {
      const same = typeof v === "number" && typeof b[k] === "number" ? Math.abs(v - b[k]) < 1e-12 : v === b[k];
      if (!same) keep[k] = v;
    }
    if (Object.keys(keep).length) out[sec] = keep;
  }
  return out;
}

/** 落盘一份面板覆盖，并把新状态还给面板。`saveConfig` 与「投料口→素材来源」共用这一条。 */
async function applyPatch(patch) {
  if (!isObj(patch)) throw new Error("patch 必须是对象");
  const cur = readOverrides();
  const mergedBase = merge(DEFAULTS, (await readBaseConfig()).value || {});
  const next = pruneToBase(dropNulls(cur, patch), mergedBase);
  fs.mkdirSync(path.dirname(overridesPath()), { recursive: true });
  fs.writeFileSync(overridesPath(), JSON.stringify(next, null, 2), "utf8");
  baseCache = { mtime: 0, value: null, error: "", source: "" }; // 让下次 state() 重算
  try {
    rememberConfigPaths((await effectiveConfig()).effective);
  } catch {
    /* 记路径失败不影响保存 */
  }
  return await panelState();
}

/* ============================ 面板 API ============================ */

/**
 * 部署工具目录（`$EXT:deploy`）现在长什么样。
 *
 * **只读声明就能拿到路径**：路径是用户绑的，不是插件写死的。没绑就返回 `bound:false`，
 * 面板上一句话说明"还没配部署工具"，而不是让整个插件起不来——
 * 训练和部署本来就是两件事，缺后者不该拖住前者。
 */
function scanDeployTool() {
  const dir = String((ctx && typeof ctx.root === "function" && ctx.root("deploy")) || "").replace(/\\/g, "/");
  if (!dir) return { dir: "", bound: false, ready: false, runBat: false, configs: [], error: "" };
  try {
    const ents = fs.readdirSync(dir, { withFileTypes: true });
    const configs = ents
      .filter((e) => e.isFile() && /^deploy_config.*\.ps1$/i.test(e.name))
      .map((e) => e.name)
      .sort();
    const runBat = ents.some((e) => e.isFile() && e.name.toLowerCase() === "run.bat");
    return { dir, bound: true, ready: runBat && configs.length > 0, runBat, configs, error: "" };
  } catch (e) {
    // 绑了但读不到（目录被删/没权限）：说清楚，别装成"没配"
    return { dir, bound: true, ready: false, runBat: false, configs: [], error: String((e && e.message) || e) };
  }
}


/* ============================ 部署（$EXT:deploy） ============================ */

/**
 * 读一份 `deploy_config*.ps1` 里的关键变量。
 *
 * **只取那几个 `$Xxx = "..."` 行**，不解析 PowerShell 脚本本身：那是一门完整的语言，
 * 用正则去"理解"它迟早会把 `$Model` 读成注释里的那一句。读不准就说"没读到"，不猜。
 */
function readDeployConfig(name) {
  const tool = scanDeployTool();
  if (!tool.bound) return { ok: false, error: "还没绑外部目录 deploy：去「插件」面板顶部绑一次" };
  if (!name) return { ok: false, error: "没有选配置文件" };
  const p = path.join(tool.dir, name);
  if (!fs.existsSync(p)) return { ok: false, error: `没有这个配置文件：${name}` };
  const text = fs.readFileSync(p, "utf8");
  const pick = (v) => {
    // 值可能带引号也可能不带（$ImgszW = 640）。注释行以 # 开头，^\s*$ 天然不会命中它。
    const m = new RegExp("^\\s*\\$" + v + "\\s*=\\s*(?:\"([^\"]*)\"|([^#\\r\\n]*))", "m").exec(text);
    if (!m) return "";
    return (m[1] !== undefined ? m[1] : String(m[2] || "").trim());
  };
  return {
    ok: true,
    name,
    path: p,
    model: pick("Model"),
    modelName: pick("ModelName"),
    imgsz: `${pick("ImgszW") || "?"}×${pick("ImgszH") || "?"}`,
    python: pick("PythonExe"),
    docker: pick("DockerImage"),
    // 校准图与 opset 也要读出来：换数据集后最容易忘改的就是校准来源，量化的好坏全看它
    calib: pick("CalibSources"),
    opset: pick("Opset"),
    labels: pick("Labels"),
  };
}

/** 工作区里最新的 `runs/<run>/weights/best.pt`（按 mtime）。 */
function latestBest(project) {
  // 跟着配置里的 project 走：有人把训练产物放到别的盘，写死 runs 就会"找不到训练产物"
  const base = String(project || abs("runs")).replace(/\\/g, "/");
  const runs = scanRuns(base).map((r) => {
    const bp = path.join(base, r.name, "weights", "best.pt").replace(/\\/g, "/");
    return { ...r, bestPath: fs.existsSync(bp) ? bp : "" };
  });
  const withBest = runs.filter((r) => r.bestPath);
  let best = null;
  for (const r of withBest) {
    try {
      const t = fs.statSync(r.bestPath).mtimeMs;
      if (!best || t > best.at) best = { at: t, path: r.bestPath, run: r.name };
    } catch {
      /* 文件刚被删 */
    }
  }
  return best;
}

/**
 * 交付：把最新一次训练的 `best.pt` 复制到 `models/delivered/<名字>-best.pt`。
 *
 * 为什么不直接把 `$Model` 指向 `runs/…/weights/best.pt`：那个目录会被下一次训练覆盖。
 * 交付的意思是**留一份**，名字固定，部署脚本与 README 都指得稳。
 */
function deliverBest(modelName, project) {
  const best = latestBest(project);
  if (!best) return { ok: false, error: "工作区里没有找到训练产物（runs/<run>/weights/best.pt）" };
  const dstDir = abs("models/delivered");
  fs.mkdirSync(dstDir, { recursive: true });
  // 传对象/路径/空串都要能活：旧版 String({}) 会生出一个 -object-Object--best.pt
  let hinted = isObj(modelName)
    ? String(modelName.name || modelName.run || modelName.file || "")
    : String(modelName == null ? "" : modelName);
  hinted = hinted.trim();
  if (/[\\/]/.test(hinted)) hinted = path.basename(hinted).replace(/\.pt$/i, "");
  let stem = hinted.replace(/[^\w.-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 60);
  if (!stem || /object-Object/i.test(stem)) {
    stem = String(best.run || "model").replace(/[^\w.-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 60) || "model";
  }
  const srcSha = sha256File(best.path);
  let dst = path.join(dstDir, `${stem}-best.pt`);
  if (fs.existsSync(dst)) {
    if (srcSha && sha256File(dst) === srcSha) {
      return { ok: true, path: dst.replace(/\\/g, "/"), from: best.path, run: best.run, bytes: fs.statSync(dst).size, duplicate: true, sha256: srcSha };
    }
    for (let n = 2; fs.existsSync(dst) && n < 100; n++) dst = path.join(dstDir, `${stem}-${n}-best.pt`);
  }
  fs.copyFileSync(best.path, dst);
  return {
    ok: true,
    path: dst.replace(/\\/g, "/"),
    from: best.path,
    run: best.run,
    bytes: fs.statSync(dst).size,
    duplicate: false,
    sha256: srcSha || sha256File(dst),
  };
}

/**
 * 生成**包装配置**：先 dot-source 用户那份，再覆盖 `$Model` / `$ModelName`。
 *
 * 这样 `deploy.ps1` 的 `. $Config` 读到的是一份"用户配置 + 我们这两行"，而用户那份
 * `deploy_config.*.ps1` **一个字节都没动**。改用户文件是这类工具最容易越界的地方：
 * 它没有版本控制、也没有备份，改坏了用户只能自己回忆原样。
 *
 * `calibSamples`：这次训练用的数据集里的 `images/train`。**校准图必须跟着模型走**——
 * 换数据集之后忘了改 `$CalibSources`，量化就会拿旧场景的图校准，板子上精度掉得莫名其妙。
 */
function writeWrapper(cfgName, modelPath, modelName, calibSamples) {
  const dir = path.join(root, STATE_DIR, "deploy");
  fs.mkdirSync(dir, { recursive: true });
  const tool = scanDeployTool();
  const src = path.join(tool.dir, cfgName).replace(/\\/g, "/");
  const out = path.join(dir, `auto-${String(modelName || "model").replace(/[^\w.-]+/g, "-")}.ps1`);
  const ps = (v) => `"${String(v).replace(/"/g, '`"')}"`;
  const lines = [
    "# 由 uartix.yolo 生成：不要手改（每次部署会覆盖）",
    "# 先读用户那份配置（只读），再覆盖下面几行",
    `. ${ps(src)}`,
    "",
    `$ModelName = ${ps(modelName)}`,
    `$Model     = ${ps(modelPath)}`,
  ];
  if (calibSamples) lines.push(`$CalibSources = ${ps(calibSamples)}`);
  lines.push("");
  const text = lines.join("\n");
  // PowerShell 5.1 读没有 BOM 的脚本时按系统代码页（这台是 GBK）解析：
  // 中文模型名/路径会被读坏。带 BOM 才会按 UTF-8 读。
  fs.writeFileSync(out, "\uFEFF" + text, "utf8");
  return out;
}

/** 部署状态的快照（面板「部署」页一次拿全）。 */
/**
 * 可以拿来部署的权重：训练产物（每个 run 的 best.pt）、交付区、模型库。
 * 用户要能"选之前训的那一版"，而不是永远只部署最新一次。
 */
function deployCandidates(project) {
  const out = [];
  const seen = new Set();
  const push = (p, kind, extra) => {
    const k = String(p).replace(/\\/g, "/");
    if (seen.has(k) || !fs.existsSync(k)) return;
    seen.add(k);
    let at = 0;
    try {
      at = fs.statSync(k).mtimeMs;
    } catch {
      /* 刚被删 */
    }
    out.push({ path: k, kind, name: path.basename(k), at, ...extra });
  };
  for (const r of scanRuns(project)) {
    if (!r.hasBest) continue;
    push(r.best, "run", { run: r.name, mAP50: r.metrics ? r.metrics.mAP50M : "", epochs: r.epochs });
  }
  try {
    for (const f of fs.readdirSync(abs("models/delivered"))) {
      if (/\.pt$/i.test(f)) push(path.join(abs("models/delivered"), f).replace(/\\/g, "/"), "delivered", {});
    }
  } catch {
    /* 还没交付过 */
  }
  try {
    for (const f of fs.readdirSync(abs("models"))) {
      if (/\.pt$/i.test(f)) push(path.join(abs("models"), f).replace(/\\/g, "/"), "models", {});
    }
  } catch {
    /* 没有模型库 */
  }
  return out.sort((a, b) => b.at - a.at).slice(0, 24);
}

/** 能当校准来源的目录：工作区里每个数据集的 images/train（有图才算）。 */
function calibCandidates() {
  const out = [];
  for (const d of scanDatasetDirs()) {
    const train = path.join(String(d.dir).replace(/\\/g, "/"), "images", "train").replace(/\\/g, "/");
    let n = 0;
    try {
      n = fs.readdirSync(train).filter((f) => /\.(jpe?g|png|bmp)$/i.test(f)).length;
    } catch {
      continue;
    }
    if (n) out.push({ path: train, dataset: d.name || path.basename(d.dir), images: n });
  }
  return out;
}

/** GPU 列表（device 下拉用）。问不到 nvidia-smi 就只给 cpu。 */
async function deviceChoices() {
  const r = await runOnce("nvidia-smi", ["--query-gpu=index,name", "--format=csv,noheader"], 4000);
  const out = [];
  if (r.code === 0) {
    for (const line of String(r.out || "").split(/\r?\n/)) {
      const m = /^\s*(\d+)\s*,\s*(.+)$/.exec(line);
      if (m) out.push({ value: m[1], label: `${m[1]} · ${m[2].trim()}` });
    }
  }
  out.push({ value: "cpu", label: "cpu（没有 CUDA，或想复现结果）" });
  return out;
}

/**
 * Docker 引擎能不能用，以及"不能用"卡在哪一层。
 *
 * `docker version` 问的是**引擎**（Server），不是 CLI：Docker Desktop 的 CLI 常在，引擎却没起。
 * 引擎没起时再测一次 WSL 的系统发行版——"一直转圈"最常见的根因是 WSL 连虚拟机都创建不出来
 * （HCS/ERROR_NOT_FOUND），那和插件权限、目录绑定、管理员身份都无关。
 */
async function dockerEnv() {
  const v = await runOnce("docker", ["version", "--format", "{{.Server.Version}}"], 8000);
  const version = String(v.out || "")
    .split(/\r?\n/)
    .map((s) => s.trim())
    .filter(Boolean)
    .pop() || "";
  if (v.code === 0 && /^\d+\.\d+/.test(version)) return { ok: true, version, wsl: "ok", error: "", hint: "" };

  const raw = String(v.err || v.out || "")
    .split(/\r?\n/)
    .map((s) => s.trim())
    .filter(Boolean);
  const error = raw.slice(-2).join(" ") || "docker version 没有输出";
  // 只有引擎没起时才测 WSL：这一步会真的创建虚拟机，正常机器上要几秒
  const w = await runOnce("wsl", ["--system", "-e", "echo", "ok"], 20000);
  if (w.code === 0) {
    return {
      ok: false,
      version: "",
      wsl: "ok",
      error,
      hint: "Docker 引擎没起来，但 WSL 正常。先打开 Docker Desktop（管理员或普通身份都行），等鲸鱼图标不再转圈再部署。",
    };
  }
  return {
    ok: false,
    version: "",
    wsl: "broken",
    error,
    hint:
      "WSL 连自己的系统虚拟机都创建不出来（常见错误码 Wsl/Service/CreateInstance/CreateVm/HCS/ERROR_NOT_FOUND），Docker 只是受害者。\n" +
      "这不是插件没权限，也不是「以管理员身份运行」能解决的。在【管理员】PowerShell 里依次执行：\n" +
      "  wsl --shutdown\n" +
      "  wsl --update\n" +
      "然后重启电脑。开机后先跑 wsl -d docker-desktop -e echo ok，能回 ok 再开 Docker Desktop。",
  };
}

/**
 * **候选清单的唯一来源**：训练页的权重 / 数据集 / 设备、评估与导出页的权重、部署页的模型与校准图，
 * 全部从这里取。以后多一种来源（比如从市场下载的模型、第二块盘上的数据集），只改这一个函数，
 * 四个页面一起长出来 —— 不要在各自的页面里再抄一份扫描逻辑。
 */
async function pickLists() {
  const { effective } = await effectiveConfig();
  const project = effective.train.project;
  const datasets = scanDatasetDirs().map((d) => {
    let classes = [];
    try {
      const y = readDataYaml(d.dataYaml);
      classes = (y && y.names) || [];
    } catch {
      /* 读不出来就不带类别 */
    }
    return { ...d, classes };
  });
  return {
    models: deployCandidates(project),
    official: officialModels().map((m) => ({ name: m.name, label: m.label, task: m.task })),
    datasets,
    devices: await deviceChoices(),
    calib: calibCandidates(),
    recent: readPrefs().recent,
    current: {
      weights: String((effective.train && effective.train.weights) || "").replace(/\\/g, "/"),
      data: path.join(abs(effective.dataset.output_dir || ""), "data.yaml").replace(/\\/g, "/"),
    },
  };
}

/* ============================ 部署目标画像（P177-D） ============================ */

/**
 * 一个目标画像，不是两个。两份 `deploy_config*.ps1` 只是两份**外部底座**（只读），
 * 它们之间的差别是部署实例的参数，不是两套硬件。
 */
const DEPLOY_TARGET = {
  id: "maixcam2-pulsar2-4.0",
  title: "MaixCAM2 · Pulsar2 4.0",
  tool: { kind: "maixcam2_deploy", runBat: "run.bat", deployPs1: "deploy.ps1" },
  input: { width: 640, height: 480, opset: 11 },
  runtime: { dockerImage: "pulsar2:4.0" },
  model: { families: ["yolo11", "yolov8"], tasks: ["detect", "segment"], labels: "from-model" },
  calibration: { samples: 100, seed: 42, minSamples: 60, sourcePolicy: "dataset-train-images" },
  outputs: { workDir: "work", calibDir: "calib", outDir: "out", deployDir: "deploy" },
  // YOLO26 是插件能训的，但**目标工具没声明支持**：不拦死，只给警告，让用户自己决定
  unsupportedFamilies: ["yolo26"],
};

function deployConfigIssues(cfg, effective) {
  const out = [];
  if (!cfg || !cfg.ok) return out;
  const targetData = path.join(abs(effective.dataset.output_dir || ""), "images", "train").replace(/\\/g, "/").toLowerCase();
  const calib = String(cfg.calib || "").replace(/\\/g, "/").toLowerCase();
  if (cfg.model && /\/models\/delivered\/best\.pt$|\/models\/best\.pt$/i.test(String(cfg.model).replace(/\\/g, "/"))) {
    out.push({ level: "warn", text: "模型指向旧 best.pt（不是某次 run 的固定版本）" });
  }
  if (cfg.modelName === "best") {
    out.push({ level: "warn", text: "模型名是通用的 best——上板后分不清是哪一版" });
  }
  if (calib && targetData && calib !== targetData) {
    out.push({ level: "warn", text: `校准来源 ${cfg.calib} 与当前数据集的 images/train 不一致；量化可能偏，建议改成当前数据集` });
  }
  if (String(cfg.opset || "") && String(cfg.opset) !== String(DEPLOY_TARGET.input.opset)) {
    out.push({ level: "warn", text: `opset=${cfg.opset}（目标画像默认 ${DEPLOY_TARGET.input.opset}）` });
  }
  if (cfg.docker && String(cfg.docker) !== DEPLOY_TARGET.runtime.dockerImage) {
    out.push({ level: "warn", text: `镜像 ${cfg.docker}（目标画像默认 ${DEPLOY_TARGET.runtime.dockerImage}）` });
  }
  return out;
}

function countImages(dir, cap) {
  let n = 0;
  const walk = (d, depth) => {
    if (depth > 2 || n >= (cap || 5000)) return;
    let ents = [];
    try {
      ents = fs.readdirSync(d, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of ents) {
      if (n >= (cap || 5000)) return;
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p, depth + 1);
      else if (IMAGE_RE.test(e.name)) n += 1;
    }
  };
  walk(dir, 0);
  return n;
}

/** 开跑前校验：只读、不启动任何进程。blockers 拦住，warnings 需要用户勾一下。 */
async function deployPrecheck(req) {
  needWorkspace();
  const o = isObj(req) ? req : {};
  const { effective } = await effectiveConfig();
  const checks = [];
  const blockers = [];
  const warnings = [];
  const add = (level, text, extra) => {
    const row = { level, text, ...(extra || {}) };
    checks.push(row);
    if (level === "bad") blockers.push(row);
    if (level === "warn") warnings.push(row);
  };

  const modelPath = abs(String(o.model || effective.train.weights || ""));
  const modelFacts = modelPath && fs.existsSync(modelPath) ? (scanModels(80).find((f) => f.file.toLowerCase() === modelPath.toLowerCase()) || null) : null;
  const inf = inferWeights(modelPath);
  if (!modelPath || !fs.existsSync(modelPath)) add("bad", `找不到要部署的权重：${modelPath || "(没填)"}`);
  else {
    add("ok", `模型：${path.basename(modelPath)}（${fmtBytes(fs.statSync(modelPath).size)}）`);
    const task = (modelFacts && modelFacts.task) || inf.task || "";
    if (!task) add("warn", "读不出任务（文件名也不是官方命名）：部署前请确认它是检测还是分割");
    else if (!DEPLOY_TARGET.model.tasks.includes(task)) add("bad", `目标只支持 ${DEPLOY_TARGET.model.tasks.join(" / ")}，这枚是 ${task}`);
    else add("ok", `任务：${task}`);
    const fam = (modelFacts && modelFacts.family) || inf.family || "";
    if (fam && DEPLOY_TARGET.unsupportedFamilies.includes(fam)) {
      add("warn", `${fam} 是插件能训的，但目标工具（Pulsar2 4.0 配方）没有声明支持；导出的包可能上不了板`);
    }
  }

  // 配方里的 $Labels 非空时：数量必须和权重自带类别数一致，否则上板后类别整体错位
  const cfg = o.cfgName ? readDeployConfig(String(o.cfgName)) : null;
  if (cfg && cfg.ok && String(cfg.labels || "").trim()) {
    const want = String(cfg.labels).split(/[,，\s]+/).filter(Boolean).length;
    const facts = modelFacts ? factsFor(modelFacts) : null;
    const nc = facts && facts.nc != null ? facts.nc : null;
    if (nc != null && want !== Number(nc)) {
      add("bad", `配方的 Labels 有 ${want} 个类别，而权重自带 ${nc} 个：上板后类别会整体错位`);
    } else {
      add("ok", `Labels：${want} 个类别${nc != null ? "（与权重一致）" : "（权重没读过 nc，跑之前点一次「读一遍权重」）"}`);
    }
    const dsN = (effective.dataset.classes || []).length;
    if (dsN && want !== dsN) add("warn", `Labels 有 ${want} 个，当前数据集类别表有 ${dsN} 个：确认这是同一套类别顺序`);
  }

  const calibDir = String(o.calib || "").trim();
  if (!calibDir || calibDir === "@config") {
    add("warn", "校准来源跟配置文件走：面板没法替你核对它是不是当前训练集");
  } else if (!fs.existsSync(calibDir)) {
    add("bad", `校准目录不存在：${calibDir}`);
  } else {
    const n = countImages(calibDir, DEPLOY_TARGET.calibration.minSamples + 1);
    if (n < DEPLOY_TARGET.calibration.minSamples) add("bad", `校准图只有 ${n} 张，少于目标要求的 ${DEPLOY_TARGET.calibration.minSamples} 张`);
    else add("ok", `校准图：${n} 张`);
    const want = path.join(abs(effective.dataset.output_dir || ""), "images", "train").replace(/\\/g, "/").toLowerCase();
    const got = calibDir.replace(/\\/g, "/").toLowerCase();
    if (want && got !== want) {
      add("warn", "校准来源不是当前训练数据集的 images/train；INT8 量化可能偏，确认后勾选再跑");
    } else if (want) {
      add("ok", "校准来源与训练数据集一致");
    }
  }

  const imgsz = Number(o.imgsz || DEPLOY_TARGET.input.width) || DEPLOY_TARGET.input.width;
  if (imgsz % 32 !== 0) add("bad", `输入宽度 ${imgsz} 不是 32 的倍数`);
  else add("ok", `输入 ${imgsz}×${DEPLOY_TARGET.input.height}`);
  if (Number(o.opset || DEPLOY_TARGET.input.opset) !== DEPLOY_TARGET.input.opset) {
    add("warn", `opset=${o.opset} 与目标默认 ${DEPLOY_TARGET.input.opset} 不同`);
  }
  const env = await dockerEnv();
  if (env.ok) add("ok", `Docker ${env.version || "可用"}`);
  else add(env.wsl === "broken" ? "bad" : "warn", env.hint || env.error || "Docker 不可用");

  return { ok: blockers.length === 0, target: DEPLOY_TARGET, checks, blockers, warnings, needsCalibConfirm: warnings.some((w) => /校准来源不是当前训练数据集/.test(w.text)) };
}

/** 在外部目录里找一次打包的产物：只在 deploy/out/work/logs 里按名字找，不递归整盘。 */
function scanExternalArtifacts(modelName) {
  const tool = scanDeployTool();
  if (!tool.bound) return { bound: false, dir: "", artifacts: [], meta: "", log: "", error: "还没绑外部目录" };
  const name = String(modelName || "");
  if (!name) return { bound: true, dir: tool.dir, artifacts: [], meta: "", log: "", error: "没有模型名" };
  const want = [
    `${name}.mud`,
    `${name}_npu.axmodel`,
    `${name}_vnpu.axmodel`,
    `${name}.axmodel`,
    `demo_${name}.py`,
  ];
  const artifacts = [];
  for (const sub of ["deploy", "out"]) {
    const d = path.join(tool.dir, sub);
    for (const f of want) {
      const p = path.join(d, f);
      try {
        const st = fs.statSync(p);
        if (st.isFile() && !artifacts.some((a) => a.name === f)) {
          artifacts.push({ name: f, bytes: st.size, sha256: sha256File(p), externalPath: p.replace(/\\/g, "/"), sub });
        }
      } catch {
        /* 这个子目录里没有 */
      }
    }
  }
  let meta = "";
  const mp = path.join(tool.dir, "work", "meta.json");
  if (fs.existsSync(mp)) meta = mp;
  let log = "";
  const ld = path.join(tool.dir, "logs");
  try {
    const files = fs.readdirSync(ld).filter((f) => /\.(log|txt)$/i.test(f)).map((f) => ({ f, m: fs.statSync(path.join(ld, f)).mtimeMs })).sort((a, b) => b.m - a.m);
    if (files.length) log = path.join(ld, files[0].f);
  } catch {
    /* 没有 logs 目录 */
  }
  return { bound: true, dir: tool.dir, artifacts, meta, log, error: artifacts.length ? "" : `外部目录里没找到 ${name} 的 .mud / axmodel / demo` };
}

/**
 * 登记一次打包：把最终产物 + meta + 最近日志复制到 `train_runs/deploy/<bundle>/`，
 * 计算 SHA，写 `deployment.json`。外部目录**只读**，一个字节都不写。
 */
async function deployRegister(req) {
  needWorkspace();
  if (!canWrite()) throw new Error("当前是只读模式：能看部署包，不能登记");
  const o = isObj(req) ? req : {};
  const { effective } = await effectiveConfig();
  const cfgName = String(o.cfgName || "");
  const cfg = cfgName ? readDeployConfig(cfgName) : { ok: false, modelName: "" };
  const modelName = String(o.modelName || (cfg.ok ? cfg.modelName : "") || "").replace(/[^\w.-]+/g, "-");
  if (!modelName) throw new Error("没有模型名：先在配方里设 $ModelName，或在面板里填一个");
  const modelPath = abs(String(o.model || (cfg.ok ? cfg.model : "") || ""));
  const calibDir = abs(String(o.calib || (cfg.ok ? cfg.calib : "") || ""));
  const scan = scanExternalArtifacts(modelName);
  if (!scan.artifacts.length) return { ok: false, error: scan.error, modelName };

  const stamp = new Date().toISOString().replace(/[-:TZ.]/g, "").slice(0, 14);
  const id = `dep-${modelName}-${stamp}`;
  const bundleDir = abs(`train_runs/deploy/${id}`);
  fs.mkdirSync(bundleDir, { recursive: true });
  const copied = [];
  for (const a of scan.artifacts) {
    const dest = path.join(bundleDir, a.name);
    fs.copyFileSync(a.externalPath, dest);
    copied.push({ name: a.name, bytes: a.bytes, sha256: a.sha256, from: a.externalPath });
  }
  let metaName = "";
  if (scan.meta) {
    metaName = "meta.json";
    fs.copyFileSync(scan.meta, path.join(bundleDir, metaName));
    copied.push({ name: metaName, bytes: fs.statSync(scan.meta).size, sha256: sha256File(scan.meta), from: scan.meta.replace(/\\/g, "/") });
  }
  let logName = "";
  if (scan.log) {
    logName = `convert-${path.basename(scan.log)}`;
    fs.copyFileSync(scan.log, path.join(bundleDir, logName));
    copied.push({ name: logName, bytes: fs.statSync(scan.log).size, sha256: sha256File(scan.log), from: scan.log.replace(/\\/g, "/") });
  }

  const runMatch = /\/runs\/([^/]+)\/weights\//i.exec(modelPath.replace(/\\/g, "/"));
  const catalog = await catalogBuild(true);
  const modelSha = modelPath && fs.existsSync(modelPath) ? sha256File(modelPath) : "";
  const modelEntry = modelSha ? catalog.models[modelSha] : null;
  const dataset = Object.values(catalog.datasets).find((d) => d.dir.toLowerCase() === abs(effective.dataset.output_dir || "").toLowerCase());
  const calibFingerprint = (() => {
    const d = String(calibDir || "").replace(/\\/g, "/");
    if (!d) return "";
    const ds = Object.values(catalog.datasets).find((x) => d.toLowerCase().startsWith(x.dir.toLowerCase()));
    return ds ? ds.fingerprint : "";
  })();
  const matched = !!(
    calibDir &&
    dataset &&
    calibDir.replace(/\\/g, "/").toLowerCase() === path.join(dataset.dir, "images", "train").replace(/\\/g, "/").toLowerCase()
  );

  const meta = {
    schemaVersion: 1,
    id,
    name: modelName,
    target: DEPLOY_TARGET.id,
    targetTitle: DEPLOY_TARGET.title,
    status: "packaged",
    createdAt: new Date().toISOString(),
    modelPath: modelPath.replace(/\\/g, "/"),
    modelId: modelEntry ? modelEntry.id : modelSha ? `mdl-${modelSha.slice(0, 8)}` : "",
    modelSha256: modelSha,
    runId: runMatch ? runMatch[1] : "",
    datasetId: dataset ? dataset.id : "",
    datasetFingerprint: dataset ? dataset.fingerprint : "",
    calibDir: calibDir.replace(/\\/g, "/"),
    calibFingerprint,
    calibMatched: matched,
    recipe: cfgName,
    artifacts: copied,
    externalDir: scan.dir,
    externalPaths: copied.map((c) => c.from),
    logs: logName ? [logName] : [],
    readOnlyExternal: true,
  };
  writeJsonAtomic(path.join(bundleDir, "deployment.json"), meta);
  catalogCache = { at: 0, value: null };
  externalCacheCache = { at: 0, value: null };
  auditLog({ action: "deploy-register", kind: "deployment", id, path: bundleDir, bytes: copied.reduce((n, c) => n + c.bytes, 0) });
  try {
    ctx.panels.emit(PANEL, "assets", { reason: "deploy-register", id });
  } catch {
    /* 面板没开 */
  }
  return { ok: true, bundle: { ...meta, dir: bundleDir.replace(/\\/g, "/"), bytes: copied.reduce((n, c) => n + c.bytes, 0) }, state: await catalogBuild(true) };
}

async function deployState() {
  const { effective } = await effectiveConfig();
  const tool = scanDeployTool();
  const configs = (tool.configs || []).map((c) => readDeployConfig(c));
  const best = latestBest(effective.train.project);
  const dd = abs("models/delivered");
  let delivered = [];
  try {
    delivered = fs
      .readdirSync(dd)
      .filter((f) => f.endsWith(".pt"))
      .map((f) => {
        const st = fs.statSync(path.join(dd, f));
        return { name: f, bytes: st.size, at: st.mtimeMs };
      })
      .sort((a, b) => b.at - a.at)
      .slice(0, 6);
  } catch {
    /* 还没交付过 */
  }
  return {
    tool,
    target: DEPLOY_TARGET,
    configs: configs.map((c) => ({ ...c, issues: c.ok ? deployConfigIssues(c, effective) : [] })),
    latest: best ? { path: best.path, run: best.run, at: best.at } : null,
    delivered,
    candidates: deployCandidates(effective.train.project),
    calib: calibCandidates(),
    deployments: listDeploymentBundles(),
    external: externalCacheStats(),
    jobs: [...jobs.values()].filter((j) => j.kind === "deploy").slice(-4).map(snapshot),
    active: active && active.kind === "deploy" ? snapshot(active) : null,
  };
}

/**
 * 起一次部署。
 *
 * **参数只有一个对象**：面板桥转发的就是 `(method, args)` 一个载荷，
 * 位置参数是拿不到的（这里以前写成三个位置参数，结果 `step` 永远是 `all`——
 * 「只检查环境」实际在跑全流程。判据见 `yoloPlugin.test.mjs` 的"调用形状"那条）。
 *
 * `step` 与工具自己的 `-Step` 一一对应：`validate`（只检查、不动文件）/ `all` /
 * `convert`（从已有 onnx 直接编译）/ `package`（只重新打包）。`deliver:false` 表示不交付、直接用配置里那枚模型。
 */
async function deployStart(req) {
  const o = isObj(req) ? req : { cfgName: req };
  const cfgName = String(o.cfgName == null ? "" : o.cfgName);
  const step = String(o.step || "all");
  // 与 deploy.ps1 的 [ValidateSet] 一一对应。这里先挡一道：传进来的值会原样变成 ps1 的参数，
  // 让 PowerShell 去报"参数绑定失败"远不如这里说清楚。
  const STEPS = ["all", "validate", "prepare", "convert", "package"];
  if (!STEPS.includes(step)) throw new Error(`不认识的部署步骤「${step}」（只有 ${STEPS.join(" / ")}）`);
  const opts = isObj(o.opts) ? o.opts : { deliver: o.deliver };
  needWorkspace();
  if (active) throw new Error(`已经有一个任务在跑（${active.label}）：先停掉它再开始新的`);
  const tool = scanDeployTool();
  if (!tool.bound) throw new Error("还没绑外部目录 deploy：去「插件」面板顶部绑一次");
  if (!tool.ready) throw new Error(`部署工具不完整：${tool.dir} 里缺 run.bat 或 deploy_config*.ps1`);
  const cfg = readDeployConfig(cfgName);
  if (!cfg.ok) throw new Error(cfg.error);

  const ps1 = path.join(tool.dir, "deploy.ps1");
  if (!fs.existsSync(ps1)) throw new Error(`部署工具里没有 deploy.ps1：${tool.dir}`);

  // 只有 convert 真正需要 Docker。引擎没起、且 WSL 也坏了时，deploy.ps1 会干等 180 秒
  // 再抛一句"Docker 不可用"——用户看到的就是一直转圈。这里提前给出人话。
  if (step === "all" || step === "convert") {
    const env = await dockerEnv();
    if (!env.ok && env.wsl === "broken") throw new Error(env.hint);
  }

  // 配置只读一次：交付看 project、校准看 dataset.output_dir —— 两者都跟着用户那份 config.yaml 走
  const { effective } = await effectiveConfig();

  // 部署哪一枚？**面板选了就用面板选的**（runs/ 里任意一版、交付区、模型库、或别处的路径都行）；
  // 没选才退回"最新一次训练的 best.pt 并留一份交付副本"。这件事必须显式，不能靠猜。
  const picked = String(o.model || "").replace(/\\/g, "/").trim();
  let modelPath = cfg.model;
  let delivered = null;
  if (picked) {
    const p = abs(picked);
    if (!fs.existsSync(p)) throw new Error(`找不到要部署的权重：${picked}`);
    if (!/\.pt$/i.test(p)) throw new Error(`只接受 .pt（导出 onnx 是部署工具自己那一步）：${picked}`);
    modelPath = p;
  } else if (opts && opts.deliver !== false) {
    const d = deliverBest(cfg.modelName || path.basename(cfg.name, ".ps1"), effective.train.project);
    if (!d.ok) throw new Error(d.error);
    modelPath = d.path;
    delivered = d;
  }
  // 校准图：面板选了就用面板的（可以指到任意数据集）；选「跟配置文件走」就不覆盖；
  // 没选则自动用**当前训练数据集**的 images/train —— 换数据后忘了改 $CalibSources 是最常见的一坑。
  const pickedCalib = String(o.calib || "").trim();
  let calibDir = "";
  if (pickedCalib === "@config") {
    calibDir = "";
  } else if (pickedCalib) {
    const p = abs(pickedCalib);
    if (!fs.existsSync(p)) throw new Error(`校准目录不存在：${pickedCalib}`);
    calibDir = p;
  } else {
    const auto = path.join(abs(effective.dataset.output_dir || ""), "images", "train").replace(/\\/g, "/");
    calibDir = fs.existsSync(auto) ? auto : "";
  }
  const wrapper = writeWrapper(cfg.name, modelPath, cfg.modelName || "model", calibDir);
  rememberPath("weights", modelPath, "deploy");
  rememberPath("calib", calibDir || cfg.calib, "deploy");

  const label = `部署 ${cfg.modelName || cfg.name}${step === "all" ? "" : `（${step}）`}`;
  const job = newJob("deploy", label);
  job.configPath = wrapper;
  jobs.set(job.id, job);
  active = job;

  pushLine(job, `[工作台] 工具: ${tool.dir}`, "sys");
  pushLine(job, `[工作台] 配置: ${cfg.name}（用户那份只读）`, "sys");
  if (delivered) pushLine(job, `[工作台] 交付: ${delivered.path}（来自 ${delivered.run}）`, "sys");
  pushLine(job, `[工作台] 模型: ${modelPath}`, "sys");
  pushLine(job, `[工作台] 包装配置: ${wrapper}`, "sys");
  if (calibDir) {
    pushLine(job, `[工作台] 校准图: ${calibDir}（覆盖配置里的 ${cfg.calib || "未设置"}）`, "sys");
    const want = path.join(abs(effective.dataset.output_dir || ""), "images", "train").replace(/\\/g, "/").toLowerCase();
    if (want && calibDir.replace(/\\/g, "/").toLowerCase() !== want) {
      pushLine(job, `[工作台] 注意：校准来源不是当前训练集的 images/train（${want}），INT8 量化可能偏`, "err");
    }
  } else if (cfg.calib) {
    pushLine(job, `[工作台] 校准图仍用配置里的 ${cfg.calib}（当前数据集没有 images/train，没法替你换）`, "sys");
  }
  pushLine(job, `[工作台] 目标：${DEPLOY_TARGET.title} · ${DEPLOY_TARGET.input.width}×${DEPLOY_TARGET.input.height} · opset ${DEPLOY_TARGET.input.opset} · ${DEPLOY_TARGET.runtime.dockerImage}`, "sys");
  job.deployMeta = { modelName: cfg.modelName || "", modelPath, calibDir, cfgName: cfg.name, step };
  job.progress.phase = step === "validate" ? "check" : "prepare";
  job.progress.detail = step === "validate" ? "只检查环境，不动任何文件" : "准备 ONNX";
  emitJob(job);

  try {
    // PowerShell 5.1 的 stdout 默认跟随系统代码页（这台是 GBK），而日志按 UTF-8 收——
    // 不先改编码，deploy.ps1 打的每一句中文都会变成乱码。
    const q = (s) => "'" + String(s).replace(/'/g, "''") + "'";
    const psCmd =
      "try { [Console]::OutputEncoding=[System.Text.Encoding]::UTF8 } catch {}; " +
      "& " + q(ps1) + " -Config " + q(wrapper) + " -Step " + q(step);
    const child = ctx.process.spawn({
      cmd: "powershell",
      args: ["-NoProfile", "-ExecutionPolicy", "Bypass", "-Command", psCmd],
      cwd: tool.dir,
      env: { ...PY_ENV, },
      onStdout: (l) => pushLine(job, l, "out"),
      onStderr: (l) => pushLine(job, l, "err"),
      onExit: (code) => {
        finishJob(job, code);
        // 打包成功后自动登记：把外部 deploy/ 与 out/ 里的最终产物复制进 train_runs/deploy/<bundle>/。
        // 外部目录仍然只读；登记失败不影响这次部署的结果，只多一行说明。
        if (code === 0 && !job.stopped && (step === "all" || step === "package")) {
          Promise.resolve()
            .then(() => deployRegister({ modelName: cfg.modelName || "", model: modelPath, calib: calibDir, cfgName: cfg.name }))
            .then((r) => {
              if (r && r.ok) pushLine(job, `[工作台] 部署包已登记：${r.bundle.dir}（${r.bundle.artifacts.length} 个产物）`, "sys");
              else pushLine(job, `[工作台] 这次没登记部署包：${(r && r.error) || scanExternalArtifacts(cfg.modelName || "").error}`, "err");
            })
            .catch((e) => pushLine(job, `[工作台] 登记部署包失败：${(e && e.message) || e}`, "err"));
        }
      },
      onError: (e) => {
        pushLine(job, `[工作台] 起进程失败：${(e && e.message) || e}`, "sys");
        finishJob(job, -1);
      },
    });
    job.pid = child.pid || 0;
    job.child = child;
  } catch (e) {
    pushLine(job, `[工作台] 起进程失败：${(e && e.message) || e}`, "sys");
    finishJob(job, -1);
    throw e;
  }
  return snapshot(job);
}

async function panelState() {
  if (!root) {
    // 没登记工作区时**不抛**：面板要能把"去上面选一个目录"显示出来
    return {
      workspace: "",
      needWorkspace: true,
      python: { path: "", ok: false, version: "", source: "", error: "" },
      config: { effective: DEFAULTS, overrides: {}, baseFound: false, baseError: "", baseSource: "" },
      dataset: { dir: "", dataYaml: "", exists: false, trainCount: 0, valCount: 0, classes: [], sourcesFrom: "none", resolvedSources: [] },
      deploy: scanDeployTool(),
      cage: null,
      runs: [],
      trainRuns: [],
      evals: 0,
      exports: 0,
      intake: { dir: "", exists: false, subdirs: [], loose: { images: 0, json: 0, other: 0 }, truncated: false },
      // 参数面：没探过就老实说没探过。探测要 6 秒，所以它不塞在刷新里，面板自己调 params()
      params: specNow(),
      models: [],
      task: null,
      batches: [],
      jobs: [],
      active: null,
    };
  }
  const cfg = await effectiveConfig();
  const py = await detectPython();
  const intake = scanIntake();
  const resolved = resolveDatasetSources(cfg.effective, intake);
  return {
    workspace: root,
    needWorkspace: false,
    python: { path: py.path, ok: py.ok, version: py.version, source: py.source, error: py.error },
    config: {
      effective: cfg.effective,
      overrides: cfg.overrides,
      baseFound: cfg.baseFound,
      baseError: cfg.baseError,
      baseSource: cfg.baseSource,
    },
    dataset: { ...scanDataset(cfg.effective.dataset.output_dir), sourcesFrom: resolved.from, resolvedSources: resolved.sources },
    deploy: scanDeployTool(),
    runs: scanRuns(cfg.effective.train.project).slice(0, 12),
    trainRuns: scanTrainRuns(),
    cage: probeCage(),
    // 「下一步」要能说出"评估/导出做过了没"——不另存状态，直接数盘上那两堆目录（读几个 json 而已）
    evals: scanEvals(5).length,
    exports: scanExports(5).length,
    intake,
    params: specNow(),
    models: scanModels(24).map((f) => ({ ...f, facts: factsFor(f) })),
    task: taskBlock(cfg.effective),
    batches: scanTrainBatches(cfg.effective.train.project, "", 6),
    jobs: [...jobs.values()].slice(-8).map(snapshot),
    active: snapshot(active),
  };
}

/**
 * 停掉当前在跑的任务。面板的 stop() 与宿主命令 `yolo.stop` 共用这一条——
 * 两个入口做的是同一件事，就不该各写一份 kill 逻辑（§8-36：一份东西两套口径迟早漂移）。
 */
async function stopActive() {
  const j = active;
  if (!j) return { ok: false, reason: "没有在跑的任务" };
  try {
    j.child && j.child.kill();
  } catch {
    /* 可能已经退出 */
  }
  // ctx.process.spawn 返回的句柄只给了 kill；拿不到就直接让宿主杀进程树
  if (j.pid) {
    try {
      process.kill(j.pid);
    } catch {
      /* 已经没了 */
    }
  }
  pushLine(j, "[工作台] 用户要求停止", "sys");
  j.stopped = true; // 终态要能分清"你停的"和"它崩的"
  return { ok: true, id: j.id };
}

/** 一行式现状，给宿主命令面板 / AI 用（不带面板那一大包 state）。 */
function statusBrief() {
  const j = active ? snapshot(active) : null;
  return {
    workspace: root || "",
    needWorkspace: !root,
    active: j ? { id: j.id, kind: j.kind, label: j.label, state: j.state, progress: j.progress } : null,
    runningCount: [...jobs.values()].filter((x) => x.state === "running").length,
  };
}

async function activate(c) {
  ctx = c;
  root = String(c.workspace || "");
  c.log.info(root ? `YOLO 工作台已就绪；工作区 = ${root}` : "YOLO 工作台已就绪；**还没有登记工作区根**");
  try {
    reconcileRunMeta();
  } catch {
    /* 只读/没工作区时跳过；不挡启动 */
  }

  c.panels.register(PANEL, {
    /** 面板挂载时调一次：环境、配置、数据集、训练记录、任务列表，一次拿全（少一轮往返）。 */
    async state() {
      return await panelState();
    },

    /** 保存面板上的改动。只存**与基准不同的那些**，这样用户改回默认时 diff 会自己消失。 */
    async saveConfig(patch) {
      return await applyPatch(patch);
    },

    /** 清掉面板覆盖，回到"工作区 config.yaml + 内置默认"。 */
    async resetConfig() {
      try {
        fs.unlinkSync(overridesPath());
      } catch {
        /* 本来就没有 */
      }
      baseCache = { mtime: 0, value: null, error: "", source: "" };
      return await panelState();
    },

    async startDataset(overrides) {
      return await startJob("dataset", overrides || {});
    },

    async startTrain(overrides) {
      return await startJob("train", overrides || {});
    },

    /* ---- 参数面与投料口（P175-W1）---- */

    /** 读当前那套 ultralytics 的参数表。同一套 python 只探一次；`true` = 强制重探。 */
    async params(refresh) {
      // 引导脚本会把"没参数"归一成 `{}`——那是真值，直接信它会每次挂载都重探一遍（6 秒）
      return await probeParams(refresh === true);
    },

    /** 开跑前摘要：让 runner `--dry-run` 解析一遍，看清"引擎到底会收到哪些参数、哪些被丢了"。 */
    async precheck(overrides) {
      return await precheck(overrides || {});
    },

    /** 建投料口目录。**只在用户点按钮时**执行：标注是他自己的事，插件不替他决定目录长什么样。 */
    async intakeEnsure() {
      needWorkspace();
      return ensureIntake();
    },

    /** 把投料口里的某个子目录登记成素材来源。名字必须来自盘上扫出来的那些（不拼用户给的路径）。 */
    async intakeUse(name) {
      needWorkspace();
      const hit = scanIntake().subdirs.find((s) => s.name === String(name == null ? "" : name));
      if (!hit) throw new Error(`投料口里没有这个子目录：${name}（先点「刷新」）`);
      const { effective } = await effectiveConfig();
      const srcs = (effective.dataset.sources || []).slice();
      if (!srcs.includes(hit.path)) srcs.push(hit.path);
      return await applyPatch({ dataset: { sources: srcs } });
    },

    /* ---- 模型代际与任务（P175-W2）---- */

    /** 模型库：读每枚 `.pt` 内嵌的 task / nc / 训练它的包版本。要 import torch（~10 秒），单独一颗按钮。 */
    async modelLibrary(refresh) {
      needWorkspace();
      return await modelLibrary(refresh === true);
    },

    /** 任务自动识别：**只出建议**。点了「按这个任务训」才落配置（红线 D）。 */
    async detectTask(dir) {
      needWorkspace();
      // 只认字符串：引导脚本会把"没参数"归一成 `{}`，`String({})` 会变成 `[object Object]` 并被当成路径
      const given = typeof dir === "string" ? dir.trim() : "";
      const d = given || (await effectiveConfig()).effective.dataset.output_dir;
      return detectTask(d);
    },

    /** 用户点名要哪个任务。只接受 detect / segment，别的（obb / pose / classify）不在范围内。 */
    async applyTask(task) {
      const t = String(task == null ? "" : task);
      if (!TASKS.includes(t)) throw new Error(`任务只支持 ${TASKS.join(" / ")}（收到：${task}）`);
      return await applyPatch({ train: { task: t } });
    },

    /** 只问不写：这次的任务与权重搭不搭、续训填得对不对。 */
    async checkTask() {
      needWorkspace();
      const { effective } = await effectiveConfig();
      return taskBlock(effective);
    },

    /** 监控页：曲线 + ETA + 显存 + 失败归类，一次拿全。`runName` 留空 = 在跑的或最近一个 run。 */
    async monitor(runName) {
      return await monitor(typeof runName === "string" ? runName : "");
    },

    async memInfo() {
      return await memInfo();
    },

    /* ---- 评估与对比（P175-W5）---- */

    /** 起一次评估（插件自带 runner；结果只落 `train_runs/eval/`，不碰 `runs/`）。 */
    async evalStart(opts) {
      return await evalStart(opts);
    },

    async evalState() {
      needWorkspace();
      return await evalState();
    },

    /** 读评估目录里引擎画的那几张图。一个对象参数 `{ dir, name }`：只认白名单文件名，且必须在 `train_runs/eval/` 下。 */
    async evalImage(req) {
      needWorkspace();
      const o = isObj(req) ? req : {};
      const base = abs("train_runs/eval").toLowerCase();
      const d = abs(typeof o.dir === "string" ? o.dir : "").replace(/\\/g, "/").toLowerCase();
      if (!d.startsWith(base)) throw new Error("只读评估结果目录里的图");
      const n = String(o.name == null ? "" : o.name);
      if (!EVAL_IMAGES.includes(n)) throw new Error(`只给引擎画的那几张图（${EVAL_IMAGES.join(" / ")}）`);
      let buf;
      try {
        buf = fs.readFileSync(path.join(abs(o.dir), "val", n));
      } catch {
        throw new Error(`读不到这张图：${n}`);
      }
      if (buf.length > 4 * 1024 * 1024) throw new Error(`图超过 4MB（${Math.round(buf.length / 1024)}KB），不往面板里塞`);
      return { ok: true, name: n, bytes: buf.length, dataUrl: "data:" + (n.endsWith(".png") ? "image/png" : "image/jpeg") + ";base64," + buf.toString("base64") };
    },

    /** 两个 run 的参数差异 + 曲线叠加（复盘"改了哪一项值不值"）。一个对象参数 `{ a, b }`。 */
    async compareRuns(req) {
      needWorkspace();
      const o = isObj(req) ? req : {};
      const { effective } = await effectiveConfig();
      const x = typeof o.a === "string" ? o.a : "";
      const y = typeof o.b === "string" ? o.b : "";
      if (!x || !y) throw new Error("要选两个 run 才能对比");
      return compareRuns(effective.train.project, x, y);
    },

    /* ---- 导出与端侧（P175-W6）---- */

    async exportStart(req) {
      return await exportStart(req);
    },

    async exportState() {
      needWorkspace();
      return await exportState();
    },

    /** 导出前的约束核对（纯查、不写）：`{ format, task, dynamic, opset, nms }`。 */
    async exportCheck(req) {
      const o = isObj(req) ? req : {};
      return { ok: true, advice: exportAdvice(String(o.format || "onnx"), String(o.task || ""), o) };
    },

    /* ---- 实验管理（P175-W7）---- */

    /** 实验列表：每个 run 的 task / 模型 / 轮次 / 指标 / 是否已交付 / 备注。 */
    async experiments() {
      needWorkspace();
      const { effective } = await effectiveConfig();
      const delivered = (() => {
        try {
          return fs.readdirSync(abs("models/delivered")).map((f) => f.toLowerCase());
        } catch {
          return [];
        }
      })();
      const runs = runProfiles(effective.train.project, 40).map((r) => ({
        ...r,
        delivered: delivered.some((f) => f.includes(String(r.name).toLowerCase())),
      }));
      return { ok: true, project: abs(effective.train.project || DEFAULTS.train.project), runs, delivered };
    },

    /** 「等价命令」：只生成并返回，不写盘（写盘是 `saveReproBat` 那一步）。 */
    async repro(req) {
      needWorkspace();
      const o = isObj(req) ? req : {};
      const { effective } = await effectiveConfig();
      const run = runProfile(effective.train.project, String(o.run || ""));
      if (!run.name || !fs.existsSync(run.dir)) throw new Error(`没有这个 run：${o.run}`);
      const r = reproCommands(run);
      return { ok: true, run: run.name, commands: r.commands, snapshot: r.snapshot, text: r.text };
    },

    /** 把某一条等价命令存成 .bat（落 `train_runs/bat/`，不碰 `00~07`）。 */
    async saveReproBat(req) {
      needWorkspace();
      const o = isObj(req) ? req : {};
      const { effective } = await effectiveConfig();
      const run = runProfile(effective.train.project, String(o.run || ""));
      if (!run.name || !fs.existsSync(run.dir)) throw new Error(`没有这个 run：${o.run}`);
      return writeReproBat(run, String(o.which || "runner"));
    },

    /** 备注：写 `train_runs/<实验>.note`，不碰 `runs/`。 */
    async saveNote(req) {
      needWorkspace();
      const o = isObj(req) ? req : {};
      const { effective } = await effectiveConfig();
      return saveRunNote(effective.train.project, String(o.run || ""), String(o.text || ""));
    },

    /** 归档：复制 args/results/best 到 `train_runs/archive/<run>-<时间>/`。**只复制，不搬走**。 */
    async archiveRun(req) {
      needWorkspace();
      const o = isObj(req) ? req : {};
      const { effective } = await effectiveConfig();
      return archiveRun(effective.train.project, String(o.run || ""));
    },

    /** P177-E：续训计划（默认从 last.pt 开新 run；原生 resume 只是高级选项）。 */
    async resumePlan(req) {
      return await resumePlan(req);
    },

    /** P177-E：磁盘守卫（按同类 run 实测体积 × 1.5 预估）。 */
    async diskGuard() {
      needWorkspace();
      return await diskGuard();
    },

    /* ---- 标注体检与增强预览（P175-W3）---- */

    /** 体检：**只读**。不写、不改、不删任何标签文件。 */
    async audit(dir) {
      needWorkspace();
      const given = typeof dir === "string" ? dir.trim() : "";
      const d = given || (await effectiveConfig()).effective.dataset.output_dir;
      return auditDataset(d);
    },

    /**
     * 把上一次训练真实产出的 `train_batch*.jpg` 取回来当增强预览。
     *
     * 面板画不出"假预览"：那需要自己实现一遍 mosaic / copy_paste，而实现歪了的预览
     * 比没有预览更糟（用户会以为训练就是那样）。所以这里只给**引擎自己写出来的那张**。
     * 路径必须落在 `project` 下面且文件名就是 `train_batchN.jpg`——不接受用户给的任意路径。
     */
    async previewImage(file) {
      needWorkspace();
      const { effective } = await effectiveConfig();
      const base = abs(effective.train.project || DEFAULTS.train.project).toLowerCase();
      const p = String(typeof file === "string" ? file : "").replace(/\\/g, "/");
      const full = abs(p).replace(/\\/g, "/");
      if (!full.toLowerCase().startsWith(base.toLowerCase())) throw new Error("预览只允许读训练产物目录里的图");
      if (!/^train_batch\d*\.jpg$/i.test(path.basename(full))) throw new Error("预览只给 train_batchN.jpg（引擎产出的增强样本）");
      let buf;
      try {
        buf = fs.readFileSync(full);
      } catch {
        throw new Error(`读不到这张预览图：${p}`);
      }
      if (buf.length > 2 * 1024 * 1024) throw new Error(`预览图超过 2MB（${Math.round(buf.length / 1024)}KB），不往面板里塞`);
      return { ok: true, file: full, bytes: buf.length, dataUrl: "data:image/jpeg;base64," + buf.toString("base64") };
    },

    /* ---- 部署（$EXT:deploy）---- */
    /** 训练/评估/导出/部署共用的候选清单（权重、数据集、设备、校准图）。 */
    async picks() {
      needWorkspace();
      return await pickLists();
    },

    /** P177-A：资产索引（数据集 / run / 模型 / 部署包 / 回收站 / 存储）。只读骨架先上。 */
    async assetsState(force) {
      needWorkspace();
      return await catalogBuild(force === true);
    },

    /**
     * P177-B：清理与回收站。`action` = suggest / preview / trash / restore / purge / purgeAll / audit。
     * 所有删除都先进 `.uartix/yolo/trash`；永久删除只发生在 purge，且要二次确认文本。
     */
    async assetsCleanup(req) {
      needWorkspace();
      const o = isObj(req) ? req : {};
      const action = String(o.action || "suggest");
      if (action === "suggest") {
        const c = await catalogBuild(false);
        return { ok: true, suggestions: c.suggestions || [], audit: c.audit || [] };
      }
      if (action === "audit") return { ok: true, entries: readAudit(o.limit || 60) };
      if (action === "retention") {
        if (!canWrite()) throw new Error("当前是只读模式：能看保留策略，不能改");
        const days = Math.max(0, Number(o.days) || 0);
        const prefs = readPrefs();
        prefs.trashKeepDays = days;
        savePrefs(prefs);
        catalogCache = { at: 0, value: null };
        return { ok: true, keepDays: days, state: await catalogBuild(true) };
      }
      if (!canWrite()) throw new Error("当前是只读模式：能看资产，不能清理 / 恢复 / 永久删除");
      if (action === "purgeOld") {
        const r = purgeOldTrash(Number(o.days) || readPrefs().trashKeepDays, o.confirm);
        catalogCache = { at: 0, value: null };
        return { ...r, state: await catalogBuild(true) };
      }
      if (action === "preview") {
        const c = await catalogBuild(false);
        const plan = cleanupPlan(c, o.items, o.cascade);
        return { ok: true, ...plan };
      }
      if (action === "trash") {
        if (String(o.confirm || "") !== "清理") throw new Error("回收要二次确认：确认文本必须是「清理」");
        const c = await catalogBuild(false);
        const plan = cleanupPlan(c, o.items, o.cascade);
        if (!plan.ok) return { ok: false, error: "有引用阻止，先处理下面这些条目", ...plan };
        const moved = [];
        for (const a of plan.actions) {
          moved.push(
            moveToTrash(a.path, {
              kind: a.kind,
              id: a.id,
              name: path.basename(a.path),
              refs: a.refs,
              reason: a.reason,
              cascade: a.cascade,
            }),
          );
        }
        catalogCache = { at: 0, value: null };
        externalCacheCache = { at: 0, value: null };
        return { ok: true, moved, plan, state: await catalogBuild(true) };
      }
      if (action === "restore") {
        const r = restoreTrash(o.id);
        catalogCache = { at: 0, value: null };
        return { ...r, state: await catalogBuild(true) };
      }
      if (action === "purge") {
        if (String(o.confirm || "") !== "删除") throw new Error("永久删除要二次确认：确认文本必须是「删除」");
        const r = purgeTrash(o.id);
        catalogCache = { at: 0, value: null };
        return { ...r, state: await catalogBuild(true) };
      }
      if (action === "purgeAll") {
        const r = purgeAllTrash(o.confirm);
        catalogCache = { at: 0, value: null };
        return { ...r, state: await catalogBuild(true) };
      }
      throw new Error(`不认识的资产动作：${action}`);
    },

    /** P177-C：官方权重清单 / 已下载状态 / 当前下载任务。 */
    async modelDownloadState() {
      needWorkspace();
      return await modelDownloadState();
    },

    /** P177-C：下载一枚官方权重（只在白名单内，不自动设为训练权重）。 */
    async modelDownload(req) {
      return await modelDownload(req);
    },

    /* ---- P178：环境自举 ---- */

    /** 环境全景：显卡/驱动/推荐画像/已有环境/当前解释器/磁盘。 */
    async envState() {
      needWorkspace();
      return await envState();
    },

    /** 装一份私有环境（必须用户点按钮）。`{ variant?: "cu126"|"cu130"|"cpu" }` */
    async envInstall(req) {
      return await envInstall(req);
    },

    /** 切换默认环境；id 传空串表示"不用插件环境"。 */
    async envSetDefault(req) {
      return await envSetDefault(req);
    },

    /** 删除一份环境（进回收站，可恢复）。 */
    async envRemove(req) {
      return await envRemove(req);
    },

    async deployState() {
      return await deployState();
    },

    /** 一个对象参数：`{ cfgName, step, deliver }`（桥只转发一个载荷，位置参数拿不到）。 */
    async deployStart(req) {
      return await deployStart(req);
    },

    /** P177-D：开跑前校验（模型 / 校准 / 尺寸 / opset / Docker），只读不启动。 */
    async deployPrecheck(req) {
      return await deployPrecheck(req);
    },

    /** P177-D：把外部 deploy/out 里的最终产物登记成 train_runs/deploy/<bundle>/（外部只读）。 */
    async deployRegister(req) {
      return await deployRegister(req);
    },

    /** 部署前问一句：Docker 引擎（以及它脚下的 WSL）到底能不能用。 */
    async deployEnv() {
      return await dockerEnv();
    },

    /** 只交付模型、不部署（"先把产物留一份"也是常见动作）。 */
    async deployDeliver(modelName) {
      const { effective } = await effectiveConfig();
      const r = deliverBest(modelName, effective.train.project);
      if (!r.ok) throw new Error(r.error);
      return { ...r, state: await deployState() };
    },

    async stop() {
      return await stopActive();
    },

    /** 面板重新挂载后补日志用（内存里保留最近 LOG_KEEP 行）。 */
    async jobLog(id) {
      const j = jobs.get(String(id));
      if (!j) return { lines: [], total: 0 };
      return { lines: j.lines.slice(-1200), total: j.lines.length };
    },

    /** 深度自检：torch / CUDA / ultralytics 版本。要 import torch，慢（10~20s），单独一个按钮。 */
    async probe() {
      const py = await detectPython();
      if (!py.ok) return { ok: false, error: `没有可用的 python：${py.error}` };
      const code =
        "import json,sys\n" +
        "o={'python':sys.version.split()[0]}\n" +
        "try:\n" +
        " import torch;o['torch']=torch.__version__;o['cuda']=bool(torch.cuda.is_available());o['gpu']=torch.cuda.get_device_name(0) if o['cuda'] else ''\n" +
        "except Exception as e:o['torch_error']=str(e)[:200]\n" +
        "try:\n" +
        " import ultralytics;o['ultralytics']=ultralytics.__version__\n" +
        "except Exception as e:o['ultralytics_error']=str(e)[:200]\n" +
        "print(json.dumps(o,ensure_ascii=True))\n";
      const r = await runOnce(py.path, ["-c", code], 60000);
      if (r.code !== 0) return { ok: false, error: (r.err || r.out || "自检失败").slice(0, 400) };
      try {
        return { ok: true, ...JSON.parse(r.out.trim().split(/\r?\n/).pop()) };
      } catch (e) {
        return { ok: false, error: `自检输出解析失败：${(e && e.message) || e}` };
      }
    },
  });

  // 宿主命令面板 / AI 的入口：与面板按钮走同一批函数，不另立第二套实现。
  c.commands.register("yolo.status", async () => statusBrief());
  c.commands.register("yolo.stop", async () => await stopActive());

  c.onDispose(() => {
    c.log.info("YOLO 工作台正在退出：结束所有子进程");
  });
}

/* ============================ 标注体检（P175-W3，详设 §5.2） ============================ */

/**
 * **这一整块只读**：一个标签文件都不写、不改、不删。
 * 体检的价值在于"开训前告诉你这份数据会怎么毁掉你的指标"，而不是替你修——
 * 修标注是用户在标注工具里的事（他自己在 X-AnyLabeling 里做）。
 */

/** 解析一份 YOLO 标签文件的全部行。 */
function parseLabelFile(p) {
  const out = { boxes: 0, polys: 0, quads: 0, bad: 0, outOfBounds: 0, classes: {}, ids: [] };
  let text = "";
  try {
    text = fs.readFileSync(p, "utf8");
  } catch {
    return null;
  }
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line) continue;
    const parts = line.split(/\s+/);
    const id = Number(parts[0]);
    if (!Number.isInteger(id) || id < 0) {
      out.bad++;
      continue;
    }
    out.ids.push(id);
    out.classes[id] = (out.classes[id] || 0) + 1;
    const coords = parts.slice(1).map(Number);
    if (coords.some((c) => !Number.isFinite(c))) {
      out.bad++;
      continue;
    }
    if (coords.some((c) => c < -0.001 || c > 1.001)) out.outOfBounds++;
    if (coords.length === 4) out.boxes++;
    else if (coords.length === 8) out.quads++;
    else if (coords.length >= 6 && coords.length % 2 === 0) out.polys++;
    else out.bad++;
  }
  return out;
}

function listSiblings(dir, ext) {
  try {
    return fs
      .readdirSync(dir)
      .filter((f) => f.toLowerCase().endsWith(ext))
      .map((f) => f.replace(/\.[^.]+$/, ""));
  } catch {
    return null; // 目录不存在 ≠ 空目录：调用方要能分清"没有"和"读不到"
  }
}

/** 读 `data.yaml` 的 nc / names / train / val（形状不对就报出来，不猜）。 */
function readDataYaml(file) {
  const out = { exists: false, nc: null, names: [], train: "", val: "", error: "" };
  let text = "";
  try {
    text = fs.readFileSync(file, "utf8");
  } catch {
    return out;
  }
  out.exists = true;
  try {
    const v = parseSimpleYaml(text);
    out.nc = v.nc === undefined ? null : Number(v.nc);
    out.train = String(v.train || "");
    out.val = String(v.val || "");
    const n = v.names;
    if (Array.isArray(n)) out.names = n.map(String);
    else if (isObj(n)) out.names = Object.keys(n).sort((a, b) => Number(a) - Number(b)).map((k) => String(n[k]));
  } catch (e) {
    out.error = String((e && e.message) || e);
  }
  return out;
}

/**
 * 体检主体。`sample` 控制"逐行读标签"的上限（默认 400 个文件）：
 * 一个上万张的数据集全读要几十秒，而体检的价值在前 400 个就能看出来。
 * 超了就报 `truncated`，宁可少报也不把面板卡住。
 */
/**
 * 完全相同的图（同一份文件被复制到 train/val 或两个数据集）：按大小分组，
 * 只对"同尺寸 ≥2"的候选算 SHA256 —— 44G 数据集也不至于被读一遍。
 */
function findDuplicateImages(dirs, cap) {
  const files = [];
  const walk = (d, depth) => {
    if (depth > 2 || files.length >= (cap || 3000)) return;
    let ents = [];
    try {
      ents = fs.readdirSync(d, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of ents) {
      if (files.length >= (cap || 3000)) return;
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p, depth + 1);
      else if (IMAGE_RE.test(e.name)) {
        try {
          const st = fs.statSync(p);
          files.push({ p, size: st.size });
        } catch {
          /* 读不到就跳过 */
        }
      }
    }
  };
  for (const d of dirs) walk(d, 0);
  const bySize = new Map();
  for (const f of files) {
    if (!bySize.has(f.size)) bySize.set(f.size, []);
    bySize.get(f.size).push(f.p);
  }
  const groups = [];
  let hashed = 0;
  for (const [size, list] of bySize) {
    if (list.length < 2 || size < 1024) continue;
    const bySha = new Map();
    for (const p of list.slice(0, 40)) {
      if (hashed >= 400) break;
      const sha = sha256File(p);
      hashed += 1;
      if (!sha) continue;
      if (!bySha.has(sha)) bySha.set(sha, []);
      bySha.get(sha).push(p);
    }
    for (const [, paths] of bySha) {
      if (paths.length > 1) groups.push({ size, count: paths.length, paths: paths.map((x) => x.replace(/\\/g, "/")).slice(0, 6), bytes: size * (paths.length - 1) });
    }
    if (groups.length >= 20) break;
  }
  return { scanned: files.length, hashed, groups: groups.slice(0, 20), reclaimBytes: groups.reduce((n, g) => n + g.bytes, 0) };
}

function auditDataset(dirIn, sample) {
  const dir = abs(dirIn || DEFAULTS.dataset.output_dir);
  const r = {
    dir,
    ok: true,
    truncated: false,
    sampled: 0,
    dataYaml: readDataYaml(path.join(dir, "data.yaml")),
    splits: {},
    zeroLabelImages: 0,
    emptyLabelFiles: 0,
    outOfBounds: 0,
    badLines: 0,
    boxes: 0,
    polys: 0,
    quads: 0,
    classHist: {},
    maxClassId: -1,
    missingClasses: [],
    leakNames: [],
    findings: [],
  };
  const limit = sample || 400;
  // `listSiblings` 在目录不存在时返回 null（"没有"≠"读不到"）；这里只取名单，统一当空处理，
  // 否则 `null.concat(...)` 会把整次体检查成"体检失败"——数据集还没构建时用户最常撞上。
  const list = (d, ext) => listSiblings(d, ext) || [];
  for (const split of ["train", "val"]) {
    const imgDir = path.join(dir, "images", split);
    const lblDir = path.join(dir, "labels", split);
    const imgs = list(imgDir, ".jpg").concat(list(imgDir, ".png"), list(imgDir, ".jpeg"));
    const stems = new Set(imgs);
    const labels = listSiblings(lblDir, ".txt");
    r.splits[split] = { images: imgs.length, labels: labels === null ? 0 : labels.length, dirMissing: stems.size === 0 && labels === null };
    if (labels === null) continue;
    const take = labels.slice(0, Math.max(0, limit - r.sampled));
    if (labels.length > take.length) r.truncated = true;
    for (const stem of take) {
      r.sampled++;
      const one = parseLabelFile(path.join(lblDir, stem + ".txt"));
      if (!one) continue;
      if (!one.ids.length) r.emptyLabelFiles++;
      if (!stems.has(stem)) r.zeroLabelImages++; // 有标签没图：引擎会在扫描阶段直接跳过它
      r.outOfBounds += one.outOfBounds;
      r.badLines += one.bad;
      r.boxes += one.boxes;
      r.polys += one.polys;
      r.quads += one.quads;
      for (const [k, n] of Object.entries(one.classes)) {
        r.classHist[k] = (r.classHist[k] || 0) + n;
        r.maxClassId = Math.max(r.maxClassId, Number(k));
      }
    }
    if (split === "train") r.trainStems = imgs;
    else r.valStems = imgs;
  }
  // train ↔ val 重名 = 数据泄漏：验证集里出现训练过的图，指标会好看但模型没学到东西
  if (r.trainStems && r.valStems) {
    const v = new Set(r.valStems);
    r.leakNames = r.trainStems.filter((s) => v.has(s)).slice(0, 20);
  }
  const names = r.dataYaml.names || [];
  if (names.length) r.missingClasses = names.map((n, i) => (r.classHist[i] ? null : n)).filter(Boolean);
  delete r.trainStems;
  delete r.valStems;

  // P177 §6.3 新增两项：完全重复的图 + 投料口来源账（都只读）
  try {
    r.duplicates = findDuplicateImages([path.join(dir, "images", "train"), path.join(dir, "images", "val")], 3000);
  } catch {
    r.duplicates = { scanned: 0, hashed: 0, groups: [], reclaimBytes: 0 };
  }
  try {
    const it = scanIntake();
    r.intake = { dir: it.dir, exists: it.exists, subdirs: (it.subdirs || []).map((x) => ({ name: x.name, images: x.images, json: x.json })), loose: it.loose };
  } catch {
    r.intake = null;
  }

  if (r.duplicates && r.duplicates.groups.length) {
    r.findings.push({
      level: "warn",
      key: "duplicateImages",
      text: `发现 ${r.duplicates.groups.length} 组完全相同的图（最多算 ${r.duplicates.hashed} 张的 SHA256），多用约 ${fmtBytes(r.duplicates.reclaimBytes)}；重复图会让 val 指标偏乐观，去资产页处理前先确认。`,
    });
  }
  if (r.dataYaml.exists && r.dataYaml.nc != null && r.maxClassId >= r.dataYaml.nc) {
    r.findings.push({ level: "bad", key: "ncMismatch", text: `标签里出现了类别 id ${r.maxClassId}，而 data.yaml 的 nc 只有 ${r.dataYaml.nc}：引擎会直接拒或错位训练。` });
  }
  // 目录压根不存在时别报"干净"：那是"还没构建"，不是"体检通过"
  if (r.splits.train.dirMissing && r.splits.val.dirMissing) {
    r.findings.push({ level: "bad", key: "noDataset", text: "数据集目录不存在（" + String(dir).split("\\").join("/") + "）：先在「数据」页点构建数据集，再回来体检。" });
  }
  if (r.outOfBounds) r.findings.push({ level: "bad", key: "outOfBounds", text: `${r.outOfBounds} 行坐标越界（<0 或 >1）：这些框会被裁掉或让 loss 变 NaN。` });
  if (r.badLines) r.findings.push({ level: "warn", key: "badLines", text: `${r.badLines} 行不是合法标注（token 数对不上）：会被静默忽略。` });
  if (r.emptyLabelFiles) r.findings.push({ level: "warn", key: "emptyLabels", text: `${r.emptyLabelFiles} 个标签文件是空的（背景图）。少量是对的，多了说明标注漏了。` });
  if (r.zeroLabelImages) r.findings.push({ level: "warn", key: "orphanLabels", text: `${r.zeroLabelImages} 个标签找不到同名图片：这些标注不会进训练。` });
  if (r.leakNames.length) r.findings.push({ level: "bad", key: "leak", text: `train 与 val 有 ${r.leakNames.length}${r.leakNames.length >= 20 ? "+" : ""} 个同名文件（数据泄漏）：指标会虚高，先去重再训。` });
  if (r.missingClasses.length) r.findings.push({ level: "warn", key: "missingClasses", text: `这些类别在抽到的样本里一次都没出现：${r.missingClasses.join("、")}。要么样本太少，要么标注时漏标。` });
  const hist = Object.values(r.classHist);
  if (hist.length > 1 && Math.max(...hist) / Math.max(1, Math.min(...hist)) > 10) {
    r.findings.push({ level: "warn", key: "imbalance", text: `类别数量差 ${Math.round(Math.max(...hist) / Math.min(...hist))} 倍：少数类的 mAP 会被拖低，考虑补标或按类加权。` });
  }
  if (r.quads) r.findings.push({ level: "info", key: "quads", text: `抽到 ${r.quads} 个 4 点多边形（1+8 个 token）——它和 OBB 的形状一样，本工作台只做 detect / segment。` });
  if (!r.findings.length) r.findings.push({ level: "ok", key: "clean", text: `抽了 ${r.sampled} 个标签文件，没发现常见问题。` });
  return r;
}

/** 上一次训练真实喂给网络的样本图（引擎产出的 `train_batch*.jpg`）——不是面板画出来的假预览。 */
function scanTrainBatches(project, runName, limit) {
  if (!root) return [];
  const base = abs(project || DEFAULTS.train.project);
  const out = [];
  let dirs = [];
  try {
    dirs = (runName ? [runName] : fs.readdirSync(base)).filter((n) => !n.startsWith("."));
  } catch {
    return [];
  }
  for (const d of dirs) {
    let files = [];
    try {
      files = fs.readdirSync(path.join(base, d)).filter((f) => /^train_batch\d*\.jpg$/i.test(f));
    } catch {
      continue;
    }
    for (const f of files.slice(0, limit || 3)) {
      const p = path.join(base, d, f);
      let st;
      try {
        st = fs.statSync(p);
      } catch {
        continue;
      }
      out.push({ run: d, name: f, file: p.replace(/\\/g, "/"), bytes: st.size, mtime: st.mtimeMs });
    }
  }
  out.sort((a, b) => b.mtime - a.mtime);
  return out.slice(0, limit || 6);
}

/* ============================ 评估与对比（P175-W5，详设 §5.5） ============================ */

/** 面板允许读回来的那几张图——都是引擎自己画的，面板不画第二份。 */
const EVAL_IMAGES = ["confusion_matrix.png", "BoxPR_curve.png", "F1_curve.png", "P_curve.png", "R_curve.png", "val_batch0_pred.jpg", "val_batch0_labels.jpg"];

/** 评估结果目录：`train_runs/eval/<时间戳>`——不塞进 `runs/`，那是用户手动跑出来的产物区。 */
function evalOutDir(at) {
  const d = new Date(at || Date.now());
  const p = (n) => String(n).padStart(2, "0");
  return abs(`train_runs/eval/${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`);
}

/** 读一次评估的结果（`eval.json` 是 runner 写的，指标 / 阈值表 / 图 / 错例都在里面）。 */
function readEvalResult(dir) {
  const file = path.join(String(dir), "eval.json");
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return null;
  }
}

/** 评估历史：`train_runs/eval/*` 倒序。只认有 eval.json 的目录——跑一半被杀的不算一次结果。 */
function scanEvals(limit) {
  if (!root) return [];
  const base = abs("train_runs/eval");
  let names = [];
  try {
    names = fs.readdirSync(base);
  } catch {
    return [];
  }
  const out = [];
  for (const n of names) {
    const dir = path.join(base, n).replace(/\\/g, "/");
    const one = readEvalResult(dir);
    if (!one) continue;
    out.push({ dir, name: n, at: one.at || 0, weights: one.weights, task: one.task, metrics: one.metrics });
  }
  out.sort((a, b) => String(b.name).localeCompare(String(a.name)));
  return out.slice(0, limit || 10);
}

/**
 * 两份 `args.yaml` 的差异（复盘用）。
 *
 * `args.yaml` 是引擎自己写的"这次训练真实用了什么"——它比面板的记忆可信。
 * 只比**两边都是标量**的键：嵌套结构（names / 各种列表）在这里既难比又不是差异的来源。
 */
function diffArgs(a, b) {
  const out = [];
  const keys = new Set([...Object.keys(a || {}), ...Object.keys(b || {})]);
  for (const k of keys) {
    const va = a ? a[k] : undefined;
    const vb = b ? b[k] : undefined;
    if (va === vb) continue;
    if (typeof va === "object" || typeof vb === "object") continue;
    if (va === undefined || vb === undefined) continue; // 一边没有多半是解析差异，不是真差异
    out.push({ key: k, a: va, b: vb });
  }
  return out.sort((x, y) => String(x.key).localeCompare(String(y.key)));
}

/** 读一个 run 的 `args.yaml`（引擎写的）。 */
function readRunArgs(runDir) {
  try {
    return parseSimpleYaml(fs.readFileSync(path.join(String(runDir), "args.yaml"), "utf8"));
  } catch {
    return {};
  }
}

/** 两条曲线叠加对比：把两个 run 的 results.csv 各自抽稀后一起交给面板。 */
function compareRuns(project, a, b) {
  const base = abs(project || DEFAULTS.train.project);
  const one = (name) => {
    const dir = path.join(base, name);
    let parsed = { columns: [], rows: [] };
    try {
      parsed = parseResultsCsv(fs.readFileSync(path.join(dir, "results.csv"), "utf8"));
    } catch {
      /* 这个 run 没写出 csv */
    }
    return { name, dir: dir.replace(/\\/g, "/"), columns: parsed.columns, chart: chartColumns(parsed.columns), rows: downsample(parsed.rows, 400), args: readRunArgs(dir) };
  };
  const A = one(a);
  const B = one(b);
  const metricOf = (r) => {
    const last = r.rows.length ? r.rows[r.rows.length - 1] : {};
    return {
      mAP50B: last["metrics/mAP50(B)"],
      mAP5095B: last["metrics/mAP50-95(B)"],
      mAP50M: last["metrics/mAP50(M)"],
      mAP5095M: last["metrics/mAP50-95(M)"],
      epochs: r.rows.length,
    };
  };
  return { ok: true, a: A, b: B, diff: diffArgs(A.args, B.args), summary: { a: metricOf(A), b: metricOf(B) } };
}

/**
 * 起一次评估。走插件自带的 `runner/eval_job.py`，**不动用户的 `scripts/validate_viz.py`**；
 * 结果一律落在 `train_runs/eval/`，`runs/` 里一个文件都不新增。
 */
async function evalStart(opts) {
  needWorkspace();
  if (active) throw new Error(`已经有一个任务在跑（${active.label}）：先停掉它`);
  const o = isObj(opts) ? opts : {};
  const { effective } = await effectiveConfig();
  const py = await detectPython();
  if (!py.ok) throw new Error(`找不到可用的 python：${py.error}`);
  const runner = path.join(PKG_DIR, "runner", "eval_job.py").replace(/\\/g, "/");
  if (!fs.existsSync(runner)) throw new Error(`插件包里没有 runner/eval_job.py：重装一次插件`);

  const weights = abs(String(o.weights || effective.eval?.model || effective.train.weights || ""));
  const data = abs(String(o.data || effective.eval?.data || "")) || path.join(abs(effective.dataset.output_dir), "data.yaml").replace(/\\/g, "/");
  const out = evalOutDir();
  rememberPath("weights", weights, "eval");
  rememberPath("data", data, "eval");
  const merged = merge({}, effective);
  merged.eval = {
    model: weights,
    data,
    imgsz: Number(o.imgsz || (effective.eval && effective.eval.imgsz) || effective.train.imgsz || 640),
    conf: Number(o.conf != null ? o.conf : (effective.eval && effective.eval.conf) || 0.25),
    device: String(o.device != null ? o.device : (effective.eval && effective.eval.device) || effective.train.device || "0"),
    workers: Number(o.workers != null ? o.workers : (effective.eval && effective.eval.workers) ?? effective.train.workers ?? 0),
  };

  const job = newJob("eval", `评估 ${path.basename(weights)}`);
  const confPath = abs(`train_runs/eval-${new Date(job.startedAt).toISOString().replace(/[:.]/g, "-").slice(0, 19)}.yaml`);
  fs.mkdirSync(path.dirname(confPath), { recursive: true });
  fs.writeFileSync(confPath, dumpConfig(merged), "utf8");
  job.configPath = confPath;
  job.evalOut = out;
  jobs.set(job.id, job);
  active = job;

  const args = [runner, "--config", confPath, "--weights", weights, "--data", data, "--out", out, "--conf", String(merged.eval.conf)];
  if (o.errors) args.push("--errors", "--max-errors", String(Math.max(1, Math.min(200, Number(o.maxErrors) || 40))));
  pushLine(job, `[工作台] python: ${py.path}（${py.source}）`, "sys");
  pushLine(job, `[工作台] 结果目录: ${out}`, "sys");
  pushLine(job, `[工作台] 命令: "${py.path}" "${runner}" ${args.slice(1).map((a) => `"${a}"`).join(" ")}`, "sys");

  try {
    const child = ctx.process.spawn({
      cmd: py.path,
      args,
      cwd: root,
      env: { ...PY_ENV, OPENBLAS_NUM_THREADS: "1", KMP_DUPLICATE_LIB_OK: "TRUE", CUDA_MODULE_LOADING: "LAZY" },
      onStdout: (l) => pushLine(job, l, "out"),
      onStderr: (l) => pushLine(job, l, "err"),
      onExit: (code) => finishJob(job, code),
      onError: (e) => {
        pushLine(job, `[工作台] 起进程失败：${(e && e.message) || e}`, "sys");
        finishJob(job, -1);
      },
    });
    job.pid = child.pid || 0;
    job.child = child;
  } catch (e) {
    pushLine(job, `[工作台] 起进程失败：${(e && e.message) || e}`, "sys");
    finishJob(job, -1);
    throw e;
  }
  return snapshot(job);
}

/** 评估页一次拿全：最近一次结果 + 历史 + 可选权重 + 可选数据集。 */
async function evalState() {
  const list = scanEvals(10);
  const last = list.length ? readEvalResult(list[0].dir) : null;
  const { effective } = await effectiveConfig();
  return {
    ok: true,
    last,
    history: list,
    weights: scanModels(40).map((f) => ({ file: f.file, name: f.name, task: factsFor(f)?.task || "", bytes: f.bytes })),
    bests: scanRuns(effective.train.project).filter((r) => r.hasBest).map((r) => ({ run: r.name, file: r.best, mAP50: r.metrics ? r.metrics.mAP50M : "" })),
    candidates: deployCandidates(effective.train.project),
    datasets: scanDatasetDirs(),
    current: { data: path.join(abs(effective.dataset.output_dir), "data.yaml").replace(/\\/g, "/"), imgsz: effective.train.imgsz, device: String(effective.train.device), workers: effective.train.workers },
  };
}

/** 工作区里所有含 `data.yaml` 的目录（评估/训练选数据集都用它）。 */
function scanDatasetDirs() {
  if (!root) return [];
  const base = abs("datasets");
  const out = [];
  let names = [];
  try {
    names = fs.readdirSync(base);
  } catch {
    return out;
  }
  for (const n of names) {
    const d = path.join(base, n);
    try {
      if (!fs.statSync(d).isDirectory()) continue;
      const y = path.join(d, "data.yaml");
      if (!fs.existsSync(y)) continue;
      out.push({ dir: d.replace(/\\/g, "/"), dataYaml: y.replace(/\\/g, "/"), name: n, train: countFiles(path.join(d, "images/train")), val: countFiles(path.join(d, "images/val")) });
    } catch {
      /* 读不动就跳过 */
    }
  }
  return out;
}

/* ============================ 导出与端侧（P175-W6，详设 §5.6） ============================ */

/**
 * 格式矩阵（实测 8.4.102 支持的那些）。
 * `needs` 是"这一档除了 pip 包还要什么"——不说清楚的话，用户会以为点了就能出文件。
 * `tflite` 是 `saved_model` 的别名，不单列（列了就会有人找一个并不存在的选项）。
 */
const EXPORT_FORMATS = [
  { id: "onnx", label: "ONNX", needs: "", note: "最通用；MaixCam / OpenVINO / TensorRT 的中转站" },
  { id: "openvino", label: "OpenVINO", needs: "openvino", note: "Intel CPU / iGPU" },
  { id: "engine", label: "TensorRT", needs: "libnvinfer（系统级）", note: "NVIDIA GPU 上最快；导出时可能要下东西" },
  { id: "torchscript", label: "TorchScript", needs: "", note: "纯 python / libtorch 侧" },
  { id: "coreml", label: "CoreML", needs: "macOS + coremltools", note: "Apple 设备" },
  { id: "saved_model", label: "SavedModel", needs: "tensorflow", note: "TF 生态；tflite 走这一档" },
  { id: "pb", label: "Frozen GraphDef", needs: "tensorflow", note: "老的 TF .pb" },
  { id: "edgetpu", label: "Edge TPU", needs: "tensorflow + pycoral", note: "Google Coral" },
  { id: "paddle", label: "PaddlePaddle", needs: "paddlepaddle", note: "百度生态" },
  { id: "mnn", label: "MNN", needs: "MNN", note: "阿里移动端" },
  { id: "ncnn", label: "ncnn", needs: "ncnn", note: "移动端 / 嵌入式 CPU" },
  { id: "imx", label: "i.MX NPU", needs: "nxp ethos-u / vx-tooling", note: "NXP i.MX8MP 一类" },
  { id: "rknn", label: "RKNN", needs: "rockchip rknn-toolkit2", note: "瑞芯微 RK3588 一类" },
  { id: "executorch", label: "ExecuTorch", needs: "executorch", note: "PyTorch 官方端侧" },
  { id: "axelera", label: "Axelera", needs: "axelera SDK", note: "Axelera NPU" },
  { id: "deepx", label: "DeepX", needs: "deepx SDK", note: "DeepX VPU" },
  { id: "qnn", label: "QNN", needs: "Qualcomm QNN SDK", note: "高通 Hexagon NPU" },
  { id: "litert", label: "LiteRT", needs: "litert", note: "Google 新一代端侧" },
  { id: "hailo", label: "Hailo", needs: "hailort + SDK", note: "Hailo NPU" },
];

/**
 * 端侧约束卡。这些是**厂商文档写死的限制**，不是我们的偏好：
 * 违反它们的导出会成功，但东西上不了板子——所以要在点之前就说。
 */
const EDGE_CARDS = [
  {
    id: "maixcam",
    title: "MaixCam / MaixHub 在线转换器",
    tasks: ["detect"],
    opset: 17,
    dynamic: false,
    note: "官方在线转换器**只支持目标检测**（YOLO26 / YOLO11 / YOLOv8 系），示例固定 opset=17、dynamic=False。分割 / 姿态 / 分类要自己手动转。",
  },
];

/** 导出前把端侧约束对一遍：能导 ≠ 能上板。 */
function exportAdvice(fmt, task, opts) {
  const out = [];
  const f = EXPORT_FORMATS.find((x) => x.id === fmt);
  if (f && f.needs) out.push({ level: "warn", text: `${f.label} 需要额外的 ${f.needs}；缺了会在导出那一步报错。` });
  for (const c of EDGE_CARDS) {
    if (c.tasks.includes(task)) continue;
    out.push({ level: "bad", text: `${c.title}：只吃 ${c.tasks.join("/")}，这份模型是 ${task || "?"} —— 导出来也上不了板，得手动转。` });
  }
  // opset 这条只在"这份模型确实可能走那条端侧路"时才提：任务都不搭的话，上面那条 bad 已经说完了
  if (EDGE_CARDS.some((c) => c.tasks.includes(task)) && Number(opts && opts.opset) && !EDGE_CARDS.some((c) => Number(opts.opset) === c.opset)) {
    out.push({ level: "warn", text: `MaixCam 那条路的示例是 opset=${EDGE_CARDS[0].opset}；填了 ${opts.opset} 就要自己确认转换器吃不吃。` });
  }
  if (opts && opts.dynamic) out.push({ level: "warn", text: "dynamic=True 很多端侧栈不吃（MaixCam 就要 False）。" });
  if (task === "detect" && opts && opts.nms !== true) {
    out.push({ level: "info", text: "YOLO26 是端到端输出 [N,300,6]、免 NMS 后处理；如果端侧代码里以前那段后处理还在，要么删掉，要么导出时勾 nms。" });
  }
  return out;
}

/** 读一次导出的结果（runner 写的 `export.json`）。 */
function readExportResult(dir) {
  try {
    return JSON.parse(fs.readFileSync(path.join(String(dir), "export.json"), "utf8"));
  } catch {
    return null;
  }
}

/** 导出历史：`train_runs/export/` 下每个目录里的 `export.json`。 */
function scanExports(limit) {
  if (!root) return [];
  const base = abs("train_runs/export");
  let names = [];
  try {
    names = fs.readdirSync(base);
  } catch {
    return [];
  }
  const out = [];
  for (const n of names) {
    const dir = path.join(base, n).replace(/\\/g, "/");
    const v = readExportResult(dir);
    if (v) out.push({ dir, name: n, ...v });
  }
  out.sort((a, b) => String(b.name).localeCompare(String(a.name)));
  return out.slice(0, limit || 10);
}

/**
 * 起一次导出。走插件自带的 `runner/export_job.py`，**不动用户的 `scripts/export_onnx.py`**；
 * 产物落 `train_runs/export/<时间戳>/`，不往 `models/` 里塞东西（交付是另一颗按钮，本来就有）。
 */
async function exportStart(req) {
  needWorkspace();
  if (active) throw new Error(`已经有一个任务在跑（${active.label}）：先停掉它`);
  const o = isObj(req) ? req : {};
  const fmt = String(o.format || "onnx").trim().toLowerCase();
  if (!EXPORT_FORMATS.some((f) => f.id === fmt)) throw new Error(`不支持的导出格式：${o.format}`);
  const py = await detectPython();
  if (!py.ok) throw new Error(`找不到可用的 python：${py.error}`);
  const runner = path.join(PKG_DIR, "runner", "export_job.py").replace(/\\/g, "/");
  if (!fs.existsSync(runner)) throw new Error("插件包里没有 runner/export_job.py：重装一次插件");
  const { effective } = await effectiveConfig();
  const weights = abs(String(o.weights || effective.eval?.model || effective.train.weights || ""));
  if (!weights || !fs.existsSync(weights)) throw new Error(`找不到要导出的权重：${weights || "(没填)"}`);
  const data = abs(String(o.data || effective.eval?.data || "")) || path.join(abs(effective.dataset.output_dir), "data.yaml").replace(/\\/g, "/");
  const imgsz = Number(o.imgsz || effective.export?.imgsz || effective.train.imgsz || 640);
  const out = abs(`train_runs/export/${new Date().toISOString().replace(/[-:TZ.]/g, "").slice(0, 14)}`);
  rememberPath("weights", weights, "export");
  rememberPath("data", data, "export");
  const merged = merge({}, effective);
  merged.export = { format: fmt, imgsz, dynamic: !!o.dynamic, simplify: o.simplify !== false, opset: Number(o.opset) || 0, quantize: String(o.quantize || "") };

  const job = newJob("export", `导出 ${fmt}`);
  const confPath = snapshotPathFor("export", fmt, job.startedAt);
  fs.mkdirSync(path.dirname(confPath), { recursive: true });
  fs.writeFileSync(confPath, dumpConfig(merged), "utf8");
  job.configPath = confPath;
  job.exportOut = out;
  jobs.set(job.id, job);
  active = job;

  const args = [runner, "--weights", weights, "--format", fmt, "--config", confPath, "--data", data, "--imgsz", String(imgsz), "--out", out];
  if (o.dynamic) args.push("--dynamic");
  if (o.simplify === false) args.push("--no-simplify");
  if (Number(o.opset)) args.push("--opset", String(Number(o.opset)));
  if (o.quantize) args.push("--quantize", String(o.quantize));
  if (o.nms) args.push("--nms");
  pushLine(job, `[工作台] python: ${py.path}（${py.source}）`, "sys");
  pushLine(job, `[工作台] 产物目录: ${out}`, "sys");
  pushLine(job, `[工作台] 命令: "${py.path}" "${runner}" ${args.map((a) => `"${a}"`).join(" ")}`, "sys");

  try {
    const child = ctx.process.spawn({
      cmd: py.path,
      args,
      cwd: root,
      env: { ...PY_ENV, OPENBLAS_NUM_THREADS: "1", KMP_DUPLICATE_LIB_OK: "TRUE", CUDA_MODULE_LOADING: "LAZY" },
      onStdout: (l) => pushLine(job, l, "out"),
      onStderr: (l) => pushLine(job, l, "err"),
      onExit: (code) => finishJob(job, code),
      onError: (e) => {
        pushLine(job, `[工作台] 起进程失败：${(e && e.message) || e}`, "sys");
        finishJob(job, -1);
      },
    });
    job.pid = child.pid || 0;
    job.child = child;
  } catch (e) {
    pushLine(job, `[工作台] 起进程失败：${(e && e.message) || e}`, "sys");
    finishJob(job, -1);
    throw e;
  }
  return snapshot(job);
}

/** 导出页一次拿全：格式矩阵、端侧约束、历史、可选权重、当前任务。 */
async function exportState() {
  const { effective } = await effectiveConfig();
  const weights = scanModels(40).map((f) => ({ file: f.file, name: f.name, task: factsFor(f)?.task || "", bytes: f.bytes }));
  const chosen = String((effective.train && effective.train.weights) || "");
  const here = weights.find((w) => w.file.toLowerCase() === chosen.toLowerCase());
  const task = (here && here.task) || weightsTaskFacts(chosen).task || "";
  const hist = scanExports(8);
  return {
    ok: true,
    formats: EXPORT_FORMATS,
    cards: EDGE_CARDS,
    history: hist,
    last: hist.length ? hist[0] : null,
    weights,
    bests: scanRuns(effective.train.project).filter((r) => r.hasBest).map((r) => ({ v: r.best, t: "run " + r.name + " 的 best.pt" })),
    candidates: deployCandidates(effective.train.project),
    current: { weights: chosen, task, format: String(effective.export?.format || "onnx"), imgsz: effective.export?.imgsz || effective.train.imgsz || 640, data: path.join(abs(effective.dataset.output_dir), "data.yaml").replace(/\\/g, "/") },
  };
}

/* ============================ 官方权重下载（P177-C） ============================ */

/**
 * v1 只认官方 ultralytics/assets 的这一个 release（与当前 ultralytics 8.4.102 的默认
 * `attempt_download_asset` 一致）。升级包版本时改这一处，不做"任意 URL 下载"。
 */
const DL_RELEASE = "v8.4.0";
const DL_HOSTS = ["github.com", "objects.githubusercontent.com", "raw.githubusercontent.com"];
const DL_LICENSE = "AGPL-3.0";
const DL_MAX_BYTES = 200 * 1024 * 1024;

function dlUrl(name) {
  return `https://github.com/ultralytics/assets/releases/download/${DL_RELEASE}/${name}`;
}

/** 官方清单：只列本插件真能训/能部署的两类（detect / segment）× YOLO11 / YOLO26。 */
const OFFICIAL_WEIGHTS = (() => {
  const out = [];
  for (const family of ["yolo11", "yolo26"]) {
    for (const scale of ["n", "s", "m", "l", "x"]) {
      for (const task of ["detect", "segment"]) {
        const name = `${family}${scale}${task === "segment" ? "-seg" : ""}.pt`;
        out.push({ name, family, scale, task, url: dlUrl(name), license: DL_LICENSE });
      }
    }
  }
  return out;
})();

const dlLedgerPath = () => abs("models/pretrained/downloads.json");

function readDownloadLedger() {
  const j = readJson(dlLedgerPath(), null);
  return isObj(j) && isObj(j.files) ? j : { schemaVersion: 1, release: DL_RELEASE, files: {} };
}

function writeDownloadLedger(next) {
  if (!canWrite()) return;
  fs.mkdirSync(path.dirname(dlLedgerPath()), { recursive: true });
  writeJsonAtomic(dlLedgerPath(), { ...next, schemaVersion: 1, release: DL_RELEASE, updatedAt: new Date().toISOString() });
}

function officialTarget(nameIn) {
  const item = OFFICIAL_WEIGHTS.find((x) => x.name === String(nameIn || ""));
  if (!item) throw new Error(`不在官方清单里：${nameIn || "(空)"}。v1 只允许 ultralytics/assets 的 YOLO11 / YOLO26 检测与分割权重`);
  return { ...item, path: abs(`models/pretrained/${item.family}/${item.name}`) };
}

/** 模型页的下载面板：清单 + 已下载 + 正在下 + 许可证/来源，一次拿全。 */
async function modelDownloadState() {
  const ledger = readDownloadLedger();
  const items = OFFICIAL_WEIGHTS.map((x) => {
    const rec = ledger.files[x.name] || null;
    const target = abs(`models/pretrained/${x.family}/${x.name}`);
    let bytes = 0;
    try {
      bytes = fs.statSync(target).size;
    } catch {
      /* 还没下 */
    }
    return {
      ...x,
      path: target,
      exists: !!bytes,
      bytes,
      sha256: rec && rec.sha256 ? String(rec.sha256) : "",
      downloadedAt: rec && rec.downloadedAt ? String(rec.downloadedAt) : "",
    };
  });
  const { effective } = await effectiveConfig();
  const running = active && active.kind === "download" ? snapshot(active) : null;
  return {
    ok: true,
    release: DL_RELEASE,
    license: DL_LICENSE,
    hosts: DL_HOSTS,
    maxBytes: DL_MAX_BYTES,
    items,
    installed: items.filter((x) => x.exists).length,
    proxy: effective.env && effective.env.proxy_enable ? String(effective.env.proxy || "") : "",
    active: running,
    readOnly: !canWrite(),
  };
}

/**
 * 起一次下载。**不自动设为训练权重、不自动装包**：下完只落盘 + 记账 + 探针读事实，
 * 用不用由用户回去点。已存在同路径时直接返回 exists，不重下。
 */
async function modelDownload(req) {
  needWorkspace();
  if (active) throw new Error(`已经有一个任务在跑（${active.label}）：先停掉它`);
  if (!canWrite()) throw new Error("当前是只读模式：能看模型清单，不能下载");
  const o = isObj(req) ? req : {};
  const item = officialTarget(o.name);
  if (fs.existsSync(item.path) && fs.statSync(item.path).size > 0) {
    return { ok: true, exists: true, path: item.path, bytes: fs.statSync(item.path).size, name: item.name };
  }
  const py = await detectPython();
  if (!py.ok) throw new Error(`找不到可用的 python：${py.error}`);
  const runner = path.join(PKG_DIR, "runner", "download_job.py").replace(/\\/g, "/");
  if (!fs.existsSync(runner)) throw new Error("插件包里没有 runner/download_job.py：重装一次插件");

  // 磁盘守卫：官方权重最大 ~140MB，留 512MB 余量给 .part 与解压/缓存
  let free = 0;
  try {
    const st = fs.statfsSync(root);
    free = Number(st.bavail) * Number(st.bsize) || 0;
  } catch {
    /* 某些文件系统不支持 statfs；不拦 */
  }
  if (free && free < 512 * 1024 * 1024) {
    throw new Error(`工作区可用空间只剩 ${fmtBytes(free)}，不够下载（至少留 512 MB）。先到资产页清理，再回来`);
  }

  const { effective } = await effectiveConfig();
  const proxy = effective.env && effective.env.proxy_enable ? String(effective.env.proxy || "") : "";
  const ledger = readDownloadLedger();
  const rec = ledger.files[item.name] || null;
  const job = newJob("download", `下载 ${item.name}`);
  job.download = { name: item.name, target: item.path, url: item.url };
  jobs.set(job.id, job);
  active = job;

  const args = [runner, "--url", item.url, "--out", item.path, "--max-bytes", String(DL_MAX_BYTES), "--allow-hosts", DL_HOSTS.join(",")];
  if (proxy) args.push("--proxy", proxy);
  if (rec && Number(rec.bytes) > 0) args.push("--expect-bytes", String(Number(rec.bytes)));
  if (rec && rec.sha256) args.push("--expect-sha256", String(rec.sha256));
  pushLine(job, `[工作台] 来源: ${item.url}（release ${DL_RELEASE}）`, "sys");
  pushLine(job, `[工作台] 目标: ${item.path}`, "sys");
  pushLine(job, proxy ? `[工作台] 代理: 已按工作区配置启用` : "[工作台] 代理: 未启用（直连）", "sys");
  if (rec && rec.sha256) pushLine(job, `[工作台] 已有下载记录，会核对大小与 SHA256`, "sys");

  try {
    const child = ctx.process.spawn({
      cmd: py.path,
      args,
      cwd: root,
      env: { ...PY_ENV, OPENBLAS_NUM_THREADS: "1", PYTHONUNBUFFERED: "1" },
      onStdout: (l) => onDownloadLine(job, l),
      onStderr: (l) => pushLine(job, l, "err"),
      onExit: (code) => {
        finishJob(job, code);
        if (!job.stopped && code === 0 && job.downloadResult && job.downloadResult.ok) {
          const next = readDownloadLedger();
          next.files[item.name] = {
            name: item.name,
            url: item.url,
            release: DL_RELEASE,
            license: DL_LICENSE,
            bytes: Number(job.downloadResult.bytes) || 0,
            sha256: String(job.downloadResult.sha256 || ""),
            downloadedAt: new Date().toISOString(),
            path: item.path,
          };
          writeDownloadLedger(next);
          try {
            ctx.panels.emit(PANEL, "assets", { reason: "download", name: item.name });
          } catch {
            /* 面板没开 */
          }
          // 探针读 task/nc：读不出就只记文件，不猜事实
          Promise.resolve()
            .then(() => modelLibrary(true))
            .catch(() => {});
        }
        if (active === job) active = null;
      },
      onError: (e) => {
        pushLine(job, `[工作台] 起进程失败：${(e && e.message) || e}`, "sys");
        finishJob(job, -1);
      },
    });
    job.pid = child.pid || 0;
    job.child = child;
  } catch (e) {
    pushLine(job, `[工作台] 起进程失败：${(e && e.message) || e}`, "sys");
    finishJob(job, -1);
    throw e;
  }
  return snapshot(job);
}

/** 下载器的输出是 JSON 行；转成人能读的那一句再进日志，同时更新进度。 */
function onDownloadLine(job, line) {
  const text = String(line || "").trim();
  if (!text) return;
  if (!text.startsWith("{")) {
    pushLine(job, text, "out");
    return;
  }
  let m = null;
  try {
    m = JSON.parse(text);
  } catch {
    pushLine(job, text, "out");
    return;
  }
  const p = job.progress;
  if (m.type === "head") {
    job.download.total = Number(m.total) || 0;
    p.phase = "download";
    p.detail = `文件大小 ${fmtBytes(m.total)}`;
    pushLine(job, `[下载] 文件大小 ${fmtBytes(m.total)}`, "sys");
  } else if (m.type === "progress") {
    job.download.done = Number(m.done) || 0;
    job.download.total = Number(m.total) || job.download.total || 0;
    p.phase = "download";
    p.percent = Number(m.pct) || 0;
    p.detail = `${fmtBytes(job.download.done)} / ${job.download.total ? fmtBytes(job.download.total) : "未知"}` + (m.speed ? ` · ${fmtBytes(m.speed)}/s` : "");
  } else if (m.type === "retry") {
    pushLine(job, `[下载] 第 ${m.attempt} 次失败，正在重试：${m.error || ""}`, "err");
    p.detail = "网络不稳，正在重试（.part 保留）";
  } else if (m.type === "done") {
    job.downloadResult = m;
    p.phase = "done";
    p.percent = 100;
    p.detail = `${fmtBytes(m.bytes)} · SHA256 ${String(m.sha256 || "").slice(0, 12)}…`;
    pushLine(job, `[下载] 完成：${m.path}`, "sys");
    pushLine(job, `[下载] SHA256 ${m.sha256}`, "sys");
  } else if (m.type === "cancelled") {
    pushLine(job, `[下载] ${m.message || "已取消"}`, "sys");
  } else if (m.type === "error") {
    job.downloadError = String(m.message || "下载失败");
    p.phase = "error";
    p.detail = job.downloadError;
    pushLine(job, `[错误] ${job.downloadError}`, "err");
  } else {
    pushLine(job, text, "out");
  }
}

/* ============================ 实验管理（P175-W7，详设 §5.7 / §4.3） ============================ */

/** 一个 run 的档案：面板上的实验列表就是它。 */
function runProfile(project, name) {
  const dir = path.join(abs(project || DEFAULTS.train.project), name);
  const args = readRunArgs(dir);
  const best = path.join(dir, "weights", "best.pt");
  const last = path.join(dir, "weights", "last.pt");
  let hasBest = false;
  let bestBytes = 0;
  try {
    const st = fs.statSync(best);
    hasBest = true;
    bestBytes = st.size;
  } catch {
    /* 还没写出 best.pt */
  }
  let parsed = { columns: [], rows: [] };
  try {
    parsed = parseResultsCsv(fs.readFileSync(path.join(dir, "results.csv"), "utf8"));
  } catch {
    /* 没写出 csv */
  }
  const rows = parsed.rows;
  const lastRow = rows.length ? rows[rows.length - 1] : {};
  const hasResultsCsv = fs.existsSync(path.join(dir, "results.csv"));
  let finishedAt = 0;
  try {
    finishedAt = fs.statSync(path.join(dir, "results.csv")).mtimeMs;
  } catch {
    /* 没写出 csv */
  }
  const durationSec = Number(lastRow.time) || 0;
  // 最佳轮按掩膜 mAP50-95 找（检测任务没有 M 列就退回框），而不是拿最后一轮冒名
  let bestEpoch = rows.length ? Number(lastRow.epoch) || rows.length : 0;
  let bestVal = -Infinity;
  for (const row of rows) {
    const v = Number(row["metrics/mAP50-95(M)"] ?? row["metrics/mAP50-95(B)"]);
    if (Number.isFinite(v) && v > bestVal) {
      bestVal = v;
      bestEpoch = Number(row.epoch) || bestEpoch;
    }
  }
  const noteFile = abs(`train_runs/${String(name).replace(/[^\w.-]+/g, "-")}.note`);
  let note = "";
  try {
    note = fs.readFileSync(noteFile, "utf8").trim();
  } catch {
    /* 还没写过备注 */
  }
  const base = {
    name,
    dir: dir.replace(/\\/g, "/"),
    task: String(args.task || ""),
    model: String(args.model || ""),
    imgsz: args.imgsz == null ? "" : String(args.imgsz),
    epochs: rows.length,
    bestEpoch,
    finishedAt,
    startedAt: finishedAt && durationSec > 0 ? Math.round(finishedAt - durationSec * 1000) : 0,
    hasResultsCsv,
    argsEpochs: Number(args.epochs) || 0,
    argsData: String(args.data || ""),
    argsWeights: String(args.weights || args.model || ""),
    hasBest,
    best: hasBest ? best.replace(/\\/g, "/") : "",
    bestBytes,
    hasLast: fs.existsSync(last),
    last: fs.existsSync(last) ? last.replace(/\\/g, "/") : "",
    mAP50: lastRow["metrics/mAP50(B)"] ?? "",
    mAP5095: lastRow["metrics/mAP50-95(B)"] ?? "",
    mAP50M: lastRow["metrics/mAP50(M)"] ?? "",
    mAP5095M: lastRow["metrics/mAP50-95(M)"] ?? "",
    durationText: fmtDuration(Number(lastRow.time) || 0),
    durationSec: Number(lastRow.time) || 0,
    note,
    noteFile,
    argsFile: path.join(dir, "args.yaml").replace(/\\/g, "/"),
    argsKeys: Object.keys(args).length,
  };
  const status = runStatusOf(name, base, readRunMeta(name));
  return { ...base, status: status.status, statusLabel: status.label, statusWhy: status.why, managed: status.managed };
}

/** 实验列表（默认页那个表）。 */
function runProfiles(project, limit) {
  const runs = scanRuns(project);
  return runs.slice(0, limit || 40).map((r) => runProfile(project, r.name));
}

/**
 * 「等价命令」：面板上点出来的这一次，命令行怎么原样跑。
 *
 * 三条都是**真的能跑的**，不是示意图：
 * ① 插件 runner（吃全部参数）；② 用户自己的 `scripts/train.py`（只吃它认得的那 20 个键，
 * 但用的是**同一份 yaml**）；③ ultralytics CLI——直接吃引擎自己写的 `args.yaml`，
 * 换一个 `name` 免得盖掉原产物。
 */
function reproCommands(run) {
  // 用**探测到的那枚 python**，不是裸 `python`：这台机器的解释器是 conda 环境里的绝对路径
  // （`_env.bat` 写的），PATH 上没有 `python` —— 写裸命令的话，「复制到 cmd 里能直接跑通」
  // 这条承诺就是假的（端到端试用时照出来的）。没探测过才退回 `python`。
  const py = pyCache.ok && pyCache.path ? pyCache.path.replace(/\\/g, "/") : "python";
  const ws = root.replace(/\\/g, "/");
  const runner = path.join(PKG_DIR, "runner", "train_job.py").replace(/\\/g, "/");
  const snap = abs(`train_runs/repro-${run.name}-${Date.now().toString(36)}.yaml`);
  const args = readRunArgs(run.dir);
  const merged = merge({}, DEFAULTS);
  merged.train = merge(merge({}, DEFAULTS.train), args);
  merged.train.weights = String(args.model || run.model || merged.train.weights);
  merged.train.project = abs(String(args.project || run.project || "runs"));
  merged.train.name = String(args.name || run.name);
  merged.dataset.output_dir = abs(merged.dataset.output_dir);
  const data = String(args.data || "");
  if (data) merged.train.data = data;
  return {
    snapshot: snap,
    text: dumpConfig(merged),
    commands: [
      { id: "runner", label: `插件 runner（全部 ${Object.keys(args).length} 个参数都吃）`, cmd: `"${py}" "${runner}" --config "${snap}" --root "${ws}"` },
      { id: "workspace", label: "工作区脚本（只认它自己那 20 个键）", cmd: `"${py}" "${ws}/scripts/train.py" --config "${snap}"` },
      { id: "cli", label: "ultralytics CLI（直接吃引擎写的 args.yaml）", cmd: `yolo train cfg="${run.argsFile}" name=${run.name}_repro exist_ok=false` },
    ],
  };
}

/** 把等价命令写成一个 .bat——落在 `train_runs/bat/`，绝不碰 `00~07` 那批编号脚本。 */
function writeReproBat(run, which) {
  const r = reproCommands(run);
  fs.mkdirSync(path.dirname(r.snapshot), { recursive: true }); // 第一次复现时 train_runs/ 可能还不存在
  fs.writeFileSync(r.snapshot, r.text, "utf8");
  const hit = r.commands.find((c) => c.id === which) || r.commands[0];
  const dir = abs("train_runs/bat");
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `run_${String(run.name).replace(/[^\w.-]+/g, "-")}-${hit.id}.bat`);
  const py = readEnvBat() || "python";
  // 命令里那颗 `python` 换成 `_env.bat` 里那一条：复现脚本要能在装了环境的机器上双击就跑
  const line = hit.cmd.replace(/^"python"/, `"${py.replace(/\\/g, "/")}"`);
  const body = [
    "@echo off",
    "chcp 65001 >nul",
    "REM 由 uartix.yolo 生成的复现脚本。只读，不改工作区里任何既有文件。",
    `REM 快照：${r.snapshot.replace(/\\/g, "/")}`,
    `REM 任务：${run.task || "?"} / 模型：${run.model || "?"}`,
    line,
    "echo.",
    "echo ==== 复现结束。产物在 runs/ 下对应目录 ====",
    "pause >nul",
    "",
  ].join("\r\n");
  fs.writeFileSync(file, body, "utf8");
  return { ok: true, file: file.replace(/\\/g, "/"), snapshot: r.snapshot, commands: r.commands };
}

/** 备注：写进 `train_runs/<实验>.note`，不碰 `runs/`（那是引擎的产物区）。 */
function saveRunNote(project, name, text) {
  const safe = String(name == null ? "" : name).replace(/[^\w.-]+/g, "-");
  if (!safe) throw new Error("没有这个实验");
  const file = abs(`train_runs/${safe}.note`);
  const t = String(text == null ? "" : text).slice(0, 2000);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  if (t.trim()) fs.writeFileSync(file, t, "utf8");
  else {
    try {
      fs.unlinkSync(file);
    } catch {
      /* 本来就没有 */
    }
  }
  return runProfile(project, name);
}

/**
 * 归档：把 `args.yaml + results.csv + best.pt` **复制**进 `train_runs/archive/<run>-<时间>/`。
 *
 * 设计稿写的是"移"。这里刻意改成复制：搬走会让 `runs/` 里的历史断档，
 * 而那个目录是用户自己会去看的——断档的代价比多占一点磁盘大得多。
 */
/**
 * 中断/停止后的续训计划（P177-E）。
 *
 * 默认**开新 run**：`weights = last.pt`、`name = <原名>-resume`、`resume` 留空。
 * 这样优化器状态保住了、原 run 的产物不被覆盖、曲线重新从第 1 轮计（看得清"续了多久"）。
 * Ultralytics 原生 `resume=last.pt` 只作为高级选项：它会写回原 run 目录并接着原轮次，
 * 跨包版本时容易失败，所以不放在默认路径上。
 */
async function resumePlan(req) {
  needWorkspace();
  const o = isObj(req) ? req : {};
  const run = String(o.run || "");
  if (!run) throw new Error("没说哪个 run");
  const { effective } = await effectiveConfig();
  const project = String(o.project || effective.train.project || DEFAULTS.train.project);
  const dir = path.join(abs(project), run);
  if (!fs.existsSync(dir)) throw new Error(`没有这个 run：${run}`);
  const last = path.join(dir, "weights", "last.pt");
  const args = readRunArgs(dir);
  const native = String(o.mode || "new") === "native";
  if (!fs.existsSync(last)) {
    return {
      ok: false,
      run,
      why: `这个 run 没有 weights/last.pt：${last}。没有优化器状态就没法续训；从 best.pt 接着训只会"从头开始但轮次接着数"，不要这么做。`,
      patch: null,
    };
  }
  const epochs = Number(args.epochs) || Number(effective.train.epochs) || 300;
  const patch = {
    task: String(args.task || effective.train.task || ""),
    weights: last.replace(/\\/g, "/"),
    data: String(args.data || effective.train.data || ""),
    project: String(args.project || project),
    name: native ? run : `${run}-resume`,
    epochs,
    resume: native ? last.replace(/\\/g, "/") : "",
  };
  return {
    ok: true,
    run,
    native,
    last: last.replace(/\\/g, "/"),
    patch,
    warnings: native
      ? ["原生 resume 会写回原 run 目录、接着原轮次；跨 ultralytics 版本可能直接失败。产物会被这次续训覆盖。"]
      : ["开新 run：原 run 不动，曲线从第 1 轮重新计；优化器状态来自 last.pt。", "跑之前确认 epochs 是「总共要跑到多少轮」，不是「再跑多少轮」——Ultralytics 的 epochs 是总轮次。"],
  };
}

/** 训练前的磁盘守卫：按同类 run 的实测体积 × 1.5 预估；不够就明说，不启动。 */
async function diskGuard() {
  const { effective } = await effectiveConfig();
  const project = abs(effective.train.project || DEFAULTS.train.project);
  let sample = 0;
  let count = 0;
  for (const r of scanRuns(project).slice(0, 12)) {
    if (!r.bytes) continue;
    sample += r.bytes;
    count += 1;
  }
  const perRun = count ? sample / count : 0;
  const need = perRun ? perRun * 1.5 : 512 * 1024 * 1024;
  let free = 0;
  try {
    const st = fs.statfsSync(root);
    free = Number(st.bavail) * Number(st.bsize) || 0;
  } catch {
    return { ok: true, free: 0, need: 0, note: "这个文件系统不支持查询可用空间，跳过磁盘守卫" };
  }
  return {
    ok: free >= need,
    free,
    need,
    sampleRuns: count,
    note: free >= need ? "" : `可用 ${fmtBytes(free)}，按同类 run 预估这次要 ${fmtBytes(need)}（${count} 个样本 × 1.5）。先到资产页清理，或把 project 换到空间更大的盘。`,
  };
}

function archiveRun(project, name) {

  const run = runProfile(project, name);
  if (!run.dir || !fs.existsSync(run.dir)) throw new Error(`没有这个 run：${name}`);
  const stamp = new Date().toISOString().replace(/[-:TZ.]/g, "").slice(0, 14);
  const dst = abs(`${RUNS_DIR}/archive/${String(name).replace(/[^\w.-]+/g, "-")}-${stamp}`);
  fs.mkdirSync(path.join(dst, "weights"), { recursive: true });
  const copied = [];
  for (const [src, rel] of [
    [path.join(run.dir, "args.yaml"), "args.yaml"],
    [path.join(run.dir, "results.csv"), "results.csv"],
    [run.best, "weights/best.pt"],
  ]) {
    if (!src || !fs.existsSync(src)) continue;
    fs.copyFileSync(src, path.join(dst, rel));
    copied.push(rel);
  }
  if (run.note) fs.writeFileSync(path.join(dst, "note.txt"), run.note, "utf8");
  return { ok: true, dst: dst.replace(/\\/g, "/"), copied, from: run.dir, moved: false };
}

/* ============================ 监控与失败归类（P175-W4，详设 §5.4） ============================ */

/**
 * 解析 `results.csv`。不自造采集：引擎已经逐轮往这个文件里写。
 * 要的是**容忍形状变化**——非 resume 重跑会删重建、不同任务列集合不同
 * （分割才有 `train/seg_loss` 与 `(M)` 那一组）、列名带空格和括号。列不认识就原样留着，不猜含义。
 */
function parseResultsCsv(text) {
  const lines = String(text || "").split(/\r?\n/).filter((l) => l.trim());
  if (!lines.length) return { columns: [], rows: [] };
  const columns = lines[0].split(",").map((s) => s.trim().replace(/^/, ""));
  const rows = [];
  for (const line of lines.slice(1)) {
    const cells = line.split(",");
    if (cells.length < 2) continue; // 半行（引擎正在写）跳过，不报错
    const row = {};
    columns.forEach((c, i) => {
      const raw = String(cells[i] == null ? "" : cells[i]).trim();
      const n = Number(raw);
      row[c] = raw !== "" && Number.isFinite(n) ? n : raw;
    });
    rows.push(row);
  }
  return { columns, rows };
}

/** 抽稀：几千个点画在面板上没意义。等间隔留 ~140 个，但最后一个点必须是真·最后。 */
function downsample(rows, want) {
  const n = want || 140;
  if (rows.length <= n) return rows.slice();
  const stride = rows.length / n;
  const out = [];
  for (let i = 0; i < n; i++) out.push(rows[Math.floor(i * stride)]);
  if (out[out.length - 1] !== rows[rows.length - 1]) out.push(rows[rows.length - 1]);
  return out;
}

/** 曲线要画的列：只画**实际存在**的那些（缺哪列就少一条线，不编）。 */
function chartColumns(columns) {
  const has = (c) => columns.includes(c);
  return {
    loss: ["train/box_loss", "train/cls_loss", "train/dfl_loss", "train/seg_loss", "train/sem_loss"].filter(has),
    map: ["metrics/mAP50(B)", "metrics/mAP50-95(B)", "metrics/mAP50(M)", "metrics/mAP50-95(M)"].filter(has),
  };
}

/** 显存：`nvidia-smi` 比 import torch 快两个数量级（~0.2s vs ~7s）——轮询只用得起前者。 */
async function memInfo() {
  const r = await runOnce("nvidia-smi", ["--query-gpu=memory.total,memory.used", "--format=csv,noheader,nounits"], 8000);
  if (r.code !== 0) return { ok: false, error: String(r.err || r.out || "nvidia-smi 不可用").slice(0, 160) };
  const line = String(r.out || "").split(/\r?\n/).find((l) => l.includes(",")) || "";
  const parts = line.split(",").map((x) => Number(String(x).trim()));
  if (parts.length < 2 || !Number.isFinite(parts[0]) || !Number.isFinite(parts[1])) return { ok: false, error: "nvidia-smi 输出读不懂" };
  const total = parts[0];
  const used = parts[1];
  return { ok: true, totalMiB: total, usedMiB: used, freeMiB: Math.max(0, total - used), percent: total > 0 ? Math.round((used / total) * 100) : 0 };
}

/**
 * 失败归类的规则表。顺序有意义：越具体的排越前面。
 * 每条都带"下一步做什么"——只说"失败了"的面板等于没说。
 */
const FAILURE_KINDS = [
  {
    kind: "oom",
    re: /CUDA out of memory|CUBLAS_STATUS_ALLOC_FAILED|DefaultCPUAllocator|not enough memory|allocation failed/i,
    label: "显存 / 内存不够",
    advice: "batch 减半（或填 -1 让引擎自己挑）；workers 保持 0；cache 改 false；或把 imgsz 降一档。",
  },
  {
    kind: "labels",
    re: /Label length|labels appear corrupt|Segment labels appear|corrupt/i,
    label: "标注文件不合法",
    advice: "去数据页点「体检一遍」：越界坐标、非法 token 数、train/val 重名都会以这种方式炸。",
  },
  {
    kind: "env",
    re: /ModuleNotFoundError|No module named|ImportError/i,
    label: "这套 python 里没有 ultralytics",
    advice: "面板用的是 _env.bat 里那枚 python（概览「环境」能看到是谁）。装好依赖，或把 _env.bat 指到装过 ultralytics 的环境——面板不替你装包。",
  },
  {
    kind: "path",
    re: /FileNotFoundError|No such file or directory|找不到|does not exist|not a valid dataset/i,
    label: "路径或文件缺失",
    advice: "先看 data.yaml 与权重在不在；数据集没构建就去数据页构建；标注放进 annotations/ 投料口。",
  },
  {
    kind: "version",
    re: /is not supported for this model|requires .*>=|not a valid YOLO argument|Unrecognized argument/i,
    label: "版本或参数不匹配",
    advice: "这代模型 / 这个参数当前这套 ultralytics 不认。看「先看这次会用什么参数」里被丢掉的键，或升级包。",
  },
  {
    kind: "cuda",
    re: /Torch not compiled with CUDA|no CUDA GPUs are available|no kernel image|CUDA initialization/i,
    label: "CUDA 用不了",
    advice: "device 先改成 cpu 跑通流程，或确认这个环境装的是 CUDA 版 torch（概览点「深度自检」）。",
  },
  {
    kind: "download",
    re: /URLError|getaddrinfo|Failed to establish|Connection (?:reset|aborted)|timed out/i,
    label: "网络 / 代理不通",
    advice: "权重下载要出网。代理不对时把 .pt 手动放进 models/ 再选它——面板不替你改网络设置。",
  },
];

/**
 * 构建数据集"退出码 0 但什么都没构建出来"的兜底判据。
 *
 * 用户的 `build_dataset.py` 对"标签名不在类别表"只打 `[警告]` 然后正常退出 —— 于是面板会显示成功，
 * 而数据集里一个标注框都没有（端到端试用真撞上过一次：中文类别名被探针串成乱码）。
 * 这里不猜原因，只把它自己打的账读回来：类别计数全 0、或全部样本都没有有效标注 → 提醒。
 */
function datasetWarning(lines) {
  const text = (lines || []).join("\n");
  let total = 0;
  let classes = 0;
  for (const m of text.matchAll(/类别\s+.+?\s*:\s*(\d+)\s*个标注框/g)) {
    total += Number(m[1]) || 0;
    classes += 1;
  }
  const skipped = [];
  for (const m of text.matchAll(/跳过\s+(.+?)\s*:\s*(\d+)\s*个/g)) skipped.push([m[1], Number(m[2]) || 0]);
  const skipN = skipped.reduce((n, s) => n + s[1], 0);
  const samples = Number((/合计\s+(\d+)\s+个样本/.exec(text) || [])[1] || 0);
  const empty = Number((/有\s+(\d+)\s+张图片没有任何有效标注框/.exec(text) || [])[1] || 0);

  if (classes && total === 0) {
    const why = skipped.length ? `被跳过的标签名：${skipped.map((s) => `${s[0]}（${s[1]} 个）`).join("、")}。` : "";
    return `构建退出码是 0，但这次一个标注框都没落盘——标注里的标签名和类别表 classes 对不上。${why}` +
      `先去「数据」页核对类别表与投料口再重新构建（类别名区分大小写；中文类别名如果显示成乱码，是编码问题，不是你没标）。`;
  }
  if (samples && empty >= samples) {
    return `这 ${samples} 张图片全都没有有效标注框：要么没导出 json、要么 json 里的形状名不在类别表里。训练会跑但学不到东西。`;
  }
  if (skipN) {
    return `有 ${skipN} 个标注被跳过（${skipped.map((s) => `${s[0]} ${s[1]} 个`).join("、")}）——它们不会进训练集，看看是不是类别表少了名字。`;
  }
  return "";
}

/** 从日志尾部往前找第一个命中的归类；用户主动停止不算失败。 */
function classifyFailure(lines) {
  const list = (Array.isArray(lines) ? lines : []).map((l) => (typeof l === "string" ? l : String((l && l.text) || "")));
  if (!list.length) return null;
  const tail = list.slice(-200);
  if (tail.some((l) => /用户要求停止/.test(l))) return { kind: "stopped", label: "你停掉的", advice: "", matched: "" };
  for (const f of FAILURE_KINDS) {
    const hit = tail.slice().reverse().find((l) => f.re.test(l));
    if (hit) return { kind: f.kind, label: f.label, advice: f.advice, matched: hit.slice(0, 240) };
  }
  return { kind: "unknown", label: "没归类出来", advice: "把日志最后 20 行贴出来看；这一类以后可以补进规则表。", matched: "" };
}

/** 上一次任务的失败结论（跑成功就清掉——留着会让用户以为还在失败）。 */
let lastFailure = null;

/** 监控一次：在跑/最近一次 run 的曲线、进度、ETA、显存、失败归类。 */
async function monitor(runName) {
  needWorkspace();
  const { effective } = await effectiveConfig();
  const project = effective.train.project || DEFAULTS.train.project;
  const runs = scanRuns(project);
  const name = typeof runName === "string" && runName ? runName : active && active.kind === "train" ? String(effective.train.name || "") : runs[0] ? runs[0].name : "";
  const brief = runs.slice(0, 12).map((r) => ({ name: r.name, epochs: r.epochs, mAP50: r.metrics ? r.metrics.mAP50M : "", hasBest: r.hasBest, durationText: r.durationText }));
  if (!name) return { ok: false, error: "还没有训练产物（runs/ 里没找到 results.csv）", runs: brief, rows: [] };
  const dir = path.join(abs(project), name);
  let parsed = { columns: [], rows: [] };
  let exists = false;
  try {
    parsed = parseResultsCsv(fs.readFileSync(path.join(dir, "results.csv"), "utf8"));
    exists = true;
  } catch {
    /* 还没写出来：给空曲线而不是报错 */
  }
  const rows = parsed.rows;
  const last = rows.length ? rows[rows.length - 1] : null;
  const epochs = Number(effective.train.epochs) || 0;
  const doneEpoch = last ? Number(last.epoch) || rows.length : 0;
  // ETA 用**实测平均**（累计耗时 / 已完成轮数）。引擎打的那个数含准备数据的时间，第一版偏得离谱
  const elapsed = last ? Number(last.time) || 0 : 0;
  const perEpoch = doneEpoch > 0 && elapsed > 0 ? elapsed / doneEpoch : 0;
  const remain = epochs > 0 && perEpoch > 0 && epochs > doneEpoch ? Math.round((epochs - doneEpoch) * perEpoch) : 0;
  const mem = await memInfo();
  const running = active && active.kind === "train" && active.state === "running" ? snapshot(active) : null;
  return {
    ok: true,
    run: name,
    dir: dir.replace(/\\/g, "/"),
    exists,
    epochs,
    doneEpoch,
    percent: epochs > 0 ? Math.min(100, Math.round((doneEpoch / epochs) * 100)) : 0,
    elapsedText: fmtDuration(elapsed),
    perEpochSec: Number(perEpoch.toFixed(1)),
    remainText: fmtDuration(remain),
    columns: parsed.columns,
    chart: chartColumns(parsed.columns),
    rows: downsample(rows, 400),
    lastRow: last,
    mem,
    runs: brief,
    active: running,
    failure: running ? null : lastFailure,
  };
}

// 纯函数导出给测试与将来的复用：`dumpConfig` ↔ `parseSimpleYaml` 必须能原样往返
// （真正读它的是 Python 的 yaml.safe_load，格式写错的后果是"参数没生效"这种不报错的错）；
// 参数表也必须是纯映射：喂给它一份"少一个键"的探测结果，它就得少渲染一项（详设 §10 判据 2）。
export {
  activate,
  buildEnvCommands,
  buildParamSpec,
  chartColumns,
  classifyFailure,
  coerceTrain,
  datasetWarning,
  downsample,
  diffArgs,
  dumpConfig,
  EXPORT_FORMATS,
  exportAdvice,
  FAILURE_KINDS,
  fmtDuration,
  inferWeights,
  labelShape,
  MODEL_FAMILIES,
  officialModels,
  parseLabelFile,
  parseResultsCsv,
  parseSimpleYaml,
  PARAM_HELP,
  PARAM_META,
  readDataYaml,
  recommendEnvProfile,
  resumeGuard,
  taskMismatch,
  // 只给测试：下载器要对着本地假服务验续传/重定向，没有导出口就没法在进程内测
  httpsDownload,
};
