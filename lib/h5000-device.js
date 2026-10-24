'use strict'

// NMEA 2000 network identity of an H5000 CPU, sent on a raw socketcan
// channel. Replaces canboatjs 1.x SimpleCan/CanDevice, which presented as
// Navico "Internal Environment", never sent a heartbeat or 126998, did not
// answer 126998 requests and compared NAMEs from Signal K 2.x camelCase
// fields (wrong result, so the address walked).
//
// Every byte below is copied from a real H5000 Hercules CPU, firmware
// 4.0-5.0.160 (canboat samples live.all / ap48-tack.all, src 38):
//   60928  27,07,bd,2f,00,be,78,c0   B&G 381, function 190, class 60 Navigation
//   126996 34,08,a2,63,"Hercules " … 134 bytes, 0xff padded, serial space padded
//   126998 02,01,02,01,02,01         three empty strings
//   126993 60,ea,<seq>,ff,ff,ff,ff,ff  every 60 s

const EventEmitter = require('events')
const { fastPacketFrames } = require('./performance-pgn')

const ISO_REQUEST = 59904
const ISO_ACK = 59392
const ADDRESS_CLAIM = 60928
const PGN_LIST = 126464
const HEARTBEAT = 126993
const PRODUCT_INFO = 126996
const CONFIG_INFO = 126998

const NULL_ADDRESS = 254
const MAX_ADDRESS = 251
const HEARTBEAT_MS = 60000

const DEFAULT_NAME = {
  uniqueNumber: 1731561,
  manufacturerCode: 381, // B&G
  deviceInstanceLower: 0,
  deviceInstanceUpper: 0,
  deviceFunction: 190, // Navigation management
  deviceClass: 60, // Navigation
  systemInstance: 0,
  industryGroup: 4, // Marine
  arbitraryAddressCapable: 1
}

const DEFAULT_PRODUCT = {
  nmea2000Version: 2100,
  productCode: 25506,
  modelId: 'Hercules ',
  softwareVersion: '4.0-5.0.160',
  modelVersion: '',
  serialCode: '1731561',
  certificationLevel: 2,
  loadEquivalency: 1
}

function encodeName (n) {
  n = Object.assign({}, DEFAULT_NAME, n)
  const low = ((n.uniqueNumber & 0x1fffff) | ((n.manufacturerCode & 0x7ff) << 21)) >>> 0
  const b = Buffer.alloc(8)
  b.writeUInt32LE(low, 0)
  b[4] = (n.deviceInstanceLower & 7) | ((n.deviceInstanceUpper & 0x1f) << 3)
  b[5] = n.deviceFunction & 0xff
  b[6] = (n.deviceClass & 0x7f) << 1
  b[7] = (n.systemInstance & 0xf) | ((n.industryGroup & 7) << 4) | ((n.arbitraryAddressCapable & 1) << 7)
  return b
}

function nameValue (buf) {
  return buf.readBigUInt64LE(0)
}

function fixedString (text, pad) {
  const b = Buffer.alloc(32, pad)
  Buffer.from(String(text || ''), 'latin1').copy(b, 0, 0, 32)
  return b
}

function encodeProductInfo (p) {
  p = Object.assign({}, DEFAULT_PRODUCT, p)
  const head = Buffer.alloc(4)
  head.writeUInt16LE(p.nmea2000Version, 0)
  head.writeUInt16LE(p.productCode, 2)
  return Buffer.concat([
    head,
    fixedString(p.modelId, 0xff),
    fixedString(p.softwareVersion, 0xff),
    fixedString(p.modelVersion, 0xff),
    fixedString(p.serialCode, 0x20),
    Buffer.from([p.certificationLevel, p.loadEquivalency])
  ])
}

// Installation description 1, 2 and manufacturer info: empty STRING_LAU.
function encodeConfigInfo () {
  return Buffer.from([0x02, 0x01, 0x02, 0x01, 0x02, 0x01])
}

function encodeHeartbeat (sequence) {
  return Buffer.from([HEARTBEAT_MS & 0xff, HEARTBEAT_MS >> 8, sequence & 0xff, 0xff, 0xff, 0xff, 0xff, 0xff])
}

function encodePgnList (functionCode, pgns) {
  const b = Buffer.alloc(1 + pgns.length * 3)
  b[0] = functionCode
  pgns.forEach((pgn, i) => b.writeUIntLE(pgn, 1 + i * 3, 3))
  return b
}

// ISO NAK: control 1, group function 0xff, reserved, requested PGN.
function encodeNak (pgn) {
  const b = Buffer.from([0x01, 0xff, 0xff, 0xff, 0xff, 0, 0, 0])
  b.writeUIntLE(pgn, 5, 3)
  return b
}

function isPdu1 (pgn) {
  return ((pgn >> 8) & 0xff) < 240
}

// PDU1 (PF < 240) carries the destination in the PS byte of the id.
function encodeCanId (prio, pgn, src, dst) {
  const ps = isPdu1(pgn) ? dst : pgn
  return (((prio & 7) << 26) | (((pgn >> 8) & 0x3ff) << 16) | ((ps & 0xff) << 8) | (src & 0xff)) >>> 0
}

function parseCanId (id) {
  const prio = (id >> 26) & 7
  const src = id & 0xff
  const pf = (id >> 16) & 0xff
  const ps = (id >> 8) & 0xff
  const dp = (id >> 24) & 3
  if (pf < 240) {
    return { prio, src, dst: ps, pgn: (dp << 16) | (pf << 8) }
  }
  return { prio, src, dst: 255, pgn: (dp << 16) | (pf << 8) | ps }
}

// Next address from `start` (inclusive) that nobody else holds.
function freeAddress (start, taken) {
  for (let i = 0; i <= MAX_ADDRESS; i++) {
    const a = (start + i) % (MAX_ADDRESS + 1)
    if (!taken.has(a)) return a
  }
  return NULL_ADDRESS
}

class H5000Device extends EventEmitter {
  constructor (options) {
    super()
    this.channel = options.channel
    this.preferredAddress = Number.isInteger(options.preferredAddress) ? options.preferredAddress : 14
    this.name = encodeName(options.name)
    this.product = encodeProductInfo(options.productInfo)
    this.transmitPGNs = options.transmitPGNs || []
    this.receivePGNs = options.receivePGNs || []
    this.debug = options.debug || (() => {})
    this.listenMs = options.listenMs == null ? 1000 : options.listenMs
    this.address = NULL_ADDRESS
    this.cansend = false
    this.others = new Map() // address -> NAME (BigInt) of other devices
    this.active = new Set() // addresses heard sending anything
    this.heartbeatSequence = 0
    this.fastSequence = Object.create(null)
    this.timers = []
    this.messageCb = null
    this.framesReceived = 0
    this.lastError = null
  }

  // SimpleCan used to expose these; index.js still reads them.
  get candevice () { return this }

  start () {
    this.channel.addListener('onMessage', (msg) => this.onFrame(msg))
    try {
      this.channel.start()
    } catch (err) {
      this.fail(err)
      return
    }
    // Ask everyone for their claim, then pick an address nobody holds.
    this.sendFrame(6, ISO_REQUEST, 255, Buffer.from([0x00, 0xee, 0x00]), NULL_ADDRESS)
    this.later(() => this.claim(freeAddress(this.preferredAddress, this.takenAddresses())), this.listenMs)
  }

  stop () {
    this.cansend = false
    this.timers.forEach(t => { clearTimeout(t); clearInterval(t) })
    this.timers = []
    try { this.channel.stop() } catch (err) { this.debug('channel stop: %s', err.message) }
  }

  later (fn, ms) {
    this.timers.push(setTimeout(fn, ms))
  }

  takenAddresses () {
    const ours = nameValue(this.name)
    const taken = new Set()
    for (const [addr, name] of this.others) {
      if (name !== ours) taken.add(addr)
    }
    // Some devices never answer a claim request but still use an address.
    for (const addr of this.active) {
      if (addr !== this.address) taken.add(addr)
    }
    return taken
  }

  claim (address) {
    this.cansend = false
    this.address = address
    this.sendFrame(6, ADDRESS_CLAIM, 255, this.name)
    if (address === NULL_ADDRESS) {
      this.emit('address', address)
      return
    }
    // ISO 11783-5: wait 250 ms for a contending claim before sending data.
    const claimed = address
    this.later(() => {
      if (this.address !== claimed) return
      this.cansend = true
      this.debug('H5000 claimed address %d', claimed)
      this.emit('address', claimed)
      this.announce()
    }, 250)
  }

  announce () {
    this.sendFast(6, PRODUCT_INFO, this.product)
    this.sendHeartbeat()
    if (!this.heartbeatTimer) {
      this.heartbeatTimer = setInterval(() => this.sendHeartbeat(), HEARTBEAT_MS)
      this.timers.push(this.heartbeatTimer)
    }
  }

  sendHeartbeat () {
    if (!this.cansend) return
    this.sendFrame(7, HEARTBEAT, 255, encodeHeartbeat(this.heartbeatSequence))
    this.heartbeatSequence = (this.heartbeatSequence + 1) % 253
  }

  // Reported once per distinct message, so a down interface does not flood.
  fail (err) {
    if (this.lastError === err.message) return
    this.lastError = err.message
    this.debug('H5000 CAN error: %s', err.message)
    if (this.listenerCount('error')) this.emit('error', err)
  }

  onFrame (msg) {
    this.framesReceived++
    const id = parseCanId(msg.id)
    if (id.src <= MAX_ADDRESS && id.src !== this.address) this.active.add(id.src)
    if (id.src === this.address && id.src !== NULL_ADDRESS) {
      // Someone else on our address (we never receive our own frames).
      if (id.pgn !== ADDRESS_CLAIM) return
    }
    if (id.pgn === ADDRESS_CLAIM && msg.data.length >= 8) {
      this.onClaim(id.src, msg.data)
    } else if (id.pgn === ISO_REQUEST && msg.data.length >= 3) {
      if (id.dst === 255 || id.dst === this.address) {
        this.onRequest(id.src, id.dst, msg.data.readUIntLE(0, 3))
      }
    }
    if (this.messageCb) {
      this.messageCb({ pgn: id, length: msg.data.length, data: msg.data })
    }
  }

  onClaim (src, data) {
    if (src > MAX_ADDRESS) return // cannot-claim or global
    const theirs = nameValue(data)
    const ours = nameValue(this.name)
    if (theirs === ours) return
    this.others.set(src, theirs)
    if (src !== this.address) return
    if (ours < theirs) {
      this.debug('address %d contended by a higher NAME; claiming again', src)
      this.sendFrame(6, ADDRESS_CLAIM, 255, this.name)
    } else {
      this.debug('address %d lost to a lower NAME; moving', src)
      this.claim(freeAddress(src + 1, this.takenAddresses()))
    }
  }

  onRequest (src, dst, pgn) {
    if (pgn === ADDRESS_CLAIM) {
      this.sendFrame(6, ADDRESS_CLAIM, 255, this.name)
      return
    }
    if (!this.cansend) return
    switch (pgn) {
      case PRODUCT_INFO:
        this.sendFast(6, PRODUCT_INFO, this.product)
        break
      case CONFIG_INFO:
        this.sendFrame(6, CONFIG_INFO, 255, encodeConfigInfo())
        break
      case HEARTBEAT:
        this.sendHeartbeat()
        break
      case PGN_LIST:
        this.sendFast(6, PGN_LIST, encodePgnList(0, this.transmitPGNs))
        this.sendFast(6, PGN_LIST, encodePgnList(1, this.receivePGNs))
        break
      default:
        if (dst === this.address) this.sendFrame(6, ISO_ACK, src, encodeNak(pgn))
    }
  }

  sendFrame (prio, pgn, dst, data, src) {
    const from = src == null ? this.address : src
    this.write({ id: encodeCanId(prio, pgn, from, dst), ext: true, data: data })
  }

  sendFast (prio, pgn, payload, dst) {
    const seq = this.fastSequence[pgn] = ((this.fastSequence[pgn] || 0) + 1) & 7
    const id = encodeCanId(prio, pgn, this.address, dst == null ? 255 : dst)
    for (const frame of fastPacketFrames(payload, seq)) {
      this.write({ id: id, ext: true, data: frame })
    }
  }

  write (frame) {
    try {
      this.channel.send(frame)
      this.lastError = null
    } catch (err) {
      this.fail(err)
    }
  }

  // Actisense line "<time>,<prio>,<pgn>,<src>,<dst>,<len>,<hex>…" from this
  // device's address; src in the line is ignored. Over 8 bytes is a fast packet.
  sendPGN (line) {
    if (!this.cansend) return
    const parts = line.split(',')
    const prio = Number(parts[1])
    const pgn = Number(parts[2])
    const dst = Number(parts[4])
    const len = Number(parts[5])
    const data = Buffer.from(parts.slice(6, 6 + len).map(h => parseInt(h, 16)))
    if (data.length > 8) {
      this.sendFast(prio, pgn, data, dst)
    } else {
      this.sendFrame(prio, pgn, dst, data)
    }
  }
}

module.exports = {
  H5000Device,
  encodeName,
  encodeProductInfo,
  encodeConfigInfo,
  encodeHeartbeat,
  encodePgnList,
  encodeNak,
  encodeCanId,
  parseCanId,
  freeAddress,
  DEFAULT_NAME,
  DEFAULT_PRODUCT
}
