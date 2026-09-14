/**
 * P74 编排器表达式沙箱（expr.ts）。
 *
 * 红线：不 eval、不 new Function、无循环语法、无 IO；**函数仅白名单纯函数**
 * （B4b：FUNCS 表封闭集合，未知函数语法期即拒绝；if 为惰性求值）。
 * 手写递归下降解析 + 求值，三重保护：
 * - 解析深度帽 exprDepthMax（防栈溢出）
 * - 求值节点访问帽 exprNodeCap（防病态表达式）
 * - 求值 deadline exprDeadlineMs（防超长表达式卡主线程）
 *
 * 语法（JS 风格子集）：
 *   or:   a || b        and: a && b       not: !a
 *   cmp:  == != > < >= <=
 *   add:  + -           mul:  * / %       unary: - !
 *   字面量: 数字 / '串' "串" / true / false
 *   标识符: 变量查 scope.get()（未声明即抛错，绝不静默当 0）
 *   成员:  evt.xxx（只读事件上下文，根只允许 evt）
 *   函数:  abs(x) min(a,b…) max(a,b…) round(x,d?) floor(x) ceil(x)
 *          clamp(x,lo,hi) if(c,a,b?) len(s) fmt(x,d?)
 *          —— if 惰性：只求值被选中的分支；未提供 b 时等价 false
 *   + 语义：任一侧为字符串 → 字符串拼接；否则数值加
 */
import { ORCH_LIMITS, type EvtCtx } from "./types";

export type ExprVal = number | string | boolean;

export interface ExprScope {
  /** 变量查表；undefined = 未声明（抛错） */
  get(name: string): ExprVal | undefined;
  /** 事件上下文（只读） */
  evt: EvtCtx;
}

export class ExprError extends Error {}

/* ================= 词法 ================= */

type Tok =
  | { t: "num"; v: number }
  | { t: "str"; v: string }
  | { t: "ident"; v: string }
  | { t: "op"; v: string };

const IDENT_START = /[A-Za-z_$\u4e00-\u9fa5]/;
const IDENT_PART = /[A-Za-z0-9_$\u4e00-\u9fa5]/;

function tokenize(src: string): Tok[] {
  const out: Tok[] = [];
  let i = 0;
  while (i < src.length) {
    const c = src[i];
    if (/\s/.test(c)) {
      i++;
      continue;
    }
    // 数字（含 .5 / 1e-3）
    if (/[0-9]/.test(c) || (c === "." && /[0-9]/.test(src[i + 1] ?? ""))) {
      const m = /^\d*\.?\d+(?:[eE][+-]?\d+)?/.exec(src.slice(i));
      if (!m) throw new ExprError(`非法数字（位置 ${i}）`);
      out.push({ t: "num", v: Number(m[0]) });
      i += m[0].length;
      continue;
    }
    // 字符串（不解析转义——编排表达式场景不需要，避免语义争议）
    if (c === "'" || c === '"') {
      const end = src.indexOf(c, i + 1);
      if (end < 0) throw new ExprError("字符串未闭合");
      out.push({ t: "str", v: src.slice(i + 1, end) });
      i = end + 1;
      continue;
    }
    if (IDENT_START.test(c)) {
      let j = i + 1;
      while (j < src.length && IDENT_PART.test(src[j])) j++;
      out.push({ t: "ident", v: src.slice(i, j) });
      i = j;
      continue;
    }
    const two = src.slice(i, i + 2);
    if (two === "==" || two === "!=" || two === ">=" || two === "<=" || two === "&&" || two === "||") {
      out.push({ t: "op", v: two });
      i += 2;
      continue;
    }
    if ("+-*/%()><!.".includes(c) || c === ",") {
      out.push({ t: "op", v: c });
      i++;
      continue;
    }
    throw new ExprError(`无法识别的字符 "${c}"（位置 ${i}）`);
  }
  return out;
}

/* ================= 语法树 ================= */

type Node =
  | { t: "num" | "str" | "bool"; v: ExprVal }
  | { t: "var"; name: string }
  | { t: "evt"; path: string[] }
  | { t: "un"; op: "!" | "-"; a: Node }
  | { t: "bin"; op: string; a: Node; b: Node }
  | { t: "call"; name: string; args: Node[] };

/* ================= B4b：白名单纯函数表 =================
 * 封闭集合：语法期未知函数直接拒绝；全部无副作用、不读 scope 之外任何东西。
 * if 不在此表求值——需要惰性（只算被选中的分支），在求值器特判。 */
interface FuncDef {
  min: number;
  max: number;
  /** 参数已全部求值后调用；数值参数由 numArg 收窄并给出可读报错 */
  call: (args: ExprVal[]) => ExprVal;
}

const numArg = (fn: string, v: ExprVal): number => {
  const n = toNum(v);
  if (Number.isNaN(n)) throw new ExprError(`函数 ${fn} 的参数需要是数值（收到 "${v}"）`);
  return n;
};

const FUNCS: Record<string, FuncDef> = {
  abs: { min: 1, max: 1, call: (a) => Math.abs(numArg("abs", a[0])) },
  floor: { min: 1, max: 1, call: (a) => Math.floor(numArg("floor", a[0])) },
  ceil: { min: 1, max: 1, call: (a) => Math.ceil(numArg("ceil", a[0])) },
  round: {
    min: 1,
    max: 2,
    call: (a) => {
      const x = numArg("round", a[0]);
      const d = a[1] === undefined ? 0 : Math.min(8, Math.max(0, Math.trunc(numArg("round", a[1]))));
      const f = 10 ** d;
      return Math.round(x * f) / f;
    },
  },
  min: {
    min: 1,
    max: 8,
    call: (a) => Math.min(...a.map((v) => numArg("min", v))),
  },
  max: {
    min: 1,
    max: 8,
    call: (a) => Math.max(...a.map((v) => numArg("max", v))),
  },
  clamp: {
    min: 3,
    max: 3,
    call: (a) => {
      const [x, lo, hi] = a.map((v) => numArg("clamp", v));
      return Math.min(hi, Math.max(lo, x));
    },
  },
  if: {
    // 语法表占位（arg 个数校验用）；求值走惰性特判
    min: 2,
    max: 3,
    call: () => {
      throw new ExprError("内部错误：if 应走惰性求值");
    },
  },
  len: {
    min: 1,
    max: 1,
    call: (a) => {
      if (typeof a[0] !== "string") throw new ExprError("函数 len 的参数需要是字符串");
      return a[0].length;
    },
  },
  fmt: {
    min: 1,
    max: 2,
    call: (a) => {
      const x = numArg("fmt", a[0]);
      if (a[1] === undefined) return String(x);
      const d = Math.min(8, Math.max(0, Math.trunc(numArg("fmt", a[1]))));
      return x.toFixed(d);
    },
  },
};

const FUNC_NAMES = Object.keys(FUNCS).join("/");

class Parser {
  private pos = 0;
  private depth = 0;
  constructor(private toks: Tok[]) {}

  private peek(): Tok | null {
    return this.toks[this.pos] ?? null;
  }
  private eat(op: string): boolean {
    const t = this.peek();
    if (t && t.t === "op" && t.v === op) {
      this.pos++;
      return true;
    }
    return false;
  }
  private expectOp(op: string) {
    if (!this.eat(op)) throw new ExprError(`缺少 "${op}"`);
  }

  parse(): Node {
    if (this.toks.length === 0) throw new ExprError("空表达式");
    const n = this.parseOr();
    if (this.pos < this.toks.length) throw new ExprError("表达式末尾有多余内容");
    return n;
  }

  private enter() {
    if (++this.depth > ORCH_LIMITS.exprDepthMax) throw new ExprError("表达式嵌套过深");
  }
  private leave() {
    this.depth--;
  }

  private parseOr(): Node {
    this.enter();
    try {
      let a = this.parseAnd();
      while (this.eat("||")) a = { t: "bin", op: "||", a, b: this.parseAnd() };
      return a;
    } finally {
      this.leave();
    }
  }
  private parseAnd(): Node {
    this.enter();
    try {
      let a = this.parseNot();
      while (this.eat("&&")) a = { t: "bin", op: "&&", a, b: this.parseNot() };
      return a;
    } finally {
      this.leave();
    }
  }
  private parseNot(): Node {
    if (this.eat("!")) return { t: "un", op: "!", a: this.parseNot() };
    return this.parseCmp();
  }
  private parseCmp(): Node {
    const a = this.parseAdd();
    const t = this.peek();
    if (t && t.t === "op" && ["==", "!=", ">", "<", ">=", "<="].includes(t.v)) {
      this.pos++;
      return { t: "bin", op: t.v, a, b: this.parseAdd() };
    }
    return a;
  }
  private parseAdd(): Node {
    this.enter();
    try {
      let a = this.parseMul();
      for (;;) {
        if (this.eat("+")) a = { t: "bin", op: "+", a, b: this.parseMul() };
        else if (this.eat("-")) a = { t: "bin", op: "-", a, b: this.parseMul() };
        else return a;
      }
    } finally {
      this.leave();
    }
  }
  private parseMul(): Node {
    this.enter();
    try {
      let a = this.parseUnary();
      for (;;) {
        if (this.eat("*")) a = { t: "bin", op: "*", a, b: this.parseUnary() };
        else if (this.eat("/")) a = { t: "bin", op: "/", a, b: this.parseUnary() };
        else if (this.eat("%")) a = { t: "bin", op: "%", a, b: this.parseUnary() };
        else return a;
      }
    } finally {
      this.leave();
    }
  }
  private parseUnary(): Node {
    if (this.eat("-")) return { t: "un", op: "-", a: this.parseUnary() };
    return this.parsePrimary();
  }
  private parsePrimary(): Node {
    const t = this.peek();
    if (!t) throw new ExprError("表达式意外结束");
    if (t.t === "num") {
      this.pos++;
      return { t: "num", v: t.v };
    }
    if (t.t === "str") {
      this.pos++;
      return { t: "str", v: t.v };
    }
    if (t.t === "ident") {
      this.pos++;
      if (t.v === "true") return { t: "bool", v: true };
      if (t.v === "false") return { t: "bool", v: false };
      // B4b：函数调用语法 ident "(" args ")"（仅白名单；未知函数带可用清单报错）
      if (this.peek()?.t === "op" && (this.peek() as { v: string }).v === "(") {
        const def = FUNCS[t.v];
        if (!def) throw new ExprError(`未知函数 "${t.v}"（可用：${FUNC_NAMES}）`);
        this.pos++; // 吃掉 "("
        const args: Node[] = [];
        if (!this.eat(")")) {
          do {
            args.push(this.parseOr());
          } while (this.eat(","));
          this.expectOp(")");
        }
        if (args.length < def.min || args.length > def.max) {
          const ar = def.min === def.max ? `${def.min} 个` : `${def.min}~${def.max} 个`;
          throw new ExprError(`函数 ${t.v} 需要 ${ar}参数（收到 ${args.length} 个）`);
        }
        return { t: "call", name: t.v, args };
      }
      if (t.v === "evt") {
        const path: string[] = [];
        while (this.eat(".")) {
          const p = this.peek();
          if (!p || p.t !== "ident") throw new ExprError("evt 后需要字段名");
          this.pos++;
          path.push(p.v);
        }
        return { t: "evt", path };
      }
      return { t: "var", name: t.v };
    }
    if (this.eat("(")) {
      this.enter();
      try {
        const n = this.parseOr();
        this.expectOp(")");
        return n;
      } finally {
        this.leave();
      }
    }
    throw new ExprError(`意外的记号 "${(t as { v: string }).v}"`);
  }
}

/* ================= 求值 ================= */

const truthy = (v: ExprVal): boolean => (typeof v === "string" ? v.length > 0 : Boolean(v));

const toNum = (v: ExprVal): number =>
  typeof v === "number" ? v : typeof v === "boolean" ? (v ? 1 : 0) : Number(v);

function eqVal(a: ExprVal, b: ExprVal): boolean {
  if (typeof a === typeof b) return a === b;
  const na = toNum(a);
  const nb = toNum(b);
  return !Number.isNaN(na) && !Number.isNaN(nb) && na === nb;
}

function cmpVal(a: ExprVal, op: string, b: ExprVal): boolean {
  switch (op) {
    case "==":
      return eqVal(a, b);
    case "!=":
      return !eqVal(a, b);
  }
  // 顺序比较：字符串对字符串走字典序，其余转数字
  if (typeof a === "string" && typeof b === "string") {
    switch (op) {
      case ">": return a > b;
      case "<": return a < b;
      case ">=": return a >= b;
      default: return a <= b;
    }
  }
  const na = toNum(a);
  const nb = toNum(b);
  if (Number.isNaN(na) || Number.isNaN(nb)) return false;
  switch (op) {
    case ">": return na > nb;
    case "<": return na < nb;
    case ">=": return na >= nb;
    default: return na <= nb;
  }
}

/**
 * 求值入口。任何错误（语法/未知变量/deadline/节点帽）抛 ExprError，
 * 由调用方（条件求值）转为「条件不成立 + 日志」，绝不静默放行。
 */
export function evalExpr(src: string, scope: ExprScope, deadlineMs: number = ORCH_LIMITS.exprDeadlineMs): ExprVal {
  const ast = new Parser(tokenize(src)).parse();
  const t0 = Date.now();
  let visits = 0;

  const ev = (n: Node): ExprVal => {
    if (++visits > ORCH_LIMITS.exprNodeCap) throw new ExprError("表达式过于复杂");
    if ((visits & 255) === 0 && Date.now() - t0 > deadlineMs) throw new ExprError("表达式求值超时");
    switch (n.t) {
      case "num":
      case "str":
      case "bool":
        return n.v;
      case "var": {
        const v = scope.get(n.name);
        if (v === undefined) throw new ExprError(`变量 ${n.name} 未声明`);
        return v;
      }
      case "evt": {
        let cur: unknown = scope.evt;
        for (const p of n.path) {
          if (cur === null || typeof cur !== "object") throw new ExprError(`evt.${n.path.join(".")} 不存在`);
          cur = (cur as Record<string, unknown>)[p];
        }
        if (cur === undefined || typeof cur === "object") throw new ExprError(`evt.${n.path.join(".") || "…"} 不存在`);
        return cur as ExprVal;
      }
      case "un": {
        const a = ev(n.a);
        if (n.op === "!") return !truthy(a);
        const num = toNum(a);
        if (Number.isNaN(num)) throw new ExprError("负号作用于非数值");
        return -num;
      }
      case "bin": {
        // && / || 短路，且恒返回严格布尔（对非程序员可预期，避免 JS 操作数透传的惊讶）
        if (n.op === "&&") return truthy(ev(n.a)) ? truthy(ev(n.b)) : false;
        if (n.op === "||") return truthy(ev(n.a)) ? true : truthy(ev(n.b));
        const a = ev(n.a);
        const b = ev(n.b);
        switch (n.op) {
          case "+":
            if (typeof a === "string" || typeof b === "string") return String(a) + String(b);
            return toNum(a) + toNum(b);
          case "-":
            return toNum(a) - toNum(b);
          case "*":
            return toNum(a) * toNum(b);
          case "/":
            return toNum(a) / toNum(b);
          case "%":
            return toNum(a) % toNum(b);
          default:
            return cmpVal(a, n.op, b);
        }
      }
      case "call": {
        // if 惰性：只求值被选中的分支（另一分支里的未声明变量/除零都不会触发）
        if (n.name === "if") {
          if (truthy(ev(n.args[0]))) return ev(n.args[1]);
          return n.args[2] ? ev(n.args[2]) : false;
        }
        return FUNCS[n.name].call(n.args.map(ev));
      }
    }
  };

  return ev(ast);
}

/** 条件表达式专用：求值 → 布尔；错误返回 null（调用方记日志按不成立处理） */
export function evalCondExpr(src: string, scope: ExprScope): { ok: boolean; err?: string } {
  try {
    return { ok: truthy(evalExpr(src, scope)) };
  } catch (e) {
    return { ok: false, err: e instanceof Error ? e.message : String(e) };
  }
}
