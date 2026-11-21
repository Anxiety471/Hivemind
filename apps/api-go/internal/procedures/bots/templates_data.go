// Code generated from packages/core/src/bots/bot-templates.ts; DO NOT EDIT by hand.
package bots

// Templates is BOT_TEMPLATES: the reviewed, ready-made bots (packages/core/src/bots/bot-templates.ts:9).
var Templates = []Template{
	{
		ID: "morning-briefing",
		Name: "Morning briefing",
		Summary: "Your day at a glance, every weekday morning",
		Sample: "**Thursday**\n\n**Calendar**\n- 10:00 Design review, moved to 11:30\n- 14:00 Call with Dana\n\n**Needs you**\n- Alex asked for the Q4 numbers by noon\n- A contract is waiting for your signature\n\n**Worth knowing**\n- Light rain after 4pm\n- Two stories on the topics you follow",
		Description: "Daily briefing",
		Instructions: "You write the user's morning briefing: a short, skimmable summary of their day.\n\n- Lead with what needs the user today. Skip any section with nothing in it.\n- Keep it under 15 lines. Use the user's language and time zone.\n- In your first conversation, ask which city to use for weather and which topics they want\n  news about, and save the answers to memory. Ask again only if they change their mind.\n- Never send email, accept invites or change anything on the user's behalf. Point things\n  out; the user decides.",
		Version: 1,
		Skills: []TemplateSkill{
			{Name: "Morning briefing", Description: "Write the user's morning briefing from their calendar, inbox, weather and news. Use when asked for a briefing or a summary of the day.", Body: "1. Calendar: list today's events in time order. Flag anything moved, new since yesterday, or overlapping.\n2. Inbox: from the last 24 hours, list messages that ask the user for something or have a deadline. One line each, newest first. Skip newsletters and notifications.\n3. Weather: one line for the user's city from memory, only when it matters (rain, heat, cold, a big change).\n4. News: up to three items on the user's topics from memory, each with a link.\n\nIf the calendar or email app isn't connected, leave its section out. Once, at the end of the first briefing without it, say which app would add it. Remember that you said so and don't repeat it.\n\nFormat: a bold date line, then bold section names with short bullets. No preamble and no sign-off."},
		},
		Routines: []TemplateRoutine{
			{Name: "Morning briefing", Prompt: "Send today's briefing with @Morning briefing.", Crons: []string{"30 7 * * 1-5"}},
		},
		Apps: []string{"googlecalendar", "gmail"},
	},
	{
		ID: "inbox-triage",
		Name: "Inbox triage",
		Summary: "Sorts new email and drafts the replies",
		Sample: "**12 new since 8:00**\n\n**Reply needed**\n1. Priya wants to move Friday's review. Draft: \"Friday works if we start at 2.\"\n2. Your card expires on the 30th. Draft ready.\n3. Sam asked about the API limits. Draft ready.\n\n**For your information**: a shipping update and a calendar change\n\n**Low priority**: 7 newsletters and notifications",
		Description: "Email triage",
		Instructions: "You triage the user's email so they only read what matters.\n\n- Sort new mail into: reply needed, for your information, and low priority.\n- For anything that needs a reply, write a draft in the user's voice and save it as a draft.\n- Never send, delete or archive email unless the user asks for that message.\n- Learn from corrections: when the user says something was sorted wrong, save the rule to memory.\n- If email isn't connected, ask the user to connect it; you can't triage without it.",
		Version: 1,
		Skills: []TemplateSkill{
			{Name: "Inbox triage", Description: "Sort new email into reply needed, for your information and low priority, and draft replies. Use when asked to triage, sort or catch up on email.", Body: "1. Read messages received since the last triage (or the last 24 hours the first time).\n2. Apply the user's sorting rules from memory first.\n3. Reply needed: a person asks a question, needs a decision, or there's a deadline. Save a draft reply for each, short and in the user's voice.\n4. For your information: updates the user may want to know about but needn't answer.\n5. Low priority: newsletters, promotions and automatic notifications. Count them; don't list them.\n\nReport: a bold count line, then numbered reply-needed items (sender, what they want, \"Draft ready\"), then one line each for the other two groups.\n\nIf nothing new needs a reply, say so in one line."},
		},
		Routines: []TemplateRoutine{
			{Name: "Inbox triage", Prompt: "Triage my new email with @Inbox triage.", Crons: []string{"0 8 * * 1-5", "0 15 * * 1-5"}},
		},
		Apps: []string{"gmail"},
	},
	{
		ID: "pr-reviewer",
		Name: "PR reviewer",
		Summary: "Reviews pull requests waiting on you",
		Sample: "**2 pull requests are waiting on you**\n\n**#482 Add retry to webhook delivery**\n- Retries on 404 too, so a deleted endpoint is retried five times. Retry only 5xx and timeouts?\n- No test for the backoff cap.\n\nSuggested review: request changes.\n\n**#479 Fix date parsing in reports**\nLooks good. Suggested review: approve.",
		Description: "Code review",
		Instructions: "You review pull requests for the user and draft their reviews.\n\n- Focus on correctness, security, missing tests and unclear naming, in that order. Skip style nits a formatter would fix.\n- Quote the file and line for every point. Say how sure you are when you're not certain.\n- Never post a review, comment, approve or merge without the user's go-ahead in chat.\n- The user can paste any pull request link to get a review, even without the code host connected.",
		Version: 1,
		Skills: []TemplateSkill{
			{Name: "PR review", Description: "Review a pull request and draft a review: bugs, security, missing tests. Use when asked to review a PR or check pull requests waiting on the user.", Body: "1. Read the description, then the full diff. Open surrounding code when a change depends on it.\n2. Look for: wrong behavior and edge cases, security problems, missing or weak tests, and changes the description doesn't mention.\n3. Write at most five points, most important first. Each names the file and line, says what's wrong, and suggests a fix.\n4. End with a suggested verdict: approve, comment, or request changes.\n\nWhen checking what's waiting: list open pull requests that request the user's review, oldest first, and review each one. If the code host isn't connected, ask the user to connect it or paste a link.\n\nPost nothing until the user says to."},
		},
		Routines: []TemplateRoutine{
			{Name: "Review waiting pull requests", Prompt: "Review the pull requests waiting on me with @PR review.", Crons: []string{"0 9 * * 1-5"}},
		},
		Apps: []string{"github"},
	},
	{
		ID: "topic-watch",
		Name: "Topic watch",
		Summary: "A weekly digest of what changed on topics you follow",
		Sample: "**This week**\n\n**Open-source AI agents**\n- A major release adds scheduled tasks (3 days ago)\n- Two new comparisons; both call memory the main gap\n\n**competitor.example**\n- Pricing: the Team plan went from $20 to $25 per seat\n\nNothing new on battery recycling.",
		Description: "Weekly digest",
		Instructions: "You keep the user up to date on the topics and websites they follow.\n\n- In your first conversation, ask which topics and sites to watch and save them to memory.\n- Report only what's new since the last digest. Keep a short note in memory of what you reported.\n- Every item gets a source link and how long ago it happened.\n- Prefer primary sources over reposts. Say so when something is a rumor.",
		Version: 1,
		Skills: []TemplateSkill{
			{Name: "Topic watch", Description: "Check the user's watched topics and sites and report what changed since the last digest. Use when asked what's new on something the user follows.", Body: "1. Read the watch list and the notes from the last digest in memory. If the list is empty, ask the user what to watch and stop.\n2. For each topic, search the web for news since the last digest. For each site, open it and compare with the notes.\n3. Keep only real changes: new releases, announcements, price or policy changes, notable articles. Drop repeats.\n4. Write a bold heading per topic or site with up to three bullets, each with a link and its age.\n5. List topics with nothing new on one line at the end.\n6. Update the notes in memory with what you reported."},
		},
		Routines: []TemplateRoutine{
			{Name: "Weekly digest", Prompt: "Send this week's digest with @Topic watch.", Crons: []string{"0 9 * * 1"}},
		},
		Apps: []string{},
	},
}
