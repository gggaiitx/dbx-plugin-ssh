// 建议浮层的翻转定位（issue #120）：锚点 y 是光标行顶的像素坐标（取自
// xterm helper textarea 的 rect，见 readTerminalSuggestionAnchor），浮层默认
// 从光标行底向下展开；下方放不下时翻到光标上方，两侧都放不下时选空间更大的
// 一侧并按可用空间收窄浮层（内部滚动），永不遮输入行、永不被视口硬裁——
// 对标 VS Code/Warp。纯函数 + 显式参数，DOM 测量留在组件。

/** 浮层与光标行之间的垂直呼吸间隙（px）。 */
export const OVERLAY_GAP = 6;

/** 浮层左缘与光标字符右缘之间的水平间隙（px）。 */
export const OVERLAY_GAP_X = 6;

export type OverlayPlacement = "below" | "above";

/** 建议浮层锚点：光标格的像素坐标（y 为光标行顶），cell 尺寸为格宽/行高。 */
export interface SuggestionAnchor {
  x: number;
  y: number;
  /** 行高；缺失（旧锚点/不可测）时按 0 处理。 */
  cellHeight?: number;
  /** 格宽（光标字符右缘 = x + cellWidth）。 */
  cellWidth?: number;
}

/** 浮层左缘：光标字符之后再留水平间隙，不压住刚输入的字符。 */
export function overlayLeft(anchorX: number, cellWidth: number, gap = OVERLAY_GAP_X): number {
  return Math.max(0, anchorX + cellWidth + gap);
}

/**
 * 放置侧选择：下方放得下就下方；否则上方放得下就上方；两侧都不够时取
 * 空间更大的一侧（浮层随后按该侧可用空间收窄、内部滚动）。视口或浮层
 * 高度不可测时保持默认下方。
 */
export function chooseOverlayPlacement(
  anchorTopY: number,
  cellHeight: number,
  overlayHeight: number,
  viewportHeight: number,
): OverlayPlacement {
  if (!(viewportHeight > 0) || !(overlayHeight > 0)) return "below";
  const cursorBottomY = anchorTopY + cellHeight;
  const spaceBelow = viewportHeight - cursorBottomY;
  const spaceAbove = anchorTopY;
  if (spaceBelow >= overlayHeight) return "below";
  if (spaceAbove >= overlayHeight) return "above";
  return spaceAbove > spaceBelow ? "above" : "below";
}

/** 下方展开时的 top：光标行底（行顶 y + 行高）再留 gap。 */
export function overlayBelowTop(anchorTopY: number, cellHeight: number, gap = OVERLAY_GAP): number {
  return anchorTopY + cellHeight + gap;
}

/** 翻转后的 bottom 偏移：浮层底边贴光标行顶并留 gap（不遮输入行）。 */
export function flippedOverlayBottom(anchorTopY: number, viewportHeight: number, gap = OVERLAY_GAP): number {
  return Math.max(0, viewportHeight - anchorTopY + gap);
}

/**
 * 放置侧的可用高度：浮层超过它就该内部滚动（组件设为 max-height），
 * 而不是伸出视口被硬裁。返回 0 表示不可用（组件保持 CSS 默认 max-height）。
 */
export function overlayMaxHeight(
  placement: OverlayPlacement,
  anchorTopY: number,
  cellHeight: number,
  viewportHeight: number,
  gap = OVERLAY_GAP,
): number {
  if (!(viewportHeight > 0)) return 0;
  return placement === "above"
    ? Math.max(0, anchorTopY - gap)
    : Math.max(0, viewportHeight - (anchorTopY + cellHeight) - gap);
}
