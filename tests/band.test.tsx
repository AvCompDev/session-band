import { expect, mock, test } from 'claude-code/testing'

const BAND = {
  plugin: 'session-band',
  component: 'AbovePrompt',
  props: { hasSurvey: false, bodyColumns: 100 },
} as const

const BOARD = {
  plugin: 'session-band',
  component: 'Pane',
  requestId: 'session-board',
  props: {
    title: 'Task board',
    isFocused: false,
    bodyColumns: 40,
    placement: 'dock',
    scroll: { offset: 0, bodyRows: 20 },
    view: {},
  },
} as const

const TURN = {
  answer: 'hi',
  durationMs: 104000,
  isAborted: false,
  turnId: 't1',
  reason: 'answer',
  usage: {
    model: 'm',
    input_tokens: 1000,
    output_tokens: 7800,
    cache_read_input_tokens: 1591200,
    cache_creation_input_tokens: 0,
  },
} as const

function engine(on: Parameters<Parameters<typeof test>[1]>[1], usd: { now: number }, id = 'abc') {
  on('session.usage', () => ({
    value: { startedAt: 0, context: { window: 200000 }, rateLimits: [], cost: { usd: usd.now } },
  }))
  on('session.id', () => ({ value: id }))
  on('command.register', () => ({ value: { command: 'session-board' } }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('turn.complete', (_, e) => ({ text: e.answer }))
}

test('band shows stats after a turn, on every surface', async ($, on) => {
  const saves: { key: string; value: unknown }[] = []
  const kept = new Map<string, unknown>()
  on('store.get', (_, e) => ({ value: kept.get(e.key) }))
  on('store.set', (_, e) => {
    saves.push({ key: e.key, value: e.value })
    kept.set(e.key, e.value)
    return { value: undefined }
  })
  on('store.delete', (_, e) => {
    kept.delete(e.key)
    return { value: undefined }
  })
  on('store.keys', () => ({ value: [...kept.keys()] }))
  const usd = { now: 0 }
  engine(on, usd)
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  usd.now = 0.44
  await $.turn.complete(TURN)

  for (const surface of ['terminal', 'desktop', 'vscode', 'mobile'] as const) {
    const ui = await $.ui.mount({ ...BAND, surface })
    expect((await ui.find({ type: 'Text', text: /\$0\.44/ }))).toBeDefined()
    expect((await ui.find({ type: 'Text', text: /1\.6M/ }))).toBeDefined()
    expect((await ui.find({ type: 'Text', text: /1m 44s/ }))).toBeDefined()
    for (const key of ['copy', 'review', 'audit', 'board', 'compact']) {
      expect(await ui.find({ key })).toBeDefined()
    }
    await ui.unmount()
  }
  const saved = saves.filter(s => s.key === 'session:abc').at(-1)
  expect(saved?.key).toBe('session:abc')
  expect((saved?.value as { turns: number; costUsd: number }).turns).toBe(1)
  expect(Math.round((saved?.value as { costUsd: number }).costUsd * 100)).toBe(44)
})

test('a reopened session continues from its saved totals', async ($, on) => {
  mock.store(on, {
    'session:abc': {
      turns: 6, costUsd: 0.44, lastCostUsd: 0.05, costHistory: [0.05],
      tokens: 1600000, outputTokens: 7800, agentMs: 104000,
    },
    'session:other': { turns: 99, costUsd: 9 },
  })
  // The engine's own cost figure restarted at 0 after reopening.
  const usd = { now: 0 }
  engine(on, usd)
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  usd.now = 0.1
  await $.turn.complete(TURN)

  const ui = await $.ui.mount({ ...BAND, surface: 'desktop' })
  expect(await ui.find({ type: 'Text', text: /\$0\.54/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /7 turns/ })).toBeDefined()
  await ui.unmount()
})

test('all-time totals add up across sessions', async ($, on) => {
  mock.store(on, {
    alltime: { sessions: 3, turns: 20, costUsd: 2, tokens: 5000000, outputTokens: 30000, agentMs: 600000 },
  })
  const usd = { now: 0 }
  engine(on, usd, 'brand-new')
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  usd.now = 0.5
  await $.turn.complete(TURN)
  usd.now = 0.75
  await $.turn.complete(TURN)

  const ui = await $.ui.mount({ ...BAND, surface: 'desktop' })
  // $2.00 + $0.75, one new session counted once over two turns.
  expect(await ui.find({ type: 'Text', text: /\$2\.75/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /22 turns · 4 sessions/ })).toBeDefined()
  await ui.unmount()
})

test('a reopened session is not counted twice in all-time', async ($, on) => {
  mock.store(on, {
    'session:abc': { turns: 6, costUsd: 0.44 },
    alltime: { sessions: 3, turns: 20, costUsd: 2 },
  })
  const usd = { now: 0 }
  engine(on, usd)
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  usd.now = 0.1
  await $.turn.complete(TURN)
  const ui = await $.ui.mount({ ...BAND, surface: 'desktop' })
  expect(await ui.find({ type: 'Text', text: /21 turns · 3 sessions/ })).toBeDefined()
  await ui.unmount()
})

test('a corrupt saved value is read safely', async ($, on) => {
  mock.store(on, { 'session:abc': { turns: 'x', costUsd: -5, costHistory: 'no' } })
  const usd = { now: 0 }
  engine(on, usd)
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  const ui = await $.ui.mount({ ...BAND, surface: 'desktop' })
  expect(await ui.find({ type: 'Text', text: /\$0\.00/ })).toBeDefined()
  await ui.unmount()
})

test('Review submits the fixed review prompt', async ($, on) => {
  const sent: string[] = []
  on('prompt.submit', (_, e) => {
    sent.push(e.text)
    return { text: e.text }
  })
  const ui = await $.ui.mount({ ...BAND, surface: 'desktop' })
  await ui.press({ key: 'review' })
  expect(sent.length).toBe(1)
  expect(sent[0]).toContain('secure-coding')
  await ui.unmount()
})

test('board follows TaskCreate and TaskUpdate', async ($, on) => {
  on('tool.call', (_, e) =>
    e.tool === 'TaskCreate'
      ? { result: 'Task #1 created successfully: Build band' }
      : { result: 'ok' },
  )

  await $.tool.call({ tool: 'TaskCreate', subject: 'Build band', description: 'x' })
  await $.tool.call({ tool: 'TaskUpdate', taskId: '1', status: 'completed' })

  const ui = await $.ui.mount({ ...BOARD, surface: 'desktop' })
  expect((await ui.find({ type: 'Text', text: /Build band/ }))?.text).toBe('✓ Build band')
  await ui.unmount()
})
