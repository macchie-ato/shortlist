// ============================================================
// Shortlist v1 — AI Candidate Screener (Simple / Manual)
// Google Apps Script
//
// SETUP:
// 1. Script Properties → add:
//    - SR_API_TOKEN           (ATS API token)
//    - LITELLM_API_KEY        (from your LiteLLM instance)
//    - CF_ACCESS_CLIENT_ID    (Cloudflare access header)
//    - CF_ACCESS_CLIENT_SECRET(Cloudflare access header)
//    - SLACK_BOT_TOKEN        (xoxb-... from api.slack.com)
//    - SLACK_USER_ID          (your Slack member ID e.g. U012AB3CD)
//
// 2. Paste your Job ID in screenNewCandidates() below
//
// 3. Run screenNewCandidates() manually
//    OR set a time trigger for automation
// ============================================================


// ============================================================
// CONFIG — replace with your own endpoint and model
// ============================================================

var LITELLM_ENDPOINT = "https://your-litellm-endpoint.com/chat/completions";
var LITELLM_MODEL    = "gemini-2.5-flash-lite"; // or your preferred model

function getConfig() {
  var props = PropertiesService.getScriptProperties();
  return {
    SR_API_TOKEN:     props.getProperty("SR_API_TOKEN"),
    LITELLM_API_KEY:  props.getProperty("LITELLM_API_KEY"),
    CF_CLIENT_ID:     props.getProperty("CF_ACCESS_CLIENT_ID"),
    CF_CLIENT_SECRET: props.getProperty("CF_ACCESS_CLIENT_SECRET"),
    SLACK_BOT_TOKEN:  props.getProperty("SLACK_BOT_TOKEN"),
    SLACK_USER_ID:    props.getProperty("SLACK_USER_ID"),
  };
}

var ATS_BASE = "https://api.smartrecruiters.com"; // Built on SmartRecruiters — update for your ATS
var ATS_APP_BASE = "https://www.smartrecruiters.com"; // Update for your ATS


// ============================================================
// MAIN — paste your Job ID here and run
// ============================================================

function screenNewCandidates() {
  var JOB_ID = "YOUR_JOB_ID_HERE"; // ← paste job UUID from your ATS

  log("=".repeat(60));
  log("Shortlist — Starting screening run");
  log("=".repeat(60));

  var config = getConfig();
  if (!config.SR_API_TOKEN || !config.LITELLM_API_KEY || !config.CF_CLIENT_ID || !config.CF_CLIENT_SECRET) {
    log("STOPPED: Missing credentials. Check Script Properties.");
    return;
  }
  log("Credentials loaded.");
  log("Slack alerts: " + (config.SLACK_BOT_TOKEN ? "enabled" : "not configured — skipping Slack"));

  log("\n[STEP 1] Fetching job from your ATS...");
  var job = getJob(JOB_ID, config.SR_API_TOKEN);
  log("Job found: " + job.title);

  log("\nGenerating hiring brief from JD...");
  job.hiringBrief = generateHiringBrief(job.title, job.jdText, config);
  log("Hiring brief generated.");

  log("\nFetching recruiters from SR hiring team...");
  var recruiterList     = getJobRecruiterEmails(JOB_ID, config.SR_API_TOKEN);
  var recruiterSlackIds = [];

  recruiterList.forEach(function(r) {
    log("Found recruiter: " + r.name + " (" + r.role + ") — " + r.email);
    var slackId = getSlackUserIdByEmail(r.email, config.SLACK_BOT_TOKEN);
    if (slackId) recruiterSlackIds.push(slackId);
  });

  if (recruiterSlackIds.length === 0) {
    log("No recruiter Slack IDs found — falling back to your Slack ID.");
    recruiterSlackIds.push(config.SLACK_USER_ID);
  }

  log("\n[STEP 2] Fetching candidates in New status...");
  var candidates = getNewCandidates(JOB_ID, config.SR_API_TOKEN);
  log("Found " + candidates.length + " candidate(s).");

  if (candidates.length === 0) {
    log("No candidates in New status. Nothing to do.");
    return;
  }

  var strongCount = 0;
  var errorCount  = 0;

  for (var i = 0; i < candidates.length; i++) {
    var c    = candidates[i];
    var name = (c.firstName + " " + c.lastName).trim();

    log("\n" + "-".repeat(60));
    log("[" + (i + 1) + "/" + candidates.length + "] " + name);

    try {
      var resumeBlob = getResumeBlob(JOB_ID, c.id, config.SR_API_TOKEN);
      log(resumeBlob ? "Resume: " + resumeBlob.fileName : "No resume attached.");

      var screening         = getScreeningAnswers(JOB_ID, c.id, config.SR_API_TOKEN);
      var salaryExpectation = screening["Salary Expectation (No Currency)"] || "Not provided";
      log("Salary expectation: " + salaryExpectation);

      log("Scoring...");
      var aiOutput = scoreCandidate(job.title, job.jdText, job.hiringBrief, resumeBlob, name, salaryExpectation, config);

      var score    = extractScore(aiOutput);
      var strong   = isStrong(score, aiOutput);
      var label    = strong ? (score >= 80 ? "STRONG" : "REVIEW") : "WEAK";
      var tagLabel = score >= 80 ? "Strong" : (score >= 60 ? "Review" : "Weak");

      log("Score: " + (score !== null ? score + "/100" : "N/A") + " — " + label);
      log(aiOutput);

      writeTagToCandidate(c.id, score !== null ? score : "N/A", tagLabel, config.SR_API_TOKEN);

      if (strong) {
        strongCount++;
        if (config.SLACK_BOT_TOKEN && recruiterSlackIds.length > 0) {
          var profileUrl = SR_APP_BASE + "/app/people/applications/" + c.id;
          recruiterSlackIds.forEach(function(slackId) {
            sendSlackDM(name, score, aiOutput, job.title, profileUrl, slackId, config);
          });
        }
      }

    } catch (e) {
      errorCount++;
      log("ERROR: " + e.message);
    }

    Utilities.sleep(1500);
  }

  log("\n" + "=".repeat(60));
  log("SCREENING COMPLETE");
  log("Screened  : " + candidates.length);
  log("Strong    : " + strongCount);
  log("Errors    : " + errorCount);
  log("=".repeat(60));

  if (config.SLACK_BOT_TOKEN && config.SLACK_USER_ID) {
    var summaryMsg = strongCount === 0
      ? "*Shortlist Run Complete — " + job.title + "*\nScreened *" + candidates.length + "* candidates. *None shortlisted.*"
      : "*Shortlist Run Complete — " + job.title + "*\nScreened *" + candidates.length + "* candidates. *" + strongCount + " shortlisted.*";

    recruiterSlackIds.forEach(function(slackId) {
      UrlFetchApp.fetch("https://slack.com/api/chat.postMessage", {
        method:  "POST",
        headers: { "Authorization": "Bearer " + config.SLACK_BOT_TOKEN, "Content-Type": "application/json" },
        payload: JSON.stringify({ channel: slackId, text: summaryMsg, mrkdwn: true }),
        muteHttpExceptions: true
      });
    });
  }
}


// ============================================================
// GENERATE HIRING BRIEF FROM JD
// ============================================================

function generateHiringBrief(jobTitle, jdText, config) {
  var systemPrompt =
    "You are a senior Talent Acquisition partner. " +
    "Extract a precise, actionable hiring brief from a job description. Be specific, not generic.";

  var userPrompt =
    "Read the job description and extract a structured hiring brief.\n\n" +
    "INDUSTRY: [specific sector]\n" +
    "ROLE TYPE: [IC / people manager / technical / commercial / operations]\n" +
    "SENIORITY: [entry / mid / senior / leadership]\n\n" +
    "TOP 3 MUST-HAVES:\n1. [specific, non-negotiable]\n2. [specific]\n3. [specific]\n\n" +
    "IDEAL CANDIDATE PROFILE:\n[2-3 sentences]\n\n" +
    "RED FLAGS:\n1. [specific]\n2. [specific]\n3. [specific]\n\n" +
    "FIRST INTERVIEW FOCUS:\n[what to probe in 30-min phone screen]\n\n" +
    "JOB DESCRIPTION:\n" + jdText;

  var payload = JSON.stringify({
    model:       LITELLM_MODEL,
    messages:    [{ role: "system", content: systemPrompt }, { role: "user", content: userPrompt }],
    temperature: 0.1,
    max_tokens:  700
  });

  var response = UrlFetchApp.fetch(LITELLM_ENDPOINT, {
    method:      "POST",
    contentType: "application/json; charset=utf-8",
    headers: {
      "Authorization":           "Bearer " + config.LITELLM_API_KEY,
      "CF-Access-Client-Id":     config.CF_CLIENT_ID,
      "CF-Access-Client-Secret": config.CF_CLIENT_SECRET
    },
    payload:            payload,
    muteHttpExceptions: true
  });

  if (response.getResponseCode() !== 200) return "Hiring brief unavailable.";
  return JSON.parse(response.getContentText()).choices[0].message.content || "Hiring brief unavailable.";
}


// ============================================================
// SCORE CANDIDATE
// ============================================================

function scoreCandidate(jobTitle, jdText, hiringBrief, resumeBlob, candidateName, salaryExpectation, config) {
  var resumeSection = resumeBlob
    ? "\n\n=== RESUME (base64, " + normaliseMimeType(resumeBlob.mimeType, resumeBlob.fileName) + ") ===\n"
      + Utilities.base64Encode(resumeBlob.bytes)
    : "\n\nNo resume attached — score on profile only. Note absence as a concern.";

  var systemPrompt =
    "You are a senior Talent Acquisition partner. " +
    "Rigorous, direct, and evidence-based. Never inflate scores. " +
    "Call out AI-inflated resumes. Every assessment point must cite specific evidence from the resume.";

  var userPrompt =
    "=== ROLE ===\nTitle: " + jobTitle + "\nCandidate: " + candidateName +
    "\nSalary Expectation: " + salaryExpectation + " (reference only)\n\n" +
    "=== HIRING BRIEF ===\n" + hiringBrief + "\n\n" +
    "=== JOB DESCRIPTION ===\n" + jdText + "\n" + resumeSection + "\n\n" +
    "=== SCORING ===\n80-100=Strong, 60-79=Review, below 60=Weak\n\n" +
    "AI-INFLATION DETECTION — flag if resume shows:\n" +
    "- Generic buzzwords (Spearhead, Orchestrate, Champion) with zero specifics\n" +
    "- Mirrors JD language suspiciously closely\n" +
    "- No numbers, team sizes, or verifiable outcomes\n" +
    "- Unverifiable employer names or inflated titles\n\n" +
    "=== OUTPUT FORMAT ===\n" +
    "Score: [0-100]\nTag: Strong / Review / Weak\n\n" +
    "Criteria Breakdown:\n" +
    "- Must-Have 1: [met/partially/not met] — [evidence]\n" +
    "- Must-Have 2: [met/partially/not met] — [evidence]\n" +
    "- Must-Have 3: [met/partially/not met] — [evidence]\n" +
    "- Industry Fit: [strong/partial/weak] — [evidence]\n" +
    "- Seniority Match: [good/over/under-qualified] — [evidence]\n" +
    "- Career Progression: [strong/inconsistent/unclear] — [evidence]\n\n" +
    "Strengths:\n- [evidence]\n- [evidence]\n\n" +
    "Red Flags:\n- [concern or None]\n- AI-Inflation: [Clean/Possibly/Likely] — [reason]\n\n" +
    "Assessment Prediction: [Pass/Uncertain/Fail] — [one sentence]\n\n" +
    "Suggested Interview Question: [specific to this candidate]\n\n" +
    "Salary Note: [reasonable for role/market?]";

  var payload = JSON.stringify({
    model:       LITELLM_MODEL,
    messages:    [{ role: "system", content: systemPrompt }, { role: "user", content: userPrompt }],
    temperature: 0.1,
    max_tokens:  1500
  });

  var response = UrlFetchApp.fetch(LITELLM_ENDPOINT, {
    method:      "POST",
    contentType: "application/json; charset=utf-8",
    headers: {
      "Authorization":           "Bearer " + config.LITELLM_API_KEY,
      "CF-Access-Client-Id":     config.CF_CLIENT_ID,
      "CF-Access-Client-Secret": config.CF_CLIENT_SECRET
    },
    payload:            payload,
    muteHttpExceptions: true
  });

  if (response.getResponseCode() !== 200) {
    throw new Error("LLM error " + response.getResponseCode() + ": " + response.getContentText());
  }
  return JSON.parse(response.getContentText()).choices[0].message.content;
}


// ============================================================
// SMARTRECRUITERS HELPERS
// ============================================================

function getJob(jobId, token) {
  try {
    var resp = UrlFetchApp.fetch(SR_BASE + "/jobs/" + jobId, {
      method: "GET", headers: { "X-SmartToken": token }, muteHttpExceptions: true
    });
    if (resp.getResponseCode() === 200) {
      var data = JSON.parse(resp.getContentText());
      var jd   = "No JD available.";
      try { jd = data.jobAd.sections.jobDescription.text; } catch (e) {}
      return { title: data.name || data.title || "Unknown Role", jdText: jd };
    }
  } catch (e) { log("getJob error: " + e.message); }

  try {
    var r = UrlFetchApp.fetch(SR_BASE + "/candidates?jobId=" + jobId + "&limit=1", {
      method: "GET", headers: { "X-SmartToken": token }, muteHttpExceptions: true
    });
    if (r.getResponseCode() === 200) {
      var first = (JSON.parse(r.getContentText()).content || [])[0];
      if (first && first.primaryAssignment && first.primaryAssignment.job) {
        return { title: first.primaryAssignment.job.title, jdText: "JD unavailable." };
      }
    }
  } catch (e2) { log("Fallback failed: " + e2.message); }

  return { title: "Unknown Role", jdText: "JD unavailable." };
}

function getNewCandidates(jobId, token) {
  var resp = srGet("/candidates?jobId=" + jobId + "&status=NEW&limit=80", token);
  return JSON.parse(resp).content || [];
}

function getResumeBlob(jobId, candidateId, token) {
  var attachments = JSON.parse(srGet("/candidates/" + candidateId + "/attachments", token)).content || [];
  for (var i = 0; i < attachments.length; i++) {
    var att = attachments[i];
    var url = (att.actions && att.actions.download && att.actions.download.url) ? att.actions.download.url : att.url;
    if (att.type === "RESUME" && url) {
      var r = UrlFetchApp.fetch(url, { method: "GET", headers: { "X-SmartToken": token }, muteHttpExceptions: true });
      return { bytes: r.getContent(), mimeType: r.getHeaders()["Content-Type"] || "application/octet-stream", fileName: att.name || "resume" };
    }
  }
  return null;
}

function getScreeningAnswers(jobId, candidateId, token) {
  var resp = UrlFetchApp.fetch(
    SR_BASE + "/candidates/" + candidateId + "/jobs/" + jobId + "/screening-answers",
    { method: "GET", headers: { "X-SmartToken": token }, muteHttpExceptions: true }
  );
  if (resp.getResponseCode() !== 200) return {};
  var answers = {};
  (JSON.parse(resp.getContentText()).content || []).forEach(function(q) {
    var fields = ((q.records || [])[0] || {}).fields || [];
    fields.forEach(function(f) {
      if (f.id === "value" && f.values && f.values.length) answers[q.name] = f.values[0].label || "";
    });
  });
  return answers;
}

function getJobRecruiterEmails(jobId, token) {
  try {
    var resp = UrlFetchApp.fetch(SR_BASE + "/jobs/" + jobId + "/hiring-team",
      { method: "GET", headers: { "X-SmartToken": token }, muteHttpExceptions: true });
    if (resp.getResponseCode() !== 200) return [];
    var recruiters = (JSON.parse(resp.getContentText()).content || []).filter(function(m) {
      return m.role === "RECRUITER" || m.role === "SECONDARY_RECRUITER";
    });
    var emails = [];
    recruiters.forEach(function(r) {
      try {
        var u = UrlFetchApp.fetch(SR_BASE + "/users/" + r.id,
          { method: "GET", headers: { "X-SmartToken": token }, muteHttpExceptions: true });
        if (u.getResponseCode() === 200) {
          var user = JSON.parse(u.getContentText());
          if (user.email) emails.push({ email: user.email, name: user.firstName + " " + user.lastName, role: r.role });
        }
      } catch (e) {}
    });
    return emails;
  } catch (e) { return []; }
}

function writeTagToCandidate(candidateId, score, tag, token) {
  try {
    var label = "Shortlist: " + tag + " (" + score + ")";
    var resp  = UrlFetchApp.fetch(SR_BASE + "/candidates/" + candidateId + "/tags", {
      method: "POST", headers: { "X-SmartToken": token, "Content-Type": "application/json" },
      payload: JSON.stringify({ tags: [label] }), muteHttpExceptions: true
    });
    log((resp.getResponseCode() === 200 || resp.getResponseCode() === 201) ? "Tag written: " + label : "Tag failed (" + resp.getResponseCode() + ")");
  } catch (e) { log("Tag error: " + e.message); }
}

function srGet(path, token) {
  var resp = UrlFetchApp.fetch(SR_BASE + path, {
    method: "GET", headers: { "X-SmartToken": token }, muteHttpExceptions: true
  });
  if (resp.getResponseCode() !== 200) throw new Error("SR error " + resp.getResponseCode() + " on " + path);
  return resp.getContentText();
}


// ============================================================
// SLACK HELPERS
// ============================================================

function getSlackUserIdByEmail(email, botToken) {
  try {
    var r = JSON.parse(UrlFetchApp.fetch(
      "https://slack.com/api/users.lookupByEmail?email=" + encodeURIComponent(email),
      { method: "GET", headers: { "Authorization": "Bearer " + botToken }, muteHttpExceptions: true }
    ).getContentText());
    return (r.ok && r.user) ? r.user.id : null;
  } catch (e) { return null; }
}

function sendSlackDM(candidateName, score, aiOutput, jobTitle, profileUrl, recruiterSlackId, config) {
  var lines   = aiOutput.split("\n").map(function(l) { return l.trim(); });
  var bullets = lines.filter(function(l) { return l.startsWith("-") || l.startsWith("•"); });
  var topNote = bullets.length > 0 ? bullets[0].replace(/^[-•]\s*/, "") : "See full screening in your ATS.";
  var emoji   = (score !== null && score >= 80) ? "*Strong Match" : "*Review Match";
  var message = emoji + " — " + jobTitle + "*\n" +
    "*" + candidateName + "* — Score: *" + (score !== null ? score + "/100" : "N/A") + "*\n" +
    "_" + topNote + "_\n" +
    "<" + profileUrl + "|View in your ATS>";

  UrlFetchApp.fetch("https://slack.com/api/chat.postMessage", {
    method:  "POST",
    headers: { "Authorization": "Bearer " + config.SLACK_BOT_TOKEN, "Content-Type": "application/json" },
    payload: JSON.stringify({ channel: recruiterSlackId, text: message, mrkdwn: true }),
    muteHttpExceptions: true
  });
}


// ============================================================
// SCORE PARSING + MIME TYPE
// ============================================================

function extractScore(aiOutput) {
  var m = aiOutput.match(/Score:\s*(\d{1,3})/);
  if (m) return parseInt(m[1]);
  var m2 = aiOutput.match(/\b([0-9]|10)\s*\/\s*10\b/);
  return m2 ? parseInt(m2[1]) * 10 : null;
}

function isStrong(score, aiOutput) {
  if (score !== null) return score >= 60;
  return aiOutput.toLowerCase().indexOf("strong") !== -1 || aiOutput.toLowerCase().indexOf("review") !== -1;
}

function normaliseMimeType(contentType, fileName) {
  if (contentType && contentType.indexOf("pdf") !== -1)  return "application/pdf";
  if (contentType && contentType.indexOf("word") !== -1) return "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
  var ext = (fileName || "").split(".").pop().toLowerCase();
  if (ext === "pdf")  return "application/pdf";
  if (ext === "docx") return "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
  return "application/pdf";
}

function log(msg) { Logger.log(msg); }


// ============================================================
// TRIGGER HELPERS (optional)
// Run installTrigger() ONCE to automate every 2 hours
// ============================================================

function installTrigger() {
  ScriptApp.getProjectTriggers().forEach(function(t) {
    if (t.getHandlerFunction() === "screenNewCandidates") ScriptApp.deleteTrigger(t);
  });
  ScriptApp.newTrigger("screenNewCandidates").timeBased().everyHours(2).create();
  Logger.log("Trigger installed — screenNewCandidates runs every 2 hours.");
}

function removeTrigger() {
  ScriptApp.getProjectTriggers().forEach(function(t) {
    if (t.getHandlerFunction() === "screenNewCandidates") ScriptApp.deleteTrigger(t);
  });
  Logger.log("Trigger removed.");
}
