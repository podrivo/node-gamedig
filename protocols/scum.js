import Core from './core.js'
import * as net from 'node:net'
import { Buffer } from 'node:buffer'

const MASTER_SERVERS = [
  { host: '176.57.138.2', port: 1040 },
  { host: '172.107.16.215', port: 1040 },
  { host: '206.189.248.133', port: 1040 }
]

const SERVER_ENTRY_SIZE = 127
const MASTER_REQUEST = Buffer.from([0x04, 0x03, 0x00, 0x00])

export default class scum extends Core {
  constructor () {
    super()
    this.usedTcp = true
  }

  async run (state) {
    const servers = await this.queryMasterServers()
    const targetIp = this.options.address
    const targetPort = this.options.port

    const server = servers.find(s => s.ip === targetIp && s.port === targetPort)
    if (!server) {
      throw new Error(`Server ${targetIp}:${targetPort} not found in SCUM master server list`)
    }

    state.name = server.name
    state.numplayers = server.numPlayers
    state.maxplayers = server.maxPlayers
    state.password = server.password
    state.version = server.version
    state.gamePort = server.port
    state.raw.time = server.time
  }

  async queryMasterServers () {
    for (const master of MASTER_SERVERS) {
      try {
        this.logger.debug(`Trying master server ${master.host}:${master.port}`)
        return await this.queryMaster(master.host, master.port)
      } catch (e) {
        this.logger.debug(`Master server ${master.host}:${master.port} failed: ${e.message}`)
      }
    }
    throw new Error('Failed to connect to any SCUM master server')
  }

  queryMaster (host, port) {
    const timeout = this.options.attemptTimeout

    return new Promise((resolve, reject) => {
      const socket = net.connect(port, host)
      socket.setTimeout(timeout)

      let buffer = Buffer.alloc(0)
      let totalServers = -1
      let resolved = false

      const finish = (err, result) => {
        if (resolved) return
        resolved = true
        socket.destroy()
        err ? reject(err) : resolve(result)
      }

      socket.on('connect', () => {
        this.logger.debug(`Connected to master server ${host}:${port}`)
        socket.write(MASTER_REQUEST)
      })

      socket.on('data', (chunk) => {
        buffer = Buffer.concat([buffer, chunk])

        if (totalServers === -1 && buffer.length >= 2) {
          totalServers = buffer.readUInt16LE(0)
          this.logger.debug(`Master server reports ${totalServers} servers`)
        }

        if (totalServers > 0) {
          const receivedEntries = Math.floor((buffer.length - 2) / SERVER_ENTRY_SIZE)
          if (receivedEntries >= totalServers) {
            finish(null, this.parseServerList(buffer, totalServers))
          }
        }
      })

      socket.on('timeout', () => finish(new Error('Master server connection timed out')))
      socket.on('error', (err) => finish(err))

      socket.on('close', () => {
        if (resolved) return
        if (buffer.length > 2) {
          const count = Math.floor((buffer.length - 2) / SERVER_ENTRY_SIZE)
          if (count > 0) {
            finish(null, this.parseServerList(buffer, count))
            return
          }
        }
        finish(new Error('Connection closed before receiving data'))
      })
    })
  }

  parseServerList (buffer, count) {
    const servers = []
    let offset = 2

    for (let i = 0; i < count && offset + SERVER_ENTRY_SIZE <= buffer.length; i++) {
      servers.push(this.parseServerEntry(buffer, offset))
      offset += SERVER_ENTRY_SIZE
    }

    this.logger.debug(`Parsed ${servers.length} servers`)
    return servers
  }

  parseServerEntry (buffer, offset) {
    const b0 = buffer.readUInt8(offset)
    const b1 = buffer.readUInt8(offset + 1)
    const b2 = buffer.readUInt8(offset + 2)
    const b3 = buffer.readUInt8(offset + 3)
    const ip = `${b3}.${b2}.${b1}.${b0}`
    offset += 4

    const port = buffer.readUInt16LE(offset)
    offset += 2

    let nameEnd = offset
    while (nameEnd < offset + 100 && buffer[nameEnd] !== 0) nameEnd++
    const name = buffer.toString('utf8', offset, nameEnd)
    offset += 100

    offset += 1 // padding

    const numPlayers = buffer.readUInt8(offset++)
    const maxPlayers = buffer.readUInt8(offset++)
    const time = buffer.readUInt8(offset++)

    offset += 1 // skip
    const flagByte = buffer.readUInt8(offset++)
    const password = ((flagByte >> 1) & 1) === 1
    offset += 7 // skip

    const build = buffer.readUInt32LE(offset)
    const patch = buffer.readUInt16LE(offset + 4)
    const minor = buffer.readUInt8(offset + 6)
    const major = buffer.readUInt8(offset + 7)
    const version = `${major}.${minor}.${patch}.${build}`

    return { ip, port, name, numPlayers, maxPlayers, time, password, version }
  }
}
