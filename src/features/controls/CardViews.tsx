import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import * as store from "./controlsStore";
import type {
  BuzzerCard,
  ButtonCard,
  ControlCard,
  JoystickCard,
  LedCard,
  LedOp,
  MonitorCard,
  SendMode,
  SliderCard,
  SwitchCard,
} from "./controlsStore";
import * as variableStore from "./variableStore";
import { beep } from "./scriptRunner";
import { NumInput, TextInput } from "../protocol/PropertiesPanel";
import { Section } from "../../shared/Section";

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
          title="拖拽调整卡片大小"
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
        <span className="ctl-name" title="右键更多操作">
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
    const t = window.setInterval(
      () => beep(card.freq, card.durationMs, vol),
      card.durationMs + 150,
    );
    return () => window.clearInterval(t);
  }, [on, card.repeat, card.freq, card.durationMs, vol]);
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
      <label>{hint}</label>
      <textarea
        className="input ctl-tpl-input ctl-script-input"
        rows={8}
        spellCheck={false}
        value={value}
        onChange={(e) => onCommit(e.target.value)}
      />
      <div className="form-hint">
        API：await send(text, mode?) · beep(freq, ms) · await delay_ms(ms) ·
        get("变量") · await waitParse(字段, ms) · set(变量, 值) ·
        setControl(控件, 值) · await repeat(n, i=&gt;…) · log(文本)；完整 JS
        语法可用（for/while/if）；解析字段名可直接当变量使用
      </div>
    </div>
  );
}

export function CardModal(props: {
  card: ControlCard;
  pageId: string;
  onClose: () => void;
  onDelete: () => void;
}) {
  const { card } = props;
  useSyncExternalStore(variableStore.subscribe, variableStore.getSnapshot);
  const vars = variableStore.listVars();
  const patch = (p: Record<string, unknown>) =>
    store.patchCard(props.pageId, card.id, p);

  const hasScriptMode =
    card.type === "slider" ||
    card.type === "button" ||
    card.type === "switch" ||
    card.type === "joystick";

  const varSelect = (
    value: string,
    onCommit: (v: string) => void,
  ) => (
    <select
      className="input"
      value={value}
      onChange={(e) => onCommit(e.target.value)}
    >
      <option value="">— 选择变量 —</option>
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
        {store.PANEL_TYPE_NAMES[card.type]}设置 · {card.name}
      </div>
      <Section title="基础">
        <div className="form-row">
          <label>名称</label>
          <TextInput value={card.name} onCommit={(v) => patch({ name: v })} />
          <label>宽度</label>
          <select
            className="input"
            value={card.w}
            onChange={(e) => patch({ w: Number(e.target.value) })}
          >
            <option value={1}>1 格</option>
            <option value={2}>2 格</option>
          </select>
        </div>
      </Section>
      {(card.type === "led" || card.type === "buzzer") && (
        <Section title="触发条件">
          <div className="form-row">
            <label>变量</label>
            {varSelect(card.varName, (v) => patch({ varName: v }))}
            <label>条件</label>
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
            <label>数值</label>
            <NumInput value={card.value} width={72} onCommit={(v) => patch({ value: v })} />
            <label>字符串</label>
            <TextInput
              value={card.strValue}
              onCommit={(v) => patch({ strValue: v })}
              placeholder="字符串变量用此处"
            />
            <label>{card.type === "buzzer" ? "触发色" : "点亮色"}</label>
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
        <Section title="声音">
          <div className="form-row">
            <label>频率</label>
            <NumInput
              value={card.freq}
              width={72}
              onCommit={(v) => patch({ freq: Math.max(20, Math.min(20000, Math.round(v))) })}
            />
            <label>Hz</label>
          </div>
          <div className="form-row">
            <label>音量</label>
            <input
              type="range"
              className="input"
              min={0}
              max={100}
              value={card.volume}
              onChange={(e) => patch({ volume: Number(e.target.value) })}
            />
            <label>时长</label>
            <NumInput
              value={card.durationMs}
              width={64}
              onCommit={(v) => patch({ durationMs: Math.max(30, Math.min(5000, Math.round(v))) })}
            />
          </div>
          <div className="form-row">
            <label>循环鸣叫</label>
            <input
              type="checkbox"
              className="chk-box"
              title="持续触发期间重复响"
              checked={card.repeat}
              onChange={(e) => patch({ repeat: e.target.checked })}
            />
            <button
              className="btn"
              onClick={() => beep(card.freq, card.durationMs, (card.volume / 100) * 0.3)}
            >
              试听
            </button>
          </div>
        </Section>
      )}
      {card.type === "monitor" && (
        <Section title="显示">
          <div className="form-row">
            <label>变量</label>
            {varSelect(card.varName, (v) => patch({ varName: v }))}
            <label>单位</label>
            <TextInput value={card.unit} width={72} onCommit={(v) => patch({ unit: v })} />
            <label>小数位</label>
            <NumInput
              value={card.decimals}
              width={56}
              onCommit={(v) => patch({ decimals: Math.max(0, Math.min(8, v)) })}
            />
          </div>
        </Section>
      )}
      {hasScriptMode && (
        <Section title="指令">
          <div className="form-row">
            <label>指令模式</label>
            <select
              className="input"
              value={card.useScript ? "script" : "template"}
              onChange={(e) => patch({ useScript: e.target.value === "script" })}
            >
              <option value="template">模板串</option>
              <option value="script">脚本（类C）</option>
            </select>
          </div>
          {card.type === "slider" && (
            <div className="form-row">
              <label>发送时机</label>
              <select
                className="input"
                value={card.sendTrigger}
                onChange={(e) => patch({ sendTrigger: e.target.value })}
              >
                <option value="onRelease">松手时发送</option>
                <option value="continuous">连续发送（随拖动）</option>
              </select>
              <label>间隔</label>
              <NumInput
                value={card.minIntervalMs}
                width={64}
                onCommit={(v) => patch({ minIntervalMs: Math.max(10, v) })}
                title="连续发送最小间隔（ms）"
              />
            </div>
          )}
          {card.type === "button" && (
            <div className="form-row">
              <label>按住连发</label>
              <input
                type="checkbox"
                className="chk-box"
                checked={card.holdRepeat}
                onChange={(e) => patch({ holdRepeat: e.target.checked })}
              />
              <label>间隔</label>
              <NumInput
                value={card.minIntervalMs}
                width={64}
                onCommit={(v) => patch({ minIntervalMs: Math.max(50, v) })}
              />
            </div>
          )}
          {card.type === "joystick" && (
            <div className="form-row">
              <label>松手回中</label>
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
              <label>指令模板（%f %.2f %d，支持 {"{变量}"}）</label>
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
              <label>指令模板（%f %.2f %d，支持 {"{变量}"}）</label>
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
              <label>每档指令</label>
              {card.templates.map((t, i) => (
                <input
                  key={i}
                  className="input ctl-tpl-input"
                  value={t}
                  placeholder={`第 ${i + 1} 档指令（${card.labels[i] ?? i + 1}）`}
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
              <label>指令模板（%x = X 通道，%y = Y 通道，支持 {"{变量}"}）</label>
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
                  ? "脚本（变量 value = 当前滑条值；松手/连续触发）"
                  : card.type === "switch"
                    ? "脚本（变量 state = 档位序号, label = 档名）"
                    : card.type === "joystick"
                      ? "脚本（变量 x / y = 摇杆输出）"
                      : "脚本（点击时执行）"
              }
            />
          )}
        </Section>
      )}
      {(card.type === "slider" || card.type === "switch") && (
        <Section title="参数" defaultOpen={false}>
          {card.type === "slider" && (
            <div className="form-row">
              <div className="form-pair">
                <label>最小</label>
                <NumInput value={card.min} width={72} onCommit={(v) => patch({ min: v })} />
              </div>
              <div className="form-pair">
                <label>最大</label>
                <NumInput value={card.max} width={72} onCommit={(v) => patch({ max: v })} />
              </div>
              <div className="form-pair">
                <label>步进</label>
                <NumInput
                  value={card.step}
                  width={72}
                  onCommit={(v) => patch({ step: v > 0 ? v : 1 })}
                />
              </div>
              <div className="form-pair">
                <label>默认值</label>
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
                <label>档位数</label>
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
                  <option value={2}>2 档</option>
                  <option value={3}>3 档</option>
                </select>
              </div>
              <div className="form-row">
                {card.labels.map((l, i) => (
                  <div className="form-pair" key={i}>
                    <label>档{i + 1}名</label>
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
            删除该卡片
          </button>
          <button className="btn primary" onClick={props.onClose}>
            完成
          </button>
        </div>
      </div>
    </div>
  );
}
