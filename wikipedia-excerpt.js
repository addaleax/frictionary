'use strict';
const cheerio = require('cheerio');
const fs = require('fs');

module.exports = wikipediaExcerpt;

function wikipediaExcerpt(body) {
  const $ = cheerio.load(body);
  
  // Try to ignore geographic stuff
  if ($('.geo').length > 0) {
    return null;
  }

  // Take the first paragraph containing a bold entry.
  // Best guess only, sorry.
  const desc = $($.root().find('p').filter(function(i, el) {
    return $(el).find('b').length > 0;
  }).get(0));
  
  // If we and with a colon, this is probably some
  // kind of disambiguation or list
  if (/:$/.test(desc.text().trim())) {
    return null;
  }
  
  return desc.html();
};

if (require.main === module) {
  const file = fs.readFileSync(process.argv[2], 'utf8');
  const excerpt = wikipediaExcerpt(file);
  if (excerpt === null)
    process.stderr.write('[null]\n');
  else
    process.stderr.write(`${excerpt}\n`);
}
