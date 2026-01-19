"use strict";

const express = require("express");
const bodyParser = require("body-parser");
const twilio = require("twilio");
const sgMail = require("@sendgrid/mail");

const app = express();
app.use(bodyParser.urlencoded({ extended: false }));

// ===== Variables (Railway) =====
const SENDGRID_API_KEY = (process.env.SENDGRID_API_KEY || "").trim();
const SUMMARY_TO_EMAIL = (process.env.SUMMARY_TO_EMAIL || "").trim();

// MUST be a Verified Sender in SendGrid Single Sender Verification
const SENDGRID_FROM = (process.env.SENDGRID_FROM || "ai.solutions.ottawa@gmail.com").trim();

if (SENDGRID_API_KEY) {
  sgMail.setApiKey(SENDGRID_API_KEY);
}

// Voice settings
const VOICE = process.env.TWILIO_TTS_VOICE || "alice";
const LANG = process.env.TWILIO_TTS_LANG || "en-US";

// ===== Timings (your requirements) =====
const T_NAME = 3;
const T_TYPE = 3;
const T_TOPIC = 7;
const T_URGENCY = 3;
const T_CALLBACK = 7;
const T_CALLBACK_TIME = 7;

const ST_SHORT = 1;
const ST_LONG = 2;

// ===== In-memory state (MVP) =====
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
  // if unclear, default to Work (safer)
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

function say(verb, text) {
  verb.say({ voice: VOICE, language: LANG }, text);
}

function gather(sayText, actionPath, timeoutSec, speechTimeoutSec) {
  const vr = new twilio.twiml.VoiceResponse();

  const g = vr.gather({
    input: "speech",
    timeout: timeoutSec,
    speechTimeout: speechTimeoutSec,
    action: actionPath, // RELATIVE path prevents loops
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

  // Always include topic/urgency fields even if Personal (as optional)
  if (s.type === "Work") {
    lines.push(`Topic: ${s.topic || "(not provided)"}`);
    lines.push(`Urgency (caller words): "${s.urgencyRaw || "(not provided)"}"`);
    lines.push(`Urgency class: ${s.urgencyClass || "(unknown)"}`);

    if (s.urgencyClass === "CAN_WAIT") {
      lines.push(`Callback time (caller words): "${s.callbackTimeRaw || "(not provided)"}"`);
    }
  } else if (s.type === "Personal") {
    // Personal: no topic/urgency required, but we keep it clean
    // (If you want, we can add "Reason (optional)" later)
  }

  lines.push(`Action: ${s.action || "(none)"}`);
  return lines.join("\n");
}

// ===== Non-killing email sender =====
async function sendEmailSafe(summaryText, subjectText) {
  try {
    if (!SENDGRID_API_KEY || !SUMMARY_TO_EMAIL) return;

    await sgMail.send({
      to: SUMMARY_TO_EMAIL,
      from: SENDGRID_FROM,
      subject: subjectText,
      text: summaryText
    });
  } catch (e) {
    // NEVER throw; never break call flow
    const body = e && e.response && e.response.body ? e.response.body : null;
    console.error("EMAIL_ERROR_FULL:", body ? JSON.stringify(body) : (e.message || e));
  }
}

function finalizeAndNotify(state) {
  const summary = buildSummary(state);

  console.log("=== CALL SUMMARY ===\n" + summary + "\n====================");

  // Fire-and-forget (safe)
  sendEmailSafe(summary, `New Call Summary - ${state.type || "Unknown"}${state.name ? " - " + state.name : ""}`);
}

// ===== ROUTES =====

// STEP 0: Incoming -> Ask name (3s)
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

  const xml = gather(
    "Hi, this is Lesia. I can't take the call right now, but I really appreciate you calling. Could you tell me your name, please?",
    "/twilio/voice/step/name",
    T_NAME,
    ST_SHORT
  );

  res.type("text/xml").send(xml);
});

// STEP 1: Name -> if hidden ask callback (7s), else ask work/personal (3s)
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

// STEP 1b: Callback -> ask work/personal
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

// STEP 2: Type -> Personal finishes (email summary). Work -> topic
app.post("/twilio/voice/step/type", (req, res) => {
  const callSid = req.body.CallSid;
  const speech = norm(req.body.SpeechResult);

  const s = callState.get(callSid) || {};
  s.type = classifyWorkPersonal(speech);
  callState.set(callSid, s);

  if (s.type === "Personal") {
    // TEMPORARY MODE: personal also ends with summary email (no connect)
    s.action = "Summary sent (personal)";
    callState.set(callSid, s);

    finalizeAndNotify(s);

    const xml = endCall("Thank you so much for calling. I'll be in touch soon.");
    return res.type("text/xml").send(xml);
  }

  // Work topic (7s)
  const xml = gather(
    "Could you briefly share what it's regarding?",
    "/twilio/voice/step/topic",
    T_TOPIC,
    ST_LONG
  );

  res.type("text/xml").send(xml);
});

// STEP 3: Topic -> urgency (3s)
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

// STEP 4: Urgency -> if CAN_WAIT ask callback time (7s) else finish (email summary)
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

  // IMMEDIATE: still no connect (temporary mode), just email summary
  s.action = "Summary sent (work - immediate)";
  callState.set(callSid, s);

  finalizeAndNotify(s);

  const xml = endCall("Thank you so much for calling. I'll be in touch soon.");
  res.type("text/xml").send(xml);
});

// STEP 5: Callback time -> finish + email summary
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
