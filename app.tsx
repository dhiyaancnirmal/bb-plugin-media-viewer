// bb-plugin-media-viewer frontend: one zoomable, pannable viewer for images,
// videos and audio. It replaces BB's preview for media files in the right
// panel and renders the `::media{file="..."}` directive inline in chat.
import { useCallback, useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import {
  definePluginApp,
  experimental_Icon as Icon,
  useBbNavigate,
  useRpc,
  type PluginFileOpenerProps,
  type PluginMessageDirectiveProps,
} from "@get-bb/plugin-sdk/app";
import { AUDIO_EXTENSIONS, IMAGE_EXTENSIONS, VIDEO_EXTENSIONS } from "./media.ts";
import type { MediaItem, MediaSource, rpcContract } from "./server.ts";

const MAX_SCALE = 32;
const STEP = 1.25;
const FRAME_SECONDS = 1 / 30;
const SPEEDS = [0.25, 0.5, 1, 1.5, 2];

type Size = { width: number; height: number };
type View = { scale: number; x: number; y: number; fitted: boolean };
type Resolved = { items: MediaItem[]; index: number };

function useResolved(source: MediaSource | null, path: string) {
  const rpc = useRpc<typeof rpcContract>();
  const [state, setState] = useState<{ resolved: Resolved | null; error: string | null }>({ resolved: null, error: null });
  const key = JSON.stringify([source, path]);
  useEffect(() => {
    if (!source) return;
    let live = true;
    setState({ resolved: null, error: null });
    rpc.call("resolve", { source, path }).then(
      (resolved) => live && setState({ resolved, error: null }),
      (error: unknown) => live && setState({ resolved: null, error: error instanceof Error ? error.message : String(error) }),
    );
    return () => {
      live = false;
    };
    // `key` stands for source and path, which callers rebuild on every render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rpc, key]);
  return state;
}

const absolute = (url: string) => new URL(url, window.location.href).href;

/** Zoom and pan for one image or video frame inside a viewport element. */
function usePanZoom(natural: Size | null, captureWheel: (view: View) => boolean) {
  const viewport = useRef<HTMLDivElement>(null);
  const [view, setView] = useState<View>({ scale: 1, x: 0, y: 0, fitted: true });
  const current = useRef(view);
  current.current = view;

  const fitScale = useCallback(() => {
    const element = viewport.current;
    if (!element || !natural || !natural.width || !natural.height) return 1;
    return Math.min(1, element.clientWidth / natural.width, element.clientHeight / natural.height);
  }, [natural]);

  // Centre content smaller than the viewport; otherwise keep its edges from
  // leaving gaps.
  const settle = useCallback(
    (next: View): View => {
      const element = viewport.current;
      if (!element || !natural) return next;
      const place = (offset: number, content: number, room: number) =>
        content <= room ? (room - content) / 2 : Math.min(0, Math.max(room - content, offset));
      return {
        ...next,
        x: place(next.x, natural.width * next.scale, element.clientWidth),
        y: place(next.y, natural.height * next.scale, element.clientHeight),
      };
    },
    [natural],
  );

  const apply = useCallback((next: View) => {
    current.current = next;
    setView(next);
  }, []);

  const fit = useCallback(() => apply(settle({ scale: fitScale(), x: 0, y: 0, fitted: true })), [apply, settle, fitScale]);

  const zoomTo = useCallback(
    (scale: number, at?: { x: number; y: number }, from: View = current.current) => {
      const element = viewport.current;
      if (!element) return;
      const point = at ?? { x: element.clientWidth / 2, y: element.clientHeight / 2 };
      const next = Math.min(MAX_SCALE, Math.max(Math.min(fitScale(), 1) / 2, scale));
      const ratio = next / from.scale;
      apply(settle({ scale: next, x: point.x - (point.x - from.x) * ratio, y: point.y - (point.y - from.y) * ratio, fitted: false }));
    },
    [apply, settle, fitScale],
  );

  useLayoutEffect(() => {
    if (natural) fit();
  }, [natural, fit]);

  useEffect(() => {
    const element = viewport.current;
    if (!element) return;
    const observer = new ResizeObserver(() => {
      if (current.current.fitted) fit();
      else apply(settle(current.current));
    });
    observer.observe(element);
    return () => observer.disconnect();
  }, [fit, apply, settle]);

  // Pinch on a trackpad arrives as ctrl+wheel. Plain wheel pans once zoomed in.
  useEffect(() => {
    const element = viewport.current;
    if (!element) return;
    const onWheel = (event: WheelEvent) => {
      const box = element.getBoundingClientRect();
      if (event.ctrlKey || event.metaKey) {
        event.preventDefault();
        const delta = Math.max(-50, Math.min(50, event.deltaY));
        zoomTo(current.current.scale * Math.exp(-delta * 0.01), { x: event.clientX - box.left, y: event.clientY - box.top });
        return;
      }
      if (!captureWheel(current.current)) return;
      event.preventDefault();
      const from = current.current;
      apply(settle({ ...from, x: from.x - event.deltaX, y: from.y - event.deltaY }));
    };
    element.addEventListener("wheel", onWheel, { passive: false });
    return () => element.removeEventListener("wheel", onWheel);
  }, [zoomTo, apply, settle, captureWheel]);

  // Drag pans; two fingers pinch.
  const pointers = useRef(new Map<number, { x: number; y: number }>());
  const gesture = useRef<{ view: View; mid: { x: number; y: number }; distance: number; count: number } | null>(null);
  const begin = () => {
    const points = [...pointers.current.values()];
    const box = viewport.current!.getBoundingClientRect();
    const mid = {
      x: points.reduce((sum, point) => sum + point.x, 0) / points.length - box.left,
      y: points.reduce((sum, point) => sum + point.y, 0) / points.length - box.top,
    };
    const distance = points.length > 1 ? Math.hypot(points[0].x - points[1].x, points[0].y - points[1].y) : 0;
    gesture.current = { view: current.current, mid, distance, count: points.length };
  };
  const handlers = {
    onPointerDown(event: React.PointerEvent) {
      if (event.pointerType === "mouse" && event.button !== 0) return;
      event.currentTarget.setPointerCapture(event.pointerId);
      pointers.current.set(event.pointerId, { x: event.clientX, y: event.clientY });
      begin();
    },
    onPointerMove(event: React.PointerEvent) {
      if (!pointers.current.has(event.pointerId)) return;
      pointers.current.set(event.pointerId, { x: event.clientX, y: event.clientY });
      const start = gesture.current;
      if (!start) return;
      const points = [...pointers.current.values()];
      const box = viewport.current!.getBoundingClientRect();
      const mid = {
        x: points.reduce((sum, point) => sum + point.x, 0) / points.length - box.left,
        y: points.reduce((sum, point) => sum + point.y, 0) / points.length - box.top,
      };
      if (start.count > 1 && points.length > 1 && start.distance > 0) {
        const distance = Math.hypot(points[0].x - points[1].x, points[0].y - points[1].y);
        const scale = Math.min(MAX_SCALE, Math.max(Math.min(fitScale(), 1) / 2, (start.view.scale * distance) / start.distance));
        const ratio = scale / start.view.scale;
        apply(settle({ scale, x: mid.x - (start.mid.x - start.view.x) * ratio, y: mid.y - (start.mid.y - start.view.y) * ratio, fitted: false }));
      } else {
        apply(settle({ ...start.view, x: start.view.x + mid.x - start.mid.x, y: start.view.y + mid.y - start.mid.y }));
      }
    },
    onPointerUp(event: React.PointerEvent) {
      pointers.current.delete(event.pointerId);
      if (pointers.current.size) begin();
      else gesture.current = null;
    },
    onPointerCancel(event: React.PointerEvent) {
      pointers.current.delete(event.pointerId);
      gesture.current = pointers.current.size ? gesture.current : null;
    },
    onDoubleClick(event: React.MouseEvent) {
      if (!current.current.fitted) return fit();
      const box = viewport.current!.getBoundingClientRect();
      const fitted = fitScale();
      zoomTo(fitted < 1 ? 1 : fitted * 2.5, { x: event.clientX - box.left, y: event.clientY - box.top });
    },
  };

  return { viewport, view, fit, zoomTo, handlers };
}

// BB's icon set has no volume or frame-step icons; these follow Lucide's.
function Glyph({ children }: { children: ReactNode }) {
  return (
    <svg viewBox="0 0 24 24" className="size-4" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      {children}
    </svg>
  );
}
const FRAME_BACK = <Glyph><polygon points="19 20 9 12 19 4 19 20" /><line x1="5" x2="5" y1="19" y2="5" /></Glyph>;
const FRAME_FORWARD = <Glyph><polygon points="5 4 15 12 5 20 5 4" /><line x1="19" x2="19" y1="5" y2="19" /></Glyph>;
const SPEAKER = <polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5" />;
const SOUND_ON = <Glyph>{SPEAKER}<path d="M15.54 8.46a5 5 0 0 1 0 7.07" /><path d="M19.07 4.93a10 10 0 0 1 0 14.14" /></Glyph>;
const SOUND_OFF = <Glyph>{SPEAKER}<line x1="22" x2="16" y1="9" y2="15" /><line x1="16" x2="22" y1="9" y2="15" /></Glyph>;

function ToolButton({ label, icon, onClick, disabled }: { label: string; icon: string | ReactNode; onClick: () => void; disabled?: boolean }) {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      disabled={disabled}
      onClick={onClick}
      className="inline-flex size-7 shrink-0 cursor-pointer items-center justify-center rounded-md text-muted-foreground hover:bg-state-hover hover:text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring disabled:pointer-events-none disabled:opacity-40"
    >
      {typeof icon === "string" ? <Icon name={icon} className="size-4" aria-hidden /> : icon}
    </button>
  );
}

function TextButton({ children, label, onClick }: { children: ReactNode; label: string; onClick: () => void }) {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      onClick={onClick}
      className="h-7 shrink-0 cursor-pointer rounded-md px-2 text-xs font-medium text-muted-foreground tabular-nums hover:bg-state-hover hover:text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
    >
      {children}
    </button>
  );
}

const clock = (seconds: number) => {
  if (!Number.isFinite(seconds)) return "0:00";
  const whole = Math.max(0, Math.floor(seconds));
  const minutes = Math.floor(whole / 60);
  const hours = Math.floor(minutes / 60);
  const rest = String(whole % 60).padStart(2, "0");
  return hours ? `${hours}:${String(minutes % 60).padStart(2, "0")}:${rest}` : `${minutes}:${rest}`;
};

function VideoControls({ video }: { video: HTMLVideoElement }) {
  const [, rerender] = useState(0);
  useEffect(() => {
    const update = () => rerender((count) => count + 1);
    const events = ["play", "pause", "timeupdate", "durationchange", "ratechange", "volumechange", "seeked"];
    for (const name of events) video.addEventListener(name, update);
    return () => {
      for (const name of events) video.removeEventListener(name, update);
    };
  }, [video]);
  const step = (seconds: number) => {
    video.pause();
    video.currentTime = Math.min(video.duration || 0, Math.max(0, video.currentTime + seconds));
  };
  return (
    <div className="flex items-center gap-1 border-t border-border px-2 py-1">
      <ToolButton
        label={video.paused ? "Play" : "Pause"}
        icon={video.paused ? "Play" : "Pause"}
        onClick={() => (video.paused ? void video.play() : video.pause())}
      />
      <ToolButton label="Previous frame" icon={FRAME_BACK} onClick={() => step(-FRAME_SECONDS)} />
      <ToolButton label="Next frame" icon={FRAME_FORWARD} onClick={() => step(FRAME_SECONDS)} />
      <span className="shrink-0 px-1 text-xs text-muted-foreground tabular-nums">
        {clock(video.currentTime)} / {clock(video.duration)}
      </span>
      <input
        type="range"
        aria-label="Seek"
        min={0}
        max={video.duration || 0}
        step="any"
        value={video.currentTime}
        onChange={(event) => (video.currentTime = Number(event.currentTarget.value))}
        className="min-w-0 flex-1 cursor-pointer accent-foreground"
      />
      <select
        aria-label="Playback speed"
        value={video.playbackRate}
        onChange={(event) => (video.playbackRate = Number(event.currentTarget.value))}
        className="h-7 shrink-0 cursor-pointer rounded-md bg-transparent px-1 text-xs text-muted-foreground hover:bg-state-hover"
      >
        {SPEEDS.map((speed) => (
          <option key={speed} value={speed}>
            {speed}×
          </option>
        ))}
      </select>
      <ToolButton
        label={video.muted ? "Unmute" : "Mute"}
        icon={video.muted ? SOUND_OFF : SOUND_ON}
        onClick={() => (video.muted = !video.muted)}
      />
    </div>
  );
}

function MediaViewer({ items, start, inline, onOpenInPanel }: { items: MediaItem[]; start: number; inline: boolean; onOpenInPanel?: (item: MediaItem) => void }) {
  const [index, setIndex] = useState(start);
  useEffect(() => setIndex(start), [start]);
  const item = items[index] ?? items[0];
  // Keyed by URL: a cached file can load before an effect could reset state.
  const [loaded, setLoaded] = useState<{ url: string; size: Size } | null>(null);
  const [failedUrl, setFailedUrl] = useState<string | null>(null);
  const natural = loaded?.url === item.url ? loaded.size : null;
  const failed = failedUrl === item.url;
  const setNatural = (size: Size) => setLoaded({ url: item.url, size });
  const setFailed = () => setFailedUrl(item.url);
  const [video, setVideo] = useState<HTMLVideoElement | null>(null);
  const captureWheel = useCallback((view: View) => !inline || !view.fitted, [inline]);
  const { viewport, view, fit, zoomTo, handlers } = usePanZoom(natural, captureWheel);
  const go = (offset: number) => setIndex((current) => (current + offset + items.length) % items.length);

  const onKeyDown = (event: React.KeyboardEvent) => {
    if (event.target instanceof HTMLInputElement || event.target instanceof HTMLSelectElement) return;
    const key = event.key;
    if (key === "+" || key === "=") zoomTo(view.scale * STEP);
    else if (key === "-" || key === "_") zoomTo(view.scale / STEP);
    else if (key === "0") fit();
    else if (key === "1") zoomTo(1);
    else if (key === "ArrowLeft" && items.length > 1) go(-1);
    else if (key === "ArrowRight" && items.length > 1) go(1);
    else if (key === " " && video) video.paused ? void video.play() : video.pause();
    else if (key === "," && video) (video.pause(), (video.currentTime = Math.max(0, video.currentTime - FRAME_SECONDS)));
    else if (key === "." && video) (video.pause(), (video.currentTime = video.currentTime + FRAME_SECONDS));
    else return;
    event.preventDefault();
  };

  const src = absolute(item.url);
  const zoomable = item.kind !== "audio";
  const placed = {
    position: "absolute" as const,
    left: 0,
    top: 0,
    width: natural?.width,
    height: natural?.height,
    maxWidth: "none",
    transformOrigin: "0 0",
    transform: `translate(${view.x}px, ${view.y}px) scale(${view.scale})`,
    visibility: natural ? ("visible" as const) : ("hidden" as const),
    imageRendering: view.scale > 2 ? ("pixelated" as const) : undefined,
  };

  return (
    <div className="flex h-full min-h-0 flex-col bg-background text-foreground" onKeyDown={onKeyDown}>
      <div className="flex min-h-9 flex-wrap items-center gap-1 border-b border-border px-2 py-1">
        {items.length > 1 ? (
          <>
            <ToolButton label="Previous file" icon="ChevronLeft" onClick={() => go(-1)} />
            <span className="shrink-0 text-xs text-muted-foreground tabular-nums">
              {index + 1} / {items.length}
            </span>
            <ToolButton label="Next file" icon="ChevronRight" onClick={() => go(1)} />
          </>
        ) : null}
        <span className="min-w-0 flex-1 truncate px-1 text-xs" title={item.name}>
          {item.name}
          {natural && item.kind !== "audio" ? (
            <span className="ml-2 text-muted-foreground tabular-nums">
              {natural.width} × {natural.height}
            </span>
          ) : null}
        </span>
        {zoomable ? (
          <>
            <ToolButton label="Zoom out" icon="ZoomOut" onClick={() => zoomTo(view.scale / STEP)} />
            <span className="w-11 shrink-0 text-center text-xs text-muted-foreground tabular-nums" aria-live="polite">
              {Math.round(view.scale * 100)}%
            </span>
            <ToolButton label="Zoom in" icon="ZoomIn" onClick={() => zoomTo(view.scale * STEP)} />
            <TextButton label="Fit to view" onClick={fit}>
              Fit
            </TextButton>
            <TextButton label="Actual size" onClick={() => zoomTo(1)}>
              100%
            </TextButton>
          </>
        ) : null}
        {onOpenInPanel && item.target ? <ToolButton label="Open in side panel" icon="PanelRight" onClick={() => onOpenInPanel(item)} /> : null}
      </div>
      {failed ? (
        <div className="flex flex-1 items-center justify-center p-4 text-center text-sm text-muted-foreground">
          {item.name} could not be loaded. The file may have moved, or this format may not play here.
        </div>
      ) : item.kind === "audio" ? (
        <div className="flex flex-1 items-center justify-center p-4">
          <audio key={src} src={src} controls preload="metadata" className="w-full max-w-xl" onError={setFailed} />
        </div>
      ) : (
        <div
          ref={viewport}
          tabIndex={0}
          role="img"
          aria-label={`${item.name}. Drag to pan, pinch or Ctrl+scroll to zoom, double-click to toggle fit.`}
          className="relative min-h-0 flex-1 cursor-grab select-none overflow-hidden bg-[repeating-conic-gradient(var(--color-muted)_0%_25%,transparent_0%_50%)] bg-[length:16px_16px] outline-none focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-ring active:cursor-grabbing"
          style={{ touchAction: inline && view.fitted ? "pan-y" : "none" }}
          {...handlers}
        >
          {item.kind === "image" ? (
            <img
              key={src}
              src={src}
              alt={item.name}
              draggable={false}
              style={placed}
              onLoad={(event) => setNatural({ width: event.currentTarget.naturalWidth, height: event.currentTarget.naturalHeight })}
              onError={setFailed}
            />
          ) : (
            <video
              key={src}
              ref={setVideo}
              src={src}
              playsInline
              preload="metadata"
              style={placed}
              onLoadedMetadata={(event) => setNatural({ width: event.currentTarget.videoWidth, height: event.currentTarget.videoHeight })}
              onError={setFailed}
            />
          )}
          {!natural ? <div className="absolute inset-0 flex items-center justify-center text-xs text-muted-foreground">Loading…</div> : null}
        </div>
      )}
      {item.kind === "video" && video && !failed ? <VideoControls video={video} /> : null}
    </div>
  );
}

function Message({ children, tone = "muted" }: { children: ReactNode; tone?: "muted" | "error" }) {
  return (
    <div className={tone === "error" ? "p-3 text-sm text-destructive" : "flex h-full items-center justify-center p-3 text-xs text-muted-foreground"}>
      {children}
    </div>
  );
}

function PanelViewer({ path, source, Original }: PluginFileOpenerProps) {
  const [original, setOriginal] = useState(false);
  const { resolved, error } = useResolved(
    {
      kind: source.kind,
      threadId: source.threadId,
      environmentId: source.environmentId,
      projectId: source.projectId,
      hostId: source.experimental_hostId ?? null,
    },
    path,
  );
  if (original) return <Original />;
  if (error)
    return (
      <Message tone="error">
        Could not open {path}: {error}{" "}
        <button type="button" className="underline" onClick={() => setOriginal(true)}>
          Use BB's preview
        </button>
      </Message>
    );
  if (!resolved) return <Message>Loading…</Message>;
  return <MediaViewer items={resolved.items} start={resolved.index} inline={false} />;
}

function InlineViewer({ attributes, message }: PluginMessageDirectiveProps) {
  const navigate = useBbNavigate();
  const file = (attributes.file ?? "").trim();
  const requested = attributes.source?.trim();
  const kind: MediaSource["kind"] = file.startsWith("/") ? "host" : requested === "thread-storage" ? "thread-storage" : "workspace";
  const height = Math.min(1600, Math.max(200, Number(attributes.height) || 520));
  const { resolved, error } = useResolved(
    file ? { kind, threadId: message.threadId, environmentId: null, projectId: null, hostId: null } : null,
    file,
  );
  const body = !file ? (
    <Message tone="error">The media directive needs a file, like ::media{"{"}file="/path/to/shot.png"{"}"}.</Message>
  ) : error ? (
    <Message tone="error">
      Could not show {file}: {error}
    </Message>
  ) : !resolved ? (
    <Message>Loading {file}…</Message>
  ) : (
    <MediaViewer
      items={resolved.items}
      start={resolved.index}
      inline
      onOpenInPanel={(item) => item.target && navigate.experimental_openFilePreview({ target: item.target, location: null })}
    />
  );
  return (
    <div className="my-2 overflow-hidden rounded-lg border border-border" style={{ height: resolved && resolved.items[resolved.index]?.kind === "audio" ? undefined : height }}>
      {body}
    </div>
  );
}

export default definePluginApp((app) => {
  app.slots.fileOpener({
    id: "media",
    title: "Media viewer",
    extensions: [...IMAGE_EXTENSIONS, ...VIDEO_EXTENSIONS, ...AUDIO_EXTENSIONS],
    component: PanelViewer,
  });
  app.slots.messageDirective({ id: "media", component: InlineViewer });
});
