import { mkdir, readFile, readdir, rename, stat, writeFile } from 'node:fs/promises'
import { isAbsolute, join, normalize, resolve } from 'node:path'
import { HandoffError } from './errors.ts'
import { parseDocumentSummary, type DocumentSummary } from './markdown.ts'

const DEFAULT_DIR = '.dsh/handoff'

/** Resolve the configured output directory against the session working directory. */
export function resolveOutputDir(cwd: string, configured: string): string {
  const value = configured.trim() === '' ? DEFAULT_DIR : configured.trim()
  return isAbsolute(value) ? normalize(value) : resolve(cwd, value)
}

/** One generated document, as listed for the UI. */
export interface DocumentEntry {
  readonly name: string
  readonly path: string
  readonly size: number
  readonly modifiedAt: number
}

/**
 * Accept one bare file name, on any platform.
 *
 * Both separators are rejected explicitly: on POSIX a name like
 * `..\escape.md` contains no `/` and would otherwise pass a `basename` check
 * while still being a Windows path traversal on the other side.
 */
function assertBareName(name: string): void {
  if (
    name === '' ||
    name === '.' ||
    name === '..' ||
    name.includes('/') ||
    name.includes('\\') ||
    name.includes('\0')
  ) {
    throw new HandoffError('BAD_NAME', `非法的文件名：${name}`)
  }
}

/** Write one document, creating the directory when needed.
 *  Write to a temporary file first and rename it into place: a crash or a
 *  failed write must never leave a half-written handoff document behind. */
export async function writeDocument(dir: string, name: string, content: string): Promise<string> {
  assertBareName(name)
  await mkdir(dir, { recursive: true })
  const target = join(dir, name)
  const temp = target + '.tmp'
  await writeFile(temp, content, 'utf8')
  await rename(temp, target)
  return target
}

/** Newest documents first, without the `latest.md` convenience copy. */
export async function listDocuments(dir: string, limit = 50): Promise<DocumentEntry[]> {
  let names: string[]
  try {
    names = await readdir(dir)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []
    throw error
  }
  const entries: DocumentEntry[] = []
  for (const name of names) {
    if (!name.endsWith('.md') || name === 'latest.md' || name.endsWith('.tmp')) continue
    const path = join(dir, name)
    try {
      const info = await stat(path)
      if (!info.isFile()) continue
      entries.push({ name, path, size: info.size, modifiedAt: info.mtimeMs })
    } catch {
      // The file disappeared between readdir and stat: skip it, do not fail the list.
    }
  }
  entries.sort((a, b) => b.modifiedAt - a.modifiedAt)
  return entries.slice(0, limit)
}

/** One listed document plus the facts its front matter carries. */
export type DocumentListing = DocumentEntry & DocumentSummary

/**
 * List documents with the summary the sidebar renders.
 *
 * The list is the panel's first paint, so a document whose front matter cannot
 * be read must not remove the row: the failure is swallowed and the row keeps
 * its name, size, and time.
 */
export async function listDocumentSummaries(dir: string, limit = 50): Promise<DocumentListing[]> {
  const entries = await listDocuments(dir, limit)
  return Promise.all(
    entries.map(async (entry): Promise<DocumentListing> => {
      try {
        return { ...entry, ...parseDocumentSummary(await readFile(entry.path, 'utf8')) }
      } catch {
        return { ...entry }
      }
    }),
  )
}

/** Read one document by bare file name. */
export async function readDocument(dir: string, name: string): Promise<string> {
  assertBareName(name)
  return readFile(join(dir, name), 'utf8')
}
