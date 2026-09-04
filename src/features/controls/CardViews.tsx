import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import * as store from "./controlsStore";
import { getLocale, tx, useLocale } from "../../i18n/strings";
import type {
  BuzzerCard,
  ButtonCard,
  ControlCard,
  CustomCard,
  GroupCard,
  GroupChild,
  GroupChildKind,
  JoystickCard,
  KeypadCard,
  KeymonCard,
  LedCard,
  LedOp,
  MonitorCard,
  SendMode,
  SliderCard,
  SwitchCard,
} from "./controlsStore";
import * as variableStore from "./variableStore";
import { beep } from "./scriptRunner";
import { WidgetFrame } from "../ai/WidgetFrame";
import { NumInput, TextInput } from "../protocol/PropertiesPanel";
import { Section } from "../../shared/Section";
import { HelpHint } from "../../shared/HelpHint";

function fmtVal(v: number): string {
  if (Number.isInteger(v)) return String(v);
  return v.toFixed(4).replace(/0+$/, "").replace(/\.$/, "");
}

function evalCond(
  op: LedOp,
  value: number,
  strValue: string,
  val: number | string | undefined,
): boolean {
  if (val === undefined) return false;
  if (op === "eq")
    return typeof val === "string" ? val === strValue : Number(val) === value;
  if (op === "ne")
    return typeof val === "string" ? val !== strValue : Number(val) !== value;
  const n = Number(val);
  return op === "gt"
    ? n > value
    : op === "ge"
      ? n >= value
      : op === "lt"
        ? n < value
        : n <= value;
}

export interface CardFrameProps {
  card: ControlCard;
  left: number;
  top: number;
  width: number;
  height: number;
  renaming: boolean;
  locked?: boolean;
  onMenu: (card: ControlCard, x: number, y: number) => void;
  onDragStart: (e: React.MouseEvent<HTMLDivElement>, card: ControlCard) => void;
  onRenameCommit: (name: string) => void;
  onRenameCancel: () => void;
  onDropTemplate: (
    card: ControlCard,
    cmd: {
        template: string;
        sendMode: SendMode;
        script: string;
        scriptEnabled: boolean;
      },
  ) => void;
  cont?: boolean;
  resizable?: boolean;
  onResizeStart?: (e: React.MouseEvent, card: ControlCard) => void;
  children: React.ReactNode;
}

function CardFrame(props: CardFrameProps) {
  const { card } = props;
  return (
    <div
      className={`ctl-card ${props.cont ? "cont" : ""}`}
      data-id={card.id}
      style={{
        left: props.left,
        top: props.top,
        width: props.width,
        height: props.height,
      }}
      onMouseDown={(e) => props.onDragStart(e, card)}
      onContextMenu={(e) => {
        e.preventDefault();
        e.stopPropagation();
        props.onMenu(card, e.clientX, e.clientY);
      }}
      onDragOver={(e) => {
        if (e.dataTransfer.types.includes("text/vs-cmd")) {
          e.preventDefault();
          e.stopPropagation();
        }
      }}
      onDrop={(e) => {
        if (!e.dataTransfer.types.includes("text/vs-cmd")) return;
        e.preventDefault();
        e.stopPropagation();
        const raw = e.dataTransfer.getData("text/vs-cmd");
        if (!raw) return;
        try {
          const cmd = JSON.parse(raw) as {
            template: string;
            sendMode: SendMode;
            script: string;
            scriptEnabled: boolean;
          };
          props.onDropTemplate(card, cmd);
        } catch {
          return;
        }
      }}
    >
      {props.renaming && (
        <input
          className="input ctl-rename-overlay"
          autoFocus
          defaultValue={card.name}
          onClick={(e) => e.stopPropagation()}
          onMouseDown={(e) => e.stopPropagation()}
          onBlur={(e) => props.onRenameCommit(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter")
              props.onRenameCommit((e.target as HTMLInputElement).value);
            if (e.key === "Escape") props.onRenameCancel();
          }}
        />
      )}
      {props.children}
      {props.resizable && (
        <div
          className="ctl-resize"
          title={tx("拖拽调整卡片大小", "Drag to resize the card")}
          onMouseDown={(e) => {
            e.stopPropagation();
            props.onResizeStart?.(e, card);
          }}
        />
      )}
    </div>
  );
}

export function SliderCardView(props: {
  card: SliderCard;
  left: number;
  top: number;
  width: number;
  height: number;
  initial: number;
  renaming: boolean;
  locked?: boolean;
  onValue: (card: SliderCard, v: number) => void;
  onRelease: (card: SliderCard, v: number) => void;
  onMenu: (card: ControlCard, x: number, y: number) => void;
  onDragStart: (e: React.MouseEvent<HTMLDivElement>, card: ControlCard) => void;
  onRenameCommit: (name: string) => void;
  onRenameCancel: () => void;
  onDropTemplate: (
    card: ControlCard,
    cmd: {
        template: string;
        sendMode: SendMode;
        script: string;
        scriptEnabled: boolean;
      },
  ) => void;
  resizable?: boolean;
  onResizeStart?: (e: React.MouseEvent, card: ControlCard) => void;
}) {
  const { card } = props;
  const sliderRef = useRef<HTMLInputElement>(null);
  const spanRef = useRef<HTMLDivElement>(null);
  const stepRef = useRef<HTMLInputElement>(null);

  const current = (): number =>
    parseFloat(sliderRef.current?.value ?? String(props.initial));

  const commit = (
    raw: number,
    fire: "none" | "value" | "release",
  ): number => {
    const snapped = parseFloat(
      (
        card.min +
        Math.round((raw - card.min) / card.step) * card.step
      ).toFixed(6),
    );
    const v = Math.min(card.max, Math.max(card.min, snapped));
    if (sliderRef.current) sliderRef.current.value = String(v);
    if (spanRef.current) spanRef.current.textContent = fmtVal(v);
    if (stepRef.current && document.activeElement !== stepRef.current) {
      stepRef.current.value = String(v);
    }
    if (fire === "value") props.onValue(card, v);
    else if (fire === "release") props.onRelease(card, v);
    return v;
  };

  useEffect(() => {
    commit(current(), "none");
  }, [card.min, card.max, card.step]);

  return (
    <CardFrame
      card={card}
      left={props.left}
      top={props.top}
      width={props.width}
      height={props.height}
      renaming={props.renaming}
      locked={props.locked}
      onMenu={props.onMenu}
      onDragStart={props.onDragStart}
      onRenameCommit={props.onRenameCommit}
      onRenameCancel={props.onRenameCancel}
      onDropTemplate={props.onDropTemplate}
      cont={card.sendTrigger === "continuous"}
      resizable={props.resizable}
      onResizeStart={props.onResizeStart}
    >
      <div className="ctl-val" ref={spanRef}>
        {fmtVal(props.initial)}
      </div>
      <input
        ref={sliderRef}
        className="ctl-slider"
        type="range"
        min={card.min}
        max={card.max}
        step={card.step}
        defaultValue={props.initial}
        onMouseDown={(e) => e.stopPropagation()}
        onInput={(e) =>
          commit(parseFloat((e.target as HTMLInputElement).value), "value")
        }
        onPointerUp={() => {
          if (card.sendTrigger === "onRelease") props.onRelease(card, current());
        }}
        onKeyUp={() => {
          if (card.sendTrigger === "onRelease") props.onRelease(card, current());
        }}
      />
      <div className="ctl-foot">
        <span className="ctl-name" title={tx("右键更多操作", "Right-click for more")}>
          {card.name}
          {card.useScript ? " ⚡" : ""}
        </span>
        <div className="ctl-stepgrp" onMouseDown={(e) => e.stopPropagation()}>
          <input
            ref={stepRef}
            className="ctl-step"
            type="number"
            min={card.min}
            max={card.max}
            step={card.step}
            defaultValue={props.initial}
            onChange={(e) => {
              const v = parseFloat(e.target.value);
              if (!Number.isNaN(v)) commit(v, "value");
            }}
            onKeyDown={(e) => {
              if (e.key === "Enter" && card.sendTrigger === "onRelease") {
                props.onRelease(card, current());
              }
            }}
          />
          <div className="ctl-spin">
            <button
              onClick={() =>
                commit(
                  current() + card.step,
                  card.sendTrigger === "continuous" ? "value" : "release",
                )
              }
            >
              ▲
            </button>
            <button
              onClick={() =>
                commit(
                  current() - card.step,
                  card.sendTrigger === "continuous" ? "value" : "release",
                )
              }
            >
              ▼
            </button>
          </div>
        </div>
      </div>
    </CardFrame>
  );
}

export function ButtonCardView(props: {
  card: ButtonCard;
  left: number;
  top: number;
  width: number;
  height: number;
  renaming: boolean;
  locked?: boolean;
  onSend: (card: ControlCard, ctx: Record<string, number | string>) => void;
  onMenu: (card: ControlCard, x: number, y: number) => void;
  onDragStart: (e: React.MouseEvent<HTMLDivElement>, card: ControlCard) => void;
  onRenameCommit: (name: string) => void;
  onRenameCancel: () => void;
  onDropTemplate: (
    card: ControlCard,
    cmd: {
        template: string;
        sendMode: SendMode;
        script: string;
        scriptEnabled: boolean;
      },
  ) => void;
  resizable?: boolean;
  onResizeStart?: (e: React.MouseEvent, card: ControlCard) => void;
}) {
  const { card } = props;
  const holdRef = useRef<number | null>(null);

  const stopHold = () => {
    if (holdRef.current !== null) {
      window.clearInterval(holdRef.current);
      holdRef.current = null;
    }
  };

  useEffect(() => stopHold, []);

  return (
    <CardFrame
      card={card}
      left={props.left}
      top={props.top}
      width={props.width}
      height={props.height}
      renaming={props.renaming}
      locked={props.locked}
      onMenu={props.onMenu}
      onDragStart={props.onDragStart}
      onRenameCommit={props.onRenameCommit}
      onRenameCancel={props.onRenameCancel}
      onDropTemplate={props.onDropTemplate}
      resizable={props.resizable}
      onResizeStart={props.onResizeStart}
    >
      <button
        className="ctl-btn"
        onMouseDown={(e) => e.stopPropagation()}
        onPointerDown={() => {
          props.onSend(card, {});
          if (card.holdRepeat) {
            stopHold();
            holdRef.current = window.setInterval(
              () => props.onSend(card, {}),
              Math.max(50, card.minIntervalMs),
            );
          }
        }}
        onPointerUp={stopHold}
        onPointerLeave={stopHold}
      >
        {card.name}
        {card.useScript ? " ⚡" : ""}
      </button>
    </CardFrame>
  );
}

export function SwitchCardView(props: {
  card: SwitchCard;
  left: number;
  top: number;
  width: number;
  height: number;
  renaming: boolean;
  locked?: boolean;
  onSend: (card: ControlCard, ctx: Record<string, number | string>) => void;
  onMenu: (card: ControlCard, x: number, y: number) => void;
  onDragStart: (e: React.MouseEvent<HTMLDivElement>, card: ControlCard) => void;
  onRenameCommit: (name: string) => void;
  onRenameCancel: () => void;
  onDropTemplate: (
    card: ControlCard,
    cmd: {
        template: string;
        sendMode: SendMode;
        script: string;
        scriptEnabled: boolean;
      },
  ) => void;
  resizable?: boolean;
  onResizeStart?: (e: React.MouseEvent, card: ControlCard) => void;
}) {
  const { card } = props;
  const [state, setState] = useState(card.state);
  useEffect(() => setState(card.state), [card.state]);

  return (
    <CardFrame
      card={card}
      left={props.left}
      top={props.top}
      width={props.width}
      height={props.height}
      renaming={props.renaming}
      locked={props.locked}
      onMenu={props.onMenu}
      onDragStart={props.onDragStart}
      onRenameCommit={props.onRenameCommit}
      onRenameCancel={props.onRenameCancel}
      onDropTemplate={props.onDropTemplate}
      resizable={props.resizable}
      onResizeStart={props.onResizeStart}
    >
      <div className="ctl-sw">
        {Array.from({ length: card.positions }).map((_, i) => (
          <button
            key={i}
            className={`ctl-sw-seg ${state === i ? "active" : ""}`}
            onMouseDown={(e) => e.stopPropagation()}
            onClick={() => {
              if (i === state) return;
              setState(i);
              props.onSend(card, { state: i, label: card.labels[i] ?? "" });
            }}
          >
            {card.labels[i] || `${i + 1}`}
          </button>
        ))}
      </div>
      <div className="ctl-name center">
        {card.name}
        {card.useScript ? " ⚡" : ""}
      </div>
    </CardFrame>
  );
}

export function LedCardView(props: {
  card: LedCard;
  left: number;
  top: number;
  width: number;
  height: number;
  renaming: boolean;
  locked?: boolean;
  onMenu: (card: ControlCard, x: number, y: number) => void;
  onDragStart: (e: React.MouseEvent<HTMLDivElement>, card: ControlCard) => void;
  onRenameCommit: (name: string) => void;
  onRenameCancel: () => void;
  onDropTemplate: (
    card: ControlCard,
    cmd: {
        template: string;
        sendMode: SendMode;
        script: string;
        scriptEnabled: boolean;
      },
  ) => void;
  resizable?: boolean;
  onResizeStart?: (e: React.MouseEvent, card: ControlCard) => void;
}) {
  const { card } = props;
  useSyncExternalStore(variableStore.subscribe, variableStore.getSnapshot);
  const val = variableStore.getVar(card.varName);
  const on = evalCond(card.op, card.value, card.strValue, val);
  return (
    <CardFrame
      card={card}
      left={props.left}
      top={props.top}
      width={props.width}
      height={props.height}
      renaming={props.renaming}
      locked={props.locked}
      onMenu={props.onMenu}
      onDragStart={props.onDragStart}
      onRenameCommit={props.onRenameCommit}
      onRenameCancel={props.onRenameCancel}
      onDropTemplate={props.onDropTemplate}
      resizable={props.resizable}
      onResizeStart={props.onResizeStart}
    >
      <div className="led-dot-wrap">
        <div
          className="led-dot"
          style={{
            width: Math.max(22, Math.min(110, Math.floor(Math.min(props.width - 28, props.height - 46)))),
            height: Math.max(22, Math.min(110, Math.floor(Math.min(props.width - 28, props.height - 46)))),
            background: on ? card.onColor : "var(--bg-inset)",
            boxShadow: on ? `0 0 14px ${card.onColor}` : "none",
            borderColor: on ? card.onColor : "var(--border)",
          }}
        />
      </div>
      <div className="ctl-name center">
        {card.name}
        {card.varName ? ` · ${card.varName}` : ""}
      </div>
    </CardFrame>
  );
}

export function BuzzerCardView(props: {
  card: BuzzerCard;
  left: number;
  top: number;
  width: number;
  height: number;
  renaming: boolean;
  locked?: boolean;
  onMenu: (card: ControlCard, x: number, y: number) => void;
  onDragStart: (e: React.MouseEvent<HTMLDivElement>, card: ControlCard) => void;
  onRenameCommit: (name: string) => void;
  onRenameCancel: () => void;
  onDropTemplate: (
    card: ControlCard,
    cmd: {
        template: string;
        sendMode: SendMode;
        script: string;
        scriptEnabled: boolean;
      },
  ) => void;
  resizable?: boolean;
  onResizeStart?: (e: React.MouseEvent, card: ControlCard) => void;
}) {
  const { card } = props;
  useSyncExternalStore(variableStore.subscribe, variableStore.getSnapshot);
  const val = variableStore.getVar(card.varName);
  const on = evalCond(card.op, card.value, card.strValue, val);
  const vol = (card.volume / 100) * 0.3;
  const prevOnRef = useRef(false);
  useEffect(() => {
    if (on && !prevOnRef.current) beep(card.freq, card.durationMs, vol);
    prevOnRef.current = on;
  }, [on, card.freq, card.durationMs, vol]);
  useEffect(() => {
    if (!on || !card.repeat) return;
    const gap = Math.max(30, card.gapMs ?? 300);
    const t = window.setInterval(
      () => beep(card.freq, card.durationMs, vol),
      card.durationMs + gap,
    );
    return () => window.clearInterval(t);
  }, [on, card.repeat, card.freq, card.durationMs, card.gapMs, vol]);
  const sz = Math.max(
    22,
    Math.min(110, Math.floor(Math.min(props.width - 28, props.height - 46))),
  );
  return (
    <CardFrame
      card={card}
      left={props.left}
      top={props.top}
      width={props.width}
      height={props.height}
      renaming={props.renaming}
      locked={props.locked}
      onMenu={props.onMenu}
      onDragStart={props.onDragStart}
      onRenameCommit={props.onRenameCommit}
      onRenameCancel={props.onRenameCancel}
      onDropTemplate={props.onDropTemplate}
      resizable={props.resizable}
      onResizeStart={props.onResizeStart}
    >
      <div className="led-dot-wrap">
        <svg
          className="buzzer-icon"
          viewBox="0 0 24 24"
          width={sz}
          height={sz}
          fill="none"
          stroke={on ? card.onColor : "var(--border)"}
          strokeWidth="1.8"
          strokeLinecap="round"
          strokeLinejoin="round"
          style={
            on
              ? { filter: `drop-shadow(0 0 8px ${card.onColor})` }
              : undefined
          }
        >
          <path d="M12 4a5 5 0 0 0-5 5v3.6L5.4 16h13.2L17 12.6V9a5 5 0 0 0-5-5z" />
          <path d="M10 19a2 2 0 0 0 4 0" />
          {on && (
            <>
              <path d="M20 7c1.2 1.4 1.2 3.6 0 5" />
              <path d="M4 7c-1.2 1.4-1.2 3.6 0 5" />
            </>
          )}
        </svg>
      </div>
      <div className="ctl-name center">
        {card.name}
        {card.varName ? ` · ${card.varName}` : ""}
      </div>
    </CardFrame>
  );
}

export function MonitorCardView(props: {
  card: MonitorCard;
  left: number;
  top: number;
  width: number;
  height: number;
  renaming: boolean;
  locked?: boolean;
  onMenu: (card: ControlCard, x: number, y: number) => void;
  onDragStart: (e: React.MouseEvent<HTMLDivElement>, card: ControlCard) => void;
  onRenameCommit: (name: string) => void;
  onRenameCancel: () => void;
  onDropTemplate: (
    card: ControlCard,
    cmd: {
        template: string;
        sendMode: SendMode;
        script: string;
        scriptEnabled: boolean;
      },
  ) => void;
  resizable?: boolean;
  onResizeStart?: (e: React.MouseEvent, card: ControlCard) => void;
}) {
  const { card } = props;
  useSyncExternalStore(variableStore.subscribe, variableStore.getSnapshot);
  const val = variableStore.getVar(card.varName);
  const text =
    val === undefined
      ? "--"
      : typeof val === "number"
        ? val.toFixed(card.decimals)
        : val;
  return (
    <CardFrame
      card={card}
      left={props.left}
      top={props.top}
      width={props.width}
      height={props.height}
      renaming={props.renaming}
      locked={props.locked}
      onMenu={props.onMenu}
      onDragStart={props.onDragStart}
      onRenameCommit={props.onRenameCommit}
      onRenameCancel={props.onRenameCancel}
      onDropTemplate={props.onDropTemplate}
      resizable={props.resizable}
      onResizeStart={props.onResizeStart}
    >
      <div className="ctl-val">
        {text}
        {card.unit ? <span className="ctl-unit">{card.unit}</span> : null}
      </div>
      <div className="ctl-name center">{card.name}</div>
    </CardFrame>
  );
}

/** 组合控件：一张卡片内纵向排布多个子控件（滑条/按钮/开关/监视/LED） */
export function GroupCardView(props: {
  card: GroupCard;
  left: number;
  top: number;
  width: number;
  height: number;
  renaming: boolean;
  locked?: boolean;
  onChildSend: (
    card: GroupCard,
    child: GroupChild,
    ctx: Record<string, number | string>,
  ) => void;
  onMenu: (card: ControlCard, x: number, y: number) => void;
  onDragStart: (e: React.MouseEvent<HTMLDivElement>, card: ControlCard) => void;
  onRenameCommit: (name: string) => void;
  onRenameCancel: () => void;
  onDropTemplate: (
    card: ControlCard,
    cmd: {
        template: string;
        sendMode: SendMode;
        script: string;
        scriptEnabled: boolean;
      },
  ) => void;
  resizable?: boolean;
  onResizeStart?: (e: React.MouseEvent, card: ControlCard) => void;
}) {
  const { card } = props;
  // monitor / led 子项随变量刷新
  useSyncExternalStore(variableStore.subscribe, variableStore.getSnapshot);
  const [sliderVals, setSliderVals] = useState<Record<string, number>>({});
  const [swStates, setSwStates] = useState<Record<string, number>>({});

  const stop = (e: React.SyntheticEvent) => e.stopPropagation();

  const sliderVal = (ch: GroupChild): number =>
    sliderVals[ch.id] ?? ch.min + (ch.max - ch.min) / 2;

  const commitSlider = (ch: GroupChild, raw: number) => {
    const snapped = parseFloat(
      (ch.min + Math.round((raw - ch.min) / ch.step) * ch.step).toFixed(6),
    );
    const v = Math.min(ch.max, Math.max(ch.min, snapped));
    setSliderVals((m) => ({ ...m, [ch.id]: v }));
    return v;
  };

  return (
    <CardFrame
      card={card}
      left={props.left}
      top={props.top}
      width={props.width}
      height={props.height}
      renaming={props.renaming}
      locked={props.locked}
      onMenu={props.onMenu}
      onDragStart={props.onDragStart}
      onRenameCommit={props.onRenameCommit}
      onRenameCancel={props.onRenameCancel}
      onDropTemplate={props.onDropTemplate}
      resizable={props.resizable}
      onResizeStart={props.onResizeStart}
    >
      <div className="ctl-group" onDoubleClick={stop}>
        <div className="ctl-group-head">
          <span className="ctl-name" title={tx("右键更多操作", "Right-click for more")}>
            {card.name}
          </span>
        </div>
        {card.children.map((ch) => {
          if (ch.kind === "slider") {
            const v = sliderVal(ch);
            return (
              <div className="ctlg-row ctlg-slider" key={ch.id} onMouseDown={stop}>
                <span className="ctl-name ctlg-label">{ch.label}</span>
                <input
                  className="ctl-slider"
                  type="range"
                  min={ch.min}
                  max={ch.max}
                  step={ch.step}
                  value={v}
                  onInput={(e) =>
                    commitSlider(ch, parseFloat((e.target as HTMLInputElement).value))
                  }
                  onPointerUp={() =>
                    props.onChildSend(card, ch, { value: sliderVal(ch) })
                  }
                  onKeyUp={() =>
                    props.onChildSend(card, ch, { value: sliderVal(ch) })
                  }
                />
                <span className="ctl-group-val">{fmtVal(v)}</span>
              </div>
            );
          }
          if (ch.kind === "button") {
            return (
              <button
                key={ch.id}
                className="ctlg-btn"
                onMouseDown={stop}
                onClick={(e) => {
                  e.stopPropagation();
                  props.onChildSend(card, ch, {});
                }}
              >
                {ch.label}
              </button>
            );
          }
          if (ch.kind === "switch") {
            const st = swStates[ch.id] ?? 0;
            return (
              <div className="ctlg-row ctlg-switch" key={ch.id} onMouseDown={stop}>
                <span className="ctl-name ctlg-label">{ch.label}</span>
                <button
                  className={`ctlg-sw ${st ? "on" : ""}`}
                  onClick={(e) => {
                    e.stopPropagation();
                    const ns = st ? 0 : 1;
                    setSwStates((m) => ({ ...m, [ch.id]: ns }));
                    props.onChildSend(card, ch, { state: ns });
                  }}
                >
                  <span className="ctlg-sw-knob" />
                </button>
              </div>
            );
          }
          if (ch.kind === "monitor") {
            const val = variableStore.getVar(ch.varName);
            const text =
              val === undefined
                ? "--"
                : typeof val === "number"
                  ? val.toFixed(2)
                  : val;
            return (
              <div className="ctlg-row ctlg-monitor" key={ch.id}>
                <span className="ctl-name ctlg-label">{ch.label}</span>
                <span className="ctl-group-val">
                  {text}
                  {ch.unit ? <span className="ctl-unit">{ch.unit}</span> : null}
                </span>
              </div>
            );
          }
          // led
          const val = variableStore.getVar(ch.varName);
          const on = evalCond(ch.op, ch.value, ch.strValue, val);
          return (
            <div className="ctlg-row ctlg-led" key={ch.id}>
              <span className="ctl-name ctlg-label">{ch.label}</span>
              <span
                className="ctlg-led-dot"
                style={{
                  background: on ? ch.onColor : "var(--bg-inset)",
                  boxShadow: on ? `0 0 8px ${ch.onColor}` : "none",
                  borderColor: on ? ch.onColor : "var(--border)",
                }}
              />
            </div>
          );
        })}
      </div>
    </CardFrame>
  );
}

export function JoystickCardView(props: {
  card: JoystickCard;
  left: number;
  top: number;
  width: number;
  height: number;
  renaming: boolean;
  locked?: boolean;
  onSend: (card: ControlCard, ctx: Record<string, number | string>) => void;
  onMenu: (card: ControlCard, x: number, y: number) => void;
  onDragStart: (e: React.MouseEvent<HTMLDivElement>, card: ControlCard) => void;
  onRenameCommit: (name: string) => void;
  onRenameCancel: () => void;
  onDropTemplate: (
    card: ControlCard,
    cmd: {
        template: string;
        sendMode: SendMode;
        script: string;
        scriptEnabled: boolean;
      },
  ) => void;
  resizable?: boolean;
  onResizeStart?: (e: React.MouseEvent, card: ControlCard) => void;
}) {
  const { card } = props;
  const padRef = useRef<HTMLDivElement>(null);
  const knobRef = useRef<HTMLDivElement>(null);
  const [padSize, setPadSize] = useState(118);
  useEffect(() => {
    const pad = padRef.current;
    if (!pad) return;
    const parent = pad.parentElement;
    if (!parent) return;
    const ro = new ResizeObserver(() => {
      const s = Math.max(
        56,
        Math.min(parent.clientWidth - 16, parent.clientHeight - 34),
      );
      setPadSize(Math.floor(s));
    });
    ro.observe(parent);
    return () => ro.disconnect();
  }, []);
  const activeRef = useRef(false);
  const throttleRef = useRef<{ last: number; timer: number | null }>({
    last: 0,
    timer: null,
  });
  const pendingRef = useRef<[number, number] | null>(null);

  const setKnob = (dx: number, dy: number) => {
    const pad = padRef.current;
    const knob = knobRef.current;
    if (!pad || !knob) return;
    const maxR = pad.clientWidth / 2 - 18;
    knob.style.transform = `translate(${dx * maxR}px, ${dy * maxR}px)`;
  };

  const handlePoint = (e: { clientX: number; clientY: number }) => {
    const pad = padRef.current;
    if (!pad) return;
    const r = pad.getBoundingClientRect();
    let dx = (e.clientX - (r.left + r.width / 2)) / (r.width / 2);
    let dy = (e.clientY - (r.top + r.height / 2)) / (r.height / 2);
    const len = Math.hypot(dx, dy);
    if (len > 1) {
      dx /= len;
      dy /= len;
    }
    setKnob(dx, dy);
    throttled(
      Math.round(dx * card.range),
      Math.round(-dy * card.range),
    );
  };

  const throttled = (x: number, y: number) => {
    const st = throttleRef.current;
    const now = Date.now();
    const dt = now - st.last;
    if (dt >= card.minIntervalMs) {
      st.last = now;
      props.onSend(card, { x, y });
    } else {
      pendingRef.current = [x, y];
      if (!st.timer) {
        st.timer = window.setTimeout(() => {
          st.timer = null;
          if (pendingRef.current) {
            const [px, py] = pendingRef.current;
            pendingRef.current = null;
            st.last = Date.now();
            props.onSend(card, { x: px, y: py });
          }
        }, card.minIntervalMs - dt);
      }
    }
  };

  const release = () => {
    if (!activeRef.current) return;
    activeRef.current = false;
    if (card.springBack) {
      setKnob(0, 0);
      props.onSend(card, { x: 0, y: 0 });
    }
  };

  useEffect(() => {
    const move = (e: PointerEvent) => {
      if (activeRef.current) handlePoint(e);
    };
    window.addEventListener("pointermove", move);
    return () => window.removeEventListener("pointermove", move);
  }, [card.range, card.minIntervalMs, card.template, card.sendMode, card.useScript, card.script]);

  return (
    <CardFrame
      card={card}
      left={props.left}
      top={props.top}
      width={props.width}
      height={props.height}
      renaming={props.renaming}
      locked={props.locked}
      onMenu={props.onMenu}
      onDragStart={props.onDragStart}
      onRenameCommit={props.onRenameCommit}
      onRenameCancel={props.onRenameCancel}
      onDropTemplate={props.onDropTemplate}
      resizable={props.resizable}
      onResizeStart={props.onResizeStart}
    >
      <div
        className="joy-pad"
        ref={padRef}
        style={{ width: padSize, height: padSize }}
        onMouseDown={(e) => e.stopPropagation()}
        onPointerDown={(e) => {
          e.stopPropagation();
          activeRef.current = true;
          (e.target as HTMLElement).setPointerCapture(e.pointerId);
          handlePoint(e);
        }}
        onPointerUp={(e) => {
          (e.target as HTMLElement).releasePointerCapture(e.pointerId);
          release();
        }}
      >
        <div className="joy-knob" ref={knobRef} />
      </div>
      <div className="ctl-name center">
        {card.name}
        {card.useScript ? " ⚡" : ""}
      </div>
    </CardFrame>
  );
}

/** 键位显示名：ArrowUp → ↑，字母转大写 */
export function keyLabel(k: string): string {
  if (k === " ") return "Space";
  const map: Record<string, string> = {
    ArrowUp: "↑",
    ArrowDown: "↓",
    ArrowLeft: "←",
    ArrowRight: "→",
  };
  if (map[k]) return map[k];
  return k.length === 1 ? k.toUpperCase() : k;
}

function normKey(k: string): string {
  return k.length === 1 ? k.toLowerCase() : k;
}

/** 键位捕获输入框：聚焦后按任意键即录入（Esc 取消） */
export function KeyCaptureInput({
  value,
  onCommit,
}: {
  value: string;
  onCommit: (v: string) => void;
}) {
  const [cap, setCap] = useState(false);
  return (
    <input
      className={`input keycap-input ${cap ? "cap" : ""}`}
      readOnly
      value={cap ? tx("按下任意键…", "Press any key…") : keyLabel(value)}
      onFocus={() => setCap(true)}
      onBlur={() => setCap(false)}
      onKeyDown={(e) => {
        if (!cap) return;
        e.preventDefault();
        e.stopPropagation();
        if (e.key !== "Escape") onCommit(e.key);
        setCap(false);
        (e.target as HTMLInputElement).blur();
      }}
    />
  );
}

/** 按键触发期间禁止输入框抢占：焦点在任何可编辑元素上时不监听 */
function editableTarget(t: EventTarget | null): boolean {
  if (!(t instanceof HTMLElement)) return false;
  return (
    t.tagName === "INPUT" ||
    t.tagName === "TEXTAREA" ||
    t.tagName === "SELECT" ||
    t.isContentEditable
  );
}

const DIR_LABELS = ["上", "下", "左", "右"];
const dirLabels = (): string[] =>
  getLocale() === "en" ? ["Up", "Down", "Left", "Right"] : DIR_LABELS;

/** 键盘遥控：四方向键位监听，按下/松开各可发指令，触发时边缘光晕+键位徽标渐隐 */
export function KeypadCardView(props: {
  card: KeypadCard;
  left: number;
  top: number;
  width: number;
  height: number;
  renaming: boolean;
  locked?: boolean;
  onSend: (card: ControlCard, ctx: Record<string, number | string>) => void;
  onMenu: (card: ControlCard, x: number, y: number) => void;
  onDragStart: (e: React.MouseEvent<HTMLDivElement>, card: ControlCard) => void;
  onRenameCommit: (name: string) => void;
  onRenameCancel: () => void;
  onDropTemplate: (
    card: ControlCard,
    cmd: {
      template: string;
      sendMode: SendMode;
      script: string;
      scriptEnabled: boolean;
    },
  ) => void;
  resizable?: boolean;
  onResizeStart?: (e: React.MouseEvent, card: ControlCard) => void;
}) {
  const { card } = props;
  const [held, setHeld] = useState<number[]>([]);
  const [flash, setFlash] = useState<{ dir: number; n: number } | null>(null);
  const cardRef = useRef(card);
  cardRef.current = card;
  const sendRef = useRef(props.onSend);
  sendRef.current = props.onSend;

  useEffect(() => {
    const idxOf = (key: string) =>
      cardRef.current.keys.findIndex((k) => normKey(k) === normKey(key));
    const onDown = (e: KeyboardEvent) => {
      if (e.repeat || editableTarget(e.target)) return;
      const i = idxOf(e.key);
      if (i < 0) return;
      e.preventDefault();
      const c = cardRef.current;
      setHeld((h) => (h.includes(i) ? h : [...h, i]));
      setFlash({ dir: i, n: Date.now() });
      sendRef.current(c, {
        dir: i,
        dirName: c.labels[i] ?? DIR_LABELS[i],
        phase: "press",
        key: keyLabel(e.key),
      });
    };
    const onUp = (e: KeyboardEvent) => {
      if (editableTarget(e.target)) return;
      const i = idxOf(e.key);
      if (i < 0) return;
      const c = cardRef.current;
      setHeld((h) => h.filter((x) => x !== i));
      sendRef.current(c, {
        dir: i,
        dirName: c.labels[i] ?? DIR_LABELS[i],
        phase: "release",
        key: keyLabel(e.key),
      });
    };
    window.addEventListener("keydown", onDown);
    window.addEventListener("keyup", onUp);
    return () => {
      window.removeEventListener("keydown", onDown);
      window.removeEventListener("keyup", onUp);
    };
  }, []);

  const trig = (i: number, phase: "press" | "release") => {
    props.onSend(card, {
      dir: i,
      dirName: card.labels[i] ?? DIR_LABELS[i],
      phase,
      key: keyLabel(card.keys[i]),
    });
  };

  const btn = (i: number, cls: string, rot: number) => (
    <button
      className={`keypad-btn ${cls} ${held.includes(i) ? "held" : ""}`}
      onMouseDown={(e) => {
        e.stopPropagation();
        setHeld((h) => (h.includes(i) ? h : [...h, i]));
        setFlash({ dir: i, n: Date.now() });
        trig(i, "press");
      }}
      onMouseUp={(e) => {
        e.stopPropagation();
        setHeld((h) => h.filter((x) => x !== i));
        trig(i, "release");
      }}
      onMouseLeave={() => setHeld((h) => h.filter((x) => x !== i))}
      title={`${card.labels[i] ?? DIR_LABELS[i]}（${keyLabel(card.keys[i])}）`}
    >
      <svg width="14" height="14" viewBox="0 0 14 14" aria-hidden="true">
        <polygon
          points="7,3 11,9 3,9"
          fill="currentColor"
          transform={`rotate(${rot} 7 7)`}
        />
      </svg>
    </button>
  );

  return (
    <CardFrame
      card={card}
      left={props.left}
      top={props.top}
      width={props.width}
      height={props.height}
      renaming={props.renaming}
      locked={props.locked}
      onMenu={props.onMenu}
      onDragStart={props.onDragStart}
      onRenameCommit={props.onRenameCommit}
      onRenameCancel={props.onRenameCancel}
      onDropTemplate={props.onDropTemplate}
      resizable={props.resizable}
      onResizeStart={props.onResizeStart}
    >
      <div className="keypad-wrap">
        {flash && (
          <span key={flash.n} className="kbadge" data-dir={flash.dir}>
            {keyLabel(card.keys[flash.dir])} {card.labels[flash.dir] ?? ""}
          </span>
        )}
        {flash && <span key={`g${flash.n}`} className="kglow" />}
        {btn(0, "up", 0)}
        {btn(2, "left", -90)}
        {btn(3, "right", 90)}
        {btn(1, "down", 180)}
      </div>
    </CardFrame>
  );
}

/** 单键监控：单个键位按下/松开触发 */
export function KeymonCardView(props: {
  card: KeymonCard;
  left: number;
  top: number;
  width: number;
  height: number;
  renaming: boolean;
  locked?: boolean;
  onSend: (card: ControlCard, ctx: Record<string, number | string>) => void;
  onMenu: (card: ControlCard, x: number, y: number) => void;
  onDragStart: (e: React.MouseEvent<HTMLDivElement>, card: ControlCard) => void;
  onRenameCommit: (name: string) => void;
  onRenameCancel: () => void;
  onDropTemplate: (
    card: ControlCard,
    cmd: {
      template: string;
      sendMode: SendMode;
      script: string;
      scriptEnabled: boolean;
    },
  ) => void;
  resizable?: boolean;
  onResizeStart?: (e: React.MouseEvent, card: ControlCard) => void;
}) {
  const { card } = props;
  const [held, setHeld] = useState(false);
  const [flash, setFlash] = useState<number | null>(null);
  const cardRef = useRef(card);
  cardRef.current = card;
  const sendRef = useRef(props.onSend);
  sendRef.current = props.onSend;

  useEffect(() => {
    const match = (key: string) =>
      normKey(key) === normKey(cardRef.current.key);
    const onDown = (e: KeyboardEvent) => {
      if (e.repeat || editableTarget(e.target)) return;
      if (!match(e.key)) return;
      e.preventDefault();
      setHeld(true);
      setFlash(Date.now());
      sendRef.current(cardRef.current, {
        phase: "press",
        key: keyLabel(e.key),
      });
    };
    const onUp = (e: KeyboardEvent) => {
      if (editableTarget(e.target)) return;
      if (!match(e.key)) return;
      setHeld(false);
      sendRef.current(cardRef.current, {
        phase: "release",
        key: keyLabel(e.key),
      });
    };
    window.addEventListener("keydown", onDown);
    window.addEventListener("keyup", onUp);
    return () => {
      window.removeEventListener("keydown", onDown);
      window.removeEventListener("keyup", onUp);
    };
  }, []);

  const trig = (phase: "press" | "release") =>
    props.onSend(card, { phase, key: keyLabel(card.key) });

  return (
    <CardFrame
      card={card}
      left={props.left}
      top={props.top}
      width={props.width}
      height={props.height}
      renaming={props.renaming}
      locked={props.locked}
      onMenu={props.onMenu}
      onDragStart={props.onDragStart}
      onRenameCommit={props.onRenameCommit}
      onRenameCancel={props.onRenameCancel}
      onDropTemplate={props.onDropTemplate}
      resizable={props.resizable}
      onResizeStart={props.onResizeStart}
    >
      <div className="keymon-wrap">
        {held && <span className="kglow" />}
        {flash && (
          <span key={flash} className="kbadge">
            {keyLabel(card.key)}
          </span>
        )}
        <div
          className={`keymon-dot ${held ? "held" : ""}`}
          onMouseDown={(e) => {
            e.stopPropagation();
            setHeld(true);
            trig("press");
          }}
          onMouseUp={(e) => {
            e.stopPropagation();
            setHeld(false);
            trig("release");
          }}
          onMouseLeave={() => setHeld(false)}
          title={tx(`按下键盘 ${keyLabel(card.key)} 触发`, `Triggered by key ${keyLabel(card.key)}`)}
        >
          {keyLabel(card.key)}
        </div>
        <div className="ctl-name center">{card.name}</div>
      </div>
    </CardFrame>
  );
}

/** 自定义卡片：沙箱 iframe（与小部件同一桥协议），任意风格与功能 */
export function CustomCardView(props: {
  card: CustomCard;
  left: number;
  top: number;
  width: number;
  height: number;
  renaming: boolean;
  locked?: boolean;
  onMenu: (card: ControlCard, x: number, y: number) => void;
  onDragStart: (e: React.MouseEvent<HTMLDivElement>, card: ControlCard) => void;
  onRenameCommit: (name: string) => void;
  onRenameCancel: () => void;
  onDropTemplate: (
    card: ControlCard,
    cmd: {
        template: string;
        sendMode: SendMode;
        script: string;
        scriptEnabled: boolean;
      },
  ) => void;
  resizable?: boolean;
  onResizeStart?: (e: React.MouseEvent, card: ControlCard) => void;
}) {
  const { card } = props;
  return (
    <CardFrame
      card={card}
      left={props.left}
      top={props.top}
      width={props.width}
      height={props.height}
      renaming={props.renaming}
      locked={props.locked}
      onMenu={props.onMenu}
      onDragStart={props.onDragStart}
      onRenameCommit={props.onRenameCommit}
      onRenameCancel={props.onRenameCancel}
      onDropTemplate={props.onDropTemplate}
      resizable={props.resizable}
      onResizeStart={props.onResizeStart}
    >
      {card.html ? (
        <WidgetFrame
          widget={{ id: `card-${card.id}`, name: card.name, html: card.html }}
          isDesktop={false}
        />
      ) : (
        <div className="ctl-custom-empty" title={tx("让 AI 生成，或右键「设置」粘贴 HTML", "Let AI generate it, or right-click Settings and paste HTML")}>
          {tx("自定义卡片（空）", "Custom card (empty)")}
          <br />
          <span>{tx("在 AI 助手中描述想要的控件，type 选 custom", "Describe the widget to the AI assistant with type=custom")}</span>
        </div>
      )}
    </CardFrame>
  );
}

const SCRIPT_API_HINT =
  "脚本 API：await send(text, mode?) 发送指令（mode 省略按卡片 ASCII/Hex 设置）· beep(freq, ms) 蜂鸣 · await delay_ms(ms) 延时 · get(\"变量\") 读取 · set(\"变量\", 值) 写入 · await waitParse(\"字段\", ms?) 等待解析帧 · setControl(\"控件名\", 值) 联动触发其他控件（按钮发送/开关切档/滑条设值/键盘遥控方向）· await repeat(n, i => …) 循环 · log(text) 输出控制台。完整 JS 语法可用（for/while/if/function/Math…）；解析字段名可直接当变量使用（重名自动 _1/_2）；模板串支持 {字段名:.2f} 格式化插值。";

const SCRIPT_API_HINT_EN =
  "Script API: await send(text, mode?) — mode defaults to the card's ASCII/Hex setting · beep(freq, ms) · await delay_ms(ms) · get(name) · set(name, value) · await waitParse(field, ms?) · setControl(cardName, value) to trigger other controls (button send / switch position / slider value / keypad direction) · await repeat(n, i => …) · log(text) to console. Full JS syntax (for/while/if/function/Math…); parsed field names work as variables (duplicates get _1/_2); templates support {field:.2f} formatting.";

const DEFAULT_KEYPAD_SCRIPT = `// dir: 0上 1下 2左 3右；phase: press/release
if (dir === 0) send("FWD:" + phase);
else if (dir === 1) send("BAK:" + phase);
else if (dir === 2) send("LFT:" + phase);
else send("RGT:" + phase);`;

function ScriptFields({
  value,
  onCommit,
  hint,
}: {
  value: string;
  onCommit: (v: string) => void;
  hint: string;
}) {
  return (
    <div className="form-col">
      <label>
        {hint}
        <HelpHint text={getLocale() === "en" ? SCRIPT_API_HINT_EN : SCRIPT_API_HINT} />
      </label>
      <textarea
        className="input ctl-tpl-input ctl-script-input"
        rows={8}
        spellCheck={false}
        value={value}
        onChange={(e) => onCommit(e.target.value)}
      />
    </div>
  );
}

export function CardModal(props: {
  card: ControlCard;
  pageId: string;
  onClose: () => void;
  onDelete: () => void;
}) {
  useLocale();
  const { card } = props;
  useSyncExternalStore(variableStore.subscribe, variableStore.getSnapshot);
  const vars = variableStore.listVars();
  const patch = (p: Record<string, unknown>) =>
    store.patchCard(props.pageId, card.id, p);

  const hasScriptMode =
    card.type === "slider" ||
    card.type === "button" ||
    card.type === "switch" ||
    card.type === "joystick" ||
    card.type === "keypad" ||
    card.type === "keymon";

  const varSelect = (
    value: string,
    onCommit: (v: string) => void,
  ) => (
    <select
      className="input"
      value={value}
      onChange={(e) => onCommit(e.target.value)}
    >
      <option value="">{tx("— 选择变量 —", "— Select variable —")}</option>
      {vars.map((v) => (
        <option key={v.name + v.fieldId} value={v.name}>
          {v.name}
        </option>
      ))}
    </select>
  );

  return (
    <div className="modal-mask" onMouseDown={props.onClose}>
      <div className="modal" onMouseDown={(e) => e.stopPropagation()}>
        <div className="modal-title">
        {`${store.panelTypeName(card.type)}${tx("设置", "Settings")} · ${card.name}`}
      </div>
      <Section title={tx("基础", "Basics")}>
        <div className="form-row">
          <label>{tx("名称", "Name")}</label>
          <TextInput value={card.name} onCommit={(v) => patch({ name: v })} />
          {card.type !== "keypad" && (
            <>
              <label>{tx("宽度", "Width")}</label>
              <select
                className="input"
                value={card.w}
                onChange={(e) => patch({ w: Number(e.target.value) })}
              >
                <option value={1}>{tx("1 格", "1 cell")}</option>
                <option value={2}>{tx("2 格", "2 cells")}</option>
              </select>
            </>
          )}
        </div>
      </Section>
      {card.type === "custom" && (
        <Section title={tx("卡片内容（自包含 HTML）", "Card Content (self-contained HTML)")}>
          <div className="form-col">
            <textarea
              className="input ctl-tpl-input ctl-script-input"
              rows={10}
              spellCheck={false}
              value={card.html}
              placeholder={tx(
                "粘贴 AI 生成的小部件 HTML（与 uartix-widget 同格式，支持 aiw:snap/aiw:send 桥）",
                "Paste AI-generated widget HTML (same format as uartix-widget, with aiw:snap/aiw:send bridge)",
              )}
              onChange={(e) => patch({ html: e.target.value })}
            />
          </div>
        </Section>
      )}
      {(card.type === "led" || card.type === "buzzer") && (
        <Section title={tx("触发条件", "Trigger")}>
          <div className="form-row">
            <label>{tx("变量", "Variable")}</label>
            {varSelect(card.varName, (v) => patch({ varName: v }))}
            <label>{tx("条件", "Condition")}</label>
            <select
              className="input"
              value={card.op}
              onChange={(e) => patch({ op: e.target.value })}
            >
              <option value="gt">&gt;</option>
              <option value="ge">≥</option>
              <option value="lt">&lt;</option>
              <option value="le">≤</option>
              <option value="eq">==</option>
              <option value="ne">!=</option>
            </select>
          </div>
          <div className="form-row">
            <label>{tx("数值", "Number")}</label>
            <NumInput value={card.value} width={72} onCommit={(v) => patch({ value: v })} />
            <label>{tx("字符串", "String")}</label>
            <TextInput
              value={card.strValue}
              onCommit={(v) => patch({ strValue: v })}
              placeholder={tx("字符串变量用此处", "for string variables")}
            />
            <label>{card.type === "buzzer" ? tx("触发色", "Trigger color") : tx("点亮色", "On color")}</label>
            <input
              type="color"
              className="color-input"
              value={card.onColor}
              onChange={(e) => patch({ onColor: e.target.value })}
            />
          </div>
        </Section>
      )}
      {card.type === "buzzer" && (
        <Section title={tx("声音", "Sound")}>
          <div className="form-row">
            <label>{tx("频率", "Frequency")}</label>
            <NumInput
              value={card.freq}
              width={72}
              onCommit={(v) => patch({ freq: Math.max(20, Math.min(20000, Math.round(v))) })}
            />
            <label>Hz</label>
          </div>
          <div className="form-row">
            <label>{tx("音量", "Volume")}</label>
            <input
              type="range"
              className="input"
              min={0}
              max={100}
              value={card.volume}
              onChange={(e) => patch({ volume: Number(e.target.value) })}
            />
            <label>{tx("时长", "Duration")}</label>
            <NumInput
              value={card.durationMs}
              width={64}
              onCommit={(v) => patch({ durationMs: Math.max(30, Math.min(5000, Math.round(v))) })}
            />
          </div>
          <div className="form-row">
            <label>{tx("循环鸣叫", "Repeat")}</label>
            <input
              type="checkbox"
              className="chk-box"
              title={tx("持续触发期间重复响", "Repeats while the trigger holds")}
              checked={card.repeat}
              onChange={(e) => patch({ repeat: e.target.checked })}
            />
            <label>{tx("间歇", "Gap")}</label>
            <NumInput
              value={card.gapMs ?? 300}
              width={64}
              onCommit={(v) => patch({ gapMs: Math.max(30, Math.min(10000, Math.round(v))) })}
              title={tx("两次鸣叫之间的间隔（ms），循环鸣叫时生效", "Gap between beeps (ms), used with repeat")}
            />
            <button
              className="btn"
              onClick={() => beep(card.freq, card.durationMs, (card.volume / 100) * 0.3)}
            >
              {tx("试听", "Preview")}
            </button>
          </div>
        </Section>
      )}
      {card.type === "monitor" && (
        <Section title={tx("显示", "Display")}>
          <div className="form-row">
            <label>{tx("变量", "Variable")}</label>
            {varSelect(card.varName, (v) => patch({ varName: v }))}
            <label>{tx("单位", "Unit")}</label>
            <TextInput value={card.unit} width={72} onCommit={(v) => patch({ unit: v })} />
            <label>{tx("小数位", "Decimals")}</label>
            <NumInput
              value={card.decimals}
              width={56}
              onCommit={(v) => patch({ decimals: Math.max(0, Math.min(8, v)) })}
            />
          </div>
        </Section>
      )}
      {card.type === "group" && (
        <Section
          title={tx("子控件", "Sub-controls")}
          tip={tx(
            "组合控件内可放置滑条、按钮、开关、监视与 LED 子项；滑条松手发送、按钮点击发送、开关切换发送。最多 8 个子项。",
            "A group card can hold sliders, buttons, switches, monitors and LED children; sliders send on release, buttons on click, switches on toggle. Up to 8 children.",
          )}
        >
          <div className="form-row">
            <label>{tx("发送格式", "Send format")}</label>
            <select
              className="input"
              value={card.sendMode}
              onChange={(e) => patch({ sendMode: e.target.value })}
            >
              <option value="ascii">ASCII</option>
              <option value="hex">HEX</option>
            </select>
            <label>{tx("添加", "Add")}</label>
            <select
              className="input"
              value=""
              onChange={(e) => {
                const kind = e.target.value as GroupChildKind;
                if (!kind) return;
                if (card.children.length >= 8) return;
                const ch = store.newGroupChild(kind);
                patch({ children: [...card.children, ch] });
              }}
            >
              <option value="">{tx("＋ 选择类型…", "＋ Add…")}</option>
              {(Object.keys(store.GROUP_KIND_LABEL) as GroupChildKind[]).map((k) => (
                <option key={k} value={k}>
                  {store.groupKindLabel(k)}
                </option>
              ))}
            </select>
          </div>
          {card.children.map((ch, i) => (
            <div className="form-col ctlg-cfg" key={ch.id}>
              <div className="form-row">
                <label>{store.groupKindLabel(ch.kind)}</label>
                <TextInput
                  value={ch.label}
                  width={90}
                  onCommit={(v) => {
                    const children = [...card.children];
                    children[i] = { ...ch, label: v };
                    patch({ children });
                  }}
                />
                {ch.kind === "led" && (
                  <>
                    <label>{tx("条件", "Condition")}</label>
                    <select
                      className="input"
                      value={ch.op}
                      onChange={(e) => {
                        const children = [...card.children];
                        children[i] = { ...ch, op: e.target.value as LedOp };
                        patch({ children });
                      }}
                    >
                      <option value="gt">&gt;</option>
                      <option value="ge">≥</option>
                      <option value="lt">&lt;</option>
                      <option value="le">≤</option>
                      <option value="eq">==</option>
                      <option value="ne">!=</option>
                    </select>
                  </>
                )}
                <button
                  className="btn danger-btn"
                  title="删除该子控件"
                  onClick={() =>
                    patch({ children: card.children.filter((x) => x.id !== ch.id) })
                  }
                >
                  ✕
                </button>
              </div>
              {(ch.kind === "slider" || ch.kind === "button") && (
                <div className="form-row">
                  <label>指令</label>
                  <TextInput
                    value={ch.template}
                    onCommit={(v) => {
                      const children = [...card.children];
                      children[i] = { ...ch, template: v };
                      patch({ children });
                    }}
                  />
                  {ch.kind === "slider" && (
                    <>
                      <label>{tx("范围", "Range")}</label>
                      <NumInput
                        value={ch.min}
                        width={56}
                        onCommit={(v) => {
                          const children = [...card.children];
                          children[i] = { ...ch, min: v };
                          patch({ children });
                        }}
                      />
                      <NumInput
                        value={ch.max}
                        width={56}
                        onCommit={(v) => {
                          const children = [...card.children];
                          children[i] = { ...ch, max: v };
                          patch({ children });
                        }}
                      />
                      <label>步进</label>
                      <NumInput
                        value={ch.step}
                        width={56}
                        onCommit={(v) => {
                          const children = [...card.children];
                          children[i] = { ...ch, step: v > 0 ? v : 1 };
                          patch({ children });
                        }}
                      />
                    </>
                  )}
                </div>
              )}
              {ch.kind === "switch" && (
                <div className="form-row">
                  <label>关/开指令</label>
                  <TextInput
                    value={ch.templates[0] ?? ""}
                    onCommit={(v) => {
                      const children = [...card.children];
                      const templates = [...ch.templates];
                      templates[0] = v;
                      children[i] = { ...ch, templates };
                      patch({ children });
                    }}
                  />
                  <TextInput
                    value={ch.templates[1] ?? ""}
                    onCommit={(v) => {
                      const children = [...card.children];
                      const templates = [...ch.templates];
                      templates[1] = v;
                      children[i] = { ...ch, templates };
                      patch({ children });
                    }}
                  />
                </div>
              )}
              {(ch.kind === "monitor" || ch.kind === "led") && (
                <div className="form-row">
                  <label>{tx("变量", "Variable")}</label>
                  {varSelect(ch.varName, (v) => {
                    const children = [...card.children];
                    children[i] = { ...ch, varName: v };
                    patch({ children });
                  })}
                  {ch.kind === "led" && (
                    <>
                      <label>{tx("数值", "Number")}</label>
                      <NumInput
                        value={ch.value}
                        width={56}
                        onCommit={(v) => {
                          const children = [...card.children];
                          children[i] = { ...ch, value: v };
                          patch({ children });
                        }}
                      />
                      <label>{tx("点亮色", "On color")}</label>
                      <input
                        type="color"
                        className="color-input"
                        value={ch.onColor}
                        onChange={(e) => {
                          const children = [...card.children];
                          children[i] = { ...ch, onColor: e.target.value };
                          patch({ children });
                        }}
                      />
                    </>
                  )}
                </div>
              )}
            </div>
          ))}
        </Section>
      )}
      {card.type === "keypad" && (
        <Section
          title={tx("键位与指令", "Keys & Commands")}
          tip={tx(
            "全局监听键位（焦点在输入框/菜单时不触发）。按下发送「按下指令」，松开发送「松开指令」（留空不发送）。四个方向共享一个脚本：脚本模式可用变量 dir（0上/1下/2左/3右）、dirName、phase（press/release）、key。",
            "Global key listening (paused while inputs/menus have focus). Press sends the press command, release sends the release command (empty = no send). All 4 directions share one script: script mode exposes dir (0 up/1 down/2 left/3 right), dirName, phase (press/release), key.",
          )}
        >
          {dirLabels().map((lbl, i) => (
            <div className="keypad-cfg-row" key={i}>
              <span className="kc-dir">{lbl}</span>
              <KeyCaptureInput
                value={card.keys[i]}
                onCommit={(v) => {
                  const a = [...card.keys];
                  a[i] = v;
                  patch({ keys: a });
                }}
              />
              <span className="kc-hint">{tx("按下", "Press")}</span>
              <TextInput
                value={card.templates[i]}
                onCommit={(v) => {
                  const a = [...card.templates];
                  a[i] = v;
                  patch({ templates: a });
                }}
              />
              <span className="kc-hint">{tx("松开", "Release")}</span>
              <TextInput
                value={card.releaseTemplates[i]}
                placeholder={tx("留空不发送", "empty = no send")}
                onCommit={(v) => {
                  const a = [...card.releaseTemplates];
                  a[i] = v;
                  patch({ releaseTemplates: a });
                }}
              />
            </div>
          ))}
        </Section>
      )}
      {card.type === "keymon" && (
        <Section
          title={tx("键位与指令", "Keys & Commands")}
          tip={tx(
            "全局监听键位（焦点在输入框/菜单时不触发）。按下发送「按下指令」，松开发送「松开指令」（留空不发送）。脚本模式可用变量 phase（press/release）、key。",
            "Global key listening (paused while inputs/menus have focus). Press sends the press command, release sends the release command (empty = no send). Script mode exposes phase (press/release) and key.",
          )}
        >
          <div className="keypad-cfg-row">
            <span className="kc-dir">{tx("键位", "Key")}</span>
            <KeyCaptureInput value={card.key} onCommit={(v) => patch({ key: v })} />
            <span className="kc-hint">{tx("按下", "Press")}</span>
            <TextInput value={card.template} onCommit={(v) => patch({ template: v })} />
            <span className="kc-hint">{tx("松开", "Release")}</span>
            <TextInput
              value={card.releaseTemplate}
              placeholder={tx("留空不发送", "empty = no send")}
              onCommit={(v) => patch({ releaseTemplate: v })}
            />
          </div>
        </Section>
      )}
      {hasScriptMode && (
        <Section title={tx("指令", "Command")}>
          <div className="form-row">
            <label>{tx("指令模式", "Command mode")}</label>
            <select
              className="input"
              value={card.useScript ? "script" : "template"}
              onChange={(e) => {
                const toScript = e.target.value === "script";
                // 键盘遥控切到脚本时默认填入 5 行示例，改键位名即可用
                if (
                  toScript &&
                  card.type === "keypad" &&
                  !card.script.trim()
                ) {
                  patch({
                    useScript: true,
                    script: DEFAULT_KEYPAD_SCRIPT,
                  });
                  return;
                }
                patch({ useScript: toScript });
              }}
            >
              <option value="template">{tx("模板串", "Template")}</option>
              <option value="script">{tx("脚本（类C）", "Script (C-like)")}</option>
            </select>
          </div>
          {card.type === "slider" && (
            <div className="form-row">
              <label>{tx("发送时机", "Send trigger")}</label>
              <select
                className="input"
                value={card.sendTrigger}
                onChange={(e) => patch({ sendTrigger: e.target.value })}
              >
                <option value="onRelease">{tx("松手时发送", "On release")}</option>
                <option value="continuous">{tx("连续发送（随拖动）", "Continuous (while dragging)")}</option>
              </select>
              <label>{tx("间隔", "Interval")}</label>
              <NumInput
                value={card.minIntervalMs}
                width={64}
                onCommit={(v) => patch({ minIntervalMs: Math.max(10, v) })}
                title={tx("连续发送最小间隔（ms）", "Minimum interval for continuous send (ms)")}
              />
            </div>
          )}
          {card.type === "button" && (
            <div className="form-row">
              <label>{tx("按住连发", "Hold repeat")}</label>
              <input
                type="checkbox"
                className="chk-box"
                checked={card.holdRepeat}
                onChange={(e) => patch({ holdRepeat: e.target.checked })}
              />
              <label>{tx("间隔", "Interval")}</label>
              <NumInput
                value={card.minIntervalMs}
                width={64}
                onCommit={(v) => patch({ minIntervalMs: Math.max(50, v) })}
              />
            </div>
          )}
          {card.type === "joystick" && (
            <div className="form-row">
              <label>{tx("松手回中", "Spring back")}</label>
              <input
                type="checkbox"
                className="chk-box"
                checked={card.springBack}
                onChange={(e) => patch({ springBack: e.target.checked })}
              />
            </div>
          )}
          {card.type === "slider" && !card.useScript && (
            <div className="form-col">
              <label>{tx("指令模板（%f %.2f %d，支持 {变量}）", "Template (%f %.2f %d, {var} supported)")}</label>
              <textarea
                className="input ctl-tpl-input"
                rows={2}
                value={card.template}
                onChange={(e) => patch({ template: e.target.value })}
              />
            </div>
          )}
          {card.type === "button" && !card.useScript && (
            <div className="form-col">
              <label>{tx("指令模板（%f %.2f %d，支持 {变量}）", "Template (%f %.2f %d, {var} supported)")}</label>
              <textarea
                className="input ctl-tpl-input"
                rows={2}
                value={card.template}
                onChange={(e) => patch({ template: e.target.value })}
              />
            </div>
          )}
          {card.type === "switch" && !card.useScript && (
            <div className="form-col">
              <label>{tx("每档指令", "Per-position commands")}</label>
              {card.templates.map((t, i) => (
                <input
                  key={i}
                  className="input ctl-tpl-input"
                  value={t}
                  placeholder={tx(`第 ${i + 1} 档指令（${card.labels[i] ?? i + 1}）`, `Command for position ${i + 1} (${card.labels[i] ?? i + 1})`)}
                  onChange={(e) => {
                    const arr = [...card.templates];
                    arr[i] = e.target.value;
                    patch({ templates: arr });
                  }}
                />
              ))}
            </div>
          )}
          {card.type === "joystick" && !card.useScript && (
            <div className="form-col">
              <label>{tx("指令模板（%x = X 通道，%y = Y 通道，支持 {变量}）", "Template (%x = X axis, %y = Y axis, {var} supported)")}</label>
              <textarea
                className="input ctl-tpl-input"
                rows={2}
                value={card.template}
                onChange={(e) => patch({ template: e.target.value })}
              />
            </div>
          )}
          {card.useScript && (
            <ScriptFields
              value={card.script}
              onCommit={(v) => patch({ script: v })}
              hint={
                card.type === "slider"
                  ? tx("脚本（变量 value = 当前滑条值；松手/连续触发）", "Script (value = slider position; release/continuous)")
                  : card.type === "switch"
                    ? tx("脚本（变量 state = 档位序号, label = 档名）", "Script (state = position index, label = position name)")
                    : card.type === "joystick"
                      ? tx("脚本（变量 x / y = 摇杆输出）", "Script (x / y = joystick output)")
                      : tx("脚本（点击时执行）", "Script (runs on click)")
              }
            />
          )}
        </Section>
      )}
      {(card.type === "slider" || card.type === "switch") && (
        <Section title={tx("参数", "Parameters")} defaultOpen={false}>
          {card.type === "slider" && (
            <div className="form-row">
              <div className="form-pair">
                <label>{tx("最小", "Min")}</label>
                <NumInput value={card.min} width={72} onCommit={(v) => patch({ min: v })} />
              </div>
              <div className="form-pair">
                <label>{tx("最大", "Max")}</label>
                <NumInput value={card.max} width={72} onCommit={(v) => patch({ max: v })} />
              </div>
              <div className="form-pair">
                <label>{tx("步进", "Step")}</label>
                <NumInput
                  value={card.step}
                  width={72}
                  onCommit={(v) => patch({ step: v > 0 ? v : 1 })}
                />
              </div>
              <div className="form-pair">
                <label>{tx("默认值", "Default")}</label>
                <NumInput
                  value={card.defaultValue}
                  width={72}
                  onCommit={(v) => patch({ defaultValue: v })}
                />
              </div>
            </div>
          )}
          {card.type === "switch" && (
            <>
              <div className="form-row">
                <label>{tx("档位数", "Positions")}</label>
                <select
                  className="input"
                  value={card.positions}
                  onChange={(e) => {
                    const positions = Number(e.target.value) as 2 | 3;
                    const templates = [...card.templates];
                    const labels = [...card.labels];
                    while (templates.length < positions) templates.push("");
                    while (labels.length < positions) labels.push("");
                    patch({ positions, templates, labels });
                  }}
                >
                  <option value={2}>{tx("2 档", "2 positions")}</option>
                  <option value={3}>{tx("3 档", "3 positions")}</option>
                </select>
              </div>
              <div className="form-row">
                {card.labels.map((l, i) => (
                  <div className="form-pair" key={i}>
                    <label>{tx(`档${i + 1}名`, `Label ${i + 1}`)}</label>
                    <TextInput
                      value={l}
                      width={72}
                      onCommit={(v) => {
                        const labels = [...card.labels];
                        labels[i] = v;
                        patch({ labels });
                      }}
                    />
                  </div>
                ))}
              </div>
            </>
          )}
        </Section>
      )}
      <div className="modal-foot">
          <button className="btn danger-btn" onClick={props.onDelete}>
            {tx("删除该卡片", "Delete card")}
          </button>
          <button className="btn primary" onClick={props.onClose}>
            {tx("完成", "Done")}
          </button>
        </div>
      </div>
    </div>
  );
}
