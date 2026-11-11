# video-toolbox

一个**聚合入口**：只注册一个工具 `video_toolbox`，按 `action` 把调用转给已装的三个视频插件，不重写它们的功能。

## 为什么要它

`dsh-ffmpeg`（11 个工具）+ `dsh-media-converter`（`media_toolbox`）+ `dsh-audio-tools`（3 个工具）各自独立，入口散。这个插件给模型**一个统一的门**，参数仍按原工具的语义传。

## 路由表

| action | 转给 | 常用参数 |
| --- | --- | --- |
| `health` | `ffmpeg_health` | — |
| `probe` | `ffmpeg_probe` | input |
| `cut` | `ffmpeg_cut` | input, output, start/end/duration, reencode |
| `concat` | `ffmpeg_concat` | inputs[], output, reencode, width/height/fps |
| `encode` | `ffmpeg_encode` | input, output, vcodec, crf, preset |
| `subtitle` | `ffmpeg_subtitle` | input, output, subtitle, mode(burn/embed) |
| `audio-extract` | `ffmpeg_extract` | input, output, format（stream 固定 a） |
| `frames` | `ffmpeg_frames` | input, output, every / times[] |
| `gif` | `ffmpeg_gif` | input, output, start/end/duration, fps, width |
| `adjust` | `ffmpeg_adjust` | input, output, scale, rotate, speed |
| `storyboard` | `ffmpeg_storyboard` | input, grid |
| `convert` | `media_toolbox` | input（转成 path）, format, codec, quality, bitrate, fps, width |
| `audio-convert` | `audio_convert` | input, output, format, bitrate, channels, sampleRate |
| `transcribe` | `audio_transcribe` | input, output, language, model, backend, srt |

## 注意

- **不装三个底层插件时**，调用会返回「未知工具」类错误——本插件不替它们做事。
- 目标工具的参数名按各家公开语义写死；上游改参数名要同步更新本表。
- 默认 CPU 编码；要 GPU 就 `encode` 传 `vcodec: h264_nvenc`（本机 4070 支持，见 README 里 ffmpeg 的说明）。
