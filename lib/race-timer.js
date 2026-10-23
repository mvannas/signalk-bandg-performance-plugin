'use strict'

// Race timer commands from a Navico/B&G MFD: PGN 130850
// "Simnet: Event Command: Timer" (canboat simnetEventCommandTimer).
//
//   bytes 0-1  manufacturer 1857 + industry (41,9f)
//   byte  2    address
//   byte  3    reserved
//   byte  4    network group
//   byte  5    event type, 23 = Timer
//   bytes 6-7  event, little-endian (SIMNET_TIMER_EVENT)
//   byte  8    parameter 1
//   bytes 9-10 parameter 2, little-endian
//   byte  11   parameter 3
//
// canboat does not say what the parameters carry for the race timer. The
// countdown length is assumed to be in parameter 2 (seconds) when it is a
// plausible value; otherwise the timer keeps its current length.

const NAVICO = 1857
const EVENT_TYPE_TIMER = 23

const TIMER_EVENTS = {
  61: 'start',
  62: 'stop',
  63: 'sync',
  64: 'reset'
}

const NAMES = {
  'Race Timer Start': 'start',
  'Race Timer Stop': 'stop',
  'Race Timer Sync': 'sync',
  'Race Timer Reset': 'reset'
}

function plausibleSeconds (n) {
  return Number.isInteger(n) && n > 0 && n <= 3600 && n !== 0xffff ? n : undefined
}

// Raw 130850 payload (Buffer / Uint8Array / array of bytes) → command or null.
function parseTimerEvent (data) {
  if (!data || data.length < 12) return null
  const b = data
  if (((b[0] | (b[1] << 8)) & 0x7ff) !== NAVICO) return null
  if (b[5] !== EVENT_TYPE_TIMER) return null
  const code = b[6] | (b[7] << 8)
  const command = TIMER_EVENTS[code]
  if (!command) return null
  const parameter2 = b[9] | (b[10] << 8)
  return {
    command: command,
    address: b[2],
    group: b[4],
    parameter1: b[8],
    parameter2: parameter2,
    parameter3: b[11],
    seconds: plausibleSeconds(parameter2)
  }
}

// canboatjs-decoded 130850 (N2KAnalyzerOut) → command or null.
function parseTimerFields (n2k) {
  if (!n2k || n2k.pgn !== 130850 || !n2k.fields) return null
  const f = n2k.fields
  if (f['Event Type'] !== 'Timer' && f['Event Type'] !== EVENT_TYPE_TIMER) return null
  const command = typeof f.Event === 'number' ? TIMER_EVENTS[f.Event] : NAMES[f.Event]
  if (!command) return null
  const parameter2 = f['Parameter 2']
  return {
    command: command,
    address: f.Address,
    parameter1: f['Parameter 1'],
    parameter2: parameter2,
    parameter3: f['Parameter 3'],
    seconds: plausibleSeconds(parameter2)
  }
}

// Steps for Racer's PUT navigation.racing.setStartTime, one MFD command.
// { command: 'length', seconds } is not a Racer command: the caller turns it
// into 'adjust' with delta = seconds - current timeToStart when it runs,
// after the steps before it have taken effect.
function racerCommands (event) {
  if (!event) return []
  const length = event.seconds ? [{ command: 'length', seconds: event.seconds }] : []
  switch (event.command) {
    case 'reset': return [{ command: 'reset' }].concat(length)
    case 'start': return length.concat([{ command: 'start' }])
    case 'stop': return [{ command: 'stop' }]
    case 'sync': return [{ command: 'sync' }]
  }
  return []
}

// 'length' step → Racer 'adjust' payload, or null when nothing to change.
function lengthToAdjust (seconds, timeToStart) {
  if (typeof timeToStart !== 'number' || !Number.isFinite(timeToStart)) return null
  const delta = seconds - timeToStart
  return delta === 0 ? null : { command: 'adjust', delta: delta }
}

module.exports = {
  parseTimerEvent,
  parseTimerFields,
  racerCommands,
  lengthToAdjust,
  TIMER_EVENTS
}
