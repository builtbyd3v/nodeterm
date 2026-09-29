// Cursor Agent CLI's conversation as the ⌘M panel's structured messages, plus the locator and the
// read-only store reader behind it.
//
// Where it lives (MEASURED on cursor-agent 2026.09.23 and 2026.09.28, macOS): the CLI keeps each
// chat in `<config>/chats/<md5(cwd)>/<chatId>/store.db`, where `<config>` is `$CURSOR_CONFIG_DIR`,
// else `$XDG_CONFIG_HOME/cursor`, else `~/.cursor` (the CLI's own `cursor-config` paths module), and
// `md5(cwd)` hashes the PHYSICAL cwd. `<chatId>` is a UUID and is the id `cursor-agent --resume` takes
// and the stream-json `session_id`. It is a SQLite database (WAL mode), read here with the built-in
// `node:sqlite` (Electron 42 ships Node 24; the repo's `engines` floor already has it), READ-ONLY:
//   meta   (key '0') = hex(utf8 JSON) {agentId, latestRootBlobId (hex), name, mode, createdAt, …}
//   blobs  (id = sha256 hex, data) content-addressed. The ROOT blob (`latestRootBlobId`) is protobuf
//          (`ConversationStateStructure`); its field 1, repeated, is the ordered list of 32-byte ids of
//          the model-context MESSAGES, each a JSON blob in the AI-SDK shape:
//   system     {role, content: string}
//   user       {role, content: string}  harness context (`<user_info>`, rules, skills), never typed; or
//              {role, content: [{type:'text', text}]} whose typed prompt is `<user_query>…</user_query>`
//              beside `<timestamp>` / `<system_reminder>` parts
//   assistant  {role, content: [reasoning | redacted-reasoning | text | tool-call {toolCallId,
//              toolName, args}], id}; `providerOptions.cursor.modelName` rides its reasoning parts
//   tool       {role, content: [{type:'tool-result', toolCallId, toolName, result, experimental_content}]}
// The `~/.cursor/projects/<slug>/agent-transcripts/<id>/<id>.jsonl` file the CLI ALSO writes is NOT
// used: measured, its text parts read `[REDACTED]`, it has no tool results, and it lost the user line
// of a failed turn. The store is the whole conversation.
//
// Never a cwd fallback: a chat is found ONLY by its whole-UUID id. The cwd merely picks the bucket to
// look in first. Compaction replaces the model's context, so older turns are not in the root's message
// list; they are not shown (grok has the same limit).
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import crypto from 'node:crypto'
import type { ChatMessage, ChatPart, ChatTranscriptResult } from '../shared/types'
import { CHAT_TOOL_ARG_MAX } from '../shared/chat-command'
import { CHAT_PAGE_MAX_BYTES, type ChatTranscriptPage } from '../shared/chat-page'
import { metaString, summarizeResult } from './transcript-reader'
import { opencodePageMessages } from './opencode-chat'

type ToolPart = Extract<ChatPart, { kind: 'tool' }>
type Obj = Record<string, unknown>
const isObj = (v: unknown): v is Obj => !!v && typeof v === 'object' && !Array.isArray(v)

// ── Pure parsing ────────────────────────────────────────────────────────────────────────────────

/** The text a person typed in one user-message part, or undefined when the part is not a prompt
 *  (`<timestamp>`, `<system_reminder>`, injected context). Exactly one wrapper newline is dropped. */
export function cursorUserText(text: string): string | undefined {
  const open = text.indexOf('<user_query>')
  if (open < 0) return undefined
  const start = open + '<user_query>'.length
  const end = text.lastIndexOf('</user_query>')
  if (end < start) return undefined
  const t = text.slice(start, end).replace(/^\n/, '').replace(/\n$/, '')
  return t.trim() ? t : undefined
}

/** Salient argument keys, in priority order (`pattern` before `path`: a grep's meaning is its pattern). */
const ARG_KEYS = ['command', 'pattern', 'glob_pattern', 'path', 'target_directory', 'target_notebook', 'query', 'search_term', 'url', 'description', 'prompt']

export function cursorToolArg(args: unknown): string {
  if (typeof args === 'string') return args.slice(0, CHAT_TOOL_ARG_MAX)
  if (!isObj(args)) return ''
  for (const k of ARG_KEYS) {
    const v = args[k]
    if (typeof v === 'string' && v) return v.slice(0, CHAT_TOOL_ARG_MAX)
  }
  const raw = JSON.stringify(args)
  return raw === '{}' ? '' : raw.slice(0, CHAT_TOOL_ARG_MAX)
}

function resultText(p: Obj): string {
  if (typeof p.result === 'string') return p.result
  if (Array.isArray(p.experimental_content)) {
    return p.experimental_content.map((c) => (isObj(c) && typeof c.text === 'string' ? c.text : '')).filter(Boolean).join('\n')
  }
  return p.result === undefined ? '' : JSON.stringify(p.result)
}

/** Shell results wrap their output in an envelope ("Exit code: 0 / Command output: / ```…```"), and
 *  search results in `<workspace_result>`; a chip wants the payload, not the envelope. */
function unwrapResult(text: string): string {
  const sh = /^Exit code: (-?\d+)\n\nCommand output:\n\n```\n([\s\S]*?)\n*```/.exec(text)
  if (sh) return sh[1] === '0' ? sh[2] : `Exit code ${sh[1]}\n${sh[2]}`
  const ws = /^<workspace_result[^>]*>\n?([\s\S]*?)\n?<\/workspace_result>\s*$/.exec(text)
  return ws ? ws[1] : text
}

export interface CursorChatParse {
  messages: ChatMessage[]
  /** The newest assistant message's `providerOptions.cursor.modelName` (absent when it states none). */
  model?: string
  /** Messages/parts this reader could not map. Diagnostic only, never on the wire. */
  skipped: number
}

/** Ordered message objects (from the store, in order) → bubbles. */
export function parseCursorChat(raw: readonly unknown[]): CursorChatParse {
  const messages: ChatMessage[] = []
  const toolById = new Map<string, ToolPart>()
  let skipped = 0
  let lastAssistant: Obj | undefined
  for (const m of raw) {
    if (!isObj(m)) {
      skipped++
      continue
    }
    const parts: unknown[] = Array.isArray(m.content) ? m.content : []
    switch (m.role) {
      case 'system':
        break
      case 'user': {
        // A string user message is harness context, never typed. Typed text is a `<user_query>`.
        const texts: ChatPart[] = []
        for (const p of parts) {
          const t = isObj(p) && p.type === 'text' && typeof p.text === 'string' ? cursorUserText(p.text) : undefined
          if (t !== undefined) texts.push({ kind: 'text', text: t })
        }
        if (texts.length) messages.push({ role: 'user', parts: texts })
        break
      }
      case 'assistant': {
        lastAssistant = m
        const out: ChatPart[] = []
        if (typeof m.content === 'string' && m.content.trim()) out.push({ kind: 'text', text: m.content })
        for (const p of parts) {
          if (!isObj(p)) {
            skipped++
            continue
          }
          if (p.type === 'text') {
            if (typeof p.text === 'string' && p.text.trim()) out.push({ kind: 'text', text: p.text })
          } else if (p.type === 'tool-call') {
            const tool: ToolPart = { kind: 'tool', name: typeof p.toolName === 'string' && p.toolName ? p.toolName : 'tool', arg: cursorToolArg(p.args) }
            out.push(tool)
            if (typeof p.toolCallId === 'string') toolById.set(p.toolCallId, tool)
          } else if (p.type !== 'reasoning' && p.type !== 'redacted-reasoning') {
            skipped++
          }
        }
        if (out.length) messages.push({ role: 'assistant', parts: out })
        break
      }
      case 'tool':
        for (const p of parts) {
          if (!isObj(p) || p.type !== 'tool-result') {
            skipped++
            continue
          }
          // An orphan result (its call is outside the window) is dropped, like every other reader.
          const tool = typeof p.toolCallId === 'string' ? toolById.get(p.toolCallId) : undefined
          const s = tool ? summarizeResult(unwrapResult(resultText(p))) : ''
          if (tool && s) tool.result = s
        }
        break
      default:
        skipped++
    }
  }
  const out: CursorChatParse = { messages, skipped }
  const modelOf = (a: Obj | undefined): string | undefined => {
    for (const p of Array.isArray(a?.content) ? (a.content as unknown[]) : []) {
      const cur = isObj(p) && isObj(p.providerOptions) ? p.providerOptions.cursor : undefined
      const name = isObj(cur) ? metaString(cur.modelName) : undefined
      if (name) return name
    }
    return undefined
  }
  const model = modelOf(lastAssistant)
  if (model !== undefined) out.model = model
  return out
}

/** Newline-delimited JSON of message objects — the raw transcript text Context Link and the handoff
 *  exchange, so cursor fits the same "text in, lines out" shape as every other agent. */
export function parseCursorNdjson(raw: string): unknown[] {
  const out: unknown[] = []
  for (const l of raw.split('\n')) {
    if (!l.trim()) continue
    try {
      out.push(JSON.parse(l))
    } catch {
      /* a partial line: dropped */
    }
  }
  return out
}

/** Context Link's display lines (`user: …`, `assistant: …`, `  $ tool arg`, `  = result`). */
export function linesFromCursor(raw: string): string[] {
  const res: string[] = []
  for (const m of parseCursorChat(parseCursorNdjson(raw)).messages) {
    for (const p of m.parts) {
      if (p.kind === 'text') res.push(`${m.role}: ${p.text}`)
      else if (p.kind === 'tool') {
        res.push(`  $ ${p.name}${p.arg ? ` ${p.arg}` : ''}`)
        if (p.result) res.push(`  = ${p.result}`)
      }
    }
  }
  return res
}

// ── Locating the store ──────────────────────────────────────────────────────────────────────────

/** A whole UUID: cursor's chat ids. A suffix or prefix of one must never match another chat. */
export const CURSOR_CHAT_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/** The CLI's own config-dir rule (`cursor-config` paths): CURSOR_CONFIG_DIR, XDG_CONFIG_HOME/cursor, ~/.cursor. */
export function cursorConfigDir(env: NodeJS.ProcessEnv = process.env, home: string = os.homedir()): string {
  if (env.CURSOR_CONFIG_DIR?.trim()) return env.CURSOR_CONFIG_DIR
  if (env.XDG_CONFIG_HOME?.trim()) return path.join(env.XDG_CONFIG_HOME, 'cursor')
  return path.join(home, '.cursor')
}

const md5 = (s: string): string => crypto.createHash('md5').update(s).digest('hex')

// A hit is cached per id (a store never moves); a miss is not, since the chat may not exist yet.
const storeCache = new Map<string, string>()

/**
 * `<chats>/<bucket>/<chatId>/store.db` for ONE chat id, or undefined. `cwd` only orders the search
 * (its md5 bucket, physical and as written, first); every bucket is then tried, because the id alone
 * is the identity and the phone path carries no cwd. No id, or one that is not a whole UUID, is a miss.
 */
export async function locateCursorChat(chatId: string | undefined, cwd?: string): Promise<string | undefined> {
  if (!chatId || !CURSOR_CHAT_ID_RE.test(chatId)) return undefined
  const cached = storeCache.get(chatId)
  if (cached) {
    try {
      if ((await fs.promises.stat(cached)).isFile()) return cached
    } catch {
      storeCache.delete(chatId)
    }
  }
  const chats = path.join(cursorConfigDir(), 'chats')
  const buckets: string[] = []
  if (cwd) {
    buckets.push(md5(path.resolve(cwd)))
    try {
      buckets.push(md5(await fs.promises.realpath(cwd)))
    } catch {
      /* no such cwd */
    }
  }
  try {
    buckets.push(...(await fs.promises.readdir(chats)))
  } catch {
    return undefined
  }
  for (const b of new Set(buckets)) {
    const p = path.join(chats, b, chatId, 'store.db')
    try {
      if ((await fs.promises.stat(p)).isFile()) {
        storeCache.set(chatId, p)
        return p
      }
    } catch {
      /* not in this bucket */
    }
  }
  return undefined
}

// ── Reading the store (read-only) ───────────────────────────────────────────────────────────────

/** Raw JSON bytes of message blobs read per call, newest first. ponytail: a chat past this shows only
 *  its newest part; a ranged/paged store read if anyone needs deeper history. */
export const CURSOR_READ_MAX_BYTES = 16 * 1024 * 1024
const DEFAULT_TITLE = 'New Agent'

/** The ids in the root blob's field 1 (`root_prompt_messages_json`, repeated bytes), in order. */
export function rootMessageIds(buf: Uint8Array): string[] | null {
  const ids: string[] = []
  let i = 0
  const varint = (): number | null => {
    let r = 0
    // up to 10 bytes: the root carries a 41-bit ms timestamp
    for (let s = 0; s < 70; s += 7) {
      if (i >= buf.length) return null
      const c = buf[i++]
      r += (c & 0x7f) * 2 ** s
      if (c < 0x80) return r
    }
    return null
  }
  while (i < buf.length) {
    const tag = varint()
    if (tag === null) return null
    const wire = tag & 7
    if (wire === 0) {
      if (varint() === null) return null
    } else if (wire === 1 || wire === 5) i += wire === 1 ? 8 : 4
    else if (wire === 2) {
      const len = varint()
      if (len === null || i + len > buf.length) return null
      if (tag >>> 3 === 1 && len === 32) ids.push(Buffer.from(buf.subarray(i, i + len)).toString('hex'))
      i += len
    } else return null
  }
  return ids
}

export interface CursorStore {
  /** Message objects, oldest first. */
  messages: unknown[]
  /** The chat's own name; undefined until cursor names it (its default is "New Agent"). */
  title?: string
}

const asText = (d: unknown): string => (typeof d === 'string' ? d : Buffer.from(d as Uint8Array).toString('utf8'))

/** One consistent read of a store; null when it cannot be read (no node:sqlite, locked, corrupt). */
export async function readCursorStore(dbPath: string, maxBytes: number = CURSOR_READ_MAX_BYTES): Promise<CursorStore | null> {
  let db: import('node:sqlite').DatabaseSync | undefined
  try {
    const { DatabaseSync } = await import('node:sqlite')
    db = new DatabaseSync(dbPath, { readOnly: true, timeout: 2000 })
    db.exec('BEGIN')
    const row = db.prepare("SELECT value FROM meta WHERE key = '0'").get() as { value?: string } | undefined
    const meta: unknown = row?.value ? JSON.parse(Buffer.from(row.value, 'hex').toString('utf8')) : {}
    const m = isObj(meta) ? meta : {}
    const name = typeof m.name === 'string' ? m.name.trim() : ''
    const store: CursorStore = { messages: [] }
    if (name && name !== DEFAULT_TITLE) store.title = name.slice(0, 200)
    const rootId = typeof m.latestRootBlobId === 'string' ? m.latestRootBlobId : ''
    if (!rootId || maxBytes <= 0) return store // maxBytes 0 = the name alone
    const blob = db.prepare('SELECT data FROM blobs WHERE id = ?')
    const size = db.prepare('SELECT length(data) AS n FROM blobs WHERE id = ?')
    const root = blob.get(rootId) as { data?: Uint8Array } | undefined
    const ids = root?.data ? rootMessageIds(root.data) : null
    if (!ids) return null
    let total = 0
    const newestFirst: unknown[] = []
    for (let k = ids.length - 1; k >= 0; k--) {
      const n = (size.get(ids[k]) as { n?: number } | undefined)?.n
      if (n === undefined) continue // a message this machine does not hold
      if (total + n > maxBytes && newestFirst.length) break
      total += n
      try {
        newestFirst.push(JSON.parse(asText((blob.get(ids[k]) as { data: unknown }).data)))
      } catch {
        /* not a JSON message blob */
      }
    }
    store.messages = newestFirst.reverse()
    return store
  } catch {
    return null
  } finally {
    try {
      db?.close()
    } catch {
      /* already closed */
    }
  }
}

/** The transcript text Context Link and the handoff read: one message per line, without the fields
 *  that only bloat it (`providerOptions` carries encrypted reasoning, `experimental_content` repeats `result`). */
export async function cursorTranscriptText(dbPath: string): Promise<string | null> {
  const s = await readCursorStore(dbPath)
  if (!s) return null
  return s.messages
    .map((m) => {
      if (!isObj(m)) return ''
      const { providerOptions: _p, ...rest } = m
      if (Array.isArray(rest.content)) {
        rest.content = rest.content
          .filter((c) => !(isObj(c) && (c.type === 'reasoning' || c.type === 'redacted-reasoning')))
          .map((c) => {
            if (!isObj(c)) return c
            const { providerOptions: _q, experimental_content: _e, ...keep } = c
            return keep
          })
      }
      return JSON.stringify(rest)
    })
    .filter(Boolean)
    .join('\n')
}

/** The session's own name for `TITLE_READ_CAPABLE`, or null. By id only, local only: a remote node's
 *  chat is on its host, and a whole-UUID id cannot name a chat on this machine by accident. */
export async function readCursorSessionName(sessionId: string): Promise<string | null> {
  const p = await locateCursorChat(sessionId)
  if (!p) return null
  return (await readCursorStore(p, 0))?.title ?? null
}

/**
 * `chat:read-transcript` for a cursor node. Refusals: a REMOTE node is refused before anything is
 * read (its chat is in the HOST's store; there is no remote leg yet), and a local failure is a
 * plain not-found like copilot's, so `unreadable` can only mean "remote" (`CHAT_LOCAL_ONLY`). One
 * page always (`olderCursor: null`): a store has no byte offsets to page by.
 */
export async function readCursorChat(
  q: { sessionId?: string; cwd?: string; remoteOnly?: boolean },
  page: ChatTranscriptPage | null
): Promise<ChatTranscriptResult> {
  const notFound = (): ChatTranscriptResult =>
    page ? { messages: [], found: false, olderCursor: null, unmatchedResults: [] } : { messages: [], found: false }
  if (q.remoteOnly) return page ? { ...notFound(), unreadable: true } : notFound()
  if (page && page.before !== null) return { messages: [], found: true, olderCursor: null, unmatchedResults: [] }
  const p = await locateCursorChat(q.sessionId, q.cwd)
  if (!p) return notFound()
  // ponytail: no change gate/cache (opencode's export needs one at 1.5 s; this read is milliseconds).
  const store = await readCursorStore(p)
  if (!store) return notFound()
  const parsed = parseCursorChat(store.messages)
  const messages = opencodePageMessages(parsed.messages, page ? page.maxBytes : CHAT_PAGE_MAX_BYTES)
  if (!page) return { messages, found: true }
  return { messages, found: true, olderCursor: null, unmatchedResults: [], ...(parsed.model !== undefined ? { model: parsed.model } : {}) }
}
