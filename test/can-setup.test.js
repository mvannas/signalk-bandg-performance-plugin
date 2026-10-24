'use strict'

const { test } = require('node:test')
const assert = require('node:assert/strict')
const { detectCanDevice, loadSocketcan } = require('../lib/can-setup')

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

test('socketcan falls back to the server tree', () => {
  const fake = { createRawChannel () {} }
  const requireFn = (id) => {
    if (id === '/server/node_modules/socketcan/index.js') return fake
    throw new Error(`Cannot find module '${id}'`)
  }
  requireFn.resolve = (id, opts) => {
    if (id === 'socketcan' && opts && opts.paths[0] === '/server') return '/server/node_modules/socketcan/index.js'
    throw new Error(`Cannot find module '${id}'`)
  }
  assert.equal(loadSocketcan(requireFn, '/server'), fake)
  assert.throws(() => loadSocketcan(requireFn, '/elsewhere'), /socketcan not found/)
})
