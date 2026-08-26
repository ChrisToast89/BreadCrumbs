/**
 * Right-click menu for the shot row.
 *
 * Its only job is setting the in and out frames on the frame you clicked, so
 * the two things a pick can be are reachable without learning which key does
 * which. Every item goes through the same data-layer operations as the keys
 * and the drag, so I8 is enforced identically here.
 */

import { useEffect, useRef } from 'react';

export interface MenuItem {
  label: string;
  /** Why an item is unavailable, shown beside it. */
  hint?: string | undefined;
  disabled?: boolean | undefined;
  onSelect: () => void;
}

interface Props {
  x: number;
  y: number;
  items: MenuItem[];
  onClose: () => void;
}

export function ContextMenu({ x, y, items, onClose }: Props): JSX.Element {
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    // Anything outside the menu closes it, as does escape.
    const onPointerDown = (event: PointerEvent): void => {
      if (!ref.current?.contains(event.target as Node)) onClose();
    };
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') {
        event.stopPropagation();
        onClose();
      }
    };

    window.addEventListener('pointerdown', onPointerDown, true);
    window.addEventListener('keydown', onKeyDown, true);
    return () => {
      window.removeEventListener('pointerdown', onPointerDown, true);
      window.removeEventListener('keydown', onKeyDown, true);
    };
  }, [onClose]);

  // Keep the menu on screen when opened near an edge.
  useEffect(() => {
    const element = ref.current;
    if (!element) return;
    const box = element.getBoundingClientRect();
    if (box.right > window.innerWidth) element.style.left = `${window.innerWidth - box.width - 8}px`;
    if (box.bottom > window.innerHeight) element.style.top = `${window.innerHeight - box.height - 8}px`;
  }, []);

  return (
    <div className="menu" ref={ref} style={{ left: x, top: y }} role="menu">
      {items.map((item) => (
        <button
          key={item.label}
          type="button"
          role="menuitem"
          className="menu__item"
          disabled={item.disabled ?? false}
          onClick={() => {
            item.onSelect();
            onClose();
          }}
        >
          <span>{item.label}</span>
          {item.hint ? <span className="menu__hint">{item.hint}</span> : null}
        </button>
      ))}
    </div>
  );
}
