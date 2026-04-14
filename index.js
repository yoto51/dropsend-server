const http = require('http')
const { WebSocketServer } = require('ws')

const PORT = process.env.PORT || 8080
const DEVICE_TTL_MS = 60 * 1000
const SESSION_TTL_MS = 10 * 60 * 1000

const devices = new Map()
const sessions = new Map()

function send(ws, payload) {
  if (ws.readyState === ws.OPEN) {
    ws.send(JSON.stringify(payload))
  }
}

function now() {
  return Date.now()
}

function cleanExpiredState() {
  const timestamp = now()

  for (const [deviceId, record] of devices.entries()) {
    if (timestamp - record.lastSeenAt > DEVICE_TTL_MS) {
      try { record.ws.close() } catch {}
      devices.delete(deviceId)
    }
  }

  for (const [sessionId, session] of sessions.entries()) {
    if (timestamp > session.expiresAt) {
      sessions.delete(sessionId)
    }
  }
}

function sanitizeIdentity(payload) {
  return {
    deviceId: String(payload.deviceId || '').trim(),
    displayName: String(payload.displayName || '').trim().slice(0, 60),
    publicKeyFingerprint: String(payload.publicKeyFingerprint || '').trim()
  }
}

function registerDevice(ws, payload) {
  const identity = sanitizeIdentity(payload)
  if (!identity.deviceId) {
    send(ws, { type: 'error', reason: 'Missing deviceId.' })
    return
  }

  const previous = devices.get(identity.deviceId)
  if (previous && previous.ws !== ws) {
    try { previous.ws.close() } catch {}
  }

  ws.deviceId = identity.deviceId
  devices.set(identity.deviceId, {
    ws,
    identity,
    lastSeenAt: now()
  })

  send(ws, { type: 'registered', identity })
}

function routePresenceQuery(ws, payload) {
  const requestId = String(payload.requestId || '').trim()
  const targetDeviceId = String(payload.targetDeviceId || '').trim()
  const record = devices.get(targetDeviceId)

  send(ws, {
    type: 'presence-result',
    requestId,
    targetDeviceId,
    online: Boolean(record),
    identity: record ? record.identity : null
  })
}

function routeTransferRequest(ws, payload) {
  const targetDeviceId = String(payload.targetDeviceId || '').trim()
  const record = devices.get(targetDeviceId)

  if (!record) {
    send(ws, {
      type: 'transfer-error',
      sessionId: payload.sessionId,
      reason: 'Recipient is offline.'
    })
    return
  }

  const sessionId = String(payload.sessionId || '').trim()
  sessions.set(sessionId, {
    sessionId,
    senderDeviceId: ws.deviceId,
    receiverDeviceId: targetDeviceId,
    senderIdentity: payload.senderIdentity,
    receiverIdentity: record.identity,
    expiresAt: now() + SESSION_TTL_MS
  })

  send(record.ws, {
    type: 'incoming-transfer-request',
    sessionId,
    senderIdentity: payload.senderIdentity,
    fileMeta: payload.fileMeta
  })

  send(ws, {
    type: 'transfer-request-sent',
    sessionId,
    receiverIdentity: record.identity
  })
}

function routeTransferResponse(ws, payload) {
  const session = sessions.get(String(payload.sessionId || '').trim())
  if (!session) {
    send(ws, { type: 'error', reason: 'Transfer session expired.' })
    return
  }

  const sender = devices.get(session.senderDeviceId)
  if (!sender) {
    send(ws, { type: 'error', reason: 'Sender is no longer online.' })
    return
  }

  send(sender.ws, {
    type: 'transfer-response',
    sessionId: session.sessionId,
    accepted: Boolean(payload.accepted),
    receiverIdentity: sanitizeIdentity(payload.receiverIdentity || {})
  })

  if (!payload.accepted) {
    sessions.delete(session.sessionId)
  }
}

function routeSignal(ws, payload) {
  const session = sessions.get(String(payload.sessionId || '').trim())
  if (!session) {
    send(ws, { type: 'error', reason: 'Signal session expired.' })
    return
  }

  const targetDeviceId = session.senderDeviceId === ws.deviceId
    ? session.receiverDeviceId
    : session.senderDeviceId

  const target = devices.get(targetDeviceId)
  if (!target) {
    send(ws, { type: 'error', reason: 'Other device is offline.' })
    return
  }

  session.expiresAt = now() + SESSION_TTL_MS
  send(target.ws, {
    type: 'signal',
    sessionId: session.sessionId,
    data: payload.data
  })
}

const server = http.createServer((req, res) => {
  cleanExpiredState()

  if (req.url === '/health') {
    res.writeHead(200, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({
      ok: true,
      onlineDevices: devices.size,
      activeSessions: sessions.size
    }))
    return
  }

  res.writeHead(404, { 'Content-Type': 'application/json' })
  res.end(JSON.stringify({ error: 'not found' }))
})

const wss = new WebSocketServer({ server })

wss.on('connection', (ws) => {
  ws.deviceId = null

  ws.on('message', (raw) => {
    cleanExpiredState()

    let msg
    try {
      msg = JSON.parse(raw)
    } catch {
      return
    }

    if (msg.type === 'register') {
      registerDevice(ws, msg.identity || {})
      return
    }

    if (!ws.deviceId) {
      send(ws, { type: 'error', reason: 'Register first.' })
      return
    }

    const record = devices.get(ws.deviceId)
    if (record) {
      record.lastSeenAt = now()
    }

    if (msg.type === 'heartbeat') {
      send(ws, { type: 'heartbeat-ok', at: new Date().toISOString() })
      return
    }

    if (msg.type === 'presence-query') {
      routePresenceQuery(ws, msg)
      return
    }

    if (msg.type === 'transfer-request') {
      routeTransferRequest(ws, msg)
      return
    }

    if (msg.type === 'transfer-response') {
      routeTransferResponse(ws, msg)
      return
    }

    if (msg.type === 'signal') {
      routeSignal(ws, msg)
    }
  })

  ws.on('close', () => {
    if (ws.deviceId && devices.get(ws.deviceId)?.ws === ws) {
      devices.delete(ws.deviceId)
    }
  })

  ws.on('error', () => {})
})

setInterval(cleanExpiredState, 15 * 1000).unref()

server.listen(PORT, () => {
  console.log(`DropSend signalling server on port ${PORT}`)
})
