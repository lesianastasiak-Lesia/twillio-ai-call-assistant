"use strict";

const express = require("express");
const bodyParser = require("body-parser");
const twilio = require("twilio");
const nodemailer = require("nodemailer");

const app = express();
app.use(bodyParser.urlencoded({ extended: false }));

const callState = new Map();

// Optional. If present, MUST be full https://domain (no trailing slash).
const ENV_BASE_URL = (process.env.BASE_URL || "").trim().replace(/\/+$/, "");

// Voice settings
const VOICE = process.env.TWILIO_TTS_VOICE || "alice"; // stable voice; can change later
const LANG = process.env.TWILIO_TTS_LANG || "en-US";

// Email settings (Railway Variables)
const EMAIL_USER = (process.env.EMAIL_USER || "").trim();
const EMAIL_PASS = (process.env.EMAIL_PASS || "").trim();
const SUMMARY_TO_EMAIL = (process.env.SUMMARY_TO_EMAIL || "").trim();

// Timings (your requirements)
const T_NAME = 3;
const T_TYPE = 3;
const T_TOPIC = 7;
const T_URGENCY = 3;
const T_CALLBACK = 7;
const T_CALLBACK_TIME = 7;

const ST_SHORT = 1;
const ST_LONG = 2;

function norm(s) {
  return (s || "").toString().trim();
}

function isHiddenNumber(from) {
  const f = (from || "").toLowerCase();
  return (
    !f ||
    f.includes("anonymous") ||
    f.includes("unknown") ||
    f.includes("private") ||
    f.includes("blocked")
  );
}

function classifyWorkPersonal(typeRaw) {
  const t = (typeRaw || "").toLowerCase();
  if (t.includes("personal") || t.includes("private")) return "Personal";
  if (t.includes("work") || t.includes("business") || t.includes("job")) return "Work";
  return "Work";
}

// LOCKED RULES:
// today / not right away / just today => CAN_WAIT
// right now / urgent / asap / emergency => IMMEDIATE
function classifyUrgency(urgencyRaw) {
  const u = (urgencyRaw || "").toLowerCase();
  const immediate = [
    "right now",
    "immediately",
    "urgent",
    "asap",
    "as soon as possible",
    "can't wait",
    "cannot wait",
    "emergency"
  ];
  if (immediate.some((k) => u.includes(k))) return "IMMEDIATE";
  return "CAN_WAIT";
}

function getBaseUrlFromRequest(req) {
  const proto = (req.headers["x-forwarded-proto"] || req.protocol || "https").toString();
  const host = (req.headers["x-forwarded-host"] || req.headers.host || "").toString();
  if (!host) return "";
  return `${proto}://${host}`.replace(/\/+$/, "");
}

function absoluteUrl(req, path) {
  const base = ENV_BASE_URL || getBaseUrlFromRequest(req);
  if (!base) return path;
  return `${base}${path}`;
}

function say(verb, text) {
  verb.say({ voice: VOICE, language: LANG }, text);
}

function twimlGather(opts) {
  const { req, sayText, actionPath, timeoutSec, speechTimeoutSec } = opts;

  const vr = new twilio.twiml.VoiceResponse();
  const gather = vr.gather({
    input: "speech",
    timeout: timeoutSec,
    speechTimeout: speechTimeoutSec,
    action: actionPath, // RELATIVE PATH prevents loops reliably
    method: "POST",
    actionOnEmptyResult: true
  });

  say(gather, sayText);

  // If no speech captured, close politely
  say(vr, "Thank you so much for calling. I'll be in touch soon.");
  vr.hangup();

  return vr.toString();
}

function twimlSayAndHangup(text) {
  const vr = new twilio.twiml.VoiceResponse();
  say(vr, text);
  vr.hangup();
  return vr.toString();
}

function buildSummary(state) {
  const lines = [];
  lines.push("Caller name: " + (state.name || "(not provided)"));

  if (state.fromHidden) {
    lines.push(
      "Caller number: " +
        (state.callbackNumber
          ? "Provided by caller: " + state.callbackNumber
          : "Hidden (caller did not provide)")
    );
  } else {
    lines.push("Caller number: " + (state.from || "(not provided)"));
  }

  lines.push("Type: " + (state.type || "(unknown)"));

  if (state.type === "Work") {
    lines.push("Topic: " + (state.topic || "(not provided)"));
    lines.push('Urgency (caller words): "' + (state.urgencyRaw || "(not provided)") + '"');
    lines.push("Urgency class: " + (state.urgencyClass || "(unknown)"));
    if (state.urgencyClass === "CAN_WAIT") {
      lines.push('Callback time (caller words): "' + (state.callbackTimeRaw || "(not provided)") + '"');
    }
  }

  lines.push("Action: " + (state.action || "(none)"));
  return lines.join("\n");
}

function logSummary(state) {
  console.log("=== CALL SUMMARY ===");
  console.log(buildSummary(state));
  console.log("====================");
}

// ---- Email sender ----
let mailer = null;

function initMailerIfPossible() {
  if (!EMAIL_USER || !EMAIL_PASS || !SUMMARY_TO_EMAIL) return null;
  return nodemailer.createTransport({
    service: "gmail",
    auth: {
      user: EMAIL_USER,
      pass: EMAIL_PASS
    }
  });
}

async function sendSummaryEmail(state) {
  // Only send if configured
  if (!EMAIL_USER || !EMAIL_PASS || !SUMMARY_TO_EMAIL) return;

  if (!mailer) mailer = initMailerIfPossible();
  if (!mailer) return;

  const subject = `Call summary - ${state.type || "Unknown"}${state.name ? " - " + state.name : ""}`;
  const text = buildSummary(state);

  await mailer.sendMail({
    from: `"AI Call Assistant" <${EMAIL_USER}>`,
    to: SUMMARY_TO_EMAIL,
    subject,
    text
  });
}

function finalizeAndNotify(state) {
  // Always log
  logSummary(state);

  // Always email (your requirement)
  sendSummaryEmail(state).catch((err) => {
    console.error("EMAIL_SEND_ERROR:", err && err.message ? err.message : err);
  });
}

// ===== ROUTES =====

// STEP 0: Incoming call -> Ask name
app.post("/twilio/voice/incoming", (req, res) => {
  const callSid = req.body.CallSid;
  const from = req.body.From || "";

  callState.set(callSid, {
    callSid,
    from,
    fromHidden: isHiddenNumber(from),
    name: "",
    callbackNumber: "",
    type: "",
    topic: "",
    urgencyRaw: "",
    urgencyClass: "",
    callbackTimeRaw: "",
    action: ""
  });

  const xml = twimlGather({
    req,
    sayText:
      "Hi, this is Lesia. I can't take the call right now, but I really appreciate you calling. Could you tell me your name, please?",
    actionPath: "/twilio/voice/step/name",
    timeoutSec: T_NAME,
    speechTimeoutSec: ST_SHORT
  });

  res.type("text/xml").send(xml);
});

// STEP 1: Name -> if hidden ask callback (7s), else ask type
app.post("/twilio/voice/step/name", (req, res) => {
  const callSid = req.body.CallSid;
  const speech = norm(req.body.SpeechResult);

  const state = callState.get(callSid) || {};
  if (speech) state.name = speech;
  callState.set(callSid, state);

  if (state.fromHidden && !state.callbackNumber) {
    const xml = twimlGather({
      req,
      sayText:
        "Thank you. I'm not seeing your callback number on my screen - could you share the best number to call you back?",
      actionPath: "/twilio/voice/step/callback",
      timeoutSec: T_CALLBACK,
      speechTimeoutSec: ST_LONG
    });
    return res.type("text/xml").send(xml);
  }

  const xml = twimlGather({
    req,
    sayText: "Thank you. Is this about work, or something personal?",
    actionPath: "/twilio/voice/step/type",
    timeoutSec: T_TYPE,
    speechTimeoutSec: ST_SHORT
  });

  res.type("text/xml").send(xml);
});

// STEP 1b: callback -> ask type
app.post("/twilio/voice/step/callback", (req, res) => {
  const callSid = req.body.CallSid;
  const speech = norm(req.body.SpeechResult);

  const state = callState.get(callSid) || {};
  if (speech) state.callbackNumber = speech;
  callState.set(callSid, state);

  const xml = twimlGather({
    req,
    sayText: "Thank you. Is this about work, or something personal?",
    actionPath: "/twilio/voice/step/type",
    timeoutSec: T_TYPE,
    speechTimeoutSec: ST_SHORT
  });

  res.type("text/xml").send(xml);
});

// STEP 2: type -> personal ends; work -> topic
app.post("/twilio/voice/step/type", (req, res) => {
  const callSid = req.body.CallSid;
  const speech = norm(req.body.SpeechResult);

  const state = callState.get(callSid) || {};
  state.type = classifyWorkPersonal(speech);
  callState.set(callSid, state);

  if (state.type === "Personal") {
    state.action = "Summary sent (personal)";
    callState.set(callSid, state);

    finalizeAndNotify(state);

    const xml = twimlSayAndHangup("Thank you so much for calling. I'll be in touch soon.");
    return res.type("text/xml").send(xml);
  }

  const xml = twimlGather({
    req,
    sayText: "Could you briefly share what it's regarding?",
    actionPath: "/twilio/voice/step/topic",
    timeoutSec: T_TOPIC,
    speechTimeoutSec: ST_LONG
  });

  res.type("text/xml").send(xml);
});

// STEP 3: topic -> urgency
app.post("/twilio/voice/step/topic", (req, res) => {
  const callSid = req.body.CallSid;
  const speech = norm(req.body.SpeechResult);

  const state = callState.get(callSid) || {};
  if (speech) state.topic = speech;
  callState.set(callSid, state);

  const xml = twimlGather({
    req,
    sayText: "Does this need immediate attention, or can it wait?",
    actionPath: "/twilio/voice/step/urgency",
    timeoutSec: T_URGENCY,
    speechTimeoutSec: ST_SHORT
  });

  res.type("text/xml").send(xml);
});

// STEP 4: urgency -> if can wait ask callback time (7s), else finish
app.post("/twilio/voice/step/urgency", (req, res) => {
  const callSid = req.body.CallSid;
  const speech = norm(req.body.SpeechResult);

  const state = callState.get(callSid) || {};
  if (speech) state.urgencyRaw = speech;
  state.urgencyClass = classifyUrgency(state.urgencyRaw);
  callState.set(callSid, state);

  if (state.urgencyClass === "CAN_WAIT") {
    const xml = twimlGather({
      req,
      sayText: "Thank you. When would be a good time for me to call you back?",
      actionPath: "/twilio/voice/step/callback_time",
      timeoutSec: T_CALLBACK_TIME,
      speechTimeoutSec: ST_LONG
    });
    return res.type("text/xml").send(xml);
  }

  state.action = "Summary sent (work - immediate)";
  callState.set(callSid, state);

  finalizeAndNotify(state);

  const xml = twimlSayAndHangup("Thank you so much for calling. I'll be in touch soon.");
  res.type("text/xml").send(xml);
});

// STEP 5: callback time -> finish + summary
app.post("/twilio/voice/step/callback_time", (req, res) => {
  const callSid = req.body.CallSid;
  const speech = norm(req.body.SpeechResult);

  const state = callState.get(callSid) || {};
  if (speech) state.callbackTimeRaw = speech;

  state.action = "Summary sent (work - can wait)";
  callState.set(callSid, state);

  finalizeAndNotify(state);

  const xml = twimlSayAndHangup("Thank you so much for calling. I'll be in touch soon.");
  res.type("text/xml").send(xml);
});

// Health check
app.get("/", (req, res) => {
  res.json({ status: "ok", message: "AI Call Assistant is running" });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log("Server running on port " + PORT));
