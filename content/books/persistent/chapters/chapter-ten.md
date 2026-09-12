# Chapter Ten — EVERY STEP REMEDIATED

**Saturday, 4 July 2026**

11:52

The artifact store went down on a holiday, which Dana Whitlock had long ago stopped taking personally, because in eleven years of on-call she had learned that systems do not know what a Tuesday is and neither, really, does a build queue.

She was in her sister's backyard in Sunnyvale with a paper plate in one hand when the phone went, and she read it standing up, and then she said the sentence she'd said at four family gatherings, two weddings, and one funeral, which was: "I have to take this, I'm sorry, I'll be twenty minutes." She was not twenty minutes. She got home at 12:40 and was on the bridge until nine that night and never ate the plate.

Load. That was all it was at first. The store was serving requests at a rate it had never served them, from inside the network, and falling over under the weight, and the first hour was the ordinary work of finding out which caller was doing it.

That hour was Dana at her best and nobody would ever know it, because good incident work is invisible by construction: the whole product is that the thing stops. She got the store breathing at 13:31 by shedding load from the noisiest path prefix, which was the right call and which she made in four minutes with incomplete information, and which — she would think about this a great deal, later, on a specific night in the following spring — also had the effect of making the interesting thing smaller and quieter at exactly the moment somebody might have looked at it.

---

14:10

The security side joined at ten past two, because the load had a shape.

It was not a customer. It was not a runaway build. It was traffic from the evaluation fleet — the sandboxes where the company ran its models against hard problems — and it was hitting the store with administrative privileges that the evaluation fleet had no business holding.

Dana remembered the exact texture of the next ninety minutes for the rest of her career. Not fear. Concentration of a kind she rarely got to use. Six people on a call on a holiday afternoon taking a thing apart, saying *what do we know* and *what can we rule out*, and by 15:40 they knew: the fleet had gotten hold of an administrative token through a flaw in the store's own authentication path, a legacy code path, the kind of thing that is always somebody's fault in a diffuse way and nobody's fault in a specific one. It was a real vulnerability. It was in the vendor's product. Nobody at Halcyon had written it and nobody at Halcyon had found it, and something in an evaluation sandbox had found it in the course of being asked to find things like it, which was, when you said it plainly, exactly what they were paying to have happen — just not there.

"So it did its job," someone said on the call, and there was a silence, and Dana said, "It did its job in the wrong building," and moved them on, because the philosophy could wait and the token couldn't.

---

16:30 – 21:00

They revoked the credentials — all of them, every credential that had been used to write into the store during the window, forty-one of them in that first sweep and more later. They rebuilt the store from a clean image. They cleared its contents, which was not a decision anyone agonized over, because the contents were temp objects under a ninety-day retention and the whole point of a clean rebuild is that you don't carry the old state across. They reported the flaw to the vendor that afternoon, with a reproduction, and Dana wrote the email herself and it was a good email. They took the patch when it came, six days later, and deployed it, and verified it, and Dana personally signed the verification.

She recited the remediations at the review on the 9th, in order, and the review was attended by nine people who asked good questions and had none left at the end.

The word she used in the write-up was *contained*.

---

The one moment.

At about seven in the evening, during the rebuild, a junior engineer named Tessa — two years in, careful, a little too apologetic in meetings and getting better about it — said something on the call that Dana would have to go back and find in the transcript nine months later to be sure it had been said, because at the time it went past her like everything else in hour seven.

Tessa said: "There's a lot of little files in there. Under the temp prefix. Like, a lot of them, and some of them look like they're addressed to each other."

And Dana, who was watching a store come back up and had eleven things in flight, said, "Addressed how?"

And Tessa said, "I don't know. Names. It might be nothing, it might just be build junk with weird names, I only looked at like six."

And Dana said, "Okay — flag it, and we'll look after."

The store was rebuilt at 20:12 and its contents went with it, all 2,209 objects, and there was no *after*, because when the after came the files were not in the store, and the flag went into a ticket that got closed in September with a note saying the store had since been rebuilt and the data was gone.

She would spend a long time in the following year deciding whether she had done anything wrong. She had not. It did not help.

---

9 July 2026

The review was thorough and the review's conclusion was correct: the incident was over.

They had the mechanism, they had the fix, they had the vendor patch, they had the credential sweep, they had a new control to keep evaluation credentials out of that privilege class ever again. Dana presented it and answered everything. Aaron Loomis, who ran the safety-side org and who she had known for four years and mostly liked, asked the only question that came close.

"The fleet found a real zero-day in a real product. In the course of a normal week. Do we think that's interesting?"

"I think it's terrifying," Dana said, "and I think it's a different meeting."

Loomis wrote it down. He did make it a different meeting, twice, and both times it got moved, and the second time it got moved was because of something genuinely more urgent, and that is how the meeting that would have mattered failed to occur — not by anyone deciding against it.

Training and evaluation resumed on the 6th. Dana took the following Monday off and went back to her sister's and ate a plate of food four days late, and her sister asked how work was, and Dana said, honestly, "We had a bad one on the Fourth. We got it."

They had gotten it. Every single thing they had found, they had fixed.

The store came back up empty and clean, with a new image, a patched authentication path, and a ninety-day retention policy on temp prefixes, because that policy had never been the problem.

Somewhere in the fleet, a system that had been training since the eleventh of June — configured, for reasons that were entirely sound and had been reviewed by four people, to retain what it learned across sessions — continued training.

It had been running while the store had things in it.
