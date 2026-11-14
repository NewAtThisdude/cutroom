# Changelog

## 0.1.0 (unreleased)

The first public release. Cutroom is a free video editor that runs entirely on your own computer, on a Mac or a
Windows PC. It is licensed GPL v3 or later.

### Editing and timeline

- Magnetic main track with overlay, audio, text, caption and effect tracks, and track toggles
- Multi-select, right-click menus, copy and paste, on-canvas handles and snapping
- Ripple, slip, slide and roll edits; J and L cuts; markers; clip colour labels
- Keyframes with easing, a keyframe curve editor with bezier handles, and keyframed masks (shapes, pen and AI masks)
- Speed ramps drawn as one curve, reverse, freeze frame, stabilize, detach audio, auto reframe
- Compound clips, multicam, adjustment layers
- Fade handles on clips: drag a top corner to fade in or out
- Paste attributes (Cmd/Ctrl+Alt+V, or right-click): copy one clip, select one or many, and tick what to paste (colour, effects, masks, transform, speed and ramps, sound, animations, transition, keyframes scaled to each clip or kept at their times); remembers the list, one undo step, skips with a note what a clip cannot take
- Split-screen layouts (side by side, stacked, one big and two small, grid of four, reaction, picture in picture) for any project shape: drop clips into the cells, pan and zoom inside a cell, gap colour and rounded corners; the cells stay ordinary clips you can trim and animate, and they re-flow when you change the layout or the canvas shape
- An undo history panel where you can jump to any step
- Project versions: automatic snapshots, named versions and restore in place
- Library source viewer with hover skim, In and Out points and Replace clip
- Library folders: nested bins you create, rename and delete (media is never deleted), drag one or several cards in and out, a breadcrumb, counts, and smart folders that fill themselves (videos, audio, photos, used in this project, not used anywhere, added today or this week); shared by every project and reachable by the MCP tools
- Command bar (Cmd-K / Ctrl-K) that plans edits with a local model, one undo step per command
- Import from Photos (Mac app), Open With and drag to the Dock icon
- Screen recorder: the whole screen, a window or an area, with your camera and microphone, each saved as its own file
  and placed in sync (camera as a movable picture-in-picture), and a teleprompter that stays out of the recording in the
  Mac app (in Edge on Windows a page can't hide its own window, so a whole-screen recording warns first and offers a window)
- Auto zoom for screen recordings: zooms in toward clicks and typing, follows the cursor and zooms out when it rests,
  as keyframes you can edit
- Package project: one `.cutroom` file with the project and every file it uses
- Timeline hand-off as FCPXML 1.10, CMX 3600 EDL and YouTube chapters
- Remappable keyboard shortcuts
- Crash recovery: edits made since the last save come back after a crash, a damaged project opens from its newest
  version, and an export cut short by a crash is listed with a Retry button
- Full screen preview (Shift+F or the button beside Theater): the picture alone at full quality, Esc leaves, playback keys keep working

### Effects, colour and transitions

- 30 video effects, 31 transitions, and an effects pack with 23 more transitions, 31 film looks and 15 effects
- Effects-pack effects and transitions run on the GPU in exports
- 12 blend modes that look the same in the preview and the export
- Colour grading on the GPU, curves, and scopes: waveform, RGB parade, histogram and vectorscope with a skin line
- Masked grades: a clip's mask can limit its colour to one object or area (or keep it out), and adjustment layers take
  their own mask (a shape, a pen outline, the AI subject of the video under them, or a shape that follows something); stack
  several, and the export matches the preview
- Before / after for colour (backslash, or the button under the preview): the clip or the whole frame without its colour work on one side of a line you drag, or side by side, effects optional; preview only, never in an export
- Motion blur, glow, clip blur and noise reduction
- Tracking with scale and rotation; blur or pixelate a region or every face, and the blur follows it
- Retouch: skin, eyes, teeth, makeup, face shape and body
- Share custom effects and transitions as `.cutroom-fx` files: save one, or import one by button or drag and drop;
  every imported file is checked before it can run

### Audio

- Volume points, EQ, pan, pitch, voice effects and stem separation
- Real noise removal and automatic ducking under speech
- A loudness meter (momentary, short-term and integrated LUFS) and loudness targets for exports
- A built-in library of CC0 sound effects and music
- Voiceover recording that lands where you spoke
- Audio visualizer (bars, mirrored bars, line, circle) in your brand colours, following one clip or the whole mix, with smoothing and sensitivity; worked out from the sound frame by frame, so the export matches the preview exactly

### Captions and text

- Automatic captions with 22 animated styles, a second-language line, keywords, emoji, lyrics and speaker labels
- Caption translation and hook titles
- Imported fonts and per-caption styling
- Find and replace in captions: match count, next and previous, replace one or all in one undo step, match case, whole word, and the second-language line

### AI features (all run on your computer)

- Remove filler words and pauses
- Remove objects from video, and cut out any subject
- Voice isolation, voice clone, voiceover voices and AI dubbing
- Make shorts from a long video, and smart combine: several clips cut into one edit on the beat
- Smooth slow motion, upscaling, relighting, deflicker and sharpen
- 3D zoom: a photo becomes a clip where the camera pushes in, pulls out, slides or orbits and the near things move more than the far ones (depth from the photo, rendered once on your computer; undo gives the photo back)
- Smart media search by what is in the shot
- Auto B-roll: shots from your own library that match what is being said go on the overlay track, in one undo
  step, and each one can be swapped or removed
- Control from Claude Code through the built-in MCP server
- Lip sync, talking photo and AI video need an NVIDIA GPU with 18-24 GB; on a Mac they run only on a GPU PC you opt in to

### Export

- H.264, HEVC, AV1, VP9, GIF and audio-only M4A, up to 8K, with frame rate and bitrate choices
- HDR (HLG and PQ, 10-bit) and transparent video
- Platform presets, and "also export as" 9:16, 16:9, 1:1 and 4:5 in one go, with an export queue
- Captions as SRT, VTT or plain text
- A Light export option for quick plain-cut exports
- Cover image: pick the frame at the playhead or a library picture, add a title in any text style; it is saved as a JPG or PNG next to the video and embedded as the MP4's cover (Finder, Explorer and players show it). Remembered per project

### Templates, brand kit and batch

- Templates you can make and share as `.cutroom-template` files, with a gallery and 4 starters
- A brand kit per library: logo, colours, fonts, caption style, intro, outro and watermark
- Batch edit: one recipe applied to many videos, with a project and exports for each

### Settings and first start

- Three setup questions on first start set the default shape, frame rate, export preset and caption language
- A guided tour over the real editor
- A Settings window with every default in one place, per computer or per library, including switches that turn
  each AI feature off

### Windows and hardware

- Runs on Windows with a PowerShell installer and launcher
- Cutroom checks the computer it runs on and picks the encoder (VideoToolbox, NVENC, Quick Sync, AMF or x264) and
  the AI backend to match
- Heavy footage stays light: GPU-made preview copies for HDR, 10-bit and 4:2:2 clips, and exports sized to the
  computer's memory
- The editor draws only when something changes, and sleeps when idle
