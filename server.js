"use strict";

const express = require("express");
const bodyParser = require("body-parser");
const twilio = require("twilio");

const app = express();
app.use(bodyParser.urlencoded({ extended: false }));

// ===== Railway Variables (MUST exist) =====
const EMAIL_WEBHOOK_URL = (process.env.EMAIL_WEBHOOK_URL || "").trim();
const EMAIL_WEBHOOK_TOKEN = (process.env.EMAIL_WEBHOOK_TOKEN || "").trim();
const SUMMARY_TO_EMAIL = (process.env.SUMMARY_TO_EMAIL || "").trim();

// Voice settings (optional)
const VOICE = process.env.TWILIO_TTS_VOICE || "alice";
const LANG = process.env.TWILIO_TTS_LANG || "en-US";

// ===== Timings (your requirements) =====
const T_NAME = 3;          // name: 3s
const T_TYPE = 3;          // work/personal: 3s
const T_TOPIC = 7;         // work topic: 7s
const T_URGENCY = 3;       // urgent/can wait: 3s
const T_CALLBACK = 7;      // hidden number callback: 7s
const T_CALLBACK_TIME = 7; // when call back: 7s

const ST_SHORT = 1;
const ST_LONG = 2;

// ===== In-memory state =====
const callState = new Map();

// ===== Helpers =====
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
  // if unclear, default to Work
  return "Work";
}

// LOCKED RULES:
// - today / not right away / just today => CAN_WAIT
// - right now / urgent / asap / emergency => IMMEDIATE
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

function say(verb, text) {
  verb.say({ voice: VOICE, language: LANG }, text);
}

function gather(sayText, actionPath, timeoutSec, speechTimeoutSec) {
  const vr = new twilio.twiml.VoiceResponse();

  const g = vr.gather({
    input: "speech",
    timeout: timeoutSec,
    speechTimeout: speechTimeoutSec,
    action: actionPath, // RELATIVE PATH (prevents loops)
    method: "POST",
    actionOnEmptyResult: true
  });

  say(g, sayText);

  // If no speech captured, close politely
  say(vr, "Thank you so much for calling. I'll be in touch soon.");
  vr.hangup();

  return vr.toString();
}

function endCall(text) {
  const vr = new twilio.twiml.VoiceResponse();
  say(vr, text);
  vr.hangup();
  return vr.toString();
}

function buildSummary(s) {
  const lines = [];

  lines.push(`Caller name: ${s.name || "(not provided)"}`);

  if (s.fromHidden) {
    lines.push(
      `Caller number: ${
        s.callbackNumber ? "Provided by caller: " + s.callbackNumber : "Hidden (caller did not provide)"
      }`
    );
  } else {
    lines.push(`Caller number: ${s.from || "(not provided)"}`);
  }

  lines.push(`Type: ${s.type || "(unknown)"}`);

  if (s.type === "Work") {
    lines.push(`Topic: ${s.topic || "(not provided)"}`);
    lines.push(`Urgency (caller words): "${s.urgencyRaw || "(not provided)"}"`);
    lines.push(`Urgency class: ${s.urgencyClass || "(unknown)"}`);
    if (s.urgencyClass === "CAN_WAIT") {
      lines.push(`Callback time (caller words): "${s.callbackTimeRaw || "(not provided)"}"`);
    }
  }

  lines.push(`Action: ${s.action || "(none)"}`);
  return lines.join("\n");
}

// ===== Email via Google Apps Script (never breaks the call) =====
async function sendEmailViaGoogle(subject, bodyText) {
  try {
    console.log("EMAIL_WEBHOOK_ATTEMPT", {
      hasUrl: !!EMAIL_WEBHOOK_URL,
      hasToken: !!EMAIL_WEBHOOK_TOKEN,
      to: SUMMARY_TO_EMAIL || "(empty)"
    });

    if (!EMAIL_WEBHOOK_URL || !EMAIL_WEBHOOK_TOKEN || !SUMMARY_TO_EMAIL) {
      console.log("EMAIL_WEBHOOK_SKIP_MISSING_VARS");
      return;
    }

    const resp = await fetch(EMAIL_WEBHOOK_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        token: EMAIL_WEBHOOK_TOKEN,
        to: SUMMARY_TO_EMAIL,
        subject: subject,
        body: bodyText
      })
    });

    const text = await resp.text();
    if (!resp.ok) {
      console.log("EMAIL_WEBHOOK_FAIL_HTTP", resp.status, text);
      return;
    }

    console.log("EMAIL_WEBHOOK_OK", text);
  } catch (e) {
    console.log("EMAIL_WEBHOOK_FAIL", e && e.message ? e.message : e);
  }
}

function finalizeAndNotify(s) {
  const summary = buildSummary(s);

  console.log("=== CALL SUMMARY ===\n" + summary + "\n====================");

  // fire-and-forget, safe
  sendEmailViaGoogle(
    `New Call Summary - ${s.type || "Unknown"}${s.name ? " - " + s.name : ""}`,
    summary
  );
}

// ===== ROUTES =====

// STEP 0: Incoming -> ask name (3s)
app.post("/twilio/voice/incoming", (req, res) => {
  console.log("INCOMING_HIT", req.body.CallSid, req.body.From);

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

  const xml = gather(
    "Hi, this is Lesia. I can't take the call right now, but I really appreciate you calling. Could you tell me your name, please?",
    "/twilio/voice/step/name",
    T_NAME,
    ST_SHORT
  );

  res.type("text/xml").send(xml);
});

// STEP 1: Name -> hidden callback (7s) OR type (3s)
app.post("/twilio/voice/step/name", (req, res) => {
  const callSid = req.body.CallSid;
  const speech = norm(req.body.SpeechResult);

  const s = callState.get(callSid) || {};
  if (speech) s.name = speech;
  callState.set(callSid, s);

  if (s.fromHidden && !s.callbackNumber) {
    const xml = gather(
      "Thank you. I'm not seeing your callback number on my screen - could you share the best number to call you back?",
      "/twilio/voice/step/callback",
      T_CALLBACK,
      ST_LONG
    );
    return res.type("text/xml").send(xml);
  }

  const xml = gather(
    "Thank you. Is this about work, or something personal?",
    "/twilio/voice/step/type",
    T_TYPE,
    ST_SHORT
  );

  res.type("text/xml").send(xml);
});

// STEP 1b: callback -> type
app.post("/twilio/voice/step/callback", (req, res) => {
  const callSid = req.body.CallSid;
  const speech = norm(req.body.SpeechResult);

  const s = callState.get(callSid) || {};
  if (speech) s.callbackNumber = speech;
  callState.set(callSid, s);

  const xml = gather(
    "Thank you. Is this about work, or something personal?",
    "/twilio/voice/step/type",
    T_TYPE,
    ST_SHORT
  );

  res.type("text/xml").send(xml);
});

// STEP 2: Type -> Personal ends (summary email). Work continues to topic.
app.post("/twilio/voice/step/type", (req, res) => {
  const callSid = req.body.CallSid;
  const speech = norm(req.body.SpeechResult);

  const s = callState.get(callSid) || {};
  s.type = classifyWorkPersonal(speech);
  callState.set(callSid, s);

  if (s.type === "Personal") {
    s.action = "Summary sent (personal)";
    callState.set(callSid, s);

    finalizeAndNotify(s);

    const xml = endCall("Thank you so much for calling. I'll be in touch soon.");
    return res.type("text/xml").send(xml);
  }

  const xml = gather(
    "Could you briefly share what it's regarding?",
    "/twilio/voice/step/topic",
    T_TOPIC,
    ST_LONG
  );

  res.type("text/xml").send(xml);
});

// STEP 3: topic -> urgency
app.post("/twilio/voice/step/topic", (req, res) => {
  const callSid = req.body.CallSid;
  const speech = norm(req.body.SpeechResult);

  const s = callState.get(callSid) || {};
  if (speech) s.topic = speech;
  callState.set(callSid, s);

  const xml = gather(
    "Does this need immediate attention, or can it wait?",
    "/twilio/voice/step/urgency",
    T_URGENCY,
    ST_SHORT
  );

  res.type("text/xml").send(xml);
});

// STEP 4: urgency -> if CAN_WAIT ask callback time (7s), else finish
app.post("/twilio/voice/step/urgency", (req, res) => {
  const callSid = req.body.CallSid;
  const speech = norm(req.body.SpeechResult);

  const s = callState.get(callSid) || {};
  if (speech) s.urgencyRaw = speech;
  s.urgencyClass = classifyUrgency(s.urgencyRaw);
  callState.set(callSid, s);

  if (s.urgencyClass === "CAN_WAIT") {
    const xml = gather(
      "Thank you. When would be a good time for me to call you back?",
      "/twilio/voice/step/callback_time",
      T_CALLBACK_TIME,
      ST_LONG
    );
    return res.type("text/xml").send(xml);
  }

  s.action = "Summary sent (work - immediate)";
  callState.set(callSid, s);

  finalizeAndNotify(s);

  const xml = endCall("Thank you so much for calling. I'll be in touch soon.");
  res.type("text/xml").send(xml);
});

// STEP 5: callback time -> finish + email summary
app.post("/twilio/voice/step/callback_time", (req, res) => {
  const callSid = req.body.CallSid;
  const speech = norm(req.body.SpeechResult);

  const s = callState.get(callSid) || {};
  if (speech) s.callbackTimeRaw = speech;

  s.action = "Summary sent (work - can wait)";
  callState.set(callSid, s);

  finalizeAndNotify(s);

  const xml = endCall("Thank you so much for calling. I'll be in touch soon.");
  res.type("text/xml").send(xml);
});

// Health check
app.get("/", (req, res) => {
  res.json({ ok: true, service: "ai-call-assistant" });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log("Server running on port " + PORT));
