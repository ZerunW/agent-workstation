import { t } from "../i18n";
import { useApp } from "../store/app";
import { getDraft, getUploads, useComposer, type FileDraftAttachment, type ImageDraftAttachment } from "../store/composer";
import { toast } from "../store/toasts";
import { basename, joinPath, uuid } from "./format";
import { uploadFile } from "./upload";

export const MAX_INLINE_IMAGE_BYTES = 8 * 1024 * 1024;
/** Mirrors the hub's per-message limit. */
export const MAX_ATTACHMENTS = 20;

export function isImageFile(f: File): boolean {
  return f.type.startsWith("image/");
}

export function fileToImageAttachment(file: File): Promise<ImageDraftAttachment> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(reader.error ?? new Error("read failed"));
    reader.onload = () => {
      const url = String(reader.result);
      const comma = url.indexOf(",");
      resolve({ type: "image", mediaType: file.type || "image/png", dataBase64: url.slice(comma + 1), name: file.name || undefined });
    };
    reader.readAsDataURL(file);
  });
}

// Files behind the pending tiles, so a failed upload can be retried and a running one cancelled.
const inflight = new Map<string, { file: File; controller: AbortController }>();

function attachmentCount(key: string): number {
  const s = useComposer.getState();
  return getDraft(s.drafts, key).attachments.length + getUploads(s.uploads, key).length;
}

/**
 * Route dropped / pasted / picked files into the draft as tiles. Images are read inline (base64); any other file
 * is uploaded to inbox/ and attached as a file_ref — the composer text is never touched. The hub decides what
 * Claude sees: a path in Code sessions, the inlined document in Chat sessions.
 */
export async function ingestFiles(files: File[], draftKey: string, _mode?: "chat" | "code"): Promise<void> {
  if (files.length === 0) return;
  if (attachmentCount(draftKey) + files.length > MAX_ATTACHMENTS) {
    toast.error(t("composer.attachment.tooMany", { n: MAX_ATTACHMENTS }));
    return;
  }
  const images = files.filter(isImageFile);
  const others = files.filter((f) => !isImageFile(f));
  const composer = useComposer.getState();

  if (images.length) {
    const ok: ImageDraftAttachment[] = [];
    for (const f of images) {
      if (f.size > MAX_INLINE_IMAGE_BYTES) {
        toast.error(t("composer.image.tooLarge", { name: f.name || "image" }));
        continue;
      }
      try {
        ok.push(await fileToImageAttachment(f));
      } catch {
        toast.error(t("app.error.generic"));
      }
    }
    if (ok.length) composer.addAttachments(draftKey, ok);
  }

  if (others.length) {
    if (useApp.getState().disk?.level === "block") {
      toast.error(t("disk.blocked.upload"));
      return;
    }
    await Promise.all(others.map((file) => startUpload(draftKey, file)));
  }
  useComposer.getState().requestFocus();
}

async function startUpload(draftKey: string, file: File, reuseId?: string): Promise<void> {
  const id = reuseId ?? uuid();
  const controller = new AbortController();
  inflight.set(id, { file, controller });
  const composer = useComposer.getState();
  if (reuseId) composer.updateUpload(draftKey, id, { progress: 0, error: undefined });
  else composer.addUpload(draftKey, { id, name: file.name || "file", size: file.size, progress: 0 });
  try {
    const res = await uploadFile(file, {
      path: joinPath("inbox", basename(file.name || "file")),
      signal: controller.signal,
      onProgress: (p) => useComposer.getState().updateUpload(draftKey, id, { progress: p.totalBytes > 0 ? p.sentBytes / p.totalBytes : 1 }),
    });
    // The tile may have been removed while uploading: then the file simply stays in inbox/ unattached.
    const still = getUploads(useComposer.getState().uploads, draftKey).some((u) => u.id === id);
    useComposer.getState().removeUpload(draftKey, id);
    if (still) {
      const att: FileDraftAttachment = { type: "file_ref", path: res.path, name: basename(res.path), size: file.size };
      useComposer.getState().addAttachments(draftKey, [att]);
    }
    inflight.delete(id);
  } catch (e) {
    if ((e as Error)?.name === "AbortError") return;
    useComposer.getState().updateUpload(draftKey, id, { error: e instanceof Error ? e.message : String(e) });
  }
}

/** Retry a failed upload tile. */
export function retryUpload(draftKey: string, id: string): void {
  const entry = inflight.get(id);
  if (!entry) return;
  void startUpload(draftKey, entry.file, id);
}

/** Remove a pending tile; a running upload is aborted. */
export function cancelUpload(draftKey: string, id: string): void {
  inflight.get(id)?.controller.abort();
  inflight.delete(id);
  useComposer.getState().removeUpload(draftKey, id);
}
