var tabsUtils = require('./utils/tabs');
var cache = require('./utils/cache');
var _ = require('../common');

var requests = {};
var verify = {};
var special_headers = [
  'user-agent',
  'referer',
  'origin',
  'host',
];
// var tasks = {};

function getRequestId() {
  var id = _.getUniqId();
  requests[id] = {
    id: id,
    xhr: new XMLHttpRequest,
  };
  return id;
}

function xhrCallbackWrapper(req) {
  var lastPromise = Promise.resolve();
  var xhr = req.xhr;
  return function (evt) {
    var res = {
      id: req.id,
      type: evt.type,
      resType: xhr.responseType,
    };
    var data = res.data = {
      finalUrl: req.finalUrl,
      readyState: xhr.readyState,
      responseHeaders: xhr.getAllResponseHeaders(),
      status: xhr.status,
      statusText: xhr.statusText,
    };
    try {
      data.responseText = xhr.responseText;
    } catch (e) {
      // ignore if responseText is unreachable
    }
    if (evt.type === 'loadend') clearRequest(req);
    lastPromise = lastPromise.then(function () {
      return new Promise(function (resolve, _reject) {
        if (xhr.response && xhr.responseType === 'blob') {
          var reader = new FileReader;
          reader.onload = function (_e) {
            data.response = this.result;
            resolve();
          };
          reader.readAsDataURL(xhr.response);
        } else {
          // default `null` for blob and '' for text
          data.response = xhr.response;
          resolve();
        }
      });
    }).then(function () {
      req.cb && req.cb(res);
    });
  };
}

function httpRequest(details, cb) {
  var req = requests[details.id];
  if (!req || req.cb) return;
  req.cb = cb;
  var xhr = req.xhr;
  try {
    xhr.open(details.method, details.url, true, details.user, details.password);
    xhr.setRequestHeader('VM-Verify', details.id);
    details.headers && Object.keys(details.headers).forEach(function (key) {
      xhr.setRequestHeader(
        ~special_headers.indexOf(key.toLowerCase()) ? 'VM-' + key : key,
        details.headers[key]
      );
    });
    if (details.responseType) xhr.responseType = 'blob';
    if (details.overrideMimeType) xhr.overrideMimeType(details.overrideMimeType);
    var callback = xhrCallbackWrapper(req);
    [
      'abort',
      'error',
      'load',
      'loadend',
      'progress',
      'readystatechange',
      'timeout',
    ].forEach(function (evt) {
      xhr['on' + evt] = callback;
    });
    req.finalUrl = details.url;
    xhr.send(details.data);
  } catch (e) {
    console.warn(e);
  }
}

function clearRequest(req) {
  if (req.coreId) delete verify[req.coreId];
  delete requests[req.id];
}

function abortRequest(id) {
  var req = requests[id];
  if (req) {
    req.xhr.abort();
    clearRequest(req);
  }
}

// Watch URL redirects
chrome.webRequest.onBeforeRedirect.addListener(function (details) {
  var reqId = verify[details.requestId];
  if (reqId) {
    var req = requests[reqId];
    if (req) req.finalUrl = details.redirectUrl;
  }
}, {
  urls: ['<all_urls>'],
  types: ['xmlhttprequest'],
});

// Modifications on headers
chrome.webRequest.onBeforeSendHeaders.addListener(function (details) {
  var headers = details.requestHeaders;
  var newHeaders = [];
  var vmHeaders = {};
  headers.forEach(function (header) {
    // if (header.name === 'VM-Task') {
    //   tasks[details.requestId] = header.value;
    // } else
    if (header.name.slice(0, 3) === 'VM-') {
      vmHeaders[header.name.slice(3)] = header.value;
    } else {
      newHeaders.push(header);
    }
  });
  var reqId = vmHeaders['Verify'];
  if (reqId) {
    var req = requests[reqId];
    if (req) {
      delete vmHeaders['Verify'];
      verify[details.requestId] = reqId;
      req.coreId = details.requestId;
      Object.keys(vmHeaders).forEach(function (key) {
        ~special_headers.indexOf(key.toLowerCase())
        && newHeaders.push({name: key, value: vmHeaders[key]});
      });
    }
  }
  return {requestHeaders: newHeaders};
}, {
  urls: ['<all_urls>'],
  types: ['xmlhttprequest'],
}, ['blocking', 'requestHeaders']);

// tasks are not necessary now, turned off
// Stop redirects
// chrome.webRequest.onHeadersReceived.addListener(function (details) {
//   var task = tasks[details.requestId];
//   if (task) {
//     delete tasks[details.requestId];
//     if (task === 'Get-Location' && _.includes([301, 302, 303], details.statusCode)) {
//       var locationHeader = details.responseHeaders.find(function (header) {
//         return header.name.toLowerCase() === 'location';
//       });
//       return {
//         redirectUrl: 'data:text/plain;charset=utf-8,' + (locationHeader && locationHeader.value || ''),
//       };
//     }
//   }
// }, {
//   urls: ['<all_urls>'],
//   types: ['xmlhttprequest'],
// }, ['blocking', 'responseHeaders']);
// chrome.webRequest.onCompleted.addListener(function (details) {
//   delete tasks[details.requestId];
// }, {
//   urls: ['<all_urls>'],
//   types: ['xmlhttprequest'],
// });
// chrome.webRequest.onErrorOccurred.addListener(function (details) {
//   delete tasks[details.requestId];
// }, {
//   urls: ['<all_urls>'],
//   types: ['xmlhttprequest'],
// });

chrome.webRequest.onBeforeRequest.addListener(function (req) {
  // onBeforeRequest is fired for local files too
  if (/\.user\.js([\?#]|$)/.test(req.url)) {
    // {cancel: true} will redirect to a blocked view
    var noredirect = {redirectUrl: 'javascript:history.back()'};
    var x = new XMLHttpRequest();
    x.open('GET', req.url, false);
    try {
      x.send();
    } catch (e) {
      // Request is redirected
      return;
    }
    if ((!x.status || x.status == 200) && !/^\s*</.test(x.responseText)) {
      cache.set(req.url, x.responseText);
      var url = chrome.extension.getURL('/options/index.html') + '#confirm/' + encodeURIComponent(req.url);
      if (req.tabId < 0) tabsUtils.create(url);
      else tabsUtils.get(req.tabId).then(function (t) {
        tabsUtils.create(url + '/' + encodeURIComponent(t.url));
      });
      return noredirect;
    }
  }
}, {
  urls: ['<all_urls>'],
  types: ['main_frame'],
}, ['blocking', 'requestBody']);

module.exports = {
  getRequestId: getRequestId,
  abortRequest: abortRequest,
  httpRequest: httpRequest,
};
