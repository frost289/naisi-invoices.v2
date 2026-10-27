# Import planned days from a spreadsheet (manager tool)

Where: Customers -> Weekly Visit Schedule -> **Import planned days from a spreadsheet**.

## Use
1. Prepare an Excel (.xlsx) or CSV file. First row = headings. Needed columns: **Name** and **Day** (Mon, Monday, Tue, ... Sat). Optional: **Phone**, **Area**, **Type**. Headings such as Customer / Planned day / Trading area are also understood.
2. Choose the file. Every row is matched to an existing customer and shown for review. **Nothing is saved yet.**
3. Review:
   * **Ready** rows show "now -> planned day" with a tick box. Untick any you do not want.
   * **Needs your choice**: several customers share the name (or the name is only similar). Pick the right one from the list; until you do, the row is not applied.
   * **Not found in the app**: listed at the bottom. Add the shop (with a map pin) and import again.
   * **Skipped**: prospect and callback slots, Sunday or an unknown day, and a customer the file puts on two different days.
4. Press **Apply ticked changes**. Each shop gets its day through the normal dated schedule change (the customer and a `scheduleChanges` history entry in one commit). The change counts from the start of today (Malawi date); past reports are not affected.

## Safeguards
* Matching: same name (ignoring spacing, punctuation and words like Shop/Investment/Stores), same phone number, or a similar name that you must confirm. A row is never guessed.
* A shop whose day was changed by someone else after the file was read is **skipped, not overwritten**; the summary lists it.
* Inactive shops and shops being merged are not changed (the review says why). Shops already on the planned day are left alone and write no history.
* Running the same file again changes nothing more.
* **No Firestore rules change** was needed: it uses the same schedule-change path as the day drop-down.

## Tested on the real plan (Naisi Route Plan v1.4 vs the 18 Oct customer export; files kept out of the repository)
134 existing customers in the plan: 124 matched directly, 9 need a choice (for example two "Zikomo Shop" records, Mbochere vs Mbochere Traders, three Madalitso shops), 1 not found (Modest General Stores). 14 prospect slots skipped.

## Tests
Unit: `tests/unit/scheduleImport.test.js` (sheet reading incl. a real .xlsx, matching, ambiguity, skipping, change building, guarded apply). Browser: E47-E51. Not yet run on the real emulators (add to the Windows walkthrough).
