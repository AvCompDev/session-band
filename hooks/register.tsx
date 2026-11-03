import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { AllTime, BoardTask, Stats } from '../types'

const BOARD = 'session-board'

const EMPTY: Stats = {
  turns: 0,
  costUsd: 0,
  lastCostUsd: 0,
  costHistory: [],
  tokens: 0,
  outputTokens: 0,
  agentMs: 0,
}

const stats = atom({ plugin: 'session-band', key: 'stats' } as const, EMPTY, {
  shape: 'stats-1',
})
const NO_ALL_TIME: AllTime = {
  sessions: 0,
  turns: 0,
  costUsd: 0,
  tokens: 0,
  outputTokens: 0,
  agentMs: 0,
}
const allTime = atom({ plugin: 'session-band', key: 'allTime' } as const, NO_ALL_TIME, {
  shape: 'alltime-1',
})
const tasks = atom({ plugin: 'session-band', key: 'tasks' } as const, [], {
  shape: 'tasks-1',
})

// Fixed prompts: nothing typed or read from tools goes into them.
const REVIEW_PROMPT =
  'Review the code changes made in this session for correctness and bugs. ' +
  'Use the secure-coding skill and run its quick check. List findings by ' +
  'severity, and do not change any files until I confirm.'
const AUDIT_PROMPT =
  'Run a security audit of the code, skills and plugins changed in this ' +
  'session: the secure-coding skill for code, the ast10-skill-auditor skill ' +
  'for skills and plugins. Report findings only, and do not change any ' +
  'files until I confirm.'

const MAX_SUBJECT = 200
const MAX_TASKS = 100
const SPARK = '▁▂▃▄▅▆▇█'

export function money(usd: number): string {
  return usd >= 100 ? `$${usd.toFixed(0)}` : `$${usd.toFixed(2)}`
}

export function count(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`
  return `${n}`
}

export function duration(ms: number): string {
  const s = Math.round(ms / 1000)
  if (s < 60) return `${s}s`
  const m = Math.floor(s / 60)
  if (m < 60) return `${m}m ${s % 60}s`
  return `${Math.floor(m / 60)}h ${m % 60}m`
}

export function spark(values: readonly number[]): string {
  if (values.length === 0) return ''
  const max = Math.max(...values)
  return values
    .map(v => SPARK[max <= 0 ? 0 : Math.min(7, Math.round((v / max) * 7))])
    .join('')
}

function clean(value: unknown): string {
  return typeof value === 'string'
    ? value.replace(/\s+/g, ' ').trim().slice(0, MAX_SUBJECT)
    : ''
}

function status(value: unknown): BoardTask['status'] | undefined {
  return value === 'pending' || value === 'in_progress' || value === 'completed'
    ? value
    : undefined
}

async function copyLastReply(
  $: EngineInterface,
  surface: Parameters<EngineInterface['ui']['copy']>[0]['surface'],
): Promise<void> {
  const found = await $.session.messages()
  if (!Array.isArray(found)) return
  const last = [...found]
    .reverse()
    .find(m => m.role === 'assistant' && m.text.trim() !== '')
  if (last === undefined) {
    $.ui.toast('No reply to copy yet')
    return
  }
  const done = await $.ui.copy({ text: last.text, surface })
  $.ui.toast(done.isCopied ? 'Last reply copied' : 'Copy did not work here')
}

async function compact($: EngineInterface): Promise<void> {
  try {
    const result = await $.session.compact()
    $.ui.toast(result.skip ? 'Compact was skipped' : 'Conversation compacted')
  } catch {
    $.ui.toast('Wait for the current turn to finish, then compact')
  }
}

// Saved totals: one store key per session id, newest last, oldest pruned.
const KEY_PREFIX = 'session:'
const MAX_SAVED_SESSIONS = 200

function num(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0
    ? value
    : 0
}

// The store is a JSON file: validate what comes back before using it.
export function parseSaved(value: unknown): Stats | undefined {
  if (typeof value !== 'object' || value === null) return undefined
  const v = value as Record<string, unknown>
  return {
    turns: Math.floor(num(v.turns)),
    costUsd: num(v.costUsd),
    lastCostUsd: num(v.lastCostUsd),
    costHistory: Array.isArray(v.costHistory)
      ? v.costHistory.slice(-12).map(num)
      : [],
    tokens: num(v.tokens),
    outputTokens: num(v.outputTokens),
    agentMs: num(v.agentMs),
  }
}

const ALL_TIME_KEY = 'alltime'

export function parseAllTime(value: unknown): AllTime {
  if (typeof value !== 'object' || value === null) return { ...NO_ALL_TIME }
  const v = value as Record<string, unknown>
  return {
    sessions: Math.floor(num(v.sessions)),
    turns: Math.floor(num(v.turns)),
    costUsd: num(v.costUsd),
    tokens: num(v.tokens),
    outputTokens: num(v.outputTokens),
    agentMs: num(v.agentMs),
  }
}

// Read the saved figure fresh and add to it, so two sessions open at once on
// one machine each add their own turns rather than overwrite each other.
async function addToAllTime(
  $: EngineInterface,
  add: Omit<AllTime, 'sessions'>,
  isNewSession: boolean,
): Promise<AllTime> {
  const was = parseAllTime(await $.store.get(ALL_TIME_KEY))
  const now: AllTime = {
    sessions: was.sessions + (isNewSession ? 1 : 0),
    turns: was.turns + add.turns,
    costUsd: was.costUsd + add.costUsd,
    tokens: was.tokens + add.tokens,
    outputTokens: was.outputTokens + add.outputTokens,
    agentMs: was.agentMs + add.agentMs,
  }
  await $.store.set(ALL_TIME_KEY, now)
  return now
}

async function saveTotals($: EngineInterface, s: Stats): Promise<void> {
  const key = KEY_PREFIX + (await $.session.id())
  // Delete then set, so this session moves to the end of the key order.
  await $.store.delete(key)
  await $.store.set(key, s)
  const keys = (await $.store.keys()).filter(k => k.startsWith(KEY_PREFIX))
  for (const old of keys.slice(0, Math.max(0, keys.length - MAX_SAVED_SESSIONS))) {
    await $.store.delete(old)
  }
}

export const register: Register = on => {
  // The cost the engine reported at the last turn this module saw. Cost is
  // added as the change since then, so totals keep adding up whether or not
  // the engine's own figure restarts when a session is reopened.
  let lastSeenUsd: number | undefined
  // Whether this session is already counted in the all-time session count.
  let isCounted = true

  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: 'session-board',
      description: 'Show the task board for this session',
    })
    lastSeenUsd = (await $.session.usage()).cost?.usd ?? 0
    const saved = parseSaved(
      await $.store.get(KEY_PREFIX + (await $.session.id())),
    )
    isCounted = saved !== undefined
    const total = parseAllTime(await $.store.get(ALL_TIME_KEY))
    await update($, allTime, () => total)
    if (saved !== undefined) {
      // Keep whichever has more turns (a hot reload keeps the live state).
      await update($, stats, s => (saved.turns > s.turns ? saved : s))
    }
    return next(e)
  }).catch(($, e, next) => next(e))

  on('command.run', { command: 'session-board' }, async $ => {
    await $.ui.open({ id: BOARD, title: 'Task board' })
    return { text: 'Task board opened.' }
  })

  on('turn.complete', async ($, e, next) => {
    const result = await next(e)
    if (e.agentId !== undefined) return result

    const usage = await $.session.usage()
    const nowUsd = usage.cost?.usd
    const u = e.usage
    let last = 0
    if (nowUsd !== undefined) {
      const before = lastSeenUsd ?? nowUsd
      last = nowUsd >= before ? nowUsd - before : nowUsd
      lastSeenUsd = nowUsd
    }
    const add = {
      turns: 1,
      costUsd: last,
      tokens: u
        ? u.input_tokens +
          u.output_tokens +
          u.cache_read_input_tokens +
          u.cache_creation_input_tokens
        : 0,
      outputTokens: u?.output_tokens ?? 0,
      agentMs: e.durationMs,
    }
    await update($, stats, s => ({
      turns: s.turns + add.turns,
      costUsd: s.costUsd + add.costUsd,
      lastCostUsd: last,
      costHistory: [...s.costHistory, last].slice(-12),
      tokens: s.tokens + add.tokens,
      outputTokens: s.outputTokens + add.outputTokens,
      agentMs: s.agentMs + add.agentMs,
    }))
    await saveTotals($, await read($, stats))
    const total = await addToAllTime($, add, !isCounted)
    isCounted = true
    await update($, allTime, () => total)
    return result
  }).catch(($, e, next) => next(e))

  // Board: follow the task-list tools. Their text is drawn as plain Text only.
  on('tool.call', async ($, e, next) => {
    const ran = await next(e)
    const input = e as unknown as Record<string, unknown>

    if (e.tool === 'TaskCreate') {
      const text = JSON.stringify(ran).slice(0, 2000)
      const id = /#(\d{1,6})/.exec(text)?.[1]
      const subject = clean(input.subject)
      if (id !== undefined && subject !== '') {
        await update($, tasks, list =>
          [
            ...list.filter(t => t.id !== id),
            { id, subject, status: 'pending' as const },
          ].slice(-MAX_TASKS),
        )
      }
    } else if (e.tool === 'TaskUpdate') {
      const id = clean(input.taskId)
      const newStatus = status(input.status)
      const subject = clean(input.subject)
      if (input.status === 'deleted') {
        await update($, tasks, list => list.filter(t => t.id !== id))
      } else if (id !== '') {
        await update($, tasks, list =>
          list.map(t =>
            t.id === id
              ? {
                  ...t,
                  status: newStatus ?? t.status,
                  subject: subject || t.subject,
                }
              : t,
          ),
        )
      }
    } else if (e.tool === 'TodoWrite' && Array.isArray(input.todos)) {
      const list: BoardTask[] = []
      input.todos.slice(0, MAX_TASKS).forEach((todo: unknown, i: number) => {
        const t = (todo ?? {}) as Record<string, unknown>
        const subject = clean(t.content)
        if (subject !== '') {
          list.push({ id: `todo-${i}`, subject, status: status(t.status) ?? 'pending' })
        }
      })
      await update($, tasks, () => list)
    }
    return ran
  }).catch(($, e, next) => next(e)) // board tracking failing never blocks the tool

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    if (e.props.hasSurvey) return next(e)

    const s = await read($, stats)
    const all = await read($, allTime)
    const { Box, Button, Text } = $.ui.resolve(e)
    const avgCost = s.turns > 0 ? s.costUsd / s.turns : 0
    const avgMs = s.turns > 0 ? s.agentMs / s.turns : 0

    return (
      <Box flexDirection="column">
        <Box flexDirection="row" gap={1} flexWrap="wrap">
          <Button key="copy" label="Copy" onPress={press => copyLastReply($, press.surface)} />
          <Button key="review" label="Review" onPress={() => void $.prompt.submit({ text: REVIEW_PROMPT })} />
          <Button key="audit" label="Audit" onPress={() => void $.prompt.submit({ text: AUDIT_PROMPT })} />
          <Button
            key="board"
            label="Board"
            onPress={() => void $.ui.open({ id: BOARD, title: 'Task board' })}
          />
          <Button key="compact" label="Compact" onPress={() => compact($)} />
        </Box>
        <Box flexDirection="row" gap={3} flexWrap="wrap">
          <Text>
            <Text dimColor>cost </Text>
            <Text bold>{money(s.costUsd)}</Text>
            <Text dimColor>
              {' '}last {money(s.lastCostUsd)} · avg {money(avgCost)} {spark(s.costHistory)}
            </Text>
          </Text>
          <Text>
            <Text dimColor>tokens </Text>
            <Text bold>{count(s.tokens)}</Text>
            <Text dimColor>
              {' '}
              {count(s.outputTokens)} out · {s.turns} turns
            </Text>
          </Text>
          <Text>
            <Text dimColor>agent time </Text>
            <Text bold>{duration(s.agentMs)}</Text>
            <Text dimColor> avg {duration(avgMs)} / turn</Text>
          </Text>
        </Box>
        <Text>
          <Text dimColor>all sessions </Text>
          <Text bold>{money(all.costUsd)}</Text>
          <Text dimColor>
            {' '}
            · {count(all.tokens)} tokens · {all.turns} turns · {all.sessions}{' '}
            {all.sessions === 1 ? 'session' : 'sessions'} · {duration(all.agentMs)}
          </Text>
        </Text>
      </Box>
    )
  })

  on('ui.render', { component: 'Pane', requestId: BOARD }, async ($, e) => {
    const { Box, Text } = $.ui.resolve(e)
    const list = await read($, tasks)
    const groups: [BoardTask['status'], string][] = [
      ['in_progress', 'In progress'],
      ['pending', 'To do'],
      ['completed', 'Done'],
    ]

    if (list.length === 0) {
      return (
        <Box flexDirection="column">
          <Text dimColor>No tasks yet. Tasks Claude creates will show here.</Text>
        </Box>
      )
    }

    return (
      <Box flexDirection="column">
        {groups.map(([key, title]) => {
          const rows = list.filter(t => t.status === key)
          return (
            <Box key={key} flexDirection="column" marginBottom={1}>
              <Text bold>
                {title} ({rows.length})
              </Text>
              {rows.map(t => (
                <Text dimColor={key === 'completed'}>
                  {key === 'completed' ? '✓' : key === 'in_progress' ? '▶' : '○'} {t.subject}
                </Text>
              ))}
            </Box>
          )
        })}
      </Box>
    )
  })
}
