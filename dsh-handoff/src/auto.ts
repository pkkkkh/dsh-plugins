import { appendFileSync } from 'node:fs'
import { join } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import type { Session } from '@deepseek-ai/dsh-session'
import type { HandoffConfig } from './config.ts'
import { describeError } from './errors.ts'
import { generateHandoff } from './generate.ts'
import { resolveOutputDir } from './store.ts'

/**
 * Automatic handoff generation.
 *
 * Why it exists: the tool and the command only run when a human or the model
 * asks for them. Long sessions therefore drift past their last document and the
 * next conversation reads a stale brief. Two natural boundaries are good enough
 * to keep the file fresh without touching the session:
 *
 * - `compaction/start` — the context is about to be summarised, i.e. it is full.
 * - `turn/end` every N completed turns — a cheap heartbeat for sessions that
 *   never reach compaction.
 *
 * Generation is fire-and-forget: a failure is logged and never blocks the log
 * append it reacted to.
 */

/** Per-session bookkeeping for the automatic hook. */
export interface AutoHandoffState {
  /** Turn number of the latest completed turn. */
  turns: number
  /** Turn number at the last successful document. */
  lastTurnAt: number
  /** Epoch ms of the last successful document. */
  lastWriteAt: number
  /** A generation is running; further boundaries are ignored until it settles. */
  inflight: boolean
  /** Number of failed attempts so far (diagnostics only). */
  failures: number
}

/** Inputs of the pure decision helper. Kept plain so tests stay trivial. */
export interface AutoDecisionInput {
  enabled: boolean
  inflight: boolean
  /** Session event type, e.g. `turn/end` or `compaction/start`. */
  eventType: string
  /** Turn number of the latest completed turn. */
  turns: number
  /** Turn number at the last successful document. */
  lastTurnAt: number
  /** Epoch ms of the last successful document. */
  lastWriteAt: number
  now: number
  everyTurns: number
  minMinutes: number
}

export interface AutoDecision {
  generate: boolean
  reason: string
}

/** Decide whether this boundary should produce a document. */
export function autoDecision(input: AutoDecisionInput): AutoDecision {
  if (!input.enabled) return { generate: false, reason: 'disabled' }
  if (input.inflight) return { generate: false, reason: 'inflight' }
  const minGap = Math.max(0, input.minMinutes) * 60_000
  if (input.lastWriteAt > 0 && input.now - input.lastWriteAt < minGap) {
    return { generate: false, reason: 'too-soon' }
  }
  if (input.eventType === 'compaction/start') return { generate: true, reason: 'compaction' }
  if (input.eventType === 'turn/end') {
    const every = Math.max(1, Math.floor(input.everyTurns))
    if (input.turns - input.lastTurnAt >= every) return { generate: true, reason: 'turn-interval' }
    return { generate: false, reason: 'below-turn-interval' }
  }
  return { generate: false, reason: 'irrelevant-event' }
}

/** Directory that holds the automatic log beside the documents. */
export function autoLogPath(cwd: string, config: HandoffConfig): string {
  return join(resolveOutputDir(cwd, config.outputDir), 'auto.log')
}

/** Append one diagnostic line; logging must never break the hook. */
export function appendAutoLog(cwd: string, config: HandoffConfig, line: string): void {
  try {
    appendFileSync(autoLogPath(cwd, config), `[${new Date().toISOString()}] ${line}\n`, 'utf8')
  } catch {
    /* best effort */
  }
}

/** Read the current turn number out of a `turn/end` payload. */
export function turnNumberOf(event: { type?: string; data?: unknown }): number | undefined {
  if (event?.type !== 'turn/end') return undefined
  const data = event.data as { turn?: unknown } | undefined
  const turn = Number(data?.turn)
  return Number.isFinite(turn) ? turn : undefined
}

/**
 * Wire the automatic hook. Called from `apply()`; does nothing when
 * `autoGenerate` is off, so a profile can keep the plugin manual-only.
 */
export function attachAutoHandoff(ctx: Context, config: HandoffConfig): void {
  if (!config.autoGenerate) return
  const states = new Map<string, AutoHandoffState>()
  const stateOf = (id: string): AutoHandoffState => {
    let state = states.get(id)
    if (state === undefined) {
      state = { turns: 0, lastTurnAt: 0, lastWriteAt: 0, inflight: false, failures: 0 }
      states.set(id, state)
    }
    return state
  }

  ctx.effect(
    () =>
      ctx.on('session/event', (session: Session, event: { type: string; data?: unknown }) => {
        const header = session.header as { cwd?: string; origin?: string }
        // Delegated children are disposable; their parent owns the handoff.
        if (header.origin === 'subagent') return
        const id = String(session.id)
        const state = stateOf(id)
        const turn = turnNumberOf(event)
        if (turn !== undefined) state.turns = Math.max(state.turns, turn)
        const now = Date.now()
        const decision = autoDecision({
          enabled: config.autoGenerate,
          inflight: state.inflight,
          eventType: event.type,
          turns: state.turns,
          lastTurnAt: state.lastTurnAt,
          lastWriteAt: state.lastWriteAt,
          now,
          everyTurns: config.autoEveryTurns,
          minMinutes: config.autoMinMinutes,
        })
        if (!decision.generate) return
        const cwd = header.cwd ?? process.cwd()
        state.inflight = true
        void (async () => {
          try {
            const result = await generateHandoff({ ctx, session, config })
            state.lastWriteAt = Date.now()
            state.lastTurnAt = state.turns
            appendAutoLog(
              cwd,
              config,
              `generated ${result.relativePath} v${result.version} (${result.stats.messages} msgs, ${result.stats.chars} chars) via ${event.type}/${decision.reason}`,
            )
          } catch (error) {
            state.failures += 1
            appendAutoLog(cwd, config, `failed via ${event.type}/${decision.reason}: ${describeError(error)}`)
          } finally {
            state.inflight = false
          }
        })()
      }),
    'dsh-handoff: automatic handoff hook',
  )
}
