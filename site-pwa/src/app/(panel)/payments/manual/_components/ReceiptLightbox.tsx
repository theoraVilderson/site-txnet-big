"use client";

import { useRef, useState, type PointerEvent, type WheelEvent } from "react";
import { Maximize2, ZoomIn, ZoomOut } from "lucide-react";
import { useLocale } from "@/context/LocaleContext";
import { Dialog, IconButton } from "../../../_components/kit";
import { MANUAL_KEYS } from "../_lib/manual-confirm";

const K = MANUAL_KEYS.transfer;

/** 1× fits the dialog; 5× reads a tracking code off a phone screenshot. */
const MIN_ZOOM = 1;
const MAX_ZOOM = 5;
const BUTTON_STEP = 1.5;
/** A wheel notch's worth of `deltaY` per doubling — smooth on a trackpad, one step on a mouse. */
const WHEEL_PER_DOUBLING = 500;

const clamp = (z: number) => Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, z));

/**
 * A transfer's receipt, full size (F-803-k): scroll or pinch to zoom, drag to
 * pan when zoomed, and buttons for a keyboard. Pinch is two pointers' distance,
 * so it needs no gesture library (C-34).
 */
export function ReceiptLightbox({ url, open, onClose }: { url: string; open: boolean; onClose: () => void }) {
  const { t } = useLocale();
  const [zoom, setZoom] = useState(MIN_ZOOM);
  const [pan, setPan] = useState({ x: 0, y: 0 });
  // The URL is signed for five minutes; a list left open longer needs a reload, and says so.
  const [failed, setFailed] = useState(false);
  const pointers = useRef(new Map<number, { x: number; y: number }>());
  const pinchFrom = useRef<{ distance: number; zoom: number } | null>(null);

  const zoomTo = (next: number) => {
    const z = clamp(next);
    setZoom(z);
    if (z === MIN_ZOOM) setPan({ x: 0, y: 0 });
  };

  const onWheel = (e: WheelEvent) => zoomTo(zoom * 2 ** (-e.deltaY / WHEEL_PER_DOUBLING));

  const onPointerDown = (e: PointerEvent) => {
    e.currentTarget.setPointerCapture(e.pointerId);
    pointers.current.set(e.pointerId, { x: e.clientX, y: e.clientY });
    const [a, b] = [...pointers.current.values()];
    if (b) pinchFrom.current = { distance: Math.hypot(a.x - b.x, a.y - b.y), zoom };
  };

  const onPointerMove = (e: PointerEvent) => {
    const last = pointers.current.get(e.pointerId);
    if (!last) return;
    pointers.current.set(e.pointerId, { x: e.clientX, y: e.clientY });
    const [a, b] = [...pointers.current.values()];
    if (b && pinchFrom.current) zoomTo((pinchFrom.current.zoom * Math.hypot(a.x - b.x, a.y - b.y)) / pinchFrom.current.distance);
    else if (zoom > MIN_ZOOM) setPan((p) => ({ x: p.x + (e.clientX - last.x) / zoom, y: p.y + (e.clientY - last.y) / zoom }));
  };

  const onPointerUp = (e: PointerEvent) => {
    pointers.current.delete(e.pointerId);
    if (pointers.current.size < 2) pinchFrom.current = null;
  };

  const close = () => {
    zoomTo(MIN_ZOOM);
    onClose();
  };

  return (
    <Dialog
      open={open}
      onClose={close}
      size="lg"
      title={t("common", K.receipt)}
      footer={
        <div className="flex gap-1">
          <IconButton aria-label={t("common", K.zoomOut)} icon={<ZoomOut size={16} aria-hidden />} onClick={() => zoomTo(zoom / BUTTON_STEP)} disabled={zoom <= MIN_ZOOM} />
          <IconButton aria-label={t("common", K.zoomReset)} icon={<Maximize2 size={16} aria-hidden />} onClick={() => zoomTo(MIN_ZOOM)} disabled={zoom === MIN_ZOOM} />
          <IconButton aria-label={t("common", K.zoomIn)} icon={<ZoomIn size={16} aria-hidden />} onClick={() => zoomTo(zoom * BUTTON_STEP)} disabled={zoom >= MAX_ZOOM} />
        </div>
      }
    >
      <div
        className="relative h-[65vh] cursor-grab touch-none overflow-hidden rounded-xl bg-bg-inner active:cursor-grabbing"
        onWheel={onWheel}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerUp}
        onDoubleClick={() => zoomTo(zoom === MIN_ZOOM ? BUTTON_STEP * BUTTON_STEP : MIN_ZOOM)}
      >
        {failed ? (
          <p role="alert" className="grid size-full place-items-center p-4 text-center text-xs font-bold text-error">
            {t("common", K.receiptExpired)}
          </p>
        ) : (
          // eslint-disable-next-line @next/next/no-img-element -- a signed five-minute URL, not something next/image may cache
          <img
            src={url}
            alt={t("common", K.receipt)}
            draggable={false}
            className="size-full select-none object-contain"
            onError={() => setFailed(true)}
            style={{ transform: `scale(${zoom}) translate(${pan.x}px, ${pan.y}px)` }}
          />
        )}
      </div>
    </Dialog>
  );
}
