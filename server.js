const express = require("express");
const bodyParser = require("body-parser");
const twilio = require("twilio");

const app = express();

// Twilio sends application/x-www-form-urlencoded
app.use(bodyParser.urlencoded({ extended: false }));

// ===== In-memory state (MVP) =====
// For production across multiple instances, replace with Redis/Supabase.
// For now it's fine to validate full flow.
const callState = new Map();

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
  if (t.includes("work")  t.includes("business")  t.includes("job")) return "Work";
  // If unclear, default to Work (safer for business summaries)
  return "Work";
}

// LOCKED RULES:
// - "today / later today / this afternoon / before end of day / not right away / just today" => CAN WAIT
// - "right now / immediately / urgent / asap / as soon as possible / can't wait / emergency" => IMMEDIATE
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
  if (immediate.some(k => u.includes(k))) return "IMMEDIATE";

  // Everything else => CAN_WAIT (including "today")
  return "CAN_WAIT";
}

// Fast, human-feeling gather: low pause, quick end-of-speech detection
function twimlGather({ sayText, actionUrl, timeout = 3, speechTimeout = 1 }) {
  const twiml = new twilio.twiml.VoiceResponse();

  const gather = twiml.gather({
    input: "speech",
    timeout,                 // wait for caller to start speaking
    speechTimeout,           // wait for silence to end speech
    action: actionUrl,
    method: "POST",
    actionOnEmptyResult: true
  });

  // Twilio built-in TTS voice. (We can replace later with a custom voice provider.)
  gather.say({ voice: "alice" }, sayText);

  // If no speech captured, end politely
  twiml.say({ voice: "alice" }, "Thank you so much for calling. I’ll be in touch soon.");
  twiml.hangup();

  return twiml.toString();
}

function twimlSayAndHangup(text) {
  const twiml = new twilio.twiml.VoiceResponse();
  twiml.say({ voice: "alice" }, text);
  twiml.hangup();
  return twiml.toString();
}

function buildSummary(state) {
  const lines = [];
  lines.push(`Caller name: ${state.name || "(not provided)"}`);

  if (state.fromHidden) {
    lines.push(`Caller number: ${state.callbackNumber ? "Provided by caller: " + state.callbackNumber : "Hidden (caller did not provide)"}`);
  } else {
    lines.push(`Caller number: ${state.from || "(not provided)"}`);
  }

  lines.push(`Type: ${state.type || "(unknown)"}`);

  if (state.type === "Work") {
    lines.push(`Topic: ${state.topic || "(not provided)"}`);
    // show caller's words fully
    lines.push(`Urgency (caller’s words): "${state.urgencyRaw || "(not provided)"}"`);
    lines.push(`Urgency class: ${state.urgencyClass || "(unknown)"}`);
  }

  lines.push(`Action: ${state.action || "(none)"}`);
  return lines.join("\n");
}

function logSummary(state) {
  console.log("=== CALL SUMMARY ===");
  console.log(buildSummary(state));
  console.log("====================");
}

// ===== STEP 0: Incoming call -> Ask name (warm + short) =====
app.post("/twilio/voice/incoming", (req, res) => {
  const callSid = req.body.CallSid;
  const from = req.body.From || "";

  const state = {
    callSid,
    from,
    fromHidden: isHiddenNumber(from),
    name: "",
    type: "",
    topic: "",
    urgencyRaw: "",
    urgencyClass: "",
    callbackNumber: "",
    action: ""
  };

  callState.set(callSid, state);

  const xml = twimlGather({
    sayText:
      "Hi, this is Lesia.I can’t take the call right now, but I really appreciate you calling. Could you tell me your name, please?",
    actionUrl: "/twilio/voice/step/name"
  });

  res.type("text/xml").send(xml);
});

// ===== STEP 1: Name -> If hidden number ask callback, else ask work/personal =====
app.post("/twilio/voice/step/name", (req, res) => {
  const callSid = req.body.CallSid;
  const speech = norm(req.body.SpeechResult);

  const state = callState.get(callSid) || {};
  if (speech) state.name = speech;
  callState.set(callSid, state);

  // Ask callback only if number hidden
  if (state.fromHidden && !state.callbackNumber) {
    const xml = twimlGather({
      sayText:
        "Thank you. I’m not seeing your callback number on my screen - could you share the best number to call you back?",
      actionUrl: "/twilio/voice/step/callback_before_type"
    });
    return res.type("text/xml").send(xml);
  }

  const xml = twimlGather({
    sayText: "Thank you. Is this about work, or something personal?",
    actionUrl: "/twilio/voice/step/type"
  });

  res.type("text/xml").send(xml);
});

// ===== STEP 1b: Callback (only if hidden) -> Ask work/personal =====
app.post("/twilio/voice/step/callback_before_type", (req, res) => {
  const callSid = req.body.CallSid;
  const speech = norm(req.body.SpeechResult);

  const state = callState.get(callSid) || {};
  if (speech) state.callbackNumber = speech;
  callState.set(callSid, state);

  const xml = twimlGather({
    sayText: "Thank you. Is this about work, or something personal?",
    actionUrl: "/twilio/voice/step/type"
  });

  res.type("text/xml").send(xml);
});

// ===== STEP 2: Type -> Personal ends; Work continues to topic =====
app.post("/twilio/voice/step/type", (req, res) => {
  const callSid = req.body.CallSid;
  const speech = norm(req.body.SpeechResult);

  const state = callState.get(callSid) || {};
  state.type = classifyWorkPersonal(speech);
  callState.set(callSid, state);

  if (state.type === "Personal") {
    state.action = "Summary sent (personal)";
    callState.set(callSid, state);

    // We still log summary for your records
    logSummary(state);

    const xml = twimlSayAndHangup("Thank you so much for calling. I’ll be in touch soon.");
    return res.type("text/xml").send(xml);
  }

  // Work -> ask topic
  const xml = twimlGather({
    sayText: "Could you briefly share what it’s regarding?",
    actionUrl: "/twilio/voice/step/topic"
  });

  res.type("text/xml").send(xml);
});

// ===== STEP 3: Topic -> Ask urgency =====
app.post("/twilio/voice/step/topic", (req, res) => {
  const callSid = req.body.CallSid;
  const speech = norm(req.body.SpeechResult);

  const state = callState.get(callSid) || {};
  if (speech) state.topic = speech;
  callState.set(callSid, state);

  const xml = twimlGather({
    sayText: "Does this need immediate attention, or can it wait?",
    actionUrl: "/twilio/voice/step/urgency"
  });

  res.type("text/xml").send(xml);
});

// ===== STEP 4: Urgency -> End + log summary (no recording) =====
app.post("/twilio/voice/step/urgency", (req, res) => {
  const callSid = req.body.CallSid;
  const speech = norm(req.body.SpeechResult);

  const state = callState.get(callSid) || {};
  if (speech) state.urgencyRaw = speech;
  state.urgencyClass = classifyUrgency(state.urgencyRaw);

  // In this mode (no recording), we do not connect calls — we always summarize.
  state.action = "Summary sent (work)";
  callState.set(callSid, state);

  logSummary(state);

  const xml = twimlSayAndHangup("Thank you so much for calling. I’ll be in touch soon.");
  res.type("text/xml").send(xml);
});

// Health check
app.get("/", (req, res) => {
  res.json({ status: "ok", message: "AI Call Assistant is running" });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
});

  res.type("text/xml").send(xml);
});

// ===== STEP 1: Name -> If hidden, ask callback; else ask work/personal =====
app.post("/twilio/voice/step/name", (req, res) => {
  const callSid = req.body.CallSid;
  const speech = norm(req.body.SpeechResult);

  const state = callState.get(callSid) || {};
  if (speech) state.name = speech;
  callState.set(callSid, state);

  if (state.fromHidden && !state.callbackNumber) {
    const xml = twimlGather({
      sayText:
        "Thank you. I’m not seeing your callback number on my screen - could you share the best number to call you back?",
      actionPath: "/twilio/voice/step/callback",
      timeout: 3,
      speechTimeout: 1
    });
    return res.type("text/xml").send(xml);
  }

  const xml = twimlGather({
    sayText: "Thank you. Is this about work, or something personal?",
    actionPath: "/twilio/voice/step/type",
    timeout: 3,
    speechTimeout: 1
  });

  res.type("text/xml").send(xml);
});

// ===== Callback (only if hidden) -> work/personal =====
app.post("/twilio/voice/step/callback", (req, res) => {
  const callSid = req.body.CallSid;
  const speech = norm(req.body.SpeechResult);

  const state = callState.get(callSid) || {};
  if (speech) state.callbackNumber = speech;
  callState.set(callSid, state);

  const xml = twimlGather({
    sayText: "Thank you. Is this about work, or something personal?",
    actionPath: "/twilio/voice/step/type",
    timeout: 3,
    speechTimeout: 1
  });

  res.type("text/xml").send(xml);
});

// ===== Type -> Personal ends; Work asks topic =====
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
    const xml = twimlSayAndHangup("Thank you so much for calling. I’ll be in touch soon.");
    return res.type("text/xml").send(xml);
  }

  // Topic can be longer -> allow a bit more time
  const xml = twimlGather({
    sayText: "Could you briefly share what it’s regarding?",
    actionPath: "/twilio/voice/step/topic",
    timeout: 5,          // more time to start speaking
    speechTimeout: 2     // allow a short pause while thinking
  });

  res.type("text/xml").send(xml);
});

// ===== Topic -> urgency =====
app.post("/twilio/voice/step/topic", (req, res) => {
  const callSid = req.body.CallSid;
  const speech = norm(req.body.SpeechResult);

  const state = callState.get(callSid) || {};
  if (speech) state.topic = speech;
  callState.set(callSid, state);

  const xml = twimlGather({
    sayText: "Does this need immediate attention, or can it wait?",
    actionPath: "/twilio/voice/step/urgency",
    timeout: 3,
    speechTimeout: 1
  });

  res.type("text/xml").send(xml);
});

// ===== Urgency -> end + summary =====
app.post("/twilio/voice/step/urgency", (req, res) => {
  const callSid = req.body.CallSid;
  const speech = norm(req.body.SpeechResult);

  const state = callState.get(callSid) || {};
  if (speech) state.urgencyRaw = speech;
  state.urgencyClass = classifyUrgency(state.urgencyRaw);

  state.action = "Summary sent (work)";
  callState.set(callSid, state);

  logSummary(state);

  const xml = twimlSayAndHangup("Thank you so much for calling. I’ll be in touch soon.");
  res.type("text/xml").send(xml);
});

// Health check
app.get("/", (req, res) => {
  res.json({ status: "ok", message: "AI Call Assistant is running" });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
const express = require("express");
const bodyParser = require("body-parser");
const twilio = require("twilio");

const app = express();
app.use(bodyParser.urlencoded({ extended: false }));

const callState = new Map();

// === CONFIG ===
const BASE_URL = process.env.BASE_URL; // MUST be set in Railway
const VOICE = process.env.TWILIO_TTS_VOICE || "Polly.Joanna-Neural"; // more natural
const LANG = process.env.TWILIO_TTS_LANG || "en-US";

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
  if (t.includes("work")  t.includes("business")  t.includes("job")) return "Work";
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
  if (immediate.some(k => u.includes(k))) return "IMMEDIATE";
  return "CAN_WAIT";
}

function say(verb, text) {
  // Twilio <Say> supports Polly/Google voices.  [oai_citation:2‡Twilio](https://www.twilio.com/docs/voice/twiml/say?utm_source=chatgpt.com)
  verb.say({ voice: VOICE, language: LANG }, text);
}

function twimlGather({ sayText, actionPath, timeout, speechTimeout }) {
  if (!BASE_URL) throw new Error("BASE_URL is not set");

  const twiml = new twilio.twiml.VoiceResponse();
  const gather = twiml.gather({
    input: "speech",
    timeout,                 // wait for user to start speaking
    speechTimeout,           // seconds of silence to end speech
    action: ${BASE_URL}${actionPath},
    method: "POST",
    actionOnEmptyResult: true
  });

  say(gather, sayText);

  // If no speech captured
  say(twiml, "Thank you so much for calling. I’ll be in touch soon.");
  twiml.hangup();

  return twiml.toString();
}

function twimlSayAndHangup(text) {
  const twiml = new twilio.twiml.VoiceResponse();
  say(twiml, text);
  twiml.hangup();
  return twiml.toString();
}

function buildSummary(state) {
  const lines = [];
  lines.push(`Caller name: ${state.name || "(not provided)"}`);
  lines.push(
    `Caller number: ${
      state.fromHidden
        ? (state.callbackNumber ? "Provided by caller: " + state.callbackNumber : "Hidden (caller did not provide)")
        : (state.from || "(not provided)")
    }`
  );
  lines.push(`Type: ${state.type || "(unknown)"}`);
  if (state.type === "Work") {
    lines.push(`Topic: ${state.topic || "(not provided)"}`);
    lines.push(`Urgency (caller’s words): "${state.urgencyRaw || "(not provided)"}"`);
    lines.push(`Urgency class: ${state.urgencyClass || "(unknown)"}`);
  }
  lines.push(`Action: ${state.action || "(none)"}`);
  return lines.join("\n");
}

function logSummary(state) {
  console.log("=== CALL SUMMARY ===");
  console.log(buildSummary(state));
  console.log("====================");
}

// ===== STEP 0: Incoming call -> Ask name =====
// Fast for name: short pauses
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
    action: ""
  };
  callState.set(callSid, state);

  const xml = twimlGather({
    sayText:
      "Hi, this is Lesia. I can’t take the call right now, but I really appreciate you calling. Could you tell me your name, please?",
    actionPath: "/twilio/voice/step/name",
    timeout: 2,          // quick start
    speechTimeout: 1     // quick finish on short answers
