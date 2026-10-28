# Media viewer for bb

Opens images, videos and audio in bb's right panel with zoom, pan and
playback controls, and shows them inline in chat with a `::media` directive.

- Drag to pan; pinch, or Ctrl or Cmd and scroll, to zoom at the pointer.
- Double-click toggles between Fit and a close-up. Fit and 100% buttons.
- Previous and next step through every media file in the same folder.
- Video: play, frame step, seek, speed from 0.25× to 2×, mute.
- Works on the desktop app, the web client and touch screens, and for files
  on any connected machine.

Images: png, jpg, jpeg, webp, gif, avif, bmp, ico, svg. Videos: mp4, m4v,
mov, webm. Audio: mp3, m4a, aac, wav, ogg, oga, opus, flac.

## Use

Matching files open in the viewer wherever bb opens a file in the right
panel: file links, the file picker and `bb thread open`. To use bb's own
preview for a file type, pick it under Settings → File openers, or use
"Open with" on a file.

Agents can show media inline by writing a directive on its own line:

```text
::media{file="/absolute/path/to/shot.png"}
::media{file="screens/home.png" source="thread-storage" height="400"}
```

The bundled `media-viewer` skill tells agents how to present media.

## Build

```sh
npm install
bb plugin build
bb plugin install .
```

The viewer streams files through bb's own file routes, which support byte
ranges, so long videos seek without downloading the whole file.
