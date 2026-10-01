/**
 * P123-C · 属性行的最小公共件。
 *
 * 为什么从 `PropertiesPanel` 里搬出来：发送侧的块编辑面要复用同样的行（`NumInput` /
 * `TextInput` 之前是它的导出），而它又要被 `PropertiesPanel` 渲染 —— 留在原处就是一个
 * 组件与它的使用者互相 import 的环。行控件是叶子，放进 `shared` 两边都只往下依赖。
 *
 * `FormRow` 就是把 `form-row` 那层手写结构收成一件：接收侧与发送侧的属性页现在是
 * **同一个容器、两套 section**，行必须长得一样，否则"同一个属性页面"只是句口号。
 */
import { useEffect, useState, type ReactNode } from "react";

export function NumInput({
  value,
  onCommit,
  width,
  title,
}: {
  value: number;
  onCommit: (v: number) => void;
  width?: number;
  title?: string;
}) {
  const [txt, setTxt] = useState(String(value));
  useEffect(() => setTxt(String(value)), [value]);
  const commit = () => {
    const v = parseFloat(txt.replace(",", "."));
    if (!Number.isNaN(v)) onCommit(v);
    else setTxt(String(value));
  };
  return (
    <input
      className="input num"
      style={width ? { width } : { flex: "1 1 90px", minWidth: 56 }}
      title={title}
      value={txt}
      onChange={(e) => setTxt(e.target.value)}
      onBlur={commit}
      onKeyDown={(e) => e.key === "Enter" && commit()}
    />
  );
}

export function TextInput({
  value,
  onCommit,
  width,
  placeholder,
}: {
  value: string;
  onCommit: (v: string) => void;
  width?: number;
  placeholder?: string;
}) {
  const [txt, setTxt] = useState(value);
  useEffect(() => setTxt(value), [value]);
  const commit = () => {
    if (txt !== value) onCommit(txt);
  };
  return (
    <input
      className="input"
      style={width ? { width } : { flex: "1 1 110px", minWidth: 70 }}
      placeholder={placeholder}
      value={txt}
      onChange={(e) => setTxt(e.target.value)}
      onBlur={commit}
      onKeyDown={(e) => e.key === "Enter" && commit()}
    />
  );
}

/**
 * 一行：一个标签 + 若干控件（成对控件直接放进 children，`form-pair` 那层由调用方管）。
 *
 * 标签必须是 `<label>` 这个**元素**，不是 `<span>`：样式只写在 `.form-row > label`
 * （56px 宽、右对齐、`--fs-sm`）与 `.form-pair > label` 上，而 `body` 不设字号 ——
 * 写成 span 就没人管，退回浏览器默认 16px，同一个属性页里两边字号就分叉了（P124-A 修的就是这个）。
 * 外层也不能是 `<label>`：那会变成 label 套 label，非法 HTML，点击行为不可预期。
 */
export function FormRow(props: { label: string; title?: string; children: ReactNode }) {
  return (
    <div className="form-row">
      <label title={props.title}>{props.label}</label>
      {props.children}
    </div>
  );
}

/** 一句说明（灰字，跟在行后面） */
export const FormHint = (props: { text: string }) => <div className="form-hint">{props.text}</div>;
