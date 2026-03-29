const express = require('express');
const { v4: uuidv4 } = require('uuid');
const {
  SchemaConnector,
  StateUpdateRequest,
  DeviceErrorTypes,
} = require('st-schema');

const app = express();
app.use(express.json({ limit: '256kb' }));
app.use(express.urlencoded({ extended: false }));

const PORT = Number(process.env.PORT || 8080);

const ST_CLIENT_ID = process.env.ST_CLIENT_ID || '';
const ST_CLIENT_SECRET = process.env.ST_CLIENT_SECRET || '';

const DEV_USERNAME = process.env.DEV_USERNAME || 'admin';
const DEV_PASSWORD = process.env.DEV_PASSWORD || '1234';

const DEVICE_ID = process.env.DEVICE_ID || 'airpurifier-001';
const DEVICE_SECRET = process.env.DEVICE_SECRET || 'change-this-secret';

const REDIRECT_WHITELIST = (process.env.OAUTH_ALLOWED_REDIRECTS || '')
  .split(',')
  .map((v) => v.trim())
  .filter(Boolean);

const DEVICE_HANDLER_TYPE = 'c2c-fan-controller-4speed';
const MAIN_DEVICE_LABEL = process.env.MAIN_DEVICE_LABEL || 'Air Purifier';
const SLEEP_DEVICE_ID = `${DEVICE_ID}-sleep`;
const SLEEP_DEVICE_LABEL = process.env.SLEEP_DEVICE_LABEL || 'Air Purifier Sleep';

const MODE_TO_SPEED = {
  AUTO: 1,
  STRONG: 2,
  MEDIUM: 3,
  WEAK: 4,
};

const SPEED_TO_MODE = {
  1: 'AUTO',
  2: 'STRONG',
  3: 'MEDIUM',
  4: 'WEAK',
};

const store = {
  oauthCodes: new Map(),
  refreshTokens: new Map(),
  callbackTokensByPartnerAccessToken: new Map(),
  device: {
    id: DEVICE_ID,
    label: MAIN_DEVICE_LABEL,
    sleepId: SLEEP_DEVICE_ID,
    sleepLabel: SLEEP_DEVICE_LABEL,
    online: false,
    lastSeen: null,
    state: {
      power: false,
      mode: 'AUTO',
      sleep: false,
      currentDiff: 0,
      updatedAt: new Date().toISOString(),
    },
    commandQueue: [],
  },
};

function log(...args) {
  console.log(new Date().toISOString(), ...args);
}

function nowIso() {
  return new Date().toISOString();
}

function normalizeMode(mode) {
  const normalized = String(mode || '').trim().toUpperCase();
  return MODE_TO_SPEED[normalized] ? normalized : null;
}

function normalizeSpeed(speed) {
  const num = Number(speed);
  return SPEED_TO_MODE[num] ? num : null;
}

function getMainStates() {
  const s = store.device.state;
  return [
    {
      component: 'main',
      capability: 'st.switch',
      attribute: 'switch',
      value: s.power ? 'on' : 'off',
    },
    {
      component: 'main',
      capability: 'st.fanSpeed',
      attribute: 'fanSpeed',
      value: MODE_TO_SPEED[s.mode] || 1,
    },
  ];
}

function getSleepStates() {
  const s = store.device.state;
  return [
    {
      component: 'main',
      capability: 'st.switch',
      attribute: 'switch',
      value: s.sleep ? 'on' : 'off',
    },
  ];
}

function pushCommand(cmd) {
  const queue = store.device.commandQueue;
  if (queue.length >= 20) {
    queue.shift();
  }
  queue.push({
    id: uuidv4(),
    command: cmd,
    queuedAt: nowIso(),
  });
  log('QUEUE+', cmd, 'size=', queue.length);
}

function popCommand() {
  const item = store.device.commandQueue.shift();
  return item || null;
}

function isAllowedRedirectUri(uri) {
  if (!uri) return false;
  if (REDIRECT_WHITELIST.length === 0) return true;
  return REDIRECT_WHITELIST.includes(uri);
}

function getClientCredentials(req) {
  const auth = req.headers.authorization || '';
  if (auth.startsWith('Basic ')) {
    try {
      const decoded = Buffer.from(auth.slice(6), 'base64').toString('utf8');
      const idx = decoded.indexOf(':');
      if (idx >= 0) {
        return {
          clientId: decoded.slice(0, idx),
          clientSecret: decoded.slice(idx + 1),
        };
      }
    } catch (err) {
      log('Failed to parse Basic auth', err.message);
    }
  }

  return {
    clientId: req.body.client_id || '',
    clientSecret: req.body.client_secret || '',
  };
}

function authDevice(req, res, next) {
  const id = req.header('x-device-id');
  const secret = req.header('x-device-secret');

  if (id !== DEVICE_ID || secret !== DEVICE_SECRET) {
    return res.status(401).json({ ok: false, error: 'unauthorized' });
  }

  return next();
}

function schemaRequestLooksValid(req, res, next) {
  const token = req.body?.authentication?.token;
  if (!token) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  return next();
}

async function pushStateToSmartThings() {
  if (!ST_CLIENT_ID || !ST_CLIENT_SECRET) {
    log('Skipping proactive callback because ST_CLIENT_ID / ST_CLIENT_SECRET are missing');
    return;
  }

  const entries = [...store.callbackTokensByPartnerAccessToken.entries()];
  if (entries.length === 0) {
    return;
  }

  const deviceState = [
    {
      externalDeviceId: DEVICE_ID,
      states: getMainStates(),
    },
    {
      externalDeviceId: SLEEP_DEVICE_ID,
      states: getSleepStates(),
    },
  ];

  for (const [partnerAccessToken, item] of entries) {
    try {
      const updateRequest = new StateUpdateRequest(ST_CLIENT_ID, ST_CLIENT_SECRET);
      await updateRequest.updateState(item.callbackUrls, item.callbackAuthentication, deviceState);
      log('Proactive state push success for token', partnerAccessToken.slice(0, 8));
    } catch (err) {
      log('Proactive state push failed:', err?.message || err);
    }
  }
}

app.get('/', (req, res) => {
  res.send('SmartThings AirPurifier Cloud OK');
});

app.get('/health', (req, res) => {
  res.json({
    ok: true,
    service: 'smartthings-airpurifier-cloud',
    time: nowIso(),
    online: store.device.online,
    lastSeen: store.device.lastSeen,
    queueSize: store.device.commandQueue.length,
  });
});

app.get('/debug/status', (req, res) => {
  res.json({
    ok: true,
    device: store.device,
    callbackSubscriptions: store.callbackTokensByPartnerAccessToken.size,
    oauthCodes: store.oauthCodes.size,
    refreshTokens: store.refreshTokens.size,
  });
});

app.get('/oauth/authorize', (req, res) => {
  const { client_id, redirect_uri, state } = req.query;

  if (!redirect_uri) {
    return res.status(400).send('missing redirect_uri');
  }

  if (!isAllowedRedirectUri(String(redirect_uri))) {
    return res.status(400).send('redirect_uri_not_allowed');
  }

  return res.send(`
    <html>
      <head>
        <meta charset="utf-8" />
        <title>SmartThings 연동 승인</title>
      </head>
      <body style="font-family:sans-serif;padding:24px;max-width:420px;margin:auto;">
        <h2>SmartThings 연동 승인</h2>
        <p style="color:#666">로그인 후 Air Purifier 기기 연동을 승인하세요.</p>
        <form method="POST" action="/oauth/authorize">
          <input type="hidden" name="client_id" value="${String(client_id || '').replace(/"/g, '&quot;')}" />
          <input type="hidden" name="redirect_uri" value="${String(redirect_uri).replace(/"/g, '&quot;')}" />
          <input type="hidden" name="state" value="${String(state || '').replace(/"/g, '&quot;')}" />

          <div style="margin:12px 0;">
            <div style="margin-bottom:6px">Username</div>
            <input name="username" style="width:100%;padding:10px" />
          </div>

          <div style="margin:12px 0;">
            <div style="margin-bottom:6px">Password</div>
            <input type="password" name="password" style="width:100%;padding:10px" />
          </div>

          <button type="submit" style="padding:10px 14px">Allow</button>
        </form>
      </body>
    </html>
  `);
});

app.post('/oauth/authorize', (req, res) => {
  const { redirect_uri, state, username, password, client_id } = req.body;

  if (!redirect_uri) {
    return res.status(400).send('missing redirect_uri');
  }

  if (!isAllowedRedirectUri(String(redirect_uri))) {
    return res.status(400).send('redirect_uri_not_allowed');
  }

  if (username !== DEV_USERNAME || password !== DEV_PASSWORD) {
    return res.status(401).send('invalid_credentials');
  }

  const code = uuidv4();
  store.oauthCodes.set(code, {
    createdAt: Date.now(),
    clientId: String(client_id || ''),
  });

  const url = new URL(String(redirect_uri));
  url.searchParams.set('code', code);
  if (state) {
    url.searchParams.set('state', String(state));
  }

  return res.redirect(url.toString());
});

app.post('/oauth/token', (req, res) => {
  const { clientId, clientSecret } = getClientCredentials(req);
  const grantType = req.body.grant_type || 'authorization_code';

  if (clientId !== ST_CLIENT_ID || clientSecret !== ST_CLIENT_SECRET) {
    return res.status(401).json({ error: 'invalid_client' });
  }

  if (grantType === 'authorization_code') {
    const code = req.body.code;
    if (!code || !store.oauthCodes.has(code)) {
      return res.status(400).json({ error: 'invalid_grant' });
    }

    store.oauthCodes.delete(code);

    const accessToken = uuidv4();
    const refreshToken = uuidv4();
    store.refreshTokens.set(refreshToken, {
      issuedAt: Date.now(),
    });

    return res.json({
      token_type: 'Bearer',
      access_token: accessToken,
      refresh_token: refreshToken,
      expires_in: 3600,
    });
  }

  if (grantType === 'refresh_token') {
    const refreshToken = req.body.refresh_token;
    if (!refreshToken || !store.refreshTokens.has(refreshToken)) {
      return res.status(400).json({ error: 'invalid_grant' });
    }

    const newAccessToken = uuidv4();
    return res.json({
      token_type: 'Bearer',
      access_token: newAccessToken,
      refresh_token: refreshToken,
      expires_in: 3600,
    });
  }

  return res.status(400).json({ error: 'unsupported_grant_type' });
});

app.post('/device/report', authDevice, async (req, res) => {
  const body = req.body || {};
  const nextState = { ...store.device.state };

  if (typeof body.power === 'boolean') {
    nextState.power = body.power;
  }

  const normalizedMode = normalizeMode(body.mode);
  if (normalizedMode) {
    nextState.mode = normalizedMode;
  }

  if (typeof body.sleep === 'boolean') {
    nextState.sleep = body.sleep;
  }

  if (body.currentDiff !== undefined) {
    nextState.currentDiff = Number(body.currentDiff || 0);
  }

  nextState.updatedAt = nowIso();

  store.device.online = true;
  store.device.lastSeen = nowIso();
  store.device.state = nextState;

  log('DEVICE REPORT', JSON.stringify(store.device.state));

  res.json({ ok: true, state: store.device.state });

  try {
    await pushStateToSmartThings();
  } catch (err) {
    log('pushStateToSmartThings error:', err?.message || err);
  }
});

app.get('/device/poll', authDevice, (req, res) => {
  const item = popCommand();
  if (!item) {
    return res.json({ ok: true, command: 'NONE' });
  }

  return res.json({
    ok: true,
    command: item.command,
    id: item.id,
    queuedAt: item.queuedAt,
  });
});

app.post('/device/ack', authDevice, (req, res) => {
  const { id, success, message } = req.body || {};
  log('DEVICE ACK', JSON.stringify({ id, success, message }));
  res.json({ ok: true });
});

app.post('/device/test-command', (req, res) => {
  const { command } = req.body || {};
  if (!command) {
    return res.status(400).json({ ok: false, error: 'command_required' });
  }
  pushCommand(String(command));
  return res.json({ ok: true, queueSize: store.device.commandQueue.length });
});

const connector = new SchemaConnector()
  .clientId(ST_CLIENT_ID)
  .clientSecret(ST_CLIENT_SECRET)
  .discoveryHandler((accessToken, response) => {
    response
      .addDevice(DEVICE_ID, MAIN_DEVICE_LABEL, DEVICE_HANDLER_TYPE)
      .manufacturerName('Custom')
      .modelName('ESP32 AirPurifier')
      .roomHint('Living Room')
      .deviceHandlerType(DEVICE_HANDLER_TYPE);

    response
      .addDevice(SLEEP_DEVICE_ID, SLEEP_DEVICE_LABEL, 'c2c-switch')
      .manufacturerName('Custom')
      .modelName('ESP32 AirPurifier Sleep')
      .roomHint('Living Room')
      .deviceHandlerType('c2c-switch');
  })
  .stateRefreshHandler((accessToken, response) => {
    response.addDevice(DEVICE_ID, getMainStates());
    response.addDevice(SLEEP_DEVICE_ID, getSleepStates());
  })
  .commandHandler((accessToken, response, devices) => {
    for (const device of devices) {
      const deviceResponse = response.addDevice(device.externalDeviceId);

      for (const cmd of device.commands) {
        if (device.externalDeviceId === DEVICE_ID) {
          if (cmd.capability === 'st.switch') {
            if (cmd.command === 'on') {
              store.device.state.power = true;
              pushCommand('POWER_ON');
            } else if (cmd.command === 'off') {
              store.device.state.power = false;
              store.device.state.sleep = false;
              pushCommand('POWER_OFF');
            } else {
              deviceResponse.setError(
                `Unsupported switch command: ${cmd.command}`,
                DeviceErrorTypes.CAPABILITY_NOT_SUPPORTED,
              );
              continue;
            }
          } else if (cmd.capability === 'st.fanSpeed' && cmd.command === 'setFanSpeed') {
            const speed = normalizeSpeed(cmd.arguments?.[0]);
            if (!speed) {
              deviceResponse.setError(
                'Invalid fan speed. Allowed values: 1,2,3,4',
                DeviceErrorTypes.CAPABILITY_NOT_SUPPORTED,
              );
              continue;
            }

            const mode = SPEED_TO_MODE[speed];
            store.device.state.mode = mode;
            store.device.state.power = true;
            pushCommand(`SET_MODE:${mode}`);
          } else {
            deviceResponse.setError(
              `Unsupported capability: ${cmd.capability}`,
              DeviceErrorTypes.CAPABILITY_NOT_SUPPORTED,
            );
            continue;
          }

          store.device.state.updatedAt = nowIso();
          for (const st of getMainStates()) {
            deviceResponse.addState(st);
          }
        } else if (device.externalDeviceId === SLEEP_DEVICE_ID) {
          if (cmd.capability === 'st.switch') {
            if (cmd.command === 'on') {
              store.device.state.sleep = true;
              store.device.state.power = true;
              pushCommand('SLEEP_ON');
            } else if (cmd.command === 'off') {
              store.device.state.sleep = false;
              pushCommand('SLEEP_OFF');
            } else {
              deviceResponse.setError(
                `Unsupported switch command: ${cmd.command}`,
                DeviceErrorTypes.CAPABILITY_NOT_SUPPORTED,
              );
              continue;
            }
          } else {
            deviceResponse.setError(
              `Unsupported capability: ${cmd.capability}`,
              DeviceErrorTypes.CAPABILITY_NOT_SUPPORTED,
            );
            continue;
          }

          store.device.state.updatedAt = nowIso();
          for (const st of getSleepStates()) {
            deviceResponse.addState(st);
          }
        }
      }
    }
  })
  .callbackAccessHandler((accessToken, callbackAuthentication, callbackUrls) => {
    store.callbackTokensByPartnerAccessToken.set(accessToken, {
      callbackAuthentication,
      callbackUrls,
      createdAt: nowIso(),
    });
    log('Callback access stored for token', String(accessToken).slice(0, 8));
  })
  .integrationDeletedHandler((accessToken) => {
    store.callbackTokensByPartnerAccessToken.delete(accessToken);
    log('Integration deleted for token', String(accessToken).slice(0, 8));
  });

app.post('/schema', schemaRequestLooksValid, (req, res) => {
  return connector.handleHttpCallback(req, res);
});

app.listen(PORT, () => {
  log(`listening on ${PORT}`);
  log(`root: /`);
  log(`health: /health`);
  log(`schema: /schema`);
  log(`oauth authorize: /oauth/authorize`);
  log(`oauth token: /oauth/token`);
});