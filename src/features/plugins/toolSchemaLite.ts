/**
 * P99a-B2：插件注册工具用的 **JSON-Schema-lite**（详设 §5.3-1）。
 *
 * 为什么要有这张白名单，而不是"随便一个 schema 都行"：
 * 1. 今天 `additionalProperties:false` 在宿主这边**纯属装饰**——派发链只有一次 `JSON.parse`，
 *    没有任何东西在校验参数。插件工具的作者会拿到模型发出的任意形状参数。
 * 2. schema 文本本身要进每一轮请求：一条嵌套千层、或 `properties` 里塞 1 MiB 的 schema，
 *    就是不用出网也能把上下文与 CPU 打爆的信道。所以**体积、深度、关键字集合**都得有界。
 * 3. 校验器只认它能实现的子集。认了一个实现不了的关键字 = 对插件作者假装生效（§8-37）。
 *
 * 因此这里只允许：`type / properties / items / enum / required / description / additionalProperties`，
 * 且对象层必须 `additionalProperties:false`、数组必须有 `items`。深度 ≤4、体积 ≤4 KiB。
 */

export const MAX_SCHEMA_BYTES = 4096;
export const MAX_SCHEMA_DEPTH = 4;
export const MAX_ARGS_BYTES = 8192;
export const MAX_ENUM_ITEMS = 64;
/** 允许的根类型；`null` 单独不作为参数类型（参数是个对象）。 */
export const LITE_TYPES = ["object", "array", "string", "number", "integer", "boolean"] as const;
const ALLOWED_KEYS = new Set([
  "type",
  "properties",
  "items",
  "enum",
  "required",
  "description",
  "additionalProperties",
]);

function isPlain(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

export interface SchemaCheck {
  ok: boolean;
  errors: string[];
  bytes: number;
}

/** 校验（并规范化）一份插件自报的参数 schema。返回的 errors 直接回给插件侧。 */
export function validateLiteSchema(raw: unknown): SchemaCheck {
  const bytes = (() => {
    try {
      return JSON.stringify(raw ?? null).length;
    } catch {
      return Number.POSITIVE_INFINITY;
    }
  })();
  const errors: string[] = [];
  if (bytes > MAX_SCHEMA_BYTES) {
    return { ok: false, errors: [`schema 体积 ${bytes} 字节，超过 ${MAX_SCHEMA_BYTES} 上限`], bytes };
  }
  if (!isPlain(raw)) return { ok: false, errors: ["schema 必须是对象"], bytes };
  if (raw.type !== "object") return { ok: false, errors: ['根节点 type 必须是 "object"（工具参数是对象）'], bytes };

  const walk = (node: unknown, path: string, depth: number): void => {
    if (errors.length > 12) return; // 一次别回一屏幕，前 12 条足够定位
    if (!isPlain(node)) {
      errors.push(`${path} 必须是 schema 对象`);
      return;
    }
    if (depth > MAX_SCHEMA_DEPTH) {
      errors.push(`${path} 深度超过 ${MAX_SCHEMA_DEPTH} 层`);
      return;
    }
    for (const k of Object.keys(node)) {
      if (!ALLOWED_KEYS.has(k)) errors.push(`${path} 用了不支持的关键字「${k}」（只允许 ${[...ALLOWED_KEYS].join("/")}）`);
    }
    const t = node.type;
    if (typeof t !== "string" || !(LITE_TYPES as readonly string[]).includes(t)) {
      errors.push(`${path}.type 必须是 ${LITE_TYPES.join("/")}`);
      return;
    }
    if (node.description !== undefined && typeof node.description !== "string") {
      errors.push(`${path}.description 必须是字符串`);
    }
    if (t === "object") {
      if (node.additionalProperties !== false) {
        errors.push(`${path} 必须写 additionalProperties:false（不封口的对象＝任意体积的参数信道）`);
      }
      const props = node.properties;
      if (!isPlain(props)) {
        errors.push(`${path}.properties 必须是对象`);
        return;
      }
      const names = Object.keys(props);
      if (names.length > 32) errors.push(`${path}.properties 超过 32 个字段`);
      for (const n of names) walk(props[n], `${path}.properties.${n}`, depth + 1);
      if (node.required !== undefined) {
        if (!Array.isArray(node.required) || node.required.some((r) => typeof r !== "string")) {
          errors.push(`${path}.required 必须是字符串数组`);
        } else {
          for (const r of node.required) if (!(r in props)) errors.push(`${path}.required 引用了不存在的字段：${r}`);
        }
      }
    } else if (t === "array") {
      if (node.items === undefined) errors.push(`${path}.items 必填（没有元素类型的数组＝无界）`);
      else walk(node.items, `${path}.items`, depth + 1);
    } else if (node.enum !== undefined) {
      if (!Array.isArray(node.enum) || node.enum.length === 0 || node.enum.length > MAX_ENUM_ITEMS) {
        errors.push(`${path}.enum 必须是 1..${MAX_ENUM_ITEMS} 个的数组`);
      } else if (node.enum.some((v) => v !== null && typeof v === "object")) {
        errors.push(`${path}.enum 只能是字面量`);
      }
    }
  };
  walk(raw, "$", 1);
  return { ok: errors.length === 0, errors, bytes };
}

/** 按 lite schema 校验一份实参。宿主侧在把参数转给 worker **之前**调用。 */
export function validateLiteArgs(schema: unknown, value: unknown): { ok: boolean; errors: string[] } {
  const errors: string[] = [];
  const check = (node: unknown, v: unknown, path: string): void => {
    if (errors.length > 8 || !isPlain(node)) return;
    const t = node.type;
    if (t === "object") {
      if (!isPlain(v)) {
        errors.push(`${path} 必须是对象`);
        return;
      }
      const props = (isPlain(node.properties) ? node.properties : {}) as Record<string, unknown>;
      for (const req of Array.isArray(node.required) ? node.required : []) {
        if (typeof req === "string" && !(req in v)) errors.push(`${path}.${req} 缺少必填字段`);
      }
      for (const k of Object.keys(v)) {
        if (!(k in props)) errors.push(`${path}.${k} 不在参数表里（additionalProperties:false）`);
        else check(props[k], v[k], `${path}.${k}`);
      }
      return;
    }
    if (t === "array") {
      if (!Array.isArray(v)) {
        errors.push(`${path} 必须是数组`);
        return;
      }
      for (let i = 0; i < v.length; i++) check(node.items, v[i], `${path}[${i}]`);
      return;
    }
    if (t === "string" && typeof v !== "string") return void errors.push(`${path} 必须是字符串`);
    if (t === "boolean" && typeof v !== "boolean") return void errors.push(`${path} 必须是布尔`);
    if (t === "number" && typeof v !== "number") return void errors.push(`${path} 必须是数字`);
    if (t === "integer" && !(typeof v === "number" && Number.isInteger(v))) {
      return void errors.push(`${path} 必须是整数`);
    }
    if (Array.isArray(node.enum) && !node.enum.some((e) => e === v)) {
      errors.push(`${path} 必须是 ${node.enum.map((e) => JSON.stringify(e)).join("/")} 之一`);
    }
  };
  check(schema, value, "$");
  return { ok: errors.length === 0, errors };
}
