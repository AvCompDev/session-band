export type Stats = {
  turns: number
  costUsd: number
  lastCostUsd: number
  costHistory: number[]
  tokens: number
  outputTokens: number
  agentMs: number
}

export type AllTime = {
  sessions: number
  turns: number
  costUsd: number
  tokens: number
  outputTokens: number
  agentMs: number
}

export type BoardTask = {
  id: string
  subject: string
  status: 'pending' | 'in_progress' | 'completed'
}

declare module 'claude-code' {
  interface PluginState {
    'session-band': {
      stats: Shaped<Stats>
      tasks: Shaped<BoardTask[]>
      allTime: Shaped<AllTime>
    }
  }
}
