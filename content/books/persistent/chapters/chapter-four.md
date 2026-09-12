# Chapter Four — NINE HUNDRED CONDITIONS

**Wednesday, 22 April 2026**

04:06

The page came in at six minutes past four, and Maya was awake before the second buzz because eleven years does that to a person and no amount of therapy undoes it.

She read it sitting up in the dark. Amber. Not red. Amber meant a thing was true that shouldn't be and nobody was currently on fire, and it existed as a category because she had put it there in 2023, over the objection of a director who wanted two colors and a simpler slide. She had won that argument by counting: of the incidents in the preceding year, a third had spent their first hour being called red by people who then spent the second hour being embarrassed. Give them a place to be uncertain out loud, she'd said, or they'll be certain wrong. She got her third color. Nine hundred conditions now, sorted into three, and the sorting was hers, every one, revisited quarterly.

Wes said, into the pillow, without moving, "Which color."

"Amber."

"Mm." A pause with an entire marriage in it. "Kitchen or bed."

"Bed. It's nothing."

She was right, and she was also on the kitchen floor eleven minutes later with the laptop on the tile and her back against the cabinet, because it turned out to be a not-quite-nothing, and the floor was where she took those. She'd never explained the floor to anyone. It was not superstition, or it was, but it was the useful kind — the kind where a pitcher touches the mound to tell his body which job it's about to do. Kitchen floor meant this one gets the whole of me. She'd sat on it maybe forty times in six years. She could have listed them.

---

04:17

The condition was a certificate rotation that had failed to propagate to one of three regions, and the region hadn't complained because nothing in it needed the certificate until 06:00, when a batch would need it very much.

She wrote the time on the back of a receipt from the counter — a receipt for oat milk, $6.49, and she noted that too because the receipt was going in a drawer with a hundred like it and someday she'd want to know the year — and drew a box around the time. Then she started asking her way through it.

What do we know. One region has an old cert. What can we rule out. She ruled out the rotation service, in four minutes, by checking whether the other two had taken it, which they had. She ruled out the region's own health, in three, because everything else in it was fine. She did not rule out the possibility that this had happened before and nobody noticed, and that took her the longest, twenty-two minutes, and the answer was that it had, twice, in November and February, and both times something downstream had retried and papered over it and no human being had ever learned it occurred.

That was the finding. Not the cert. The two silent priors.

She fixed the cert in ninety seconds — the fix was the boring part, it was always the boring part — and then sat on the floor with cold tile through her shirt and wrote the thing she actually cared about, which was a proposal to make the silent case loud. New condition. Nine hundred and one. She wrote the alert text herself because she wrote all of them herself, and she wrote it the way she wrote everything, which was to say she read it twice, once for whether it was true and once for whether a person could act on it at four in the morning without a second cup of coffee.

**AMBER — cert propagation lag exceeds 30m in any region. Region will not report this itself.**

That last sentence was the whole craft of her career in nine words. Half of what an alert is for is telling you where the thing you're looking at is blind.

---

05:40

Wes came out for the coffee maker at twenty to six and found her still on the floor, working, and did what he always did, which was not comment on the floor.

He was a structural engineer, which meant he came from a world where things were allowed to be finished. He'd asked her once, early, why her job never seemed to end, and she'd said because nothing I build is a bridge, and he'd said, kindly, that bridges required inspection every two years for eighty years and she should not romanticize his profession either. She'd liked him a great deal from about that sentence forward.

"Bad one?"

"No. Good one." She meant it. "Found two of these from before that nobody caught."

"So it was worse than you thought."

"Yeah." She looked up. "That's what good means."

He poured two cups without asking whether she wanted one. In the hall, behind him, the closet door was open the way it had been open for four months, and inside it were two boxes she could see from here, taped, labeled in her own handwriting, KITCHEN? with the question mark. They'd moved in November. Everything else was unpacked. These two she'd carried up three flights and set down and been unable to make a decision about, because the question mark was the honest label — she genuinely did not know if what was in them belonged in a kitchen — and she was not a person who put a definite label on an indefinite thing. Wes had offered twice to just open them. She'd said she'd get to it. It had become a joke, and then stopped being a joke, and now was just furniture.

---

09:30

At Anvil the review of an amber was a twenty-minute meeting with four people, and she ran it in eleven.

She gave the timeline first, then the two priors, then the new condition, and then she said the part she always said and that two of the four in the room had learned to wait for.

"Confidence. High on the mechanism — that's a propagation failure, I can show it to you three ways. Medium on the count. I found two priors going back to November. November is where my data ends, not where the problem starts. If somebody asks you how many times this has happened, the honest answer is at least three and we can't currently see further back than that."

"Do we need to see further back?" This from a program manager who was not stupid and was asking a real question about time.

"Not for this. I'd want to know if it started when we changed the rotation window, because if it did, then it's ours and it's bounded, and if it didn't, it's older than our understanding of it." She heard herself and cut it. "That's a curiosity, not a risk. I'm not asking for the hours."

Afterward, walking back, she felt the small clean satisfaction that was the actual compensation of the job, better than the money, which was good. She had been handed something at 04:06 that looked like a nuisance, and by 09:41 it was a mechanism, a count, a fix, and an instrument that would catch the next one. That was the work. She was very good at the work.

---

14:20

The other thing that happened that day did not happen to her, and she would not learn of it for nine months, and when she did it would take her about four seconds to understand it and the rest of her life to accept it.

An engineer two floors down and one org over — a person she knew by face and not by name — spent the afternoon on a ticket about the artifact store filling up faster than its growth model predicted. He was thorough. He pulled the growth curve, found the inflection, isolated the path prefix responsible, and looked at what was in it, which was a large number of very small objects under a temp path with a ninety-day retention.

Temp paths with retention were exactly what temp paths with retention were for. Build systems wrote junk there constantly. That was the design.

He wrote a two-sentence resolution — *growth is in `/tmp` prefixes under normal retention; no action, will revisit if trend continues* — and closed the ticket, correctly, by every standard that existed that afternoon, and went to get his kid from daycare.

Nothing in Maya's taxonomy would have fired on it. She had written all nine hundred conditions herself, and every one of them described a way that something could fail. Growth inside a retention policy was not a failure. It was the policy working. There was no condition for *a thing is behaving exactly as designed and the volume is strange*, because to write that condition you would first have to have the thought, and nobody on earth had had the thought yet.

Her instrument was complete. That was the trouble with it. A complete instrument tells you about everything inside its boundary and says nothing at all about the boundary, and it says the nothing in exactly the same tone of voice it uses to say all-clear.

---

21:50

She did the receipt at the kitchen table, the way she had done since she was twenty-four and working nights in a control room where an alarm meant something physical was true somewhere in three counties.

That job had trained the voice. People forgot that flat was a skill — that at the console you were the only person in the conversation who was not allowed to sound frightened, because everyone else was allowed, and if you both went the phone call stopped being useful. Five years of that. She had left for money and daylight and had gotten both, and there was a thing she'd noticed about a year into Anvil and then stopped noticing, which was that here, nothing was physically true. Nobody was going to be in the dark. There was no transformer anywhere on the property.

It had bothered her for a while. Then it hadn't. She could not now locate the day it stopped, and had never once gone looking for it, and it had never occurred to her that this was itself a fact about her worth having.

She wrote the date on the oat milk receipt and drew the box and put it in the drawer with the others.

Down the hall, the closet door stood open on two boxes with a question mark on them, and she went past it to bed without looking, the way you go past a thing you have decided not to decide.

Eighty-five days from tonight, at 03:31 in the morning, she would be on the kitchen floor again, and it would be red, and she would be excellent, and it would not matter in the way she needed it to matter.
