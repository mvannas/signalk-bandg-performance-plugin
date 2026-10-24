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
    if (CanChannel) return withWriteFrame(new CanChannel(iface), path.dirname(index), requireFn)
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

// CanChannel.send ignores the result of the native write, so a full kernel
// queue loses the frame silently. Give the channel a writeFrame() that
// returns it (-errno on failure), using the same native module.
function withWriteFrame (channel, distDir, requireFn) {
  let native
  for (const build of ['Release', 'Debug']) {
    try {
      native = requireFn(path.join(distDir, '..', 'build', build, 'canSocket.node'))
      break
    } catch (err) {}
  }
  if (!native || typeof native.writeCanFrame !== 'function' || typeof channel.writeFd !== 'number') {
    return channel
  }
  channel.writeFrame = (msg) => {
    if (channel.stopped) return 0
    const frame = Buffer.alloc(16)
    frame.writeUInt32LE(((msg.id >>> 0) | (msg.ext ? 0x80000000 : 0)) >>> 0, 0)
    frame[4] = msg.data.length
    msg.data.copy(frame, 8, 0, Math.min(msg.data.length, 8))
    return native.writeCanFrame(channel.writeFd, frame)
  }
  return channel
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
