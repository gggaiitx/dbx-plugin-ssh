<script setup lang="ts">
// 命令模糊建议浮层（P1-1）：纯展示组件——条目渲染（匹配高亮 + 来源图标）、
// 键盘导航与填充语义都在 App（键盘经 xterm attachCustomKeyEventHandler 消费，
// 浮层只反映 activeIndex 并把点击/悬停上抛）。定位由 App 传入：锚点是光标
// 格像素坐标（y 为行顶），读不到时（anchor=null）降级为贴终端底部；下方
// 放不下翻转到光标上方，两侧都不够选空间更大的一侧并收窄内滚，永不遮输入
// 行（issue #120，lib/overlayPlacement，宿主高度以包含块实测为准）。
import { computed, ref, watchEffect } from "vue";
import { History, Zap } from "@lucide/vue";
import type { CommandSuggestion } from "../lib/commandSuggestions";
import {
  chooseOverlayPlacement,
  flippedOverlayBottom,
  overlayBelowTop,
  overlayLeft,
  overlayMaxHeight,
  type SuggestionAnchor,
} from "../lib/overlayPlacement";

interface Segment {
  text: string;
  matched: boolean;
}

const props = defineProps<{
  items: CommandSuggestion[];
  activeIndex: number;
  /** 光标格像素坐标（y 为光标行顶）；null = 定位不可用，贴终端底部。 */
  anchor: SuggestionAnchor | null;
  /** 终端可视底界（terminal-host 净高）；缺省时回落实测包含块高度。 */
  viewport?: { height: number };
  t: (key: string, values?: Record<string, string | number>) => string;
}>();

const emit = defineEmits<{
  activate: [index: number];
  fill: [item: CommandSuggestion];
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
  void props.items.length;
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

/** 按 indices 把命令串切成高亮片段（未命中的字符合并成段）。 */
function segments(command: string, indices: number[]): Segment[] {
  const matched = new Set(indices);
  const out: Segment[] = [];
  let current: Segment | null = null;
  for (let i = 0; i < command.length; i += 1) {
    const isMatched = matched.has(i);
    if (!current || current.matched !== isMatched) {
      current = { text: command.charAt(i), matched: isMatched };
      out.push(current);
    } else {
      current.text += command.charAt(i);
    }
  }
  return out;
}

const sourceLabel = (item: CommandSuggestion) => (item.source === "quick" ? props.t("suggestions.sourceQuick") : props.t("suggestions.sourceHistory"));
</script>

<template>
  <div ref="rootEl" class="command-suggestions" :class="{ 'anchor-fallback': anchor === null }" :style="style" role="listbox" :aria-label="t('suggestions.title')">
    <button
      v-for="(item, index) in items"
      :key="`${item.source}-${item.command}`"
      type="button"
      class="suggestion-row"
      :class="{ active: index === activeIndex }"
      role="option"
      :aria-selected="index === activeIndex"
      :title="`${sourceLabel(item)} · ${t('suggestions.fillHint')}`"
      @mouseenter="emit('activate', index)"
      @mousedown.prevent
      @click="emit('fill', item)"
    >
      <History v-if="item.source === 'history'" class="suggestion-icon" aria-hidden="true" />
      <Zap v-else class="suggestion-icon" aria-hidden="true" />
      <span class="suggestion-command mono">
        <template v-for="(segment, segmentIndex) in segments(item.command, item.indices)" :key="segmentIndex"><mark v-if="segment.matched">{{ segment.text }}</mark><template v-else>{{ segment.text }}</template></template>
      </span>
      <span class="suggestion-source">{{ sourceLabel(item) }}</span>
    </button>
  </div>
</template>

<style scoped>
/* 面板色随宿主主题：与 .notice/.metrics-float 同用 --popover/--border/
   --shadow-popover 令牌（style.css 统一阴影配方），不硬编码深色 fallback——
   浅色主题下黑底深字不可读（issue #120）。文字色显式配对面板底，
   不依赖终端 pane 的继承色。 */
.command-suggestions {
  position: absolute;
  z-index: 30;
  max-width: 380px;
  min-width: 260px;
  max-height: 40vh;
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

.command-suggestions.anchor-fallback {
  left: 12px;
  bottom: 12px;
}

.suggestion-row {
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

.suggestion-row.active {
  background: var(--accent);
}

.suggestion-icon {
  flex: none;
  width: 14px;
  height: 14px;
  opacity: 0.75;
}

.suggestion-command {
  flex: 1 1 auto;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.suggestion-command mark {
  background: transparent;
  color: var(--primary);
  font-weight: 600;
}

.suggestion-source {
  flex: none;
  font-size: 11px;
  opacity: 0.65;
}
</style>
