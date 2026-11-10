import { PointerEvent as ReactPointerEvent, useRef, useState } from "react";

const closeDistance = 96;

export function useSheetDrag(onClose: () => void) {
  const [offset, setOffset] = useState(0);
  const [dragging, setDragging] = useState(false);
  const startY = useRef(0);
  const active = useRef(false);

  const finish = (clientY: number) => {
    if (!active.current) return;
    active.current = false;
    const next = Math.max(0, clientY - startY.current);
    setDragging(false);
    if (next >= closeDistance) {
      setOffset(0);
      onClose();
      return;
    }
    window.requestAnimationFrame(() => setOffset(0));
  };

  const handleProps = {
    onPointerDown: (event: ReactPointerEvent<HTMLDivElement>) => {
      if (event.button !== 0) return;
      active.current = true;
      startY.current = event.clientY;
      setDragging(true);
      setOffset(0);
      event.currentTarget.setPointerCapture(event.pointerId);
    },
    onPointerMove: (event: ReactPointerEvent<HTMLDivElement>) => {
      if (!active.current) return;
      setOffset(Math.max(0, event.clientY - startY.current));
    },
    onPointerUp: (event: ReactPointerEvent<HTMLDivElement>) => finish(event.clientY),
    onPointerCancel: (event: ReactPointerEvent<HTMLDivElement>) => finish(event.clientY),
  };

  const panelStyle =
    offset > 0 || dragging
      ? {
          transform: `translateY(${offset}px)`,
          transition: dragging ? "none" : "transform 180ms ease",
        }
      : undefined;

  return { handleProps, panelStyle };
}

export function SheetHandle({
  onPointerDown,
  onPointerMove,
  onPointerUp,
  onPointerCancel,
}: ReturnType<typeof useSheetDrag>["handleProps"]) {
  return (
    <div
      aria-hidden="true"
      className="sheet-handle"
      onPointerCancel={onPointerCancel}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
    >
      <span />
    </div>
  );
}
