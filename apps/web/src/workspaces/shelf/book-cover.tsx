import { useEffect, useState, type CSSProperties } from "react";

import { LapisMark } from "../../components/lapis-mark";
import { useI18n } from "../../i18n";
import {
  projectCoverBlob,
  projectCoverUrl,
  type Project,
} from "../../lib/api";
import { coverHue } from "../../lib/fmt";

export function BookCover({ project }: { project: Project }) {
  const { t } = useI18n();
  const imageUrl = projectCoverUrl(project);
  const [localUrl, setLocalUrl] = useState<string | null>(
    imageUrl && imageUrl.startsWith("blob:") ? imageUrl : null,
  );
  useEffect(() => {
    // local 驱动下封面无 HTTP URL，改取内核 bytes 缓存为 Blob URL。
    if (!project.cover || imageUrl) return;
    let cancelled = false;
    void projectCoverBlob(project)
      .then((url) => {
        if (!cancelled && url) setLocalUrl(url);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [project, imageUrl]);
  const crop = project.cover?.crop;
  const src = imageUrl ?? localUrl;
  return (
    <div
      className="book-cover"
      style={{ "--book-hue": coverHue(project.id) } as CSSProperties}
    >
      {src ? (
        <img
          className="book-cover__image"
          src={src}
          alt={t("shelf.book.customCover", { name: project.title })}
          style={{
            objectPosition: `${(crop?.x ?? 0.5) * 100}% ${(crop?.y ?? 0.5) * 100}%`,
            transform: `scale(${crop?.zoom ?? 1})`,
            transformOrigin: `${(crop?.x ?? 0.5) * 100}% ${(crop?.y ?? 0.5) * 100}%`,
          }}
        />
      ) : (
        <div
          className="book-cover__default"
          role="img"
          aria-label={t("shelf.book.defaultCover", { name: project.title })}
        >
          <span className="book-cover__mark mono">
            Lapis · {project.phase.slice(0, 1).toUpperCase()}
          </span>
          <strong>{project.title}</strong>
          <span>{project.subtitle ?? t("shelf.book.unfinished")}</span>
          <LapisMark variant="cover" mono />
        </div>
      )}
      <span className="book-cover__edge" aria-hidden="true" />
    </div>
  );
}
