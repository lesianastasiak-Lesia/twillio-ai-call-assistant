I can’t take the call right now, but I really appreciate you calling. Could you tell me your name, please?",
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
