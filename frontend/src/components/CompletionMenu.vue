<script setup lang="ts">
// 结构化补全下拉菜单（对标 Warp/fig，线 2）：按 spec 命中的层级展示候选——
// sub（子命令）/ flag（flag）/ value（静态枚举值）+ hint（动态占位提示，如
// <branch>）。纯展示组件：键盘（↑↓/Tab/Enter/Esc）由 App 的
// handleTerminalKey 在浮层开启时优先消费，浮层只反映 activeIndex 并把
// 点击/悬停上抛；定位复用 CommandSuggestions 的光标像素锚点语义（y 为行
// 顶；下方放不下翻到光标上方，两侧都不够选更大侧收窄内滚，issue #120）。
// 样式沿用既有建议浮层的面板视觉（同一 --popover/--border/--accent 令牌
// 体系，随宿主主题），不引 reka 弹层——避免与 xterm 键盘捕获争焦点。
import { computed, ref, watchEffect } from "vue";
import { ChevronRight, CornerDownRight, Flag, Info, SlidersHorizontal } from "@lucide/vue";
import type { CompletionLevel, CompletionRow } from "../lib/completions/spec";
import {
  chooseOverlayPlacement,
  flippedOverlayBottom,
  overlayBelowTop,
  overlayLeft,
  overlayMaxHeight,
  type SuggestionAnchor,
} from "../lib/overlayPlacement";

const props = defineProps<{
  rows: CompletionRow[];
  level: CompletionLevel;
  /** 解析到的命令节点路径（如 ["git", "checkout"]），作菜单头面包屑。 */
  commandPath: string[];
  activeIndex: number;
  /** 光标格像素坐标（y 为光标行顶）；null = 定位不可用，贴终端底部。 */
  anchor: SuggestionAnchor | null;
  /** 终端可视底界（terminal-host 净高）；缺省时回落实测包含块高度。 */
  viewport?: { height: number };
  t: (key: string, values?: Record<string, string | number>) => string;
}>();

const emit = defineEmits<{
  activate: [index: number];
  accept: [row: CompletionRow];
}>();

const rootEl = ref<HTMLElement | null>(null);
const placement = ref<"below" | "above">("below");
const overlayBottom = ref(0);
const constrainedHeight = ref(0);

// DOM 更新后按浮层实际高度选放置侧：条目数/锚点变化都重测。宿主高度取
// 包含块（terminal-pane）实测，不依赖外部下发，batch-bar 让位等也自动正确。
watchEffect(() => {
  const el = rootEl.value;
  const anchor = props.anchor;
  void props.rows.length;
  if (!el || !anchor) {
    placement.value = "below";
    constrainedHeight.value = 0;
    return;
  }
  const viewportHeight = props.viewport?.height || el.parentElement?.clientHeight || 0;
  const cellHeight = anchor.cellHeight ?? 0;
  const naturalHeight = el.offsetHeight;
  placement.value = chooseOverlayPlacement(anchor.y, cellHeight, naturalHeight, viewportHeight);
  overlayBottom.value = flippedOverlayBottom(anchor.y, viewportHeight);
  const available = overlayMaxHeight(placement.value, anchor.y, cellHeight, viewportHeight);
  constrainedHeight.value = available > 0 && available < naturalHeight ? available : 0;
}, { flush: "post" });

const style = computed(() => {
  if (!props.anchor) return undefined;
  const left = `${overlayLeft(props.anchor.x, props.anchor.cellWidth ?? 0)}px`;
  const maxHeight = constrainedHeight.value > 0 ? { maxHeight: `${constrainedHeight.value}px` } : undefined;
  if (placement.value === "above") return { left, bottom: `${overlayBottom.value}px`, ...maxHeight };
  return { left, top: `${overlayBelowTop(props.anchor.y, props.anchor.cellHeight ?? 0)}px`, ...maxHeight };
});

const levelLabel = computed(() => {
  if (props.level === "flag") return props.t("completionMenu.levelFlag");
  if (props.level === "value") return props.t("completionMenu.levelValue");
  return props.t("completionMenu.levelSub");
});

const breadcrumb = computed(() => props.commandPath.join(" › "));

function rowIcon(kind: CompletionRow["kind"]) {
  if (kind === "sub") return ChevronRight;
  if (kind === "flag") return SlidersHorizontal;
  if (kind === "value") return CornerDownRight;
  return Info;
}
</script>

<template>
  <div ref="rootEl" class="completion-menu" :class="{ 'anchor-fallback': anchor === null }" :style="style" role="listbox" :aria-label="t('completionMenu.title')">
    <div class="completion-head">
      <span class="completion-crumb mono">{{ breadcrumb }}</span>
      <span class="completion-level">{{ levelLabel }}</span>
    </div>
    <button
      v-for="(row, index) in rows"
      :key="`${row.kind}-${row.label}`"
      type="button"
      class="completion-row"
      :class="{ active: index === activeIndex, hint: row.kind === 'hint' }"
      role="option"
      :aria-selected="index === activeIndex"
      :title="`${row.description} · ${t('completionMenu.acceptHint')}`"
      @mouseenter="emit('activate', index)"
      @mousedown.prevent
      @click="emit('accept', row)"
    >
      <component :is="rowIcon(row.kind)" class="completion-icon" aria-hidden="true" />
      <span class="completion-label mono">{{ row.label }}</span>
      <span class="completion-description">{{ row.description }}</span>
      <Flag v-if="row.kind === 'flag'" class="completion-kind-mark" aria-hidden="true" />
    </button>
  </div>
</template>

<style scoped>
/* 面板色随宿主主题（issue #120）：与 .notice/.metrics-float 同用
   --popover/--border/--shadow-popover 令牌；文字色显式配对面板底。 */
.completion-menu {
  position: absolute;
  z-index: 30;
  max-width: 460px;
  min-width: 280px;
  max-height: 44vh;
  overflow-y: auto;
  background: var(--popover);
  border: 1px solid var(--border);
  border-radius: 8px;
  box-shadow: var(--shadow-popover);
  color: var(--foreground);
  padding: 4px;
  display: flex;
  flex-direction: column;
  gap: 2px;
}

.completion-menu.anchor-fallback {
  left: 12px;
  bottom: 12px;
}

.completion-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  padding: 4px 8px 2px;
  border-bottom: 1px solid var(--border);
}

.completion-crumb {
  font-size: 11px;
  opacity: 0.7;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.completion-level {
  flex: none;
  font-size: 10.5px;
  letter-spacing: 0.04em;
  text-transform: uppercase;
  opacity: 0.6;
}

.completion-row {
  display: flex;
  align-items: center;
  gap: 8px;
  width: 100%;
  border: 0;
  background: transparent;
  color: inherit;
  text-align: left;
  padding: 4px 8px;
  border-radius: 6px;
  cursor: pointer;
  font-size: 12.5px;
  line-height: 1.4;
}

.completion-row.active {
  background: var(--accent);
}

.completion-row.hint .completion-label {
  opacity: 0.55;
  font-style: italic;
}

.completion-icon {
  flex: none;
  width: 13px;
  height: 13px;
  opacity: 0.7;
}

.completion-label {
  flex: none;
  max-width: 46%;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-weight: 600;
}

.completion-description {
  flex: 1 1 auto;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-size: 11.5px;
  opacity: 0.65;
}

.completion-kind-mark {
  flex: none;
  width: 12px;
  height: 12px;
  opacity: 0.45;
}
</style>
