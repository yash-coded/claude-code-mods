import type { Hook, Register } from 'claude-code'

type Dollar = Parameters<Hook<'prompt.submit'>>[0]

// Bump when helper/dictation-watch.swift changes so sessions rebuild it.
const HELPER = 'dictation-watch-v2'

// Apps whose microphone use counts as dictation.
// Add yours with `/dictation-music learn` or `/dictation-music add <bundle-id>`.
const DEFAULT_APPS = ['com.typewhisper.mac', 'com.superduper.superwhisper']

// Calls and meetings, matched by bundle ID prefix. While any of these holds the
// mic the mod does nothing, and none of them can be added as a dictation app.
const MEETING_APPS = [
  'us.zoom.',
  'com.microsoft.teams',
  'com.tinyspeck.slackmacgap',
  'com.apple.FaceTime',
  'com.cisco.webex',
  'com.webex.',
  'com.hnc.Discord',
  'com.skype.',
  'net.whatsapp.',
  // Browsers: Google Meet and other web calls capture the mic through them.
  'com.google.Chrome',
  'com.apple.Safari',
  'com.apple.WebKit',
  'company.thebrowser.',
  'org.mozilla.firefox',
  'com.microsoft.edgemac',
  'com.brave.Browser',
  'com.operasoftware.',
  'com.vivaldi.',
  'app.zen-browser.',
]

// https://github.com/ungive/media-control, the system Now Playing from the CLI.
const MEDIA_CONTROL_PATHS = ['/opt/homebrew/bin/media-control', '/usr/local/bin/media-control']
const INSTALL_HINT = 'Install media-control to control your music: brew install media-control'

// A pause older than this is left alone rather than blasting music back on.
const STALE_MS = 15 * 60 * 1000
// Dictating into silence this long after the mod's pause: the silence is the
// person's choice now, so that pause is forgotten.
const FORGET_MS = 2 * 60 * 1000
// How far the track may have moved while paused (seconds) and still be ours.
const POSITION_SLACK = 3

const USAGE = 'Usage: /dictation-music [learn | add <bundle-id> | remove <bundle-id> | reset]'

// What the mod paused, so it resumes only that, untouched since.
type Marker = { pausedAt?: number; app?: string; track?: string; position?: number }
type NowPlaying = { playing: boolean; app?: string; track?: string; position?: number }
type Config = { apps: string[] }

// Apps holding the mic right now, as this session's helper last reported.
const capturing = new Set<string>()
// Set by `/dictation-music learn`: the next app to use the mic is added.
let learning = false
// What `/dictation-music` reports about the mic watcher.
let watcher = 'starting'

const isMeetingApp = (app: string) => MEETING_APPS.some(prefix => app.startsWith(prefix))
const inMeeting = () => [...capturing].some(isMeetingApp)
// Something other than a meeting still has the mic open: still dictating.
const stillDictating = () => [...capturing].some(app => !isMeetingApp(app))

async function stateDir($: Dollar): Promise<string> {
  return `${await $.env.get('HOME')}/.claude/dictation-music`
}

async function readJson<T>($: Dollar, path: string): Promise<T | undefined> {
  try {
    return JSON.parse(String(await $.fs.read(path)))
  } catch {
    return undefined
  }
}

async function exists($: Dollar, path: string): Promise<boolean> {
  return $.fs.stat(path).then(
    () => true,
    () => false,
  )
}

async function readConfig($: Dollar): Promise<Config> {
  const config = await readJson<Config>($, `${await stateDir($)}/config.json`)
  return Array.isArray(config?.apps) ? config : { apps: DEFAULT_APPS }
}

async function writeConfig($: Dollar, config: Config) {
  await $.fs.write(`${await stateDir($)}/config.json`, JSON.stringify(config, null, 2) + '\n')
}

async function mediaControl($: Dollar): Promise<string | undefined> {
  for (const path of MEDIA_CONTROL_PATHS) if (await exists($, path)) return path
  return undefined
}

async function nowPlaying($: Dollar, media: string): Promise<NowPlaying> {
  const { exitCode, stdout } = await $.process.run([media, 'get'], { timeoutMs: 5000 })
  if (exitCode !== 0) return { playing: false }
  try {
    const now = JSON.parse(stdout)
    return {
      playing: now?.playing === true,
      app: now?.bundleIdentifier,
      track: now?.contentItemIdentifier ?? now?.title,
      position: positionNow(now),
    }
  } catch {
    return { playing: false }
  }
}

// media-control reports the position as of `timestamp` (whole seconds, and
// stale for a moment after a pause), so a playing track is projected to now.
function positionNow(now: { elapsedTime?: unknown; timestamp?: unknown; playing?: unknown; playbackRate?: unknown }) {
  if (typeof now?.elapsedTime !== 'number') return undefined
  const at = typeof now.timestamp === 'string' ? Date.parse(now.timestamp) : NaN
  if (now.playing !== true || Number.isNaN(at)) return now.elapsedTime
  return now.elapsedTime + ((Date.now() - at) / 1000) * (Number(now.playbackRate) || 1)
}

const sameSpot = (marker: Marker, now: NowPlaying) =>
  now.app === marker.app &&
  now.track === marker.track &&
  (marker.position === undefined ||
    now.position === undefined ||
    Math.abs(now.position - marker.position) <= POSITION_SLACK)

async function onMicStart($: Dollar, app: string) {
  capturing.add(app)
  if (isMeetingApp(app) || inMeeting()) return
  const config = await readConfig($)
  if (learning) {
    learning = false
    if (!config.apps.includes(app)) await writeConfig($, { apps: [...config.apps, app] })
    $.ui.toast(`dictation-music: added ${app}`)
  } else if (!config.apps.includes(app)) {
    return
  }
  const media = await mediaControl($)
  if (!media) return
  const path = `${await stateDir($)}/paused.json`
  const before = await nowPlaying($, media)
  if (!before.playing) {
    const marker = await readJson<Marker>($, path)
    if (marker?.pausedAt && Date.now() - marker.pausedAt > FORGET_MS) await $.fs.write(path, '{}')
    return
  }
  await $.process.run([media, 'pause'], { timeoutMs: 5000 })
  const marker: Marker = { pausedAt: Date.now(), app: before.app, track: before.track, position: before.position }
  await $.fs.write(path, JSON.stringify(marker))
}

// `submitted`: the person sent the prompt, so they're done dictating even if
// the dictation app hasn't let go of the mic yet (it often submits first).
async function resumeIfPaused($: Dollar, submitted = false) {
  const path = `${await stateDir($)}/paused.json`
  const marker = await readJson<Marker>($, path)
  if (!marker?.pausedAt) return
  if (!submitted && stillDictating()) return
  // Clear first so concurrent sessions don't both resume.
  await $.fs.write(path, '{}')
  // Joined a call since dictating: leave the music off.
  if (inMeeting()) return
  if (Date.now() - marker.pausedAt > STALE_MS) return
  const media = await mediaControl($)
  if (!media) return
  // Played, skipped or switched since the pause: the person took over.
  const now = await nowPlaying($, media)
  if (now.playing || !sameSpot(marker, now)) return
  await $.process.run([media, 'play'], { timeoutMs: 5000 })
}

// Builds the mic watcher on first run, then reports each app that starts or
// stops using the mic for as long as the session lives.
async function watchMic($: Dollar) {
  const dir = await stateDir($)
  const bin = `${dir}/${HELPER}`
  if (!(await exists($, bin))) {
    watcher = 'building'
    await $.fs.write(`${dir}/.keep`, '') // swiftc needs the folder to exist
    const build = await $.process.run(
      ['/usr/bin/swiftc', '-O', '-o', bin, `${$.plugin.root}/helper/dictation-watch.swift`],
      { timeoutMs: 300_000 },
    )
    if (build.exitCode !== 0) {
      watcher = `build failed (is Xcode Command Line Tools installed?): ${build.stderr.trim().slice(0, 300)}`
      $.ui.toast('dictation-music: could not build the mic watcher. Run /dictation-music for details.')
      return
    }
  }
  watcher = 'running'
  let buffer = ''
  for await (const chunk of $.process.spawn({ argv: [bin] })) {
    if (!('text' in chunk) || chunk.stream !== 'stdout') continue
    buffer += chunk.text
    const lines = buffer.split('\n')
    buffer = lines.pop() ?? ''
    for (const line of lines) {
      const [event, ...rest] = line.trim().split(' ')
      const app = rest.join(' ')
      if (event === 'start') await onMicStart($, app)
      else if (event === 'stop') capturing.delete(app)
    }
  }
  watcher = 'stopped'
}

async function runCommand($: Dollar, args: string): Promise<string> {
  const [verb = '', ...rest] = args.trim().split(/\s+/)
  const target = rest.join(' ')
  const config = await readConfig($)
  switch (verb) {
    case 'learn':
      learning = true
      return 'Start your dictation app now: the next app to use the microphone will be added.'
    case 'add':
      if (!target) return USAGE
      if (isMeetingApp(target)) return `${target} is a meeting app or browser, so it can't pause music.`
      if (!config.apps.includes(target)) await writeConfig($, { apps: [...config.apps, target] })
      return `Added ${target}.`
    case 'remove':
      if (!target) return USAGE
      await writeConfig($, { apps: config.apps.filter(app => app !== target) })
      return `Removed ${target}.`
    case 'reset':
      await writeConfig($, { apps: DEFAULT_APPS })
      return `Back to the defaults: ${DEFAULT_APPS.join(', ')}.`
    default: {
      const media = await mediaControl($)
      return [
        `Pausing music for: ${config.apps.join(', ') || 'no apps yet'}`,
        `Media control: ${media ?? `not found. ${INSTALL_HINT}`}`,
        `Mic watcher: ${watcher}`,
        USAGE,
      ].join('\n')
    }
  }
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    const started = await next(e)
    await $.command.register({
      name: 'dictation-music',
      description: 'Choose which dictation apps pause your music',
      argumentHint: '[learn | add <bundle-id> | remove <bundle-id> | reset]',
    })
    if (!(await mediaControl($))) $.ui.toast(`dictation-music: ${INSTALL_HINT}`)
    void watchMic($).catch(err => {
      watcher = `failed: ${String(err)}`
      $.ui.log(`dictation-music: ${String(err)}`, { to: 'debug' })
    })
    return started
  })

  on('command.run', { command: 'dictation-music' }, async ($, e) => ({
    text: await runCommand($, e.args),
  }))

  on('prompt.submit', async ($, e, next) => {
    const submitted = await next(e)
    await resumeIfPaused($, true).catch(() => {})
    return submitted
  })

  // A message sent while Claude is already working joins the running turn
  // instead of arriving as a new prompt: catch it at the next model request.
  on('turn.step', async function* ($, e, next) {
    if (!e.agentId) await resumeIfPaused($).catch(() => {})
    return yield* next(e)
  })
}
