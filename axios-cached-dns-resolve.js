const dns = require('dns')
const URL = require('url')
const net = require('net')
const LRUCache = require('lru-cache')
const util = require('util')
const { initLogger } = require('./logging')

const dnsResolve = util.promisify(dns.resolve)

const config = {
  disabled: process.env.AXIOS_DNS_DISABLE === 'true',
  dnsTtlMs: process.env.AXIOS_DNS_CACHE_TTL_MS || 5000, // when to refresh actively used dns entries (5 sec)
  cacheGraceExpireMultiplier: process.env.AXIOS_DNS_CACHE_EXPIRE_MULTIPLIER || 2, // maximum grace to use entry beyond TTL
  dnsIdleTtlMs: process.env.AXIOS_DNS_CACHE_IDLE_TTL_MS || 1000 * 60 * 60, // when to remove entry entirely if not being used (1 hour)
  dnsCacheSize: process.env.AXIOS_DNS_CACHE_SIZE || 100, // maximum number of entries to keep in cache
  // pino logging options
  logging: {
    name: 'axios-cache-dns-resolve',
    // enabled: true,
    level: process.env.AXIOS_DNS_LOG_LEVEL || 'info', // default 'info' others trace, debug, info, warn, error, and fatal
    // timestamp: true,
    prettyPrint: process.env.NODE_ENV === 'DEBUG' || false,
    formatters: {
      level(label/* , number */) {
        return { level: label }
      },
    },
  },
  cache: undefined,
}

const cacheConfig = {
  max: config.dnsCacheSize,
  maxAge: (config.dnsTtlMs * config.cacheGraceExpireMultiplier), // grace for refresh
}

const stats = {
  dnsEntries: 0,
  refreshed: 0,
  hits: 0,
  misses: 0,
  idleExpired: 0,
  errors: 0,
  lastError: 0,
  lastErrorTs: 0,
}

let log
let cachePruneId

init()

function init() {
  log = initLogger(config.logging)

  if (config.cache) return

  config.cache = new LRUCache(cacheConfig)

  startPeriodicCachePrune()
  cachePruneId = setInterval(() => config.cache.prune(), config.dnsIdleTtlMs)
}

function startPeriodicCachePrune() {
  if (cachePruneId) clearInterval(cachePruneId)
  cachePruneId = setInterval(() => config.cache.prune(), config.dnsIdleTtlMs)
}

function getStats() {
  stats.dnsEntries = config.cache.length
  return stats
}

function getDnsCacheEntries() {
  return config.cache.values()
}

function registerInterceptor(axios) {
  if (config.disabled || !axios || !axios.interceptors) return // supertest
  axios.interceptors.request.use(async (reqConfig) => {
    try {
      let url
      if (reqConfig.baseURL) {
        url = URL.parse(reqConfig.baseURL)
      } else {
        url = URL.parse(reqConfig.url)
      }

      if (net.isIP(url.hostname)) return reqConfig // skip

      reqConfig.headers.Host = url.hostname // set hostname in header

      url.hostname = await getAddress(url.hostname, reqConfig.dnsEntryType)
      delete url.host // clear hostname

      if (reqConfig.baseURL) {
        reqConfig.baseURL = URL.format(url)
      } else {
        reqConfig.url = URL.format(url)
      }
    } catch (err) {
      recordError(err, `Error getAddress, ${err.message}`)
    }

    return reqConfig
  })
}

async function getAddress(host, type = 'A') {
  const key = `${type}\\${host}`
  let dnsEntry = config.cache.get(key)
  if (dnsEntry) {
    stats.hits += 1
    dnsEntry.lastUsedTs = Date.now()
    const ip = dnsEntry.ips[dnsEntry.nextIdx += 1 % dnsEntry.ips.length] // round-robin
    config.cache.set(key, dnsEntry)
    return ip
  }
  stats.misses += 1
  if (log.isLevelEnabled('debug')) log.debug(`cache miss ${host}`)

  let ips
  if (type === 'SRV') {
    const record = await dnsResolve(host, type)
    ips = await dnsResolve(record[0].name)
  } else {
    ips = await dnsResolve(host, type)
  }

  dnsEntry = {
    type,
    host,
    ips,
    nextIdx: 0,
    lastUsedTs: Date.now(),
    updatedTs: Date.now(),
  }
  const ip = dnsEntry.ips[dnsEntry.nextIdx += 1 % dnsEntry.ips.length] // round-robin
  config.cache.set(key, dnsEntry)
  return ip
}

function recordError(err, errMesg) {
  stats.errors += 1
  stats.lastError = err
  stats.lastErrorTs = new Date().toISOString()
  log.error(err, errMesg)
}

module.exports = {
  config,
  cacheConfig,
  stats,
  startPeriodicCachePrune,
  getStats,
  getDnsCacheEntries,
  registerInterceptor,
}
