"use client";

import {Fragment, useEffect, useRef, useState, type CSSProperties, type KeyboardEvent, type PointerEvent, type ReactNode} from "react";

interface ReorderListProps<T> {
  items: T[];
  getKey: (item: T) => string;
  /** Accessible name of an item, for its drag handle. */
  getLabel: (item: T) => string;
  /** The row's content; `handle` is the drag grip to place in it. */
  renderItem: (item: T, index: number, handle: ReactNode) => ReactNode;
  /** What sits in the gap before `position` (0..items.length), such as an "add here" control. */
  renderGap?: (position: number) => ReactNode;
  onReorder: (from: number, to: number) => void;
  isDisabled?: boolean;
  className?: string;
}

interface Drag {
  from: number;
  to: number;
  dy: number;
}

/** Distance from the scroll area's edge where dragging scrolls it. */
const EDGE = 64;

/** The nearest ancestor that scrolls vertically, or null for the page itself. */
function scrollParent(element: HTMLElement | null): HTMLElement | null {
  for (let node = element?.parentElement; node; node = node.parentElement) {
    const {overflowY} = getComputedStyle(node);
    if ((overflowY === "auto" || overflowY === "scroll") && node.scrollHeight > node.clientHeight) return node;
  }
  return null;
}

const scrollTopOf = (scroller: HTMLElement | null) => (scroller ? scroller.scrollTop : window.scrollY);

/**
 * A list reordered by dragging each row's grip, with pointer events so mouse, pen and touch all work.
 * Arrow keys on a focused grip move that row one place.
 */
export default function ReorderList<T>({items, getKey, getLabel, renderItem, renderGap, onReorder, isDisabled = false, className = ""}: ReorderListProps<T>) {
  const listRef = useRef<HTMLOListElement>(null);
  const rowsRef = useRef<Array<HTMLLIElement | null>>([]);
  const session = useRef<{from: number; startY: number; startScroll: number; mids: number[]; height: number; pointerY: number; raf: number; to: number; scroller: HTMLElement | null} | null>(null);
  const [drag, setDrag] = useState<Drag | null>(null);

  useEffect(() => () => cancelAnimationFrame(session.current?.raf ?? 0), []);

  const update = () => {
    const current = session.current;
    if (!current) return;
    const dy = current.pointerY + scrollTopOf(current.scroller) - (current.startY + current.startScroll);
    const center = current.mids[current.from] + dy;
    let to = current.from;
    current.mids.forEach((mid, index) => {
      if (index < current.from && center < mid) to = Math.min(to, index);
      if (index > current.from && center > mid) to = Math.max(to, index);
    });
    current.to = to;
    setDrag({from: current.from, to, dy});
  };

  // Near the top or bottom of the scroll area it scrolls, so long lists can be crossed in one drag.
  const autoScroll = () => {
    const current = session.current;
    if (!current) return;
    const {pointerY, scroller} = current;
    const top = scroller ? Math.max(0, scroller.getBoundingClientRect().top) : 0;
    const bottom = scroller ? Math.min(window.innerHeight, scroller.getBoundingClientRect().bottom) : window.innerHeight;
    const speed = pointerY < top + EDGE ? -(top + EDGE - pointerY) / 3 : pointerY > bottom - EDGE ? (pointerY - bottom + EDGE) / 3 : 0;
    if (speed) {
      if (scroller) scroller.scrollTop += speed;
      else window.scrollBy(0, speed);
      update();
    }
    current.raf = requestAnimationFrame(autoScroll);
  };

  const start = (index: number) => (event: PointerEvent<HTMLButtonElement>) => {
    if (isDisabled || event.button !== 0) return;
    event.preventDefault();
    event.currentTarget.setPointerCapture(event.pointerId);
    const rects = rowsRef.current.slice(0, items.length).map((row) => row?.getBoundingClientRect() ?? new DOMRect());
    const scroller = scrollParent(listRef.current);
    const scroll = scrollTopOf(scroller);
    session.current = {
      scroller,
      from: index,
      startY: event.clientY,
      startScroll: scroll,
      mids: rects.map((rect) => rect.top + scroll + rect.height / 2),
      height: rects[index].height,
      pointerY: event.clientY,
      raf: 0,
      to: index,
    };
    setDrag({from: index, to: index, dy: 0});
    session.current.raf = requestAnimationFrame(autoScroll);
  };

  const move = (event: PointerEvent<HTMLButtonElement>) => {
    if (!session.current) return;
    session.current.pointerY = event.clientY;
    update();
  };

  const end = () => {
    const current = session.current;
    if (!current) return;
    cancelAnimationFrame(current.raf);
    session.current = null;
    setDrag(null);
    if (current.to !== current.from) onReorder(current.from, current.to);
  };

  const keyMove = (index: number) => (event: KeyboardEvent<HTMLButtonElement>) => {
    if (isDisabled) return;
    const to = event.key === "ArrowUp" ? index - 1 : event.key === "ArrowDown" ? index + 1 : null;
    if (to === null || to < 0 || to >= items.length) return;
    event.preventDefault();
    onReorder(index, to);
  };

  const shift = (index: number): number => {
    if (!drag || !session.current) return 0;
    const {from, to} = drag;
    if (index === from) return drag.dy;
    const step = session.current.height;
    if (from < to && index > from && index <= to) return -step;
    if (to < from && index >= to && index < from) return step;
    return 0;
  };

  return (
    <ol ref={listRef} className={`reorder-list${drag ? " is-dragging" : ""} ${className}`.trim()}>
      {items.map((item, index) => {
        const label = getLabel(item);
        const handle = (
          <button
            type="button"
            className="drag-handle"
            aria-label={`Move ${label}. Drag, or use the arrow keys.`}
            title="Drag to reorder"
            disabled={isDisabled}
            onPointerDown={start(index)}
            onPointerMove={move}
            onPointerUp={end}
            onPointerCancel={end}
            onKeyDown={keyMove(index)}
          >
            <svg viewBox="0 0 10 16" aria-hidden="true">
              {[3, 8, 13].map((y) => [3, 7].map((x) => <circle key={`${x}-${y}`} cx={x} cy={y} r="1.3" />))}
            </svg>
          </button>
        );
        const offset = shift(index);
        return (
          <Fragment key={getKey(item)}>
            {renderGap && <li className="reorder-gap" aria-hidden={drag ? true : undefined}>{renderGap(index)}</li>}
            <li
              ref={(row) => {
                rowsRef.current[index] = row;
              }}
              className={`reorder-row${drag?.from === index ? " is-lifted" : ""}`}
              style={offset ? ({"--shift": `${offset}px`} as CSSProperties) : undefined}
            >
              {renderItem(item, index, handle)}
            </li>
          </Fragment>
        );
      })}
      {renderGap && <li className="reorder-gap">{renderGap(items.length)}</li>}
    </ol>
  );
}
