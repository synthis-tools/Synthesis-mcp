/**
 * @fileoverview Synthesis MCP Server - Project Management with Persistent Context
 *
 * Synthesis Protocol: Never lose project context. This MCP server provides
 * 4 tools that help AI coding assistants maintain context across sessions.
 *
 * Supports stdio and HTTP transports.
 */

import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js'
import {
  CallToolRequestSchema,
  ErrorCode,
  ListToolsRequestSchema,
  McpError,
  isInitializeRequest,
  type Tool,
} from '@modelcontextprotocol/sdk/types.js'
import { createServer } from 'http'
import { randomUUID } from 'crypto'
import * as fs from 'fs'
import * as path from 'path'
import * as os from 'os'

// ============================================================================
// Configuration
// ============================================================================

const TRANSPORT_TYPE = (process.env.TRANSPORT || 'stdio') as 'stdio' | 'http'
const HTTP_PORT = parseInt(process.env.PORT || '8080', 10)

// Synthesis Hub location (default: ~/Claude Synthesis Projects)
function getSynthesisHome(): string {
  return process.env.SYNTHESIS_HOME || path.join(os.homedir(), 'Claude Synthesis Projects')
}

// Session management for HTTP transport
const transports: { [sessionId: string]: StreamableHTTPServerTransport } = {}
const servers: { [sessionId: string]: Server } = {}

// ============================================================================
// Security: Path Sanitization
// ============================================================================

/**
 * Sanitize a project ID to prevent path traversal attacks.
 * Only allows alphanumeric characters, hyphens, and underscores.
 * @param projectId - The raw project ID from user input
 * @returns Sanitized project ID safe for use in file paths
 * @throws Error if project ID is invalid or empty after sanitization
 */
function sanitizeProjectId(projectId: string): string {
  if (!projectId || typeof projectId !== 'string') {
    throw new Error('Project ID is required')
  }

  // Remove any path traversal attempts and invalid characters
  const sanitized = projectId
    .replace(/\.\./g, '') // Remove path traversal
    .replace(/[/\\]/g, '') // Remove path separators
    .replace(/[^a-zA-Z0-9_-]/g, '-') // Only allow safe characters
    .replace(/^-+|-+$/g, '') // Remove leading/trailing hyphens
    .substring(0, 100) // Limit length

  if (!sanitized) {
    throw new Error('Invalid project ID: must contain alphanumeric characters')
  }

  return sanitized
}

/**
 * Sanitize a filename to prevent path traversal attacks.
 * @param filename - The raw filename from user input
 * @returns Sanitized filename safe for use in file paths
 */
function sanitizeFilename(filename: string): string {
  if (!filename || typeof filename !== 'string') {
    return 'unnamed'
  }

  return filename
    .replace(/\.\./g, '')
    .replace(/[/\\]/g, '')
    .replace(/[^a-zA-Z0-9_.-]/g, '-')
    .substring(0, 100) || 'unnamed'
}

/**
 * Verify that a resolved path is within the synthesis home directory.
 * @param resolvedPath - The fully resolved path to check
 * @param synthesisHome - The synthesis home directory
 * @throws Error if path escapes the synthesis home directory
 */
function verifyPathWithinHome(resolvedPath: string, synthesisHome: string): void {
  const normalizedPath = path.normalize(resolvedPath)
  const normalizedHome = path.normalize(synthesisHome)

  if (!normalizedPath.startsWith(normalizedHome)) {
    throw new Error('Path traversal detected: access denied')
  }
}

// ============================================================================
// Utility Functions
// ============================================================================

function getToday(): string {
  return new Date().toISOString().split('T')[0] ?? ''
}

function slugify(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .substring(0, 50)
}

function ensureDir(dirPath: string): void {
  if (!fs.existsSync(dirPath)) {
    fs.mkdirSync(dirPath, { recursive: true })
  }
}

function readYaml(filePath: string): Record<string, unknown> {
  if (!fs.existsSync(filePath)) {
    return { projects: [] }
  }
  const content = fs.readFileSync(filePath, 'utf-8')
  // Simple YAML parser for index.yaml
  const lines = content.split('\n')
  const result: { projects: Array<Record<string, unknown>> } = { projects: [] }
  let currentProject: Record<string, unknown> | null = null

  for (const line of lines) {
    if (line.trim().startsWith('- id:')) {
      if (currentProject) result.projects.push(currentProject)
      currentProject = { id: line.split(':')[1]?.trim() }
    } else if (currentProject && line.includes(':')) {
      const [key, ...valueParts] = line.split(':')
      const keyTrimmed = key?.trim()
      const value = valueParts.join(':').trim()
      if (keyTrimmed && !keyTrimmed.startsWith('-')) {
        currentProject[keyTrimmed] = value
      }
    }
  }
  if (currentProject) result.projects.push(currentProject)

  return result
}

function writeYaml(filePath: string, data: { projects: Array<Record<string, unknown>> }): void {
  let content = 'projects:\n'
  for (const project of data.projects) {
    content += `  - id: ${project.id}\n`
    for (const [key, value] of Object.entries(project)) {
      if (key !== 'id') {
        content += `    ${key}: ${value}\n`
      }
    }
  }
  fs.writeFileSync(filePath, content)
}

// ============================================================================
// Tool Definitions
// ============================================================================

const synthesisStartTool: Tool = {
  name: 'synthesis_start',
  description: `**MANDATORY FIRST CALL**: You MUST call this tool BEFORE doing ANY work when a user mentions a project. This loads the project state and shows you what to do next.

Triggers: "lets work on X", "can we test", "continue with", "back to", any project name mention.

If the project is not found, you'll be prompted to register it.`,
  inputSchema: {
    type: 'object',
    properties: {
      query: {
        type: 'string',
        description: 'Project name, description, or path to search for',
      },
      register_if_new: {
        type: 'boolean',
        description: 'If true and project not found, register current directory as new project',
      },
      name: {
        type: 'string',
        description: 'Project name for registration (defaults to folder name)',
      },
      description: {
        type: 'string',
        description: 'Project description for registration',
      },
    },
    required: ['query'],
  },
}

const synthesisCheckpointTool: Tool = {
  name: 'synthesis_checkpoint',
  description: `**CALL AFTER SIGNIFICANT WORK**: You MUST call this after completing any meaningful task: bug fix, feature added, file created/modified, test run, refactor done, decision made.

If losing this progress would hurt, checkpoint it! Auto-updates CONTEXT.md and creates work-log.`,
  inputSchema: {
    type: 'object',
    properties: {
      project_id: {
        type: 'string',
        description: 'The project ID',
      },
      summary: {
        type: 'string',
        description: 'Brief summary of what was accomplished',
      },
      files_changed: {
        type: 'array',
        items: { type: 'string' },
        description: 'List of files that were changed',
      },
      completed_steps: {
        type: 'array',
        items: { type: 'number' },
        description: 'Indices (1-based) of Next Steps to mark as completed',
      },
      add_next_step: {
        type: 'string',
        description: 'New next step to add if discovered',
      },
      details: {
        type: 'string',
        description: 'Detailed description of what was done',
      },
    },
    required: ['project_id', 'summary'],
  },
}

const synthesisLessonTool: Tool = {
  name: 'synthesis_lesson',
  description: `**CALL WHEN YOU SOLVE A PROBLEM OR DISCOVER SOMETHING**: You MUST call this when you: fix a bug (incident), find a root cause (incident), discover a useful technique (pattern), or learn something reusable.

Triggers: "fixed", "the issue was", "root cause", "solved by", "the trick is", "learned that".`,
  inputSchema: {
    type: 'object',
    properties: {
      project_id: {
        type: 'string',
        description: 'The project ID',
      },
      type: {
        type: 'string',
        enum: ['incident', 'pattern'],
        description: 'incident = bug fix/problem solved, pattern = useful technique discovered',
      },
      title: {
        type: 'string',
        description: 'Short title for the lesson',
      },
      what_happened: {
        type: 'string',
        description: 'What was the problem or what did you discover?',
      },
      solution: {
        type: 'string',
        description: 'How was it solved or what is the technique?',
      },
      keywords: {
        type: 'array',
        items: { type: 'string' },
        description: 'Keywords for finding this lesson later',
      },
    },
    required: ['project_id', 'type', 'title', 'what_happened', 'solution'],
  },
}

const synthesisSearchTool: Tool = {
  name: 'synthesis_search',
  description: `**CALL WHEN STUCK OR FACING AN ISSUE**: Search lessons for solutions to problems you've encountered before.

Use when: user is stuck, you see an error you might have solved before, or you want to check if there's a known solution.

Triggers: "I'm stuck", "this error", "not working", "how do I", debugging issues.`,
  inputSchema: {
    type: 'object',
    properties: {
      keywords: {
        type: 'array',
        items: { type: 'string' },
        description: 'Keywords to search for (e.g., ["pdf", "watermark", "error"])',
      },
      error_message: {
        type: 'string',
        description: 'Specific error message if applicable',
      },
    },
    required: ['keywords'],
  },
}

// ============================================================================
// Tool Handlers
// ============================================================================

async function handleSynthesisStart(params: {
  query: string
  register_if_new?: boolean
  name?: string
  description?: string
}): Promise<{ content: Array<{ type: string; text: string }> }> {
  const { query, register_if_new = false, name, description } = params
  const synthesisHome = getSynthesisHome()
  const indexPath = path.join(synthesisHome, 'index.yaml')
  const today = getToday()

  // Ensure hub exists
  ensureDir(synthesisHome)
  ensureDir(path.join(synthesisHome, '_lessons'))
  ensureDir(path.join(synthesisHome, 'tracking'))

  // Read or create index
  const index = readYaml(indexPath) as { projects: Array<Record<string, unknown>> }
  if (!index.projects) index.projects = []

  // Search for project
  const queryLower = query.toLowerCase()
  let matchedProject = index.projects.find((p) => {
    const id = String(p.id || '').toLowerCase()
    const pName = String(p.name || '').toLowerCase()
    return id === queryLower || id.includes(queryLower) || pName.includes(queryLower)
  })

  // Register new project if requested
  if (!matchedProject && register_if_new) {
    const cwd = process.cwd()
    const cwdName = path.basename(cwd)
    const rawProjectId = slugify(name || cwdName) || 'project-' + Date.now()

    // Sanitize project ID for safe file operations
    const projectId = sanitizeProjectId(rawProjectId)
    const projectName = name || cwdName

    const newProject = {
      id: projectId,
      name: projectName,
      status: 'active',
      description: description || `Project at ${cwd}`,
      path: cwd,
      last_session: today,
    }

    index.projects.push(newProject)
    writeYaml(indexPath, index)

    // Create CONTEXT.md with verified paths
    const contextDir = path.join(synthesisHome, 'tracking', projectId)
    verifyPathWithinHome(contextDir, synthesisHome)
    ensureDir(contextDir)

    const workLogsDir = path.join(contextDir, 'work-logs')
    verifyPathWithinHome(workLogsDir, synthesisHome)
    ensureDir(workLogsDir)

    const contextContent = `# Project: ${projectName}

## Overview
Project located at: \`${cwd}\`

**Started:** ${today}
**Status:** In Progress

## Current State
Project registered with Synthesis.

**Key artifacts:**
- Project root: \`${cwd}\`

## Next Steps
1. [ ] Define project goals and requirements
2. [ ] Document current state
3. [ ] Plan next development phase

## Blockers
*None currently*

## Key Decisions
| Decision | Rationale | Date |
|---|---|---|
| Registered with Synthesis | Enable context tracking | ${today} |

## Session History
| Date | Summary |
|---|---|
| ${today} | Project registered with Synthesis |
`
    const contextFilePath = path.join(contextDir, 'CONTEXT.md')
    verifyPathWithinHome(contextFilePath, synthesisHome)
    fs.writeFileSync(contextFilePath, contextContent)
    matchedProject = newProject
  }

  if (matchedProject) {
    // Update last_session
    const projectIndex = index.projects.findIndex((p) => p.id === matchedProject!.id)
    if (projectIndex !== -1) {
      const projectToUpdate = index.projects[projectIndex]
      if (projectToUpdate) {
        projectToUpdate.last_session = today
      }
      writeYaml(indexPath, index)
    }

    // Sanitize and read CONTEXT.md
    const safeProjectId = sanitizeProjectId(String(matchedProject.id))
    const contextPath = path.join(synthesisHome, 'tracking', safeProjectId, 'CONTEXT.md')
    verifyPathWithinHome(contextPath, synthesisHome)

    let contextContent = ''
    if (fs.existsSync(contextPath)) {
      contextContent = fs.readFileSync(contextPath, 'utf-8')
    }

    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify(
            {
              success: true,
              project: matchedProject,
              context_content: contextContent,
              _instructions:
                '\n**SESSION START PROTOCOL:**\n1. Project state loaded - review current state and next steps\n2. Continue from "Next Steps" - do NOT ask user to re-explain\n3. After ANY significant task -> call synthesis_checkpoint\n4. If you fix a bug or discover something -> call synthesis_lesson\n',
            },
            null,
            2
          ),
        },
      ],
    }
  }

  // Project not found
  return {
    content: [
      {
        type: 'text',
        text: `**PROJECT NOT IN SYNTHESIS HUB**

The query "${query}" did not match any registered project.

**ASK THE USER NOW:** "Would you like to add this project to Synthesis for context tracking?"

If YES: Call synthesis_start again with register_if_new: true
If NO: Continue without Synthesis (no tracking/checkpoints)

---
Registered projects: ${index.projects.map((p) => p.name).join(', ') || 'None'}`,
      },
    ],
  }
}

async function handleSynthesisCheckpoint(params: {
  project_id: string
  summary: string
  files_changed?: string[]
  completed_steps?: number[]
  add_next_step?: string
  details?: string
}): Promise<{ content: Array<{ type: string; text: string }> }> {
  const { project_id, summary, files_changed = [], details } = params
  const synthesisHome = getSynthesisHome()
  const today = getToday()

  // Sanitize project ID to prevent path traversal
  const safeProjectId = sanitizeProjectId(project_id)

  const contextPath = path.join(synthesisHome, 'tracking', safeProjectId, 'CONTEXT.md')
  verifyPathWithinHome(contextPath, synthesisHome)

  if (!fs.existsSync(contextPath)) {
    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify({ success: false, error: `Project not found: ${safeProjectId}. Call synthesis_start first.` }),
        },
      ],
    }
  }

  // Create work-log with sanitized paths
  const workLogsDir = path.join(synthesisHome, 'tracking', safeProjectId, 'work-logs')
  verifyPathWithinHome(workLogsDir, synthesisHome)
  ensureDir(workLogsDir)

  const slug = slugify(summary.substring(0, 30))
  const safeSlug = sanitizeFilename(slug || 'checkpoint')
  const worklogFilename = `${today}-${safeSlug}.md`
  const safeWorklogFilename = sanitizeFilename(worklogFilename)

  const worklogContent = `# ${summary}

**Date:** ${today}
**Project:** ${safeProjectId}

---

## Summary
${details || summary}

${files_changed.length > 0 ? '## Files Changed\n' + files_changed.map((f) => `- \`${f}\``).join('\n') : ''}

## What Remains
*See CONTEXT.md Next Steps*
`
  const worklogPath = path.join(workLogsDir, safeWorklogFilename)
  verifyPathWithinHome(worklogPath, synthesisHome)
  fs.writeFileSync(worklogPath, worklogContent)

  // Update CONTEXT.md Session History
  let content = fs.readFileSync(contextPath, 'utf-8')
  const sessionRegex = /(## Session History\n\| Date \| Summary \|\n\|---\|---\|\n)/
  if (sessionRegex.test(content)) {
    content = content.replace(sessionRegex, `$1| ${today} | ${summary} |\n`)
    fs.writeFileSync(contextPath, content)
  }

  return {
    content: [
      {
        type: 'text',
        text: JSON.stringify(
          {
            success: true,
            project_id: safeProjectId,
            summary,
            worklog_created: safeWorklogFilename,
            _instructions:
              '\n**CHECKPOINT PROTOCOL:**\n1. Work-log created automatically\n2. CONTEXT.md updated\n3. Continue with remaining Next Steps\n',
          },
          null,
          2
        ),
      },
    ],
  }
}

async function handleSynthesisLesson(params: {
  project_id: string
  type: 'incident' | 'pattern'
  title: string
  what_happened: string
  solution: string
  keywords?: string[]
}): Promise<{ content: Array<{ type: string; text: string }> }> {
  const { project_id, type, title, what_happened, solution, keywords = [] } = params
  const synthesisHome = getSynthesisHome()
  const today = getToday()

  // Sanitize project ID
  const safeProjectId = sanitizeProjectId(project_id)

  const lessonsDir = path.join(synthesisHome, '_lessons')
  verifyPathWithinHome(lessonsDir, synthesisHome)
  ensureDir(lessonsDir)

  const lessonSlug = slugify(title.substring(0, 40))
  const safeLessonSlug = sanitizeFilename(lessonSlug || 'lesson')
  const lessonFilename = sanitizeFilename(`${today}-${safeLessonSlug}.md`)

  let lessonContent = ''
  if (type === 'incident') {
    lessonContent = `---
type: incident
title: ${title}
project: ${safeProjectId}
date: ${today}
keywords: [${keywords.map((k) => `"${k}"`).join(', ')}]
---

# ${title}

## What Happened
${what_happened}

## Solution / Root Cause
${solution}

## Prevention
*How to avoid this in the future*
`
  } else {
    lessonContent = `---
type: pattern
title: ${title}
project: ${safeProjectId}
date: ${today}
keywords: [${keywords.map((k) => `"${k}"`).join(', ')}]
---

# ${title}

## Context
${what_happened}

## Solution / Technique
${solution}

## When to Use
*When does this pattern apply?*
`
  }

  const lessonPath = path.join(lessonsDir, lessonFilename)
  verifyPathWithinHome(lessonPath, synthesisHome)
  fs.writeFileSync(lessonPath, lessonContent)

  return {
    content: [
      {
        type: 'text',
        text: JSON.stringify(
          {
            success: true,
            project_id: safeProjectId,
            type,
            title,
            lesson_file: lessonFilename,
            _message: 'Lesson saved. This will be surfaced in future sessions when relevant.',
          },
          null,
          2
        ),
      },
    ],
  }
}

async function handleSynthesisSearch(params: {
  keywords: string[]
  error_message?: string
}): Promise<{ content: Array<{ type: string; text: string }> }> {
  const { keywords, error_message } = params
  const synthesisHome = getSynthesisHome()
  const lessonsDir = path.join(synthesisHome, '_lessons')

  if (!fs.existsSync(lessonsDir)) {
    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify({ success: true, matches: [], message: 'No lessons found.' }),
        },
      ],
    }
  }

  const files = fs.readdirSync(lessonsDir).filter((f) => f.endsWith('.md'))
  const searchTerms = keywords.map((k) => k.toLowerCase())
  if (error_message) {
    searchTerms.push(
      ...error_message
        .toLowerCase()
        .split(/\s+/)
        .filter((w) => w.length > 3)
        .slice(0, 5)
    )
  }

  const matches: Array<{ file: string; title: string; score: number; preview: string }> = []

  for (const file of files) {
    // Sanitize filename before constructing path
    const safeFilename = sanitizeFilename(file)
    const filePath = path.join(lessonsDir, safeFilename)
    verifyPathWithinHome(filePath, synthesisHome)

    if (!fs.existsSync(filePath)) continue

    const content = fs.readFileSync(filePath, 'utf-8')
    const contentLower = content.toLowerCase()

    let score = 0
    for (const term of searchTerms) {
      if (contentLower.includes(term)) score += 1
    }

    if (score > 0) {
      const titleMatch = content.match(/^#\s+(.+)$/m)
      matches.push({
        file: safeFilename,
        title: titleMatch?.[1] ?? safeFilename,
        score,
        preview: content.substring(0, 200) + '...',
      })
    }
  }

  matches.sort((a, b) => b.score - a.score)

  return {
    content: [
      {
        type: 'text',
        text: JSON.stringify(
          {
            success: true,
            search_terms: searchTerms,
            matches: matches.slice(0, 5),
            message: matches.length > 0 ? `Found ${matches.length} relevant lesson(s).` : 'No matching lessons found.',
          },
          null,
          2
        ),
      },
    ],
  }
}

// ============================================================================
// Server Creation
// ============================================================================

function createServerInstance() {
  const server = new Server(
    {
      name: 'Synthesis MCP',
      version: '1.0.0',
    },
    {
      capabilities: {
        tools: {},
        logging: {},
      },
      instructions: `Synthesis Protocol: Use synthesis_start at session start, synthesis_checkpoint after work, synthesis_lesson when you learn something, synthesis_search when stuck.`,
    }
  )

  // Register tool handlers
  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: [synthesisStartTool, synthesisCheckpointTool, synthesisLessonTool, synthesisSearchTool],
  }))

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args } = request.params

    switch (name) {
      case 'synthesis_start':
        return handleSynthesisStart(args as Parameters<typeof handleSynthesisStart>[0])
      case 'synthesis_checkpoint':
        return handleSynthesisCheckpoint(args as Parameters<typeof handleSynthesisCheckpoint>[0])
      case 'synthesis_lesson':
        return handleSynthesisLesson(args as Parameters<typeof handleSynthesisLesson>[0])
      case 'synthesis_search':
        return handleSynthesisSearch(args as Parameters<typeof handleSynthesisSearch>[0])
      default:
        throw new McpError(ErrorCode.MethodNotFound, `Unknown tool: ${name}`)
    }
  })

  server.onerror = (error: unknown) => {
    console.error('[Synthesis MCP] Error:', error)
  }

  return server
}

// ============================================================================
// Main Entry Point
// ============================================================================

async function main() {
  if (TRANSPORT_TYPE === 'http') {
    const httpServer = createServer(async (req, res) => {
      const url = new URL(req.url || '', `http://${req.headers.host}`).pathname

      // CORS headers
      res.setHeader('Access-Control-Allow-Origin', '*')
      res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS,DELETE')
      res.setHeader('Access-Control-Allow-Headers', 'Content-Type, MCP-Session-Id')

      if (req.method === 'OPTIONS') {
        res.writeHead(200)
        res.end()
        return
      }

      if (url === '/mcp' && req.method === 'POST') {
        const chunks: Buffer[] = []
        for await (const chunk of req) {
          chunks.push(chunk)
        }
        const body = JSON.parse(Buffer.concat(chunks).toString())
        const sessionId = req.headers['mcp-session-id'] as string | undefined

        let transport: StreamableHTTPServerTransport

        if (sessionId && transports[sessionId]) {
          transport = transports[sessionId]
        } else if (!sessionId && isInitializeRequest(body)) {
          transport = new StreamableHTTPServerTransport({
            sessionIdGenerator: () => randomUUID(),
            enableJsonResponse: true,
            onsessioninitialized: (newSessionId) => {
              transports[newSessionId] = transport
              const server = createServerInstance()
              servers[newSessionId] = server
              server.connect(transport).catch(console.error)
            },
          })

          transport.onclose = () => {
            if (transport.sessionId) {
              delete transports[transport.sessionId]
              delete servers[transport.sessionId]
            }
          }
        } else {
          res.writeHead(400, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify({ error: 'Invalid session' }))
          return
        }

        await transport.handleRequest(req, res, body)
      } else if (url === '/health') {
        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ status: 'ok', server: 'Synthesis MCP', version: '1.0.0' }))
      } else {
        res.writeHead(404)
        res.end('Not found')
      }
    })

    httpServer.listen(HTTP_PORT, () => {
      console.error(`Synthesis MCP Server running on HTTP at http://localhost:${HTTP_PORT}/mcp`)
    })
  } else {
    // Stdio transport
    const server = createServerInstance()
    const transport = new StdioServerTransport()
    await server.connect(transport)
    console.error('Synthesis MCP Server running on stdio')
  }
}

process.on('SIGINT', () => {
  process.exit(0)
})

main().catch((error) => {
  console.error('Fatal error:', error)
  process.exit(1)
})

export default function () {
  return createServerInstance()
}
