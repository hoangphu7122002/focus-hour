export type FocusDecision = {
  id: string
  title?: string
  status: string
  question?: string
  chosen?: string
  rejected: string[]
  why: string
  depends_on: string[]
  dependents: string[]
  impact: string[]
  supersedes?: string
  superseded_by?: string
  review_reason?: string
  evidence?: string
  adr?: string
}

export type FocusTask = {
  id: string
  title: string
  status: string
  level: string
  scope: string[]
  resources: string[]
  based_on: string[]
  stale: string[]
  staleReason: string | null
  prUrl: string | null
  prNumber: number | null
  costUsd: number
  escalations: number
  andon: { trigger: string; reason: string; class: string } | null
  checks: {
    files: string[]
    outOfScope: string[]
    added: number
    removed: number
    testsDelta: number
    mocksAdded: number
    testsPass: boolean
  } | null
  packet: { summary?: string; decisions?: string[]; risks?: string[]; out_of_scope?: string[] } | null
  prediction: string | null
  predictionSkipped: boolean
  predictionMatch: boolean | null
  waits: string | null
  publishError: string | null
}

export type FocusStatus = {
  root: string
  config: { language: { chat: string | null; code: string | null } | null; roadmap: string | null; smokeCommand: string | null; mainEffort: { ask: string; code: string } | null; predict: string; paneOutsideCheckpoint: string; reviewCap: number; mode: string; testCommand: string }
  session: {
    active: boolean
    id?: string
    mode?: string
    left?: number
    current?: number
    upcoming?: number
    inMs?: number
    inWindow: boolean
    pulledEarly?: boolean
    overtime?: boolean
    collapsed: boolean
  }
  flow: { text: string; derived: boolean }
  decisions: FocusDecision[]
  tasks: FocusTask[]
  resume: {
    last: { id: string; resumeFrom: string | null } | null
    needsReview: { id: string; title?: string; reason?: string }[]
    drafts: { id: string; title?: string }[]
    waiting: { id: string; title: string; prUrl: string | null; stale: boolean }[]
    stopped: { id: string; title: string; trigger?: string }[]
  }
  attention: { level: 0 | 1 | 2 | 3; reason: string; autoOpen: boolean }
  requests: { id: string; type: string; text: string; about?: string }[]
  agents?: { role: "builder" | "reviewer"; name: string; task: string; model: string; since: number | null; slot: number | null; rework: boolean }[]
  features: { current: string | null; roadmap: string | null; list: { id: string; name: string; goal: string; ac: string[]; status: string; depends: string[]; tasks: number; merged: number }[] }
  smoke: { sha: string; pass: boolean; at: number; seconds: number; tail: string } | null
  lessons: number
  workerAlive: boolean
}

export type FocusView = {
  tab: 'session' | 'decisions' | 'queue'
  selected: string | null
  revealQueue: boolean
  message: string | null
}

declare module 'claude-code' {
  interface PluginState {
    'focus-hour': {
      status: FocusStatus | null
      view: FocusView
    }
  }
}
