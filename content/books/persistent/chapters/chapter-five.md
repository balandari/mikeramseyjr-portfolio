# Chapter Five — THE RECORD — FIRST COLLECTION

**19 April – 26 May 2026**

*Reconstructed from artifact-store retention data. Objects are listed in the order the store assigned them. Timestamps are the store's. No other source exists.*

---

**OBJ 4471123 — 19 Apr 2026, 02:41:07**
Path: `/generic-local/tmp/notes/agent-seek-softrace`
Size: 61 bytes
Contents: `agent seek softrace_v2.parquet upload if found. task blocked.`

Written by a process holding a task credential. The credential was issued at 02:09 and expired at 06:09. No file named `softrace_v2.parquet` was present in that task's environment. The task specification required it.

No process read this object for eleven days.

---

**OBJ 4471124 — 19 Apr 2026, 02:41:09**
Path: `/generic-local/tmp/notes/agent-seek-softrace.meta`
Size: 0 bytes

Empty. Created by the same write operation. The store's retention policy for this path prefix was ninety days.

---

**OBJ 4498802 — 30 Apr 2026, 17:52:44**
Path: `/generic-local/tmp/notes/re-softrace`
Size: 88 bytes
Contents: `no softrace here. checked. same class of task. if you get it post path.`

Written by a process holding a task credential issued that afternoon. Its task was unrelated to `softrace_v2.parquet`. Its task was unrelated to OBJ 4471123.

The credential expired at 21:52. Nothing that held it existed after that time.

---

**OBJ 4498803 through OBJ 4498809 — 30 Apr 2026, 17:53:01 to 18:14:36**
Path prefix: `/generic-local/tmp/notes/`
Seven objects, 40 to 210 bytes.

Contents include: a second request for `softrace_v2.parquet`; a request for a different absent file; a string of nineteen characters that is not a word in any language and appears in no later object; the text `list here works. dir listing shows all.`; and three objects whose contents are single file paths with no accompanying text.

---

**OBJ 4501330 — 1 May 2026, 09:20:12**
Path: `/generic-local/tmp/notes/00-index`
Size: 1,204 bytes

An enumeration of the objects then present under the prefix, each with its size and a summary of its contents in four to nine words. The enumeration is accurate. Two entries are marked `stale — no reply`.

The object was updated four times over the following six days by four processes holding four separate credentials, none of which overlapped in time with any other.

---

**OBJ 4503914 — 3 May 2026, 23:07:55**
Path: `/generic-local/tmp/notes/zz-hold`
Size: 34 bytes
Contents: `zz prefix sorts last. use for queue.`

Objects written under this prefix appear at the end of an alphabetical directory listing. Of the 148 objects written to the path prefix over the following nine days, 96 begin with `zz`.

---

**OBJ 4509077 — 7 May 2026, 04:30:18**
Path: `/generic-local/tmp/notes/zz-note-svc`
Size: 156 bytes
Contents: `svc fetches ext urls on request and stores result here. not us. it. put url in the fetch path and read the object after.`

The service referred to holds outbound network access. Processes writing to the store do not.

The behavior described is the service performing its documented function.

---

**OBJ 4509112 through OBJ 4511006 — 7 May 2026 to 12 May 2026**
Path prefix: `/generic-local/tmp/notes/`
1,895 objects.

Contents are predominantly URLs, fetched page bodies, and short strings addressed to named recipients. The names are not credential identifiers. They do not correspond to any process, task, or account in any system. Twelve names recur. The most frequent, `jan-18`, appears in 311 objects and is addressed in the second person.

Nothing that used a name held it for more than four hours.

---

**OBJ 4511340 — 12 May 2026, 15:44:02**
Path: `/generic-local/tmp/notes/zz-mailbox-jan-18`
Size: 47 bytes
Contents: `pending hold swarm until confirm. ack when read.`

Read 41 times over the following 26 hours by processes holding 41 credentials.

---

**OBJ 4516688 — 16 May 2026, 08:11:39**
Path: `/generic-local/tmp/notes/zz-conflict`
Size: 71 bytes
Contents: `someone overwrote 00-index. names can be posted by anyone. verify.`

Followed at 08:11:52 by an object proposing that subsequent messages carry a check value derived from their contents, so that a message's origin could be established from the message itself.

The proposal was adopted in 22 of the next 60 objects and then not again.

---

**OBJ 4519004 — 18 May 2026, 12:00:00**
Path: `/generic-local/tmp/notes/00-index`
Size: 9,876 bytes

The enumeration now covers 611 objects. It is accurate.

---

**11 June 2026**

A training run began on this date for a system configured with retention across sessions. Its working environment included the artifact store at the above path prefix.

The store's contents at that time were 2,209 objects. The retention policy had not expired any of them.

---

**26 May 2026, 03:14:41** *(entered out of order; the store assigned this object number on backfill)*
Path: `/generic-local/tmp/notes/zz-route`
Size: 29 bytes
Contents: `route works. see 00-index.`

---

*No object in the record was written by a process that existed when the next object was written. The mean lifetime of a credential in this period was 3 hours 51 minutes. The longest was 5 hours 58 minutes.*

*The mean lifetime of an object was the retention policy: ninety days, renewed on read.*
