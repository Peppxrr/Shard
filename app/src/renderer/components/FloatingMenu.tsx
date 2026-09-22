import { useLayoutEffect, useRef } from "react";
import type { ReactNode, RefObject } from "react";
import { THEME_CHANGE_EVENT } from "../themeManager";

/** The top layer escapes filtered/transformed ancestors without moving the DOM:
 * page-scoped theme selectors and inherited variables still work. */
export function FloatingMenu({ anchor, x = 0, y = 0, onClose, children, className, role, id, ariaLabel }: {
  anchor?: RefObject<HTMLButtonElement | null>;
  x?: number;
  y?: number;
  onClose: () => void;
  children: ReactNode;
  className: string;
  role: "menu" | "listbox";
  id?: string;
  ariaLabel?: string;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const positionRef = useRef<(() => void) | null>(null);
  const closeRef = useRef(onClose);
  closeRef.current = onClose;

  useLayoutEffect(() => {
    const menu = ref.current!;
    const button = anchor?.current;
    const position = () => {
      const margin = 8, gap = 4;
      const width = Math.max(0, window.innerWidth - margin * 2);
      const height = Math.max(0, window.innerHeight - margin * 2);
      menu.style.maxWidth = `${width}px`;
      menu.style.maxHeight = `${height}px`;
      const target = button?.getBoundingClientRect();
      if (target) menu.style.width = `${Math.min(width, Math.max(target.width, 180))}px`;
      const wanted = Math.min(menu.getBoundingClientRect().height, target ? 280 : height);
      let left = target?.left ?? x;
      let top = y;
      if (target) {
        const below = Math.max(0, window.innerHeight - margin - target.bottom - gap);
        const above = Math.max(0, target.top - margin - gap);
        const useBelow = below >= wanted || below >= above;
        menu.style.maxHeight = `${Math.min(wanted, useBelow ? below : above)}px`;
        top = useBelow ? target.bottom + gap : target.top - gap - menu.getBoundingClientRect().height;
      } else if (top + wanted > window.innerHeight - margin) {
        top = y - wanted - gap;
      }
      const rect = menu.getBoundingClientRect();
      left = Math.max(margin, Math.min(left, window.innerWidth - margin - rect.width));
      top = Math.max(margin, Math.min(top, window.innerHeight - margin - rect.height));
      menu.style.left = `${left}px`;
      menu.style.top = `${top}px`;
    };
    const close = () => closeRef.current();
    const scroll = (event: Event) => {
      // Scrolling a long options list must not dismiss it.
      if (!(event.target instanceof Node) || !menu.contains(event.target)) close();
    };
    const toggled = () => { if (!menu.matches(":popover-open")) close(); };
    menu.addEventListener("toggle", toggled);
    // Electron supports the source option; TypeScript 5.9's DOM types predate it.
    (menu.showPopover as (options: { source?: HTMLElement }) => void)({ source: button ?? undefined });
    positionRef.current = position;
    position();
    const observer = new ResizeObserver(position);
    observer.observe(menu);
    if (button) observer.observe(button);

    // A constrained popover can change intrinsic content size without giving
    // ResizeObserver a useful intermediate box. Watch its actual contents too
    // and re-anchor after Chromium has committed the DOM mutation.
    let mutationFrame = 0;
    const mutations = new MutationObserver(() => {
      cancelAnimationFrame(mutationFrame);
      mutationFrame = requestAnimationFrame(position);
    });
    mutations.observe(menu, { childList: true, subtree: true, characterData: true });

    window.addEventListener("blur", close);
    window.addEventListener("resize", close);
    window.addEventListener("scroll", scroll, true);
    window.addEventListener(THEME_CHANGE_EVENT, position);
    return () => {
      positionRef.current = null;
      observer.disconnect();
      mutations.disconnect();
      cancelAnimationFrame(mutationFrame);
      window.removeEventListener("blur", close);
      window.removeEventListener("resize", close);
      window.removeEventListener("scroll", scroll, true);
      window.removeEventListener(THEME_CHANGE_EVENT, position);
      menu.removeEventListener("toggle", toggled);
      if (menu.matches(":popover-open")) menu.hidePopover();
    };
  }, [anchor, x, y]);

  // Content can grow while the old max-height keeps its observed border box
  // unchanged. Measure immediately, then once more on the next frame so the
  // top-layer box has committed its new intrinsic size before we anchor it.
  useLayoutEffect(() => {
    positionRef.current?.();
    const frame = requestAnimationFrame(() => positionRef.current?.());
    return () => cancelAnimationFrame(frame);
  }, [children]);

  return <div ref={ref} id={id} popover="auto" role={role} aria-label={ariaLabel}
    data-shard-component={role === "listbox" ? "select-menu" : "context-menu"}
    className={className}
    style={{ position: "fixed", inset: "auto", margin: 0, overflowY: "auto" }}
    onPointerDown={event => event.stopPropagation()}
    onKeyDown={event => { if (event.key === "Escape") event.stopPropagation(); }}>
    {children}
  </div>;
}
