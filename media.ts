// File types the viewer handles, shared by the server and the app bundle.
export const IMAGE_EXTENSIONS = ["png", "jpg", "jpeg", "webp", "gif", "avif", "bmp", "ico", "svg"] as const;
export const VIDEO_EXTENSIONS = ["mp4", "m4v", "mov", "webm"] as const;
export const AUDIO_EXTENSIONS = ["mp3", "m4a", "aac", "wav", "ogg", "oga", "opus", "flac"] as const;

export type MediaKind = "image" | "video" | "audio";

export function mediaKind(file: string): MediaKind | null {
  const name = file.slice(file.lastIndexOf("/") + 1);
  const dot = name.lastIndexOf(".");
  if (dot <= 0) return null;
  const extension = name.slice(dot + 1).toLowerCase();
  if ((IMAGE_EXTENSIONS as readonly string[]).includes(extension)) return "image";
  if ((VIDEO_EXTENSIONS as readonly string[]).includes(extension)) return "video";
  if ((AUDIO_EXTENSIONS as readonly string[]).includes(extension)) return "audio";
  return null;
}
