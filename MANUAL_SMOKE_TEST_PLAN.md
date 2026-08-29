# Manual Smoke Test Plan for AI Chat Fixes

## Prerequisites
1. Build the app: `npm run build:electron`
2. Start the Electron app (dev mode or packaged)
3. Have a test document/resume available to upload

## Test Execution Steps

### CRITICAL TEST #1: Normal Chat (No Meeting) - "Hello, can you hear me?"
**Objective**: Verify normal questions are NOT treated as meeting questions

**Setup**:
- Ensure NO meeting is currently active (close any meeting if one is open)
- DO NOT upload any documents yet

**Steps**:
1. Open Natively chat overlay
2. Type or speak: "Hello, can you hear me?"
3. Get the answer

**Expected Result** ✅:
- Response should be a normal conversational answer
- NOT: "I didn't catch that in the meeting"
- NOT: "That wasn't discussed in the meeting"
- Example good response: "Yes, I can hear you! How can I help?"

**Actual Result**:
- [ ] Response is normal conversational
- [ ] No meeting context forcing
- [ ] Answer is appropriate for general knowledge question

---

### CRITICAL TEST #2: General Knowledge Question - "What is DBMS?"
**Objective**: Verify general knowledge questions bypass RAG

**Setup**:
- Ensure NO meeting is active
- No documents uploaded

**Steps**:
1. Ask: "What is DBMS?" (text or voice)
2. Observe the answer

**Expected Result** ✅:
- Should get a technical explanation of DBMS
- NOT: "I didn't catch that in the meeting"
- NOT: Meeting transcript context

**Actual Result**:
- [ ] General knowledge answer provided
- [ ] No meeting context forcing
- [ ] Answer is technically correct

---

### TEST #3: Document Upload - Normal Question with Document Context
**Objective**: Verify document evidence is passed to LLM for normal questions

**Setup**:
- Upload a resume or document with project descriptions
- NO meeting active

**Steps**:
1. Upload document (click attachment button)
2. Ask: "What projects are in my resume/document?"
3. Observe the answer

**Expected Result** ✅:
- LLM references specific projects from your document
- Shows `hasContext: true` in logs (if inspecting)
- Document evidence is actually used

**Actual Result**:
- [ ] Document mentioned in answer
- [ ] Specific details from document cited
- [ ] NOT just generic response
- [ ] Logs show context being used

---

### TEST #4: Resume Question Without Meeting
**Objective**: Verify profile/resume context works for normal questions

**Setup**:
- Upload a resume PDF or document
- NO meeting active
- Make sure SettingsManager has reference_files enabled

**Steps**:
1. Ask: "What skills do I have?" or "What did I work on?"
2. Check if resume content is used

**Expected Result** ✅:
- Answer references specific skills/projects from resume
- Document context is applied
- No "meeting" framing

**Actual Result**:
- [ ] Resume content referenced
- [ ] Specific details provided
- [ ] Context properly retrieved

---

### TEST #5: Provider Fallback (If Testable)
**Objective**: Verify provider fallback chain works

**Setup**:
- Note: May require intentionally breaking Natively API key to test
- OR: Observe logs when Natively fails naturally

**Steps**:
1. Ask a question while Natively provider might fail (optional: disable Natively in settings)
2. Verify Gemini Flash-Lite is tried as fallback
3. Check logs for provider rotation

**Expected Result** ✅:
- Natively 401 → falls back to Gemini successfully
- No error message blocking the answer
- Fallback provider streams answer

**Actual Result**:
- [ ] Fallback provider activates when primary fails
- [ ] Answer still streams successfully
- [ ] No "provider unreachable" block

---

### TEST #6: Listen/Answer Flow
**Objective**: Verify STT → text → LLM → response works

**Setup**:
- NO meeting active
- Enable voice input

**Steps**:
1. Click the Listen button (or press hotkey)
2. Speak a question: "What is machine learning?"
3. Click Answer Now
4. Observe response

**Expected Result** ✅:
- Your spoken text appears as user message
- LLM generates a normal (not meeting-forced) answer
- Chat shows full exchange: [Your question] → [AI answer]

**Actual Result**:
- [ ] Voice input captured
- [ ] Text appears in chat
- [ ] Answer is appropriate
- [ ] No meeting context forcing
- [ ] UI reflects full exchange

---

### TEST #7: Meeting Active Mode - RAG Should Work
**Objective**: Verify RAG still works when meeting IS active

**Setup**:
- Start or simulate an active meeting
- Meeting has some transcript content

**Steps**:
1. Ask: "What did we discuss about [topic from meeting]?"
2. Verify RAG retrieves meeting context

**Expected Result** ✅:
- Answer comes from meeting transcript
- Shows "I didn't catch that" ONLY if topic wasn't in meeting
- RAG is actually querying the live meeting

**Actual Result**:
- [ ] Meeting context retrieved
- [ ] Appropriate "wasn't in meeting" message only when needed
- [ ] Not forced on all questions

---

## Logging Inspection (Optional)

**To verify fixes are working at code level**:

1. Open DevTools (right-click → Inspect or Cmd+Opt+I on macOS)
2. Check Console for logs:

**Good signs**:
- `[isMeetingActive] false` → Normal chat branch taken
- `[V3 intelligence] building context` → V3 engine activated
- `[document context] reference_files enabled` → Documents passed to LLM
- Provider rotation logs (if testing fallback)

**Bad signs**:
- Query always goes to RAG regardless of meeting state
- `[MEETING_RAG] Processing normal question` → Wrong prompt applied
- `hasContext: false` despite documents uploaded
- Error message from provider preventing answer

---

## Pass/Fail Criteria

### MUST PASS (Critical):
- ✅ Test #1: Normal question doesn't get "I didn't catch that in meeting"
- ✅ Test #2: General knowledge questions work without RAG forcing
- ✅ Test #4: Document context reaches LLM for normal questions

### SHOULD PASS (High Priority):
- ✅ Test #3: Document upload works for queries
- ✅ Test #5: Provider fallback works (if applicable)
- ✅ Test #6: Listen/Answer flow completes
- ✅ Test #7: Meeting mode RAG still functions

### OVERALL RESULT:
- **PASS**: All critical tests pass, no "I didn't catch that in meeting" on general questions
- **PARTIAL**: Critical tests pass but some secondary tests fail (indicates partial fix)
- **FAIL**: Normal questions still show meeting context forcing

---

## Next Steps After Testing

If all tests pass:
1. Deploy to production
2. Monitor logs for any regressions
3. User smoke tests with own workflow

If any critical test fails:
1. Check browser console for errors
2. Review logs in `~/Library/Application Support/Natively/natively.log`
3. Report specific test failure with log snippet
