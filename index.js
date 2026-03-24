const express = require("express");
const bodyParser = require("body-parser");
const { v4: uuidv4 } = require("uuid");
const { SchemaConnector } = require("st-schema");

const app = express();
app.use(bodyParser.json());
app.use(bodyParser.urlencoded({ extended: true }));

const PORT = process.env.PORT || 3000;
const CLIENT_ID = process.env.CLIENT_ID;
const CLIENT_SECRET = process.env.CLIENT_SECRET;
const DEV_USERNAME = process.env.DEV_USERNAME || "admin";
const DEV_PASSWORD = process.env.DEV_PASSWORD || "1234";
const DEVICE_ID = process.env.DEVICE_ID || "airpurifier-001";
const DEVICE_SECRET = process.env.DEVICE_SECRET || "change-this-secret";

const db = {
  oauthCodes: new Map(),
  tokens: new Map(),
  device: {
    id: DEVICE_ID,
    label: "AirPurifier",
    online: false,
    lastSeen: null,
    pendingCommand: "NONE",
    state: {
      power: false,
      mode: "AUTO",
      sleep: false,
      currentDiff: 0
    }
  }
};

function authDevice(req, res, next) {
  const id = req.header("x-device-id");
  const secret = req.header("x-device-secret");

  if (id !== DEVICE_ID || secret !== DEVICE_SECRET) {
    return res.status(401).send("unauthorized");
  }
  next();
}

app.post("/device/report", authDevice, (req, res) => {
  const body = req.body || {};

  db.device.online = true;
  db.device.lastSeen = new Date().toISOString();
  db.device.state = {
    power: !!body.power,
    mode: body.mode || "AUTO",
    sleep: !!body.sleep,
    currentDiff: Number(body.currentDiff || 0)
  };

  res.json({ ok: true });
});

app.get("/device/poll", authDevice, (req, res) => {
  const cmd = db.device.pendingCommand || "NONE";
  db.device.pendingCommand = "NONE";
  res.send(cmd);
});

app.get("/debug/status", (req, res) => {
  res.json(db);
});

app.get("/", (req, res) => {
  res.send("SmartThings AirPurifier Cloud OK");
});

app.get("/oauth/authorize", (req, res) => {
  const { client_id, redirect_uri, state } = req.query;

  if (client_id !== CLIENT_ID) {
    return res.status(400).send("invalid client_id");
  }

  res.send(`
    <html>
      <body style="font-family:sans-serif;padding:24px">
        <h2>SmartThings 연동 승인</h2>
        <form method="POST" action="/oauth/authorize">
          <input type="hidden" name="client_id" value="${client_id}" />
          <input type="hidden" name="redirect_uri" value="${redirect_uri}" />
          <input type="hidden" name="state" value="${state || ""}" />
          <div style="margin-bottom:8px">
            <input name="username" placeholder="username" />
          </div>
          <div style="margin-bottom:8px">
            <input type="password" name="password" placeholder="password" />
          </div>
          <button type="submit">Allow</button>
        </form>
      </body>
    </html>
  `);
});

app.post("/oauth/authorize", (req, res) => {
  const { client_id, redirect_uri, state, username, password } = req.body;

  if (client_id !== CLIENT_ID) {
    return res.status(400).send("invalid client_id");
  }

  if (username !== DEV_USERNAME || password !== DEV_PASSWORD) {
    return res.status(401).send("invalid credentials");
  }

  const code = uuidv4();
  db.oauthCodes.set(code, { client_id });

  const url = new URL(redirect_uri);
  url.searchParams.set("code", code);
  if (state) url.searchParams.set("state", state);

  res.redirect(url.toString());
});

app.post("/oauth/token", (req, res) => {
  const { grant_type, code, client_id, client_secret } = req.body;

  if (client_id !== CLIENT_ID || client_secret !== CLIENT_SECRET) {
    return res.status(401).json({ error: "invalid_client" });
  }

  if (grant_type !== "authorization_code") {
    return res.status(400).json({ error: "unsupported_grant_type" });
  }

  if (!db.oauthCodes.has(code)) {
    return res.status(400).json({ error: "invalid_code" });
  }

  db.oauthCodes.delete(code);

  const accessToken = uuidv4();
  const refreshToken = uuidv4();
  db.tokens.set(accessToken, { user: "dev-user" });

  res.json({
    token_type: "Bearer",
    access_token: accessToken,
    refresh_token: refreshToken,
    expires_in: 3600
  });
});

const connector = new SchemaConnector();

function currentStates() {
  const s = db.device.state;

  const fan = s.mode === "AUTO"
    ? 1
    : s.mode === "STRONG"
    ? 2
    : s.mode === "MEDIUM"
    ? 3
    : 4;

  return [
    {
      component: "main",
      capability: "st.switch",
      attribute: "switch",
      value: s.power ? "on" : "off"
    },
    {
      component: "main",
      capability: "st.fanSpeed",
      attribute: "fanSpeed",
      value: fan
    },
    {
      component: "sleep",
      capability: "st.switch",
      attribute: "switch",
      value: s.sleep ? "on" : "off"
    }
  ];
}

connector.discoveryHandler((accessToken, response) => {
  response
    .addDevice(db.device.id, db.device.label, "c2c-air-conditioner")
    .manufacturerName("Custom")
    .modelName("ESP32 AirPurifier")
    .roomHint("Living Room")
    .deviceHandlerType("c2c-air-conditioner");
});

connector.stateRefreshHandler((accessToken, response) => {
  response.addDevice(db.device.id, currentStates());
});

connector.commandHandler((accessToken, response, devices) => {
  devices.forEach(device => {
    device.commands.forEach(command => {
      if (command.capability === "st.switch" && command.component === "main") {
        db.device.pendingCommand = "POWER";
      }

      if (command.capability === "st.switch" && command.component === "sleep") {
        db.device.pendingCommand = "SLEEP";
      }

      if (command.capability === "st.fanSpeed" && command.command === "setFanSpeed") {
        const speed = command.arguments[0];
        if (speed === 1) db.device.pendingCommand = "FAN_AUTO";
        else if (speed === 2) db.device.pendingCommand = "FAN_STRONG";
        else if (speed === 3) db.device.pendingCommand = "FAN_MEDIUM";
        else if (speed === 4) db.device.pendingCommand = "FAN_WEAK";
      }
    });

    response.addDevice(device.externalDeviceId, currentStates());
  });
});

app.post("/schema", (req, res) => {
  connector.handleHttpCallback(req, res);
});

app.listen(PORT, () => {
  console.log(`listening on ${PORT}`);
});