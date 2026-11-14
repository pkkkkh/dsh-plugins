import { defineTool } from '@deepseek-ai/dsh-tools'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

export const name = 'image-toolbox'

/**
 * 服务端生图：没有任何客户端 UI，配置走 profile，Key 也可以放本地文件。
 * 只依赖宿主 tools 服务 + Node 自带的 fetch。
 */
export const inject = ['tools']

const DEFAULTS = {
  baseUrl: 'https://ark.cn-beijing.volces.com/api/v3',
  model: 'doubao-seedream-5-0-flash-260915',
  outputDir: 'D:\\Videos\\img',
  size: '1024x1024',
  keyFile: 'C:\\Users\\kh006\\.dsh\\ark.key',
}

/** Key 的优先级：配置 > 环境变量 > 本地文件。 */
export function resolveKey(config, env = process.env) {
  const fromConfig = String(config?.apiKey ?? '').trim()
  if (fromConfig !== '') return fromConfig
  const fromEnv = String(env.ARK_API_KEY ?? env.ARK_APIKEY ?? '').trim()
  if (fromEnv !== '') return fromEnv
  const file = String(config?.keyFile ?? DEFAULTS.keyFile)
  try {
    if (existsSync(file)) {
      const text = readFileSync(file, 'utf8').trim()
      if (text !== '') return text
    }
  } catch {
    /* ignore */
  }
  return ''
}

function stamp() {
  const d = new Date()
  const p = (n) => String(n).padStart(2, '0')
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`
}

function safeExtFromUrl(url, fallback = 'png') {
  const m = /\.(png|jpe?g|webp)(?:\?|$)/i.exec(String(url))
  if (!m) return fallback
  return m[1].toLowerCase().replace('jpeg', 'jpg')
}

export async function generateViaArk({ apiKey, baseUrl, model, prompt, size, watermark }) {
  const url = `${String(baseUrl).replace(/\/+$/, '')}/images/generations`
  const body = {
    model,
    prompt,
    size,
    response_format: 'url',
    ...(watermark === undefined ? {} : { watermark: Boolean(watermark) }),
  }
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify(body),
  })
  const text = await res.text()
  if (!res.ok) {
    // 不把 key 带进错误信息
    throw new Error(`火山方舟 HTTP ${res.status}: ${text.slice(0, 300)}`)
  }
  let json
  try {
    json = JSON.parse(text)
  } catch {
    throw new Error(`返回不是 JSON：${text.slice(0, 200)}`)
  }
  const items = Array.isArray(json?.data) ? json.data : []
  if (items.length === 0) throw new Error(`没拿到图片数据：${text.slice(0, 300)}`)
  return items
}

export function apply(ctx, config = {}) {
  const baseUrl = String(config?.baseUrl ?? DEFAULTS.baseUrl)
  const model = String(config?.model ?? DEFAULTS.model)
  const outputDir = String(config?.outputDir ?? DEFAULTS.outputDir)
  const defaultSize = String(config?.size ?? DEFAULTS.size)

  ctx.effect(
    () =>
      ctx.tools.register(
        defineTool({
          name: 'image_generate',
          description: [
            '生成图片（服务端直连火山方舟 / 豆包 Seedream），出图后落盘并返回本地路径。',
            '参数：prompt（必填）、size（如 1024x1024 / 2048x2048）、count（1-4，逐张生成）、',
            'model（可选，默认配置值）、saveDir（可选，默认 D:\\Videos\\img）。',
            '没有配置 Key 时会返回明确错误；不出图时不会扣费。',
          ].join(''),
          parameters: {
            prompt: { type: 'string', description: '画面描述（中文或英文都行）', required: true },
            size: { type: 'string', description: '分辨率，如 1024x1024、1440x1920、2048x2048' },
            count: { type: 'number', description: '生成几张（1-4，默认 1；每张单独计费）' },
            model: { type: 'string', description: '模型 ID，默认用配置里的（doubao-seedream-*）' },
            saveDir: { type: 'string', description: '保存目录，默认 D:\\Videos\\img' },
          },
          output: {
            schema: {
              type: 'object',
              additionalProperties: false,
              properties: {
                model: { type: 'string', required: true },
                count: { type: 'integer', required: true },
                dir: { type: 'string', required: true },
                files: { type: 'array', items: { type: 'string' }, required: true },
                text: { type: 'string', required: true },
              },
            },
            render(_args, value) {
              return [{ type: 'text', text: value.text }]
            },
          },
          async execute(args) {
            const apiKey = resolveKey(config)
            if (apiKey === '') {
              throw new Error(
                '没有 API Key：把火山方舟的 Key 写进 C:\\Users\\kh006\\.dsh\\ark.key（一行），' +
                  '或在 profile 的 image-toolbox 配置里填 apiKey。',
              )
            }
            const prompt = String(args?.prompt ?? '').trim()
            if (prompt === '') throw new Error('prompt 不能为空。')
            const dir = String(args?.saveDir ?? outputDir)
            mkdirSync(dir, { recursive: true })
            const usedModel = String(args?.model ?? model)
            const size = String(args?.size ?? defaultSize)
            const count = Math.max(1, Math.min(4, Math.floor(Number(args?.count ?? 1) || 1)))

            const files = []
            for (let i = 0; i < count; i += 1) {
              const items = await generateViaArk({ apiKey, baseUrl, model: usedModel, prompt, size })
              for (const item of items) {
                let buf
                if (typeof item?.b64_json === 'string' && item.b64_json !== '') {
                  buf = Buffer.from(item.b64_json, 'base64')
                } else if (typeof item?.url === 'string' && item.url !== '') {
                  const img = await fetch(item.url)
                  if (!img.ok) throw new Error(`下载图片失败 HTTP ${img.status}`)
                  buf = Buffer.from(await img.arrayBuffer())
                } else {
                  throw new Error('返回里没有 url / b64_json')
                }
                const ext = safeExtFromUrl(item?.url, 'png')
                const file = join(dir, `img-${stamp()}-${files.length + 1}.${ext}`)
                writeFileSync(file, buf)
                files.push(file)
              }
            }
            return {
              model: usedModel,
              count: files.length,
              dir,
              files,
              text: `已生成 ${files.length} 张（模型 ${usedModel}，${size}）：\n` + files.map((f) => `- ${f}`).join('\n'),
            }
          },
        }),
      ),
    'image-toolbox: image_generate tool',
  )
}
