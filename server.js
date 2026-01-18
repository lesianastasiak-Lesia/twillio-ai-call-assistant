const express = require("express");
const bodyParser = require("body-parser");
const twilio = require("twilio");

const app = express();
app.use(bodyParser.urlencoded({ extended: false }));

const callState = new Map();

// MUST be set in Railway Variables:
// BASE_URL = https://twillio-ai-call-assistant-production.up.railway.app
const BASE_URL = process.env.BASE_URL || "";

// More natural than default. You can change later.
const VOICE = process.env.TWILIO_TTS_VOICE || "Polly.Joanna-Neural";
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

function say(verb, text) {
  verb.say({ voice: VOICE, language: LANG }, text);
}

function twimlGather(opts) {
  const sayText = opts.sayText;
  const actionPath = opts.actionPath;
  const timeout = opts.timeout;
  const speechTimeout = opts.speechTimeout;

  if (!BASE_URL) {
    // If BASE_URL not set, end gracefully instead of crashing
    const twiml = new twilio.twiml.VoiceResponse();
    say(twiml, "Thanks for calling. This line is being set up. Please try again shortly.");
    twiml.hangup();
    return twiml.toString();
  }

  const twiml = new twilio.twiml.VoiceResponse();
  const gather = twiml.gather({
    input: "speech",
    timeout: timeout,
    speechTimeout: speechTimeout,
    action: BASE_URL + actionPath,
    method: "POST",
    actionOnEmptyResult: true
  });

  say(gather, sayText);

  // Fallback if no speech
  say(twiml, "Thank you so much for calling. I'll be in touch soon.");
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
  lines.push("Caller name: " + (state.name || "(not provided)"));

  if (state.fromHidden) {
    if (state.callbackNumber) {
      lines.push("Caller number: Provided by caller: " + state.callbackNumber);
    } else {
      lines.push("Caller number: Hidden (caller did not provide)");
    }
  } else {
    lines.push("Caller number: " + (state.from || "(not provided)"));
  }

  lines.push("Type: " + (state.type || "(unknown)"));

  if (state.type === "Work") {
    lines.push("Topic: " + (state.topic || "(not provided)"));
    lines.push('Urgency (caller words): "' + (state.urgencyRaw || "(not provided)") + '"');
    lines.push("Urgency class: " + (state.urgencyClass || "(unknown)"));
  }

  lines.push("Action: " + (state.action || "(none)"));
  return lines.join("\n");
}

function logSummary(state) {
  console.log("=== CALL SUMMARY ===");
  console.log(buildSummary(state));
  console.log("====================");
}

// STEP 0: Incoming call -> Ask name (fast pauses)
app.post("/twilio/voice/incoming", (req, res) => {
  const callSid = req.body.CallSid;
  const from = req.body.From || "";

  const state = {
    callSid: callSid,
    from: from,
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
      "Hi, this is Lesia. I can't take the call right now, but I really appreciate you calling. Could you tell me your name, please?",
    actionPath: "/twilio/voice/step/name",
    timeout: 2,
    speechTimeout: 1
  });

  res.type("text/xml").send(xml);
});

// STEP 1: Name -> If hidden ask callback, else ask work/personal
app.post("/twilio/voice/step/name", (req, res) => {
  const callSid = req.body.CallSid;
  const speech = norm(req.body.SpeechResult);

  const state = callState.get(callSid) || {};
  if (speech) state.name = speech;
  callState.set(callSid, state);

  if (state.fromHidden && !state.callbackNumber) {
    const xml = twimlGather({
      sayText:
        "Thank you. I'm not seeing your callback number on my screen - could you share the best number to call you back?",
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

// Callback -> Ask work/personal
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

// Type -> Personal end; Work -> topic
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

  const xml = twimlGather({
    sayText: "Could you briefly share what it's regarding?",
    actionPath: "/twilio/voice/step/topic",
    timeout: 5,
    speechTimeout: 2
  });

  res.type("text/xml").send(xml);
});

// Topic -> urgency
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

// Urgency -> end + log summary
app.post("/twilio/voice/step/urgency", (req, res) => {
  const callSid = req.body.CallSid;
  const speech = norm(req.body.SpeechResult);

  const state = callState.get(callSid) || {};
  if (speech) state.urgencyRaw = speech;
  state.urgencyClass = classifyUrgency(state.urgencyRaw);
  state.action = "Summary sent (work)";
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
