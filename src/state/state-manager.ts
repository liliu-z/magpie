// src/state/state-manager.ts
import { mkdir, readFile, writeFile, readdir } from 'fs/promises'
import { join } from 'path'
import { homedir } from 'os'
import type { ReviewSession, FeatureAnalysis, DiscussSession } from './types.js'

export class StateManager {
  private baseDir: string
  private magpieDir: string

  constructor(baseDir: string) {
    this.baseDir = baseDir
    this.magpieDir = join(baseDir, '.magpie')
  }

  async init(): Promise<void> {
    await mkdir(join(this.magpieDir, 'sessions'), { recursive: true })
    await mkdir(join(this.magpieDir, 'cache'), { recursive: true })
  }

  async saveSession(session: ReviewSession): Promise<void> {
    const sessionsDir = join(this.magpieDir, 'sessions')
    await mkdir(sessionsDir, { recursive: true })
    const filePath = join(sessionsDir, `${session.id}.json`)
    await writeFile(filePath, JSON.stringify(session, null, 2))
  }

  async loadSession(id: string): Promise<ReviewSession | null> {
    const filePath = join(this.magpieDir, 'sessions', `${id}.json`)
    try {
      const content = await readFile(filePath, 'utf-8')
      const data = JSON.parse(content)
      // Convert date strings back to Date objects
      data.startedAt = new Date(data.startedAt)
      data.updatedAt = new Date(data.updatedAt)
      return data as ReviewSession
    } catch {
      return null
    }
  }

  async findIncompleteSessions(): Promise<ReviewSession[]> {
    const sessionsDir = join(this.magpieDir, 'sessions')
    try {
      const files = await readdir(sessionsDir)
      const sessions: ReviewSession[] = []

      for (const file of files) {
        if (file.endsWith('.json')) {
          const id = file.replace('.json', '')
          const session = await this.loadSession(id)
          if (session && (session.status === 'in_progress' || session.status === 'paused')) {
            sessions.push(session)
          }
        }
      }

      // Sort by updatedAt descending (most recent first)
      sessions.sort((a, b) => b.updatedAt.getTime() - a.updatedAt.getTime())
      return sessions
    } catch {
      return []
    }
  }

  async listAllSessions(): Promise<ReviewSession[]> {
    const sessionsDir = join(this.magpieDir, 'sessions')
    try {
      const files = await readdir(sessionsDir)
      const sessions: ReviewSession[] = []

      for (const file of files) {
        if (file.endsWith('.json')) {
          const id = file.replace('.json', '')
          const session = await this.loadSession(id)
          if (session) {
            sessions.push(session)
          }
        }
      }

      // Sort by updatedAt descending (most recent first)
      sessions.sort((a, b) => b.updatedAt.getTime() - a.updatedAt.getTime())
      return sessions
    } catch {
      return []
    }
  }

  async saveFeatureAnalysis(analysis: FeatureAnalysis): Promise<void> {
    const cacheDir = join(this.magpieDir, 'cache')
    await mkdir(cacheDir, { recursive: true })
    const filePath = join(cacheDir, 'feature-analysis.json')
    await writeFile(filePath, JSON.stringify(analysis, null, 2))
  }

  async loadFeatureAnalysis(): Promise<FeatureAnalysis | null> {
    const filePath = join(this.magpieDir, 'cache', 'feature-analysis.json')
    try {
      const content = await readFile(filePath, 'utf-8')
      const data = JSON.parse(content)
      data.analyzedAt = new Date(data.analyzedAt)
      return data as FeatureAnalysis
    } catch {
      return null
    }
  }

  // Discuss session methods — stored in ~/.magpie/discussions/
  private get discussionsDir(): string {
    return join(homedir(), '.magpie', 'discussions')
  }

  async initDiscussions(): Promise<void> {
    await mkdir(this.discussionsDir, { recursive: true })
  }

  async saveDiscussSession(session: DiscussSession): Promise<void> {
    await mkdir(this.discussionsDir, { recursive: true })
    const filePath = join(this.discussionsDir, `${session.id}.json`)
    await writeFile(filePath, JSON.stringify(session, null, 2))
  }

  async loadDiscussSession(id: string): Promise<DiscussSession | null> {
    const filePath = join(this.discussionsDir, `${id}.json`)
    try {
      const content = await readFile(filePath, 'utf-8')
      const data = JSON.parse(content)
      data.createdAt = new Date(data.createdAt)
      data.updatedAt = new Date(data.updatedAt)
      for (const round of data.rounds) {
        round.timestamp = new Date(round.timestamp)
        for (const msg of round.messages) {
          msg.timestamp = new Date(msg.timestamp)
        }
      }
      return data as DiscussSession
    } catch {
      return null
    }
  }

  async listDiscussSessions(): Promise<DiscussSession[]> {
    try {
      const files = await readdir(this.discussionsDir)
      const sessions: DiscussSession[] = []
      for (const file of files) {
        if (file.endsWith('.json')) {
          const id = file.replace('.json', '')
          const session = await this.loadDiscussSession(id)
          if (session) sessions.push(session)
        }
      }
      sessions.sort((a, b) => b.updatedAt.getTime() - a.updatedAt.getTime())
      return sessions
    } catch {
      return []
    }
  }
}
