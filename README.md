<p align="center"><img src="docs/banner.svg" alt="Cutroom: a timeline of coloured clips under the title" width="100%"></p>

<p align="center">
  <a href="#install-in-one-line"><img alt="macOS" src="https://img.shields.io/badge/macOS-Apple%20Silicon-8b5cf6?logo=apple&logoColor=white"></a>
  <a href="#install-in-one-line"><img alt="Windows" src="https://img.shields.io/badge/Windows-10%20%7C%2011-22d3ee?logo=data:image/svg%2bxml;base64,PHN2ZyB2aWV3Qm94PSIwIDAgMjQgMjQiIHhtbG5zPSJodHRwOi8vd3d3LnczLm9yZy8yMDAwL3N2ZyIgZmlsbD0iI2ZmZmZmZiI+PHRpdGxlPldpbmRvd3M8L3RpdGxlPjxyZWN0IHg9IjIiIHk9IjIiIHdpZHRoPSI5LjUiIGhlaWdodD0iOS41Ii8+PHJlY3QgeD0iMTIuNSIgeT0iMiIgd2lkdGg9IjkuNSIgaGVpZ2h0PSI5LjUiLz48cmVjdCB4PSIyIiB5PSIxMi41IiB3aWR0aD0iOS41IiBoZWlnaHQ9IjkuNSIvPjxyZWN0IHg9IjEyLjUiIHk9IjEyLjUiIHdpZHRoPSI5LjUiIGhlaWdodD0iOS41Ii8+PC9zdmc+Cg==&logoColor=white"></a>
  <a href="LICENSE"><img alt="License: GPL v3" src="https://img.shields.io/badge/license-GPL%20v3-f472b6"></a>
  <a href="docs/GUIDE.md#how-its-tested"><img alt="Tested on Mac and Windows" src="https://img.shields.io/badge/checks-1%2C717%20Mac%20%C2%B7%201%2C849%20Windows-22c55e"></a>
  <a href="#let-your-ai-assistant-edit-mcp"><img alt="MCP server" src="https://img.shields.io/badge/MCP-any%20AI%20assistant-f59e0b"></a>
  <img alt="No account, no upload" src="https://img.shields.io/badge/cloud-none-64748b">
</p>

<p align="center"><b>A free video editor for Mac and Windows that runs entirely on your computer.</b><br>
CapCut-style editing with AI built in. No account, no uploads, no watermark, no subscription.</p>

## Install in one line

**<img src="docs/icons/apple.svg" width="18" height="18" align="absmiddle" alt=""> Mac** · paste into Terminal:

```sh
curl -fsSL https://raw.githubusercontent.com/NewAtThisdude/cutroom/main/install.sh | sh
```

**<img src="docs/icons/windows.svg" width="18" height="18" align="absmiddle" alt=""> Windows 10 / 11** · paste into PowerShell:

```powershell
irm https://raw.githubusercontent.com/NewAtThisdude/cutroom/main/install.ps1 | iex
```

It checks your computer first, asks before installing anything and needs no admin rights. Run it again to update.
[Other ways to install](docs/GUIDE.md#install-in-detail) · [Uninstall](docs/GUIDE.md#uninstall)

![The Cutroom editor: library, preview, inspector and timeline](docs/screenshot.png)

## See what it makes

Every image below came out of Cutroom's own exports ([footage credits](docs/samples/CREDITS.md)).

**Auto captions** over an on-device voiceover, in three of the 22 caption styles

![The same night-street frame captioned in three styles: gold karaoke, green neon, yellow word box](docs/samples/captions.jpg)

**Colour looks** in one click: the original, Golden, Cyber and Noir

![A mountain sunset in four colour looks](docs/samples/looks.jpg)

**Cut out a subject** and put it on any background, no green screen

![A dancer in front of a studio curtain, then the same dancer over a mountain sunset](docs/samples/cut-out.jpg)

**Every shape from one edit**: 16:9, 9:16, 1:1 and 4:5, with captions that reflow to fit

![One edit exported in four shapes side by side](docs/samples/shapes.jpg)

**57 transitions**, here caught halfway: ink, cube, page curl and wave

![A cut from Tokyo to London halfway through four different transitions](docs/samples/transitions.jpg)

## Why Cutroom

- <img src="docs/icons/lock-keyhole.svg" width="16" height="16" align="absmiddle" alt=""> **Private.** Your footage never leaves your computer. No account, no cloud, nothing to pay.
- <img src="docs/icons/sparkles.svg" width="16" height="16" align="absmiddle" alt=""> **AI on your own machine.** Auto captions in 18 languages, voiceover, voice cloning, object removal,
  background cut-outs and music. The installer sets up what your hardware can run.
- <img src="docs/icons/scan-eye.svg" width="16" height="16" align="absmiddle" alt=""> **What you see is what you export.** The preview and the export share one engine, and every release
  compares them frame by frame.
- <img src="docs/icons/clapperboard.svg" width="16" height="16" align="absmiddle" alt=""> **A real editor.** Multi-track timeline, keyframes, colour wheels and LUTs, 57 transitions, and
  exports up to 8K with HDR and ProRes.
- <img src="docs/icons/bot.svg" width="16" height="16" align="absmiddle" alt=""> **Your AI assistant can edit.** Claude, Codex, Cursor or Copilot can cut, caption and export the open
  project while you watch.
- <img src="docs/icons/flask-conical.svg" width="16" height="16" align="absmiddle" alt=""> **Tested on both systems.** 1,717 automated checks on a Mac and 1,849 on Windows before a release.

## Let your AI assistant edit

```sh
# Claude Code
claude mcp add -s user cutroom -- python3 -I ~/.local/share/cutroom/src/mcp/cutroom_mcp.py
# Codex CLI
codex mcp add cutroom -- python3 -I ~/.local/share/cutroom/src/mcp/cutroom_mcp.py
```

Then ask in plain words: "remove the pauses, add bold captions and export 1080p".
[Cursor, Copilot, Claude Desktop and Windows setup](docs/GUIDE.md#let-your-ai-assistant-edit-mcp)

## On-device AI

The installer picks the AI pack your computer can run: MLX on Apple Silicon, CUDA on an NVIDIA PC, CPU elsewhere.
The models, their sizes and measured speeds are in the [guide](docs/GUIDE.md#on-device-ai).

## More

[Full guide](docs/GUIDE.md) (every feature, how it is tested, known limits) · [Changelog](CHANGELOG.md) ·
[Contributing](CONTRIBUTING.md) · [Third-party licences](THIRD_PARTY.md) · Licensed under [GPL v3](LICENSE)
