/**
 * YOLO 训练工作台 · 插件侧（uartix.yolo）
 *
 * ## 它是什么
 *
 * 把工作区里**已经跑通过**的那套脚本（`scripts/build_dataset.py` / `train.py`）包成一个面板：
 * 参数在面板里改，插件生成一份「本次运行」的 config.yaml，起 python 子进程，把 stdout 逐行
 * 解析成进度与日志推给界面。
 *
 * ## 三个刻意的决定
 *
 * 1. **不重新实现训练**。工作区里那套脚本跑出过 mAP50 = 0.995，重写等于用新 bug 换旧逻辑。
 *    插件只做三件它们不做的事：参数集中、进度可视化、失败能看见原因。
 *
 * 2. **不覆盖工作区的 config.yaml**。那份文件是用户自己的唯一真相（README 第 13 行写着
 *    "唯一需要修改的文件"）。插件把合并结果写到 `.uartix/yolo/runs/<jobId>/config.yaml`，
 *    原文件只读。想恢复默认就删 `.uartix/yolo/config.json`。
 *
 * 3. **进度只解析脚本真的会打印的东西**。`build_dataset.py` 的 `[信息] 合计 N 个样本`、
 *    `[信息] 划分完成: 训练集 X 张 / 验证集 Y 张`，以及 ultralytics 的 `  12/300  ...` 行。
 *    不去猜"大概到哪了"——猜出来的进度条比没有更糟。
 *
 * ## 关于权限边界（写给后来的人）
 *
 * 本插件起的 python 子进程**不受** `--allow-fs-write` 约束：Node 的权限模型不传递给子进程。
 * 所以这条链上"写是牢笼"只对插件自己的 `ctx.fs` 成立，子进程那一段是**知情**（批准卡上写着
 * "运行 python"）。这一点在 P174 详设 §10 里就是明写的，别在这里偷偷加一层假护栏。
 */

import fs from "node:fs";
import path from "node:path";

const PANEL = "train";
/** 插件自己的状态目录（相对工作区）。只放本次运行的配置与快照。 */
const STATE_DIR = ".uartix/yolo";
/** 每个 job 一个目录：`config.yaml` + 可选产物。 */
const JOBS_DIR = `${STATE_DIR}/runs`;
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
};

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
      "import json,sys,yaml;json.dump(yaml.safe_load(open(sys.argv[1],encoding='utf-8')) or {},sys.stdout,ensure_ascii=False)";
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

function dumpConfig(c) {
  const L = [];
  const kv = (k, v, ind) => {
    const pad = " ".repeat(ind);
    if (typeof v === "boolean") L.push(`${pad}${k}: ${v ? "true" : "false"}`);
    else if (typeof v === "number" && Number.isFinite(v)) L.push(`${pad}${k}: ${v}`);
    else L.push(`${pad}${k}: ${yq(v)}`);
  };
  const list = (k, arr, ind) => {
    const pad = " ".repeat(ind);
    if (!arr || !arr.length) {
      L.push(`${pad}${k}: []`);
      return;
    }
    L.push(`${pad}${k}:`);
    for (const it of arr) L.push(`${pad}  - ${yq(it)}`);
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
  L.push("  label_map: {}");

  L.push("train:");
  const t = c.train;
  kv("weights", t.weights, 2);
  kv("epochs", Number(t.epochs), 2);
  kv("imgsz", Number(t.imgsz), 2);
  kv("batch", Number(t.batch), 2);
  kv("workers", Number(t.workers), 2);
  kv("patience", Number(t.patience), 2);
  kv("device", String(t.device), 2);
  kv("name", t.name, 2);
  kv("project", t.project, 2);
  kv("optimizer", t.optimizer, 2);
  kv("cos_lr", !!t.cos_lr, 2);
  kv("close_mosaic", Number(t.close_mosaic), 2);
  kv("degrees", Number(t.degrees), 2);
  kv("fliplr", Number(t.fliplr), 2);
  kv("flipud", Number(t.flipud), 2);
  kv("copy_paste", Number(t.copy_paste), 2);
  kv("mixup", Number(t.mixup), 2);
  kv("cache", t.cache, 2);
  kv("seed", Number(t.seed), 2);
  kv("save_period", Number(t.save_period), 2);
  return L.join("\n") + "\n";
}

/* ============================ job ============================ */

function newJob(kind, label) {
  const id = `j${++seq}-${Date.now().toString(36)}`;
  const dir = abs(`${JOBS_DIR}/${id}`);
  fs.mkdirSync(dir, { recursive: true });
  fs.mkdirSync(abs("logs"), { recursive: true }); // 日志落 `$WS/logs/`（和用户既有习惯一致）
  return {
    id,
    kind,
    label,
    dir,
    state: "running",
    startedAt: Date.now(),
    endedAt: 0,
    code: null,
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
  if (j.state === "failed" && j.progress.phase !== "error") {
    j.progress.phase = "error";
    j.progress.detail = `进程退出码 ${code}（往上翻日志看最后一行 [错误]）`;
  }
  flushLog();
  pushLine(j, `[工作台] 进程结束，退出码 ${code}`, "sys");
  if (active === j) active = null;
}

/** 起一个 job：写本次运行的 config.yaml → spawn → 逐行喂给 pushLine。 */
async function startJob(kind, overrides) {
  needWorkspace();
  if (active) throw new Error(`已经有一个任务在跑（${active.label}）：先停掉它再开始新的`);
  const { effective } = await effectiveConfig();
  const merged = merge(effective, overrides || {});
  merged.dataset.output_dir = abs(merged.dataset.output_dir);
  merged.train.project = abs(merged.train.project);

  const py = await detectPython();
  if (!py.ok) throw new Error(`找不到可用的 python（试过 ${py.source}：${py.path}）：${py.error}`);

  const label = kind === "dataset" ? "构建数据集" : `训练 ${merged.train.name}`;
  const job = newJob(kind, label);

  const confPath = path.join(job.dir, "config.yaml");
  fs.writeFileSync(confPath, dumpConfig(merged), "utf8");

  const script = abs(kind === "dataset" ? "scripts/build_dataset.py" : "scripts/train.py");
  if (!fs.existsSync(script)) throw new Error(`工作区里没有 ${script}：这个面板要配合 YOLO-Workspace 的 scripts/ 使用`);

  job.configPath = confPath;
  jobs.set(job.id, job);
  active = job;

  pushLine(job, `[工作台] python: ${py.path}（${py.source}）`, "sys");
  pushLine(job, `[工作台] 配置: ${confPath}`, "sys");
  pushLine(job, `[工作台] 命令: "${py.path}" "${script}" --config "${confPath}"`, "sys");

  try {
    const child = ctx.process.spawn({
      cmd: py.path,
      args: [script, "--config", confPath],
      cwd: root,
      env: {
        PYTHONIOENCODING: "utf-8",
        PYTHONUTF8: "1",
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
  };
}

/** 工作区里最新的 `runs/<run>/weights/best.pt`（按 mtime）。 */
function latestBest() {
  const runs = scanRuns("runs").map((r) => {
    const bp = path.join(root, "runs", r.name, "weights", "best.pt");
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
function deliverBest(modelName) {
  const best = latestBest();
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
 */
function writeWrapper(cfgName, modelPath, modelName) {
  const dir = path.join(root, STATE_DIR, "deploy");
  fs.mkdirSync(dir, { recursive: true });
  const tool = scanDeployTool();
  const src = path.join(tool.dir, cfgName).replace(/\\/g, "/");
  const out = path.join(dir, `auto-${String(modelName || "model").replace(/[^\w.-]+/g, "-")}.ps1`);
  const ps = (v) => `"${String(v).replace(/"/g, '`"')}"`;
  const text = [
    "# 由 uartix.yolo 生成：不要手改（每次部署会覆盖）",
    "# 先读用户那份配置（只读），再覆盖下面两行",
    `. ${ps(src)}`,
    "",
    `$ModelName = ${ps(modelName)}`,
    `$Model     = ${ps(modelPath)}`,
    "",
  ].join("\n");
  fs.writeFileSync(out, text, "utf8");
  return out;
}

/** 部署状态的快照（面板「部署」页一次拿全）。 */
function deployState() {
  const tool = scanDeployTool();
  const configs = (tool.configs || []).map((c) => readDeployConfig(c));
  const best = latestBest();
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
    jobs: [...jobs.values()].filter((j) => j.kind === "deploy").slice(-4).map(snapshot),
    active: active && active.kind === "deploy" ? snapshot(active) : null,
  };
}

/**
 * 起一次部署。
 *
 * `step` 与工具自己的 `-Step` 一一对应：`validate`（只检查、不动文件）/`all`/
 * `convert`（从已有 onnx 直接编译）/`package`（只重新打包）。
 */
async function deployStart(cfgName, step, opts) {
  needWorkspace();
  if (active) throw new Error(`已经有一个任务在跑（${active.label}）：先停掉它再开始新的`);
  const tool = scanDeployTool();
  if (!tool.bound) throw new Error("还没绑外部目录 deploy：去「插件」面板顶部绑一次");
  if (!tool.ready) throw new Error(`部署工具不完整：${tool.dir} 里缺 run.bat 或 deploy_config*.ps1`);
  const cfg = readDeployConfig(cfgName);
  if (!cfg.ok) throw new Error(cfg.error);

  const ps1 = path.join(tool.dir, "deploy.ps1");
  if (!fs.existsSync(ps1)) throw new Error(`部署工具里没有 deploy.ps1：${tool.dir}`);

  // 交付最新产物（除非用户明确说不）——"把哪个模型部署出去"必须显式，不能靠猜
  let modelPath = cfg.model;
  let delivered = null;
  if (opts && opts.deliver !== false) {
    const d = deliverBest(cfg.modelName || path.basename(cfg.name, ".ps1"));
    if (!d.ok) throw new Error(d.error);
    modelPath = d.path;
    delivered = d;
  }
  const wrapper = writeWrapper(cfg.name, modelPath, cfg.modelName || "model");

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
  job.progress.phase = step === "validate" ? "check" : "prepare";
  job.progress.detail = step === "validate" ? "只检查环境，不动任何文件" : "准备 ONNX";
  emitJob(job);

  try {
    const child = ctx.process.spawn({
      cmd: "powershell",
      args: ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", ps1, "-Config", wrapper, "-Step", step],
      cwd: tool.dir,
      env: { PYTHONIOENCODING: "utf-8", PYTHONUTF8: "1" },
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
      dataset: { dir: "", dataYaml: "", exists: false, trainCount: 0, valCount: 0, classes: [] },
      deploy: scanDeployTool(),
      runs: [],
      jobs: [],
      active: null,
    };
  }
  const cfg = await effectiveConfig();
  const py = await detectPython();
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
    dataset: scanDataset(cfg.effective.dataset.output_dir),
    deploy: scanDeployTool(),
    runs: scanRuns(cfg.effective.train.project).slice(0, 12),
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
      if (!isObj(patch)) throw new Error("patch 必须是对象");
      const cur = readOverrides();
      const next = merge(cur, patch);
      fs.mkdirSync(path.dirname(overridesPath()), { recursive: true });
      fs.writeFileSync(overridesPath(), JSON.stringify(next, null, 2), "utf8");
      baseCache = { mtime: 0, value: null, error: "", source: "" }; // 让下次 state() 重算
      return await panelState();
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

    /* ---- 部署（$EXT:deploy）---- */
    async deployState() {
      return deployState();
    },

    /** `step`：validate / all / convert / package；`opts.deliver=false` 直接用配置里那个模型。 */
    async deployStart(cfgName, step, opts) {
      return await deployStart(cfgName, String(step || "all"), opts || {});
    },

    /** 只交付模型、不部署（"先把产物留一份"也是常见动作）。 */
    async deployDeliver(modelName) {
      const r = deliverBest(modelName);
      if (!r.ok) throw new Error(r.error);
      return { ...r, state: deployState() };
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
        "print(json.dumps(o,ensure_ascii=False))\n";
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

// `dumpConfig` / `parseSimpleYaml` 是纯函数（不碰 ctx），导出给测试与将来的复用：
// 它们之间必须能往返——本插件生成的 config.yaml，用它自己的解析器读回来必须一模一样。
export { activate, dumpConfig, fmtDuration, parseSimpleYaml };
