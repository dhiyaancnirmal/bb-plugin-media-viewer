---
name: media-viewer
description: Show images, screenshots, videos and audio to the user in BB's right panel or inline in chat, with zoom, pan and playback controls. Use whenever you present visual results or ask for visual feedback.
---

# Media viewer

The Media viewer plugin opens image, video and audio files in BB's right
panel with zoom, pan and playback controls. It also renders a `::media`
directive inline in your reply.

Images: png, jpg, jpeg, webp, gif, avif, bmp, ico, svg. Videos: mp4, m4v,
mov, webm. Audio: mp3, m4a, aac, wav, ogg, oga, opus, flac.

## Show media in the right panel

Put the files you want to show in one folder in this thread's storage, then
open the first one:

```sh
dir="$BB_THREAD_STORAGE/media/login-review"
mkdir -p "$dir"
cp /path/to/before.png "$dir/01-before.png"
cp /path/to/after.png "$dir/02-after.png"
bb thread open "$BB_THREAD_ID" "$dir/01-before.png" --json
```

The viewer steps through every image, video and audio file in that folder,
in name order, so number the files in the order you want them seen. A
folder holding only the files you mean to show keeps the set clean.

`bb thread open` accepts only paths in this thread's workspace or
`$BB_THREAD_STORAGE`. Copy files from anywhere else, including another
thread's storage, into your own storage first. Fetch files from another
machine before copying them.

## Show media inline in chat

Write the directive on its own line in your reply, not in a code block:

```text
::media{file="/absolute/path/to/shot.png"}
```

- An absolute `file` is read on the machine this thread runs on.
- A relative `file` is read from the thread's workspace, or from its
  storage with `source="thread-storage"`.
- `height` sets the viewer height in pixels, from 200 to 1600 (default 520).

The inline viewer has the same controls and a button that opens the file in
the right panel.

## Controls

- Drag to pan. Pinch, or Ctrl or Cmd and scroll, to zoom at the pointer.
- Double-click toggles between Fit and a close-up at the pointer.
- Toolbar: previous and next file, zoom out, zoom in, Fit and 100%.
- Keys: `+` and `-` zoom, `0` fits, `1` shows actual size, arrow keys change
  file. For video, Space plays or pauses and `,` and `.` step one frame.
- Video has play, frame step, a seek bar, speed from 0.25× to 2× and mute.

Opening a file the viewer cannot decode shows an error. In the right panel
it offers BB's own preview instead.
