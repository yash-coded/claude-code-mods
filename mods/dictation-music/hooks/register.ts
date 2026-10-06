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
// Fade lengths. Short going out, so the music is gone as you start talking.
const FADE_OUT_MS = 500
const FADE_IN_MS = 1500
// A lock older than this was left by a session that died mid-fade.
const LOCK_STALE_MS = 20_000

// The activity log `/dictation-music log` shows: lines kept, and shown.
const LOG_KEEP = 500
const LOG_SHOW = 25

const USAGE = 'Usage: /dictation-music [learn | add <bundle-id> | remove <bundle-id> | reset | log]'

// What the mod paused, so it resumes only that, untouched since.
type Marker = { pausedAt?: number; app?: string; track?: string; position?: number }
type NowPlaying = { playing: boolean; app?: string; track?: string; position?: number; reportedAt?: number }
// `fade: false` in config.json pauses and plays without fading.
type Config = { apps: string[]; fade?: boolean }

// Apps holding the mic right now, as this session's helper last reported.
const capturing = new Set<string>()
// Set by `/dictation-music learn`: the next app to use the mic is added.
let learning = false
// What `/dictation-music` reports about the mic watcher.
let watcher = 'starting'
// Tells this session's lines apart in the shared activity log.
const SESSION = Date.now().toString(36).slice(-4)

const isMeetingApp = (app: string) => MEETING_APPS.some(prefix => app.startsWith(prefix))
const inMeeting = () => [...capturing].some(isMeetingApp)
// Dictation apps still holding the mic. Only the configured ones count: a
// screen recorder or other app using the mic is no sign of dictating.
const stillDictating = (config: Config) => [...capturing].filter(app => config.apps.includes(app))

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

// Appends one line to the activity log. Every session writes to the same file,
// so it appends (atomic for a short line) instead of rewriting it.
async function log($: Dollar, message: string) {
  const line = `${new Date().toISOString()} [${SESSION}] ${message}`
  await $.process
    .run(['/bin/sh', '-c', 'printf "%s\\n" "$1" >> "$2"', 'sh', line, `${await stateDir($)}/activity.log`])
    .catch(() => {})
}

async function trimLog($: Dollar) {
  const path = `${await stateDir($)}/activity.log`
  const text = await $.fs.read(path).then(String, () => '')
  const lines = text.split('\n').filter(Boolean)
  if (lines.length > LOG_KEEP * 2) await $.fs.write(path, lines.slice(-LOG_KEEP).join('\n') + '\n')
}

const describe = (at: { app?: string; track?: string; position?: number }) =>
  `${at.app ?? '?'} ${at.track ?? '?'} @${at.position === undefined ? '?' : at.position.toFixed(1)}s`

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
      reportedAt: typeof now?.timestamp === 'string' ? Date.parse(now.timestamp) : undefined,
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

// Right after a pause media-control still reports the old position for a
// moment, so wait for a reading taken after `since`.
async function stoppedAt($: Dollar, media: string, since: number, fallback?: number) {
  for (let attempt = 0; attempt < 10; attempt++) {
    const now = await nowPlaying($, media)
    if (!now.playing && (now.reportedAt ?? 0) >= since - 1000) return now.position
    await $.clock.sleep(250)
  }
  return fallback
}

// Pauses or plays, fading the system volume around it unless turned off.
async function fade($: Dollar, media: string, verb: 'pause' | 'play', config: Config) {
  if (config.fade === false) {
    await $.process.run([media, verb], { timeoutMs: 5000 })
    return
  }
  const [direction, ms] = verb === 'pause' ? ['out', FADE_OUT_MS] : ['in', FADE_IN_MS]
  await $.process.run(
    ['/usr/bin/osascript', `${$.plugin.root}/helper/fade.applescript`, direction, media, String(ms)],
    { timeoutMs: 10_000 },
  )
}

// Every session hears the same mic events. Only one at a time touches the
// music, so two fades never fight over the volume; mkdir is atomic, so a
// folder is the lock. Answers false, doing nothing, when another holds it.
async function withLock($: Dollar, work: () => Promise<unknown>): Promise<boolean> {
  const lock = `${await stateDir($)}/lock`
  const take = () => $.process.run(['/bin/mkdir', lock]).then(r => r.exitCode === 0, () => false)
  let taken = await take()
  if (!taken) {
    const age = await $.fs.stat(lock).then(stat => Date.now() - stat.mtimeMs, () => Infinity)
    if (age > LOCK_STALE_MS) {
      await $.process.run(['/bin/rmdir', lock]).catch(() => {})
      taken = await take()
    }
  }
  if (!taken) return false
  try {
    await work()
  } finally {
    await $.process.run(['/bin/rmdir', lock]).catch(() => {})
  }
  return true
}

const sameSpot = (marker: Marker, now: NowPlaying) =>
  now.app === marker.app &&
  now.track === marker.track &&
  (marker.position === undefined ||
    now.position === undefined ||
    Math.abs(now.position - marker.position) <= POSITION_SLACK)

async function onMicStart($: Dollar, app: string) {
  capturing.add(app)
  await log($, `mic start: ${app}`)
  if (isMeetingApp(app) || inMeeting()) return log($, 'on a call: not pausing')
  const config = await readConfig($)
  if (learning) {
    learning = false
    if (!config.apps.includes(app)) await writeConfig($, { ...config, apps: [...config.apps, app] })
    $.ui.toast(`dictation-music: added ${app}`)
    await log($, `learned ${app}`)
  } else if (!config.apps.includes(app)) {
    return
  }
  const media = await mediaControl($)
  if (!media) return log($, 'media-control not found: not pausing')
  await withLock($, () => pause($, media, config))
}

async function pause($: Dollar, media: string, config: Config) {
  const path = `${await stateDir($)}/paused.json`
  const before = await nowPlaying($, media)
  if (!before.playing) {
    const marker = await readJson<Marker>($, path)
    if (marker?.pausedAt && Date.now() - marker.pausedAt > FORGET_MS) {
      await $.fs.write(path, '{}')
      return log($, 'nothing playing: forgot an old pause')
    }
    return log($, `nothing playing${marker?.pausedAt ? ': keeping the recent pause' : ''}`)
  }
  const since = Date.now()
  await fade($, media, 'pause', config)
  const position = await stoppedAt($, media, since, before.position)
  const marker: Marker = { pausedAt: Date.now(), app: before.app, track: before.track, position }
  await $.fs.write(path, JSON.stringify(marker))
  await log($, `paused ${describe(marker)}`)
}

async function onMicStop($: Dollar, app: string) {
  capturing.delete(app)
  await log($, `mic stop: ${app}`)
}

// `submitted`: the person sent the prompt, so they're done dictating even if
// the dictation app hasn't let go of the mic yet (it often submits first).
async function resumeIfPaused($: Dollar, submitted = false) {
  const path = `${await stateDir($)}/paused.json`
  if (!(await readJson<Marker>($, path))?.pausedAt) return
  const config = await readConfig($)
  const via = submitted ? 'prompt submitted' : 'Claude took a step'
  if (!submitted) {
    const dictating = stillDictating(config)
    if (dictating.length) return log($, `${via}: ${dictating.join(', ')} still has the mic, waiting`)
  }
  // Busy: a submit and the step right after it both get here; one resumes.
  await withLock($, () => resume($, path, config, via))
}

async function resume($: Dollar, path: string, config: Config, via: string) {
  // Read again under the lock: whoever held it may have resumed already.
  const marker = await readJson<Marker>($, path)
  if (!marker?.pausedAt) return
  // Clear first so concurrent sessions don't both resume.
  await $.fs.write(path, '{}')
  // Joined a call since dictating: leave the music off.
  if (inMeeting()) return log($, `${via}: on a call, leaving the music off`)
  if (Date.now() - marker.pausedAt > STALE_MS) return log($, `${via}: pause is too old, leaving it`)
  const media = await mediaControl($)
  if (!media) return log($, `${via}: media-control not found`)
  // Played, skipped or switched since the pause: the person took over.
  const now = await nowPlaying($, media)
  if (now.playing) return log($, `${via}: music is already playing`)
  if (!sameSpot(marker, now)) {
    return log($, `${via}: music changed since the pause (now ${describe(now)}, paused ${describe(marker)})`)
  }
  await fade($, media, 'play', config)
  await log($, `${via}: resumed ${describe(marker)}`)
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
      else if (event === 'stop') await onMicStop($, app)
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
      if (!config.apps.includes(target)) await writeConfig($, { ...config, apps: [...config.apps, target] })
      return `Added ${target}.`
    case 'remove':
      if (!target) return USAGE
      await writeConfig($, { ...config, apps: config.apps.filter(app => app !== target) })
      return `Removed ${target}.`
    case 'log': {
      const text = await $.fs.read(`${await stateDir($)}/activity.log`).then(String, () => '')
      const lines = text.split('\n').filter(Boolean).slice(-LOG_SHOW)
      return lines.length ? lines.join('\n') : 'Nothing logged yet.'
    }
    case 'reset':
      await writeConfig($, { ...config, apps: DEFAULT_APPS })
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
      argumentHint: '[learn | add <bundle-id> | remove <bundle-id> | reset | log]',
    })
    if (!(await mediaControl($))) $.ui.toast(`dictation-music: ${INSTALL_HINT}`)
    await trimLog($)
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
    // In the background: the fade-in takes a moment, and Claude shouldn't wait.
    void resumeIfPaused($, true).catch(() => {})
    return submitted
  })

  // A message sent while Claude is already working joins the running turn
  // instead of arriving as a new prompt: catch it at the next model request.
  on('turn.step', async function* ($, e, next) {
    if (!e.agentId) void resumeIfPaused($).catch(() => {})
    return yield* next(e)
  })
}
