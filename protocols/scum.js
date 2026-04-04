import valve from './valve.js'

/**
 * SCUM advertises Steam server browser on UDP at (game port + 2). Many hosts (including
 * official servers) do not answer public A2S queries; BattleMetrics still tracks those servers.
 *
 * @see https://scum.wiki.gg/wiki/Scum_Dedicated_server_setup
 * @see https://developer.valvesoftware.com/wiki/Server_queries
 */
export default class scum extends valve {
  constructor () {
    super()
    // Avoid TCP probing the game port before HTTP (core.request tcpPing); valve only uses UDP here.
    this.usedTcp = true
  }

  async run (state) {
    try {
      await super.run(state)
    } catch (e) {
      this.logger.debug('SCUM: Steam query failed, trying BattleMetrics', e)
      await this.queryBattleMetrics(state)
    }
  }

  async queryBattleMetrics (state) {
    const { address, port } = this.options
    const params = new URLSearchParams()
    params.append('filter[search]', address)
    params.append('filter[game]', 'scum')
    const url = `https://api.battlemetrics.com/servers?${params.toString()}`
    const json = await this.request({ url, responseType: 'json' })
    const rows = json.data || []
    const match = rows.find((s) => {
      const a = s.attributes
      if (a.ip !== address) return false
      const pq = a.portQuery ?? a.port
      return a.port === port || pq === port ||
        a.port === port + 2 || pq === port + 2 ||
        a.port === port - 2 || pq === port - 2
    })
    if (!match) {
      throw new Error('SCUM: no UDP response and no BattleMetrics match for this address/port')
    }

    const attr = match.attributes
    const qPort = attr.portQuery ?? attr.port
    const gamePort = qPort >= 2 ? qPort - 2 : qPort

    this.options.port = qPort
    state.name = attr.name
    state.map = ''
    state.password = false
    state.numplayers = attr.players
    state.maxplayers = attr.maxPlayers
    state.version = attr.details?.version ? String(attr.details.version) : ''
    state.raw.battlemetrics = { id: match.id, ...attr }
    state.raw.players = []
    state.players = []
    state.raw.source = 'battlemetrics'
    state.connect = `${address}:${gamePort}`
  }
}
