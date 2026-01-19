"use strict";

const express = require("express");
const bodyParser = require("body-parser");
const twilio = require("twilio");
const sgMail = require("@sendgrid/mail");

const app = express();
app.use(bodyParser.urlencoded({ extended: false }));

// ===== CONFIG =====
const VOICE = process.env.TWILIO_TTS_VOICE || "alice";
const LANG = process.env.TWILIO_TTS_LANG || "en-US";

// timings
const T_NAME = 3;
const T_TYPE = 3;
const T_TOPIC = 7;
const T_URGENCY = 3;
const T_CALLBACK = 7;
const T_CALLBACK_TIME = 7;

const ST_SHORT = 1;
const ST_LONG = 2;

// SendGrid
const SENDGRID_API_KEY = process.env.SENDGRID_API_KEY || "";
const SUMMARY_TO_EMAIL = process.env.SUMMARY_TO_EMAIL || "";

if (SENDGRID_API_KEY) sgMail.setApiKey(SENDGRID_API_KEY);

// ===== HELPERS =====
const callState = new Map();

function norm(s) { return (s || "").toString().trim(); }

function isHiddenNumber(from) {
  const f = (from || "").toLowerCase();
  return !f || ["anonymous","unknown","private","blocked"].some(x => f.includes(x));
}

function classifyWorkPersonal(s) {
  s = (s||"").toLowerCase();
  if (s.includes("personal") || s.includes("private")) return "Personal";
  return "Work";
}

function classifyUrgency(s) {
  s = (s||"").toLowerCase();
  const immediate = ["right now","immediately","urgent","asap","emergency","can't wait","cannot wait"];
  return immediate.some(x => s.includes(x)) ? "IMMEDIATE" : "CAN_WAIT";
}

function say(v, t){ v.say({voice:VOICE, language:LANG}, t); }

function gather({sayText, action, timeout, speechTimeout}) {
  const vr = new twilio.twiml.VoiceResponse();
  const g = vr.gather({
    input:"speech",
    action,
    method:"POST",
    timeout,
    speechTimeout,
    actionOnEmptyResult:true
  });
  say(g, sayText);
  say(vr, "Thank you so much for calling. I'll be in touch soon.");
  vr.hangup();
  return vr.toString();
}

function end(text){
  const vr = new twilio.twiml.VoiceResponse();
  say(vr, text);
  vr.hangup();
  return vr.toString();
}

function buildSummary(s){
  const L=[];
  L.push(`Caller name: ${s.name||"(not provided)"}`);
  L.push(`Caller number: ${s.fromHidden ? (s.callbackNumber||"Hidden") : (s.from||"(not provided)")}`);
  L.push(`Type: ${s.type||"(unknown)"}`);
  if (s.type==="Work"){
    L.push(`Topic: ${s.topic||"(not provided)"}`);
    L.push(`Urgency (caller words): "${s.urgencyRaw||"(not provided)"}"`);
    L.push(`Urgency class: ${s.urgencyClass||"(unknown)"}`);
    if (s.urgencyClass==="CAN_WAIT"){
      L.push(`Callback time: "${s.callbackTimeRaw||"(not provided)"}"`);
    }
  }
  return L.join("\n");
}

async function sendEmail(summary){
  if (!SENDGRID_API_KEY || !SUMMARY_TO_EMAIL) return;
  await sgMail.send({
    to: SUMMARY_TO_EMAIL,
    from: "ai.solutions.ottawa@gmail.com",
    subject: "New Call Summary",
    text: summary
  });
}

function finalize(s){
  const summary = buildSummary(s);
  console.log("=== CALL SUMMARY ===\n"+summary+"\n====================");
  sendEmail(summary).catch(e=>console.error("EMAIL_ERROR", JSON.stringify(e, null, 2)));
}

// ===== ROUTES =====
app.post("/twilio/voice/incoming",(req,res)=>{
  const callSid=req.body.CallSid;
  const from=req.body.From||"";
  callState.set(callSid,{
    callSid, from, fromHidden:isHiddenNumber(from),
    name:"", callbackNumber:"",
    type:"", topic:"",
    urgencyRaw:"", urgencyClass:"",
    callbackTimeRaw:""
  });
  res.type("text/xml").send(gather({
    sayText:"Hi, this is Lesia. I can’t take the call right now. Could you tell me your name, please?",
    action:"/twilio/voice/name",
    timeout:T_NAME, speechTimeout:ST_SHORT
  }));
});

app.post("/twilio/voice/name",(req,res)=>{
  const s=callState.get(req.body.CallSid);
  s.name=norm(req.body.SpeechResult)||s.name;
  if (s.fromHidden && !s.callbackNumber){
    return res.type("text/xml").send(gather({
      sayText:"I’m not seeing your number. What’s the best number to call you back?",
      action:"/twilio/voice/callback",
      timeout:T_CALLBACK, speechTimeout:ST_LONG
    }));
  }
  res.type("text/xml").send(gather({
    sayText:"Is this about work, or something personal?",
    action:"/twilio/voice/type",
    timeout:T_TYPE, speechTimeout:ST_SHORT
  }));
});

app.post("/twilio/voice/callback",(req,res)=>{
  const s=callState.get(req.body.CallSid);
  s.callbackNumber=norm(req.body.SpeechResult)||s.callbackNumber;
  res.type("text/xml").send(gather({
    sayText:"Is this about work, or something personal?",
    action:"/twilio/voice/type",
    timeout:T_TYPE, speechTimeout:ST_SHORT
  }));
});

app.post("/twilio/voice/type",(req,res)=>{
  const s=callState.get(req.body.CallSid);
  s.type=classifyWorkPersonal(req.body.SpeechResult);
  if (s.type==="Personal"){
    finalize(s);
    return res.type("text/xml").send(end("Thank you so much for calling. I’ll be in touch soon."));
  }
  res.type("text/xml").send(gather({
    sayText:"Could you briefly share what it’s regarding?",
    action:"/twilio/voice/topic",
    timeout:T_TOPIC, speechTimeout:ST_LONG
  }));
});

app.post("/twilio/voice/topic",(req,res)=>{
  const s=callState.get(req.body.CallSid);
  s.topic=norm(req.body.SpeechResult)||s.topic;
  res.type("text/xml").send(gather({
    sayText:"Does this need immediate attention, or can it wait?",
    action:"/twilio/voice/urgency",
    timeout:T_URGENCY, speechTimeout:ST_SHORT
  }));
});

app.post("/twilio/voice/urgency",(req,res)=>{
  const s=callState.get(req.body.CallSid);
  s.urgencyRaw=norm(req.body.SpeechResult)||s.urgencyRaw;
  s.urgencyClass=classifyUrgency(s.urgencyRaw);
  if (s.urgencyClass==="CAN_WAIT"){
    return res.type("text/xml").send(gather({
      sayText:"When would be a good time for me to call you back?",
      action:"/twilio/voice/callback_time",
      timeout:T_CALLBACK_TIME, speechTimeout:ST_LONG
    }));
  }
  finalize(s);
  res.type("text/xml").send(end("Thank you so much for calling. I’ll be in touch soon."));
});

app.post("/twilio/voice/callback_time",(req,res)=>{
  const s=callState.get(req.body.CallSid);
  s.callbackTimeRaw=norm(req.body.SpeechResult)||s.callbackTimeRaw;
  finalize(s);
  res.type("text/xml").send(end("Thank you so much for calling. I’ll be in touch soon."));
});

app.get("/",(_,res)=>res.json({ok:true}));

const PORT=process.env.PORT||3000;
app.listen(PORT,()=>console.log("Server running on port "+PORT));
