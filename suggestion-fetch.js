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
  
  fetchSome(n) {
    n = n || this.options.rnlimit;
    
    return this._fetchSome().then(list => {
      if (list.length >= n)
        return list;
      
      return this.fetchSome(n - list.length)
        .then(additional => list.concat(additional));
    });
  }
  
  _fetchSome() {
    const qs = Object.assign({
      action: 'query',
      list: 'random',
      rnlimit: this.options.rnlimit,
      rnnamespace: this.options.rnnamespace,
      format: 'json'
    }, this.mwContinue || {});
    
    return this.request({
      url: '/w/api.php',
      qs: qs
    }).then(res => {
      const body = JSON.parse(res.body);
      
      if (body.continue) {
        this._mwContinue = body.continue;
      }
      
      return Promise.all(body.query.random.map(entry => {
        // good chance of removing Person entries
        if (!/^\S+$/.test(entry.title)) {
          return null;
        }
        
        return this.loadIndividualArticle(entry.title);
      })).then(list => list.filter(e => e));
    });
  }
  
  loadIndividualArticle(title) {
    const qs = {
      title: title,
      action: 'render'
    };
    
    return this.request({
      url: '/w/index.php',
      qs: qs
    }).then(res => {
      const excerpt = wikipediaExcerpt(res.body);
      
      if (!excerpt) {
        debug('Rejecting title', title);
        return null;
      }
      
      return {
        site: this.options.site,
        title: title,
        ref: this.options.base + '/w/index.php?title=' + encodeURIComponent(title),
        excerpt: excerpt,
        fetchTime: Date.now()
      };
    });
  }
  
  request(options) {
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
