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
async function detectPython() {
  const over = readOverrides();
  const forced = over && over.env && over.env.python;
  if (forced) {
    const r = await probePython(String(forced), "config.env.python");
    pyCache = r;
    return r;
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
  const job = newJob(kind, label);
  if (kind === "dataset") {
    // 没显式写 sources 就从投料口自动取——用户裁定的那条"分离数据集直接读这个文件夹"
    const resolved = resolveDatasetSources(merged);
    merged.dataset.sources = resolved.sources;
    job.sourcesFrom = resolved.from;
  }

  const confPath = snapshotPathFor(kind, kind === "train" ? merged.train.name : path.basename(merged.dataset.output_dir || "ds"), job.startedAt);
  fs.writeFileSync(confPath, dumpConfig(merged), "utf8");

  job.configPath = confPath;
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
  const stem = String(modelName || best.run || "model").replace(/[^\w.-]+/g, "-");
  const dst = path.join(dstDir, `${stem}-best.pt`);
  fs.copyFileSync(best.path, dst);
  return { ok: true, path: dst, from: best.path, run: best.run, bytes: fs.statSync(dst).size };
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
  fs.writeFileSync(out, text, "utf8");
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
    current: {
      weights: String((effective.train && effective.train.weights) || "").replace(/\\/g, "/"),
      data: path.join(abs(effective.dataset.output_dir || ""), "data.yaml").replace(/\\/g, "/"),
    },
  };
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
    configs,
    latest: best ? { path: best.path, run: best.run, at: best.at } : null,
    delivered,
    candidates: deployCandidates(effective.train.project),
    calib: calibCandidates(),
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
  } else if (cfg.calib) {
    pushLine(job, `[工作台] 校准图仍用配置里的 ${cfg.calib}（当前数据集没有 images/train，没法替你换）`, "sys");
  }
  job.progress.phase = step === "validate" ? "check" : "prepare";
  job.progress.detail = step === "validate" ? "只检查环境，不动任何文件" : "准备 ONNX";
  emitJob(job);

  try {
    const child = ctx.process.spawn({
      cmd: "powershell",
      args: ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", ps1, "-Config", wrapper, "-Step", step],
      cwd: tool.dir,
      env: { ...PY_ENV, },
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

    /** 归档：复制 args/results/best 到 `archive/<run>-<时间>/`。**只复制，不搬走**。 */
    async archiveRun(req) {
      needWorkspace();
      const o = isObj(req) ? req : {};
      const { effective } = await effectiveConfig();
      return archiveRun(effective.train.project, String(o.run || ""));
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

    async deployState() {
      return await deployState();
    },

    /** 一个对象参数：`{ cfgName, step, deliver }`（桥只转发一个载荷，位置参数拿不到）。 */
    async deployStart(req) {
      return await deployStart(req);
    },

    /** 只交付模型、不部署（"先把产物留一份"也是常见动作）。 */
    async deployDeliver(modelName) {
      const r = deliverBest(modelName);
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
  for (const split of ["train", "val"]) {
    const imgDir = path.join(dir, "images", split);
    const lblDir = path.join(dir, "labels", split);
    const imgs = listSiblings(imgDir, ".jpg").concat(listSiblings(imgDir, ".png") || [], listSiblings(imgDir, ".jpeg") || []);
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

  if (r.dataYaml.exists && r.dataYaml.nc != null && r.maxClassId >= r.dataYaml.nc) {
    r.findings.push({ level: "bad", key: "ncMismatch", text: `标签里出现了类别 id ${r.maxClassId}，而 data.yaml 的 nc 只有 ${r.dataYaml.nc}：引擎会直接拒或错位训练。` });
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
    return { name, dir: dir.replace(/\\/g, "/"), columns: parsed.columns, chart: chartColumns(parsed.columns), rows: downsample(parsed.rows, 140), args: readRunArgs(dir) };
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
  const noteFile = abs(`train_runs/${String(name).replace(/[^\w.-]+/g, "-")}.note`);
  let note = "";
  try {
    note = fs.readFileSync(noteFile, "utf8").trim();
  } catch {
    /* 还没写过备注 */
  }
  return {
    name,
    dir: dir.replace(/\\/g, "/"),
    task: String(args.task || ""),
    model: String(args.model || ""),
    imgsz: args.imgsz == null ? "" : String(args.imgsz),
    epochs: rows.length,
    bestEpoch: rows.length,
    hasBest,
    best: hasBest ? best.replace(/\\/g, "/") : "",
    bestBytes,
    hasLast: fs.existsSync(last),
    last: fs.existsSync(last) ? last.replace(/\\/g, "/") : "",
    mAP50: lastRow["metrics/mAP50(B)"] ?? "",
    mAP5095: lastRow["metrics/mAP50-95(B)"] ?? "",
    mAP50M: lastRow["metrics/mAP50(M)"] ?? "",
    durationText: fmtDuration(Number(lastRow.time) || 0),
    note,
    noteFile,
    argsFile: path.join(dir, "args.yaml").replace(/\\/g, "/"),
    argsKeys: Object.keys(args).length,
  };
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
 * 归档：把 `args.yaml + results.csv + best.pt` **复制**进 `archive/<run>-<时间>/`。
 *
 * 设计稿写的是"移"。这里刻意改成复制：搬走会让 `runs/` 里的历史断档，
 * 而那个目录是用户自己会去看的——断档的代价比多占一点磁盘大得多。
 */
function archiveRun(project, name) {
  const run = runProfile(project, name);
  if (!run.dir || !fs.existsSync(run.dir)) throw new Error(`没有这个 run：${name}`);
  const stamp = new Date().toISOString().replace(/[-:TZ.]/g, "").slice(0, 14);
  const dst = abs(`archive/${String(name).replace(/[^\w.-]+/g, "-")}-${stamp}`);
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
    rows: downsample(rows, 140),
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
  PARAM_META,
  readDataYaml,
  resumeGuard,
  taskMismatch,
};
