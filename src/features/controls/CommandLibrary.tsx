import { useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore } from "react";
import { createPortal } from "react-dom";
import * as commandStore from "./commandStore";
import { isGroup } from "./commandStore";
import type { CommandItem } from "./commandStore";
import type { SendMode } from "./controlsStore";
import { useSettings } from "../settings/settingsStore";
import { bakeReferenceFrame, runCommand } from "./cmdExec";
import * as sendStore from "../send/sendStore";
import { TextInput } from "../protocol/PropertiesPanel";
import { IconChevron, IconClose } from "../../shared/icons";
import { HelpHint } from "../../shared/HelpHint";
import { tx, useLocale } from "../../i18n/strings";
import { attachPdragZone, beginPointerDrag } from "../../shared/pointerDrag";

/**
 * P104-R3 命令库：从控制画布的抽屉（`sideTab === "commands"`）整块搬进左侧导轨「命令」项。
 *
 * 树本身、拖拽排序、单击发送、双击编辑、右键菜单、命令设置弹窗——全部逐字搬过来，
 * 只改了三件事，且每一件都写在这里：
 *  1. 发送/跑脚本改调 `cmdExec`（画布上的卡片与这里的命令行共用同一份实现）；
 *  2. 错误面从画布的 `.ctl-err` 换成库自己的底部一行（画布不在这里，错误不该往那边喊）；
 *  3. 抽屉的 `sideTab` / 190px 可拖宽没了——导轨二级面板就是它的落位，宽度由壳统一给。
 *
 * `treeRef` 上那块 `attachPdragZone("vs-cmd vs-group")` 是**树内排序**的落点，
 * 与画布上的 `vs-cmd` 落点（把命令拖成卡片）是两个区、各管各的：
 * 拖到树里 = 换顺序，拖到画布 = 建卡片。内核按 `elementsFromPoint` 找最深命中区，
 * 所以两者互不干扰，这一点在搬之前是靠在 `sideTab` 上挂 effect 生效的。
 */
export function CommandLibrary() {
  useLocale(); // 面板根组件的口径：这一面的话术是 tx() 出来的，切语言要有人重渲染
  const cmds = useSyncExternalStore(commandStore.subscribe, commandStore.getSnapshot);
  // 浮层定位要按缩放换算：CSS zoom 下 getBoundingClientRect 给的是视觉 px，
  // 而浮层 left/top 写的是逻辑 px（B1 修的那批坐标账，这里是同一笔）。
  const zfactor = (useSettings().zoom || 100) / 100;
  const [err, setErr] = useState<string | null>(null);

  const [editingCmd, setEditingCmd] = useState<string | null>(null);
  const [renamingNode, setRenamingNode] = useState<string | null>(null);
  const [collapsedGroups, setCollapsedGroups] = useState<Set<string>>(new Set());
  const [flashCmd, setFlashCmd] = useState<string | null>(null);
  const [cmdMenu, setCmdMenu] = useState<{ id: string; x: number; y: number } | null>(null);
  const [cmdMenuPos, setCmdMenuPos] = useState<{ left: number; top: number } | null>(null);
  const cmdMenuRef = useRef<HTMLDivElement | null>(null);
  const [groupMenuId, setGroupMenuId] = useState<string | null>(null);
  const [dropTarget, setDropTarget] = useState<{
    id: string;
    pos: "before" | "after" | "into";
  } | null>(null);
  const dragNodeRef = useRef<{ id: string; kind: "cmd" | "group" } | null>(null);
  const dropPosRef = useRef<{ id: string; pos: "before" | "after" | "into" } | null>(null);

  const doMove = (
    dragId: string,
    refId: string,
    pos: "before" | "after" | "into",
  ): boolean => {
    if (pos === "into") {
      if (commandStore.moveNode(dragId, refId)) return true;
      setErr(tx("不能移动到自己的子分组内", "Cannot move a group into itself"));
      return false;
    }
    const parent = commandStore.parentOfId(refId) ?? null;
    if (commandStore.moveNode(dragId, parent, refId, pos === "before"))
      return true;
    if (parent !== null && commandStore.moveNode(dragId, parent)) return true;
    return false;
  };

  useEffect(() => {
    if (!groupMenuId) return;
    const close = () => setGroupMenuId(null);
    window.addEventListener("click", close);
    return () => window.removeEventListener("click", close);
  }, [groupMenuId]);

  useEffect(() => {
    if (!cmdMenu) return;
    const close = () => setCmdMenu(null);
    window.addEventListener("click", close);
    return () => window.removeEventListener("click", close);
  }, [cmdMenu]);

  useLayoutEffect(() => {
    if (!cmdMenu || !cmdMenuRef.current) return;
    const r = cmdMenuRef.current.getBoundingClientRect();
    const zf = zfactor || 1;
    const w = r.width / zf;
    const h = r.height / zf;
    const vw = window.innerWidth / zf;
    const vh = window.innerHeight / zf;
    const left = Math.max(8, Math.min(cmdMenu.x / zf, vw - w - 8));
    let top = cmdMenu.y / zf;
    if (top + h > vh - 8) top = Math.max(8, vh - h - 8);
    setCmdMenuPos({ left, top });
  }, [cmdMenu, zfactor]);

  const dragEnd = () => {
    dragNodeRef.current = null;
    dropPosRef.current = null;
    setDropTarget(null);
  };

  const treeRef = useRef<HTMLDivElement | null>(null);
  const treeOverRef = useRef<(d: { x: number; y: number }) => void>(() => {});
  const treeDropRef = useRef<() => void>(() => {});
  useEffect(() => {
    const el = treeRef.current;
    if (!el) return;
    return attachPdragZone(el, {
      kinds: "vs-cmd vs-group",
      onOver: (dd) => treeOverRef.current(dd),
      onLeave: () => {
        dropPosRef.current = null;
        setDropTarget(null);
      },
      onDrop: () => treeDropRef.current(),
    });
  }, []);

  treeOverRef.current = (d) => {
    const row = document
      .elementFromPoint(d.x, d.y)
      ?.closest(".cmd-group-head,.cmd-item") as HTMLElement | null;
    const src = dragNodeRef.current;
    const nodeId = row?.getAttribute("data-node-id") ?? null;
    if (!row || !src || !nodeId || nodeId === src.id) {
      if (dropPosRef.current) {
        dropPosRef.current = null;
        setDropTarget(null);
      }
      return;
    }
    const r = row.getBoundingClientRect();
    let pos: "before" | "after" | "into";
    if (row.classList.contains("cmd-group-head")) {
      const t = (d.y - r.top) / Math.max(1, r.height);
      pos = t < 0.33 ? "before" : t > 0.67 ? "after" : "into";
    } else {
      pos = d.y > r.top + r.height / 2 ? "after" : "before";
    }
    dropPosRef.current = { id: nodeId, pos };
    setDropTarget((p) => (p && p.id === nodeId && p.pos === pos ? p : { id: nodeId, pos }));
  };
  treeDropRef.current = () => {
    const dt = dropPosRef.current;
    const src = dragNodeRef.current;
    dragEnd();
    if (!src) return;
    if (dt && src.id !== dt.id) {
      doMove(src.id, dt.id, dt.pos);
      return;
    }
    if (!dt) {
      if (!commandStore.moveNode(src.id, null)) setErr(tx("无法移动", "Cannot move"));
    }
  };

  const renderCmdTree = (items: commandStore.CommandNode[], depth: number) => (
    <>
      {items.map((n) => {
        if (isGroup(n)) {
          const collapsed = collapsedGroups.has(n.id);
          return (
            <div key={n.id} className="cmd-group" style={{ marginLeft: depth ? 10 : 0 }}>
              <div
                className={`cmd-group-head${
                  dropTarget && dropTarget.id === n.id
                    ? dropTarget.pos === "into"
                      ? " drop-into"
                      : dropTarget.pos === "before"
                        ? " drop-before"
                        : " drop-after"
                    : ""
                }`}
                data-node-id={n.id}
                onPointerDown={(e) => {
                  if (renamingNode === n.id || e.button !== 0) return;
                  dragNodeRef.current = { id: n.id, kind: "group" };
                  beginPointerDrag(e, {
                    kind: "vs-group",
                    data: n.id,
                    label: n.name,
                    sub: tx("分组", "group"),
                    onEnd: dragEnd,
                  });
                }}
              >
                <button
                  className="cmd-fold"
                  title={collapsed ? tx("展开", "Expand") : tx("折叠", "Collapse")}
                  onClick={() => {
                    const next = new Set(collapsedGroups);
                    if (collapsed) next.delete(n.id);
                    else next.add(n.id);
                    setCollapsedGroups(next);
                  }}
                >
                  <IconChevron size={13} dir={collapsed ? "right" : "down"} />
                </button>
                <span
                  className="cmd-group-name"
                  onDoubleClick={() => setRenamingNode(n.id)}
                >
                  {renamingNode === n.id ? (
                    <input
                      className="input ctl-tab-rename"
                      autoFocus
                      defaultValue={n.name}
                      onClick={(e) => e.stopPropagation()}
                      onBlur={(e) => {
                        commandStore.renameNode(n.id, e.target.value.trim() || n.name);
                        setRenamingNode(null);
                      }}
                      onKeyDown={(e) => {
                        if (e.key === "Enter") {
                          commandStore.renameNode(
                            n.id,
                            (e.target as HTMLInputElement).value.trim() || n.name,
                          );
                          setRenamingNode(null);
                        }
                        if (e.key === "Escape") setRenamingNode(null);
                      }}
                    />
                  ) : (
                    n.name
                  )}
                </span>
                <button
                  className="cmd-add-toggle"
                  title={tx("添加命令 / 子分组", "Add command / subgroup")}
                  onClick={(e) => {
                    e.stopPropagation();
                    setGroupMenuId(groupMenuId === n.id ? null : n.id);
                  }}
                >
                  ＋<IconChevron size={12} dir="down" />
                </button>
                {groupMenuId === n.id && (
                  <div
                    className="cmd-group-menu"
                    onClick={(e) => e.stopPropagation()}
                  >
                    <button
                      onClick={() => {
                        commandStore.addCommand(n.id);
                        setGroupMenuId(null);
                      }}
                    >
                      {tx("＋ 添加命令", "＋ Add command")}
                    </button>
                    <button
                      onClick={() => {
                        commandStore.addGroup(tx("子分组", "Subgroup"), n.id);
                        setGroupMenuId(null);
                      }}
                    >
                      {tx("＋ 添加子分组", "＋ Add subgroup")}
                    </button>
                  </div>
                )}
                <button title={tx("删除分组", "Delete group")} onClick={() => commandStore.removeNode(n.id)}><IconClose /></button>
              </div>
              {!collapsed &&
                (renamingNode === n.id ? null : renderCmdTree(n.items, depth + 1))}
            </div>
          );
        }
        const editing = editingCmd === n.id;
        return (
          <div key={n.id} className="cmd-item-wrap" style={{ marginLeft: depth ? 10 : 0 }}>
            <div
              className={`cmd-item ${n.scriptEnabled && n.script ? "script" : ""} ${flashCmd === n.id ? "flash" : ""} ${
                dropTarget && dropTarget.id === n.id
                  ? dropTarget.pos === "before"
                    ? " drop-before"
                    : " drop-after"
                  : ""
              }`}
              data-node-id={n.id}
              onPointerDown={(e) => {
                if (e.button !== 0) return;
                dragNodeRef.current = { id: n.id, kind: "cmd" };
                beginPointerDrag(e, {
                  kind: "vs-cmd",
                  data: JSON.stringify({
                    nodeId: n.id,
                    template: n.template,
                    sendMode: n.sendMode,
                    script: n.script,
                    scriptEnabled: n.scriptEnabled,
                    // 引用式命令拖成卡片要带走的是**引用**：不带这个字段，
                    // 拖过去就是一张空模板卡（详设 §1.4 那个"拷死字节"的病换了个入口复发）
                    sendTemplateId: n.sendTemplateId,
                    name: n.name,
                  }),
                  label: n.name,
                  sub: tx("命令", "command"),
                  onEnd: dragEnd,
                });
              }}
              onClick={() => {
                runCommand(n)
                  .then(() => setErr(null))
                  .catch((er) => setErr(String(er)));
                setFlashCmd(n.id);
                window.setTimeout(() => setFlashCmd(null), 500);
              }}
              onDoubleClick={() => setEditingCmd(editing ? null : n.id)}
              onContextMenu={(e) => {
                e.preventDefault();
                e.stopPropagation();
                setCmdMenuPos(null);
                setCmdMenu({ id: n.id, x: e.clientX, y: e.clientY });
              }}
              title={tx("单击发送 · 双击编辑 · 右键更多 · 可拖到画布部署", "Click to send · double-click to edit · right-click for more · drag onto the canvas to place it")}
            >
              <span className="cmd-item-name">{n.name}</span>
              <span className="cmd-item-tpl">
                {n.scriptEnabled && n.script ? tx("⚡脚本", "⚡ script") : n.sendTemplateId ? tx("📐 发送谱引用", "📐 template reference") : n.template}
              </span>
              <button
                className="cmd-edit"
                title={tx("编辑命令", "Edit command")}
                onClick={(e) => {
                  e.stopPropagation();
                  setEditingCmd(editing ? null : n.id);
                }}
              >
                ✎
              </button>
            </div>
            {editing && <div className="cmd-edit-hint">{tx("编辑中…（弹窗）", "Editing… (dialog)")}</div>}
          </div>
        );
      })}
    </>
  );

  const editCmdItem = editingCmd
    ? commandStore.getCommand(editingCmd)
    : null;

  return (
    <>
      <div className="cmd-tree" ref={treeRef}>
        <div className="cmd-toolbar">
          <button
            className="btn"
            onClick={() => commandStore.addGroup(tx(`分组${cmds.groups.length + 1}`, `Group ${cmds.groups.length + 1}`))}
          >
            {tx("＋ 分组", "＋ Group")}
          </button>
        </div>
        {renderCmdTree(cmds.groups, 0)}
        <div className="widget-hint">
          {tx("单击发送 · 双击编辑 · 拖到画布部署", "Click to send · double-click to edit · drag onto canvas")}
          <HelpHint text={tx(
            "命令支持 {变量} 插值与解析变量；脚本 API：await send(text, mode?) · beep(freq, ms) · await delay_ms(ms) · get(“变量”) · set(“变量”, 值) · await waitParse(“字段”, ms?) · setControl(“控件名”, 值) 联动触发其他控件 · await repeat(n, i => …) · log(text)。完整 JS 语法可用，详见 帮助 → 脚本命令详解。",
            "Commands support {var} interpolation and parsed variables; script API: await send(text, mode?) · beep(freq, ms) · await delay_ms(ms) · get(name) · set(name, value) · await waitParse(field, ms?) · setControl(cardName, value) to trigger other controls · await repeat(n, i => …) · log(text). Full JS syntax available — see Help → Script Commands.",
          )} />
        </div>
      </div>
      {err && <div className="lib-err">{err}</div>}

      {cmdMenu &&
        createPortal(
          <div
            ref={cmdMenuRef}
            className="ctx-menu"
            style={{
              left: cmdMenuPos?.left ?? -9999,
              top: cmdMenuPos?.top ?? -9999,
              visibility: cmdMenuPos ? "visible" : "hidden",
            }}
            onContextMenu={(e) => e.preventDefault()}
            onClick={(e) => e.stopPropagation()}
          >
            {(() => {
              const node = commandStore.getCommand(cmdMenu.id);
              if (!node) return null;
              return (
                <>
                  <div className="ctx-title">{node.name}</div>
                  <button
                    className="ctx-item"
                    onClick={() => {
                      setEditingCmd(cmdMenu.id);
                      setCmdMenu(null);
                    }}
                  >
                    {tx("编辑…", "Edit…")}
                  </button>
                  <button
                    className="ctx-item danger"
                    onClick={() => {
                      commandStore.removeNode(cmdMenu.id);
                      setCmdMenu(null);
                    }}
                  >
                    {tx("删除命令", "Delete command")}
                  </button>
                </>
              );
            })()}
          </div>,
          document.body,
        )}

      {editCmdItem && (
        <CommandModal
          key={editCmdItem.id}
          item={editCmdItem}
          onClose={() => setEditingCmd(null)}
          onDelete={() => {
            commandStore.removeNode(editCmdItem.id);
            setEditingCmd(null);
          }}
        />
      )}
    </>
  );
}

/** 命令设置弹窗：随命令库一起从 ControlCanvas 搬过来（它只被这里用）。 */
function CommandModal(props: {
  item: CommandItem;
  onClose: () => void;
  onDelete: () => void;
}) {
  const { item } = props;
  useLocale();
  const scriptOn = item.scriptEnabled;
  const specName = item.sendTemplateId ? sendStore.getTemplate(item.sendTemplateId)?.name : undefined;
  return (
    <div className="modal-mask" role="dialog" aria-modal="true" onMouseDown={props.onClose}>
      <div className="modal" onMouseDown={(e) => e.stopPropagation()}>
        <div className="modal-title">{`${tx("命令设置", "Command Settings")} · ${item.name}`}</div>
        <div className="form-row">
          <label>{tx("名称", "Name")}</label>
          <TextInput
            value={item.name}
            onCommit={(v) => commandStore.patchCommand(item.id, { name: v })}
          />
          <label>{tx("模式", "Mode")}</label>
          <select
            className="input"
            value={item.sendMode}
            onChange={(e) =>
              commandStore.patchCommand(item.id, {
                sendMode: e.target.value as SendMode,
              })
            }
          >
            <option value="ascii">ASCII</option>
            <option value="hex">Hex</option>
          </select>
        </div>
        <div className="form-row">
          <label>{tx("脚本指令", "Script Command")}</label>
          <label className="chk">
            <input
              type="checkbox"
              className="chk-box"
              checked={scriptOn}
              onChange={(e) =>
                commandStore.patchCommand(item.id, {
                  scriptEnabled: e.target.checked,
                })
              }
            />
            {tx("优先执行脚本（隐藏指令模板）", "Run script first (hide template)")}
          </label>
        </div>
        {item.sendTemplateId ? (
          <div className="form-row">
            <label>{tx("发送谱", "Template")}</label>
            <div className="cmd-hint">
              {specName
                ? tx(
                    "这条命令不存字节：点它 = 发「{n}」此刻算出来的一帧，改那张谱这条命令跟着变。".replace(
                      "{n}",
                      specName,
                    ),
                    "This command stores no bytes: clicking it sends whatever “{n}” computes right now — edit the spec and this follows.".replace(
                      "{n}",
                      specName,
                    ),
                  )
                : tx(
                    "引用的发送谱已被删除：这条命令发不出去。清除引用后自己写字节，或回「TX组帧台」重新存一条。",
                    "The referenced send template was deleted: this command cannot send. Clear the reference and type the bytes, or save it again from the send builder.",
                  )}
            </div>
            {specName ? (
              <button
                className="btn"
                onClick={() => {
                  const hex = bakeReferenceFrame(item);
                  if (!hex) return;
                  commandStore.patchCommand(item.id, {
                    template: hex,
                    sendTemplateId: undefined,
                    overrides: undefined,
                  });
                }}
              >
                {tx("断开引用：存成固定字节", "Detach: freeze into bytes")}
              </button>
            ) : (
              <button
                className="btn"
                onClick={() =>
                  commandStore.patchCommand(item.id, { sendTemplateId: undefined, overrides: undefined })
                }
              >
                {tx("清除引用：自己写字节", "Clear the reference: type the bytes")}
              </button>
            )}
            <div className="cmd-hint">
              {tx(
                "断开之后长度不再回填、校验不再重算、自增序号定死在这一帧——想跟着谱走就别断开。",
                "Once detached, lengths stop auto-filling, the checksum stops recomputing and the sequence number freezes on this frame.",
              )}
            </div>
          </div>
        ) : (
          !scriptOn && (
          <>
            <div className="form-row">
              <label>{tx("指令模板", "Template")}</label>
              <textarea
                className="input ctl-tpl-input cmd-ta"
                rows={5}
                value={item.template}
                placeholder={"VRp=%.2f!"}
                onChange={(e) =>
                  commandStore.patchCommand(item.id, { template: e.target.value })
                }
              />
            </div>
            <div className="cmd-hint">
                {tx(
                  "语法：{变量} 引用解析出的数据，可带格式后缀（{速度:d} 取整、{速度:.2f} 两位小数、{速度:str} 原文）；%d 这类 printf 占位**只在滑条卡片上**替换，命令库点击发送不认",
                  "Syntax: {var} references parsed values, with optional format suffixes ({speed:d} integer, {speed:.2f} two decimals, {speed:str} raw). printf placeholders like %d are substituted only on slider cards — clicking a command here does not.",
                )}
              </div>
          </>
          )
        )}
        {scriptOn && (
          <>
            <div className="form-row">
              <label>{tx("脚本", "Script")}</label>
              <textarea
                className="input ctl-tpl-input ctl-script-input cmd-ta"
                rows={5}
                spellCheck={false}
                value={item.script}
                placeholder={
                  'if (Roll > 45) {\n  await send("ALARM:high!");\n  beep(880, 200);\n}'
                }
                onChange={(e) =>
                  commandStore.patchCommand(item.id, { script: e.target.value })
                }
              />
            </div>
            <div className="cmd-hint">
              {tx(
                "API：await send(text, mode?) · beep(freq, ms) · await delay_ms(ms) · get(变量) · await waitParse(字段, ms) · set(变量, 值) · setControl(控件, 值) · await repeat(n, i=>…) · log(文本)；完整 JS 语法可用（for/while/if）；解析字段名可直接当变量使用",
                "API: await send(text, mode?) · beep(freq, ms) · await delay_ms(ms) · get(name) · await waitParse(field, ms) · set(name, value) · setControl(card, value) · await repeat(n, i=>…) · log(text); full JS syntax (for/while/if); parsed field names work as variables",
              )}
            </div>
          </>
        )}
        <div className="form-row">
          <label>{tx("备注", "Note")}</label>
          <TextInput
            value={item.note}
            onCommit={(v) => commandStore.patchCommand(item.id, { note: v })}
          />
        </div>
        <div className="modal-foot">
          <button
            className="btn danger-btn"
            onClick={() => {
              commandStore.removeNode(item.id);
              props.onClose();
            }}
          >
            {tx("删除命令", "Delete command")}
          </button>
          <button className="btn primary" onClick={props.onClose}>
            {tx("完成", "Done")}
          </button>
        </div>
      </div>
    </div>
  );
}
