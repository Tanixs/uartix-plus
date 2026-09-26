import { beginPointerDrag } from "../../shared/pointerDrag";
import { WIDGET_ICONS } from "../../shared/icons";
import { HelpHint } from "../../shared/HelpHint";
import { tx, useLocale } from "../../i18n/strings";
import * as store from "./controlsStore";
import type { ControlType } from "./controlsStore";

/**
 * P104-R3 控件库：从控制画布的抽屉（`sideTab === "widgets"`）整块搬进左侧导轨「控件」项。
 *
 * 搬的理由和 B8 给字段图例的一样：**库在左，视图在中间**。
 * 抽屉是面板内的第二层导航——要用控件得先开控制画布、再点侧栏钮、再点 Tab，
 * 而"拖一个滑条到画布"是这条链子上唯一真正高频的动作。
 *
 * 代码是**搬**过来的不是重写的。P97-I5 立的规矩是"加一种控件忘了配名字 = 编译错误"，
 * 原先靠 `satisfies Record<ControlType, string>` 生效；P105-F 补英文后换成下面这个
 * **不写 default 的 switch**（少一个取值就是 TS2366）—— 同一道钉子，只是换了一种形状，
 * 因为门只认 `tx("中文", "English")` 这种"双语就在调用点上"的写法，两张并列的表对它是不透明的。
 * 列的顺序仍由 `store.CONTROL_TYPES` 给（那份清单也是 `ui_inventory` 用的唯一来源）。
 */
function widgetLabel(type: ControlType): string {
  switch (type) {
    case "slider": return tx("滑条", "Slider");
    case "button": return tx("按钮", "Button");
    case "switch": return tx("开关", "Switch");
    case "led": return tx("LED 灯", "LED");
    case "buzzer": return tx("蜂鸣器", "Buzzer");
    case "monitor": return tx("数值监视", "Value monitor");
    case "joystick": return tx("摇杆", "Joystick");
    case "keypad": return tx("键盘遥控", "Keypad");
    case "keymon": return tx("单键监控", "Key monitor");
    case "group": return tx("组合控件", "Group control");
    case "custom": return tx("自定义卡片", "Custom card");
  }
}

export function WidgetGallery() {
  useLocale(); // 列表与拖拽影子上的名字都是 tx() 出来的，切语言要有人重渲染
  return (
    <div className="widget-list">
      {store.CONTROL_TYPES.map((type) => (
        <div
          key={type}
          className="widget-item pdrag-src"
          onPointerDown={(e) =>
            beginPointerDrag(e, {
              kind: "vs-widget",
              data: JSON.stringify({ type }),
              label: widgetLabel(type),
            })
          }
          title={tx("拖到右侧画布创建", "Drag onto the canvas on the right to create one")}
        >
          <span className="widget-icon">
            {WIDGET_ICONS[type]}
          </span>{" "}
          {widgetLabel(type)}
        </div>
      ))}
      <div className="widget-hint">
        {tx("拖控件到右侧画布创建", "Drag a control onto the canvas to create it")}
        <HelpHint text={tx("右键卡片「设置」可切换模板串 / 脚本模式，脚本内可用全部解析变量；键盘遥控与单键监控会全局监听键位（焦点在输入框时不触发）。",
          "Right-click a card and open Settings to switch between template and script mode; a script sees every parsed variable. Keypad and key monitor listen globally (paused while an input box has focus).")} />
      </div>
    </div>
  );
}
