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

  async init() {
    const exists = await this._db.existsAsync();
    if (!exists) {
      debug('Creating non-existent DB');
      await this._db.createAsync();
    }

    await Promise.all([
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
  }

  async saveSuggestions(list) {
    debug('Save suggestions', list.length);

    await Promise.all(list.map(async entry => {
      const id = entry.site + ':' + entry.title;

      const doc = await this._db.getAsync(id).catch(e => {});
      const updated = Object.assign(
        doc || {},
        { random: Math.random() },
        entry);
      await this._db.saveAsync(id, updated);
    }));
  }

  async voteForSuggestion(id, vote) {
    debug('Vote for suggestion', id, vote);

    let doc;
    try {
      doc = await this._db.getAsync(id);
    } catch (e) {
      e.notFound = true; // web interface knows how to handle this
      throw e;
    }

    doc.votes = doc.votes || {};
    doc.votes[vote] = (doc.votes[vote] || 0)+1;
    await this._db.saveAsync(id, doc);
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

  async getTop(site, n) {
    debug('Fetching top', site, n);
    const res = await this._db.viewAsync('suggestions/by_votes', {
      startkey: [site, 9999999999],
      descending: true,
      limit: n
    });

    const overallResult = res.toArray().filter(r => r.site === site);

    debug('Fetched top', site, n, res.length, overallResult.length);

    return overallResult;
  }

  async removeOutdated(maxTimestamp) {
    const res = await this._db.viewAsync('suggestions/outdated', {
      startkey: maxTimestamp,
      descending: true
    });

    debug('Removing outdated suggestions', res.length);

    await Promise.all(res.toArray()
        .map(r => this._db.removeAsync(r._id, r._rev)));
  }

  async getRandom(site, n) {
    return await this._getRandom(site, n, 5);
  }

  async _getRandom(site, n, maxIterationsLeft) {
    debug('Fetch random suggestions', site, n, maxIterationsLeft);

    const res = (await this._db.viewAsync('suggestions/by_random', {
      startkey: [site, Math.random()],
      descending: Math.random() > 0.5,
      limit: n
    })).toArray().filter(r => r.site === site);

    if (res.length < n && maxIterationsLeft > 0) {
      debug('Recursively fetching more random suggestions',
        site, n, res.length, maxIterationsLeft);

      const res2 = await this._getRandom(site,
                                         n - res.length,
                                         maxIterationsLeft-1);
      return res.concat(res2);
    }

    debug('Loaded random suggestions', site, n, res.length);
    return res;
  }
}
