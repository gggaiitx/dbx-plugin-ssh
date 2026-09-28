// @vitest-environment happy-dom
// 浮层翻转定位（issue #120）：底部空间不足翻到光标上方，两侧都放不下选
// 空间更大的一侧并收窄浮层内滚；锚点 y 为光标行顶（textarea rect 语义）。
import { describe, expect, it } from "vitest";
import {
  chooseOverlayPlacement,
  flippedOverlayBottom,
  overlayBelowTop,
  overlayLeft,
  overlayMaxHeight,
} from "./overlayPlacement";

describe("chooseOverlayPlacement", () => {
  it("keeps the overlay below while the viewport has room", () => {
    // 光标行 100..120，浮层 200：下方 600 放得下
    expect(chooseOverlayPlacement(100, 20, 200, 720)).toBe("below");
  });

  it("flips above when the bottom cannot fit but the top can", () => {
    // 光标行 640..660，浮层 200：下方 60 不够，上方 640 够
    expect(chooseOverlayPlacement(640, 20, 200, 720)).toBe("above");
  });

  it("picks the larger side when neither fits, without flipping past the top", () => {
    // 光标行 400..420，浮层 700：两侧都不够，上方 400 > 下方 300 → above
    expect(chooseOverlayPlacement(400, 20, 700, 720)).toBe("above");
    // 光标行 100..120：上方 100 < 下方 600 → below
    expect(chooseOverlayPlacement(100, 20, 700, 720)).toBe("below");
  });

  it("stays below without a measurable viewport or overlay", () => {
    expect(chooseOverlayPlacement(640, 20, 0, 720)).toBe("below");
    expect(chooseOverlayPlacement(640, 20, 200, 0)).toBe("below");
  });
});

describe("overlayBelowTop / flippedOverlayBottom / overlayLeft", () => {
  it("starts below the cursor row with a small gap", () => {
    expect(overlayBelowTop(100, 20)).toBe(126);
  });

  it("rests the flipped overlay bottom just above the cursor row top", () => {
    expect(flippedOverlayBottom(640, 720)).toBe(86);
    expect(flippedOverlayBottom(0, 720)).toBe(726);
  });

  it("clears the cursor character and keeps a horizontal gap", () => {
    expect(overlayLeft(157, 8)).toBe(171);
    expect(overlayLeft(0, 0)).toBe(6);
  });
});

describe("overlayMaxHeight", () => {
  it("gives the below side the space under the cursor row", () => {
    expect(overlayMaxHeight("below", 100, 20, 720)).toBe(594);
  });

  it("gives the above side the space over the cursor row top", () => {
    expect(overlayMaxHeight("above", 640, 20, 720)).toBe(634);
  });

  it("returns 0 without a measurable viewport", () => {
    expect(overlayMaxHeight("above", 640, 20, 0)).toBe(0);
  });
});
