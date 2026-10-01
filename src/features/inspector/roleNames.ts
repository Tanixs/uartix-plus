/**
 * P123-C · 角色中文名的唯一出处（接收侧与发送侧共用）。
 *
 * 原来两边各写一版，同枚举措辞不同：`id` = 功能码 / 标识、`addr` = 目标地址 / 地址、
 * `checksum` = 和校验 / 校验。用户拍定取**接收侧那版**（它面向已经熟悉帧画布的人）。
 * "同一个属性页、两套 section" 要成立，标签不许有两个答案 —— 所以这里只有一份。
 *
 * 写成函数而不是常量：`tx()` 在模块顶层求值会被 check-i18n 判红（切语言时它不会跟着变）。
 */
import { tx } from "../../i18n/strings";
import type { FieldRole } from "../../ipc/types";

export const roleNames = (): Record<FieldRole, string> => ({
  header: tx("帧头", "Header"),
  addr: tx("目标地址", "Address"),
  id: tx("功能码", "Command ID"),
  length: tx("数据长度", "Length"),
  seq: tx("序号", "Seq"),
  payload: tx("数据载荷", "Payload"),
  data: tx("数据内容", "Data"),
  checksum: tx("和校验", "Checksum"),
  checksum2: tx("附加校验", "Checksum2"),
  footer: tx("帧尾", "Footer"),
});
