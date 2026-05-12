# Shortlist

AI candidate screening for lean TA teams. Reads a hiring brief — not just a job description — scores every candidate with evidence-based reasoning, detects AI-inflated resumes, and posts results directly into the ATS. No new tool for recruiters to learn.

Built for startups and small TA teams who need to move faster on screening without paying enterprise AI matching prices. Runs entirely on Google Apps Script — no servers, no infrastructure, no per-seat fees.

---

## The problem

Most AI matching tools compare resume text to job description text. They answer: does this CV look like this JD?

Recruiters actually care about: would we realistically hire this person for this role?

The gap is widening. Candidates use AI to mirror JD keywords — ATS match scores look great, but recruiters still reject these candidates later. The score predicted keyword overlap, not hiring likelihood.

Shortlist closes this gap by reading the full hiring context, not just the public JD.

---

## How it works — full flow

```
New job goes live in the ATS
          │
          ▼
Shortlist reads the JD via ATS API
          │
          ▼
Gemini generates a hiring brief automatically
(ideal profile, red flags, scoring criteria,
salary benchmarks, interview focus areas)
          │
          ▼
Brief posted to recruiter via Slack DM
          │
          ▼
Recruiter replies: "yes" → approved
Recruiter replies with corrections → Gemini revises → V2 sent back
          │
          ▼
Brief locked. Screening begins.
          │
          ▼
Candidates scored in batches (day: 20 / night: 25)
every 30 min during office hours, hourly overnight
          │
          ▼
Per candidate:
  → Star rating + full AI review posted to SR
  → Tag written to candidate profile
  → Row logged to audit sheet
          │
          ▼
Consolidated Slack DM after each batch
(shortlisted candidates only, with profile links)
          │
          ▼
Audit trail written to Google Sheets
(Candidate Log | Batch Summary | Brief Events)
```

Human is in the loop at two points: brief approval before scoring begins, and all hiring decisions. No candidate is auto-rejected.

---

## What the output looks like

**Per candidate in the ATS:**
- Star rating (1–5) mapped from score
- Full AI review comment with score breakdown
- Tag: `Shortlist: Strong (87)` / `Shortlist: Review (64)` / `Shortlist: Weak (42)`

**Per candidate review includes:**
- Overall score (0–100) and tag
- Criteria breakdown — must-haves, industry fit, seniority match, career progression
- Strengths with specific evidence from the resume
- Red flags with specific evidence
- AI-inflation check — detects generic buzzwords, JD mirroring, unverifiable claims
- Assessment prediction — would they pass the interview exercises?
- Suggested interview question tailored to this specific candidate
- Salary note vs. market benchmark

Scoring criteria are not hardcoded — they are extracted from each hiring brief, so they adapt per role.

---

## Score to star rating mapping

| Score | Stars | Label |
|---|---|---|
| 85–100 | ★★★★★ | Strong Yes |
| 70–84 | ★★★★☆ | Yes |
| 50–69 | ★★★☆☆ | Maybe |
| 30–49 | ★★☆☆☆ | No |
| 0–29 | ★☆☆☆☆ | Strong No |

---

## Two versions

**v1 — Simple (manual run)**
Run `screenNewCandidates()` manually for a specific job ID. No Slack webhook, no approval flow, no batch cursor. Good for testing and small teams doing occasional runs.

**v2 — Full vision (automated)**
Full automated pipeline with Slack-based brief approval, day/night batch triggers, cursor-based processing to avoid re-scoring, job-specific scoring rules, audit trail, and consolidated Slack summaries. Designed to run continuously with no manual input after the initial `startNewJob()` call.

---

## Stack

- Google Apps Script (all automation logic)
- Gemini via LiteLLM (hiring brief generation, candidate scoring)
- ATS API — built and tested on SmartRecruiters; adaptable to other ATS platforms with a reviews API
- Slack (brief review/approval, batch summaries, strong candidate alerts)
- Google Sheets (audit trail — candidate log, batch summary, brief events)

---

## Setup

**Script Properties — add these keys:**

| Key | Description |
|---|---|
| `SR_API_TOKEN` | ATS API token |
| `LITELLM_API_KEY` | API key for your LiteLLM instance |
| `CF_ACCESS_CLIENT_ID` | Cloudflare access header |
| `CF_ACCESS_CLIENT_SECRET` | Cloudflare access header |
| `SLACK_BOT_TOKEN` | xoxb-... from api.slack.com |
| `SLACK_USER_ID` | Your Slack member ID (v1 only) |

**Additional config (v2):**
1. Create a Google Sheet and paste the ID into `AUDIT_SHEET_ID`
2. Deploy as a Web App (Execute as: Me, Access: Anyone) and paste the URL into your Slack App's Event Subscriptions → Request URL
3. Subscribe to `message.im` scope
4. Add any fixed Slack recipients to `EXTRA_SLACK_IDS`
5. Run `installDayTrigger()` and `installNightTrigger()` once

**To start a new job (v2):**
1. Paste the Job ID into `startNewJob()`
2. Run `startNewJob()` once
3. Everything else is automated

Real credentials have been stripped. Never hardcode tokens — use Script Properties.

---

## Structure

```
shortlist/
├── v1_simple/
│   └── Code.gs              # Manual run — paste job ID and run
├── v2_full/
│   └── Code.gs              # Full automated pipeline
├── PROMPT-GUIDE.md          # How the scoring and brief prompts work
├── README.md
└── assets/
    ├── slack-brief.png      # Sample Slack brief approval flow
    ├── slack-summary.png    # Sample batch summary DM
    └── sr-output.png        # Sample SR candidate view with Shortlist review
```

---

## Job-specific scoring rules (v2)

Each job can have custom scoring filters added to `JOB_REQUIREMENTS`:

```javascript
var JOB_REQUIREMENTS = {
  "your-job-id": {
    mustHaveKeywords:   ["keyword1", "keyword2"],  // cap score at 40 if none present
    maxYearsExperience: 2,                          // penalise over-experienced candidates
    bonusKeywords:      ["bonus1", "bonus2"],       // up to +10 pts
    customNote:         "Recruiter note for this role — fed directly into the scoring prompt."
  }
};
```

---

## Cost

| Volume | Gemini cost per role |
|---|---|
| 100–200 candidates (typical) | ~$2–5 |
| 1,000+ candidates (high volume) | ~$5–8 |

Monthly estimate for a small team running 10–20 roles: $20–70. No per-seat fees, no vendor contract, no annual license.

---

## Legal and IT clearance

Shortlist sends candidate resumes to an external AI model via API. Resumes are PII. Before running on real candidate data, the following need to be confirmed with your legal and IT teams.

**Data privacy**
Candidate resumes contain personal data. Depending on your markets this falls under PDPA (Malaysia), PDPC (Singapore), GDPR (EU), or equivalent. Confirm:
- Whether your LiteLLM proxy keeps data within your organisation's infrastructure or routes to external servers
- Whether your data processing agreement with the model provider covers candidate PII
- Whether candidates need to be notified that AI screening is in use

**AI screening disclosure**
Several jurisdictions are moving toward requiring disclosure when AI is used in hiring decisions. Even where not yet mandatory, a brief notice in your application flow is good practice. Shortlist is an assistant — it surfaces scores and reasoning, it does not make hiring decisions. That framing matters legally and should be communicated to hiring teams before any pilot.

**Bias and fairness**
The scoring model may favour candidates from well-known companies, certain educational backgrounds, or standardised resume formats. Before any pilot:
- Agree on what score distributions to track (by gender, nationality, background type)
- Set a threshold that would trigger a prompt revision
- Document this before you start, not after

**IT and vendor approval**
If your organisation has a vendor approval process, the LiteLLM endpoint and the underlying model provider both need clearance before real candidate data is sent. The prototype is safe for testing with dummy data — real resumes require IT sign-off first.

**The current build uses test data only.** Legal and IT clearance documentation should be prepared before any live pilot is proposed, covering: data flow, retention policy, disclosure approach, and bias tracking plan.

---

## Honest limitations

- Built for lean teams — not tested at enterprise scale
- Scoring quality depends on brief quality — vague JDs produce vague briefs
- Non-English resumes haven't been fully validated
- Bias risk: the model may score candidates from well-known companies higher due to name recognition — track score distributions during any pilot
- Requires legal review before using on real candidate data — resumes are PII
- No candidate is auto-rejected, but scores will influence recruiter behaviour — communicate this clearly before piloting

---

## Current status

v1 is complete and tested. v2 scoring engine, SR write-back, Slack integration, and audit logging are built. Poll loop with cursor-based state tracking is working. Actively being iterated — not yet in production.

---

## Links

- Portfolio: https://macchie-ato.github.io
