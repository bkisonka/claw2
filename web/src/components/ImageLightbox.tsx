import { useCallback, useEffect } from "react";
import { createPortal } from "react-dom";
import { useT } from "../i18n";

interface ImageLightboxProps {
  src: string;
  alt?: string;
  onClose: () => void;
  /** Previous image (←). If none — arrow is hidden. */
  onPrev?: () => void;
  /** Next image (→). */
  onNext?: () => void;
}

/** Full-size view: Escape / backdrop / ×; ←→ for gallery. */
export function ImageLightbox({ src, alt = "", onClose, onPrev, onNext }: ImageLightboxProps) {
  const t = useT();

  const handlePrev = useCallback(
    (e?: { stopPropagation?: () => void }) => {
      e?.stopPropagation?.();
      onPrev?.();
    },
    [onPrev]
  );
  const handleNext = useCallback(
    (e?: { stopPropagation?: () => void }) => {
      e?.stopPropagation?.();
      onNext?.();
    },
    [onNext]
  );

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        onClose();
        return;
      }
      if (e.key === "ArrowLeft") {
        e.preventDefault();
        onPrev?.();
        return;
      }
      if (e.key === "ArrowRight") {
        e.preventDefault();
        onNext?.();
      }
    };
    const prevOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    window.addEventListener("keydown", onKey);
    return () => {
      document.body.style.overflow = prevOverflow;
      window.removeEventListener("keydown", onKey);
    };
  }, [onClose, onPrev, onNext]);

  return createPortal(
    <div
      className="image-lightbox"
      role="dialog"
      aria-modal="true"
      aria-label={t("gallery.fullscreen")}
      onClick={onClose}
    >
      <button
        type="button"
        className="image-lightbox-close"
        onClick={onClose}
        aria-label={t("gallery.closeFullscreen")}
      >
        ×
      </button>
      {onPrev && (
        <button
          type="button"
          className="image-lightbox-nav image-lightbox-nav-prev"
          onClick={handlePrev}
          aria-label={t("gallery.prev")}
        >
          ‹
        </button>
      )}
      {onNext && (
        <button
          type="button"
          className="image-lightbox-nav image-lightbox-nav-next"
          onClick={handleNext}
          aria-label={t("gallery.next")}
        >
          ›
        </button>
      )}
      <img
        className="image-lightbox-img"
        src={src}
        alt={alt}
        onClick={(e) => e.stopPropagation()}
      />
    </div>,
    document.body
  );
}
