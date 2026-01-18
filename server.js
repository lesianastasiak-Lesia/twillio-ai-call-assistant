const express = require("express");
const bodyParser = require("body-parser");
const twilio = require("twilio");

const app = express();
app.use(bodyParser.urlencoded({ extended: false }));

app.post("/twilio/voice/incoming", (req, res) => {
  const VoiceResponse = twilio.twiml.VoiceResponse;
  const response = new VoiceResponse();

  response.say(
    { voice: "alice" },
    "Hi, this is Lesia. Thank you for calling. I will get back to you shortly."
  );

  response.hangup();
  res.type("text/xml");
  res.send(response.toString());
});

app.get("/", (req, res) => {
  res.json({ status: "ok", message: "AI Call Assistant is running" });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
