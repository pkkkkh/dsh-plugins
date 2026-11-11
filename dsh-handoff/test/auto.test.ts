import { describe, expect, it } from 'vitest'
import { autoDecision, turnNumberOf } from '../src/auto.ts'
import type { AutoDecisionInput } from '../src/auto.ts'

const now = 1_800_000_000_000

function input(patch: Partial<AutoDecisionInput> = {}): AutoDecisionInput {
  return {
    enabled: true,
    inflight: false,
    eventType: 'turn/end',
    turns: 30,
    lastTurnAt: 0,
    lastWriteAt: 0,
    now,
    everyTurns: 15,
    minMinutes: 30,
    ...patch,
  }
}

describe('autoDecision', () => {
  it('never generates when switched off', () => {
    expect(autoDecision(input({ enabled: false, eventType: 'compaction/start' }))).toEqual({
      generate: false,
      reason: 'disabled',
    })
  })

  it('skips while a generation is still running', () => {
    expect(autoDecision(input({ inflight: true, eventType: 'compaction/start' })).reason).toBe('inflight')
  })

  it('generates on compaction even with no turns counted yet', () => {
    expect(autoDecision(input({ eventType: 'compaction/start', turns: 0 }))).toEqual({
      generate: true,
      reason: 'compaction',
    })
  })

  it('respects the minimum gap for compaction', () => {
    const justWritten = now - 5 * 60_000
    expect(autoDecision(input({ eventType: 'compaction/start', lastWriteAt: justWritten })).reason).toBe('too-soon')
  })

  it('waits for the turn interval on turn/end', () => {
    expect(autoDecision(input({ turns: 14, lastTurnAt: 0 })).reason).toBe('below-turn-interval')
  })

  it('generates once the turn interval is reached', () => {
    expect(autoDecision(input({ turns: 15, lastTurnAt: 0 }))).toEqual({
      generate: true,
      reason: 'turn-interval',
    })
  })

  it('measures the interval from the last document turn', () => {
    expect(autoDecision(input({ turns: 24, lastTurnAt: 10 })).reason).toBe('below-turn-interval')
    expect(autoDecision(input({ turns: 25, lastTurnAt: 10 })).reason).toBe('turn-interval')
  })

  it('lets the minimum gap win over a satisfied turn interval', () => {
    const recent = now - 10 * 60_000
    expect(autoDecision(input({ turns: 40, lastTurnAt: 0, lastWriteAt: recent })).reason).toBe('too-soon')
  })

  it('ignores unrelated session events', () => {
    expect(autoDecision(input({ eventType: 'assistant/message' })).reason).toBe('irrelevant-event')
    expect(autoDecision(input({ eventType: 'session/title' })).reason).toBe('irrelevant-event')
  })

  it('treats a zero minimum gap as no throttle', () => {
    expect(autoDecision(input({ minMinutes: 0, lastWriteAt: now })).reason).toBe('turn-interval')
  })
})

describe('turnNumberOf', () => {
  it('reads the turn out of turn/end only', () => {
    expect(turnNumberOf({ type: 'turn/end', data: { turn: 7 } })).toBe(7)
    expect(turnNumberOf({ type: 'turn/start', data: { turn: 7 } })).toBeUndefined()
    expect(turnNumberOf({ type: 'turn/end' })).toBeUndefined()
    expect(turnNumberOf({ type: 'turn/end', data: { turn: 'x' } })).toBeUndefined()
  })
})
