import { defineTool } from '@deepseek-ai/dsh-tools'

export const name = 'video-toolbox'

/**
 * 只要 tools 服务：本插件不干事，只把一次调用转给三家里对应那个工具。
 */
export const inject = ['tools']

const TOOL_DESCRIPTION = [
  '视频工具箱（聚合入口）：用 action 选一件事，内部转调 dsh-ffmpeg / dsh-media-converter / dsh-audio-tools。',
  '动作：health / probe / audio-probe / cut / concat / encode / gpu-encode / subtitle / audio-extract',
  ' / frames / gif / adjust / storyboard / convert / tags / audio-convert / transcribe。',
  '参数按动作传（没用到的留空）：cut 用 start/end 或 duration；concat 用 inputs 数组；encode 用 preset/crf/scale；',
  'gpu-encode 用 codec(h264|hevc)+quality；frames 用 every 或 times[]；adjust 用 speed/volume/rotate；',
  'transcribe 用 language/model/backend/srt。时间参数写 "90" 或 "00:01:30"。',
].join('')

/** action → 目标工具、允许透传的参数名、固定参数、input 映射到的键名。 */
const ROUTES = {
  'health': { tool: 'ffmpeg_health', keys: [] },
  'probe': { tool: 'ffmpeg_probe', keys: ['input'] },
  'audio-probe': { tool: 'audio_probe', keys: [], pathKey: 'path' },
  'cut': { tool: 'ffmpeg_cut', keys: ['input', 'output', 'start', 'end', 'duration', 'reencode'] },
  'concat': { tool: 'ffmpeg_concat', keys: ['inputs', 'output', 'reencode', 'width', 'height', 'fps'] },
  'encode': { tool: 'ffmpeg_encode', keys: ['input', 'output', 'preset', 'crf', 'fps', 'scale'] },
  'gpu-encode': { tool: 'media_toolbox', keys: ['format', 'codec', 'quality', 'bitrate', 'fps', 'width'], fixed: { action: 'convert' }, pathKey: 'path' },
  'subtitle': { tool: 'ffmpeg_subtitle', keys: ['input', 'subtitle', 'output'] },
  'audio-extract': { tool: 'ffmpeg_extract', keys: ['input', 'output'], fixed: { what: 'audio' } },
  'frames': { tool: 'ffmpeg_frames', keys: ['input', 'every', 'times', 'maxFrames', 'outputDir', 'format'] },
  'gif': { tool: 'ffmpeg_gif', keys: ['input', 'start', 'duration', 'fps', 'width', 'output'] },
  'adjust': { tool: 'ffmpeg_adjust', keys: ['input', 'speed', 'volume', 'mute', 'rotate', 'output'] },
  'storyboard': { tool: 'ffmpeg_storyboard', keys: ['input', 'output', 'count', 'columns', 'width', 'start', 'end'] },
  'convert': { tool: 'media_toolbox', keys: ['format', 'codec', 'quality', 'bitrate', 'fps', 'width', 'channels', 'sampleRate'], fixed: { action: 'convert' }, pathKey: 'path' },
  'tags': { tool: 'media_toolbox', keys: ['tags'], fixed: { action: 'rewrite-tags' }, pathKey: 'path' },
  'audio-convert': { tool: 'audio_convert', keys: ['input', 'output', 'format', 'bitrate', 'sampleRate', 'channels', 'start', 'duration', 'normalize', 'overwrite'] },
  'transcribe': { tool: 'audio_transcribe', keys: ['input', 'output', 'language', 'model', 'backend', 'prompt', 'srt'] },
}

const TIME_KEYS = new Set(['start', 'end', 'duration'])

/** 时间参数统一转成字符串（ffmpeg_cut 那类要字符串，storyboard 两者都吃）。 */
function normalizeValue(key, value) {
  if (value === undefined || value === null || value === '') return undefined
  if (TIME_KEYS.has(key)) return String(value)
  if (Array.isArray(value) && value.length === 0) return undefined
  return value
}

function buildArgs(action, args) {
  const route = ROUTES[action]
  const out = { ...(route.fixed ?? {}) }
  for (const key of route.keys) {
    const value = normalizeValue(key, args?.[key])
    if (value === undefined) continue
    out[key] = value
  }
  if (route.pathKey !== undefined) {
    const input = args?.input
    if (typeof input !== 'string' || input.trim() === '') throw new Error(`${action} 需要 input（源文件路径）。`)
    out[route.pathKey] = input
  }
  // media_toolbox 的 trim 是 {start,end} 对象；外面用 trimStart/trimEnd 两个数字。
  if (action === 'convert' || action === 'gpu-encode') {
    const trimStart = args?.trimStart
    const trimEnd = args?.trimEnd
    if (trimStart !== undefined || trimEnd !== undefined) {
      const trim = {}
      if (trimStart !== undefined) trim.start = Number(trimStart)
      if (trimEnd !== undefined) trim.end = Number(trimEnd)
      out.trim = trim
    }
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
            action: { type: 'string', description: '要做什么：' + Object.keys(ROUTES).join(' / '), required: true },
            input: { type: 'string', description: '源文件路径（audio-probe/convert/tags 内部会映射成 path）' },
            output: { type: 'string', description: '输出路径（部分动作可省）' },
            inputs: { type: 'array', items: { type: 'string' }, description: 'concat 用：按顺序的片段数组' },
            start: { type: 'string', description: '起点："90" 或 "00:01:30"' },
            end: { type: 'string', description: '终点：秒数或 HH:MM:SS' },
            duration: { type: 'string', description: '时长：秒数或 HH:MM:SS' },
            trimStart: { type: 'number', description: 'convert/gpu-encode 的裁剪起点（秒）' },
            trimEnd: { type: 'number', description: 'convert/gpu-encode 的裁剪终点（秒）' },
            format: { type: 'string', description: '目标格式：mp4 / mkv / mp3 / wav / png …' },
            preset: { type: 'string', description: 'encode 预设：bilibili-1080p / bilibili-4k / vertical-1080p / web-720p' },
            crf: { type: 'number', description: 'encode 画质 0-51（越小越清晰）' },
            scale: { type: 'string', description: 'encode 分辨率，如 1920:1080 或 -2:720' },
            codec: { type: 'string', description: 'gpu-encode 编码器：h264 / hevc（GPU 硬编，无显卡自动回退）' },
            quality: { type: 'number', description: 'convert/gpu-encode 质量 1-100（90=默认）' },
            bitrate: { type: 'number', description: '音频码率 kbps（32-320），仅音频编码目标有效' },
            fps: { type: 'number', description: '帧率' },
            width: { type: 'number', description: '宽度（像素）' },
            height: { type: 'number', description: '高度（像素）' },
            channels: { type: 'number', description: '声道数 1/2' },
            sampleRate: { type: 'number', description: '采样率 Hz' },
            subtitle: { type: 'string', description: '字幕文件路径（srt/ass）' },
            every: { type: 'number', description: 'frames 抽帧间隔（秒）' },
            times: { type: 'array', items: { type: 'string' }, description: 'frames 抽帧时刻，如 ["00:00:05"]' },
            maxFrames: { type: 'number', description: 'frames 帧数上限 1-500' },
            outputDir: { type: 'string', description: 'frames 输出目录（每次运行新建 run-*）' },
            speed: { type: 'number', description: 'adjust 倍速，1.5 / 0.5' },
            volume: { type: 'string', description: 'adjust 音量：倍数 1.5 或 -3dB' },
            mute: { type: 'boolean', description: 'adjust 静音' },
            rotate: { type: 'number', description: 'adjust 顺时针旋转 90/180/270' },
            count: { type: 'number', description: 'storyboard 采样格数 2-36' },
            columns: { type: 'number', description: 'storyboard 列数 1-6' },
            reencode: { type: 'boolean', description: 'cut/concat 是否重编码（默认流拷贝）' },
            normalize: { type: 'boolean', description: 'audio-convert 响度归一化' },
            overwrite: { type: 'boolean', description: 'audio-convert 覆盖已存在输出' },
            tags: {
              type: 'object',
              additionalProperties: false,
              description: 'tags 要写的标签：{title,artist,album,comment,date,genre}',
              properties: {
                title: { type: 'string' },
                artist: { type: 'string' },
                album: { type: 'string' },
                comment: { type: 'string' },
                date: { type: 'string' },
                genre: { type: 'string' },
              },
            },
            language: { type: 'string', description: 'transcribe 语言：auto / zh / en' },
            model: { type: 'string', description: 'transcribe whisper 模型：tiny/base/small/medium/large-v3' },
            backend: { type: 'string', description: 'transcribe 后端：cli（本地）/ api' },
            prompt: { type: 'string', description: 'transcribe 初始提示（人名/术语）' },
            srt: { type: 'boolean', description: 'transcribe 顺带导出 srt' },
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
            const signal = exec?.signal ?? new AbortController().signal
            // DSH 0.2.2：tools.execute 收「批量调用」，结果是批量的 ToolCallResult[]
            const batch = await ctx.tools.execute({
              calls: [{ type: 'tool-call', id: callId, name: route.tool, arguments: JSON.stringify(callArgs) }],
              signal,
              ...(exec?.agent === undefined ? {} : { agent: exec.agent }),
            })
            const first = Array.isArray(batch?.results) ? batch.results[0] : undefined
            if (first === undefined) {
              throw new Error(`${route.tool} 没有返回结果`)
            }
            const failed = first.isError === true || first.result?.isError === true
            if (failed) {
              const reason = first.error?.message ?? first.result?.error?.message ?? '未知错误'
              throw new Error(`${route.tool} 执行失败：${reason}`)
            }
            const blocks = Array.isArray(first.content)
              ? first.content
              : Array.isArray(first.result?.content)
                ? first.result.content
                : []
            const text = blocks
              .filter((block) => block?.type === 'text')
              .map((block) => block.text)
              .join('\n')
              .trim()
            const fallback = JSON.stringify(first.value ?? first.result?.value ?? first).slice(0, 2000)
            return { action, tool: route.tool, text: text.length > 0 ? text : fallback }
          },
        }),
      ),
    'video-toolbox: video_toolbox tool',
  )
}
