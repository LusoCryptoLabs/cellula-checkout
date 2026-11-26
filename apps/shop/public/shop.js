// The shop's page: products, an order and its invoice from the shop's server, the Pay with Fiber
// window, and the shop's own word that it was paid.
;(function () {
  var $ = function (id) { return document.getElementById(id) }
  var esc = function (s) { return String(s == null ? '' : s).replace(/[&<>"]/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c] }) }
  var sleep = function (ms) { return new Promise(function (r) { setTimeout(r, ms) }) }
  // A reason ended as a sentence, with one full stop: joined as it came, one that had its own said
  // "...open one here.. You can try again."
  var ended = function (s) { var t = String(s).trim(); return /[.!?…]$/.test(t) ? t : t + '.' }
  // A reason said on its own: a capital first too (the shop's own errors are written to be joined).
  var sentence = function (s) { var t = String(s).trim(); return ended(t.charAt(0).toUpperCase() + t.slice(1)) }

  async function api(path, init) {
    var r = await fetch(path, Object.assign({ headers: { 'content-type': 'application/json' } }, init || {}))
    var body = await r.json().catch(function () { return {} })
    if (!r.ok) throw new Error(body.error || 'the shop answered ' + r.status)
    return body
  }

  // Paid only when the shop's server says so: it learns it from its merchant, never from this page.
  async function waitOrder(id, ms) {
    var end = Date.now() + ms
    while (Date.now() < end) {
      var o = await api('/api/orders/' + id).catch(function () { return null })
      if (o && o.status === 'paid') return o
      if (o && o.invoice_status === 'expired') return o
      await sleep(1500)
    }
    return api('/api/orders/' + id)
  }

  function say(card, text, bad) {
    var l = card.querySelector('.line')
    l.textContent = text
    l.classList.toggle('bad', !!bad)
  }

  async function buy(card, product) {
    var buyBtn = card.querySelector('.buy')
    buyBtn.disabled = true
    say(card, 'Asking the shop for an invoice…')
    var made
    try {
      made = await api('/api/orders', { method: 'POST', body: JSON.stringify({ product: product.id }) })
    } catch (e) {
      buyBtn.disabled = false
      return say(card, sentence(e.message), true)
    }
    buyBtn.hidden = true
    var pay = card.querySelector('.pay')
    pay.hidden = false
    pay.textContent = 'Pay ' + product.price_ckb + ' CKB with Fiber'
    say(card, 'Order ' + made.order.id + '. The invoice holds for 15 minutes.')
    // The window must open on the tap itself, so the invoice is ready before it.
    pay.onclick = async function () {
      if (!window.payWithFiber) return say(card, 'The checkout script did not load. Check your connection and reload.', true)
      pay.disabled = true
      say(card, 'Confirm in the window that opened…')
      try {
        await window.payWithFiber({ invoice: made.invoice, return: location.origin + '/?order=' + made.order.id })
      } catch (e) {
        pay.disabled = false
        return say(card, 'Not paid: ' + ended(e && e.message ? e.message : 'the window closed') + ' You can try again.', true)
      }
      say(card, 'Your wallet sent it. Checking with the shop…')
      var o = await waitOrder(made.order.id, 90000).catch(function () { return null })
      done(card, o)
    }
  }

  function done(card, o) {
    var pay = card.querySelector('.pay')
    if (o && o.status === 'paid') {
      pay.hidden = true
      card.classList.add('paid')
      say(card, 'Paid. Order ' + o.id + ', confirmed by the shop' + (o.paid_by === 'webhook' ? ' from its webhook.' : '.'))
    } else if (o && o.invoice_status === 'expired') {
      say(card, 'The invoice expired before it was paid. Buy again for a new one.', true)
    } else {
      pay.disabled = false
      say(card, 'The shop has not seen it yet. If your wallet says paid, wait a moment and reload.', true)
    }
  }

  function render(products) {
    $('products').innerHTML = products.map(function (p) {
      return '<article class="card" data-id="' + esc(p.id) + '"><h3>' + esc(p.name) + '</h3><p>' + esc(p.blurb) + '</p>' +
        '<div class="price">' + esc(p.price_ckb) + '<small>CKB</small></div>' +
        '<button type="button" class="buy">Buy</button><button type="button" class="pay" hidden></button>' +
        '<div class="line" aria-live="polite"></div></article>'
    }).join('')
    products.forEach(function (p) {
      var card = $('products').querySelector('[data-id="' + p.id + '"]')
      card.querySelector('.buy').addEventListener('click', function () { buy(card, p) })
    })
  }

  async function status() {
    var s = await api('/api/status').catch(function () { return null })
    var el = $('state')
    if (s && s.ready) { el.textContent = 'Open: up to ' + s.can_receive_ckb + ' CKB a payment'; el.className = 'state open' }
    else if (s && s.starting) { el.textContent = "Opening the shop's channel…"; el.className = 'state'; setTimeout(status, 5000) }
    else { el.textContent = 'Closed for now'; el.className = 'state' }
  }

  // Back from a checkout that opened in this tab (a blocked window): the order is in the address.
  async function returned() {
    var id = new URLSearchParams(location.search).get('order')
    if (!id || !/^o_[0-9a-f]{12}$/.test(id)) return
    var n = $('returned')
    n.hidden = false
    n.textContent = 'Checking order ' + id + ' with the shop…'
    var o = await waitOrder(id, 60000).catch(function () { return null })
    n.textContent = o && o.status === 'paid' ? 'Paid. Order ' + id + ', confirmed by the shop.' : 'Order ' + id + ' is not paid yet.'
  }

  api('/api/products').then(function (b) { render(b.products) }, function () { $('products').textContent = 'The shop did not answer. Reload in a moment.' })
  status()
  returned()
})()
