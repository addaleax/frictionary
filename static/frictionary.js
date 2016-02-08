(function() {'use strict';

var curSite = typeof localStorage === 'undefined' ? '' : localStorage.site;
var curSuggestions = [];

function vote(suggestion, sign, element) {
  var id = encodeURI(suggestion.site) + ':' + encodeURI(suggestion.title);
  $.ajax({
    url: '/vote/' + id,
    data: JSON.stringify({ vote: sign }),
    method: 'POST',
    processData: false,
    contentType: 'application/json;charset=utf-8'
  }).then(function() {
    element.text(element.text().replace(/(\d+)/, function(match) {
      return parseInt(match) + 1;
    }));
  });
}

function loadSuggestions() {
  $.ajax({
    url: '/suggestions/' + curSite
  }).then(function(results) {
    curSuggestions = results.data;
    $('#suggestions').html(curSuggestions.map(function(s, index) {
      var votes = s.votes || {};
      return '<li class="suggestion">\n' +
        '<div class="suggestion-excerpt">' + s.excerpt + '</div>\n' +
        '<div><a href="' + s.ref + '" class="wikipedia-link">→ ' +
          '<img src="Wikipedia-W-bold-in-square.svg" ' +
          'alt="Wikipedia" class="wikipedia-logo" /></a></div>\n' +
        '<div class="votes">\n' +
          '<button id="vote-pos-' + index + '" href="javascript:void(0)">' +
            (votes[1] || 0) + ' +</button> |\n' +
          '<button id="vote-neg-' + index + '" href="javascript:void(0)">− ' +
            (votes[-1] || 0) + '</button>\n' +
        '</div>\n' +
      '</li>';
    }).join('\n'));
    
    curSuggestions.forEach(function(s, index) {
      var pos = $('#vote-pos-' + index);
      var neg = $('#vote-neg-' + index);
      pos.click(function() { vote(s, +1, pos); });
      neg.click(function() { vote(s, -1, neg); });
    });
  });
}

$(document).ready(function() {
  if (curSite) {
    loadSuggestions();
  }

  $.ajax({
    url: '/sites'
  }).then(function(res) {
    if (!curSite) {
      curSite = res.data[0];
      loadSuggestions();
    }
    
    $('#site-selector').html(res.data.map(function(site) {
      return '<option ' + (curSite === site ? 'selected': '') + '>' +
        site + '</option>';
    }).join('\n')).change(function() {
      curSite = $('#site-selector').val();
      document.cookie = curSite;
      if (typeof localStorage !== 'undefined') {
        localStorage.site = curSite;
      }
      
      loadSuggestions();
    });
  });

  $('.reload').click(loadSuggestions);
});

})();
