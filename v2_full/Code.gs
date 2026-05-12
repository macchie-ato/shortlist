// ============================================================
// Shortlist v2 — AI Candidate Screener (Full Automated Pipeline)
// Google Apps Script
//
// SETUP:
// 1. Script Properties → add (5 keys only):
//    - SR_API_TOKEN            (ATS API token)
//    - LITELLM_API_KEY         (from your LiteLLM instance)
//    - CF_ACCESS_CLIENT_ID     (Cloudflare access header)
//    - CF_ACCESS_CLIENT_SECRET (Cloudflare access header)
//    - SLACK_BOT_TOKEN         (xoxb-... from api.slack.com)
//
// 2. Create a Google Sheet for the audit trail.
//    Paste its ID into AUDIT_SHEET_ID below.
//
// 3. Deploy as Web App (for Slack webhook):
//    Deploy → New Deployment → Web App
//    Execute as: Me | Access: Anyone
//    Copy the Web App URL
//
// 4. Paste Web App URL into your Slack App:
//    api.slack.com/apps → Event Subscriptions → Request URL
//    Subscribe to: message.im
//    Scopes: chat:write, im:read, im:history
//
// 5. Add any fixed Slack recipients to EXTRA_SLACK_IDS
//
// 6. Run installDayTrigger() and installNightTrigger() ONCE
//
// HOW TO START A NEW JOB (only manual step per job):
//    1. Paste the Job ID into startNewJob() below
//    2. Run startNewJob() once
//    3. Everything else is fully automated
//
// FULL AUTOMATED FLOW:
//    Step 1 → AI reads JD → generates hiring brief
//    Step 2 → Sends brief to recruiter via Slack DM
//    Step 3 → Recruiter replies with corrections OR "yes"
//             - Corrections → Gemini revises → V2 sent back
//             - "yes" → brief locked, screening begins
//    Step 4 → Candidates screened in batches (day/night)
//    Step 5 → Star rating + full AI review posted to ATS
//    Step 6 → ONE consolidated Slack DM per batch
//    Step 7 → Audit trail written to Google Sheet
//    Step 8 → Never auto-rejects. Human stays in control.
// ============================================================


// ============================================================
// CONSTANTS — replace with your own values
// ============================================================

var LITELLM_ENDPOINT = "https://your-litellm-endpoint.com/chat/completions"; // ← replace
var LITELLM_MODEL    = "gemini-2.5-flash-lite"; // or your preferred model
var ATS_BASE         = "https://api.smartrecruiters.com"; // ← update for your ATS
var ATS_APP_BASE     = "https://www.smartrecruiters.com"; // ← update for your ATS

// Batch settings
var DAY_BATCH_SIZE   = 20;  // candidates per run during office hours
var NIGHT_BATCH_SIZE = 25;  // candidates per run overnight

// Office hours
var OFFICE_START = 9;   // 9am
var OFFICE_END   = 18;  // 6pm

// Audit trail — paste your Google Sheet ID here
var AUDIT_SHEET_ID = "YOUR_AUDIT_SHEET_ID"; // ← replace

// Extra Slack recipients — always notified regardless of ATS hiring team
// Add Slack member IDs (e.g. "U012AB3CD") for anyone who should always receive updates
var EXTRA_SLACK_IDS = [
  // "U012AB3CD"
];


// ============================================================
// LOAD CREDENTIALS
// ============================================================

function getConfig() {
  var props = PropertiesService.getScriptProperties();
  return {
    SR_API_TOKEN:     props.getProperty("SR_API_TOKEN"),
    LITELLM_API_KEY:  props.getProperty("LITELLM_API_KEY"),
    CF_CLIENT_ID:     props.getProperty("CF_ACCESS_CLIENT_ID"),
    CF_CLIENT_SECRET: props.getProperty("CF_ACCESS_CLIENT_SECRET"),
    SLACK_BOT_TOKEN:  props.getProperty("SLACK_BOT_TOKEN")
  };
}


// ============================================================
// JOB-SPECIFIC SCORING RULES
// Add a block per job ID to customise scoring filters
// ============================================================

var JOB_REQUIREMENTS = {
  // "your-job-id": {
  //   mustHaveKeywords:   ["keyword1", "keyword2"],  // cap score at 40 if none present
  //   maxYearsExperience: 2,                          // penalise over-experienced candidates
  //   bonusKeywords:      ["bonus1", "bonus2"],       // +up to 10 pts
  //   customNote:         "Recruiter note for this role."
  // }
};


// ============================================================
// ▶ STEP 1 — START A NEW JOB (run this manually once per job)
// ============================================================

function startNewJob() {
  var JOB_ID = "YOUR_JOB_ID_HERE"; // ← paste job ID here

  log("=".repeat(60));
  log("Shortlist — Starting new job: " + JOB_ID);
  log("=".repeat(60));

  var config = getConfig();
  if (!config.SR_API_TOKEN || !config.LITELLM_API_KEY) {
    log("Missing credentials. Check Script Properties.");
    return;
  }

  var state = getJobState(JOB_ID);
  if (state.status && state.status !== "reset") {
    log("Job already running with status: " + state.status);
    log("Run resetJobFull() to restart from scratch.");
    return;
  }

  log("\nFetching job from ATS...");
  var job = getJob(JOB_ID, config.SR_API_TOKEN);
  log("Job found: " + job.title);

  log("\nResolving recruiter Slack IDs...");
  var recruiterSlackIds = resolveSlackRecipients(JOB_ID, config);
  log(recruiterSlackIds.length + " recipient(s) found.");

  log("\nGenerating hiring brief V1 from JD...");
  var brief = generateHiringBriefFromJD(job.title, job.jdText, null, config);
  log("Hiring brief V1 generated.");

  saveJobState(JOB_ID, {
    status:            "awaiting_approval",
    jobTitle:          job.title,
    jdText:            job.jdText,
    currentBrief:      brief,
    briefVersion:      1,
    recruiterSlackIds: recruiterSlackIds
  });

  logBriefEventToSheet({
    jobId:        JOB_ID,
    jobTitle:     job.title,
    event:        "Hiring Brief V1 Generated & Sent",
    briefVersion: 1,
    notes:        "Auto-generated from JD. Sent to " + recruiterSlackIds.length + " recruiter(s)."
  });

  sendBriefToSlack(JOB_ID, job.title, brief, 1, recruiterSlackIds, config);

  log("\nHiring brief V1 sent to recruiter on Slack.");
  log("Waiting for recruiter to reply 'yes' or provide corrections.");
}


// ============================================================
// SLACK WEBHOOK — receives recruiter DM replies
// ============================================================

function doPost(e) {
  var params = JSON.parse(e.postData.contents);
  var config = getConfig();

  if (params.type === "url_verification") {
    return ContentService.createTextOutput(params.challenge)
      .setMimeType(ContentService.MimeType.TEXT);
  }

  var event = params.event;
  if (!event || event.type !== "message" || event.bot_id || event.subtype) {
    return ContentService.createTextOutput("ok");
  }

  var userId      = event.user;
  var userMessage = (event.text || "").trim();

  var jobId = findJobForRecruiter(userId);
  if (!jobId) return ContentService.createTextOutput("ok");

  var state = getJobState(jobId);
  if (state.status !== "awaiting_approval") return ContentService.createTextOutput("ok");

  if (userMessage.toLowerCase() === "yes") {
    state.status        = "approved";
    state.approvedBrief = state.currentBrief;
    saveJobState(jobId, state);

    logBriefEventToSheet({
      jobId:        jobId,
      jobTitle:     state.jobTitle,
      event:        "Hiring Brief APPROVED",
      briefVersion: state.briefVersion,
      notes:        "Recruiter approved V" + state.briefVersion + ". Screening will begin."
    });

    state.recruiterSlackIds.forEach(function(slackId) {
      slackPost(slackId,
        "✅ *Hiring brief approved!* Shortlist will now begin screening candidates.\n" +
        "You'll receive a batch summary after each screening run.",
        config.SLACK_BOT_TOKEN
      );
    });

  } else {
    state.recruiterSlackIds.forEach(function(slackId) {
      slackPost(slackId, "Got your corrections! Revising the hiring brief now...", config.SLACK_BOT_TOKEN);
    });

    var newVersion   = state.briefVersion + 1;
    var revisedBrief = generateHiringBriefFromJD(state.jobTitle, state.jdText, userMessage, config);

    state.currentBrief = revisedBrief;
    state.briefVersion = newVersion;
    saveJobState(jobId, state);

    logBriefEventToSheet({
      jobId:        jobId,
      jobTitle:     state.jobTitle,
      event:        "Hiring Brief Revised → V" + newVersion,
      briefVersion: newVersion,
      notes:        "Recruiter corrections: " + userMessage.substring(0, 300)
    });

    sendBriefToSlack(jobId, state.jobTitle, revisedBrief, newVersion, state.recruiterSlackIds, config);
  }

  return ContentService.createTextOutput("ok");
}


// ============================================================
// SEND HIRING BRIEF TO SLACK
// ============================================================

function sendBriefToSlack(jobId, jobTitle, brief, version, slackIds, config) {
  var header = version > 1
    ? "🔄 *Revised Hiring Brief V" + version + " — " + jobTitle + "*\n_(Updated based on your corrections)_"
    : "📋 *Hiring Brief V" + version + " — " + jobTitle + "*\n_(Auto-generated from job description)_";

  var message =
    header + "\n\n" + brief + "\n\n" +
    "─────────────────────────────\n" +
    "✅ Reply *yes* to approve and start screening\n" +
    "✏️ Reply with corrections to get a revised version";

  slackIds.forEach(function(slackId) {
    slackPost(slackId, message, config.SLACK_BOT_TOKEN);
  });
}


// ============================================================
// GENERATE HIRING BRIEF FROM JD
// ============================================================

function generateHiringBriefFromJD(jobTitle, jdText, recruiterCorrections, config) {
  var systemPrompt =
    "You are a senior Talent Acquisition partner. " +
    "Extract a precise, actionable hiring brief. Be specific, never generic.";

  var userPrompt = recruiterCorrections
    ? "The recruiter has reviewed the hiring brief and sent corrections:\n\n" +
      "RECRUITER CORRECTIONS:\n" + recruiterCorrections + "\n\n" +
      "Rewrite the hiring brief incorporating these corrections. Only change what was flagged.\n\n" +
      "JOB DESCRIPTION:\n" + jdText + "\n\n" +
      "OUTPUT FORMAT:\n" +
      "INDUSTRY: [specific sector]\nROLE TYPE: [IC / people manager / technical / commercial / operations]\n" +
      "SENIORITY: [entry / mid / senior / leadership]\n\n" +
      "TOP 3 MUST-HAVES:\n1. [specific]\n2. [specific]\n3. [specific]\n\n" +
      "IDEAL CANDIDATE PROFILE:\n[2-3 sentences]\n\n" +
      "RED FLAGS:\n1. [specific]\n2. [specific]\n3. [specific]\n\n" +
      "FIRST INTERVIEW FOCUS:\n[specific to this role]"
    : "Read the job description and extract a structured hiring brief.\n\n" +
      "INDUSTRY: [specific sector]\nROLE TYPE: [IC / people manager / technical / commercial / operations]\n" +
      "SENIORITY: [entry / mid / senior / leadership]\n\n" +
      "TOP 3 MUST-HAVES:\n1. [specific, non-negotiable]\n2. [specific]\n3. [specific]\n\n" +
      "IDEAL CANDIDATE PROFILE:\n[2-3 sentences]\n\n" +
      "RED FLAGS:\n1. [specific]\n2. [specific]\n3. [specific]\n\n" +
      "FIRST INTERVIEW FOCUS:\n[what to probe in 30-min phone screen]\n\n" +
      "JOB DESCRIPTION:\n" + jdText;

  return callLLM(systemPrompt, userPrompt, 700, config) || "Hiring brief unavailable.";
}


// ============================================================
// MAIN SCREENING — called by day/night triggers automatically
// ============================================================

function screenNewCandidates() {
  var JOB_ID          = "YOUR_JOB_ID_HERE"; // ← paste same job ID as startNewJob()
  var jobRequirements = JOB_REQUIREMENTS[JOB_ID] || {};

  var officeHours = isOfficeHours();
  var batchSize   = officeHours ? DAY_BATCH_SIZE : NIGHT_BATCH_SIZE;
  var timeLabel   = officeHours ? "DAY" : "NIGHT";

  log("=".repeat(60));
  log("Shortlist — " + timeLabel + " run | Batch size: " + batchSize);
  log(getOfficeStatus());
  log("=".repeat(60));

  var config = getConfig();
  if (!config.SR_API_TOKEN || !config.LITELLM_API_KEY) {
    log("Missing credentials.");
    return;
  }

  var state = getJobState(JOB_ID);

  if (!state.status) { log("Job not started. Run startNewJob() first."); return; }

  if (state.status === "awaiting_approval") {
    log("PAUSED — Waiting for recruiter to approve hiring brief (V" + state.briefVersion + ").");
    if (config.SLACK_BOT_TOKEN) {
      state.recruiterSlackIds.forEach(function(slackId) {
        slackPost(slackId,
          "⏳ *Shortlist Reminder — " + state.jobTitle + "*\n" +
          "Screening is paused. Reply *yes* to approve the hiring brief, or send corrections.",
          config.SLACK_BOT_TOKEN
        );
      });
    }
    return;
  }

  if (state.status === "completed") { log("All candidates already processed."); return; }

  var approvedBrief     = state.approvedBrief;
  var recruiterSlackIds = state.recruiterSlackIds;
  var jobTitle          = state.jobTitle;
  var jdText            = state.jdText;

  log("\nFetching candidates in New status...");
  var allCandidates = getNewCandidates(JOB_ID, config.SR_API_TOKEN);
  log("Total in queue: " + allCandidates.length);

  if (allCandidates.length === 0) { log("No candidates in New status."); return; }

  var cursor     = getCursor(JOB_ID);
  var batch      = allCandidates.slice(cursor, cursor + batchSize);
  var nextCursor = cursor + batch.length;
  var batchNum   = Math.floor(cursor / batchSize) + 1;

  log("Batch #" + batchNum + ": candidates " + (cursor + 1) + " → " + nextCursor + " of " + allCandidates.length);

  if (batch.length === 0) { log("All candidates processed. Resetting cursor."); resetCursor(JOB_ID); return; }

  var shortlisted = [];
  var errorCount  = 0;

  for (var i = 0; i < batch.length; i++) {
    var c    = batch[i];
    var name = (c.firstName + " " + c.lastName).trim();

    log("\n" + "-".repeat(60));
    log("[" + (cursor + i + 1) + "/" + allCandidates.length + "] " + name);

    try {
      var resumeBlob        = getResumeBlob(JOB_ID, c.id, config.SR_API_TOKEN);
      var screening         = getScreeningAnswers(JOB_ID, c.id, config.SR_API_TOKEN);
      var salaryExpectation = screening["Salary Expectation (No Currency)"] || "Not provided";
      var profileUrl        = ATS_APP_BASE + "/app/people/applications/" + c.id;

      log(resumeBlob ? "Resume: " + resumeBlob.fileName : "No resume.");
      log("Salary: " + salaryExpectation);
      log("Scoring...");

      var aiOutput = scoreCandidate(jobTitle, jdText, approvedBrief, resumeBlob, name, salaryExpectation, config, jobRequirements);
      var score    = extractScore(aiOutput);
      var strong   = isStrong(score, aiOutput);
      var label    = strong ? (score >= 80 ? "STRONG" : "REVIEW") : "WEAK";
      var tagLabel = score >= 80 ? "Strong" : (score >= 60 ? "Review" : "Weak");

      log("Score: " + score + "/100 — " + label);
      log(aiOutput);

      writeTagToCandidate(c.id, score !== null ? score : "N/A", tagLabel, config.SR_API_TOKEN);

      if (score !== null) postReviewToATS(c.id, JOB_ID, score, aiOutput, config.SR_API_TOKEN);

      logCandidateToSheet({
        jobId: JOB_ID, jobTitle: jobTitle, candidateId: c.id, candidateName: name,
        score: score, label: label, tag: "Shortlist: " + tagLabel + " (" + (score !== null ? score : "N/A") + ")",
        briefVersion: state.briefVersion, timeLabel: timeLabel, batchNum: batchNum,
        salary: salaryExpectation, profileUrl: profileUrl, aiOutput: aiOutput, error: ""
      });

      if (strong) {
        var lines   = aiOutput.split("\n").map(function(l) { return l.trim(); });
        var bullets = lines.filter(function(l) { return l.startsWith("-") || l.startsWith("•"); });
        shortlisted.push({
          name: name, score: score, profileUrl: profileUrl,
          topNote: bullets.length > 0 ? bullets[0].replace(/^[-•]\s*/, "") : "See full screening in ATS.",
          label: label
        });
      }

    } catch (e) {
      errorCount++;
      log("ERROR: " + e.message);
      logCandidateToSheet({
        jobId: JOB_ID, jobTitle: jobTitle, candidateId: c.id, candidateName: name,
        score: null, label: "ERROR", briefVersion: state.briefVersion,
        timeLabel: timeLabel, batchNum: batchNum, error: e.message
      });
    }

    Utilities.sleep(1500);
  }

  var allDone   = nextCursor >= allCandidates.length;
  var remaining = Math.max(0, allCandidates.length - nextCursor);
  saveCursor(JOB_ID, allDone ? 0 : nextCursor);

  log("\n" + "=".repeat(60));
  log("BATCH COMPLETE — " + timeLabel);
  log("Processed  : " + batch.length);
  log("Shortlisted: " + shortlisted.length);
  log("Errors     : " + errorCount);
  log("Remaining  : " + remaining);
  log("=".repeat(60));

  logBatchSummaryToSheet({
    jobId: JOB_ID, jobTitle: jobTitle, timeLabel: timeLabel, batchNum: batchNum,
    processed: batch.length, shortlisted: shortlisted.length, errors: errorCount,
    remaining: remaining, briefVersion: state.briefVersion
  });

  if (config.SLACK_BOT_TOKEN && recruiterSlackIds.length > 0) {
    var hours      = getCurrentHours();
    var timeStamp  = "SGT " + hours.sgt + ":00 / IST " + hours.ist + ":00";
    var summaryMsg = buildConsolidatedSlackMessage(
      jobTitle, batch.length, allCandidates.length,
      shortlisted, remaining, nextCursor, timeLabel, timeStamp, allDone
    );
    recruiterSlackIds.forEach(function(slackId) { slackPost(slackId, summaryMsg, config.SLACK_BOT_TOKEN); });
    log("Slack summary sent.");
  }
}


// ============================================================
// CONSOLIDATED SLACK MESSAGE
// ============================================================

function buildConsolidatedSlackMessage(jobTitle, batchSize, total, shortlisted, remaining, nextCursor, timeLabel, timeStamp, allDone) {
  var header =
    "📋 *Shortlist " + timeLabel + " Batch — " + jobTitle + "* (" + timeStamp + ")\n" +
    "🔍 Processed: *" + batchSize + "* | Total: *" + total + "* | Remaining: *" + remaining + "*\n";

  if (shortlisted.length === 0) {
    return header + "❌ *No candidates shortlisted* in this batch.\n" +
      (allDone ? "Full cycle complete." : "Next batch picks up at candidate " + (nextCursor + 1) + ".");
  }

  var lines = shortlisted.map(function(c, idx) {
    var stars = "⭐".repeat(scoreToStars(c.score));
    return (idx + 1) + ". *" + c.name + "* — " + c.score + "/100 " + stars + "\n" +
      "   _" + c.topNote + "_\n" +
      "   <" + c.profileUrl + "|View in ATS>";
  }).join("\n\n");

  return header + "✅ *" + shortlisted.length + " candidate(s) shortlisted:*\n\n" + lines + "\n\n" +
    (allDone ? "Full cycle complete." : "Next batch picks up at candidate " + (nextCursor + 1) + ".");
}


// ============================================================
// AUDIT TRAIL — Google Sheets
// ============================================================

function logCandidateToSheet(data) {
  try {
    var ss    = SpreadsheetApp.openById(AUDIT_SHEET_ID);
    var sheet = ss.getSheetByName("Candidate Log");
    if (!sheet) {
      sheet = ss.insertSheet("Candidate Log");
      sheet.appendRow(["Timestamp","Job Title","Job ID","Candidate Name","Candidate ID","Score (/100)","Star Rating","Label","Tag","Brief Version","Day/Night","Batch #","Salary","ATS Profile Link","Full AI Review","Error"]);
      sheet.getRange(1,1,1,16).setFontWeight("bold");
      sheet.setFrozenRows(1);
    }
    var starLabel = !data.score ? "N/A" : data.score >= 85 ? "Strong Yes" : data.score >= 70 ? "Yes" : data.score >= 50 ? "Maybe" : data.score >= 30 ? "No" : "Strong No";
    sheet.appendRow([new Date(), data.jobTitle||"", data.jobId||"", data.candidateName||"", data.candidateId||"", data.score !== null && data.score !== undefined ? data.score : "N/A", starLabel, data.label||"", data.tag||"", "V"+(data.briefVersion||1), data.timeLabel||"", "Batch "+(data.batchNum||1), data.salary||"Not provided", data.profileUrl||"", (data.aiOutput||"").substring(0,500), data.error||""]);
  } catch (e) { log("Candidate log failed: " + e.message); }
}

function logBatchSummaryToSheet(data) {
  try {
    var ss    = SpreadsheetApp.openById(AUDIT_SHEET_ID);
    var sheet = ss.getSheetByName("Batch Summary");
    if (!sheet) {
      sheet = ss.insertSheet("Batch Summary");
      sheet.appendRow(["Timestamp","Job Title","Job ID","Day/Night","Batch #","Candidates Processed","Shortlisted","Errors","Remaining","Brief Version","SGT Time","IST Time"]);
      sheet.getRange(1,1,1,12).setFontWeight("bold");
      sheet.setFrozenRows(1);
    }
    var hours = getCurrentHours();
    sheet.appendRow([new Date(), data.jobTitle||"", data.jobId||"", data.timeLabel||"", "Batch "+(data.batchNum||1), data.processed||0, data.shortlisted||0, data.errors||0, data.remaining||0, "V"+(data.briefVersion||1), hours.sgt+":00 SGT", hours.ist+":00 IST"]);
  } catch (e) { log("Batch summary log failed: " + e.message); }
}

function logBriefEventToSheet(data) {
  try {
    var ss    = SpreadsheetApp.openById(AUDIT_SHEET_ID);
    var sheet = ss.getSheetByName("Brief Events");
    if (!sheet) {
      sheet = ss.insertSheet("Brief Events");
      sheet.appendRow(["Timestamp","Job Title","Job ID","Event","Brief Version","Notes"]);
      sheet.getRange(1,1,1,6).setFontWeight("bold");
      sheet.setFrozenRows(1);
    }
    sheet.appendRow([new Date(), data.jobTitle||"", data.jobId||"", data.event||"", "V"+(data.briefVersion||1), data.notes||""]);
  } catch (e) { log("Brief event log failed: " + e.message); }
}


// ============================================================
// JOB STATE MANAGEMENT
// ============================================================

function getJobState(jobId) {
  var raw = PropertiesService.getScriptProperties().getProperty("JOB_STATE_" + jobId);
  return raw ? JSON.parse(raw) : {};
}

function saveJobState(jobId, state) {
  PropertiesService.getScriptProperties().setProperty("JOB_STATE_" + jobId, JSON.stringify(state));
}

function resetJob(jobId) {
  PropertiesService.getScriptProperties().deleteProperty("JOB_STATE_" + jobId);
  PropertiesService.getScriptProperties().deleteProperty("CURSOR_" + jobId);
  Logger.log("Job reset. Run startNewJob() to restart.");
}

function findJobForRecruiter(slackUserId) {
  var props = PropertiesService.getScriptProperties().getProperties();
  for (var key in props) {
    if (key.indexOf("JOB_STATE_") === 0) {
      var state = JSON.parse(props[key]);
      if (state.recruiterSlackIds && state.recruiterSlackIds.indexOf(slackUserId) !== -1) {
        return key.replace("JOB_STATE_", "");
      }
    }
  }
  if (EXTRA_SLACK_IDS.indexOf(slackUserId) !== -1) {
    for (var key2 in props) {
      if (key2.indexOf("JOB_STATE_") === 0) return key2.replace("JOB_STATE_", "");
    }
  }
  return null;
}


// ============================================================
// RESOLVE SLACK RECIPIENTS
// ============================================================

function resolveSlackRecipients(jobId, config) {
  var recruiterList     = getJobRecruiterEmails(jobId, config.SR_API_TOKEN);
  var recruiterSlackIds = [];

  recruiterList.forEach(function(r) {
    log("Recruiter: " + r.name + " (" + r.email + ")");
    var slackId = getSlackUserIdByEmail(r.email, config.SLACK_BOT_TOKEN);
    if (slackId) recruiterSlackIds.push(slackId);
  });

  EXTRA_SLACK_IDS.forEach(function(id) {
    if (recruiterSlackIds.indexOf(id) === -1) recruiterSlackIds.push(id);
  });

  return recruiterSlackIds;
}


// ============================================================
// BATCH CURSOR
// ============================================================

function getCursor(jobId) {
  var val = PropertiesService.getScriptProperties().getProperty("CURSOR_" + jobId);
  return val ? parseInt(val) : 0;
}
function saveCursor(jobId, offset) {
  PropertiesService.getScriptProperties().setProperty("CURSOR_" + jobId, offset.toString());
}
function resetCursor(jobId) {
  PropertiesService.getScriptProperties().deleteProperty("CURSOR_" + jobId);
}


// ============================================================
// SCORE CANDIDATE
// ============================================================

function scoreCandidate(jobTitle, jdText, hiringBrief, resumeBlob, candidateName, salaryExpectation, config, jobReqs) {
  jobReqs = jobReqs || {};

  var resumeSection = resumeBlob
    ? "\n\n=== RESUME (base64, " + normaliseMimeType(resumeBlob.mimeType, resumeBlob.fileName) + ") ===\n"
      + Utilities.base64Encode(resumeBlob.bytes)
    : "\n\nNo resume — score on profile only. Flag absence as concern.";

  var systemPrompt =
    "You are a senior Talent Acquisition partner. " +
    "Rigorous, direct, evidence-based. Never inflate scores. " +
    "Call out AI-inflated resumes. Every point must cite specific evidence.";

  var userPrompt =
    "=== ROLE ===\nTitle: " + jobTitle + "\nCandidate: " + candidateName +
    "\nSalary Expectation: " + salaryExpectation + " (reference only)\n\n" +
    "=== APPROVED HIRING BRIEF ===\n" + hiringBrief + "\n\n" +
    "=== JOB DESCRIPTION ===\n" + jdText + "\n" + resumeSection + "\n\n" +
    (jobReqs.mustHaveKeywords && jobReqs.mustHaveKeywords.length
      ? "=== HARD REQUIREMENTS ===\nIf NONE present, cap score at 40:\n" +
        jobReqs.mustHaveKeywords.map(function(k) { return "- " + k; }).join("\n") + "\n\n" : "") +
    (jobReqs.maxYearsExperience
      ? "EXPERIENCE CAP: More than " + jobReqs.maxYearsExperience + " yrs = -15-20 pts + flag.\n\n" : "") +
    (jobReqs.bonusKeywords && jobReqs.bonusKeywords.length
      ? "BONUS: +up to 10 pts if these appear: " + jobReqs.bonusKeywords.join(", ") + "\n\n" : "") +
    (jobReqs.customNote ? "RECRUITER NOTE: " + jobReqs.customNote + "\n\n" : "") +
    "=== SCORING ===\n80-100=Strong, 60-79=Review, below 60=Weak\n\n" +
    "AI-INFLATION DETECTION:\n" +
    "- Generic buzzwords with zero specifics\n" +
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

  return callLLM(systemPrompt, userPrompt, 1500, config);
}


// ============================================================
// POST REVIEW TO ATS
// ============================================================

function postReviewToATS(candidateId, jobId, score, aiOutput, token) {
  var starRating, ratingLabel;
  if      (score >= 85) { starRating = 5; ratingLabel = "Strong Yes"; }
  else if (score >= 70) { starRating = 4; ratingLabel = "Yes";        }
  else if (score >= 50) { starRating = 3; ratingLabel = "Maybe";      }
  else if (score >= 30) { starRating = 2; ratingLabel = "No";         }
  else                  { starRating = 1; ratingLabel = "Strong No";  }

  var comment = "Shortlist AI Review\nScore: " + score + "/100 — " + ratingLabel + "\n─────────────\n\n" + aiOutput;

  try {
    var resp = UrlFetchApp.fetch(ATS_BASE + "/reviews-api/v201910/reviews", {
      method:  "POST",
      headers: { "X-SmartToken": token, "Content-Type": "application/json" },
      payload: JSON.stringify({
        candidateId: candidateId, jobId: jobId,
        overallRating: starRating, comment: comment.substring(0, 4000)
      }),
      muteHttpExceptions: true
    });
    var code = resp.getResponseCode();
    log(code === 200 || code === 201 ? "ATS Review: " + starRating + " star(s)" : "ATS Review failed (" + code + "): " + resp.getContentText());
  } catch (e) { log("ATS Review error: " + e.message); }
}


// ============================================================
// LITELLM HELPER
// ============================================================

function callLLM(systemPrompt, userPrompt, maxTokens, config) {
  var response = UrlFetchApp.fetch(LITELLM_ENDPOINT, {
    method:      "POST",
    contentType: "application/json; charset=utf-8",
    headers: {
      "Authorization":           "Bearer " + config.LITELLM_API_KEY,
      "CF-Access-Client-Id":     config.CF_CLIENT_ID,
      "CF-Access-Client-Secret": config.CF_CLIENT_SECRET
    },
    payload: JSON.stringify({
      model: LITELLM_MODEL,
      messages: [{ role: "system", content: systemPrompt }, { role: "user", content: userPrompt }],
      temperature: 0.1,
      max_tokens:  maxTokens
    }),
    muteHttpExceptions: true
  });

  if (response.getResponseCode() !== 200) throw new Error("LLM error " + response.getResponseCode() + ": " + response.getContentText());
  return JSON.parse(response.getContentText()).choices[0].message.content;
}


// ============================================================
// ATS HELPERS
// ============================================================

function getJob(jobId, token) {
  try {
    var resp = UrlFetchApp.fetch(ATS_BASE + "/jobs/" + jobId, { method: "GET", headers: { "X-SmartToken": token }, muteHttpExceptions: true });
    if (resp.getResponseCode() === 200) {
      var data = JSON.parse(resp.getContentText());
      var jd = "No JD available.";
      try { jd = data.jobAd.sections.jobDescription.text; } catch (e) {}
      return { title: data.name || data.title || "Unknown Role", jdText: jd };
    }
  } catch (e) { log("getJob error: " + e.message); }
  try {
    var r = UrlFetchApp.fetch(ATS_BASE + "/candidates?jobId=" + jobId + "&limit=1", { method: "GET", headers: { "X-SmartToken": token }, muteHttpExceptions: true });
    if (r.getResponseCode() === 200) {
      var first = (JSON.parse(r.getContentText()).content || [])[0];
      if (first && first.primaryAssignment && first.primaryAssignment.job) return { title: first.primaryAssignment.job.title, jdText: "JD unavailable." };
    }
  } catch (e2) { log("Fallback failed: " + e2.message); }
  return { title: "Unknown Role", jdText: "JD unavailable." };
}

function getNewCandidates(jobId, token) {
  var resp = srGet("/candidates?jobId=" + jobId + "&status=NEW&limit=500", token);
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
  var resp = UrlFetchApp.fetch(ATS_BASE + "/candidates/" + candidateId + "/jobs/" + jobId + "/screening-answers", { method: "GET", headers: { "X-SmartToken": token }, muteHttpExceptions: true });
  if (resp.getResponseCode() !== 200) return {};
  var answers = {};
  (JSON.parse(resp.getContentText()).content || []).forEach(function(q) {
    var fields = ((q.records || [])[0] || {}).fields || [];
    fields.forEach(function(f) { if (f.id === "value" && f.values && f.values.length) answers[q.name] = f.values[0].label || ""; });
  });
  return answers;
}

function getJobRecruiterEmails(jobId, token) {
  try {
    var resp = UrlFetchApp.fetch(ATS_BASE + "/jobs/" + jobId + "/hiring-team", { method: "GET", headers: { "X-SmartToken": token }, muteHttpExceptions: true });
    if (resp.getResponseCode() !== 200) return [];
    var recruiters = (JSON.parse(resp.getContentText()).content || []).filter(function(m) { return m.role === "RECRUITER" || m.role === "SECONDARY_RECRUITER"; });
    var emails = [];
    recruiters.forEach(function(r) {
      try {
        var u = UrlFetchApp.fetch(ATS_BASE + "/users/" + r.id, { method: "GET", headers: { "X-SmartToken": token }, muteHttpExceptions: true });
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
    var resp  = UrlFetchApp.fetch(ATS_BASE + "/candidates/" + candidateId + "/tags", {
      method: "POST", headers: { "X-SmartToken": token, "Content-Type": "application/json" },
      payload: JSON.stringify({ tags: [label] }), muteHttpExceptions: true
    });
    log((resp.getResponseCode() === 200 || resp.getResponseCode() === 201) ? "Tag written: " + label : "Tag failed (" + resp.getResponseCode() + ")");
  } catch (e) { log("Tag error: " + e.message); }
}

function srGet(path, token) {
  var resp = UrlFetchApp.fetch(ATS_BASE + path, { method: "GET", headers: { "X-SmartToken": token }, muteHttpExceptions: true });
  if (resp.getResponseCode() !== 200) throw new Error("ATS error " + resp.getResponseCode() + " on " + path);
  return resp.getContentText();
}


// ============================================================
// SLACK HELPERS
// ============================================================

function getSlackUserIdByEmail(email, botToken) {
  try {
    var r = JSON.parse(UrlFetchApp.fetch("https://slack.com/api/users.lookupByEmail?email=" + encodeURIComponent(email), { method: "GET", headers: { "Authorization": "Bearer " + botToken }, muteHttpExceptions: true }).getContentText());
    return (r.ok && r.user) ? r.user.id : null;
  } catch (e) { return null; }
}

function slackPost(channel, text, botToken) {
  var r = JSON.parse(UrlFetchApp.fetch("https://slack.com/api/chat.postMessage", {
    method: "POST",
    headers: { "Authorization": "Bearer " + botToken, "Content-Type": "application/json" },
    payload: JSON.stringify({ channel: channel, text: text, mrkdwn: true }),
    muteHttpExceptions: true
  }).getContentText());
  log(r.ok ? "Slack → " + channel : "Slack error: " + r.error);
}


// ============================================================
// SCORE AND MIME HELPERS
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

function scoreToStars(score) {
  if (score >= 85) return 5; if (score >= 70) return 4;
  if (score >= 50) return 3; if (score >= 30) return 2;
  return 1;
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
// TIMEZONE HELPERS
// ============================================================

function getCurrentHours() {
  var now = new Date();
  var utc = now.getTime() + (now.getTimezoneOffset() * 60000);
  return { sgt: new Date(utc + 8 * 3600000).getHours(), ist: new Date(utc + 5.5 * 3600000).getHours() };
}
function isOfficeHours() {
  var h = getCurrentHours();
  return (h.sgt >= OFFICE_START && h.sgt < OFFICE_END) || (h.ist >= OFFICE_START && h.ist < OFFICE_END);
}
function getOfficeStatus() {
  var h = getCurrentHours();
  return (h.sgt >= OFFICE_START && h.sgt < OFFICE_END ? "SG open" : "SG closed") + " (" + h.sgt + ":00 SGT) | " +
         (h.ist >= OFFICE_START && h.ist < OFFICE_END ? "India open" : "India closed") + " (" + h.ist + ":00 IST)";
}


// ============================================================
// TRIGGERS — run ONCE only
// ============================================================

function installDayTrigger() {
  ScriptApp.getProjectTriggers().forEach(function(t) { if (t.getHandlerFunction() === "runDayBatch") ScriptApp.deleteTrigger(t); });
  ScriptApp.newTrigger("runDayBatch").timeBased().everyMinutes(30).create();
  Logger.log("Day trigger installed — every 30 mins.");
}

function installNightTrigger() {
  ScriptApp.getProjectTriggers().forEach(function(t) { if (t.getHandlerFunction() === "runNightBatch") ScriptApp.deleteTrigger(t); });
  ScriptApp.newTrigger("runNightBatch").timeBased().everyHours(1).create();
  Logger.log("Night trigger installed — every 1 hour.");
}

function runDayBatch()   { if (!isOfficeHours()) { log("Outside office hours — skipping."); return; } screenNewCandidates(); }
function runNightBatch() { if (isOfficeHours())  { log("Office hours active — skipping.");  return; } screenNewCandidates(); }

function removeTriggers() {
  ScriptApp.getProjectTriggers().forEach(function(t) {
    var fn = t.getHandlerFunction();
    if (fn === "runDayBatch" || fn === "runNightBatch" || fn === "screenNewCandidates") ScriptApp.deleteTrigger(t);
  });
  Logger.log("All triggers removed.");
}


// ============================================================
// TEST + UTILITY FUNCTIONS
// ============================================================

function checkJobStatus() {
  var JOB_ID = "YOUR_JOB_ID_HERE";
  var state  = getJobState(JOB_ID);
  log("Status      : " + (state.status || "not started"));
  log("Title       : " + (state.jobTitle || "—"));
  log("Brief V     : V" + (state.briefVersion || "—"));
  log("Slack IDs   : " + (state.recruiterSlackIds || []).join(", "));
  log("Cursor      : " + getCursor(JOB_ID));
}

function resetJobFull() {
  resetJob("YOUR_JOB_ID_HERE");
  log("Job reset. Run startNewJob() to restart.");
}

function testSheetConnection() {
  try {
    var ss = SpreadsheetApp.openById(AUDIT_SHEET_ID);
    log("Sheet connected: " + ss.getName());
    log("Tabs: " + ss.getSheets().map(function(s) { return s.getName(); }).join(", "));
  } catch (e) {
    log("Sheet connection failed: " + e.message);
    log("Check AUDIT_SHEET_ID and sheet permissions.");
  }
}
