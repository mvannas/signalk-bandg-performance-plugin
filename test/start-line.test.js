'use strict'

const { test } = require('node:test')
const assert = require('node:assert/strict')
const {
  computeStartLine,
  encodeStartLine,
  encodeStartLineValue,
  keyHex,
  wrapAngle
} = require('../lib/start-line')

// 200 m line running west (pin) → east (committee boat) at 60°N.
const port = { latitude: 60, longitude: 24.99820 }
const stb = { latitude: 60, longitude: 25.00180 }
const midSouth50 = { latitude: 60 - 50 / 111195, longitude: 25 }

function near (actual, expected, tolerance, label) {
  assert.ok(Math.abs(actual - expected) <= tolerance, `${label}: ${actual} not within ${tolerance} of ${expected}`)
}

test('key bytes carry the 12-bit key and the value length', () => {
  assert.equal(keyHex(305, 4), '31,41') // same as the plugin's Bias Advantage key
  assert.equal(keyHex(276, 4), '14,41')
  assert.equal(keyHex(272, 2), '10,21')
  assert.equal(keyHex(117, 4), '75,40')
  assert.equal(keyHex(152, 4), '98,40')
})

test('no line, no values', () => {
  assert.equal(computeStartLine({ port: null, stb }), null)
  assert.equal(computeStartLine({ port, stb: { latitude: 'x', longitude: 1 } }), null)
  assert.equal(encodeStartLine(null), '')
})

test('line geometry from the pre-start side, wind square to the line', () => {
  const v = computeStartLine({ port, stb, position: midSouth50, windDirection: 0, boatLength: 10 })
  near(v.lineBearing, Math.PI / 2, 0.001, 'bearing')
  near(v.lineBias, 0, 0.001, 'bias')
  near(v.biasAdvantage, 0, 0.5, 'bias m')
  near(v.distanceBehindLine, 50, 0.1, 'behind')
  near(v.distanceToLine, 50, 0.1, 'to line')
  near(v.distanceToPort, Math.hypot(100, 50), 0.5, 'to port')
  near(v.distanceToStb, Math.hypot(100, 50), 0.5, 'to stb')
  near(v.distanceToLineBoatLengths, 5, 0.01, 'boat lengths')
  assert.equal(v.portLatitude, 60)
  assert.equal(v.stbLongitude, 25.0018)
})

test('over the line is negative', () => {
  const v = computeStartLine({ port, stb, position: { latitude: 60 + 20 / 111195, longitude: 25 } })
  near(v.distanceBehindLine, -20, 0.1, 'behind')
  near(v.distanceToLine, -20, 0.1, 'to line')
})

test('beyond an end, distance to line is to that end', () => {
  const pos = { latitude: 60 - 30 / 111195, longitude: 25.0018 + 40 / 55597 }
  const v = computeStartLine({ port, stb, position: pos })
  near(v.distanceBehindLine, 30, 0.2, 'behind')
  near(v.distanceToLine, 50, 0.3, 'to line')
})

test('wind veered 10°: starboard end favoured, positive bias', () => {
  const v = computeStartLine({ port, stb, windDirection: 10 * Math.PI / 180, boatLength: 10 })
  near(v.lineBias, 10 * Math.PI / 180, 0.001, 'bias')
  near(v.biasAdvantage, 200 * Math.sin(10 * Math.PI / 180), 0.5, 'bias m')
  near(v.biasAdvantageBoatLengths, 3.47, 0.05, 'bias boat lengths')
  const backed = computeStartLine({ port, stb, windDirection: -10 * Math.PI / 180 })
  assert.ok(backed.lineBias < 0)
  assert.ok(backed.biasAdvantage > 0) // key 305 is unsigned
})

test('bow offset moves the measuring point along the heading', () => {
  const v = computeStartLine({ port, stb, position: midSouth50, heading: 0, gpsFromBow: 8 })
  near(v.distanceBehindLine, 42, 0.1, 'behind')
})

test('bearing wraps into the signed 16-bit range', () => {
  const v = computeStartLine({ port: stb, stb: port })
  near(v.lineBearing, -Math.PI / 2, 0.001, 'bearing')
  assert.equal(wrapAngle(3 * Math.PI / 2), -Math.PI / 2)
})

test('encoding uses canboat resolutions', () => {
  assert.equal(encodeStartLineValue('portLatitude', 60.1234567), '14,41,' + hex32(601234567))
  assert.equal(encodeStartLineValue('portLongitude', -1.5), '15,41,' + hex32(-15000000))
  assert.equal(encodeStartLineValue('distanceToLine', -12.34), '98,40,' + hex32(-1234))
  assert.equal(encodeStartLineValue('lineBearing', -Math.PI / 2), '10,21,' + hex16(-15708))
  assert.equal(encodeStartLineValue('raceTimer', -300), '75,40,' + hex32(-300000))
  assert.equal(encodeStartLineValue('distanceToLineBoatLengths', 2.34), '19,21,' + hex16(23))
  assert.equal(encodeStartLineValue('biasAdvantage', -5), '31,41,00,00,00,00')
  assert.equal(encodeStartLineValue('lineBias', null), null)
})

test('encodeStartLine keeps only enabled keys', () => {
  const values = { portLatitude: 60, biasAdvantage: 3 }
  assert.equal(encodeStartLine(values, new Set(['portLatitude'])), ',14,41,' + hex32(600000000))
})

test('plugin adds start line keys to the full 130824 sample', async () => {
  const self = {
    'navigation.racing.startLinePort': { value: port },
    'navigation.racing.startLineStb': { value: stb },
    'navigation.position': { value: midSouth50 },
    'environment.wind.directionTrue': { value: 0 },
    'navigation.racing.startTime': { value: '2026-10-23T12:00:00Z' },
    'navigation.racing.timeToStart': { value: 120 }
  }
  const sent = []
  const app = {
    debug () {},
    setPluginError () {},
    setPluginStatus () {},
    getSelfPath (p) { return self[p] },
    on () {},
    removeListener () {},
    emit (event, msg) { if (event === 'nmea2000out') sent.push(msg) }
  }
  const plugin = require('../index.js')(app)
  plugin.start({}, () => {})
  await new Promise(resolve => setTimeout(resolve, 250))
  plugin.stop()
  const pgn = sent.find(m => m.split(',')[2] === '130824')
  assert.ok(pgn, 'sent 130824')
  const data = pgn.split(',').slice(6)
  assert.equal(Number(pgn.split(',')[5]), data.length)
  assert.ok(pgn.includes(',14,41,'), 'port latitude')
  assert.ok(pgn.includes(',75,40,' + hex32(-120000)), 'race timer')
  assert.ok(pgn.includes(',2d,41,'), 'distance behind line')
})

function hex32 (n) {
  return [0, 8, 16, 24].map(s => ((n >> s) & 0xff).toString(16).padStart(2, '0')).join(',')
}

function hex16 (n) {
  return [0, 8].map(s => ((n >> s) & 0xff).toString(16).padStart(2, '0')).join(',')
}
