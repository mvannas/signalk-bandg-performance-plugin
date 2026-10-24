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
// A Zeus recording (2026-10-24) sends start/stop with address ff, group 1
// and parameters all ff. The countdown length is not in this PGN but in
// 130845 (below); a plausible parameter 2 is still taken as seconds.
//
// Race timer duration: PGN 130845 "Simnet: Key Value", key 16903.
//
//   bytes 0-1  41,9f
//   byte  2    address, 3 instance, 4 network group, 5 source
//   bytes 6-8  key, little-endian 24 bit (16903 = 0x004207)
//   byte  9    operation (0 read, 1 set, 2 reply)
//   bytes 10-13 value, little-endian
//
// canboat gives the value a 60 s resolution. The recording has value 50 for
// what is surely a 5 minute timer, so the unit is taken as 0.1 min (6 s).

const NAVICO = 1857
const EVENT_TYPE_TIMER = 23
const KEY_RACE_TIMER_DURATION = 16903
const DURATION_UNIT_SECONDS = 6

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

// canboatjs-decoded 130850 (N2KAnalyzerOut) → command or null. Handles
// both old ('Event Type') and camelCase (eventType) field names.
function parseTimerFields (n2k) {
  if (!n2k || n2k.pgn !== 130850 || !n2k.fields) return null
  const f = n2k.fields
  const type = f['Event Type'] !== undefined ? f['Event Type'] : f.eventType
  if (type !== 'Timer' && type !== EVENT_TYPE_TIMER) return null
  const ev = f.Event !== undefined ? f.Event : f.event
  const command = typeof ev === 'number' ? TIMER_EVENTS[ev] : NAMES[ev]
  if (!command) return null
  const parameter2 = f['Parameter 2'] !== undefined ? f['Parameter 2'] : f.parameter2
  return {
    command: command,
    address: f.Address !== undefined ? f.Address : f.address,
    parameter2: parameter2,
    seconds: plausibleSeconds(parameter2)
  }
}

// Raw 130845 payload → { command: 'duration', seconds } or null.
function parseTimerDuration (data) {
  if (!data || data.length < 14) return null
  const b = data
  if (((b[0] | (b[1] << 8)) & 0x7ff) !== NAVICO) return null
  const key = b[6] | (b[7] << 8) | (b[8] << 16)
  if (key !== KEY_RACE_TIMER_DURATION || b[9] !== 1) return null
  const value = (b[10] | (b[11] << 8) | (b[12] << 16) | (b[13] << 24)) >>> 0
  const seconds = value * DURATION_UNIT_SECONDS
  if (!(seconds > 0 && seconds <= 3600)) return null
  return { command: 'duration', seconds: seconds, value: value }
}

// Payload bytes of an N2KAnalyzerOut message: rawData / data when the
// decoder keeps them, else rebuilt from the candump lines in input.
function rawBytes (n2k) {
  if (!n2k) return null
  if (Array.isArray(n2k.rawData)) return n2k.rawData
  if (Buffer.isBuffer(n2k.data)) return n2k.data
  if (!Array.isArray(n2k.input) || !n2k.input.length) return null
  const frames = n2k.input.map(line => {
    const m = /\]\s+((?:[0-9a-fA-F]{2}\s*)+)$/.exec(String(line).trim())
    return m ? m[1].trim().split(/\s+/).map(h => parseInt(h, 16)) : null
  })
  if (frames.some(f => !f)) return null
  if (frames.length === 1) return frames[0]
  const len = frames[0][1]
  let out = frames[0].slice(2)
  for (const f of frames.slice(1)) out = out.concat(f.slice(1))
  return out.slice(0, len)
}

// Any N2KAnalyzerOut message → timer command / duration, or null.
// Raw bytes win: canboatjs versions without simnetEventCommandTimer decode
// 130850 as "Simnet: AP command" with no event fields.
function parseN2k (n2k) {
  if (!n2k) return null
  if (n2k.pgn === 130850) {
    return parseTimerEvent(rawBytes(n2k)) || parseTimerFields(n2k)
  }
  if (n2k.pgn === 130845) {
    return parseTimerDuration(rawBytes(n2k))
  }
  return null
}

// Steps for Racer's PUT navigation.racing.setStartTime, one MFD command.
// { command: 'length', seconds } is not a Racer command: the caller turns it
// into 'adjust' with delta = seconds - current timeToStart when it runs,
// after the steps before it have taken effect.
//
// racer: { running, timeToStart } now; duration: the last length the MFD
// set (130845), used where the MFD command itself carries none.
function racerCommands (event, racer, duration) {
  if (!event) return []
  racer = racer || {}
  const seconds = event.seconds || duration
  const length = seconds ? [{ command: 'length', seconds: seconds }] : []
  switch (event.command) {
    case 'duration':
      // Like the MFD: a new length resets a stopped timer, not a running one.
      return racer.running ? [] : [{ command: 'length', seconds: event.seconds }]
    case 'reset': return [{ command: 'reset' }].concat(length)
    case 'start':
      // Resume a stopped countdown as is; after the gun start a new one.
      if (event.seconds || !(racer.timeToStart > 0)) return length.concat([{ command: 'start' }])
      return [{ command: 'start' }]
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
  parseTimerDuration,
  parseN2k,
  rawBytes,
  racerCommands,
  lengthToAdjust,
  TIMER_EVENTS
}
