"use strict";

var request = require('request')
  , split = require('split')
  , Writable = require('stream').Writable
  , util = require('util')

function backoff (current, max, step, _value) {
  return function () {
    if ((_value = current) > max) {
      throw new Error('Exceeded twitter rate limit')
    }
    current = step(current)
    return _value
  }

}

var FILTER_TYPE_TRACKING = 'tracking'
  , FILTER_TYPE_LOCATION = 'location'
  , FILTER_TYPE_FOLLOW = 'follow'
  , FILTER_TYPE_LANGUAGE = 'language'

var Twitter = function (oauth) {
  if(!(this instanceof Twitter)) {
    return new Twitter(oauth)
  }

  if (!oauth || !oauth.consumer_secret || !oauth.consumer_key || !oauth.token || !oauth.token_secret) {
    throw new Error('Oauth credentials required')
  }
  this.oauth = oauth

  this._filters = {
    tracking: {},
    location: {},
    follow: {},
    language: {}
  }

  this.backoffs()

  Writable.call(this, {objectMode: true})

  this.connectBackoff = 0;

}

util.inherits(Twitter, Writable)

// Here so we can easily test this
Twitter.prototype.twitterUrl = 'https://stream.twitter.com/1.1/statuses/filter.json'

Twitter.prototype.timeoutInterval = 1000 * 90 // default twitter timeout is 90 seconds

// Backup strategies based off twitter's guidelines
//    See https://dev.twitter.com/docs/streaming-apis/connecting#Reconnecting
Twitter.prototype.backoffs = function () {
  // Network hiccup, try every 250 seconds
  this.networkBackoff = backoff(0, 16 * 1000, function (x) { return x + 250 })
  // Rate limited. Try exponetially starting at 1 seconds
  this.httpBackoff = backoff(1000, 320 * 1000, function (x) { return x * 2 })
  // Rate limited. Try exponetially starting at 1 second
  this.rateBackoff = backoff(1000, 2147483647, function (x) { return x * 2})
}

Twitter.prototype.addFilter = function (filter, keywords, reconnect) {
  reconnect = typeof reconnect === 'undefined' || reconnect

  if (!Array.isArray(keywords)) {
    keywords = [keywords]
  }

  var addedNewKeyword = false
  keywords.forEach((function (keyword) {
    if (this._filters[filter][keyword]) {
      this._filters[filter][keyword]++
    } else {
      this._filters[filter][keyword] = 1
      this.stale = true
      addedNewKeyword = true
    }
  }).bind(this))

  if (reconnect && addedNewKeyword) {
    this.reconnect()
  }
}

Twitter.prototype.track = function (keyword, reconnect) {
  this.addFilter(FILTER_TYPE_TRACKING, keyword, reconnect)
}

Twitter.prototype.trackMultiple = function (keywords, reconnect) {
  this.addFilter(FILTER_TYPE_TRACKING, keywords, reconnect)
}

Twitter.prototype.location = function (location, reconnect) {
  this.addFilter(FILTER_TYPE_LOCATION, location, reconnect)
}

Twitter.prototype.follow = function (follow, reconnect) {
  this.addFilter(FILTER_TYPE_FOLLOW, follow, reconnect)
}

Twitter.prototype.language = function (lang, reconnect) {
  this.addFilter(FILTER_TYPE_LANGUAGE, lang, reconnect)
}

Twitter.prototype.tracking = function () {
  return Object.keys(this._filters[FILTER_TYPE_TRACKING])
}

Twitter.prototype.locations = function () {
  return Object.keys(this._filters[FILTER_TYPE_LOCATION])
}

Twitter.prototype.following = function () {
  return Object.keys(this._filters[FILTER_TYPE_FOLLOW]);
}

Twitter.prototype.languages = function () {
  return Object.keys(this._filters[FILTER_TYPE_LANGUAGE]);
}

Twitter.prototype.reconnect = function () {
  if (this.stale) {
    if (this.stream) {
      this.abort()
    }
    this.connect()
  }
}

Twitter.prototype._write = function (data, encoding, done) {
  if (data.text) {
    this.emit('tweet', this,data)
  } else if (data.delete) {
    this.emit('delete', this,data.delete)
  } else if (data.scrub_geo) {
    this.emit('scrub_geo', this,data.scrub_geo)
  } else if (data.limit) {
    this.emit('limit', this,data.limit)
  } else if (data.status_withheld) {
    this.emit('status_withheld', this,data.status_withheld)
  } else if (data.user_withheld) {
    this.emit('user_withheld', this,data.user_withheld)
  } else if (data.disconnect) {
    this.emit('disconnect', this,data.disconnect)
  } else if (data.warning) {
    this.emit('warning', this,data.warning)
  }
  done()
}

Twitter.prototype.removeFilter = function (filter, keyword, reconnect) {
  reconnect = typeof reconnect === 'undefined' || reconnect

  if (typeof this._filters[filter][keyword] === 'undefined') {
    return
  }
  if (--this._filters[filter][keyword] === 0) {
    delete this._filters[filter][keyword]
    this.stale = true
    if (reconnect) {
      this.reconnect()
    }
  }
}

Twitter.prototype.removeAllFilters = function (filter, reconnect) {
  reconnect = typeof reconnect === 'undefined' || reconnect

  if (typeof this._filters[filter] === 'undefined') {
    return
  }
  this._filters[filter] = {};
  this.stale = true
  if (reconnect) {
    this.reconnect()
  }
}

Twitter.prototype.untrack = function (keyword, reconnect) {
  this.removeFilter(FILTER_TYPE_TRACKING, keyword, reconnect)
}

Twitter.prototype.untrackAll = function (reconnect) {
  this.removeAllFilters(FILTER_TYPE_TRACKING, reconnect)
}

Twitter.prototype.unlocate = function (location, reconnect) {
  this.removeFilter(FILTER_TYPE_LOCATION, location, reconnect)
}

Twitter.prototype.unfollow = function (follow, reconnect) {
  this.removeFilter(FILTER_TYPE_FOLLOW, follow, reconnect)
}

Twitter.prototype.unlanguage = function (language, reconnect) {
  this.removeFilter(FILTER_TYPE_LANGUAGE, language, reconnect)
}

Twitter.prototype.hasFilters = function () {
  return this.tracking().length > 0 || this.locations().length > 0 || this.following().length > 0 || this.languages().length > 0
}

Twitter.prototype.errorExplanation = {
  401: {
    type: 'unauthorized',
    long: 'HTTP authentication failed.'
  },
  403: {
    type: 'forbidden',
    long: 'The connecting account is not permitted to access this endpoint.'
  },
  404: {
    type: 'not-found',
    long: 'There is nothing at this URL.'
  },
  406: {
    type: 'not-acceptable',
    long: 'At least one request parameter is invalid.'
  },
  413: {
    type: 'too-long',
    long: 'A parameter list is too long.'
  },
  416: {
    type: 'range-unacceptable',
    long: 'Returned if user does not have access to use the count parameter or a count parameter is outside of the max/min allowable values.'
  },
  420: {
    type: 'rate-limit',
    long: 'The client has connected too frequently.'
  },
  503: {
    type: 'service-unavailable',
    long: 'A streaming server is temporarily overloaded.'
  }
}

Twitter.prototype.connect = function () {
  this.stale = false
  if (!this.hasFilters()) {
    return
  }

  //console.log("Connecting",this._filters.tracking)

  this.stream = request.post({
    url: this.twitterUrl,
    oauth: this.oauth,
    form: {
      track: Object.keys(this._filters[FILTER_TYPE_TRACKING]).join(','),
      locations: Object.keys(this._filters[FILTER_TYPE_LOCATION]).join(','),
      follow: Object.keys(this._filters[FILTER_TYPE_FOLLOW]).join(','),
      language: Object.keys(this._filters[FILTER_TYPE_LANGUAGE]).join(',')
    }
  })

  this.once('error', function (err) {
    console.log('Encountered an unrecoverable error, the stream is abort.')
    console.log('  Reason: [', err.code, ']', err.explain.long)
    console.log('  Please refer to https://dev.twitter.com/streaming/overview/connecting to debug your request parameters.')
  })

  this.stream.on('response', (function (res) {
    var self = this
    // Rate limited or temporarily unavailable
    if (res.statusCode === 420 || res.statusCode === 503) {


      var backoff = res.statusCode === 420 ? this.rateBackoff() : this.httpBackoff();

  //    console.log("received",res.statusCode,"backing off for ",backoff);

      this.abort()

      let random  = backoff * Math.random() * 0.5 - backoff * 0.25;
      backoff = backoff + random;
      if (this.connectBackoff == 0) {
//        console.log("Backing Response off for ",backoff);
        this.connectBackoff = backoff;
//console.log("Backing off for ",backoff, "for ",this._filters.tracking);
        setTimeout(function () {
          self.connectBackoff = 0;
          self.connect()
        }, backoff);
      }

      this.emit('reconnect', this, {
        type: this.errorExplanation[res.statusCode].type,
        explain: this.errorExplanation[res.statusCode]
      },this.connectBackoff)
      return
    }

    // Http error
    if (res.statusCode > 200) {
      this.abort()

      this.emit('error',  this,{
        type: 'http',
        err: new Error('Twitter connection error ' + res.statusCode),
        code: res.statusCode,
        explain: this.errorExplanation[res.statusCode]
      })
      return
    }

    // 200. Alive and well.  Reset backoffs to original value

    this.backoffs()

    this.emit('connect', this)

    this.parser = split(null, function (d) {
      try {
        return JSON.parse(d)
      } catch (e) {}
    })

    this.parser = res.pipe(this.parser, {end: false})
    this.parser.pipe(this, {end: false})

    // Handle this: https://dev.twitter.com/docs/streaming-apis/connecting#Stalls
    // Abort the connection and reconnect if we haven't received an update for 90 seconds
    var close = (function () {
      this.abort()
      process.nextTick(this.connect.bind(this))
      this.emit('reconnect', this, {type: 'stall'},0)
    }).bind(this)

    this.timeout = setTimeout(close, this.timeoutInterval)

    res.on('data', function () {
      clearTimeout(self.timeout)
      self.timeout = setTimeout(close, self.timeoutInterval)
    })
  }).bind(this))

  this.stream.on('error', (function (err) {
    var self = this
    this.abort()
    let backoff = this.networkBackoff();


          let random  = backoff * Math.random() * 0.5 - backoff * 0.25;
          // console.log("Backoff jitter = ",random);

          backoff = backoff + random;

    if (this.connectBackoff == 0) {
      this.connectBackoff = backoff;
    //  console.log("Backing off for ",backoff, "for ",this._filters.tracking);
      setTimeout(function () {


        self.inConnectBackoff = 0;
        self.connect()
      }, backoff);
    }
    this.emit('reconnect', this, {type: 'network', err: err},this.connectBackoff)

  }).bind(this))
}

Twitter.prototype.abort = function () {
  if (this.parser) {
    this.parser.destroy()
  }
  clearTimeout(this.timeout)
  if (this.stream) {
    this.stream.abort()
  }

  this.stream = null
}

module.exports = Twitter
