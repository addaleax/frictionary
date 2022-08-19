#!/usr/bin/env node
'use strict';

const fs = require('fs');
const crypto = require('crypto');
const util = require('util');
const path = require('path');
const express = require('express');
const compression = require('compression');
const morgan = require('morgan');
const request = require('request');
const { MongoClient } = require('mongodb');
const session = require('express-session');
const SessionStore = require('session-file-store')(session);
const bodyParser = require('body-parser');
const _ = require('lodash');
const debug = require('debug')('frictionary:index');

const SuggestionFetch = require('./suggestion-fetch').SuggestionFetch;
const SuggestionStorage = require('./suggestion-storage').SuggestionStorage;

const readFileAsync = util.promisify(fs.readFile);
const writeFileAsync = util.promisify(fs.writeFile);
const randomBytesAsync = util.promisify(crypto.randomBytes);

const msPerDay = 86400000;

class Frictionary {
  constructor(opt) {
    this.opt = opt;

    this.userAgent = 'Frictionary/1.0 (+' + opt.userAgentContact + ') Node.js/' + process.version;

    this.fetchers = opt.sites.map(entry => {
      return new SuggestionFetch({
        userAgent: this.userAgent,
        base: entry.base,
        site: entry.site,
        info: entry.info
      });
    });

    const dbConn = new MongoClient(opt.db.connectionString);
    const db = dbConn.db(opt.db.dbname);

    this.storage = new SuggestionStorage({db});
    this.voteCache = new Map();

    this.app = express();

    this.app.use(morgan('combined'));
    this.app.use(compression());
    this.app.use(express.static(path.resolve(__dirname, 'static')));
    this.app.use(bodyParser.json());
    this.app.use(session({
      secret: opt.secret,
      store: new SessionStore(),
      resave: false,
      saveUninitialized: false
    }));

    this.app.get('/sites', (req, res) => this.getSites(req, res));
    this.app.get('/suggestions/:site?', (req, res) => this.getSuggestions(req, res));
    this.app.post('/vote/:suggestion', (req, res) => this.voteForSuggestion(req, res));
  }

  async init() {
    await Promise.all([
      this.app.listen(this.opt.httpPort || 3000),
      Promise.all(this.fetchers.map(f => f.init())),
      this.storage.init()
    ]);

    setInterval(() => this.removeOutdated(), msPerDay);

    return this.removeOutdated();
  }

  removeOutdated() {
    const outdatedMillisecs = parseInt(this.opt.outdatedDays) * msPerDay;
    return this.storage.removeOutdated(new Date(Date.now() - outdatedMillisecs));
  }

  async fetchAndStore(fetcher) {
    const list = await fetcher.fetchSome();

    await this.storage.saveSuggestions(list);
    return list;
  }

  get siteNames() {
    return this.fetchers.map(f => f.site);
  }

  getSites(req, res) {
    const sites = this.fetchers.map(f => ({"id": f.site, "info": f.siteInfo}));
    res.send({
      data: sites
    });
  }

  async voteForSuggestion(req, res) {
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

    try {
      await this.storage.voteForSuggestion(id, vote);
      await res.send({status: 'OK'});
    } catch (err) {
      if (err.notFound) {
        await res.status(404).send({error: 'No such ID'});
      }

      await res.status(500).send(String(err));
    }
  }

  async getSuggestions(req, res) {
    const sites = this.siteNames;
    const site = req.params.site;

    if (sites.indexOf(site) === -1) {
      await res.status(404).send({error: 'No such site'});
    }

    const fetcher = this.fetchers[sites.indexOf(site)];

    try {
      const [ top_, random_ ] = await Promise.all([
        // loading from our own DB is cheap -> don’t be afraid to do it a lot!
        this.storage.getCachedTop(site, 2048),
        this.storage.getRandom(site, this.opt.defaultRandom * 4)
      ]);

      req.session.seen = req.session.seen || [];
      const seenFilter = entry =>
        req.session.seen.indexOf(entry.site + ':' + entry.title) === -1;
      const top = top_.filter(seenFilter);
      const random = random_.filter(seenFilter);

      debug('Loaded initial results', top.length, random.length);

      let list = _.shuffle(_.uniqBy(random.concat(_.shuffle(top)), 'title')
        .slice(0, this.opt.defaultRandom*2));

      if (list.length < this.opt.defaultRandom) {
        const additional = await this.fetchAndStore(fetcher);
        list = _.shuffle(list.concat(additional));
      }

      req.session.seen = req.session.seen.concat(
        list.map(entry => entry.site + ':' + entry.title)
      );

      await res.send({
        data: list
      });
    } catch (err) {
      console.error(err);
      await res.status(500).send(String(err));
    }

    await this.fetchAndStore(fetcher);
  }
}

if (require.main === module) {
  (async function() {
    process.on('uncaughtException',  err => console.error(err));
    process.on('unhandledRejection', err => console.error(err));

    const config = await readFileAsync(path.resolve(__dirname, 'config.json'));
    const opt = Object.assign({}, JSON.parse(config));

    const spath = path.resolve(__dirname, '.fn-secret');
    try {
      opt.secret = await readFileAsync(spath, 'utf-8');
    } catch (e) {
      opt.secret = (await randomBytesAsync(8)).toString('base64');
    }

    await writeFileAsync(spath, opt.secret, 'utf-8');

    const frictionary = new Frictionary(opt);
    await frictionary.init();
  })();
}
