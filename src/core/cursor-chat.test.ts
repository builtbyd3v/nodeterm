// Fixture-driven tests for core/cursor-chat.ts. The stores are SYNTHESIZED here (no private chat is
// committed): `buildStore` writes the layout measured on cursor-agent 2026.09.23/.28 — meta key '0'
// = hex(JSON), sha256-addressed blobs, a protobuf root whose field 1 lists the message blob ids —
// with message shapes copied from a real chat that ran `echo` and a Write/Read/Grep turn.
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { DatabaseSync as Db } from 'node:sqlite'
import {
  cursorConfigDir,
  cursorTranscriptText,
  cursorUserText,
  linesFromCursor,
  locateCursorChat,
  parseCursorChat,
  readCursorChat,
  readCursorSessionName,
  readCursorStore,
  rootMessageIds
} from './cursor-chat'

const ID = '5667590a-e4c7-4f28-9d99-027f84c10837'
const OTHER = 'aaaaaaaa-e4c7-4f28-9d99-027f84c10837'
const CTX = '<user_info>\nOS Version: darwin\n</user_info>\n<rules>secret-rule-text</rules>'
const userMsg = (q: string) => ({
  role: 'user',
  content: [{ type: 'text', text: `<timestamp>Monday, Sep 28, 2026, 9:25 PM (UTC-4)</timestamp>\n<user_query>\n${q}\n</user_query>` }]
})
const reasoning = { type: 'redacted-reasoning', data: 'ENCRYPTED', providerOptions: { cursor: { modelName: 'composer-2.5-fast' } } }
const MESSAGES: unknown[] = [
  { role: 'system', content: 'SYSTEM PROMPT' },
  { role: 'user', content: CTX },
  userMsg('Run echo and tell me the word.'),
  {
    role: 'assistant',
    content: [reasoning, { type: 'tool-call', toolCallId: 't1', toolName: 'Shell', args: { command: 'echo fixture-ok', description: 'echo' } }],
    id: '1'
  },
  {
    role: 'tool',
    content: [
      {
        type: 'tool-result',
        toolCallId: 't1',
        toolName: 'Shell',
        result: 'Exit code: 0\n\nCommand output:\n\n```\nfixture-ok\n\n```\n\nCommand completed in 9 ms.\n\nShell state persists.',
        experimental_content: [{ type: 'text', text: 'dup' }]
      }
    ],
    id: 't1'
  },
  { role: 'assistant', content: [reasoning, { type: 'text', text: 'done' }], id: '1' },
  userMsg('Now write, read and grep a file.'),
  {
    role: 'assistant',
    content: [
      reasoning,
      { type: 'tool-call', toolCallId: 't2', toolName: 'Write', args: { path: '/w/hello.txt', contents: 'hi' } },
      { type: 'tool-call', toolCallId: 't3', toolName: 'Grep', args: { pattern: 'hi', path: '/w/hello.txt' } },
      { type: 'tool-call', toolCallId: 't4', toolName: 'Read', args: { path: '/w/missing.txt' } }
    ],
    id: '1'
  },
  { role: 'tool', content: [{ type: 'tool-result', toolCallId: 't2', toolName: 'Write', result: 'Wrote contents to /w/hello.txt' }], id: 't2' },
  {
    role: 'tool',
    content: [{ type: 'tool-result', toolCallId: 't3', toolName: 'Grep', result: '<workspace_result workspace_path="/w">\nhello.txt\n  1:hi\n</workspace_result>' }],
    id: 't3'
  },
  { role: 'tool', content: [{ type: 'tool-result', toolCallId: 't4', toolName: 'Read', result: 'Error: File not found' }], id: 't4' },
  { role: 'assistant', content: [{ type: 'text', text: 'Read failed, the rest worked.' }], id: '1' }
]

let Database: typeof Db
let root: string
let prevConfig: string | undefined

function varint(n: number): number[] {
  const out: number[] = []
  while (n >= 0x80) {
    out.push((n & 0x7f) | 0x80)
    n = Math.floor(n / 128)
  }
  return [...out, n]
}

/** `<root>/chats/<bucket>/<id>/store.db` with `messages` as the root's ordered field 1. */
function buildStore(bucket: string, id: string, messages: unknown[], name = 'New Agent', withRoot = true): string {
  const dir = path.join(root, 'chats', bucket, id)
  fs.mkdirSync(dir, { recursive: true })
  const file = path.join(dir, 'store.db')
  const db = new Database(file)
  db.exec('PRAGMA journal_mode = WAL; CREATE TABLE blobs (id TEXT PRIMARY KEY, data BLOB); CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT);')
  const put = db.prepare('INSERT INTO blobs (id, data) VALUES (?, ?)')
  const ids = messages.map((m) => {
    const data = Buffer.from(JSON.stringify(m))
    const h = crypto.createHash('sha256').update(data).digest('hex')
    put.run(h, data)
    return h
  })
  // Field 1 per message, then the noise a real root carries (5: token details, 9: a string, 26: a varint).
  const bytes: number[] = []
  for (const h of ids) bytes.push(0x0a, 0x20, ...Buffer.from(h, 'hex'))
  bytes.push(0x2a, 0x04, 0x08, 0x01, 0x10, 0x02, 0x4a, 0x03, 0x61, 0x62, 0x63, 0xd0, 0x01, ...varint(1790645113982))
  const rootData = Buffer.from(bytes)
  const rootId = crypto.createHash('sha256').update(rootData).digest('hex')
  put.run(rootId, rootData)
  const meta = { agentId: id, latestRootBlobId: withRoot ? rootId : '', name, mode: 'default', createdAt: 1 }
  db.prepare("INSERT INTO meta (key, value) VALUES ('0', ?)").run(Buffer.from(JSON.stringify(meta)).toString('hex'))
  db.close()
  return file
}

beforeAll(async () => {
  ;({ DatabaseSync: Database } = await import('node:sqlite'))
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'cursor-chat-'))
  prevConfig = process.env.CURSOR_CONFIG_DIR
  process.env.CURSOR_CONFIG_DIR = root
})
afterAll(() => {
  if (prevConfig === undefined) delete process.env.CURSOR_CONFIG_DIR
  else process.env.CURSOR_CONFIG_DIR = prevConfig
  fs.rmSync(root, { recursive: true, force: true })
})

describe('parseCursorChat', () => {
  const parsed = parseCursorChat(MESSAGES)
  it('shows typed prompts only: never the system prompt or injected context', () => {
    const users = parsed.messages.filter((m) => m.role === 'user').map((m) => m.parts)
    expect(users).toEqual([[{ kind: 'text', text: 'Run echo and tell me the word.' }], [{ kind: 'text', text: 'Now write, read and grep a file.' }]])
    const all = JSON.stringify(parsed.messages)
    for (const leak of ['SYSTEM PROMPT', 'secret-rule-text', '<user_query>', '<timestamp>', 'ENCRYPTED']) expect(all).not.toContain(leak)
  })
  it('attaches each result to its call, unwrapping the shell and search envelopes', () => {
    const tools = parsed.messages.flatMap((m) => m.parts).filter((p) => p.kind === 'tool')
    expect(tools.map((t) => [t.name, t.arg, t.result])).toEqual([
      ['Shell', 'echo fixture-ok', 'fixture-ok'],
      ['Write', '/w/hello.txt', 'Wrote contents to /w/hello.txt'],
      ['Grep', 'hi', 'hello.txt   1:hi'],
      ['Read', '/w/missing.txt', 'Error: File not found']
    ])
  })
  it('keeps assistant text, drops reasoning-only turns, and reports the newest model when stated', () => {
    expect(parsed.messages.filter((m) => m.role === 'assistant').flatMap((m) => m.parts).filter((p) => p.kind === 'text')).toHaveLength(2)
    // the newest assistant message states no model: absent, never carried from an older one
    expect(parsed.model).toBeUndefined()
    expect(parseCursorChat(MESSAGES.slice(0, 6)).model).toBe('composer-2.5-fast')
  })
  it('drops an orphan result and counts what it cannot map', () => {
    const p = parseCursorChat([{ role: 'tool', content: [{ type: 'tool-result', toolCallId: 'gone', result: 'x' }] }, 42, { role: 'weird' }])
    expect(p.messages).toEqual([])
    expect(p.skipped).toBe(2)
  })
  it('extracts the typed text from a user_query part only', () => {
    expect(cursorUserText('<timestamp>t</timestamp>\n<user_query>\nhi\nthere\n</user_query>')).toBe('hi\nthere')
    expect(cursorUserText('<system_reminder>x</system_reminder>')).toBeUndefined()
    expect(cursorUserText('<user_query>\n \n</user_query>')).toBeUndefined()
  })
})

describe('the store reader', () => {
  it('reads messages in order, the title, and rejects a malformed root', async () => {
    const file = buildStore('b1', ID, MESSAGES, 'Fixture chat')
    const s = await readCursorStore(file)
    expect(s?.title).toBe('Fixture chat')
    expect(s?.messages).toEqual(MESSAGES)
    expect(rootMessageIds(new Uint8Array([0x0a, 0x20, 1, 2]))).toBeNull() // truncated length-delimited field
  })
  it('treats the default name as no title and an empty root as an empty conversation', async () => {
    const file = buildStore('b-empty', OTHER, [], 'New Agent', false)
    expect(await readCursorStore(file)).toEqual({ messages: [] })
  })
  it('keeps the newest messages when the byte budget is exceeded', async () => {
    const file = buildStore('b-big', '11111111-e4c7-4f28-9d99-027f84c10837', [userMsg('old'), userMsg('mid'), userMsg('new')])
    const one = JSON.stringify(userMsg('new')).length
    const s = await readCursorStore(file, one + 5)
    expect(s?.messages).toEqual([userMsg('new')])
  })
  it('returns null for a file that is not a store, and never writes to a real one', async () => {
    const junk = path.join(root, 'junk.db')
    fs.writeFileSync(junk, 'not sqlite')
    expect(await readCursorStore(junk)).toBeNull()
    const file = path.join(root, 'chats', 'b1', ID, 'store.db')
    const before = fs.statSync(file).mtimeMs
    await readCursorStore(file)
    expect(fs.statSync(file).mtimeMs).toBe(before)
  })
})

describe('locateCursorChat', () => {
  it('finds a chat by its whole-UUID id, with or without the cwd bucket', async () => {
    const cwd = '/some/work/dir'
    const file = buildStore(crypto.createHash('md5').update(cwd).digest('hex'), '22222222-e4c7-4f28-9d99-027f84c10837', [])
    expect(await locateCursorChat('22222222-e4c7-4f28-9d99-027f84c10837', cwd)).toBe(file)
    expect(await locateCursorChat('22222222-e4c7-4f28-9d99-027f84c10837')).toBe(file)
  })
  it('never guesses: no id, a partial id or an unknown id is a miss (there is no cwd fallback)', async () => {
    expect(await locateCursorChat(undefined, '/some/work/dir')).toBeUndefined()
    expect(await locateCursorChat('22222222', '/some/work/dir')).toBeUndefined()
    expect(await locateCursorChat('../../etc/passwd')).toBeUndefined()
    expect(await locateCursorChat('33333333-e4c7-4f28-9d99-027f84c10837', '/some/work/dir')).toBeUndefined()
  })
  it('follows the CLI\'s config-dir rule', () => {
    expect(cursorConfigDir({ CURSOR_CONFIG_DIR: '/a' }, '/h')).toBe('/a')
    expect(cursorConfigDir({ XDG_CONFIG_HOME: '/x' }, '/h')).toBe('/x/cursor')
    expect(cursorConfigDir({}, '/h')).toBe('/h/.cursor')
  })
})

describe('readCursorChat (the chat:read-transcript leg)', () => {
  const page = { before: null, maxBytes: 256 * 1024 } as const
  it('answers a paged read with one page, the model and no older cursor', async () => {
    const r = await readCursorChat({ sessionId: ID }, { ...page })
    expect(r.found).toBe(true)
    expect(r.olderCursor).toBeNull()
    expect(r.unmatchedResults).toEqual([])
    expect(r.messages.map((m) => m.role)).toEqual(['user', 'assistant', 'assistant', 'user', 'assistant', 'assistant'])
  })
  it('answers the legacy unpaged read as {messages, found} only', async () => {
    const r = await readCursorChat({ sessionId: ID }, null)
    expect(Object.keys(r).sort()).toEqual(['found', 'messages'])
  })
  it('has nothing older to give', async () => {
    expect(await readCursorChat({ sessionId: ID }, { before: 5, maxBytes: 65536 })).toEqual({ messages: [], found: true, olderCursor: null, unmatchedResults: [] })
  })
  it('refuses a remote node BEFORE reading: unreadable, even though a same-id store exists here', async () => {
    expect(await readCursorChat({ sessionId: ID, remoteOnly: true }, { ...page })).toMatchObject({ found: false, unreadable: true })
    expect(await readCursorChat({ sessionId: ID, remoteOnly: true }, null)).toEqual({ messages: [], found: false })
  })
  it('is not found for no id or an unknown id, never another session', async () => {
    expect((await readCursorChat({}, { ...page })).found).toBe(false)
    expect((await readCursorChat({ sessionId: '44444444-e4c7-4f28-9d99-027f84c10837', cwd: '/some/work/dir' }, { ...page })).found).toBe(false)
  })
})

describe('the session name', () => {
  it('reads the chat\'s own name and answers null while it is still the default', async () => {
    expect(await readCursorSessionName(ID)).toBe('Fixture chat')
    expect(await readCursorSessionName(OTHER)).toBeNull()
    expect(await readCursorSessionName('55555555-e4c7-4f28-9d99-027f84c10837')).toBeNull()
  })
})

describe('Context Link text', () => {
  it('builds transcript text without reasoning or provider blobs, and renders display lines from it', async () => {
    const text = await cursorTranscriptText(path.join(root, 'chats', 'b1', ID, 'store.db'))
    expect(text).not.toContain('ENCRYPTED')
    expect(text).not.toContain('providerOptions')
    expect(linesFromCursor(text ?? '')).toEqual([
      'user: Run echo and tell me the word.',
      '  $ Shell echo fixture-ok',
      '  = fixture-ok',
      'assistant: done',
      'user: Now write, read and grep a file.',
      '  $ Write /w/hello.txt',
      '  = Wrote contents to /w/hello.txt',
      '  $ Grep hi',
      '  = hello.txt   1:hi',
      '  $ Read /w/missing.txt',
      '  = Error: File not found',
      'assistant: Read failed, the rest worked.'
    ])
  })
})
