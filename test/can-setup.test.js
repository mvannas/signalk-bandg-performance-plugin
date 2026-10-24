'use strict'

const { test } = require('node:test')
const assert = require('node:assert/strict')
const { detectCanDevice, openCanChannel } = require('../lib/can-setup')

test('finds the interface of a Signal K 2.x canboatjs provider', () => {
  const settings = {
    pipedProviders: [
      { enabled: true, pipeElements: [{ type: 'providers/simple', options: { type: 'NMEA0183', subOptions: { type: 'tcp' } } }] },
      { enabled: true, pipeElements: [{ type: 'providers/simple', options: { type: 'NMEA2000', subOptions: { type: 'canbus-canboatjs', interface: 'can1' } } }] }
    ]
  }
  assert.equal(detectCanDevice(settings), 'can1')
})

test('finds a Signal K 1.x canbus provider and skips disabled ones', () => {
  const settings = {
    pipedProviders: [
      { enabled: false, pipeElements: [{ type: 'providers/canbus', options: { canDevice: 'can9' } }] },
      { enabled: true, pipeElements: [{ type: 'providers/canbus', options: { canDevice: 'can0' } }] }
    ]
  }
  assert.equal(detectCanDevice(settings), 'can0')
})

test('no providers is not an error', () => {
  assert.equal(detectCanDevice(undefined), undefined)
  assert.equal(detectCanDevice({}), undefined)
})

test('uses the CanChannel of the server\'s canboatjs 3', () => {
  class CanChannel { constructor (iface) { this.iface = iface } }
  const requireFn = (id) => {
    if (id === '/server/node_modules/@canboat/canboatjs/dist/canSocket.js') return { CanChannel }
    throw new Error(`Cannot find module '${id}'`)
  }
  requireFn.resolve = (id, opts) => {
    if (id === '@canboat/canboatjs' && opts.paths[0] === '/server') return '/server/node_modules/@canboat/canboatjs/dist/index.js'
    throw new Error(`Cannot find module '${id}'`)
  }
  const channel = openCanChannel('can0', { requireFn, serverPaths: ['/plugin', '/server'] })
  assert.ok(channel instanceof CanChannel)
  assert.equal(channel.iface, 'can0')
})

test('falls back to the socketcan module on older servers', () => {
  const fake = { createRawChannel (iface) { return { iface } } }
  const requireFn = (id) => {
    if (id === '/server/node_modules/socketcan/index.js') return fake
    throw new Error(`Cannot find module '${id}'`)
  }
  requireFn.resolve = (id, opts) => {
    if (id === '@canboat/canboatjs') return '/server/node_modules/@canboat/canboatjs/lib/index.js'
    if (id === 'socketcan' && opts.paths[0] === '/server') return '/server/node_modules/socketcan/index.js'
    throw new Error(`Cannot find module '${id}'`)
  }
  assert.equal(openCanChannel('can1', { requireFn, serverPaths: ['/server'] }).iface, 'can1')
  assert.throws(() => openCanChannel('can1', { requireFn, serverPaths: ['/elsewhere'] }), /no CAN socket module found/)
})

test('the server CanChannel gets a writeFrame that reports the native result', () => {
  const written = []
  class CanChannel { constructor () { this.writeFd = 7; this.stopped = false } }
  const native = { writeCanFrame (fd, frame) { written.push([fd, frame]); return -105 } }
  const requireFn = (id) => {
    if (id === '/s/node_modules/@canboat/canboatjs/dist/canSocket.js') return { CanChannel }
    if (id === '/s/node_modules/@canboat/canboatjs/build/Release/canSocket.node') return native
    throw new Error(`Cannot find module '${id}'`)
  }
  requireFn.resolve = () => '/s/node_modules/@canboat/canboatjs/dist/index.js'
  const channel = openCanChannel('can0', { requireFn, serverPaths: ['/s'] })
  assert.equal(channel.writeFrame({ id: 0x19f01414, ext: true, data: Buffer.from([1, 2, 3]) }), -105)
  const [fd, frame] = written[0]
  assert.equal(fd, 7)
  assert.equal(frame.readUInt32LE(0), (0x19f01414 | 0x80000000) >>> 0)
  assert.equal(frame[4], 3)
  assert.deepEqual([...frame.subarray(8, 11)], [1, 2, 3])
})
