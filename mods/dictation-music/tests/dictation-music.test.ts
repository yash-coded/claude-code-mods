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
}

// Stands in for the machine beneath the mod: files in memory, a mic watcher
// that prints `mic`, and a player media-control reads and drives.
// Returns the media-control commands run, in order.
function fakeHost(on: On, host: Host = {}): string[] {
  const files = host.files ?? {}
  const player: Player = { playing: true, app: SPOTIFY, track: TRACK, position: 42, ...host.player }
  const ran: string[] = []
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
    const found = e.path === HELPER || (e.path === MEDIA && host.hasMediaControl !== false)
    if (!found) throw new Error('ENOENT')
    return { value: { kind: 'file', size: 1, mtimeMs: 0, isLink: false } }
  })
  on('process.run', (_$, e) => {
    const verb = e.argv.at(-1)!
    ran.push(verb)
    if (verb === 'pause') player.playing = false
    if (verb === 'play') player.playing = true
    const now = {
      playing: player.playing,
      bundleIdentifier: player.app,
      contentItemIdentifier: player.track,
      elapsedTime: player.position,
      playbackRate: player.playing ? 1 : 0,
      timestamp: new Date(Date.now() - (player.reportedAgoMs ?? 0)).toISOString(),
    }
    const stdout = verb === 'get' ? JSON.stringify(now) : ''
    return { value: { exitCode: 0, stdout, stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
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
async function submit($: Engine, text = 'hello') {
  await $.prompt.submit({ text, wait: false, origin: { kind: 'composer' } })
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
  expect(ran).toEqual(['get', 'pause'])
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
  expect(ran).toEqual(['get', 'pause'])
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
  expect(ran).toEqual(['get', 'pause'])
})

test('resumes paused music once the prompt is submitted', async ($, on) => {
  const files = pausedByMod()
  const ran = fakeHost(on, { files, player: paused })
  await submit($)
  expect(ran).toEqual(['get', 'play'])
  expect(files[MARKER]).toBe('{}')
})

test('a submitted prompt resumes even before the dictation app lets go of the mic', async ($, on) => {
  const [until, release] = hold()
  const ran = fakeHost(on, { files: pausedByMod(), mic: ['start com.typewhisper.mac'], until, player: paused })
  await startSession($)
  ran.length = 0
  await submit($)
  expect(ran).toEqual(['get', 'play'])
  release()
})

test('resumes for a message sent while Claude is working', async ($, on) => {
  const ran = fakeHost(on, { files: pausedByMod(), player: paused })
  await step($, 'subagent-1')
  expect(ran).toEqual([])
  await step($)
  expect(ran).toEqual(['get', 'play'])
})

test('waits for the dictation app to let go of the mic mid-turn', async ($, on) => {
  const files = pausedByMod()
  const [until, release] = hold()
  const ran = fakeHost(on, { files, mic: ['start com.example.recorder'], until, player: paused })
  await startSession($)
  await step($)
  expect(ran).toEqual([])
  expect(JSON.parse(files[MARKER]!).pausedAt).toBeGreaterThan(0)
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
  expect(ran).toEqual(['get', 'get', 'play'])
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
  expect(ran).toEqual(['get', 'pause'])
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

test('records where a playing track actually stopped, not its stale position', async ($, on) => {
  const files: Record<string, string> = {}
  // Reported as 0:27 three seconds ago, so it's really at about 0:30.
  fakeHost(on, { files, mic: ['start com.typewhisper.mac'], player: { position: 27, reportedAgoMs: 3000 } })
  await startSession($)
  const { position } = JSON.parse(files[MARKER]!)
  expect(position).toBeGreaterThan(29.5)
  expect(position).toBeLessThan(31)
})
