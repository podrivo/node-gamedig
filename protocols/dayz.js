import valve from './valve.js'
import { Buffer } from 'node:buffer'

export default class dayz extends valve {
  async run (state) {
    if (!this.options.port) this.options.port = 27016
    await super.queryInfo(state)
    await super.queryChallenge()
    await super.queryPlayers(state)
    await this.queryRules(state)

    this.processQueryInfo(state)
    await super.cleanup(state)
  }

  async queryRules (state) {
    if (!this.options.requestRules) {
      return
    }

    const rules = {}
    state.raw.rules = rules
    const dayZPayload = []

    this.logger.debug('Requesting rules ...')

    const b = await this.sendPacket(0x56, null, 0x45, true)
    if (b === null && !this.options.requestRulesRequired) return

    let dayZPayloadEnded = false

    const reader = this.reader(b)
    const num = reader.uint(2)
    for (let i = 0; i < num; i++) {
      if (!dayZPayloadEnded) {
        // Binary entries use 2-byte keys (index + count) followed by a null terminator.
        // Detect them by checking for two non-zero bytes followed by 0x00.
        const one = reader.uint(1)
        const two = reader.uint(1)
        const three = reader.uint(1)
        if (one !== 0 && two !== 0 && three === 0) {
          while (true) {
            const byte = reader.uint(1)
            if (byte === 0) break
            dayZPayload.push(byte)
          }
          continue
        } else {
          reader.skip(-3)
          dayZPayloadEnded = true
        }
      }

      const key = reader.string()
      rules[key] = reader.string()
    }

    const { mods, signatures } = this.parseDayzPayload(Buffer.from(dayZPayload))
    state.raw.dayzMods = mods
    state.raw.dayzSignatures = signatures
  }

  processQueryInfo (state) {
    if (!state.raw.tags) { return }

    state.raw.dlcEnabled = false
    state.raw.firstPerson = false
    state.raw.privateHive = false
    state.raw.external = false
    state.raw.official = false

    for (const tag of state.raw.tags) {
      if (tag.startsWith('lqs')) {
        const value = parseInt(tag.replace('lqs', ''))
        if (!isNaN(value)) {
          state.raw.queue = value
        }
      }
      if (tag.includes('no3rd')) {
        state.raw.firstPerson = true
      }
      if (tag.includes('isDLC')) {
        state.raw.dlcEnabled = true
      }
      if (tag.includes('privHive')) {
        state.raw.privateHive = true
      }
      if (tag.includes('external')) {
        state.raw.external = true
      }
      if (tag.includes(':')) {
        state.raw.time = tag
      }
      if (tag.startsWith('etm')) {
        const value = parseInt(tag.replace('etm', ''))
        if (!isNaN(value)) {
          state.raw.dayAcceleration = value
        }
      }
      if (tag.startsWith('entm')) {
        const value = parseInt(tag.replace('entm', ''))
        if (!isNaN(value)) {
          state.raw.nightAcceleration = value
        }
      }
    }

    if (!state.raw.external && !state.raw.privateHive) {
      state.raw.official = true
    }
  }

  /**
   * Decodes the DayZ byte escape encoding used to avoid 0x00 and 0xFF in
   * null-terminated A2S_RULES string values.
   *   0x01 0x01 → 0x01 (literal escape byte)
   *   0x01 0x02 → 0x00 (encoded null)
   *   0x01 0x03 → 0xFF (encoded 0xFF)
   */
  decodeDayzEscapes (buffer) {
    const out = []
    for (let i = 0; i < buffer.length; i++) {
      if (buffer[i] === 0x01 && i + 1 < buffer.length) {
        const next = buffer[i + 1]
        if (next === 0x01) { out.push(0x01); i++ }
        else if (next === 0x02) { out.push(0x00); i++ }
        else if (next === 0x03) { out.push(0xFF); i++ }
        else { out.push(buffer[i]) }
      } else {
        out.push(buffer[i])
      }
    }
    return Buffer.from(out)
  }

  /**
   * Parses the concatenated binary payload from the DayZ A2S_RULES response.
   * The raw buffer is first escape-decoded, then parsed structurally.
   */
  parseDayzPayload (rawBuffer) {
    if (!rawBuffer.length) {
      return { mods: [], signatures: [] }
    }

    this.logger.debug('DAYZ RAW BUFFER (before escape decoding)')
    this.logger.debug(rawBuffer)

    const buffer = this.decodeDayzEscapes(rawBuffer)

    this.logger.debug('DAYZ DECODED BUFFER')
    this.logger.debug(buffer)

    const reader = this.reader(buffer)

    const version = reader.uint(1)
    this.logger.debug('payload version: ' + version)

    if (version !== 2) {
      this.logger.debug('Unsupported DayZ binary payload version: ' + version + ', skipping mod parsing')
      return { mods: [], signatures: [] }
    }

    const overflow = reader.uint(1)
    this.logger.debug('overflow: ' + overflow)

    // DLC Flags — 2-byte LE bitmask; each set bit has a corresponding 4-byte hash
    const dlcFlags = reader.uint(2)
    this.logger.debug('dlcFlags: 0x' + dlcFlags.toString(16))

    let bits = dlcFlags
    while (bits) {
      if (bits & 1) {
        const hash = reader.uint(4)
        this.logger.debug('dlc hash: ' + hash)
      }
      bits >>>= 1
    }

    // --- Mod entries ---
    const mods = []
    const signatures = []
    if (reader.done()) return { mods, signatures }

    const modCount = reader.uint(1)
    this.logger.debug('mod count: ' + modCount)

    for (let i = 0; i < modCount; i++) {
      if (reader.remaining() < 5) break

      const hash = reader.uint(4)

      // Workshop ID Length byte — lower 4 bits give the byte count for the
      // workshop ID field. Typically 4 (32-bit). This byte is sometimes
      // absent on the last mod entry, requiring peek-ahead logic.
      const savedOffset = reader.offset()
      const lengthByte = reader.uint(1)
      const workshopIdSize = lengthByte & 0x0F

      let workshopId
      if (workshopIdSize >= 1 && workshopIdSize <= 8) {
        workshopId = reader.uint(Math.min(workshopIdSize, 4))
        if (workshopIdSize > 4) reader.skip(workshopIdSize - 4)
      } else {
        reader.setOffset(savedOffset)
        workshopId = reader.uint(4)
      }

      const nameLength = reader.uint(1)
      const title = nameLength > 0 ? reader.string(nameLength) : ''

      this.logger.debug({ hash, workshopId, title })
      mods.push({ workshopId, title })
    }

    // --- Signature entries (metadata — not mods) ---
    if (!reader.done()) {
      const sigCount = reader.uint(1)
      this.logger.debug('signature count: ' + sigCount)

      for (let i = 0; i < sigCount; i++) {
        if (reader.done()) break
        const nameLength = reader.uint(1)
        const name = nameLength > 0 ? reader.string(nameLength) : ''
        this.logger.debug('signature: ' + name)
        signatures.push(name)
      }
    }

    if (!reader.done()) {
      this.logger.debug('dayz buffer remaining bytes:', reader.rest())
    }

    return { mods, signatures }
  }
}
