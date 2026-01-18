"use strict";

const express = require("express");
const bodyParser = require("body-parser");
const twilio = require("twilio");

const app = express();
app.use(bodyParser.urlencoded({ extended: false }));

const callState = new Map();

// Optional. If present, MUST be full https://domain (no trailing slash).
const ENV_BASE_URL = (process.env.BASE_URL || "").trim().replace(/\/+$/, "");

// Voice config
const VOICE = process.env.TWILIO_TTS_VOICE || "Polly.Joanna-Neural";
const LANG = process.env.TWILIO_TTS_LANG || "en-US";

// Timings per your requirements
const T_NAME_TIMEOUT = 3;       // name: 3s
const T_TYPE_TIMEOUT = 3;       // work/personal: 3s
const T_TOPIC_TIMEOUT = 7;      // work topic: 7s
const T_URGENCY_TIMEOUT = 3;    // urgent/can wait: 3s
const T_CALLBACK_TIMEOUT = 7;   // callback number (hidden): 7s
const T_CALLBACKTIME_TIMEOUT = 7; // "when should we call back": 7s

// Speech end detection
const ST_SHORT = 1; // short answers
const ST_LONG = 2;  // longer thought

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

  // Everything else => CAN_WAIT (including "today", "not right away", etc.)
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

function twimlGather(req, opts) {
  const { sayText, actionPath, timeoutSec, speechTimeoutSec } = opts;

  const vr = new twilio.twiml.VoiceResponse();
  const gather = vr.gather({
    input: "speech",
    timeout: timeoutSec,
    speechTimeout: speechTimeoutSec,
    action: absoluteUrl(req, actionPath),
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
  lines.push(`Caller name: ${state.name || "(not provided)"}`);

  if (state.fromHidden) {
    lines.push(
      `Caller number: ${
        state.callbackNumber
          ? "Provided by caller: " + state.callbackNumber
          : "Hidden (caller did not provide)"
      }`
    );
  } else {
    lines.push(`Caller number: ${state.from || "(not provided)"}`);
  }

  lines.push(`Type: ${state.type || "(unknown)"}`);

  if (state.type === "Work") {
    lines.push(`Topic: ${state.topic || "(not provided)"}`);
    lines.push(`Urgency (caller words): "${state.urgencyRaw || "(not provided)"}"`);
    lines.push(`Urgency class: ${state.urgencyClass || "(unknown)"}`);

    if (state.urgencyClass === "CAN_WAIT") {
      lines.push(`Callback time (caller words): "${state.callbackTimeRaw || "(not provided)"}"`);
    }
  }

  lines.push(`Action: ${state.action || "(none)"}`);
  return lines.join("\n");
}

function logSummary(state) {
  console.log("=== CALL SUMMARY ===");
  console.log(buildSummary(state));
  console.log("====================");
}

// ===== ROUTES =====

// STEP 0: ask name (3s)
app.post("/twilio/voice/incoming", (req, res) => {
  const callSid = req.body.CallSid;
  const from = req.body.From || "";

  const state = {
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
  };

  callState.set(callSid, state);

  const xml = twimlGather(req, {
    sayText:
      "Hi, this is Lesia. I can't take the call right now, but I really appreciate you calling. Could you tell me your name, please?",
    actionPath: "/twilio/voice/step/name",
    timeoutSec: T_NAME_TIMEOUT,
    speechTimeoutSec: ST_SHORT
  });

  res.type("text/xml").send(xml);
});

// STEP 1: name -> callback (if hidden, 7s) else type
app.post("/twilio/voice/step/name", (req, res) => {
  const callSid = req.body.CallSid;
  const speech = norm(req.body.SpeechResult);

  const state = callState.get(callSid) || {};
  if (speech) state.name = speech;
  callState.set(callSid, state);

  if (state.fromHidden && !state.callbackNumber) {
    const xml = twimlGather(req, {
      sayText:
        "Thank you. I'm not seeing your callback number on my screen - could you share the best number to call you back?",
      actionPath: "/twilio/voice/step/callback",
      timeoutSec: T_CALLBACK_TIMEOUT,     // 7s as requested
      speechTimeoutSec: ST_LONG
    });
    return res.type("text/xml").send(xml);
  }

  const xml = twimlGather(req, {
    sayText: "Thank you. Is this about work, or something personal?",
    actionPath: "/twilio/voice/step/type",
    timeoutSec: T_TYPE_TIMEOUT,
    speechTimeoutSec: ST_SHORT
  });

  res.type("text/xml").send(xml);
});

// STEP 1b: callback -> type
app.post("/twilio/voice/step/callback", (req, res) => {
  const callSid = req.body.CallSid;
  const speech = norm(req.body.SpeechResult);

  const state = callState.get(callSid) || {};
  if (speech) state.callbackNumber = speech;
  callState.set(callSid, state);

  const xml = twimlGather(req, {
    sayText: "Thank you. Is this about work, or something personal?",
    actionPath: "/twilio/voice/step/type",
    timeoutSec: T_TYPE_TIMEOUT,
    speechTimeoutSec: ST_SHORT
  });

  res.type("text/xml").send(xml);
});

// STEP 2: type -> personal ends; work -> topic (7s)
app.post("/twilio/voice/step/type", (req, res) => {
  const callSid = req.body.CallSid;
  const speech = norm(req.body.SpeechResult);

  const state = callState.get(callSid) || {};
  state.type = classifyWorkPersonal(speech);
  callState.set(callSid, state);

  if (state.type === "Personal") {
    state.action = "Summary sent (personal)";
    callState.set(callSid, state);

    logSummary(state);

    const xml = twimlSayAndHangup("Thank you so much for calling. I'll be in touch soon.");
    return res.type("text/xml").send(xml);
  }

  const xml = twimlGather(req, {
    sayText: "Could you briefly share what it's regarding?",
    actionPath: "/twilio/voice/step/topic",
    timeoutSec: T_TOPIC_TIMEOUT,          // 7s
    speechTimeoutSec: ST_LONG
  });

  res.type("text/xml").send(xml);
});

// STEP 3: topic -> urgency (3s)
app.post("/twilio/voice/step/topic", (req, res) => {
  const callSid = req.body.CallSid;
  const speech = norm(req.body.SpeechResult);

  const state = callState.get(callSid) || {};
  if (speech) state.topic = speech;
  callState.set(callSid, state);

  const xml = twimlGather(req, {
    sayText: "Does this need immediate attention, or can it wait?",
    actionPath: "/twilio/voice/step/urgency",
    timeoutSec: T_URGENCY_TIMEOUT,        // 3s
    speechTimeoutSec: ST_SHORT
  });

  res.type("text/xml").send(xml);
});

// STEP 4: urgency -> if CAN_WAIT ask callback time (7s), else finish
app.post("/twilio/voice/step/urgency", (req, res) => {
  const callSid = req.body.CallSid;
  const speech = norm(req.body.SpeechResult);

  const state = callState.get(callSid) || {};
  if (speech) state.urgencyRaw = speech;
  state.urgencyClass = classifyUrgency(state.urgencyRaw);
  callState.set(callSid, state);

  if (state.urgencyClass === "CAN_WAIT") {
    const xml = twimlGather(req, {
      sayText: "Thank you. When would be a good time for me to call you back?",
      actionPath: "/twilio/voice/step/callback_time",
      timeoutSec: T_CALLBACKTIME_TIMEOUT, // 7s
      speechTimeoutSec: ST_LONG
    });
    return res.type("text/xml").send(xml);
  }

  // IMMEDIATE -> summarize now (still no connect in this mode)
  state.action = "Summary sent (work - immediate)";
  callState.set(callSid, state);

  logSummary(state);

  const xml = twimlSayAndHangup("Thank you so much for calling. I'll be in touch soon.");
  res.type("text/xml").send(xml);
});

// STEP 5: callback time -> finalize + summary
app.post("/twilio/voice/step/callback_time", (req, res) => {
  const callSid = req.body.CallSid;
  const speech = norm(req.body.SpeechResult);

  const state = callState.get(callSid) || {};
  if (speech) state.callbackTimeRaw = speech;
  state.action = "Summary sent (work - can wait)";
  callState.set(callSid, state);

  logSummary(state);

  const xml = twimlSayAndHangup("Thank you so much for calling. I'll be in touch soon.");
  res.type("text/xml").send(xml);
});

// Health check
app.get("/", (req, res) => {
  res.json({ status: "ok", message: "AI Call Assistant is running" });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log("Server running on port " + PORT));
