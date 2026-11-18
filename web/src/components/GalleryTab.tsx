import { useCallback, useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import {
  deleteChatImage,
  downloadChatFile,
  fetchChatGallery,
  type GalleryImageItem,
} from "../api/chat";
import { apiBase } from "../config";
import { useChatPageContext } from "../context/ChatPageContext";
import { useT } from "../i18n";
import { resolveMediaSrc } from "../lib/cellRender";
import { buildImageEditPrompt } from "../lib/galleryActions";
import { IconDownload, IconSpark, IconTrash, IconExpand } from "./icons";
import { ImageLightbox } from "./ImageLightbox";
import { ImageEditDialog } from "./ImageEditDialog";

export function GalleryTab() {
  const t = useT();
  const navigate = useNavigate();
  const { currentChatId, onSeedPrompt, onImageRemoved } = useChatPageContext();
  const [images, setImages] = useState<GalleryImageItem[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busyPath, setBusyPath] = useState<string | null>(null);
  /** Index of the open lightbox; null — closed. */
  const [lightboxIndex, setLightboxIndex] = useState<number | null>(null);
  const [editTarget, setEditTarget] = useState<GalleryImageItem | null>(null);

  const load = useCallback(() => {
    if (!currentChatId) {
      setImages([]);
      setLoading(false);
      setError(null);
      return;
    }
    setLoading(true);
    setError(null);
    fetchChatGallery(currentChatId)
      .then(setImages)
      .catch((e) => setError(e instanceof Error ? e.message : String(e)))
      .finally(() => setLoading(false));
  }, [currentChatId]);

  useEffect(() => {
    load();
  }, [load]);

  useEffect(() => {
    if (lightboxIndex == null) return;
    if (images.length === 0) {
      setLightboxIndex(null);
      return;
    }
    if (lightboxIndex >= images.length) {
      setLightboxIndex(images.length - 1);
    }
  }, [images, lightboxIndex]);

  const openLightbox = (index: number) => setLightboxIndex(index);

  const handleSave = async (img: GalleryImageItem) => {
    setBusyPath(img.path);
    try {
      await downloadChatFile(img.path, img.name);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusyPath(null);
    }
  };

  const handleEdit = (img: GalleryImageItem) => {
    setLightboxIndex(null);
    setEditTarget(img);
  };

  const submitEdit = (edits: string) => {
    if (!editTarget) return;
    onSeedPrompt?.(buildImageEditPrompt(editTarget.url, edits));
    setEditTarget(null);
    navigate("/chat");
  };

  const handleDelete = async (img: GalleryImageItem, index: number) => {
    if (!window.confirm(t("gallery.deleteConfirm", { name: img.name }))) return;
    setBusyPath(img.path);
    try {
      await deleteChatImage(img.path, currentChatId ?? undefined);
      onImageRemoved?.(img.url);
      setImages((prev) => prev.filter((x) => x.path !== img.path));
      if (lightboxIndex === index) {
        setLightboxIndex((i) => {
          if (i == null) return null;
          if (images.length <= 1) return null;
          return Math.min(i, images.length - 2);
        });
      } else if (lightboxIndex != null && lightboxIndex > index) {
        setLightboxIndex(lightboxIndex - 1);
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusyPath(null);
    }
  };

  const lightboxImg = lightboxIndex != null ? images[lightboxIndex] : null;
  const lightboxSrc = lightboxImg ? resolveMediaSrc(lightboxImg.url, apiBase) : "";

  if (!currentChatId) {
    return <p className="gallery-empty">{t("gallery.noChat")}</p>;
  }

  return (
    <div className="gallery-panel">
      <p className="gallery-desc">{t("gallery.desc")}</p>
      {error && (
        <p className="gallery-error" role="alert">
          {error}
        </p>
      )}
      {loading ? (
        <p className="gallery-empty">{t("gallery.loading")}</p>
      ) : images.length === 0 ? (
        <p className="gallery-empty">{t("gallery.empty")}</p>
      ) : (
        <ul className="gallery-grid" aria-label={t("gallery.listAria")}>
          {images.map((img, index) => {
            const src = resolveMediaSrc(img.url, apiBase);
            const busy = busyPath === img.path;
            return (
              <li key={img.path} className="gallery-card">
                <div
                  className="gallery-card-preview"
                  onClick={() => openLightbox(index)}
                  role="button"
                  tabIndex={0}
                  onKeyDown={(e) => {
                    if (e.key === "Enter" || e.key === " ") {
                      e.preventDefault();
                      openLightbox(index);
                    }
                  }}
                  aria-label={t("gallery.fullscreen")}
                >
                  <img src={src} alt={img.name} loading="lazy" />
                </div>
                <div className="gallery-card-meta" title={img.name}>
                  {img.name}
                </div>
                <div className="gallery-card-actions">
                  <button
                    type="button"
                    className="gallery-btn"
                    disabled={busy}
                    onClick={() => openLightbox(index)}
                    title={t("gallery.fullscreen")}
                    aria-label={t("gallery.fullscreen")}
                  >
                    <IconExpand size={16} />
                    <span>{t("gallery.fullscreen")}</span>
                  </button>
                  <button
                    type="button"
                    className="gallery-btn"
                    disabled={busy}
                    onClick={() => void handleSave(img)}
                    title={t("gallery.save")}
                    aria-label={t("gallery.save")}
                  >
                    <IconDownload size={16} />
                    <span>{t("gallery.save")}</span>
                  </button>
                  <button
                    type="button"
                    className="gallery-btn"
                    disabled={busy}
                    onClick={() => handleEdit(img)}
                    title={t("gallery.edit")}
                    aria-label={t("gallery.edit")}
                  >
                    <IconSpark size={16} />
                    <span>{t("gallery.edit")}</span>
                  </button>
                  <button
                    type="button"
                    className="gallery-btn gallery-btn-danger"
                    disabled={busy}
                    onClick={() => void handleDelete(img, index)}
                    title={t("gallery.delete")}
                    aria-label={t("gallery.delete")}
                  >
                    <IconTrash size={16} />
                    <span>{t("gallery.delete")}</span>
                  </button>
                </div>
              </li>
            );
          })}
        </ul>
      )}
      {lightboxImg && lightboxIndex != null && (
        <ImageLightbox
          src={lightboxSrc}
          alt={lightboxImg.name}
          onClose={() => setLightboxIndex(null)}
          onPrev={
            images.length > 1
              ? () => setLightboxIndex((i) => (i == null ? 0 : (i - 1 + images.length) % images.length))
              : undefined
          }
          onNext={
            images.length > 1
              ? () => setLightboxIndex((i) => (i == null ? 0 : (i + 1) % images.length))
              : undefined
          }
        />
      )}
      {editTarget && (
        <ImageEditDialog
          imageName={editTarget.name}
          previewSrc={resolveMediaSrc(editTarget.url, apiBase)}
          onCancel={() => setEditTarget(null)}
          onSubmit={submitEdit}
        />
      )}
    </div>
  );
}
