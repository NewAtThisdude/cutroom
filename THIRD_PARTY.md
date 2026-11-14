# Third-party software, models and assets

Cutroom's own code is licensed under the GNU General Public License v3.0 or later (see LICENSE). It ships very little that isn't its own; most of what is listed here is
downloaded by `install.sh`, `ai/setup.sh` or the app on first use, each at a pinned version with a SHA-256 check.
Nothing here is needed to cut, grade, caption-edit or export; the optional AI tools are what pull the models.

## In this repository

| What | Licence |
|---|---|
| Fonts in `web/fonts` (Montserrat, Poppins, Anton, Bebas Neue) | SIL Open Font License 1.1, texts in `web/fonts/OFL-*.txt` |
| `ai/rnnoise-cb.rnnn` (RNNoise model, GregorR/rnnoise-models) | released by its author as not subject to copyright |
| `packs.json` | a list of URLs and checksums only; the sounds it points to are CC0 1.0 (Kenney, Komiku, Loyalty Freak Music) |

## Installed on your Mac by Homebrew (you install these)

ffmpeg (LGPL/GPL depending on the build), whisper.cpp (MIT), Ollama (MIT), Python.

## Downloaded by `install.sh` / `install.ps1`

| Model or tool | Licence |
|---|---|
| Whisper large-v3-turbo, ggml q5 (OpenAI, via ggerganov/whisper.cpp) | MIT |
| Silero VAD v5.1.2 (ggml-org/whisper-vad) | MIT |
| uv 0.13.6 (Astral): builds the AI pack's Python environment | MIT or Apache-2.0 |
| Windows only: ffmpeg 9.0.2 "full" build (gyan.dev) | GPL-3.0 |
| Windows only: whisper.cpp 1.9.5 (CUDA or OpenBLAS build) | MIT |

## Downloaded by `ai/setup.ps1` (the Windows AI pack)

The same models as below, as PyTorch builds where the Mac uses MLX: Kokoro-82M (hexgrad/Kokoro-82M with the `kokoro` and
`misaki` packages and spaCy's `en_core_web_sm`; Apache-2.0, MIT), Demucs htdemucs (adefossez/HTDemucs, MIT), WavLM Base Plus
SV, and on the CUDA pack SAM 2.1, ProPainter (**non-commercial**), MusicGen small (**weights non-commercial**), RIFE 4.25,
Real-ESRGAN and Depth Anything V2 Small, with PyTorch (BSD-3-Clause) and the packages pinned in `ai/win-cuda.lock` /
`ai/win-cpu.lock`. Not on Windows: Chatterbox, S3TokenizerV2 and Z-Image.

## Downloaded by `ai/setup.sh` (optional on-device AI)

| Used for | Model or library | Licence |
|---|---|---|
| Voiceover | Kokoro-82M (mlx-audio) | Apache-2.0 |
| Voice clone, dubbing | Chatterbox multilingual v3; S3TokenizerV2 (from CosyVoice2) | MIT; Apache-2.0 |
| Speaker labels, clone similarity | WavLM Base Plus SV (Microsoft) | CC BY-SA 3.0 (attribution, share-alike) |
| Image generation | Z-Image-Turbo (4-bit, mflux) | Apache-2.0 |
| Object outline, cut-out | SAM 2.1 (Meta) | Apache-2.0 |
| Object removal, "Best" | ProPainter (S-Lab, NTU) | **S-Lab licence: non-commercial use only** |
| Voice / music separation | Demucs (htdemucs) | MIT |
| AI music | MusicGen small (Meta) | code MIT, **weights CC-BY-NC 4.0: non-commercial** |
| Smooth slow-mo | RIFE 4.25 (Practical-RIFE, vs-rife) | MIT |
| Upscale | Real-ESRGAN general x4v3 | BSD-3-Clause |
| Relight | Depth Anything V2 Small | Apache-2.0 |
| Voice characters | pyworld / WORLD | MIT / modified BSD |
| Search | nomic-embed-text v1.5 (Ollama) | Apache-2.0 |
| Translate, hooks, command bar | qwen3.5 (Ollama) | see the model's card |

The two **non-commercial** entries are optional and can be left out: object removal falls back to its built-in fill,
and music can come from the CC0 library or your own files.

## Optional, on a separate NVIDIA PC (`ai/gpu_setup.sh`)

LatentSync 1.6 (code Apache-2.0, weights CreativeML OpenRAIL++-M), InsightFace buffalo_l (**non-commercial research
only**), Wan 2.2 S2V and its LoRA (Apache-2.0), wav2vec2-large-xlsr-53-english (Apache-2.0), sd-vae-ft-mse (MIT),
Whisper tiny (MIT). Off unless you set that PC up; experimental.

## Apple frameworks

Vision, VideoToolbox, AVFoundation, PhotosUI and `say` are part of macOS.
