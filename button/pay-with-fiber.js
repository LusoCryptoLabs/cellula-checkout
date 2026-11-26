/*
 * Cellula Checkout: one script any site can add to ask for a Fiber payment. Testnet only for now.
 * The button a payer presses still says "Pay with Fiber", and the file keeps its name.
 *
 *   <script src="https://testnet.cellula.id/pay-with-fiber.js"></script>
 *   <button data-fiber-invoice="fibt...">Pay with Fiber</button>
 *   <button data-fiber-name="maria.cell" data-fiber-amount="5"></button>
 *
 * A click opens the checkout in a small window, on the wallet's own host (wallet.testnet.cellula.id).
 * The person pays there, from their own Fiber balance, and the button gets a `fiber-paid` event with
 * { payment_hash, preimage }, or `fiber-failed`. From script: payWithFiber({ invoice } or
 * { name, amount }) returns a promise. A button drawn after this script ran is not wired: call
 * payWithFiber from its click.
 *
 * On Android the checkout opens as an /app link, which the Cellula app takes and pays from the
 * Fiber balance it keeps. The app has no window behind it to tell, so the link carries a key of
 * this page's, the checkout seals its answer under it in the names API's store (which cannot read
 * it), and this page fetches it when the window has gone.
 *
 * Early, so the person is free once the payment is on its way (data-fiber-early on a button, which
 * then gets `fiber-sent` too, or payWithFiber({ ..., onSent })): paying a name, the checkout
 * answers `sent` once the name's LSP holds the payment, and the promise settles when it arrives,
 * followed at the gateway (`paid`, without a preimage). An invoice is answered when paid, early or
 * not.
 *
 * The answer is a hint, not proof: count a payment when the invoice settles on your own node. The
 * preimage lets you check sooner: it hashes to the payment hash.
 *
 * Docs: https://testnet.cellula.id/developers#pay-with-fiber
 */
;(function () {
  var me = document.currentScript
  // The wallet answers on its own host: app.cellula.id on mainnet, wallet.testnet.cellula.id on
  // testnet (which also runs at app.testnet.cellula.id, where it moves; until it has, this script
  // opens the first), wallet.localhost from a local server; the script's own host otherwise.
  // A copy pasted inline has no host of its own and goes to the testnet wallet, the one that is live.
  function walletOf(src) {
    if (!src) return 'https://wallet.testnet.cellula.id'
    var h = src.hostname
    if (h === 'cellula.id') return 'https://app.cellula.id'
    if (h === 'testnet.cellula.id') return 'https://wallet.' + h
    if (h === 'localhost') return src.protocol + '//wallet.localhost' + (src.port ? ':' + src.port : '')
    return src.origin
  }
  var CHECKOUT = (me && me.getAttribute('data-checkout')) || walletOf(me && me.src ? new URL(me.src) : null)
  // Where a phone's answer waits: the names API beside the wallet (wallet.<host> or app.<host> ->
  // <host>/api/r).
  function sealedOf(checkout) {
    var u = new URL(checkout)
    return u.protocol + '//' + u.host.replace(/^(wallet|app)\./, '') + '/api/r'
  }
  var SEALED = (me && me.getAttribute('data-sealed')) || null
  var onAndroid = /Android/i.test(navigator.userAgent)

  function askOf(o) {
    var target
    if (o.invoice) target = String(o.invoice)
    else if (o.name && o.amount) {
      var n = String(o.name).trim().replace(/^@/, '')
      target = (/\.cell$/i.test(n) ? n : n + '.cell') + '?amount=' + encodeURIComponent(String(o.amount))
    } else throw new Error('pay-with-fiber: give an invoice, or a name and an amount')
    target += (target.indexOf('?') < 0 ? '?' : '&') + 'origin=' + encodeURIComponent(location.origin)
    if (o.return) target += '&return=' + encodeURIComponent(o.return)
    // Early (SPEC.md, `sent`): the checkout answers once the payment has left, and the person is
    // free; this page follows it from then on (follow, below).
    if (o.early || o.onSent) target += '&early=1'
    return target
  }

  // A payment answered `sent`: where it is, asked of the gateway's link status (its `delivery`)
  // every two seconds for up to ten minutes. Arrived: `paid`, without a preimage (the gateway's word, as `held` is;
  // a site with its own node still counts from there). Unreadable from this site (the gateway
  // answers only the origins it knows) three times in a row: the answer stays `sent`.
  function follow(a, stop, onHeld) {
    return new Promise(function (resolve, reject) {
      var misses = 0
      var held = false
      var until = Date.now() + 600000
      function ask() {
        if (stop()) return
        fetch(a.follow)
          .then(function (r) {
            return r.json()
          })
          .then(
            function (j) {
              misses = 0
              var st = j && j.delivery
              if (st === 'succeeded') return resolve({ type: 'fiber-pay', version: 1, payment_hash: a.payment_hash, status: 'paid' })
              if (st === 'failed') {
                var err = new Error('the payment did not arrive, and nothing left the payer')
                err.answer = { type: 'fiber-pay', version: 1, payment_hash: a.payment_hash, status: 'failed' }
                return reject(err)
              }
              if (st === 'deferred' && !held) {
                held = true
                if (onHeld) onHeld({ type: 'fiber-pay', version: 1, payment_hash: a.payment_hash, status: 'held' })
              }
              next()
            },
            function () {
              if (++misses >= 3) return resolve(a)
              next()
            },
          )
      }
      function next() {
        if (Date.now() > until) return resolve(a)
        setTimeout(ask, 2000)
      }
      ask()
    })
  }

  // Sealing as cellula-sdk's seal.ts does it: a 16-byte key in base64url, the name the answer is filed
  // under and the AES key both hashed from it, the blob version 1, then the nonce, then the sealed bytes.
  function b64u(bytes) {
    var s = ''
    for (var i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i])
    return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
  }
  function unb64u(s) {
    var bin = atob(s.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - (s.length % 4)) % 4))
    var out = new Uint8Array(bin.length)
    for (var i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i)
    return out
  }
  function newKey() {
    return b64u(crypto.getRandomValues(new Uint8Array(16)))
  }
  function derive(key, info, n) {
    var tag = new TextEncoder().encode(info)
    var raw = unb64u(key)
    var seed = new Uint8Array(tag.length + raw.length)
    seed.set(tag)
    seed.set(raw, tag.length)
    return crypto.subtle.digest('SHA-256', seed).then(function (h) {
      return new Uint8Array(h).slice(0, n)
    })
  }
  function openSealed(key, blob) {
    var bytes = unb64u(blob.trim())
    if (bytes.length < 29 || bytes[0] !== 1) return Promise.reject(new Error('unreadable answer'))
    return derive(key, 'cells:shortlink:key:v1', 16)
      .then(function (raw) {
        return crypto.subtle.importKey('raw', raw, 'AES-GCM', false, ['decrypt'])
      })
      .then(function (k) {
        return crypto.subtle.decrypt({ name: 'AES-GCM', iv: bytes.slice(1, 13) }, k, bytes.slice(13))
      })
      .then(function (plain) {
        return JSON.parse(new TextDecoder().decode(plain))
      })
  }
  // The answer the checkout sealed under `key`, asked for every second and a half (at once when the
  // person comes back to this tab), for up to ten minutes; null then.
  function waitSealed(sealed, key, stop) {
    var until = Date.now() + 10 * 60 * 1000
    return derive(key, 'cells:shortlink:id:v1', 9).then(function (id) {
      var url = sealed + '/' + b64u(id)
      return new Promise(function (resolve) {
        var timer = 0
        function back() {
          if (document.visibilityState === 'visible') ask()
        }
        function finish(a) {
          clearTimeout(timer)
          document.removeEventListener('visibilitychange', back)
          resolve(a)
        }
        function ask() {
          clearTimeout(timer)
          if (stop()) return finish(null)
          if (Date.now() > until) return finish(null)
          fetch(url, { cache: 'no-store' })
            .then(function (r) {
              return r.ok ? r.json() : null
            })
            .then(function (j) {
              return j && j.blob ? openSealed(key, j.blob) : null
            })
            .then(
              function (a) {
                if (a && a.type === 'fiber-pay') finish(a)
                else timer = setTimeout(ask, 1500)
              },
              function () {
                timer = setTimeout(ask, 1500)
              },
            )
        }
        document.addEventListener('visibilitychange', back)
        ask()
      })
    })
  }

  function payWithFiber(o) {
    var checkout = (o && o.checkout) || CHECKOUT
    // On Android the /app link, with a key for the sealed answer; elsewhere the root page.
    var key = onAndroid ? newKey() : ''
    var url = checkout + (key ? '/app/pay#' : '/pay#') + askOf(o || {}) + (key ? '&key=' + key : '')
    var from = new URL(checkout).origin
    return new Promise(function (resolve, reject) {
      var settled = false
      var sent = false
      function take(a) {
        if (settled) return
        if (a.status === 'held') {
          if (o.onHeld) o.onHeld(a)
          return
        }
        // On its way: said, then followed; a later answer from the checkout (paid, with its
        // preimage, or failed) still settles it, whichever comes first.
        if (a.status === 'sent') {
          if (sent) return
          sent = true
          if (o.onSent) o.onSent(a)
          if (!a.follow) return finish(a)
          follow(a, function () {
            return settled
          }, o.onHeld).then(finish, function (err) {
            if (settled) return
            settled = true
            done()
            reject(err)
          })
          return
        }
        finish(a)
      }
      function finish(a) {
        if (settled) return
        settled = true
        done()
        if (a.status === 'paid' || a.status === 'sent') resolve(a)
        else {
          var err = new Error(a.reason || 'not paid')
          err.answer = a
          reject(err)
        }
      }
      // A window of its own each time: under one name a second payment went to the checkout still
      // open with the first, which ignores it, and the first one's answer then settled both.
      var w = window.open(url, 'fiber-pay-' + Date.now().toString(36) + Math.random().toString(36).slice(2), 'popup,width=440,height=780')
      // A blocked window: go to the checkout instead; `return` brings the person back here, with
      // #payment_hash=…&status=… in the address.
      if (!w) {
        location.assign(url)
        return
      }
      function done() {
        window.removeEventListener('message', onMessage)
        clearInterval(watch)
      }
      function onMessage(e) {
        // From the checkout window this opened, and no other window of that site.
        if (e.origin !== from || e.source !== w || !e.data || e.data.type !== 'fiber-pay') return
        take(e.data)
      }
      window.addEventListener('message', onMessage)
      var watch = setInterval(function () {
        if (!w.closed) return
        clearInterval(watch)
        // Closed after `sent`: nothing more to wait for there, the payment is being followed.
        if (settled || sent) return
        // Gone with no answer on Android: the Cellula app took the link, and its answer comes sealed.
        if (key) {
          waitSealed(SEALED || sealedOf(checkout), key, function () {
            return settled
          }).then(function (a) {
            if (a) take(a)
            else if (!settled) {
              settled = true
              done()
              reject(new Error('the checkout did not answer in time'))
            }
          })
          return
        }
        settled = true
        done()
        reject(new Error('the checkout was closed before paying'))
      }, 800)
    })
  }

  function wire(el) {
    if (el.__fiberPay) return
    el.__fiberPay = true
    if (!el.textContent.trim()) el.textContent = 'Pay with Fiber'
    el.addEventListener('click', function (e) {
      e.preventDefault()
      var o = el.getAttribute('data-fiber-invoice')
        ? { invoice: el.getAttribute('data-fiber-invoice') }
        : { name: el.getAttribute('data-fiber-name'), amount: el.getAttribute('data-fiber-amount') }
      if (el.getAttribute('data-fiber-return')) o.return = el.getAttribute('data-fiber-return')
      if (el.hasAttribute('data-fiber-early'))
        o.onSent = function (a) {
          el.dispatchEvent(new CustomEvent('fiber-sent', { detail: a, bubbles: true }))
        }
      payWithFiber(o).then(
        function (a) {
          el.dispatchEvent(new CustomEvent('fiber-paid', { detail: a, bubbles: true }))
        },
        function (err) {
          el.dispatchEvent(new CustomEvent('fiber-failed', { detail: err, bubbles: true }))
        },
      )
    })
  }

  function wireAll() {
    var els = document.querySelectorAll('[data-fiber-invoice],[data-fiber-name]')
    for (var i = 0; i < els.length; i++) wire(els[i])
  }

  window.payWithFiber = payWithFiber
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', wireAll)
  else wireAll()
})()
