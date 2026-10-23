'use strict'

const { test, mock } = require('node:test')
const assert = require('node:assert/strict')
const { FromPgn } = require('@canboat/canboatjs')
const { parseCanId: canboatParseCanId } = require('@canboat/canboatjs/lib/canId')
const {
  H5000Device,
  encodeName,
  encodeProductInfo,
  encodeConfigInfo,
  encodeHeartbeat,
  encodePgnList,
  encodeCanId,
  parseCanId,
  freeAddress
} = require('../lib/h5000-device')

const hexBytes = (s) => s.split(',').map(h => parseInt(h, 16))

// H5000 Hercules CPU, canboat samples live.all / ap48-tack.all, src 38.
const REAL_CLAIM = '27,07,bd,2f,00,be,78,c0'
const REAL_PRODUCT = '34,08,a2,63,48,65,72,63,75,6c,65,73,20,' + Array(23).fill('ff').join(',') +
  ',34,2e,30,2d,35,2e,30,2e,31,36,30,' + Array(21).fill('ff').join(',') +
  ',' + Array(32).fill('ff').join(',') +
  ',31,32,30,39,38,31,32,38,37,' + Array(23).fill('20').join(',') + ',02,01'

test('NAME matches a real H5000 CPU byte for byte', () => {
  assert.deepEqual([...encodeName({ uniqueNumber: 1902375 })], hexBytes(REAL_CLAIM))
})

test('product information matches a real H5000 CPU byte for byte', () => {
  const real = hexBytes(REAL_PRODUCT)
  assert.equal(real.length, 134)
  assert.deepEqual([...encodeProductInfo({ serialCode: '120981287' })], real)
})

test('canboat decodes the emulated identity as B&G Navigation, Hercules', () => {
  const parser = new FromPgn()
  const decoded = []
  parser.on('pgn', (pgn) => decoded.push(pgn))
  const line = (pgn, data) => `2026-10-23T00:00:00.000Z,6,${pgn},38,255,${data.length},` +
    [...data].map(b => b.toString(16).padStart(2, '0')).join(',')
  parser.parseString(line(60928, encodeName({ uniqueNumber: 1731561 })))
  parser.parseString(line(126996, encodeProductInfo()))
  const claim = decoded.find(p => p.pgn === 60928).fields
  assert.equal(claim['Manufacturer Code'], 'B&G')
  assert.equal(claim['Device Function'], 190)
  assert.equal(claim['Device Class'], 'Navigation')
  assert.equal(claim['Industry Group'], 'Marine')
  const product = decoded.find(p => p.pgn === 126996).fields
  assert.equal(product['Product Code'], 25506)
  assert.equal(product['Model ID'], 'Hercules ')
  assert.equal(product['Software Version Code'], '4.0-5.0.160')
  assert.equal(product['Load Equivalency'], 1)
})

test('configuration information and heartbeat match the real CPU', () => {
  assert.deepEqual([...encodeConfigInfo()], hexBytes('02,01,02,01,02,01'))
  assert.deepEqual([...encodeHeartbeat(4)], hexBytes('60,ea,04,ff,ff,ff,ff,ff'))
})

test('PGN list is function code then 3-byte PGNs', () => {
  assert.deepEqual([...encodePgnList(0, [60928, 130824])], [0, 0x00, 0xee, 0x00, 0x08, 0xff, 0x01])
})

test('CAN ids put the destination in PDU1 ids only', () => {
  assert.equal(encodeCanId(6, 60928, 38, 255), 0x18eeff26)
  assert.equal(encodeCanId(6, 59904, 30, 38), 0x18ea261e)
  assert.equal(encodeCanId(6, 126996, 38, 255), 0x19f01426)
  assert.equal(encodeCanId(3, 130824, 38, 255), 0x0dff0826)
  for (const id of [0x18eeff26, 0x18ea261e, 0x19f01426, 0x0dff0826]) {
    const ours = parseCanId(id)
    const theirs = canboatParseCanId(id)
    assert.deepEqual([ours.prio, ours.pgn, ours.src, ours.dst], [theirs.prio, theirs.pgn, theirs.src, theirs.dst])
  }
})

test('free address skips taken ones and wraps', () => {
  assert.equal(freeAddress(14, new Set([14, 15])), 16)
  assert.equal(freeAddress(251, new Set([251])), 0)
})

function fakeChannel () {
  const listeners = []
  return {
    sent: [],
    stopped: false,
    addListener (event, fn) { listeners.push(fn) },
    start () {},
    stop () { this.stopped = true },
    send (frame) { this.sent.push(Object.assign(parseCanId(frame.id), { data: [...frame.data] })) },
    receive (prio, pgn, src, dst, data) {
      listeners.forEach(fn => fn({ id: encodeCanId(prio, pgn, src, dst), data: Buffer.from(data) }))
    },
    take () { const s = this.sent; this.sent = []; return s }
  }
}

const WIND_SENSOR_NAME = [...encodeName({ uniqueNumber: 1083224, deviceFunction: 130, deviceClass: 85 })]

function startDevice (channel) {
  const device = new H5000Device({
    channel,
    preferredAddress: 14,
    transmitPGNs: [130824],
    receivePGNs: [130850]
  })
  device.start()
  return device
}

test('claims the next free address when the preferred one is taken', () => {
  mock.timers.enable({ apis: ['setTimeout', 'setInterval'] })
  try {
    const channel = fakeChannel()
    const device = startDevice(channel)
    const first = channel.take()
    assert.equal(first.length, 1)
    assert.deepEqual([first[0].pgn, first[0].src, first[0].dst, ...first[0].data], [59904, 254, 255, 0x00, 0xee, 0x00])

    channel.receive(6, 60928, 14, 255, WIND_SENSOR_NAME)
    mock.timers.tick(1000)
    const claim = channel.take()
    assert.deepEqual(claim.map(f => [f.pgn, f.src]), [[60928, 15]])
    assert.equal(device.cansend, false)

    mock.timers.tick(250)
    assert.equal(device.cansend, true)
    assert.equal(device.address, 15)
    const announce = channel.take()
    assert.ok(announce.some(f => f.pgn === 126996 && f.src === 15))
    assert.ok(announce.some(f => f.pgn === 126993 && f.src === 15 && f.data[0] === 0x60))

    mock.timers.tick(60000)
    const beat = channel.take()
    assert.deepEqual(beat.map(f => [f.pgn, f.data[2]]), [[126993, 1]])
    device.stop()
    assert.equal(channel.stopped, true)
  } finally {
    mock.timers.reset()
  }
})

test('answers ISO requests like the real CPU and NAKs the rest', () => {
  mock.timers.enable({ apis: ['setTimeout', 'setInterval'] })
  try {
    const channel = fakeChannel()
    const device = startDevice(channel)
    mock.timers.tick(1000)
    mock.timers.tick(250)
    channel.take()

    channel.receive(6, 59904, 30, 14, [0x16, 0xf0, 0x01]) // 126998
    channel.receive(6, 59904, 27, 255, [0x00, 0xee, 0x00]) // 60928
    channel.receive(6, 59904, 49, 14, [0x14, 0xf0, 0x01]) // 126996
    channel.receive(6, 59904, 49, 14, [0x00, 0xf2, 0x01]) // 127488: not ours
    channel.receive(6, 59904, 49, 255, [0x00, 0xf2, 0x01]) // global: stay quiet
    channel.receive(6, 59904, 49, 20, [0x14, 0xf0, 0x01]) // someone else
    const out = channel.take()
    assert.deepEqual(out.find(f => f.pgn === 126998).data, hexBytes('02,01,02,01,02,01'))
    assert.deepEqual(out.find(f => f.pgn === 60928).data, [...device.name])
    assert.equal(out.filter(f => f.pgn === 126996 && (f.data[0] & 0x1f) === 0).length, 1)
    const nak = out.filter(f => f.pgn === 59392)
    assert.equal(nak.length, 1)
    assert.equal(nak[0].dst, 49)
    assert.deepEqual(nak[0].data, [0x01, 0xff, 0xff, 0xff, 0xff, 0x00, 0xf2, 0x01])

    channel.receive(6, 59904, 49, 14, [0x00, 0xee, 0x01]) // 126464
    const lists = channel.take().filter(f => f.pgn === 126464 && (f.data[0] & 0x1f) === 0)
    assert.deepEqual(lists.map(f => f.data[2]), [0, 1])
    device.stop()
  } finally {
    mock.timers.reset()
  }
})

test('address contention follows NAME priority', () => {
  mock.timers.enable({ apis: ['setTimeout', 'setInterval'] })
  try {
    const channel = fakeChannel()
    const device = startDevice(channel)
    mock.timers.tick(1000)
    mock.timers.tick(250)
    channel.take()

    // A higher NAME (lower priority) on our address: we keep it.
    const higher = [...device.name]
    higher[7] = 0xff
    channel.receive(6, 60928, 14, 255, higher)
    assert.deepEqual(channel.take().map(f => [f.pgn, f.src]), [[60928, 14]])
    assert.equal(device.address, 14)

    // A lower NAME on our address: we move on.
    const lower = [...device.name]
    lower[0] = 0x00
    lower[7] = 0x00
    channel.receive(6, 60928, 14, 255, lower)
    assert.equal(device.address, 15)
    assert.equal(device.cansend, false)
    mock.timers.tick(250)
    assert.equal(device.cansend, true)
    device.stop()
  } finally {
    mock.timers.reset()
  }
})

test('sendPGN sends long lines as a fast packet from the claimed address', () => {
  mock.timers.enable({ apis: ['setTimeout', 'setInterval'] })
  try {
    const channel = fakeChannel()
    const device = startDevice(channel)
    channel.take()
    device.sendPGN('x,2,130306,1,255,8,ff,10,00,00,00,fa,ff,ff')
    assert.equal(channel.take().length, 0, 'nothing before the claim')
    mock.timers.tick(1000)
    mock.timers.tick(250)
    channel.take()
    device.sendPGN('x,2,130306,1,255,8,ff,10,00,00,00,fa,ff,ff')
    device.sendPGN('x,2,129284,1,255,10,00,01,02,03,04,05,06,07,08,09')
    const out = channel.take()
    assert.deepEqual(out.map(f => [f.pgn, f.src, f.prio]), [[130306, 14, 2], [129284, 14, 2], [129284, 14, 2]])
    assert.equal(out[1].data[1], 10)
    device.stop()
  } finally {
    mock.timers.reset()
  }
})
