'use strict'

// Start line keys for B&G 130824, computed from the line ends that
// signalk-racer stores in navigation.racing.startLinePort / startLineStb
// ({ latitude, longitude } in degrees).
//
// Key numbers, widths, signedness and resolution are from canboat's
// BANDG_KEY_VALUE table. Sign conventions are not in canboat and are
// assumptions (see README, "Start line").

const EARTH_RADIUS = 6371008.8

// 130824 keys used here. bytes = value length on the wire.
const KEYS = {
  raceTimer: { key: 117, bytes: 4 }, // ms, signed
  distanceToLine: { key: 152, bytes: 4 }, // 0.01 m, signed
  lineBearing: { key: 272, bytes: 2 }, // 0.0001 rad, signed
  lineBias: { key: 273, bytes: 2 }, // 0.0001 rad, signed
  distanceToPort: { key: 274, bytes: 4 }, // 0.01 m, unsigned
  distanceToStb: { key: 275, bytes: 4 }, // 0.01 m, unsigned
  portLatitude: { key: 276, bytes: 4 }, // 1e-7 deg, signed
  portLongitude: { key: 277, bytes: 4 },
  stbLatitude: { key: 278, bytes: 4 },
  stbLongitude: { key: 279, bytes: 4 },
  biasAdvantageBoatLengths: { key: 280, bytes: 2 }, // 0.1 boat length, signed
  distanceToLineBoatLengths: { key: 281, bytes: 2 },
  distanceBehindLine: { key: 301, bytes: 4 }, // 0.01 m, signed
  distanceBehindLineBoatLengths: { key: 302, bytes: 2 },
  biasAdvantage: { key: 305, bytes: 4 }, // 0.01 m, unsigned
  distanceToPortBoatLengths: { key: 364, bytes: 2 },
  distanceToStbBoatLengths: { key: 365, bytes: 2 },
  timeToBurn: { key: 409, bytes: 4 } // ms, signed
}

function isFiniteNumber (n) {
  return typeof n === 'number' && Number.isFinite(n)
}

function isPosition (p) {
  return !!p && isFiniteNumber(p.latitude) && isFiniteNumber(p.longitude) &&
    Math.abs(p.latitude) <= 90 && Math.abs(p.longitude) <= 180
}

function toRad (deg) {
  return deg * Math.PI / 180
}

// Wrap to [-π, π). Signed 16-bit × 0.0001 rad only reaches ±3.2767.
function wrapAngle (a) {
  a = (a + Math.PI) % (2 * Math.PI)
  if (a < 0) a += 2 * Math.PI
  return a - Math.PI
}

// Local east/north metres of p relative to origin. A start line is a few
// hundred metres at most, so a flat projection is accurate to centimetres.
function toLocal (origin, p) {
  const lat0 = toRad(origin.latitude)
  let dLon = toRad(p.longitude - origin.longitude)
  dLon = wrapAngle(dLon)
  return {
    x: dLon * Math.cos(lat0) * EARTH_RADIUS,
    y: toRad(p.latitude - origin.latitude) * EARTH_RADIUS
  }
}

function fromLocal (origin, v) {
  const lat0 = toRad(origin.latitude)
  return {
    latitude: origin.latitude + (v.y / EARTH_RADIUS) * 180 / Math.PI,
    longitude: origin.longitude + (v.x / (EARTH_RADIUS * Math.cos(lat0))) * 180 / Math.PI
  }
}

// Move the GPS position forward to the bow along the heading.
function bowPosition (position, heading, gpsFromBow) {
  if (!isFiniteNumber(gpsFromBow) || gpsFromBow === 0 || !isFiniteNumber(heading)) {
    return position
  }
  return fromLocal(position, {
    x: Math.sin(heading) * gpsFromBow,
    y: Math.cos(heading) * gpsFromBow
  })
}

// All values in Signal K units (m, rad, s). Returns { name: value } for the
// names in KEYS; a name is missing when its inputs are missing.
//
// input: port, stb, position, heading, windDirection, gpsFromBow,
//        boatLength, timeToStart, timeToBurn
function computeStartLine (input) {
  const { port, stb } = input
  if (!isPosition(port) || !isPosition(stb)) return null

  const out = {
    portLatitude: port.latitude,
    portLongitude: port.longitude,
    stbLatitude: stb.latitude,
    stbLongitude: stb.longitude
  }

  // Line vector, port (pin) → starboard (committee boat).
  const d = toLocal(port, stb)
  const length = Math.hypot(d.x, d.y)
  if (length < 0.01) return out

  const bearing = Math.atan2(d.x, d.y) // true, from north, port → stb
  out.lineBearing = wrapAngle(bearing)

  // Bias: angle between the line's upwind normal and the wind.
  // Positive = starboard end upwind (favoured), matching signalk-racer's
  // navigation.racing.stbLineBias sign.
  let biasMetres
  if (isFiniteNumber(input.windDirection)) {
    const bias = wrapAngle(input.windDirection - (bearing - Math.PI / 2))
    out.lineBias = bias
    biasMetres = length * Math.sin(bias)
    out.biasAdvantage = Math.abs(biasMetres)
  }

  const boatLength = isFiniteNumber(input.boatLength) && input.boatLength > 0
    ? input.boatLength
    : undefined

  if (isFiniteNumber(biasMetres) && boatLength) {
    out.biasAdvantageBoatLengths = biasMetres / boatLength
  }

  if (isPosition(input.position)) {
    const bow = bowPosition(input.position, input.heading, input.gpsFromBow)
    const v = toLocal(port, bow)
    const toPort = Math.hypot(v.x, v.y)
    const w = toLocal(stb, bow)
    const toStb = Math.hypot(w.x, w.y)

    // Signed perpendicular distance to the extended line. The course side
    // is to the left of port → stb, so positive = behind the line (pre-start
    // side) and negative = over the line.
    const cross = d.x * v.y - d.y * v.x
    const behind = -cross / length

    // Distance to the line segment (nearest point, clamped to the ends),
    // with the same sign as behind.
    const t = (v.x * d.x + v.y * d.y) / (length * length)
    let toLine
    if (t <= 0) toLine = toPort
    else if (t >= 1) toLine = toStb
    else toLine = Math.abs(behind)
    if (behind < 0) toLine = -toLine

    out.distanceToPort = toPort
    out.distanceToStb = toStb
    out.distanceBehindLine = behind
    out.distanceToLine = toLine

    if (boatLength) {
      out.distanceToPortBoatLengths = toPort / boatLength
      out.distanceToStbBoatLengths = toStb / boatLength
      out.distanceBehindLineBoatLengths = behind / boatLength
      out.distanceToLineBoatLengths = toLine / boatLength
    }
  }

  if (isFiniteNumber(input.timeToStart)) {
    // Countdown before the start is negative, like a B&G race timer.
    out.raceTimer = -input.timeToStart
  }
  if (isFiniteNumber(input.timeToBurn)) {
    out.timeToBurn = input.timeToBurn
  }

  return out
}

function keyHex (key, bytes) {
  const word = (key & 0xfff) | ((bytes & 0xf) << 12)
  return hexBytes(word, 2)
}

function hexBytes (integer, bytes) {
  const out = []
  for (let i = 0; i < bytes; i++) {
    out.push(((integer >> (8 * i)) & 0xff).toString(16).padStart(2, '0'))
  }
  return out.join(',')
}

const SCALES = {
  raceTimer: 1000,
  timeToBurn: 1000,
  lineBearing: 10000,
  lineBias: 10000,
  portLatitude: 1e7,
  portLongitude: 1e7,
  stbLatitude: 1e7,
  stbLongitude: 1e7,
  biasAdvantageBoatLengths: 10,
  distanceToLineBoatLengths: 10,
  distanceBehindLineBoatLengths: 10,
  distanceToPortBoatLengths: 10,
  distanceToStbBoatLengths: 10
}

const UNSIGNED = new Set(['distanceToPort', 'distanceToStb', 'biasAdvantage'])

// Encode one value as "<key>,<value>" hex for the 130824 tail, or null.
function encodeStartLineValue (name, value) {
  const spec = KEYS[name]
  if (!spec || !isFiniteNumber(value)) return null
  const scale = SCALES[name] || 100 // metres → 0.01 m
  let n = Math.round(value * scale)
  const bits = spec.bytes * 8
  if (UNSIGNED.has(name)) {
    n = Math.max(0, Math.min(n, 2 ** bits - 2))
  } else {
    const max = 2 ** (bits - 1) - 1
    n = Math.max(-max, Math.min(n, max - 1))
  }
  return keyHex(spec.key, spec.bytes) + ',' + hexBytes(n, spec.bytes)
}

// Encoded tail in a fixed key order (ignores names not in `enabled`).
function encodeStartLine (values, enabled) {
  if (!values) return ''
  let tail = ''
  for (const name of Object.keys(KEYS)) {
    if (enabled && !enabled.has(name)) continue
    const hex = encodeStartLineValue(name, values[name])
    if (hex) tail += ',' + hex
  }
  return tail
}

module.exports = {
  START_LINE_KEYS: KEYS,
  computeStartLine,
  encodeStartLine,
  encodeStartLineValue,
  keyHex,
  wrapAngle
}
