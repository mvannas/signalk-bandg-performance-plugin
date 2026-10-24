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

// Signal K 2.x ships canboatjs 3, which no longer uses the socketcan
// module: it has its own native CanChannel (dist/canSocket.js, same API:
// addListener('onMessage'), start, stop, send). That is the copy that is
// built on the boat, so use it. The socketcan module (canboatjs 1.x, an
// optional dependency of this plugin that rarely builds under ~/.signalk)
// is only a fallback for older servers.
function openCanChannel (iface, { requireFn = require, serverPaths = defaultServerPaths() } = {}) {
  const errors = []
  const note = (err) => errors.push(err.message.split('\n')[0])

  for (const base of serverPaths) {
    let index
    try {
      index = requireFn.resolve('@canboat/canboatjs', { paths: [base] })
    } catch (err) {
      note(err)
      continue
    }
    let CanChannel
    try {
      CanChannel = requireFn(path.join(path.dirname(index), 'canSocket.js')).CanChannel
    } catch (err) {
      note(err)
    }
    if (CanChannel) return new CanChannel(iface)
  }

  const socketcanFrom = [undefined].concat(serverPaths)
  for (const base of socketcanFrom) {
    let socketcan
    try {
      socketcan = base === undefined
        ? requireFn('socketcan')
        : requireFn(requireFn.resolve('socketcan', { paths: [base] }))
    } catch (err) {
      note(err)
      continue
    }
    return socketcan.createRawChannel(iface)
  }
  throw new Error('no CAN socket module found (' + errors[errors.length - 1] + ')')
}

// Where the Signal K server is installed: its entry script, and the
// process' current/argv directories as fallbacks.
function defaultServerPaths (appPath) {
  const paths = []
  const add = (p) => { if (p && !paths.includes(p)) paths.push(p) }
  add(appPath)
  add(require.main && require.main.path)
  add(process.argv[1] && path.dirname(process.argv[1]))
  add(process.cwd())
  return paths
}

module.exports = { detectCanDevice, openCanChannel, defaultServerPaths }
