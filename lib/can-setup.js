'use strict'

const path = require('path')

// CAN interface of the first enabled Signal K NMEA 2000 socketcan provider.
// Signal K 1.x: providers/canbus { canDevice }. Signal K 2.x admin UI:
// providers/simple { type: 'NMEA2000', subOptions: { type: 'canbus-canboatjs', interface } }.
function detectCanDevice (settings) {
  const providers = (settings && settings.pipedProviders) || []
  for (const provider of providers) {
    if (!provider || provider.enabled === false) continue
    for (const element of provider.pipeElements || []) {
      const options = (element && element.options) || {}
      if (element.type === 'providers/canbus' && options.canDevice) {
        return options.canDevice
      }
      const sub = options.subOptions || {}
      if (element.type === 'providers/simple' && options.type === 'NMEA2000' &&
          /^canbus/.test(sub.type || '')) {
        const iface = sub.interface || sub.canDevice
        if (iface) return iface
      }
    }
  }
  return undefined
}

// socketcan is a native module that comes with Signal K's own canboatjs,
// not with this plugin's copy (it is optional there and usually fails to
// build under ~/.signalk). Look for it in the plugin, then in the server.
function loadSocketcan (requireFn = require, mainPath = require.main && require.main.path) {
  const bases = []
  const tryBase = (fn) => { try { const b = fn(); if (b) bases.push(b) } catch (err) {} }
  tryBase(() => path.dirname(requireFn.resolve('@canboat/canboatjs')))
  tryBase(() => mainPath)
  tryBase(() => path.dirname(requireFn.resolve('@canboat/canboatjs', { paths: [mainPath] })))
  tryBase(() => path.dirname(requireFn.resolve('signalk-server/package.json', { paths: [mainPath] })))

  const errors = []
  try {
    return requireFn('socketcan')
  } catch (err) {
    errors.push(err.message.split('\n')[0])
  }
  for (const base of bases) {
    try {
      return requireFn(requireFn.resolve('socketcan', { paths: [base] }))
    } catch (err) {
      errors.push(err.message.split('\n')[0])
    }
  }
  throw new Error('socketcan not found (' + errors[errors.length - 1] + ')')
}

module.exports = { detectCanDevice, loadSocketcan }
