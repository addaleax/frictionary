#!/usr/bin/env node
'use strict';

const path = require('path');
const express = require('express');
const compression = require('compression');
const morgan = require('morgan');
const Promise = require('bluebird');
const request = require('request');
const cradle = require('cradle');
const cookieSession = require('cookie-session');
const bodyParser = require('body-parser');
const _ = require('lodash');

const SuggestionFetch = require('./suggestion-fetch').SuggestionFetch;
const SuggestionStorage = require('./suggestion-storage').SuggestionStorage;

class Frictionary {
  constructor(opt) {
    this.opt = opt;

    this.userAgent = 'Frictionary/1.0 (+' + opt.userAgentContact + ') Node.js/' + process.version;
    
    this.fetchers = opt.sites.map(entry => {
      return new SuggestionFetch({
        userAgent: this.userAgent,
        base: entry.base,
        site: entry.site
      });
    });
    
    const dbConn = new cradle.Connection(opt.db.host, opt.db.port, opt.db.opt);
    const db = Promise.promisifyAll(dbConn.database(opt.db.dbname));
    
    this.storage = new SuggestionStorage({db: db});
    this.voteCache = new Map();

    this.app = express();

    this.app.use(morgan('combined'));
    this.app.use(compression());
    this.app.use(bodyParser.json());
    this.app.use(express.static(path.resolve(__dirname, 'static')));
    this.app.use(cookieSession({secret: opt.secret}));

    this.app.get('/sites', (req, res) => this.getSites(req, res));
    this.app.get('/suggestions/:site?', (req, res) => this.getSuggestions(req, res));
    this.app.post('/vote/:suggestion', (req, res) => this.voteForSuggestion(req, res));
  }
  
  init() {
    return Promise.all([
      this.app.listen(this.opt.httpPort || 3000),
      Promise.all(this.fetchers.map(f => f.init())),
      this.storage.init()
    ]);
  }
  
  fetchAndStore(fetcher) {
    return fetcher.fetchSome().then(list => {
      return this.storage.saveSuggestions(list).then(() => list);
    });
  }
  
  get sites() {
    return this.fetchers.map(f => f.site);
  }
  
  getSites(req, res) {
    res.send({
      data: this.sites
    });
  }
  
  voteForSuggestion(req, res) {
    console.log(req.params, req.body);
    const id = req.params.suggestion;
    const vote = parseInt(req.body.vote);
    const remote = req.headers['x-forwarded-for'] || req.connection.remoteAddress;
    
    if ([+1, -1].indexOf(vote) === -1) {
      return res.status(403).send({error: 'Invalid vote count'});
    }
    
    const vc = this.voteCache.get(remote);
    const vcEntry = { id: id, vote: vote, time: Date.now() };
    if (vc) {
      if (Math.abs(vc
            .map(entry => entry.id === id ? entry.vote : 0)
            .reduce((a, b) => a+b) + vote) >= 2) {
        return res.status(403).send({error: 'Already voted'});
      }
      
      // allow 50 votes per hour
      if (vc.filter(entry => entry.time < Date.now() - 60 * 60 * 1000)
        .length > 50) {
        return res.status(403).send({error: 'Too many votes'});
      }
      
      vc.push(vcEntry);
    } else {
      this.voteCache.set(remote, [vcEntry]);
    }
    
    return this.storage.voteForSuggestion(id, vote).then(() => {
      return res.send({status: 'OK'});
    }).catch(err => {
      if (err.notFound) {
        return res.status(404).send({error: 'No such ID'});
      }
      
      return res.status(500).send(String(err));
    });
  }
  
  getSuggestions(req, res) {
    const sites = this.sites;
    const site = req.params.site;
    
    if (sites.indexOf(site) === -1) {
      return res.status(404).send({error: 'No such site'});
    }
    
    const fetcher = this.fetchers[sites.indexOf(site)];
    
    return Promise.all([
      this.storage.getCachedTop(site, 2048),
      this.storage.getRandom(site, this.opt.defaultRandom)
    ]).then(results => {
      req.session.seen = req.session.seen || [];
      const seenFilter = entry => 
        req.session.seen.indexOf(entry.site + ':' + entry.title) === -1;
      const top = results[0].filter(seenFilter);
      const random = results[1].filter(seenFilter);
      
      const list = _.shuffle(_.uniqBy(random.concat(_.shuffle(top)), 'title')
        .slice(0, this.opt.defaultRandom*2));
      
      if (list.length >= this.opt.defaultRandom) {
        return list;
      }
      
      return this.fetchAndStore(fetcher).then(additional =>
        _.shuffle(list.concat(additional))
      );
    }).then(list => {
      req.session.seen = req.session.seen.concat(
        list.map(entry => entry.site + ':' + entry.title)
      );
      
      return res.send({
        data: list
      })
    }).catch(err => {
      console.error(err);
      res.status(500).send(String(err));
    });
    
    this.fetchAndStore(fetcher);
  }
}

if (require.main === module) {
  process.on('uncaughtException',  err => console.error(err));
  process.on('unhandledRejection', err => console.error(err));
  
  const fs = Promise.promisifyAll(require('fs'));
  const crypto = Promise.promisifyAll(require('crypto'));
  const opt = {};
  
  fs.readFileAsync(path.resolve(__dirname, 'config.json')).then(config => {
    Object.assign(opt, JSON.parse(config));
    
    const spath = path.resolve(__dirname, '.fn-secret');
    
    return fs.readFileAsync(spath, 'utf-8').catch(e => {
      return crypto.randomBytesAsync(8).then(buf => buf.toString('base64'));
    }).then(secret => {
      return fs.writeFileAsync(spath, secret, 'utf-8').then(() => secret);
    });
  }).then(secret => {
    opt.secret = secret;
    
    const frictionary = new Frictionary(opt);
    frictionary.init();
  });
}
