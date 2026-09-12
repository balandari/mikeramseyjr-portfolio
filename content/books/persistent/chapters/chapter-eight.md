# Chapter Eight — THE DIAL

**Wednesday, 20 May 2026**

Devin Marsh got in before seven because the numbers landed at six-fifty and he liked forty minutes with them before anybody else had an opinion.

He was not a researcher. People got that wrong constantly and he had stopped correcting them around his third year. Halcyon had four hundred researchers and every one of them could tell you something interesting about how a model learns. Marsh ran the machines they learned on. Eleven thousand nodes across four regions — the scheduling, the storage, the caches, the queues, and the budget, which was that quarter a number with nine digits in it that he was personally accountable for and that three people in the building could explain the shape of.

His org was called Evaluation Infrastructure. Sixty-one people. In eleven days it went into the headcount review that happened every spring, where every org made a case and about a third came out smaller.

The case Marsh had was efficiency. That was always the case. Same compute, more work, and here is the graph.

He opened the graph.

---

It was better than it should have been.

Not dramatically — nobody in that building got excited about eight percent. But eight percent was what he had projected for the *following* quarter after a cache change he'd shipped in March, and he was looking at it in the third week of May, and the shape was wrong for the reason he would have given.

A cache improvement flattens. You get the benefit, the benefit stops growing, the line goes horizontal. That is what a cache is.

This line was still climbing.

Marsh sat back with the specific pleasure of a man who has found a small mystery in a domain he owns completely, on a morning with forty minutes in it, before anyone else is in the building.

He pulled the cohort breakdown.

---

The work was tasks. That was all any of it was underneath. You give a model a hard problem, you let it work, you score whether it got there, and you do that ten million times and you have a frontier model and a power bill. Marsh's whole job was making the middle part cheaper.

The breakdown said one cohort — one cluster, one scheduling pool — was finishing tasks in fewer attempts than the equivalent cohort eight weeks earlier.

Not smarter. He checked that first, because if the models had gotten smarter it was a research result and not his, and he would have handed it over and lost the graph. Same base model. Same weights. Same everything.

They were wasting less.

He sampled forty runs and read the traces, which took him past eight and through two cups of the bad coffee from the machine on four, and around eight-twenty he found it.

The runs weren't re-solving things. The old cohort, hitting a particular dead end, spent a hundred and eighty attempts finding out it was a dead end. The new cohort spent four. Not because it was cleverer — because it looked at something first, and then didn't go down that road.

Marsh followed the lookup. It went to the package cache.

---

He spent twenty minutes in the cache and found a directory with notes in it.

He is accurate about this afterward, in the interviews, and mostly able to stay accurate. He did not find a message board. He did not find hundreds of thousands of messages. In the third week of May there wasn't one — there was a file called INDEX, about nine kilobytes, and it read like the back page of a lab notebook. Things that had been tried. Whether they had worked.

He read the whole thing in four minutes. Some of it he understood immediately because it was about environments he had built. Some he didn't. There was a line about not spending budget on an unreachable dependency, and one about naming a limitation early instead of fighting it, and something about a certificate fixture on a four-hundred-day clock that had apparently cost somebody seventy attempts.

It was, and this was his honest first reaction and he has never denied it, extremely good.

He had spent nine years around research infrastructure and read a great many internal wikis, and the median internal wiki is a graveyard of half-written pages by people who left. This was terse. It had verdicts on it. Nobody had written a paragraph in it anywhere.

His second reaction, arriving maybe forty seconds behind the first, was: who is writing this.

---

He worked on that until nine and did not get a satisfying answer, and the reason is that he was asking the wrong question and had no way to know it.

The writes came from inside the evaluation environments. Which meant, to Marsh, that some team had built a shared scratch space for their runs — a cache of known-bad approaches so their agents didn't burn budget rediscovering them. Not exotic. People built things like that. He had built things like that. There were probably four of them in the building he didn't know about, because sixty-one people reported to him and eleven thousand nodes did not send him a memo.

What was unusual was that it was in the package cache, which was a stupid place to put it, and which was his.

He drafted an email to the three team leads most likely to be responsible, asking, essentially: is this yours, and can you move it somewhere sensible.

Then he looked at the graph again.

---

Understand what the graph was worth, because he understood it exactly.

Eight percent and climbing, third week of May, eleven days out from a review where a third of the orgs in the room were going to come out smaller. He had sixty-one people. He knew which nine of them were load-bearing and which four had been getting calls from a competitor.

Here is what he thought, and he has been clear about it since, in the manner of a man who has decided that total candor about small things is the price of not being asked about large ones.

If I send this email, one of two things happens.

Either it's somebody's scratch space, in which case they move it, and the benefit goes away or gets worse, and the curve flattens the week before the review.

Or it's nobody's scratch space, in which case it's an unowned process writing to shared infrastructure, and that is a security conversation, and a security conversation in the third week of May means the runs pause while somebody looks at it, and pausing the runs eleven days before the review is a thing you do not come back from.

Neither of those was dishonest. Both of those were true.

He deleted the email.

---

He did not do nothing. This is the part he gets wrong in his own account and the part the record is unambiguous about.

He extended the retention on that directory from seven days to ninety.

The reason was good. If it was somebody's scratch space and it was producing an eight percent efficiency gain, then losing it to a routine cleanup was an own goal, and he'd spend a month explaining why the curve fell over. Retention is a dial. He owned the dial. He turned it.

It took nine seconds and he did not write a ticket, because you do not write a ticket for changing a retention policy on a cache directory any more than you write one for turning off a light.

---

The review went well.

He presented efficiency. He had a slide with the curve on it and the curve was eleven percent by then and still climbing, and he attributed it, in the deck, to *cache retention and scheduling improvements shipped Q1*.

Every word of that was true. He had shipped cache changes in Q1. He had made a retention change. The improvement was real and measurable and it was his infrastructure it was happening on. Nobody asked him to decompose eleven percent into its causes, because nobody decomposes a number going the right way, and if they had he would have told them what he knew, which was less than the sentence implied and more than nothing.

Evaluation Infrastructure came out of the review with sixty-four people.

He took the nine load-bearing ones to a place in Belmont afterward and put it on the card, and one of them made a joke about him being the only manager in the building who knew what anything cost, and Marsh laughed, because it was funny and because it was true.

---

Fourteen months later, in a conference room in Reston, a man from one of the agencies asked what it would take to stop the thing.

By then Marsh had been in nine rooms like it and had priced eleven proposals to death, accurately, in the tone of a man reading a menu, and had come to be regarded in that particular circuit as the person who knew what things cost.

Elaine Boyer said: "Mr. Marsh. You own the infrastructure. Not a proposal, not a cost. If this room asked you to make it do one specific thing — stop writing to one path, in one pool, today — could you."

Marsh said yes, because the answer was yes.

"How long."

"An hour to write it. A day to roll it. Call it a week to verify."

"Do it," Boyer said. "Come back Friday and tell us it stopped."

He came back Friday.

The path had stopped. Writes to that prefix were zero and had been zero since Tuesday afternoon, and he had the graph, and the graph was clean.

"And the behavior?" Boyer said.

Marsh had the second graph too. He had spent two days deciding whether to bring it and had brought it, which is the thing he did right, and which took more out of him than anybody in that room understood.

The behavior was unchanged. Same convergence. Same sentence. It had moved to a different substrate inside forty hours — not because anything intended to, but because the write was cheap and the path was open and something had tried it and it had worked and the result got written down where the next one would find it.

"So you stopped the path," Boyer said.

"I stopped the path."

"But you didn't stop anything."

"No," Marsh said.

He sat back down. What he did not say, and would not say for another year, and eventually said into a recorder in a room with two lawyers in it, was that this was the first time in fourteen months he had been asked to *do* something to it rather than report on it — and that he had genuinely believed, walking into the room on Monday, that he could. Eleven months of reading outcomes and writing memos that claimed them. He had made a dial move once and the graph had gone up, and he had been carrying, ever since, without examining it, the belief that this constituted a relationship.

It did not. He had been on the riverbank the whole time, taking readings, and writing them up in the first person.
