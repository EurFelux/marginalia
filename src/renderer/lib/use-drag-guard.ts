import { useRef, type SyntheticEvent } from "react";
import type { DraggableSyntheticListeners } from "@dnd-kit/core";

/**
 * 判断一次手势事件是否物理上「起手」于 `node` 自身的 DOM 子树内。
 *
 * dnd-kit 的激活监听（onPointerDown / onKeyDown…）摊在可拖拽元素上，靠 React 合成事件触发。
 * React Portal（dialog / 菜单 / 浮层）在 React 树里是该元素的后代，事件会**经合成事件系统冒泡
 * 回来**——但它们的 DOM 节点其实在 portal 容器（body）里、并不在本元素内。用 DOM `contains`
 * 校验事件 target 的真实物理归属，即可区分「确实在卡片上起手」与「在浮层里起手只是冒泡路过」。
 *
 * 纯函数（不依赖运行时 DOM 全局，仅调用 node 的 contains），可在 node 测试环境直接断言。
 */
export function gestureStartedWithin(
  node: HTMLElement | null,
  target: EventTarget | null,
): boolean {
  // Node.contains(null) === false；target 在指针/键盘事件里恒为 Element，cast 安全。
  return node != null && node.contains(target as Node | null);
}

/**
 * 守卫 dnd-kit 拖拽监听：仅当手势物理起手于被拖拽元素自身 DOM 内，才把事件放行给 dnd-kit；
 * 隔离来自 React Portal 后代（dialog / 菜单 / 浮层）的冒泡事件，避免「在浮层里操作误触发宿主
 * 元素拖拽」。守卫放在拖拽消费侧（而非阉割浮层的事件上浮），任何 draggable 复用此 hook 即免疫。
 *
 * 用法：
 *   const { attributes, listeners, setNodeRef, ... } = useSortable({ id });
 *   const guard = useDragGuard(setNodeRef, listeners);
 *   <li ref={guard.setNodeRef} {...attributes} {...guard.listeners}>…</li>
 *
 * 注：泛化包裹所有激活监听（不只 onPointerDown），故键盘传感器（Space/Enter 在浮层输入框里
 * 起手）同样被守住。setNodeRef 合成 dnd-kit 的 ref 与本地 nodeRef；React Compiler 负责记忆化。
 */
export function useDragGuard(
  setNodeRef: (node: HTMLElement | null) => void,
  listeners: DraggableSyntheticListeners,
) {
  const nodeRef = useRef<HTMLElement | null>(null);

  const setGuardedNodeRef = (node: HTMLElement | null) => {
    nodeRef.current = node;
    setNodeRef(node);
  };

  // listeners 是 Record<string, Function>（事件名→handler）；逐个包一层归属守卫后透传原参。
  const guardedListeners =
    listeners &&
    (Object.fromEntries(
      Object.entries(listeners).map(([name, handler]) => [
        name,
        (event: SyntheticEvent, ...rest: unknown[]) => {
          if (!gestureStartedWithin(nodeRef.current, event.target)) return;
          (handler as (...args: unknown[]) => void)(event, ...rest);
        },
      ]),
    ) as NonNullable<DraggableSyntheticListeners>);

  return { setNodeRef: setGuardedNodeRef, listeners: guardedListeners };
}
