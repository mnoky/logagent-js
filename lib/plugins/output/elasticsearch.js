'use strict'
var consoleLogger = require('../../util/logger.js')
var Logsene = require('logsene-js')
var LogSourceToIndexMapper = require('../../core/logSourceToIndexMapper.js')
var fs = require('fs')
var reduceConfig = require('../../util/config-reducer.js')
function formatObject (o) {
  var rv = ''
  Object.keys(o).forEach(function (key) {
    rv = rv + ' ' + key + '=' + JSON.stringify(o[key])
  })
  return rv
}

function OutputElasticsearch (config, eventEmitter) {
  this.config = config
  this.logCount = 0
  this.eventEmitter = eventEmitter
  this.consoleLogger = consoleLogger
  this.loggers = {}
  this.laStats = require('../../core/printStats')
  if (config.indices) {
    config.tokenMapper = new LogSourceToIndexMapper(config.indices)
  }
  if (this.config.url) {
    this.config.elasticsearchUrl = config.url
  }
  if (this.config.httpOptions) {
    if (this.config.httpOptions.key) {
      try {
        this.config.httpOptions.key = fs.readFileSync(this.config.httpOptions.key)
      } catch (ex) {
        consoleLogger.error('Error reading SSL key file ' + this.config.httpOptions.key + ' ' + ex)
      }
    }
    if (this.config.httpOptions.cert) {
      try {
        this.config.httpOptions.cert = fs.readFileSync(this.config.httpOptions.cert)
      } catch (ex) {
        consoleLogger.error('Error reading SSL cert file ' + this.config.httpOptions.cert + ' ' + ex)
      }
    }
    if (this.config.httpOptions.ca) {
      try {
        this.config.httpOptions.ca = fs.readFileSync(this.config.httpOptions.ca)
      } catch (ex) {
        consoleLogger.error('Error reading SSL CA file ' + this.config.httpOptions.ca + ' ' + ex)
      }
    }
    this.httpOptions = this.config.httpOptions
  }
}

OutputElasticsearch.prototype.indexData = function (token, logType, data, config) {
  var logger = this.getLogger(token, logType, config)
  this.logCount++
  logger.log(data.severity || data.level || 'info', data.message || data.msg || data.MESSAGE, data)
}

OutputElasticsearch.prototype.getLogger = function (token, type, config) {
  var loggerName = token + '/' + type
  if (!this.loggers[loggerName]) {
    var options = {useIndexInBulkUrl: true}
    if (/logsene/.test(config.elasticsearchUrl)) {
      // in case the index does not exist, using /_bulk would create it
      options.useIndexInBulkUrl = false
    }
    if (this.httpOptions) {
      options.httpOptions = this.httpOptions
    }
    var logger = new Logsene(token, type, config.elasticsearchUrl,
      config.diskBufferDir, options)
    this.laStats.usedTokens.push(token)
    logger.on('log', function (data) {
      this.laStats.logsShipped += (Number(data.count) || 0)
      this.logCount = this.logCount - data.count
    }.bind(this))
    logger.on('error', function (err) {
      this.laStats.httpFailed++
      consoleLogger.error('Error in Elasticsearch request: ' + formatObject(err) + ' / ' + formatObject(err.err))
    }.bind(this))
    logger.on('rt', function (data) {
      consoleLogger.warn('Retransmit ' + data.file + ' to ' + data.url)
      this.laStats.retransmit += 1
      this.laStats.logsShipped += data.count
    }.bind(this))
    if (process.env.LOG_NEW_TOKENS) {
      consoleLogger.log('create logger for token: ' + token)
    }
    this.loggers[loggerName] = logger
  }
  return this.loggers[loggerName]
}

OutputElasticsearch.prototype.eventHandler = function (data, context) {
  var config = reduceConfig(context, data, this.config)
  var index = data._index || context.index || config.index || process.env.LOGSENE_TOKEN
  if (config.tokenMapper) {
    index = config.tokenMapper.findToken(data.logSource || context.sourceName) || index
  }
  if (!index) {
    return
  }

  // support for time-based index patterns
  index = index.replace(/YYYY|MM|DD/g, function (match) {
    if (match === 'YYYY') {
      return '' + data['@timestamp'].getFullYear()
    }
    if (match === 'MM') {
      return ('0' + (data['@timestamp'].getMonth() + 1)).substr(-2)
    }
    if (match === 'DD') {
      return ('0' + data['@timestamp'].getDate()).substr(-2)
    }
    return match
  })

  this.indexData(index, data['_type'] || 'logs', data, config)
}

OutputElasticsearch.prototype.start = function () {
  if (this.config.index || this.config.elasticsearchUrl) {
    this.eventEmitter.on('data.parsed', this.eventHandler.bind(this))
  }
}

OutputElasticsearch.prototype.stop = function (cb) {
  this.eventEmitter.removeListener('data.parsed', this.eventHandler)
  var self = this
  process.nextTick(function () {
    var count = Object.keys(this.loggers).length - 1
    Object.keys(this.loggers).forEach(function (l) {
      consoleLogger.log('send ' + l)
      this.loggers[l].send()
      this.loggers[l].on('log', function (evt) {
        count = count - 1
        consoleLogger.log('flushed ' + evt.count + ' logs for ' + self.config.elasticsearchUrl + ' ' + l + ', logs in buffer: ' + self.logCount)
        if (self.logCount === 0) {
          cb()
        }
      })
      this.loggers[l].once('error', function () {
        count = count - 1
        consoleLogger.error('flushed logs for ' + l + ' failed')
        if (count === 0) {
          cb()
        }
      })
    }.bind(this))
  }.bind(this))
}

module.exports = OutputElasticsearch
