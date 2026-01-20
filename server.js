const PORT = process.env.PORT || 3000;

// ===== SMS -> Email via Google Apps Script =====
app.post("/twilio/sms/incoming", async (req, res) => {
  try {
    const from = (req.body.From || "(unknown)").toString();
    const to = (req.body.To || "(unknown)").toString();
    const msg = (req.body.Body || "").toString();

    const subject = `New SMS to your Twilio number - from ${from}`;
    const emailBody =
      `To (your Twilio number): ${to}\n` +
      `From: ${from}\n` +
      `Message:\n${msg}\n`;

    console.log("=== SMS SUMMARY ===\n" + emailBody + "\n===================");

    // Reuse the same Google email sender as calls
    await sendEmailViaGoogle(subject, emailBody);

    // Twilio Messaging expects TwiML XML response
    res.type("text/xml").send("<Response></Response>");
  } catch (e) {
    console.error("SMS_HANDLER_ERROR:", e && e.message ? e.message : e);
    res.type("text/xml").send("<Response></Response>");
  }
});

app.listen(PORT, () => console.log("Server running on port " + PORT));
