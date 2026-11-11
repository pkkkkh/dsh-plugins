import { defineTool } from '@deepseek-ai/dsh-tools'

export const name = 'video-toolbox'

/**
 * 只要 tools 服务：本插件不干实事，只把一次调用转给下面三家之一。
 * 缺任何一家都不会让本插件挂掉——转调时那一家报 UNKNOWN_TOOL 会变成可读错误。
 */
export const inject = ['tools']

const TOOL_DESCRIPTION = [
  '视频工具箱（聚合入口）：用 action 选一件事做，内部转调 dsh-ffmpeg / dsh-media-converter / dsh-audio-tools。',
  '动作：health(环境体检) / probe(探测) / cut(裁切) / concat(拼接) / encode(转码压制) / subtitle(字幕烧录或封装)',
  ' / audio-extract(抽音轨) / frames(抽帧) / gif / adjust(缩放旋转变速) / storyboard(宫格总览)',
  ' / convert(万能转格式，走 media-converter) / audio-convert(音频转码) / transcribe(语音转写，本地 whisper)。',
  '参数按动作传：cut 用 start/end 或 duration；concat 用 inputs 数组；encode 用 vcodec/crf/preset；',
  'transcribe 用 language/model/backend/srt。只传该动作需要的字段，没用到的留空即可。',
].join('')

/** action → 目标工具 + 该动作允许透传的参数名。 */
const ROUTES = {
  'health': { tool: 'ffmpeg_health', keys: [] },
  'probe': { tool: 'ffmpeg_probe', keys: ['input'] },
  'cut': { tool: 'ffmpeg_cut', keys: ['input', 'output', 'start', 'end', 'duration', 'reencode'] },
  'concat': { tool: 'ffmpeg_concat', keys: ['inputs', 'output', 'reencode', 'width', 'height', 'fps'] },
  'encode': { tool: 'ffmpeg_encode', keys: ['input', 'output', 'vcodec', 'crf', 'preset'] },
  'subtitle': { tool: 'ffmpeg_subtitle', keys: ['input', 'output', 'subtitle', 'mode'] },
  'audio-extract': { tool: 'ffmpeg_extract', keys: ['input', 'output', 'format'], fixed: { stream: 'a' } },
  'frames': { tool: 'ffmpeg_frames', keys: ['input', 'output', 'every', 'times'] },
  'gif': { tool: 'ffmpeg_gif', keys: ['input', 'output', 'start', 'end', 'duration', 'fps', 'width'] },
  'adjust': { tool: 'ffmpeg_adjust', keys: ['input', 'output', 'scale', 'rotate', 'speed'] },
  'storyboard': { tool: 'ffmpeg_storyboard', keys: ['input', 'grid'] },
  'convert': { tool: 'media_toolbox', keys: ['format', 'codec', 'quality', 'bitrate', 'fps', 'width'], fixed: { action: 'convert' }, pathKey: 'path' },
  'audio-convert': { tool: 'audio_convert', keys: ['input', 'output', 'format', 'bitrate', 'channels', 'sampleRate'] },
  'transcribe': { tool: 'audio_transcribe', keys: ['input', 'output', 'language', 'model', 'backend', 'srt'] },
}

/** 表里没有的字段不转，空值不转。 */
function buildArgs(action, args) {
  const route = ROUTES[action]
  const out = { ...(route.fixed ?? {}) }
  for (const key of route.keys) {
    const value = args?.[key]
    if (value === undefined || value === null || value === '') continue
    if (Array.isArray(value) && value.length === 0) continue
    out[key] = value
  }
  if (route.pathKey !== undefined) {
    const input = args?.input
    if (input === undefined || input === '') throw new Error(`${action} 需要 input（源文件路径）。`)
    out[route.pathKey] = input
    delete out.input
  }
  return out
}

export function apply(ctx) {
  ctx.effect(
    () =>
      ctx.tools.register(
        defineTool({
          name: 'video_toolbox',
          description: TOOL_DESCRIPTION,
          parameters: {
            action: {
              type: 'string',
              description: '要做什么：' + Object.keys(ROUTES).join(' / '),
              required: true,
            },
            input: { type: 'string', description: '源文件路径（convert 动作里叫 path，这里统一填 input）' },
            output: { type: 'string', description: '输出路径（部分动作可省）' },
            inputs: { type: 'array', items: { type: 'string' }, description: 'concat 用：按顺序的片段路径数组' },
            start: { type: 'number', description: '起点（秒）' },
            end: { type: 'number', description: '终点（秒）' },
            duration: { type: 'number', description: '时长（秒）' },
            format: { type: 'string', description: '目标格式：mp4 / mkv / mp3 / wav / srt …' },
            vcodec: { type: 'string', description: '视频编码器：libx264 / hevc / h264_nvenc / hevc_nvenc' },
            crf: { type: 'number', description: '画质（越小越好，x264 常用 18–23）' },
            preset: { type: 'string', description: '编码预设：fast / slow / p5（NVENC）' },
            subtitle: { type: 'string', description: '字幕文件路径（srt/ass）' },
            mode: { type: 'string', description: '字幕模式：burn(烧进画面) / embed(软字幕封装)' },
            every: { type: 'number', description: '抽帧间隔（秒）' },
            times: { type: 'array', items: { type: 'number' }, description: '抽帧时刻列表（秒）' },
            fps: { type: 'number', description: '帧率' },
            width: { type: 'number', description: '宽度（像素）' },
            height: { type: 'number', description: '高度（像素）' },
            scale: { type: 'string', description: '缩放表达式，例如 1280:-2' },
            rotate: { type: 'number', description: '旋转角度' },
            speed: { type: 'number', description: '倍速，例如 1.5 / 0.5' },
            grid: { type: 'string', description: '宫格规格，例如 3x3' },
            reencode: { type: 'boolean', description: 'cut/concat 时是否重编码（false 走流拷贝，快但需同参数）' },
            codec: { type: 'string', description: 'media-converter 的编码器参数' },
            quality: { type: 'string', description: 'media-converter 的质量档位' },
            bitrate: { type: 'string', description: '音频/视频码率，例如 128k / 4M' },
            channels: { type: 'number', description: '声道数：1 / 2' },
            sampleRate: { type: 'number', description: '采样率，例如 44100 / 48000' },
            language: { type: 'string', description: '转写语言：auto / zh / en' },
            model: { type: 'string', description: 'whisper 模型：tiny / base / small / medium / large-v3' },
            backend: { type: 'string', description: '转写后端：cli（本地） / api' },
            srt: { type: 'boolean', description: '转写时是否顺带导出 srt' },
          },
          output: {
            schema: {
              type: 'object',
              additionalProperties: false,
              properties: {
                action: { type: 'string', required: true },
                tool: { type: 'string', required: true },
                text: { type: 'string', required: true },
              },
            },
            render(_args, value) {
              return [{ type: 'text', text: value.text }]
            },
          },
          async execute(args, exec) {
            const action = String(args?.action ?? '').trim()
            const route = ROUTES[action]
            if (route === undefined) {
              throw new Error(`不认识的 action：${action || '(空)'}；可用：${Object.keys(ROUTES).join(' / ')}`)
            }
            const callArgs = buildArgs(action, args)
            const callId = `video-toolbox-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`
            const result = await ctx.tools.execute({
              callId,
              name: route.tool,
              arguments: callArgs,
              agent: exec?.agent,
              signal: exec?.signal,
            })
            if (result.isError === true) {
              const reason = result.error?.message ?? '未知错误'
              throw new Error(`${route.tool} 执行失败：${reason}`)
            }
            const text = (result.content ?? [])
              .filter((block) => block?.type === 'text')
              .map((block) => block.text)
              .join('\n')
              .trim()
            return {
              action,
              tool: route.tool,
              text: text.length > 0 ? text : JSON.stringify(result.value ?? {}),
            }
          },
        }),
      ),
    'video-toolbox: video_toolbox tool',
  )
}
