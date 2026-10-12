/*! BinaryBond embed SDK — drop-in private calls for your product.
 *
 *   <script src="https://your-binarybond-host/sdk.js"></script>
 *   const call = BinaryBond.mount('#call', { token });           // new room
 *   const call = BinaryBond.mount('#call', { token, room });     // join a room key you share
 *   call.on('joined', e => …).on('participants', e => …).on('left', …);
 *   call.destroy();
 *
 * The room key travels in the iframe URL fragment, which is never sent to any
 * server. Mint `token` on your backend with POST /v1/sessions.
 */
(function (global) {
  'use strict';
  var script = document.currentScript;
  var DEFAULT_ORIGIN = script && script.src ? new URL(script.src).origin : '';

  function randomKey() {
    var b = new Uint8Array(16);
    crypto.getRandomValues(b);
    var s = '';
    for (var i = 0; i < b.length; i++) s += String.fromCharCode(b[i]);
    return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  }

  function mount(target, opts) {
    opts = opts || {};
    var el = typeof target === 'string' ? document.querySelector(target) : target;
    if (!el) throw new Error('BinaryBond: mount target not found');
    var origin = (opts.origin || DEFAULT_ORIGIN).replace(/\/+$/, '');
    var room = opts.room || randomKey();
    var url = new URL(origin + '/embed');
    if (opts.token) url.searchParams.set('token', opts.token);
    url.hash = room;

    var frame = document.createElement('iframe');
    frame.src = url.toString();
    frame.title = opts.title || 'Private call';
    frame.allow = 'camera; microphone; display-capture; fullscreen; clipboard-write; autoplay';
    frame.setAttribute('allowfullscreen', '');
    frame.referrerPolicy = 'no-referrer';
    frame.style.cssText = 'width:100%;height:' + (opts.height || '100%') + ';min-height:420px;border:0;border-radius:' + (opts.radius == null ? 16 : opts.radius) + 'px;background:#07080f;color-scheme:dark';
    el.appendChild(frame);

    var handlers = {};
    function onMessage(e) {
      if (e.origin !== origin || e.source !== frame.contentWindow) return;
      var d = e.data;
      if (!d || d.source !== 'binarybond') return;
      (handlers[d.type] || []).concat(handlers['*'] || []).forEach(function (fn) {
        try { fn(d); } catch (err) { console.error(err); }
      });
    }
    global.addEventListener('message', onMessage);

    var api = {
      frame: frame,
      room: room,
      inviteUrl: origin + '/embed#' + room,
      on: function (type, fn) { (handlers[type] = handlers[type] || []).push(fn); return api; },
      off: function (type, fn) { handlers[type] = (handlers[type] || []).filter(function (f) { return f !== fn; }); return api; },
      destroy: function () { global.removeEventListener('message', onMessage); frame.remove(); handlers = {}; },
    };
    return api;
  }

  global.BinaryBond = { mount: mount, version: '2.0.0' };
})(window);
