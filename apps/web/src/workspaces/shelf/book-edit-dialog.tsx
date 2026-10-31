import { useMutation } from "@tanstack/react-query";
import { Image as ImageIcon, RotateCcw } from "lucide-react";
import { useState, type FormEvent } from "react";
import Cropper, { type Area, type Point } from "react-easy-crop";

import { useFocusTrap } from "../../app/focus-trap";
import { ErrorNote } from "../../components/error-note";
import {
  LOCALES,
  LOCALE_LABELS,
  getLocale,
  translate,
  useI18n,
} from "../../i18n";
import {
  updateProject,
  type Project,
  type ProjectCoverMutation,
  type ProjectLanguage,
} from "../../lib/api";
import { BookCover } from "./book-cover";
import { ShelfDialog } from "./dialog";

interface PreparedCover {
  mediaType: "image/jpeg" | "image/png" | "image/webp";
  imageBase64: string;
  width: number;
  height: number;
  dataUrl: string;
}

function CoverCropDialog({
  prepared,
  onConfirm,
  onClose,
}: {
  prepared: PreparedCover;
  onConfirm: (cropped: PreparedCover) => void;
  onClose: () => void;
}) {
  const { t } = useI18n();
  const trapRef = useFocusTrap<HTMLDivElement>(onClose);
  const [point, setPoint] = useState<Point>({ x: 0, y: 0 });
  const [zoom, setZoom] = useState(1);
  const [area, setArea] = useState<Area | null>(null);
  const [cutting, setCutting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const confirm = async () => {
    if (!area || cutting) return;
    setCutting(true);
    setError(null);
    try {
      const cropped = await cropPreparedCover(prepared, area);
      onConfirm(cropped);
    } catch (cause) {
      setError(
        cause instanceof Error ? cause.message : t("shelf.crop.fallback"),
      );
      setCutting(false);
    }
  };

  return (
    <div
      className="shelf-dialog-backdrop"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <div
        ref={trapRef}
        className="shelf-dialog shelf-dialog--crop"
        role="dialog"
        aria-modal="true"
        aria-label={t("shelf.crop.title")}
      >
        <p className="shelf-dialog__eyebrow mono">{t("shelf.crop.eyebrow")}</p>
        <h2 className="shelf-dialog__title">{t("shelf.crop.title")}</h2>
        <p className="shelf-dialog__note">{t("shelf.crop.note")}</p>
        <div className="cover-cropper__stage cover-cropper__stage--dialog">
          <Cropper
            image={prepared.dataUrl}
            crop={point}
            zoom={zoom}
            aspect={3 / 4}
            minZoom={1}
            maxZoom={3}
            cropShape="rect"
            showGrid
            onCropChange={setPoint}
            onZoomChange={setZoom}
            onCropComplete={(_percent, pixels) => setArea(pixels)}
          />
        </div>
        {error ? (
          <div className="shelf-dialog__error">
            <ErrorNote error={error} title={t("shelf.crop.error")} />
          </div>
        ) : null}
        <div className="shelf-dialog__actions">
          <button type="button" className="btn btn--outline" onClick={onClose}>
            {t("common.action.cancel")}
          </button>
          <button
            type="button"
            className="btn btn--primary"
            disabled={!area || cutting}
            onClick={() => void confirm()}
          >
            {cutting ? t("shelf.crop.cutting") : t("shelf.crop.confirm")}
          </button>
        </div>
      </div>
    </div>
  );
}

function cropPreparedCover(
  source: PreparedCover,
  area: Area,
): Promise<PreparedCover> {
  return new Promise((resolve, reject) => {
    const image = new Image();
    image.onerror = () =>
      reject(new Error(translate(getLocale(), "shelf.coverFile.cropRead")));
    image.onload = () => {
      const canvas = document.createElement("canvas");
      canvas.width = Math.max(1, Math.round(area.width));
      canvas.height = Math.max(1, Math.round(area.height));
      const context = canvas.getContext("2d");
      if (!context) {
        reject(
          new Error(translate(getLocale(), "shelf.coverFile.unsupported")),
        );
        return;
      }
      context.drawImage(
        image,
        area.x,
        area.y,
        area.width,
        area.height,
        0,
        0,
        canvas.width,
        canvas.height,
      );
      canvas.toBlob(
        (blob) => {
          if (!blob) {
            reject(
              new Error(translate(getLocale(), "shelf.coverFile.cropFail")),
            );
            return;
          }
          const reader = new FileReader();
          reader.onerror = () =>
            reject(new Error(translate(getLocale(), "shelf.coverFile.encode")));
          reader.onload = () => {
            const dataUrl = String(reader.result ?? "");
            const comma = dataUrl.indexOf(",");
            if (comma < 0) {
              reject(
                new Error(
                  translate(getLocale(), "shelf.coverFile.encodeInvalid"),
                ),
              );
              return;
            }
            resolve({
              mediaType: "image/webp",
              imageBase64: dataUrl.slice(comma + 1),
              width: canvas.width,
              height: canvas.height,
              dataUrl,
            });
          };
          reader.readAsDataURL(blob);
        },
        "image/webp",
        0.9,
      );
    };
    image.src = source.dataUrl;
  });
}

function readCoverFile(file: File): Promise<PreparedCover> {
  const mediaType = file.type as PreparedCover["mediaType"];
  if (!["image/jpeg", "image/png", "image/webp"].includes(mediaType)) {
    return Promise.reject(
      new Error(translate(getLocale(), "shelf.coverFile.type")),
    );
  }
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () =>
      reject(new Error(translate(getLocale(), "shelf.coverFile.read")));
    reader.onload = () => {
      const dataUrl = String(reader.result ?? "");
      const image = new Image();
      image.onerror = () =>
        reject(new Error(translate(getLocale(), "shelf.coverFile.identify")));
      image.onload = () => {
        const maxEdge = 2400;
        const scale = Math.min(
          1,
          maxEdge / Math.max(image.naturalWidth, image.naturalHeight),
        );
        const width = Math.max(1, Math.round(image.naturalWidth * scale));
        const height = Math.max(1, Math.round(image.naturalHeight * scale));
        const canvas = document.createElement("canvas");
        canvas.width = width;
        canvas.height = height;
        const context = canvas.getContext("2d");
        if (!context) {
          reject(
            new Error(translate(getLocale(), "shelf.coverFile.unsupported")),
          );
          return;
        }
        context.drawImage(image, 0, 0, width, height);
        canvas.toBlob(
          (blob) => {
            if (!blob) {
              reject(
                new Error(translate(getLocale(), "shelf.coverFile.compress")),
              );
              return;
            }
            if (blob.size > 8 * 1024 * 1024) {
              reject(
                new Error(translate(getLocale(), "shelf.coverFile.tooLarge")),
              );
              return;
            }
            const outputReader = new FileReader();
            outputReader.onerror = () =>
              reject(
                new Error(translate(getLocale(), "shelf.coverFile.process")),
              );
            outputReader.onload = () => {
              const outputUrl = String(outputReader.result ?? "");
              const comma = outputUrl.indexOf(",");
              if (comma < 0) {
                reject(
                  new Error(
                    translate(getLocale(), "shelf.coverFile.encodeInvalid"),
                  ),
                );
                return;
              }
              resolve({
                mediaType: "image/webp",
                imageBase64: outputUrl.slice(comma + 1),
                width,
                height,
                dataUrl: outputUrl,
              });
            };
            outputReader.readAsDataURL(blob);
          },
          "image/webp",
          0.9,
        );
      };
      image.src = dataUrl;
    };
    reader.readAsDataURL(file);
  });
}

export function BookEditDialog({
  project,
  onClose,
  onSaved,
}: {
  project: Project;
  onClose: () => void;
  onSaved: () => void;
}) {
  const { t } = useI18n();
  const [title, setTitle] = useState(project.title);
  const [subtitle, setSubtitle] = useState(project.subtitle ?? "");
  const [premise, setPremise] = useState(project.premise ?? "");
  const [language, setLanguage] = useState<ProjectLanguage>(project.language);
  const [prepared, setPrepared] = useState<PreparedCover | null>(null);
  const [removeCover, setRemoveCover] = useState(false);
  const [cropSource, setCropSource] = useState<PreparedCover | null>(null);
  const [fileError, setFileError] = useState<string | null>(null);
  const [readingFile, setReadingFile] = useState(false);
  const mutation = useMutation({
    mutationFn: async () => {
      const cover: ProjectCoverMutation | undefined = removeCover
        ? { action: "remove" }
        : prepared
          ? {
              action: "put",
              mediaType: prepared.mediaType,
              imageBase64: prepared.imageBase64,
              width: prepared.width,
              height: prepared.height,
              crop: { x: 0.5, y: 0.5, zoom: 1 },
            }
          : undefined;
      await updateProject(project.id, {
        title: title.trim(),
        subtitle: subtitle.trim() || null,
        premise: premise.trim() || null,
        language,
        archived: project.archivedAt !== null,
        expectedUpdatedAt: project.updatedAt,
        ...(cover ? { cover } : {}),
      });
    },
    onSuccess: () => onSaved(),
  });

  const submit = (event: FormEvent) => {
    event.preventDefault();
    const trimmed = title.trim();
    if (!trimmed) return;
    mutation.mutate();
  };

  return (
    <ShelfDialog
      eyebrow={t("shelf.edit.eyebrow")}
      title={t("shelf.edit.title")}
      note={t("shelf.edit.note")}
      className="shelf-dialog--book-edit"
      onClose={onClose}
    >
      <form onSubmit={submit}>
        <div className="book-edit__layout">
          <div className="book-edit__preview">
            {prepared ? (
              <div className="book-cover book-cover--editing">
                <img
                  className="book-cover__image"
                  src={prepared.dataUrl}
                  alt={t("shelf.edit.previewAlt")}
                />
              </div>
            ) : removeCover ? (
              <div className="book-cover book-cover--editing">
                <div className="book-cover__default">
                  <strong>{title}</strong>
                  <span>{t("shelf.edit.restoreDefault")}</span>
                  <i aria-hidden="true" />
                </div>
              </div>
            ) : (
              <BookCover
                project={{ ...project, title, subtitle: subtitle || null }}
              />
            )}
            <label className="btn btn--outline book-edit__upload">
              <ImageIcon size={14} strokeWidth={1.5} aria-hidden="true" />
              {readingFile ? t("shelf.edit.reading") : t("shelf.edit.choose")}
              <input
                type="file"
                accept="image/jpeg,image/png,image/webp"
                hidden
                onChange={(event) => {
                  const file = event.target.files?.[0];
                  event.target.value = "";
                  if (!file) return;
                  setReadingFile(true);
                  setFileError(null);
                  void readCoverFile(file)
                    .then((value) => {
                      setRemoveCover(false);
                      setCropSource(value);
                    })
                    .catch((error: unknown) =>
                      setFileError(
                        error instanceof Error
                          ? error.message
                          : t("shelf.edit.readError"),
                      ),
                    )
                    .finally(() => setReadingFile(false));
                }}
              />
            </label>
            <button
              type="button"
              className="book-edit__reset"
              onClick={() => {
                setPrepared(null);
                setRemoveCover(true);
              }}
            >
              <RotateCcw size={13} strokeWidth={1.5} aria-hidden="true" />
              {t("shelf.edit.reset")}
            </button>
          </div>
          <div className="book-edit__fields">
            <div className="shelf-dialog__field">
              <label
                className="shelf-dialog__label mono"
                htmlFor="edit-title"
              >
                {t("shelf.edit.titleLabel")}
              </label>
              <input
                id="edit-title"
                className="shelf-dialog__input"
                value={title}
                onChange={(event) => setTitle(event.target.value)}
                autoFocus
              />
            </div>
            <div className="shelf-dialog__field">
              <label
                className="shelf-dialog__label mono"
                htmlFor="edit-subtitle"
              >
                {t("shelf.edit.subtitleLabel")}
              </label>
              <input
                id="edit-subtitle"
                className="shelf-dialog__input"
                value={subtitle}
                onChange={(event) => setSubtitle(event.target.value)}
                placeholder={t("shelf.edit.subtitlePlaceholder")}
              />
            </div>
            <div className="shelf-dialog__field">
              <label
                className="shelf-dialog__label mono"
                htmlFor="edit-premise"
              >
                {t("shelf.edit.premiseLabel")}
              </label>
              <textarea
                id="edit-premise"
                className="shelf-dialog__textarea"
                rows={4}
                value={premise}
                onChange={(event) => setPremise(event.target.value)}
                placeholder={t("shelf.edit.premisePlaceholder")}
              />
            </div>
            <div className="shelf-dialog__field">
              <label
                className="shelf-dialog__label mono"
                htmlFor="edit-language"
              >
                {t("shelf.edit.languageLabel")}
              </label>
              <select
                id="edit-language"
                className="shelf-dialog__input"
                value={language}
                onChange={(event) =>
                  setLanguage(event.target.value as ProjectLanguage)
                }
              >
                {LOCALES.map((locale) => (
                  <option key={locale} value={locale}>
                    {LOCALE_LABELS[locale]}
                  </option>
                ))}
              </select>
            </div>
            <p className="book-edit__hint">{t("shelf.edit.hint")}</p>
          </div>
        </div>
        {fileError ? (
          <div className="shelf-dialog__error">
            <ErrorNote error={fileError} title={t("shelf.edit.fileError")} />
          </div>
        ) : null}
        {mutation.isError ? (
          <div className="shelf-dialog__error">
            <ErrorNote error={mutation.error} title={t("shelf.edit.saveError")} />
          </div>
        ) : null}
        <div className="shelf-dialog__actions">
          <button type="button" className="btn btn--outline" onClick={onClose}>
            {t("common.action.cancel")}
          </button>
          <button
            type="submit"
            className="btn btn--primary"
            disabled={mutation.isPending || readingFile || !title.trim()}
          >
            {mutation.isPending ? t("shelf.edit.saving") : t("shelf.edit.submit")}
          </button>
        </div>
      </form>
      {cropSource ? (
        <CoverCropDialog
          prepared={cropSource}
          onClose={() => setCropSource(null)}
          onConfirm={(cropped) => {
            setPrepared(cropped);
            setCropSource(null);
          }}
        />
      ) : null}
    </ShelfDialog>
  );
}
