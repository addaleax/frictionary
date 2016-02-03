'use strict';
const cheerio = require('cheerio');

module.exports = function(body) {
  const $ = cheerio.load(body);

  // Take the first paragraph containing a bold entry.
  // Best guess only, sorry.
  const desc = $($.root().children('p').filter(function(i, el) {
    return $(el).find('b').length > 0;
  }).get(0));
  
  // If we and with a colon, this is probably some
  // kind of disambiguation or list
  if (/:$/.test(desc.text().trim())) {
    return null;
  }
  
  return desc.html();
};
