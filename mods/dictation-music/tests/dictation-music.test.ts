import type { On } from 'claude-code'
import { expect, test, type Engine } from 'claude-code/testing'

// The test runtime has timers; the mod's own type environment doesn't declare them.
declare function setTimeout(callback: () => void, ms: number): unknown

const HOME = '/Users/tester'
const DIR = `${HOME}/.claude/dictation-music`
const MARKER = `${DIR}/paused.json`
const CONFIG = `${DIR}/config.json`
const HELPER = `${DIR}/dictation-watch-v2`
const MEDIA = '/opt/homebrew/bin/media-control'

const SPOTIFY = 'com.spotify.client'
const TRACK = 'track-1'

// `reportedAgoMs`: media-control reports `position` as of that long ago.
type Player = { playing: boolean; app: string; track: string; position: number; reportedAgoMs?: number }

type Host = {
  files?: Record<string, string>
  // Lines the mic watcher prints, e.g. "start com.typewhisper.mac",
  // once `speak` settles (at once when not given).
  mic?: string[]
  speak?: Promise<void>
  // Keeps the mic watcher running (so its apps stay on the mic) until it settles.
  until?: Promise<void>
  // What media-control reports; Spotify playing track-1 at 0:42 by default.
  player?: Partial<Player>
  hasMediaControl?: boolean
  // Another session took the lock this long ago.
  lockedAgoMs?: number
}

// Stands in for the machine beneath the mod: files in memory, a mic watcher
// that prints `mic`, and a player media-control reads and drives.
// Returns what was done to the music, in order: media-control's get, pause
// and play, and the fades ('fade-out', 'fade-in') that wrap a pause or play.
function fakeHost(on: On, host: Host = {}): string[] {
  const files = host.files ?? {}
  const player: Player = { playing: true, app: SPOTIFY, track: TRACK, position: 42, ...host.player }
  const ran: string[] = []
  const LOCK = `${DIR}/lock`
  let lockedAt = host.lockedAgoMs === undefined ? undefined : Date.now() - host.lockedAgoMs
  const done = (stdout = '', exitCode = 0) => ({
    value: { exitCode, stdout, stderr: '', isStdoutTruncated: false, isStderrTruncated: false },
  })
  // Pausing settles the reading: the position where it stopped, reported now.
  const stop = () => {
    if (player.playing) player.position += (player.reportedAgoMs ?? 0) / 1000
    player.reportedAgoMs = 0
    player.playing = false
  }
  on('env.get', () => ({ value: HOME }))
  on('fs.read', (_$, e) => {
    const text = files[e.path]
    if (text === undefined) throw new Error('ENOENT')
    return { value: text }
  })
  on('fs.write', (_$, e) => {
    files[e.path] = e.text
    return { value: undefined }
  })
  on('fs.stat', (_$, e) => {
    if (e.path === LOCK && lockedAt !== undefined) {
      return { value: { kind: 'dir', size: 0, mtimeMs: lockedAt, isLink: false } }
    }
    const found = e.path === HELPER || (e.path === MEDIA && host.hasMediaControl !== false)
    if (!found) throw new Error('ENOENT')
    return { value: { kind: 'file', size: 1, mtimeMs: 0, isLink: false } }
  })
  on('process.run', (_$, e) => {
    // The activity log appends through the shell: sh -c '...' sh <line> <file>.
    if (e.argv[0] === '/bin/sh') {
      const [line, file] = e.argv.slice(-2) as [string, string]
      files[file] = (files[file] ?? '') + line + '\n'
      return done()
    }
    if (e.argv[0] === '/bin/mkdir') {
      if (lockedAt !== undefined) return done('', 1)
      lockedAt = Date.now()
      return done()
    }
    if (e.argv[0] === '/bin/rmdir') {
      lockedAt = undefined
      return done()
    }
    // osascript fade.applescript out|in <media-control> <ms>
    const verb = e.argv[0] === '/usr/bin/osascript' ? `fade-${e.argv[2]}` : e.argv.at(-1)!
    ran.push(verb)
    if (verb === 'pause' || verb === 'fade-out') stop()
    if (verb === 'play' || verb === 'fade-in') player.playing = true
    const now = {
      playing: player.playing,
      bundleIdentifier: player.app,
      contentItemIdentifier: player.track,
      elapsedTime: player.position,
      playbackRate: player.playing ? 1 : 0,
      timestamp: new Date(Date.now() - (player.reportedAgoMs ?? 0)).toISOString(),
    }
    return done(verb === 'get' ? JSON.stringify(now) : '')
  })
  on('process.spawn', async function* () {
    await host.speak
    for (const line of host.mic ?? []) yield { stream: 'stdout' as const, text: `${line}\n` }
    await host.until
    return { value: { code: 0, signal: null } }
  })
  on('session.start', (_$, e) => ({ cwd: e.cwd }))
  on('prompt.submit', (_$, e) => ({ text: e.text }))
  on('command.register', (_$, e) => ({ value: { command: e.name } }))
  on('ui.toast', () => ({ value: undefined }))
  on('ui.log', () => ({ value: undefined }))
  return ran
}

// A promise that holds the mic watcher where it is, and the function that lets it go on.
function hold(): [Promise<void>, () => void] {
  let release = () => {}
  const held = new Promise<void>(resolve => (release = () => resolve()))
  return [held, release]
}

const settle = () => new Promise<void>(resolve => setTimeout(() => resolve(), 50))

async function startSession($: Engine) {
  await $.session.start({ cwd: HOME, surface: null, isInteractive: true })
  // The watcher's lines are handled in the background.
  await settle()
}

// The kit has no model beneath turn.step; the mod acts before handing the
// step down, which is all these tests look at.
// Resuming runs in the background, so each of these waits for it to land.
async function submit($: Engine, text = 'hello') {
  await $.prompt.submit({ text, wait: false, origin: { kind: 'composer' } })
  await settle()
}

async function command($: Engine, args: string) {
  return $.command.run({
    command: 'dictation-music',
    args,
    origin: { kind: 'composer' },
    presentation: { isFullscreen: false, columns: 100 },
  })
}

async function step($: Engine, agentId?: string) {
  try {
    for await (const _ of $.turn.step({ turnId: 't1', index: 1, model: 'm', messageCount: 3, agentId })) {
    }
  } catch {}
  await settle()
}

// The mod paused Spotify's track-1 at 0:42, `ago` ms back.
const pausedByMod = (ago = 0) => ({
  [MARKER]: JSON.stringify({ pausedAt: Date.now() - ago, app: SPOTIFY, track: TRACK, position: 42 }),
})
const paused = { playing: false }

test('pauses music when a dictation app starts recording', async ($, on) => {
  const files: Record<string, string> = {}
  const ran = fakeHost(on, { files, mic: ['ready', 'start com.typewhisper.mac'] })
  await startSession($)
  expect(ran).toEqual(['get', 'fade-out', 'get'])
  expect(JSON.parse(files[MARKER]!)).toMatchObject({ app: SPOTIFY, track: TRACK, position: 42 })
})

test('ignores apps that are not configured', async ($, on) => {
  const ran = fakeHost(on, { mic: ['start com.example.recorder'] })
  await startSession($)
  expect(ran).toEqual([])
})

test('uses the apps in config.json', async ($, on) => {
  const files = { [CONFIG]: JSON.stringify({ apps: ['com.example.flow'] }) }
  const ran = fakeHost(on, { files, mic: ['start com.example.flow'] })
  await startSession($)
  expect(ran).toEqual(['get', 'fade-out', 'get'])
})

test('does nothing without media-control', async ($, on) => {
  const ran = fakeHost(on, { mic: ['start com.typewhisper.mac'], hasMediaControl: false })
  await startSession($)
  expect(ran).toEqual([])
})

test('never pauses for a meeting, nor for dictation during one', async ($, on) => {
  const files = { [CONFIG]: JSON.stringify({ apps: ['us.zoom.xos', 'com.typewhisper.mac'] }) }
  const ran = fakeHost(on, {
    files,
    mic: [
      'start us.zoom.xos',
      'start com.typewhisper.mac',
      'stop com.typewhisper.mac',
      'stop us.zoom.xos',
      'start com.google.Chrome.helper',
      'start com.typewhisper.mac',
    ],
  })
  await startSession($)
  expect(ran).toEqual([])
})

test('pauses again for dictation once the meeting ends', async ($, on) => {
  const ran = fakeHost(on, { mic: ['start us.zoom.xos', 'stop us.zoom.xos', 'start com.typewhisper.mac'] })
  await startSession($)
  expect(ran).toEqual(['get', 'fade-out', 'get'])
})

test('resumes paused music once the prompt is submitted', async ($, on) => {
  const files = pausedByMod()
  const ran = fakeHost(on, { files, player: paused })
  await submit($)
  expect(ran).toEqual(['get', 'fade-in'])
  expect(files[MARKER]).toBe('{}')
})

test('a submitted prompt resumes even before the dictation app lets go of the mic', async ($, on) => {
  const [until, release] = hold()
  const ran = fakeHost(on, { files: pausedByMod(), mic: ['start com.typewhisper.mac'], until, player: paused })
  await startSession($)
  ran.length = 0
  await submit($)
  expect(ran).toEqual(['get', 'fade-in'])
  release()
})

test('resumes for a message sent while Claude is working', async ($, on) => {
  const ran = fakeHost(on, { files: pausedByMod(), player: paused })
  await step($, 'subagent-1')
  expect(ran).toEqual([])
  await step($)
  expect(ran).toEqual(['get', 'fade-in'])
})

test('waits for the dictation app to let go of the mic mid-turn', async ($, on) => {
  const files = pausedByMod()
  const [until, release] = hold()
  const ran = fakeHost(on, { files, mic: ['start com.typewhisper.mac'], until, player: paused })
  await startSession($)
  ran.length = 0
  await step($)
  expect(ran).toEqual([])
  expect(JSON.parse(files[MARKER]!).pausedAt).toBeGreaterThan(0)
  release()
})

test('a screen recorder on the mic does not hold up a mid-turn resume', async ($, on) => {
  const [until, release] = hold()
  const mic = ['start com.timpler.screenstudio.helper', 'start com.typewhisper.mac', 'stop com.typewhisper.mac']
  const ran = fakeHost(on, { files: pausedByMod(), mic, until, player: paused })
  await startSession($)
  ran.length = 0
  await step($)
  expect(ran).toEqual(['get', 'fade-in'])
  release()
})

test('does not resume music while a meeting holds the mic', async ($, on) => {
  const [until, release] = hold()
  const ran = fakeHost(on, { files: pausedByMod(), mic: ['start com.microsoft.teams2'], until, player: paused })
  await startSession($)
  await submit($)
  expect(ran).toEqual([])
  release()
})

test('leaves music alone when nothing was paused', async ($, on) => {
  const ran = fakeHost(on, { player: paused })
  await submit($)
  expect(ran).toEqual([])
})

test('does not resume a stale pause', async ($, on) => {
  const files = pausedByMod(60 * 60 * 1000)
  const ran = fakeHost(on, { files, player: paused })
  await submit($)
  expect(ran).toEqual([])
  expect(files[MARKER]).toBe('{}')
})

test('does not resume after the person played and paused it themselves', async ($, on) => {
  const ran = fakeHost(on, { files: pausedByMod(), player: { playing: false, position: 130 } })
  await submit($)
  expect(ran).toEqual(['get'])
})

test('does not resume a different track or app', async ($, on) => {
  const ran = fakeHost(on, { files: pausedByMod(), player: { playing: false, app: 'com.apple.Music' } })
  await submit($)
  expect(ran).toEqual(['get'])
})

test('does not touch music the person already restarted', async ($, on) => {
  const ran = fakeHost(on, { files: pausedByMod() })
  await submit($)
  expect(ran).toEqual(['get'])
})

test('dictating into silence forgets an old pause', async ($, on) => {
  const files = pausedByMod(3 * 60 * 1000)
  const ran = fakeHost(on, { files, mic: ['start com.typewhisper.mac'], player: paused })
  await startSession($)
  expect(files[MARKER]).toBe('{}')
  await submit($)
  expect(ran).toEqual(['get'])
})

test('dictating again shortly after keeps the pause', async ($, on) => {
  const files = pausedByMod(30 * 1000)
  const ran = fakeHost(on, { files, mic: ['start com.typewhisper.mac', 'stop com.typewhisper.mac'], player: paused })
  await startSession($)
  await submit($)
  expect(ran).toEqual(['get', 'get', 'fade-in'])
})

test('learn adds the next app that uses the mic', async ($, on) => {
  const files: Record<string, string> = {}
  const [until, release] = hold()
  const [speak, startDictating] = hold()
  const ran = fakeHost(on, { files, mic: ['start com.example.newapp'], speak, until })
  await startSession($)
  await command($, 'learn')
  startDictating()
  await settle()
  expect(JSON.parse(files[CONFIG]!).apps).toContain('com.example.newapp')
  expect(ran).toEqual(['get', 'fade-out', 'get'])
  release()
})

test('add refuses meeting apps and browsers', async ($, on) => {
  const files: Record<string, string> = {}
  fakeHost(on, { files })
  const { text } = await command($, 'add us.zoom.xos')
  expect(text).toContain("can't pause music")
  expect(files[CONFIG]).toBe(undefined)
  await command($, 'add com.example.flow')
  expect(JSON.parse(files[CONFIG]!).apps).toContain('com.example.flow')
})

test('remove and reset edit the list', async ($, on) => {
  const files: Record<string, string> = {}
  fakeHost(on, { files })
  await command($, 'remove com.typewhisper.mac')
  expect(JSON.parse(files[CONFIG]!).apps).toEqual(['com.superduper.superwhisper'])
  await command($, 'reset')
  expect(JSON.parse(files[CONFIG]!).apps).toContain('com.typewhisper.mac')
})

test('status names the apps, media-control and how to install it', async ($, on) => {
  fakeHost(on, { hasMediaControl: false })
  const { text } = await command($, '')
  expect(text).toContain('com.typewhisper.mac')
  expect(text).toContain('brew install media-control')
})

test('records where the track actually stopped, not its stale position', async ($, on) => {
  const files: Record<string, string> = {}
  // Reported as 0:27 three seconds ago, so it's really at about 0:30.
  fakeHost(on, { files, mic: ['start com.typewhisper.mac'], player: { position: 27, reportedAgoMs: 3000 } })
  await startSession($)
  const { position } = JSON.parse(files[MARKER]!)
  expect(position).toBeGreaterThan(29.5)
  expect(position).toBeLessThan(31)
})

test('log shows what happened and why', async ($, on) => {
  const files: Record<string, string> = {}
  const [until, release] = hold()
  fakeHost(on, { files, mic: ['start com.typewhisper.mac', 'stop com.typewhisper.mac'], until })
  await startSession($)
  await submit($)
  const { text } = await command($, 'log')
  expect(text).toContain('mic start: com.typewhisper.mac')
  expect(text).toContain(`paused ${SPOTIFY} ${TRACK} @42.0s`)
  expect(text).toContain(`prompt submitted: resumed ${SPOTIFY} ${TRACK} @42.0s`)
  release()
})

test('fades out to pause and in to resume, unless fade is off', async ($, on) => {
  const files = { [CONFIG]: JSON.stringify({ apps: ['com.typewhisper.mac'], fade: false }) }
  const [until, release] = hold()
  const ran = fakeHost(on, { files, mic: ['start com.typewhisper.mac', 'stop com.typewhisper.mac'], until })
  await startSession($)
  await submit($)
  expect(ran).toEqual(['get', 'pause', 'get', 'get', 'play'])
  release()
})

test('leaves the music to the session that holds the lock', async ($, on) => {
  const files: Record<string, string> = {}
  const ran = fakeHost(on, { files, mic: ['start com.typewhisper.mac'], lockedAgoMs: 1000 })
  await startSession($)
  expect(ran).toEqual([])
  expect(files[MARKER]).toBe(undefined)
})

test('takes over a lock left by a session that died', async ($, on) => {
  const ran = fakeHost(on, { mic: ['start com.typewhisper.mac'], lockedAgoMs: 60_000 })
  await startSession($)
  expect(ran).toEqual(['get', 'fade-out', 'get'])
})

test('a submit and the step right after it resume once', async ($, on) => {
  const ran = fakeHost(on, { files: pausedByMod(), player: paused })
  await Promise.all([submit($), step($)])
  expect(ran.filter(verb => verb === 'fade-in')).toEqual(['fade-in'])
})
