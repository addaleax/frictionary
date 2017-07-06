'use strict';
const request = require('request');
const debug = require('debug')('frictionary:suggestion-fetch');
const wikipediaExcerpt = require('./wikipedia-excerpt');

exports.SuggestionFetch =
class SuggestionFetch {
  constructor(opt) {
    this._mwContinue = null;

    this.options = Object.assign({
      rnlimit: 10,
      rnnamespace: 0
    }, opt);

    if (!this.options.userAgent || !this.options.site || !this.options.base) {
      throw new TypeError('Sorry, SuggestionFetch needs opt.userAgent, opt.site and opt.base');
    }

    this.options.base = this.options.base.replace(/\/*$/, ''); // strip trailing /

    this._requestDefaults = request.defaults({
      baseUrl: this.options.base,
      headers: {
        'User-Agent': this.options.userAgent
      }
    });
  }

  get site() {
    return this.options.site;
  }

  get siteInfo() {
    return this.options.info;
  }

  init() {
  }

  async fetchSome(n) {
    n = n || this.options.rnlimit;

    const list = await this._fetchSome();

    if (list.length >= n)
      return list;

    const additional = await this.fetchSome(n - list.length);
    return list.concat(additional);
  }

  async _fetchSome() {
    const qs = Object.assign({
      action: 'query',
      list: 'random',
      rnlimit: this.options.rnlimit,
      rnnamespace: this.options.rnnamespace,
      format: 'json'
    }, this.mwContinue || {});

    const res = await this.request({
      url: '/w/api.php',
      qs: qs
    });

    const body = JSON.parse(res.body);

    if (body.continue) {
      this._mwContinue = body.continue;
    }

    const list = await Promise.all(body.query.random.map(async entry => {
      // good chance of removing Person entries
      if (!/^\S+$/.test(entry.title)) {
        return null;
      }

      return await this.loadIndividualArticle(entry.title);
    }));

    return list.filter(e => e);
  }

  async loadIndividualArticle(title) {
    const qs = {
      title: title,
      action: 'render'
    };

    const res = await this.request({
      url: '/w/index.php',
      qs: qs
    });

    const excerpt = wikipediaExcerpt(res.body);

    if (!excerpt) {
      debug('Rejecting title', title);
      return null;
    }

    debug('Accepting title', title);

    return {
      site: this.options.site,
      title: title,
      ref: this.options.base + '/w/index.php?title=' + encodeURIComponent(title),
      excerpt: excerpt,
      fetchTime: Date.now()
    };
  }

  async request(options) {
    debug('Requesting', this.site, options.url, options.qs || {});

    return new Promise((resolve, reject) => {
      this._requestDefaults(options, (err, response, body) => {
        debug('Loaded', this.site, options.url, err, response && response.statusCode);

        if (err) {
          reject(err);
        }

        resolve({response, body});
      })
    });
  }
}
