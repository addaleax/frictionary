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
    try {
      await this._db.createCollection('suggestions');
    } catch {}
    try {
      await this._db.collection('suggestions').createIndex({ site: 1, 'votes.total': 1 });
    } catch {}
    try {
      await this._db.collection('suggestions').createIndex({ fetchTime: 1, 'votes.total': 1 });
    } catch {}
  }

  async saveSuggestions(list) {
    debug('Save suggestions', list.length);

    await this._db.collection('suggestions').bulkWrite(list.map(entry => {
      const id = entry.site + ':' + entry.title;

      return {
        updateOne: {
          filter: { _id: id },
          update: { $set: { ...entry } },
          upsert: true
        }
      };
    }));
  }

  async voteForSuggestion(id, vote) {
    debug('Vote for suggestion', id, vote);

    await this._db.collection('suggestions').updateOne({ _id: id }, {
      $inc: {
        [`votes.${vote}`]: 1,
        'votes.total': +vote
      }
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

  async getTop(site, n) {
    debug('Fetching top', site, n);
    const res = await this._db.collection('suggestions').aggregate([
      { $match: { site } },
      { $sort: { 'votes.total': -1 } },
      { $limit: n }
    ]).toArray();

    debug('Fetched top', site, n, res.length);

    return res;
  }

  async removeOutdated(maxTimestamp) {
    const res = await this._db.collection('suggestions').deleteMany({
      $and: [
        { fetchTime: { $lt: maxTimestamp } },
        { $or: [{ 'votes.total': { $lte: 0 } }, { 'votes.total': { $exists: false } }] }
      ]
    })
    debug('Removed outdated suggestions', res.deletedCount);
  }

  async getRandom(site, n) {
    debug('Fetch random suggestions', site, n);

    const res = await this._db.collection('suggestions').aggregate([
      { $match: { site } },
      { $sample: { size: n } }
    ]).toArray();

    debug('Loaded random suggestions', site, n, res.length);
    return res;
  }
}
