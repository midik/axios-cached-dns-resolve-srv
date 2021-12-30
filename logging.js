const pino = require('pino')

let logger

function init(options) {
  return (logger = pino(options))
}

function getLogger() {
  return logger
}

module.exports = {
  initLogger: init,
  getLogger
}
