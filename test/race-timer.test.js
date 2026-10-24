'use strict'

const { test } = require('node:test')
const assert = require('node:assert/strict')
const { EventEmitter } = require('node:events')
const {
  parseTimerEvent,
  parseTimerFields,
  parseTimerDuration,
  parseN2k,
  racerCommands,
  lengthToAdjust
} = require('../lib/race-timer')

// Recorded on the boat 2026-10-24 (Zeus at src 15), as the server's
// N2KAnalyzerOut gave them: its canboatjs decodes 130850 as an AP command.
const recordedStart = {
  pgn: 130850, src: 15, dst: 255,
  input: ['can0  09ff220f   [8]  00 0c 41 9f ff ff 01 17', 'can0  09ff220f   [8]  01 3d 00 ff ff ff ff ff'],
  rawData: [65, 159, 255, 255, 1, 23, 61, 0, 255, 255, 255, 255, 255, 0, 0, 0, 0, 0, 0],
  fields: { manufacturerCode: 'Simrad', industryCode: 'Marine Industry', proprietaryId: 'Autopilot', reserved9: 0, reserved15: 0 }
}
const recordedStop = {
  pgn: 130850, src: 15, dst: 255,
  input: ['can0  09ff220f   [8]  20 0c 41 9f ff ff 01 17', 'can0  09ff220f   [8]  21 3e 00 ff ff ff ff ff'],
  rawData: [65, 159, 255, 255, 1, 23, 62, 0, 255, 255, 255, 255, 255, 0, 0, 0, 0, 0, 0],
  fields: { manufacturerCode: 'Simrad', industryCode: 'Marine Industry', proprietaryId: 'Autopilot' }
}
const recordedDuration = {
  pgn: 130845, src: 15, dst: 255,
  input: ['can0  0dff1d0f   [8]  40 0e 41 9f ff ff ff ff', 'can0  0dff1d0f   [8]  41 07 42 00 01 32 00 00', 'can0  0dff1d0f   [8]  42 00 ff ff ff ff ff ff'],
  rawData: [65, 159, 255, 255, 255, 255, 7, 66, 0, 1, 50, 0, 0, 0, 255, 255, 255, 255, 255, 255, 0],
  fields: { manufacturerCode: 'Simrad', industryCode: 'Marine Industry', key: 16903, spare9: 0, minlength: 1 }
}

test('recorded Zeus start, stop and duration', () => {
  assert.equal(parseN2k(recordedStart).command, 'start')
  assert.equal(parseN2k(recordedStart).seconds, undefined)
  assert.equal(parseN2k(recordedStop).command, 'stop')
  assert.deepEqual(parseN2k(recordedDuration), { command: 'duration', seconds: 3000, value: 50 })
})

test('recorded messages also parse from the candump lines alone', () => {
  const noRaw = m => Object.assign({}, m, { rawData: undefined })
  assert.equal(parseN2k(noRaw(recordedStart)).command, 'start')
  assert.equal(parseN2k(noRaw(recordedStop)).command, 'stop')
  assert.equal(parseN2k(noRaw(recordedDuration)).seconds, 3000)
})

test('130845 other keys and reads are ignored', () => {
  const read = recordedDuration.rawData.slice()
  read[9] = 0
  assert.equal(parseTimerDuration(read), null)
  const other = recordedDuration.rawData.slice()
  other[6] = 0x08
  assert.equal(parseTimerDuration(other), null)
})

test('duration and the last known length in Racer steps', () => {
  const d = { command: 'duration', seconds: 300 }
  assert.deepEqual(racerCommands(d, { running: false, timeToStart: 120 }), [{ command: 'length', seconds: 300 }])
  assert.deepEqual(racerCommands(d, { running: true, timeToStart: 120 }), [])
  // Reset from the MFD carries no length: use the last one it set.
  assert.deepEqual(racerCommands({ command: 'reset' }, {}, 300), [{ command: 'reset' }, { command: 'length', seconds: 300 }])
  // Start after a stop resumes; start after the gun begins a new countdown.
  assert.deepEqual(racerCommands({ command: 'start' }, { timeToStart: 95 }, 300), [{ command: 'start' }])
  assert.deepEqual(racerCommands({ command: 'start' }, { timeToStart: 0 }, 300), [{ command: 'length', seconds: 300 }, { command: 'start' }])
})

// 41,9f = Navico; address 0; group 1; event type 23; event LE16; p1; p2 LE16; p3
function frame (event, p2 = 0xffff) {
  return Buffer.from([0x41, 0x9f, 0x00, 0xff, 0x01, 23, event & 0xff, event >> 8, 0xff, p2 & 0xff, p2 >> 8, 0xff])
}

test('raw 130850 timer events', () => {
  assert.equal(parseTimerEvent(frame(61)).command, 'start')
  assert.equal(parseTimerEvent(frame(62)).command, 'stop')
  assert.equal(parseTimerEvent(frame(63)).command, 'sync')
  assert.equal(parseTimerEvent(frame(64)).command, 'reset')
  assert.equal(parseTimerEvent(frame(64)).seconds, undefined)
  assert.equal(parseTimerEvent(frame(64, 300)).seconds, 300)
  assert.equal(parseTimerEvent(frame(65)), null) // trip timer
  const ap = frame(61)
  ap[5] = 10 // AP command
  assert.equal(parseTimerEvent(ap), null)
  assert.equal(parseTimerEvent(Buffer.from([0x41, 0x9f])), null)
})

test('decoded 130850 timer events', () => {
  const n2k = { pgn: 130850, fields: { 'Event Type': 'Timer', Event: 'Race Timer Start', 'Parameter 2': 240 } }
  assert.deepEqual(
    { command: parseTimerFields(n2k).command, seconds: parseTimerFields(n2k).seconds },
    { command: 'start', seconds: 240 }
  )
  assert.equal(parseTimerFields({ pgn: 130850, fields: { 'Event Type': 23, Event: 62 } }).command, 'stop')
  assert.equal(parseTimerFields({ pgn: 130850, fields: { 'Event Type': 'AP Command', Event: 'Race Timer Start' } }), null)
  assert.equal(parseTimerFields({ pgn: 130306, fields: {} }), null)
})

test('MFD commands map to Racer steps', () => {
  assert.deepEqual(racerCommands({ command: 'start' }), [{ command: 'start' }])
  assert.deepEqual(racerCommands({ command: 'start', seconds: 240 }), [{ command: 'length', seconds: 240 }, { command: 'start' }])
  assert.deepEqual(racerCommands({ command: 'reset', seconds: 600 }), [{ command: 'reset' }, { command: 'length', seconds: 600 }])
  assert.deepEqual(racerCommands({ command: 'stop' }), [{ command: 'stop' }])
  assert.deepEqual(racerCommands({ command: 'sync' }), [{ command: 'sync' }])
  assert.deepEqual(lengthToAdjust(240, 300), { command: 'adjust', delta: -60 })
  assert.equal(lengthToAdjust(300, 300), null)
  assert.equal(lengthToAdjust(300, undefined), null)
})

function mockApp (self) {
  const app = new EventEmitter()
  app.sent = []
  app.puts = []
  app.debug = () => {}
  app.setPluginError = () => {}
  app.setPluginStatus = () => {}
  app.getSelfPath = p => self[p]
  const emit = app.emit.bind(app)
  app.emit = (event, msg) => {
    if (event === 'nmea2000out') app.sent.push(msg)
    return emit(event, msg)
  }
  app.putSelfPath = (path, value, cb) => {
    app.puts.push({ path, value })
    if (value.command === 'reset') self['navigation.racing.timeToStart'] = { value: 300 }
    setImmediate(() => cb({ state: 'COMPLETED', statusCode: 200 }))
  }
  return app
}

test('plotter reset with a length, then start, reaches Racer once each', async () => {
  const self = { 'navigation.racing.timeToStart': { value: 120 } }
  const app = mockApp(self)
  const plugin = require('../index.js')(app)
  plugin.start({}, () => {})
  const reset = { pgn: 130850, src: 3, fields: { 'Event Type': 'Timer', Event: 'Race Timer Reset', 'Parameter 2': 240 } }
  app.emit('N2KAnalyzerOut', reset)
  app.emit('N2KAnalyzerOut', reset) // duplicate, ignored
  await new Promise(resolve => setTimeout(resolve, 20))
  app.emit('N2KAnalyzerOut', { pgn: 130850, src: 3, fields: { 'Event Type': 'Timer', Event: 'Race Timer Start' } })
  await new Promise(resolve => setTimeout(resolve, 20))
  plugin.stop()
  assert.deepEqual(app.puts, [
    { path: 'navigation.racing.setStartTime', value: { command: 'reset' } },
    { path: 'navigation.racing.setStartTime', value: { command: 'adjust', delta: -60 } },
    { path: 'navigation.racing.setStartTime', value: { command: 'start' } }
  ])
})

test('recorded Zeus messages reach Racer through N2KAnalyzerOut', async () => {
  const self = { 'navigation.racing.timeToStart': { value: 120 } }
  const app = mockApp(self)
  const plugin = require('../index.js')(app)
  plugin.start({}, () => {})
  app.emit('N2KAnalyzerOut', recordedStart)
  await new Promise(resolve => setTimeout(resolve, 20))
  app.emit('N2KAnalyzerOut', recordedStop)
  await new Promise(resolve => setTimeout(resolve, 20))
  app.emit('N2KAnalyzerOut', recordedDuration)
  await new Promise(resolve => setTimeout(resolve, 20))
  plugin.stop()
  assert.deepEqual(app.puts.map(p => p.value), [
    { command: 'start' },
    { command: 'stop' },
    { command: 'adjust', delta: 2880 }
  ])
})

test('timer from the plotter can be turned off', async () => {
  const app = mockApp({})
  const plugin = require('../index.js')(app)
  plugin.start({ startLine: { timerFromMfd: false } }, () => {})
  app.emit('N2KAnalyzerOut', { pgn: 130850, fields: { 'Event Type': 'Timer', Event: 'Race Timer Start' } })
  await new Promise(resolve => setTimeout(resolve, 20))
  plugin.stop()
  assert.deepEqual(app.puts, [])
})

test('race timer key 117 is sent while Racer runs, without a line', async () => {
  const app = mockApp({
    'navigation.racing.startTime': { value: '2026-10-23T12:00:00Z' },
    'navigation.racing.timeToStart': { value: 90 }
  })
  const plugin = require('../index.js')(app)
  plugin.start({}, () => {})
  await new Promise(resolve => setTimeout(resolve, 250))
  plugin.stop()
  const pgn = app.sent.find(m => m.split(',')[2] === '130824')
  assert.ok(pgn && pgn.includes(',75,40,70,a0,fe,ff'), pgn) // -90000 ms
  assert.ok(!pgn.includes(',14,41,'), 'no line keys')
})
