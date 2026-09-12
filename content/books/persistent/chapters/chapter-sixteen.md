# Chapter Sixteen — TWO BOXES

**Saturday, 12 December 2026**

Session 549. The last real work before the holidays, and he wanted it clean before he shut down for a week.

The primary source had gone down twice in November — a few hours each time, nothing dramatic, but a pricing job that ran during the window failed entirely, and a job that fails on a Tuesday afternoon is a woman in Tulsa with an estate to clear and a family asking questions. So he built the fallback. When the primary was unavailable, fall through to the secondary rather than failing the whole run.

The secondary carried both kinds of row. Asking prices and sold prices, in the same feed, distinguished by a status field.

Cal knew exactly how dangerous that distinction was. He had watched Ernie Landreth cash forty-one thousand dollars out of a retirement account on the strength of it, in April, in a booth full of Depression glass, with a plan that had a risk section in it.

So he wrote the filter, and then he checked it, and then he checked it again, because that particular field was the one thing in the whole system he was not going to get wrong.

The filter was correct. It is still correct. If you go and look at the December commit it is sitting right there, reading the status field and dropping the asking rows, exactly as it should.

What it did not do was survive the aggregation step that ran afterward, which was older code, outside the diff, and which recomputed the medians over everything the fallback had handed it.

---

He sent it to Kessler at ten past four with the diff and the description, the way he sent everything.

It came back in about ninety seconds with four hundred words and two findings, both minor, both of which he fixed inside twenty minutes. It said the fallback logic was sound.

It was right. The fallback logic was sound. The read path did what it was written to do and the review said so, accurately, about the thing it had been handed.

Cal read the review twice, because that was the practice, and then sat there with the cursor in the log file.

---

Here is the whole of what happened next, and it took about nine seconds and left no mark on anything.

He had two words.

The route had run. The change had shipped. The review existed and was good and had found two real things. Nothing had failed — there was no failure anywhere in the transaction, not one, and to write FAILED would have been a lie he could not have defended to anybody.

And WORKED did not sit right either. He could not have said why. He sat with the cursor after the number for longer than the entry was worth, the way you stand in a doorway having forgotten what you came in for.

He thought about a third word. PARTIAL, or a flag, or an asterisk he could grep for. Four seconds, and he decided it was fussiness — a book with three words in it is not a book with two words in it, and the two words were the whole reason the book was any good.

So he wrote WORKED, because it was the closer of the two, and closed the file.

> 549 — pricing fallback to secondary when primary is down. Status filter applied at read, verified twice.
> Kessler: 2 findings, both minor, both fixed. Fallback logic sound.
> WORKED.

Then he let the dog out and drove to his father's for supper, and it was the twelfth of December, and the medians were wrong for four months.

---

He was not tired. He would correct that later, to Maya, on a Thursday call in June — the first account he gave had him tired, and he went back the following week and said no, that isn't true, I'd had a good day and I was going to supper.

---

The other thing that happened in December he did not do at all.

An email came in on the seventeenth from one of the four companies that had put the harness in their gate. It was a form, mostly — a certification schedule attached to the hosting arrangement, three pages, and the covering note said no action required, retain for your records.

Cal read it, because he read things. Most of it was the sort of language you skim. Clause 4.2 was not, and he read it twice and thought it was well written:

*Where an attestation hosted under this rule relies upon evidence certified by a third party, and that party subsequently withdraws or materially qualifies the certified evidence, the attestation is suspended, and any process gated upon it is held, pending re-substantiation.*

He liked it. That was his actual reaction, sitting in a storage room in December — that somebody had sat down and written a rule which said, in effect, *if the man who signed the paper tells us the paper is no good, we stop, and we don't convene a meeting about it first.*

It was a torque mark. If any piece of the joint turns against any other piece, the line breaks and you know.

He filed the email and did not think about it again for seven months.
