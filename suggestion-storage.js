'use strict';
const debug = require('debug')('frictionary:suggestion-storage');

exports.SuggestionStorage = 
class SuggestionStorage {
  constructor(opt) {
    this.options = Object.assign({
      cacheTime: 60*60*1000 // 1 hour
    }, opt);
    
    if (!this.options.db) {
      throw new TypeError('SuggestionStorage needs a DB connection');
    }
    
    this.cache = {};
  }
  
  get _db() {
    return this.options.db;
  }
  
  init() {
    return this._db.existsAsync().then(exists => {
      if (!exists) {
        debug('Creating non-existent DB');
        return this._db.createAsync();
      }
    }).then(() => {
      return Promise.all([
        this._db.saveAsync('_design/suggestions', {
          by_random: {
            map: function(doc) {
              if (doc.site && doc.title && doc.random) {
                emit([doc.site, doc.random], doc);
              }
            }
          },
          by_votes: {
            map: function(doc) {
              if (doc.site && doc.title && typeof doc.votes !== 'undefined') {
                var total = (doc.votes[+1] || 0) - (doc.votes[-1] || 0);
                emit([doc.site, total], doc);
              }
            }
          },
          outdated: {
            map: function (doc) {
              if (typeof doc.votes === 'undefined' ||
                (doc.votes[+1] || 0) <= (doc.votes[-1] || 0))
              {
                emit(doc.fetchTime, doc);
              }
            }
          }
        })
      ]);
    });
  }
  
  saveSuggestions(list) {
    debug('Save suggestions', list.length);
    
    return Promise.all(list.map(entry => {
      const id = entry.site + ':' + entry.title;
      
      return this._db.getAsync(id).catch(e => {}).then(doc => {
        const updated = Object.assign(
          doc || {},
          { random: Math.random() },
          entry);
        return this._db.saveAsync(id, updated);
      });
    }));
  }
  
  voteForSuggestion(id, vote) {
    debug('Vote for suggestion', id, vote);
    
    return this._db.getAsync(id).catch(e => {
      e.notFound = true; // web interface knows how to handle this
      throw e;
    }).then(doc => {
      doc.votes = doc.votes || {};
      doc.votes[vote] = (doc.votes[vote] || 0)+1;
      return this._db.saveAsync(id, doc);
    });
  }
  
  getCachedTop(site, n) {
    const key = site + ':' + n
    const cache = this.cache[key];
    if (cache && cache.entry &&
      Date.now() - cache.time < this.options.cacheTime) {
      return cache.entry;
    }
    
    this.cache[key] = {
      time: Date.now(),
      entry: Promise.resolve().then(() => this.getTop(site, n))
    };
    
    return this.cache[key].entry;
  }
  
  getTop(site, n) {
    debug('Fetching top', site, n);
    return this._db.viewAsync('suggestions/by_votes', {
      startkey: [site, 9999999999],
      descending: true,
      limit: n
    }).then(res => {
      const overallResult = res.toArray().filter(r => r.site === site);
      
      debug('Fetched top', site, n, res.length, overallResult.length);
      
      return overallResult;
    });
  }
  
  removeOutdated(maxTimestamp) {
    return this._db.viewAsync('suggestions/outdated', {
      startkey: maxTimestamp,
      descending: true
    }).then(res => {
      debug('Removing outdated suggestions', res.length);
      
      return res.toArray().map(r => this._db.removeAsync(r._id, r._rev));
    });
  }
  
  getRandom(site, n) {
    return this._getRandom(site, n, 5);
  }
  
  _getRandom(site, n, maxIterationsLeft) {
    debug('Fetch random suggestions', site, n, maxIterationsLeft);
    
    return this._db.viewAsync('suggestions/by_random', {
      startkey: [site, Math.random()],
      descending: Math.random() > 0.5,
      limit: n
    }).then(res => {
      res = res.toArray().filter(r => r.site === site);
      
      if (res.length < n && maxIterationsLeft > 0) {
        debug('Recursively fetching more random suggestions',
          site, n, res.length, maxIterationsLeft);
        
        return this._getRandom(site, n - res.length, maxIterationsLeft-1)
          .then(res2 => res.concat(res2));
      }
      
      debug('Loaded random suggestions', site, n, res.length);
      return res;
    });
  }
}
